import { describe, test, expect } from "bun:test";
import { HaikuScorer, HAIKU_MODEL } from "../hooks/haiku-scorer";

function fakeResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("HaikuScorer — construction", () => {
  test("throws when ANTHROPIC_API_KEY is unset and no apiKey passed", () => {
    const original = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(() => new HaikuScorer()).toThrow(/ANTHROPIC_API_KEY not set/);
    } finally {
      if (original !== undefined) process.env.ANTHROPIC_API_KEY = original;
    }
  });

  test("accepts explicit apiKey without env var", () => {
    const original = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(() => new HaikuScorer({ apiKey: "sk-test" })).not.toThrow();
    } finally {
      if (original !== undefined) process.env.ANTHROPIC_API_KEY = original;
    }
  });

  test("defaults to Haiku model identifier claude-haiku-4-5-20251001", () => {
    expect(HAIKU_MODEL).toBe("claude-haiku-4-5-20251001");
  });
});

describe("HaikuScorer — score()", () => {
  test("parses integer 1-10 from API response", async () => {
    let seenBody: { model?: string; messages?: unknown[] } | null = null;
    const fakeFetch = async (_url: string, init: RequestInit) => {
      seenBody = JSON.parse(init.body as string);
      return fakeResponse({
        content: [{ type: "text", text: "7" }],
      });
    };
    const scorer = new HaikuScorer({
      apiKey: "sk-test",
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    const got = await scorer.score({ user: "hello", assistant: "hi there" });
    expect(got).toBe(7);
    expect(seenBody!.model).toBe(HAIKU_MODEL);
  });

  test("extracts integer even when wrapped in prose", async () => {
    const fakeFetch = async () =>
      fakeResponse({
        content: [{ type: "text", text: "Rating: 9 out of 10." }],
      });
    const scorer = new HaikuScorer({
      apiKey: "sk-test",
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    const got = await scorer.score({ user: "q", assistant: "a" });
    expect(got).toBe(9);
  });

  test("throws on non-integer response", async () => {
    const fakeFetch = async () =>
      fakeResponse({
        content: [{ type: "text", text: "I cannot rate this." }],
      });
    const scorer = new HaikuScorer({
      apiKey: "sk-test",
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    await expect(scorer.score({ user: "q", assistant: "a" })).rejects.toThrow(
      /no integer/
    );
  });

  test("throws on non-2xx API response", async () => {
    const fakeFetch = async () => fakeResponse({ error: "overloaded" }, 529);
    const scorer = new HaikuScorer({
      apiKey: "sk-test",
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    await expect(scorer.score({ user: "q", assistant: "a" })).rejects.toThrow(
      /API error \(529\)/
    );
  });

  test("sends anthropic-version header", async () => {
    let seenHeaders: Headers | null = null;
    const fakeFetch = async (_url: string, init: RequestInit) => {
      seenHeaders = new Headers(init.headers);
      return fakeResponse({ content: [{ type: "text", text: "5" }] });
    };
    const scorer = new HaikuScorer({
      apiKey: "sk-test",
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    await scorer.score({ user: "q", assistant: "a" });
    expect(seenHeaders!.get("anthropic-version")).toBe("2023-06-01");
    expect(seenHeaders!.get("x-api-key")).toBe("sk-test");
  });
});
