// handoff.ts — V2-C: Structured handoff for cross-instance state transfer
// Writes on-demand via /sync command and on graceful shutdown.
// Reads incoming handoff on startup for context restoration.

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Config } from "./config";
import type { SessionManager } from "./session";
import type { ProjectManager } from "./projects";
import type { MemoryStore } from "./memory";
import type { TaskOrchestrator } from "./orchestrator";
import { safeParse, HandoffObjectSchema, type HandoffObject } from "./schemas";

export class HandoffManager {
  private handoffDir: string;

  constructor(
    private config: Config,
    private sessions: SessionManager,
    private projects: ProjectManager,
    private memory: MemoryStore | null = null,
    private orchestrator: TaskOrchestrator | null = null,
  ) {
    this.handoffDir = config.handoffDir;
  }

  /** Write an outgoing handoff object (called by /sync and graceful shutdown). */
  async writeOutgoing(): Promise<string | null> {
    try {
      await mkdir(this.handoffDir, { recursive: true });

      const sessionId = await this.sessions.current();
      const activeProject = this.projects.getActiveProject();
      const projectPath = activeProject ? this.projects.getProjectPath(activeProject) : null;

      // Get current branch
      let branch = "main";
      if (projectPath) {
        try {
          const proc = Bun.spawn(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
            cwd: projectPath,
            stdout: "pipe",
            stderr: "pipe",
          });
          const stdout = await new Response(proc.stdout).text();
          if ((await proc.exited) === 0) branch = stdout.trim();
        } catch { /* fallback to main */ }
      }

      // Check for uncommitted changes
      let uncommittedChanges = false;
      if (projectPath) {
        try {
          const proc = Bun.spawn(["git", "status", "--porcelain"], {
            cwd: projectPath,
            stdout: "pipe",
            stderr: "pipe",
          });
          const stdout = await new Response(proc.stdout).text();
          if ((await proc.exited) === 0) uncommittedChanges = stdout.trim().length > 0;
        } catch { /* assume clean */ }
      }

      // Get active workflows
      const activeWorkflows = this.orchestrator
        ? this.orchestrator.getActiveWorkflows().map(w => w.id)
        : [];

      // Memory sync pointer
      const lastEpisodeId = this.memory?.getLastEpisodeId() ?? 0;
      const memoryDbHash = this.memory ? await this.hashFile(this.config.memoryDbPath) : "";

      // Determine direction based on hostname
      const hostname = (await import("node:os")).hostname();
      const direction = hostname.includes("cloud") || hostname.includes("vps")
        ? "cloud-to-local" as const
        : "local-to-cloud" as const;

      const handoff: HandoffObject = {
        version: 1,
        timestamp: new Date().toISOString(),
        direction,
        activeProject: activeProject?.name ?? null,
        sessionId: sessionId,
        branch,
        uncommittedChanges,
        activePRD: null,
        activeWorkflows,
        pendingTasks: [],
        recentWorkSummary: `Active on ${activeProject?.displayName ?? "no project"}, branch ${branch}`,
        nextSteps: [],
        blockers: [],
        lastEpisodeId,
        memoryDbHash,
      };

      const filename = `handoff-${direction}-${Date.now()}.json`;
      const filePath = join(this.handoffDir, filename);
      await writeFile(filePath, JSON.stringify(handoff, null, 2) + "\n", "utf-8");
      console.log(`[handoff] Written: ${filename}`);
      return filePath;
    } catch (err) {
      console.error(`[handoff] Failed to write outgoing: ${err}`);
      return null;
    }
  }

  /** Read the most recent incoming handoff (opposite direction). */
  async readIncoming(): Promise<HandoffObject | null> {
    try {
      await mkdir(this.handoffDir, { recursive: true });
      const files = await readdir(this.handoffDir);

      // Determine what direction we should look for
      const hostname = (await import("node:os")).hostname();
      const incomingDirection = hostname.includes("cloud") || hostname.includes("vps")
        ? "local-to-cloud"
        : "cloud-to-local";

      const candidates = files
        .filter(f => f.startsWith(`handoff-${incomingDirection}`) && f.endsWith(".json"))
        .sort()
        .reverse();

      if (candidates.length === 0) return null;

      const latest = candidates[0]!;
      const raw = await readFile(join(this.handoffDir, latest), "utf-8");
      const result = safeParse(HandoffObjectSchema, raw, `handoff/${latest}`);

      if (!result.success) {
        console.warn(`[handoff] Invalid handoff file ${latest}: ${result.error}`);
        return null;
      }

      console.log(`[handoff] Read incoming: ${latest} (from ${result.data.direction})`);
      return result.data;
    } catch (err) {
      console.warn(`[handoff] Failed to read incoming: ${err}`);
      return null;
    }
  }

  private async hashFile(path: string): Promise<string> {
    try {
      const data = await readFile(path);
      return createHash("sha256").update(data).digest("hex").slice(0, 16);
    } catch {
      return "";
    }
  }
}
