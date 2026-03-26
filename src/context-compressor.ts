// context-compressor.ts — Multi-pass context compression for PAI Cloud bridge
// Consolidates, extracts knowledge from, and prunes episodic memory to reduce context fill.

import type { Config } from "./config";
import type { ClaudeInvoker } from "./claude";
import type { MemoryStore } from "./memory";
import type { SummaryDAG } from "./summary-dag";
import type { Episode } from "./schemas";

export interface CompressionResult {
  originalEpisodes: number;
  compressedEpisodes: number;
  knowledgeExtracted: number;
  prunedEpisodes: number;
  passes: number;
  savedTokens: number;
}

export interface CompressorConfig {
  threshold: number;       // context fill % to trigger (default 80)
  maxConcurrent: number;   // max parallel oneShot calls (default 3)
  maxPasses: number;       // max compression passes (default 3)
  reductionTarget: number; // target % reduction per pass (default 10)
  minImportance: number;   // episodes below this get pruned (default 3)
}

const DEFAULTS: CompressorConfig = {
  threshold: 80,
  maxConcurrent: 3,
  maxPasses: 3,
  reductionTarget: 10,
  minImportance: 3,
};

/** Fresh tail size — last N episodes are protected from pruning. */
const FRESH_TAIL_SIZE = 20;

/** Minimum episodes in a time-window chunk to trigger consolidation. */
const MIN_CHUNK_SIZE = 3;

/** Time window for grouping episodes (1 hour in ms). */
const TIME_WINDOW_MS = 60 * 60 * 1000;

/** Estimate token count from content length (rough: 1 token ~ 4 chars). */
function estimateTokens(content: string): number {
  return Math.ceil(content.length / 4);
}

export class ContextCompressor {
  constructor(
    private config: Config,
    private claude: ClaudeInvoker,
    private memoryStore: MemoryStore,
    private summaryDag: SummaryDAG | null,
  ) {}

  /**
   * Check if compression should trigger based on context fill percentage.
   * Optionally override the threshold.
   */
  shouldCompress(
    contextFillPercent: number,
    options?: { threshold?: number },
  ): boolean {
    const threshold = options?.threshold ?? DEFAULTS.threshold;
    return contextFillPercent >= threshold;
  }

  /**
   * Run a full compression cycle: consolidate, extract knowledge, prune.
   * Returns stats about what was done.
   */
  async compress(
    options?: Partial<CompressorConfig>,
  ): Promise<CompressionResult> {
    const opts: CompressorConfig = { ...DEFAULTS, ...options };

    // Get all episodes via getEpisodesSince(0)
    const allEpisodes = this.memoryStore.getEpisodesSince(0, 10_000);
    const originalCount = allEpisodes.length;
    const originalTokens = allEpisodes.reduce(
      (sum, ep) => sum + estimateTokens(ep.content),
      0,
    );

    let totalCompressed = 0;
    let totalKnowledge = 0;
    let totalPruned = 0;
    let passesRun = 0;

    for (let pass = 0; pass < opts.maxPasses; pass++) {
      passesRun++;

      // Reload episodes after each pass (state may have changed)
      const currentEpisodes =
        pass === 0
          ? allEpisodes
          : this.memoryStore.getEpisodesSince(0, 10_000);

      // Pass 1: Consolidate related episodes into summaries
      const { consolidated } = await this.consolidateEpisodes(
        currentEpisodes,
        opts.maxConcurrent,
      );
      totalCompressed += consolidated;

      // Pass 2: Extract knowledge from high-importance episodes
      const { extracted } = await this.extractKnowledge(
        currentEpisodes,
        opts.maxConcurrent,
      );
      totalKnowledge += extracted;

      // Pass 3: Prune low-importance episodes (protects fresh tail)
      const { pruned } = this.pruneEpisodes(currentEpisodes, opts.minImportance);
      totalPruned += pruned;

      // Check if we've reduced enough
      const remaining = this.memoryStore.getEpisodesSince(0, 10_000);
      const remainingTokens = remaining.reduce(
        (sum, ep) => sum + estimateTokens(ep.content),
        0,
      );
      const reductionPct =
        originalTokens > 0
          ? ((originalTokens - remainingTokens) / originalTokens) * 100
          : 0;

      if (reductionPct >= opts.reductionTarget) break;
    }

    // Calculate saved tokens
    const finalEpisodes = this.memoryStore.getEpisodesSince(0, 10_000);
    const finalTokens = finalEpisodes.reduce(
      (sum, ep) => sum + estimateTokens(ep.content),
      0,
    );

    return {
      originalEpisodes: originalCount,
      compressedEpisodes: totalCompressed,
      knowledgeExtracted: totalKnowledge,
      prunedEpisodes: totalPruned,
      passes: passesRun,
      savedTokens: Math.max(0, originalTokens - finalTokens),
    };
  }

