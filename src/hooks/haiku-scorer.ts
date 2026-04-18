// haiku-scorer.ts — HaikuScorer implementation of Scorer interface (Move 3)
//
// Calls Anthropic API (claude-haiku-4-5-20251001) to score conversation turns
// for long-term memory importance. Used by scripts/rescore-episodes.ts.
//
// Design: stateless, dependency-injected fetch for testability. Fails closed
// on parse errors (caller is expected to fail open and keep the heuristic score).

import { buildScorerPrompt, parseScoreFromLLM, type Scorer } from "./importance-scorer";

export const HAIKU_MODEL = "claude-haiku-4-5-20251001";

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";
const MAX_TOKENS = 10;
const TIMEOUT_MS = 15_000;

type FetchFn = typeof fetch;

export interface HaikuScorerOptions {
  apiKey?: string;
  model?: string;
  fetchImpl?: FetchFn;
}

interface AnthropicMessagesResponse {
  content: Array<{ type: string; text?: string }>;
}

export class HaikuScorer implements Scorer {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImpl: FetchFn;

  constructor(options: HaikuScorerOptions = {}) {
    const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("HaikuScorer: ANTHROPIC_API_KEY not set");
    }
    this.apiKey = apiKey;
    this.model = options.model ?? HAIKU_MODEL;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async score(input: { user: string | null; assistant: string }): Promise<number> {
    const { system, user } = buildScorerPrompt(input);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let resp: Response;
    try {
      resp = await this.fetchImpl(API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": API_VERSION,
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: MAX_TOKENS,
          system,
          messages: [{ role: "user", content: user }],
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`[haiku-scorer] API error (${resp.status}): ${text.slice(0, 200)}`);
    }

    const data = (await resp.json()) as AnthropicMessagesResponse;
    const text = data.content
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text!)
      .join(" ")
      .trim();

    return parseScoreFromLLM(text);
  }
}
