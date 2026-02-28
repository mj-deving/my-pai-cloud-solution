// context.ts — V2-B: Context injection for Claude invocations
// Queries MemoryStore for relevant context and formats as a prompt prefix.
// Respects token budget to avoid overwhelming the Claude context window.

import type { Config } from "./config";
import type { MemoryStore } from "./memory";

export class ContextBuilder {
  private maxTokens: number;

  constructor(
    private memory: MemoryStore,
    private config: Config,
  ) {
    this.maxTokens = config.contextMaxTokens;
  }

  /**
   * Build a context prefix for a Claude invocation.
   * Returns null if no relevant context found or memory query fails.
   */
  async buildContext(message: string, project?: string): Promise<string | null> {
    try {
      const result = await this.memory.query({
        query: message,
        project,
        maxResults: 10,
        maxTokens: this.maxTokens,
        recencyBias: 0.7,
      });

      if (result.episodes.length === 0 && result.knowledge.length === 0) {
        return null;
      }

      const parts: string[] = ["[Memory Context]"];

      // Add knowledge first (more stable, higher signal)
      if (result.knowledge.length > 0) {
        parts.push("\nRelevant knowledge:");
        for (const k of result.knowledge) {
          parts.push(`- [${k.domain}/${k.key}] ${k.content}`);
        }
      }

      // Add recent episodes (conversation history)
      if (result.episodes.length > 0) {
        parts.push("\nRecent relevant episodes:");
        for (const ep of result.episodes) {
          const time = ep.timestamp.slice(0, 16).replace("T", " ");
          const source = ep.source;
          const proj = ep.project ? ` (${ep.project})` : "";
          const text = ep.summary || ep.content.slice(0, 200);
          parts.push(`- [${time} ${source}${proj}] ${text}`);
        }
      }

      parts.push(`\n[${result.totalTokens} tokens from memory]`);

      return parts.join("\n");
    } catch (err) {
      console.warn(`[context] Failed to build context: ${err}`);
      return null;
    }
  }
}
