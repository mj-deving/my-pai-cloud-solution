// context.ts — V2-B: Context injection for Claude invocations
// Queries MemoryStore for relevant context and formats as a prompt prefix.
// Uses topic-based snapshot invalidation for prompt cache stability.
// Budget-based allocation: whiteboard 20%, knowledge 20%, episodes 30%, summary 30%.

import type { Config } from "./config";
import type { MemoryStore } from "./memory";
import type { Episode } from "./schemas";

const SNAPSHOT_TTL_MS = 5 * 60 * 1000; // 5 minutes (fallback max)
const TOPIC_SIMILARITY_THRESHOLD = 0.3; // Jaccard similarity — below this = new topic

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

  // Conversation topic tracking
  private conversationTopic: string = "";
  private topicKeywords: Set<string> = new Set();

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
   * Uses topic-based invalidation: snapshot refreshes when conversation topic shifts.
   * Returns null if no relevant context found or memory query fails.
   */
  async buildContext(message: string, project?: string, source?: string): Promise<string | null> {
    const effectiveProject = project ?? this.currentProject;

    // Check if topic has shifted — invalidate snapshot if so
    const messageKeywords = this.extractKeywords(message);
    if (this.topicKeywords.size > 0) {
      const similarity = this.jaccardSimilarity(messageKeywords, this.topicKeywords);
      if (similarity < TOPIC_SIMILARITY_THRESHOLD) {
        this.invalidate();
      }
    }
    // Update rolling topic
    this.updateTopic(message, messageKeywords);

    // Check frozen snapshot validity (time-based fallback)
    if (this.snapshot !== null && this.isSnapshotValid(effectiveProject)) {
      return this.snapshot;
    }

    // Build fresh context
    try {
      // Use scored query for better relevance ranking
      const result = await this.memory.scoredQuery({
        query: message,
        project: effectiveProject,
        source: source as Episode["source"] | undefined,
        maxResults: 10,
        maxTokens: this.maxTokens,
        recencyBias: 0.7,
      });

      // Get session summary for recovery context
      const sessionSummary = this.memory.getLatestSessionSummary(effectiveProject);

      if (result.episodes.length === 0 && result.knowledge.length === 0 && !sessionSummary) {
        this.freezeSnapshot(null, effectiveProject);
        return null;
      }

      const formatted = this.formatResult(result, effectiveProject, sessionSummary);
      const capped = this.enforceCharBudget(formatted);

      // Freeze as snapshot
      this.freezeSnapshot(capped, effectiveProject);

      return capped;
    } catch (err) {
      console.warn(`[context] Failed to build context: ${err}`);
      return null;
    }
  }

  /** Extract keywords from a message for topic tracking. */
  private extractKeywords(text: string): Set<string> {
    return new Set(
      text.toLowerCase()
        .replace(/[^\w\s]/g, "")
        .split(/\s+/)
        .filter(w => w.length > 3)
    );
  }

  /** Jaccard similarity between two keyword sets. */
  private jaccardSimilarity(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 && b.size === 0) return 1;
    let intersection = 0;
    for (const word of a) {
      if (b.has(word)) intersection++;
    }
    const union = a.size + b.size - intersection;
    return union > 0 ? intersection / union : 0;
  }

  /** Update rolling conversation topic from recent message. */
  private updateTopic(message: string, keywords: Set<string>): void {
    // Merge new keywords with existing, keeping a rolling window
    this.conversationTopic = message.slice(0, 200);
    // Blend: keep half of old keywords, add all new
    const blended = new Set<string>();
    let kept = 0;
    for (const kw of this.topicKeywords) {
      if (kept < this.topicKeywords.size / 2) {
        blended.add(kw);
        kept++;
      }
    }
    for (const kw of keywords) {
      blended.add(kw);
    }
    this.topicKeywords = blended;
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

  private formatResult(
    result: { episodes: Episode[]; knowledge: Array<{ domain: string; key: string; content: string }>; totalTokens: number },
    project?: string,
    sessionSummary?: Episode | null,
  ): string {
    const parts: string[] = ["[Memory Context]"];
    const totalBudget = this.maxChars;

    // Budget allocation: whiteboard 20%, knowledge 20%, episodes 30%, summary 30%
    const whiteboardBudget = Math.floor(totalBudget * 0.20);
    const knowledgeBudget = Math.floor(totalBudget * 0.20);
    const episodeBudget = Math.floor(totalBudget * 0.30);
    const summaryBudget = Math.floor(totalBudget * 0.30);

    // Session summary (recovery context — from previous conversation)
    if (sessionSummary) {
      const summaryText = (sessionSummary.content || "").slice(0, summaryBudget);
      parts.push(`\nPrevious conversation summary:\n${summaryText}`);
    }

    // Whiteboard (running project summary or workspace cross-project)
    if (project) {
      const whiteboard = this.memory.getWhiteboard(project);
      if (whiteboard) {
        parts.push(`\nProject whiteboard (${project}):\n${whiteboard.slice(0, whiteboardBudget)}`);
      }
    } else {
      // Workspace mode: inject cross-project whiteboards (most recent projects)
      const recentProjects = this.memory.getRecentProjectNames(
        Math.max(0, this.memory.getLastEpisodeId() - 100),
      );
      let wbChars = 0;
      for (const proj of recentProjects.slice(0, 3)) {
        const wb = this.memory.getWhiteboard(proj);
        if (wb && wbChars + wb.length < whiteboardBudget) {
          parts.push(`\nWhiteboard (${proj}):\n${wb.slice(0, Math.floor(whiteboardBudget / 3))}`);
          wbChars += wb.length;
        }
      }
    }

    // Knowledge (stable, high signal)
    if (result.knowledge.length > 0) {
      let knowledgeChars = 0;
      parts.push("\nRelevant knowledge:");
      for (const k of result.knowledge) {
        const line = `- [${k.domain}/${k.key}] ${k.content}`;
        if (knowledgeChars + line.length > knowledgeBudget) break;
        parts.push(line);
        knowledgeChars += line.length;
      }
    }

    // Episodes with importance-based masking
    if (result.episodes.length > 0) {
      let episodeChars = 0;
      parts.push("\nRecent relevant episodes:");
      for (const ep of result.episodes) {
        const time = ep.timestamp.slice(0, 16).replace("T", " ");
        const src = ep.source;
        const proj = ep.project ? ` (${ep.project})` : "";
        const importance = ep.importance ?? 5;

        let line: string;
        if (importance >= 7) {
          // High-importance: always full content
          const text = ep.summary || ep.content.slice(0, 200);
          line = `- [${time} ${src}${proj}] ${text}`;
        } else {
          // Lower-importance: summary only
          const summary = ep.summary || ep.content.slice(0, 80);
          line = `- [${time} ${src}${proj}] ${summary}`;
        }

        if (episodeChars + line.length > episodeBudget) break;
        parts.push(line);
        episodeChars += line.length;
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