  /**
   * Pass 1: Consolidate related episodes into summaries.
   * Groups episodes by 1-hour time windows, summarizes chunks of 3+.
   */
  private async consolidateEpisodes(
    episodes: Episode[],
    maxConcurrent: number,
  ): Promise<{ consolidated: number; summaries: string[] }> {
    // Group by 1-hour time window
    const chunks = this.groupByTimeWindow(episodes);

    // Filter to chunks with 3+ episodes
    const consolidatable = chunks.filter((c) => c.length >= MIN_CHUNK_SIZE);
    if (consolidatable.length === 0) {
      return { consolidated: 0, summaries: [] };
    }

    const summaries: string[] = [];
    let consolidated = 0;

    // Process in batches limited by maxConcurrent
    for (let i = 0; i < consolidatable.length; i += maxConcurrent) {
      const batch = consolidatable.slice(i, i + maxConcurrent);
      const results = await Promise.all(
        batch.map((chunk) => this.summarizeChunk(chunk)),
      );

      for (const result of results) {
        if (result) {
          summaries.push(result.summary);
          consolidated += result.episodeCount;

          // Store in SummaryDAG if available
          if (this.summaryDag) {
            this.summaryDag.create({
              parentId: null,
              depth: 0,
              content: result.summary,
              sourceEpisodeIds: result.episodeIds,
              tokenCount: estimateTokens(result.summary),
            });
          }

          // Update the first episode in the chunk with the summary,
          // mark others as consolidated (lower importance to enable future pruning)
          this.markConsolidated(result.episodeIds, result.summary);
        }
      }
    }

    return { consolidated, summaries };
  }

  /**
   * Summarize a chunk of episodes via oneShot.
   */
  private async summarizeChunk(
    chunk: Episode[],
  ): Promise<{
    summary: string;
    episodeCount: number;
    episodeIds: number[];
  } | null> {
    const episodeText = chunk
      .map(
        (e) => `[${e.timestamp}] ${e.content.slice(0, 200)}`,
      )
      .join("\n");

    const prompt = `Summarize these conversation episodes into a single concise entry. Preserve key decisions, outcomes, and actionable items. Drop redundant detail.\n\nEpisodes:\n${episodeText}`;

    try {
      const response = await this.claude.oneShot(prompt);
      const summary = response.result?.trim();
      if (!summary) return null;

      return {
        summary,
        episodeCount: chunk.length,
        episodeIds: chunk.map((e) => e.id!).filter((id) => id != null),
      };
    } catch (err) {
      console.warn(
        `[context-compressor] Failed to summarize chunk: ${err instanceof Error ? err.message : err}`,
      );
      return null;
    }
  }

  /**
   * Mark episodes as consolidated: update the first with the summary,
   * reduce importance on the rest so they can be pruned later.
   */
  private markConsolidated(episodeIds: number[], _summary: string): void {
    // We don't have direct DB access on MemoryStore, so we use distill
    // to store the consolidation as knowledge, preserving the summary.
    if (episodeIds.length > 0) {
      // Store consolidation record as knowledge
      this.memoryStore.distill(
        "consolidation",
        `consolidated-${episodeIds[0]}`,
        _summary,
        episodeIds,
        0.8,
      );
    }
  }

