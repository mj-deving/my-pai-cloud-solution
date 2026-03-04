// daily-memory.ts — Workspace daily memory writer
// At configured cron time, summarizes today's episodes into a markdown file
// in the workspace directory, records in memory.db, and optionally git commits.

import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import type { MemoryStore } from "./memory";
import type { ClaudeInvoker } from "./claude";

export class DailyMemoryWriter {
  constructor(
    private memory: MemoryStore,
    private claude: ClaudeInvoker,
    private workspaceDir: string,
    private gitEnabled: boolean,
  ) {}

  /** Write today's memory summary. Called by scheduler or manually. */
  async writeDailyMemory(): Promise<{ written: boolean; path?: string; error?: string }> {
    const today = new Date().toISOString().slice(0, 10);

    // Get today's episodes (workspace = no project filter, or project=null)
    const episodes = this.memory.getTodaysEpisodes();
    if (episodes.length === 0) {
      console.log(`[daily-memory] No episodes today (${today}), skipping`);
      return { written: false };
    }

    // Filter to importance >= 3 and format for summarization
    const significant = episodes.filter(ep => (ep.importance ?? 5) >= 3);
    if (significant.length === 0) {
      console.log(`[daily-memory] No significant episodes today (${today}), skipping`);
      return { written: false };
    }

    const text = significant
      .map(ep => `[${ep.role}] ${(ep.summary || ep.content).slice(0, 200)}`)
      .join("\n");

    const summaryResponse = await this.claude.quickShot(
      `Summarize today's key events, decisions, and learnings in 5-10 bullets:\n\n${text.slice(0, 3000)}`,
    );

    if (!summaryResponse.result || summaryResponse.error) {
      const err = summaryResponse.error || "empty response";
      console.warn(`[daily-memory] Summary generation failed: ${err}`);
      return { written: false, error: err };
    }

    // Write markdown file
    const memoryDir = join(this.workspaceDir, "memory");
    await mkdir(memoryDir, { recursive: true });
    const filePath = join(memoryDir, `${today}.md`);
    await Bun.write(filePath, `# ${today}\n\n${summaryResponse.result}`);

    // Record in memory.db
    await this.memory.record({
      timestamp: new Date().toISOString(),
      source: "daily_memory",
      role: "system",
      content: summaryResponse.result.slice(0, 1000),
      summary: `Daily memory for ${today}`,
      importance: 8,
    });

    // Git commit in workspace repo
    if (this.gitEnabled) {
      await this.gitCommitWorkspace(`daily memory: ${today}`);
    }

    console.log(`[daily-memory] Written: ${filePath} (${significant.length} episodes summarized)`);
    return { written: true, path: filePath };
  }

  private async gitCommitWorkspace(message: string): Promise<void> {
    try {
      const addProc = Bun.spawn(["git", "add", "-A"], {
        cwd: this.workspaceDir,
        stdout: "pipe",
        stderr: "pipe",
      });
      await addProc.exited;

      const commitProc = Bun.spawn(["git", "commit", "-m", message, "--allow-empty"], {
        cwd: this.workspaceDir,
        stdout: "pipe",
        stderr: "pipe",
      });
      const exitCode = await commitProc.exited;
      if (exitCode === 0) {
        console.log(`[daily-memory] Git commit: ${message}`);
      }
    } catch (err) {
      console.warn(`[daily-memory] Git commit failed (non-blocking): ${err}`);
    }
  }
}
