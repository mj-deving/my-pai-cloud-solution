// embeddings.ts — V2-A: Embedding provider for semantic memory search
// Uses Ollama HTTP API for embeddings with keyword-only fallback when unavailable.

import type { Config } from "./config";

export class EmbeddingProvider {
  private available = false;
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  private ollamaUrl: string;
  private model: string;

  constructor(private config: Config) {
    this.ollamaUrl = config.memoryOllamaUrl;
    this.model = config.memoryEmbeddingModel;
  }

  /** Check Ollama availability on startup. Non-blocking — memory works without it. */
  async init(): Promise<void> {
    await this.healthCheck();
    // Retry every 5 minutes if Ollama was down at startup
    if (!this.available) {
      this.retryTimer = setInterval(() => this.healthCheck(), 5 * 60 * 1000);
    }
  }

  /** Generate embedding vector for text. Returns null if Ollama unavailable. */
  async embed(text: string): Promise<Float64Array | null> {
    if (!this.available) return null;

    try {
      const res = await fetch(`${this.ollamaUrl}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, prompt: text }),
      });

      if (!res.ok) {
        console.warn(`[embeddings] Ollama returned ${res.status}`);
        return null;
      }

      const data = (await res.json()) as { embedding?: number[] };
      if (!data.embedding || !Array.isArray(data.embedding)) {
        console.warn("[embeddings] Unexpected response format from Ollama");
        return null;
      }

      return new Float64Array(data.embedding);
    } catch (err) {
      console.warn(`[embeddings] Embed error: ${err}`);
      return null;
    }
  }

  /** Whether Ollama embeddings are currently available. */
  isAvailable(): boolean {
    return this.available;
  }

  /** Stop the retry timer. */
  stop(): void {
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private async healthCheck(): Promise<void> {
    try {
      const res = await fetch(`${this.ollamaUrl}/api/tags`, {
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        if (!this.available) {
          console.log(`[embeddings] Ollama available at ${this.ollamaUrl} (model: ${this.model})`);
        }
        this.available = true;
        // Stop retrying once available
        if (this.retryTimer) {
          clearInterval(this.retryTimer);
          this.retryTimer = null;
        }
      } else {
        this.available = false;
      }
    } catch {
      if (this.available) {
        console.warn("[embeddings] Ollama became unavailable, falling back to keyword search");
      } else {
        console.log("[embeddings] Ollama not available, using keyword search fallback");
      }
      this.available = false;
    }
  }
}