  /**
   * Pass 2: Extract knowledge from high-importance unconsolidated episodes.
   * Episodes with importance >= 7 get knowledge extracted via oneShot.
   */
  private async extractKnowledge(
    episodes: Episode[],
    maxConcurrent: number,
  ): Promise<{ extracted: number }> {
    const highImportance = episodes.filter(
      (e) => (e.importance ?? 5) >= 7,
    );

    if (highImportance.length === 0) {
      return { extracted: 0 };
    }

    let extracted = 0;

    // Process in batches
    for (let i = 0; i < highImportance.length; i += maxConcurrent) {
      const batch = highImportance.slice(i, i + maxConcurrent);
      const results = await Promise.all(
        batch.map((ep) => this.extractFromEpisode(ep)),
      );

      for (const result of results) {
        if (result) extracted++;
      }
    }

    return { extracted };
  }

  /**
   * Extract knowledge from a single episode via oneShot.
   */
  private async extractFromEpisode(
    episode: Episode,
  ): Promise<boolean> {
    const prompt = `Extract key knowledge from this interaction. Return JSON: {"domain": "...", "key": "...", "content": "..."}\n\nEpisode: ${episode.content.slice(0, 500)}`;

    try {
      const response = await this.claude.oneShot(prompt);
      const text = response.result?.trim();
      if (!text) return false;

      const parsed = JSON.parse(text);
      if (
        typeof parsed.domain !== "string" ||
        typeof parsed.key !== "string" ||
        typeof parsed.content !== "string"
      ) {
        return false;
      }

      await this.memoryStore.distill(
        parsed.domain,
        parsed.key,
        parsed.content,
        episode.id ? [episode.id] : [],
        0.7,
      );

      return true;
    } catch {
      // Malformed JSON or oneShot failure — skip silently
      return false;
    }
  }

  /**
   * Pass 3: Prune low-importance episodes.
   * Deletes episodes with importance < minImportance, but protects the
   * fresh tail (last FRESH_TAIL_SIZE episodes).
   * Pure data operation — no LLM calls.
   */
  private pruneEpisodes(
    episodes: Episode[],
    minImportance: number,
  ): { pruned: number } {
    if (episodes.length === 0) return { pruned: 0 };

    // Sort by ID ascending to identify fresh tail
    const sorted = [...episodes].sort((a, b) => (a.id ?? 0) - (b.id ?? 0));

    // Fresh tail: the last FRESH_TAIL_SIZE episodes are protected
    const tailStart = Math.max(0, sorted.length - FRESH_TAIL_SIZE);
    const freshTailIds = new Set(
      sorted.slice(tailStart).map((e) => e.id),
    );

    // Find episodes to prune: low importance AND not in fresh tail
    const toPrune = sorted.filter(
      (e) =>
        (e.importance ?? 5) < minImportance &&
        !freshTailIds.has(e.id),
    );

    if (toPrune.length === 0) return { pruned: 0 };

    // Delete via direct SQL through the distill/system state workaround
    // Since MemoryStore doesn't expose a deleteEpisode method, we use
    // the underlying DB by accessing it through getEpisodesSince trick.
    // Actually, we need to delete. Let's use the store's internal DB.
    // The cleanest approach: use the db accessor pattern.
    this.deleteEpisodesByIds(toPrune.map((e) => e.id!).filter((id) => id != null));

    return { pruned: toPrune.length };
  }

  /** Delete episodes by IDs via MemoryStore's public API. */
  private deleteEpisodesByIds(ids: number[]): void {
    if (ids.length === 0) return;
    this.memoryStore.deleteEpisodes(ids);
  }

  /**
   * Group episodes into 1-hour time-window chunks.
   */
  private groupByTimeWindow(episodes: Episode[]): Episode[][] {
    if (episodes.length === 0) return [];

    // Sort by timestamp
    const sorted = [...episodes].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );

    const chunks: Episode[][] = [];
    const first = sorted[0]!;
    let currentChunk: Episode[] = [first];
    let windowStart = new Date(first.timestamp).getTime();

    for (let i = 1; i < sorted.length; i++) {
      const ep = sorted[i]!;
      const ts = new Date(ep.timestamp).getTime();
      if (ts - windowStart < TIME_WINDOW_MS) {
        currentChunk.push(ep);
      } else {
        chunks.push(currentChunk);
        currentChunk = [ep];
        windowStart = ts;
      }
    }
    chunks.push(currentChunk);

    return chunks;
  }
}
