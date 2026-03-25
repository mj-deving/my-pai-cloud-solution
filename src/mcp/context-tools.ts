// mcp/context-tools.ts — Tool handler logic for pai-context MCP server
// Scored retrieval and context building for injection.
// Part of PAI Cloud Evolution Session 1.

import type { SummaryDAG, DAGEpisode } from "../summary-dag";
import type { Config } from "../config";

export interface SuggestInput {
  query: string;
  maxTokens?: number;
  project?: string;
}

export interface InjectInput {
  query: string;
  project?: string;
  maxTokens?: number;
}

export class ContextToolHandlers {
  constructor(
    private dag: SummaryDAG,
    private config: Config
  ) {}

  /** Suggest relevant context for a query using scored retrieval. */
  async suggest(input: SuggestInput): Promise<{
    context: string;
    episodeCount: number;
    totalTokens: number;
  }> {
    const maxTokens = input.maxTokens ?? this.config.contextMaxTokens ?? 2000;
    const result = this.dag.scoredQuery(input.query, {
      maxResults: 10,
      maxTokens,
      project: input.project,
    });

    const context = result.episodes
      .map((ep) => this.formatEpisode(ep))
      .join("\n---\n");

    return {
      context,
      episodeCount: result.episodes.length,
      totalTokens: result.totalTokens,
    };
  }

  /** Build formatted context block ready for injection into prompts. */
  async inject(input: InjectInput): Promise<{ contextBlock: string }> {
    const maxTokens = input.maxTokens ?? this.config.contextMaxTokens ?? 2000;
    const result = this.dag.scoredQuery(input.query, {
      maxResults: 10,
      maxTokens,
      project: input.project,
    });

    if (result.episodes.length === 0) {
      return { contextBlock: "" };
    }

    const header = "📚 Relevant Memory Context:";
    const body = result.episodes
      .map((ep) => this.formatEpisode(ep))
      .join("\n");
    const footer = `[${result.episodes.length} episodes, ~${result.totalTokens} tokens]`;

    return { contextBlock: `${header}\n${body}\n${footer}` };
  }

  private formatEpisode(ep: DAGEpisode): string {
    const time = new Date(ep.timestamp).toLocaleString();
    const project = ep.project ? ` [${ep.project}]` : "";
    const content = ep.summary || ep.content.slice(0, 300);
    return `[${time}${project}] (${ep.role}, imp:${ep.importance}) ${content}`;
  }
}
