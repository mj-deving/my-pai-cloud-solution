// session.ts — Manages the shared session ID across all channels
// Session ID file is the bridge between interactive (tmux) and programmatic (Telegram/email) modes

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";

const ARCHIVE_DIR_NAME = "archived-sessions";

export interface MemoryStoreLike {
  getSystemState(key: string): string | null;
  setSystemState(key: string, value: string): void;
}

export class SessionManager {
  private memoryStore: MemoryStoreLike | null = null;

  constructor(private sessionIdFile: string) {}

  /** Wire memory store for workspace session persistence. */
  setMemoryStore(store: MemoryStoreLike): void {
    this.memoryStore = store;
  }

  // Get the current active session ID, or null if none exists
  async current(): Promise<string | null> {
    try {
      const content = await readFile(this.sessionIdFile, "utf-8");
      return content.trim() || null;
    } catch {
      return null;
    }
  }

  // Start a new session — archives old one, clears active ID
  // The real session ID comes from Claude's first response (see claude.ts)
  async newSession(): Promise<void> {
    const old = await this.current();
    if (old) {
      await this.archive(old);
    }
    // Clear the file so send() knows to start fresh
    await this.write("");
  }

  // Save the real session ID returned by Claude after first message
  async saveSession(sessionId: string): Promise<void> {
    await this.write(sessionId);
  }

  // Clear the current session (archive + remove active)
  async clear(): Promise<void> {
    const old = await this.current();
    if (old) {
      await this.archive(old);
    }
    // Clear so next send() starts fresh
    await this.write("");
  }

  // List recent sessions (archived + current)
  async list(): Promise<{ current: string | null; archived: string[] }> {
    const current = await this.current();
    const archiveDir = join(dirname(this.sessionIdFile), ARCHIVE_DIR_NAME);

    let archived: string[] = [];
    try {
      const files = await readdir(archiveDir);
      archived = files
        .filter((f) => f.endsWith(".session"))
        .map((f) => f.replace(".session", ""))
        .sort()
        .reverse()
        .slice(0, 10); // Last 10
    } catch {
      // No archive dir yet
    }

    return { current, archived };
  }

  private async write(sessionId: string): Promise<void> {
    await mkdir(dirname(this.sessionIdFile), { recursive: true });
    await writeFile(this.sessionIdFile, sessionId + "\n", "utf-8");
  }

  private async archive(sessionId: string): Promise<void> {
    const archiveDir = join(dirname(this.sessionIdFile), ARCHIVE_DIR_NAME);
    await mkdir(archiveDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const archiveFile = join(archiveDir, `${timestamp}_${sessionId}.session`);
    await writeFile(archiveFile, sessionId + "\n", "utf-8");
  }

  // --- Workspace session management (memory.db backed) ---

  /** Get workspace session ID from memory.db. */
  getWorkspaceSession(): string | null {
    return this.memoryStore?.getSystemState("workspace_session") ?? null;
  }

  /** Save workspace session ID to memory.db. */
  saveWorkspaceSession(sessionId: string): void {
    this.memoryStore?.setSystemState("workspace_session", sessionId);
  }

  /** Archive workspace session and clear it. */
  async rotateWorkspaceSession(): Promise<string | null> {
    const old = this.getWorkspaceSession();
    if (old) {
      await this.archive(old);
    }
    this.memoryStore?.setSystemState("workspace_session", "");
    return old;
  }
}
