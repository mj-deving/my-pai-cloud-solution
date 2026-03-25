// summarizer.ts — Three-tier summarization engine with two-phase truncation
// Tier 1: Normal LLM summarization
// Tier 2: Aggressive LLM summarization (shorter prompt, stricter budget)
// Tier 3: Deterministic extraction (no LLM needed)
// Part of PAI Cloud Evolution Session 1.

export interface SummarizerDeps {
  directApiKey: string;
  directApiModel: string;
  directApiMaxTokens: number;
  claudeOneShot: (prompt: string, opts?: { maxTokens?: number }) => Promise<{ result: string; sessionId: string }>;
  directApiFetch: (url: string, opts: RequestInit) => Promise<Response>;
}

export interface SummarizeOptions {
  maxTokens: number;
}

export interface SummarizeResult {
  text: string;
  tier: "normal" | "aggressive" | "deterministic";
  episodeCount: number;
  sourceEpisodeIds: number[];
  tokenCount: number;
}

interface EpisodeInput {
  id: number;
  content: string;
  importance: number;
  timestamp: string;
}

// Pattern to detect tool-call results with large output
const TOOL_RESULT_PATTERN = /^(Tool call: .+?\n)?Result: /;
const TOOL_ARG_TRUNCATE_THRESHOLD = 2000;

export class Summarizer {
  constructor(private deps: SummarizerDeps) {}

  /** Estimate token count for text (~4 chars per token). */
  tokenEstimate(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /** Summarize a set of episodes through the three-tier fallback. */
  async summarize(episodes: EpisodeInput[], opts: SummarizeOptions): Promise<SummarizeResult> {
    const sourceEpisodeIds = episodes.map((e) => e.id);
    const episodeCount = episodes.length;

    if (episodes.length === 0) {
      return { text: "", tier: "deterministic", episodeCount: 0, sourceEpisodeIds: [], tokenCount: 0 };
    }

    // Phase 1 of two-phase: truncate oversized tool-call args
    const truncated = this.truncateToolArgs(episodes);

    // Try normal tier, then aggressive, then deterministic
    let needsAggressive = false;
    try {
      const normalResult = await this.llmSummarize(truncated, opts, false);
      const normalTokens = this.tokenEstimate(normalResult);
      if (normalTokens <= opts.maxTokens * 1.5) {
        return {
          text: normalResult,
          tier: "normal",
          episodeCount,
          sourceEpisodeIds,
          tokenCount: normalTokens,
        };
      }
      needsAggressive = true;
    } catch (err) {
      console.warn(`[summarizer] Normal tier failed, trying aggressive: ${err instanceof Error ? err.message : err}`);
      needsAggressive = true;
    }

    if (needsAggressive) {
      try {
        const aggressiveResult = await this.llmSummarize(truncated, opts, true);
        const aggressiveTokens = this.tokenEstimate(aggressiveResult);
        if (aggressiveTokens <= opts.maxTokens * 1.5) {
          return {
            text: aggressiveResult,
            tier: "aggressive",
            episodeCount,
            sourceEpisodeIds,
            tokenCount: aggressiveTokens,
          };
        }
        // Aggressive still over budget — fall through to deterministic
      } catch (err) {
        console.warn(`[summarizer] Aggressive tier failed, falling to deterministic: ${err instanceof Error ? err.message : err}`);
        // Fall through to deterministic
      }
    }

    // Deterministic tier
    const deterministicText = this.deterministicSummarize(episodes, opts);
    return {
      text: deterministicText,
      tier: "deterministic",
      episodeCount,
      sourceEpisodeIds,
      tokenCount: this.tokenEstimate(deterministicText),
    };
  }

  /** Two-phase: truncate oversized tool-call args before LLM pass. */
  private truncateToolArgs(episodes: EpisodeInput[]): EpisodeInput[] {
    return episodes.map((ep) => {
      if (ep.content.length <= TOOL_ARG_TRUNCATE_THRESHOLD) return ep;
      if (!TOOL_RESULT_PATTERN.test(ep.content)) return ep;

      // Truncate the result portion
      const resultIdx = ep.content.indexOf("Result: ");
      if (resultIdx === -1) return ep;

      const prefix = ep.content.slice(0, resultIdx + 8);
      const result = ep.content.slice(resultIdx + 8);
      if (result.length <= TOOL_ARG_TRUNCATE_THRESHOLD) return ep;

      const truncatedResult = result.slice(0, TOOL_ARG_TRUNCATE_THRESHOLD) + `\n... [truncated ${result.length - TOOL_ARG_TRUNCATE_THRESHOLD} chars]`;
      return { ...ep, content: prefix + truncatedResult };
    });
  }

  /** Call LLM for summarization (direct API or CLI). */
  private async llmSummarize(
    episodes: EpisodeInput[],
    opts: SummarizeOptions,
    aggressive: boolean
  ): Promise<string> {
    const episodeText = episodes
      .map((e, i) => `[${i + 1}] (importance: ${e.importance}) ${e.content}`)
      .join("\n\n");

    const prompt = aggressive
      ? `Summarize these ${episodes.length} conversation episodes in under ${opts.maxTokens} tokens. Be aggressive — keep only the most important facts, decisions, and outcomes. Omit details.\n\n${episodeText}`
      : `Summarize these ${episodes.length} conversation episodes concisely. Preserve key facts, decisions, and context. Target: ${opts.maxTokens} tokens.\n\n${episodeText}`;

    if (this.deps.directApiKey) {
      return this.callDirectApi(prompt, opts);
    }
    return this.callClaude(prompt, opts);
  }

  /** Call Anthropic direct API. */
  private async callDirectApi(prompt: string, opts: SummarizeOptions): Promise<string> {
    const response = await this.deps.directApiFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.deps.directApiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.deps.directApiModel,
        max_tokens: Math.min(opts.maxTokens, this.deps.directApiMaxTokens),
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      throw new Error(`Direct API error: ${response.status}`);
    }

    const data = (await response.json()) as { content: Array<{ type: string; text: string }> };
    const textBlock = data.content.find((c) => c.type === "text");
    return textBlock?.text ?? "";
  }

  /** Call Claude CLI oneShot. */
  private async callClaude(prompt: string, _opts: SummarizeOptions): Promise<string> {
    const response = await this.deps.claudeOneShot(prompt);
    return response.result;
  }

  /** Deterministic summarization: first sentence + importance-weighted selection. */
  private deterministicSummarize(episodes: EpisodeInput[], opts: SummarizeOptions): string {
    // Sort by importance descending
    const sorted = [...episodes].sort((a, b) => b.importance - a.importance);

    const parts: string[] = [];
    let totalTokens = 0;

    for (const ep of sorted) {
      // Extract first sentence
      const firstSentence = this.extractFirstSentence(ep.content);
      const tokens = this.tokenEstimate(firstSentence);

      if (totalTokens + tokens > opts.maxTokens && parts.length > 0) break;
      parts.push(firstSentence);
      totalTokens += tokens;
    }

    return parts.join(" ");
  }

  /** Extract first sentence from text. */
  private extractFirstSentence(text: string): string {
    const match = text.match(/^[^.!?]+[.!?]/);
    return match ? match[0].trim() : text.slice(0, 200).trim();
  }
}
