// context.ts — V2-B: Context injection for Claude invocations
// Queries MemoryStore for relevant context and formats as a prompt prefix.
// Uses frozen snapshot caching for prompt cache stability (~75% cost reduction).
// Respects char budget to avoid overwhelming the Claude context window.

import type { Config } from "./config";
import type { MemoryStore } from "./memory";
import type { Episode } from "./schemas";

const SNAPSHOT_TTL_MS = 5 * 60 * 1000; // 5 minutes

export class ContextBuilder {
  private maxTokens: number;
  private maxChars: number;
  private currentProject: string | undefined;
  private maskingEnabled: boolean;
  private maskingWindow: number;

  // Frozen snapshot state
  private snapshot: string | null = null;
  private snapshotProject: string | undefined;
  private snapshotTimestamp = 0;

  constructor(
    private memory: MemoryStore,
    private config: Config,
  ) {
    this.maxTokens = config.contextMaxTokens;
    this.maxChars = config.contextMaxChars;
    this.maskingEnabled = config.observationMaskingEnabled;
    this.maskingWindow = config.observationMaskingWindow;
  }

  /** Set the active project. Invalidates snapshot if project changed. */
  setProject(project: string | undefined): void {
    if (project !== this.currentProject) {
      this.currentProject = project;
      this.invalidate();
    }
  }

  /** Explicitly invalidate the frozen snapshot (e.g., on session reset). */
  invalidate(): void {
    this.snapshot = null;
    this.snapshotProject = undefined;
    this.snapshotTimestamp = 0;
  }

  /**
   * Build a context prefix for a Claude invocation.
   * Returns frozen snapshot if still valid, otherwise queries memory fresh.
   * Returns null if no relevant context found or memory query fails.
   */
  async buildContext(message: string, project?: string, source?: string): Promise<string | null> {
    const effectiveProject = project ?? this.currentProject;

    // Check frozen snapshot validity
    if (this.snapshot !== null && this.isSnapshotValid(effectiveProject)) {
      return this.snapshot;
    }

    // Build fresh context
    try {
      const result = await this.memory.query({
        query: message,
        project: effectiveProject,
        source: source as Episode["source"] | undefined,
        maxResults: 10,
        maxTokens: this.maxTokens,
        recencyBias: 0.7,
      });

      if (result.episodes.length === 0 && result.knowledge.length === 0) {
        // Cache the null result too — avoids re-querying when memory is empty
        this.freezeSnapshot(null, effectiveProject);
        return null;
      }

      const formatted = this.formatResult(result, effectiveProject);
      const capped = this.enforceCharBudget(formatted);

      // Freeze as snapshot
      this.freezeSnapshot(capped, effectiveProject);

      return capped;
    } catch (err) {
      console.warn(`[context] Failed to build context: ${err}`);
      return null;
    }
  }

  private isSnapshotValid(project: string | undefined): boolean {
    const now = Date.now();
    return (
      this.snapshotProject === project &&
      (now - this.snapshotTimestamp) < SNAPSHOT_TTL_MS
    );
  }

  private freezeSnapshot(value: string | null, project: string | undefined): void {
    this.snapshot = value;
    this.snapshotProject = project;
    this.snapshotTimestamp = Date.now();
  }

  private formatResult(result: { episodes: Episode[]; knowledge: Array<{ domain: string; key: string; content: string }>; totalTokens: number }, project?: string): string {
    const parts: string[] = ["[Memory Context]"];

    // Whiteboard first (highest signal — running project summary)
    if (project) {
      const whiteboard = this.memory.getWhiteboard(project);
      if (whiteboard) {
        parts.push(`\nProject whiteboard (${project}):\n${whiteboard}`);
      }
    }

    // Knowledge (stable, high signal)
    if (result.knowledge.length > 0) {
      parts.push("\nRelevant knowledge:");
      for (const k of result.knowledge) {
        parts.push(`- [${k.domain}/${k.key}] ${k.content}`);
      }
    }

    // Episodes with observation masking
    if (result.episodes.length > 0) {
      parts.push("\nRecent relevant episodes:");
      let idx = 0;
      for (const ep of result.episodes) {
        const time = ep.timestamp.slice(0, 16).replace("T", " ");
        const src = ep.source;
        const proj = ep.project ? ` (${ep.project})` : "";

        if (this.maskingEnabled && idx >= this.maskingWindow) {
          // Beyond masking window: summary only
          const summary = ep.summary || ep.content.slice(0, 80);
          parts.push(`- [${time} ${src}${proj}] ${summary} [masked]`);
        } else {
          // Within window: full content
          const text = ep.summary || ep.content.slice(0, 200);
          parts.push(`- [${time} ${src}${proj}] ${text}`);
        }
        idx++;
      }
    }

    parts.push(`\n[${result.totalTokens} tokens from memory]`);

    return parts.join("\n");
  }

  /** Enforce char budget by truncating at episode boundaries, not mid-content. */
  private enforceCharBudget(text: string): string {
    if (text.length <= this.maxChars) return text;

    // Split into lines, accumulate until budget exceeded
    const lines = text.split("\n");
    let total = 0;
    const kept: string[] = [];

    for (const line of lines) {
      if (total + line.length + 1 > this.maxChars && kept.length > 0) break;
      kept.push(line);
      total += line.length + 1; // +1 for newline
    }

    // Always include a budget note
    kept.push(`\n[context truncated at ${this.maxChars} char budget]`);
    return kept.join("\n");
  }
}
