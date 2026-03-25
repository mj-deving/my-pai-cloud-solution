// mcp/memory-tools.ts — Tool handler logic for pai-memory MCP server
// Pure functions operating on SummaryDAG — no MCP protocol concerns.

import type { SummaryDAG, DAGEpisode } from "../summary-dag";

export interface StoreInput {
  content: string;
  source: string;
  role: string;
  importance?: number;
  project?: string;
  summary?: string;
}

export interface RecallInput {
  query: string;
  project?: string;
}

export interface SearchInput {
  query: string;
  maxResults?: number;
  maxTokens?: number;
  project?: string;
}

export interface ExpandInput {
  summaryId: number;
}

export interface WhiteboardReadInput {
  project: string;
}

export interface WhiteboardWriteInput {
  project: string;
  content: string;
}

export class MemoryToolHandlers {
  constructor(private dag: SummaryDAG) {}

  store(input: StoreInput): { episodeId: number } {
    const episodeId = this.dag.recordEpisode({
      timestamp: new Date().toISOString(),
      source: input.source,
      role: input.role,
      content: input.content,
      importance: input.importance ?? 5,
      project: input.project,
      summary: input.summary,
    });
    return { episodeId };
  }

  recall(input: RecallInput): { episodes: DAGEpisode[] } {
    if (input.project) {
      // Use scoredQuery with project filter to avoid LIMIT 20 masking project matches
      const result = this.dag.scoredQuery(input.query, { project: input.project, maxResults: 20 });
      return { episodes: result.episodes };
    }
    return { episodes: this.dag.searchFTS(input.query) };
  }

  search(input: SearchInput): { episodes: DAGEpisode[]; totalTokens: number } {
    return this.dag.scoredQuery(input.query, {
      maxResults: input.maxResults ?? 10,
      maxTokens: input.maxTokens ?? 2000,
      project: input.project,
    });
  }

  expand(input: ExpandInput): { episodes: DAGEpisode[] } {
    return { episodes: this.dag.expand(input.summaryId) };
  }

  whiteboardRead(input: WhiteboardReadInput): { content: string | null } {
    return { content: this.dag.getWhiteboard(input.project) };
  }

  whiteboardWrite(input: WhiteboardWriteInput): { success: boolean } {
    this.dag.setWhiteboard(input.project, input.content);
    return { success: true };
  }

  stats(): { episodeCount: number; summaryCount: number; storageSizeBytes: number; hasVectorSearch: boolean } {
    return this.dag.getStats();
  }
}
