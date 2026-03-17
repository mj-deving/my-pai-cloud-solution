// direct-api.ts — Lightweight Anthropic API client for simple messages
// No SDK dependency — raw fetch to messages endpoint.
// Used as fast-path for non-complex messages (greetings, questions, chat).

export interface DirectApiConfig {
  apiKey: string;
  model: string;
  maxTokens: number;
}

export interface DirectResponse {
  result: string;
  usage: { input_tokens: number; output_tokens: number };
  model: string;
}

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

/**
 * Send a message directly to the Anthropic API (no Claude CLI).
 * Returns a structured response with usage metrics.
 */
export async function sendDirect(
  message: string,
  systemPrompt: string | null,
  config: DirectApiConfig,
): Promise<DirectResponse> {
  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: config.maxTokens,
    messages: [{ role: "user", content: message }],
  };
  if (systemPrompt) {
    body.system = systemPrompt;
  }

  const resp = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": API_VERSION,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    if (resp.status === 429) {
      throw new Error(`[direct-api] Rate limited (429): ${text.slice(0, 200)}`);
    }
    if (resp.status === 401) {
      throw new Error(`[direct-api] Auth failed (401): check DIRECT_API_KEY`);
    }
    throw new Error(`[direct-api] API error (${resp.status}): ${text.slice(0, 200)}`);
  }

  const data = (await resp.json()) as {
    content: Array<{ type: string; text?: string }>;
    usage: { input_tokens: number; output_tokens: number };
    model: string;
  };

  const result = data.content
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text!)
    .join("\n");

  return {
    result,
    usage: data.usage,
    model: data.model,
  };
}
