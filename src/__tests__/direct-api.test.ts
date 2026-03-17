import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { sendDirect, type DirectApiConfig } from "../direct-api";

const TEST_CONFIG: DirectApiConfig = {
  apiKey: "test-key-123",
  model: "claude-sonnet-4-6",
  maxTokens: 4096,
};

// Mock fetch globally
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(response: { status: number; body: unknown }) {
  const fn = mock(() =>
    Promise.resolve({
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      json: () => Promise.resolve(response.body),
      text: () => Promise.resolve(JSON.stringify(response.body)),
    } as Response),
  ) as unknown as typeof fetch;
  globalThis.fetch = fn;
}

describe("sendDirect", () => {
  test("sends correct request to Anthropic API", async () => {
    mockFetch({
      status: 200,
      body: {
        content: [{ type: "text", text: "Hello!" }],
        usage: { input_tokens: 10, output_tokens: 5 },
        model: "claude-sonnet-4-6",
      },
    });

    const result = await sendDirect("hi", null, TEST_CONFIG);
    expect(result.result).toBe("Hello!");
    expect(result.usage.input_tokens).toBe(10);
    expect(result.usage.output_tokens).toBe(5);
    expect(result.model).toBe("claude-sonnet-4-6");
  });

  test("includes system prompt when provided", async () => {
    let capturedBody = "";
    globalThis.fetch = mock((_url: string, init: RequestInit) => {
      capturedBody = init.body as string;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            content: [{ type: "text", text: "response" }],
            usage: { input_tokens: 10, output_tokens: 5 },
            model: "claude-sonnet-4-6",
          }),
      } as Response);
    }) as unknown as typeof fetch;

    await sendDirect("hello", "You are Isidore", TEST_CONFIG);
    const parsed = JSON.parse(capturedBody);
    expect(parsed.system).toBe("You are Isidore");
  });

  test("omits system prompt when null", async () => {
    let capturedBody = "";
    globalThis.fetch = mock((_url: string, init: RequestInit) => {
      capturedBody = init.body as string;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            content: [{ type: "text", text: "response" }],
            usage: { input_tokens: 10, output_tokens: 5 },
            model: "claude-sonnet-4-6",
          }),
      } as Response);
    }) as unknown as typeof fetch;

    await sendDirect("hello", null, TEST_CONFIG);
    const parsed = JSON.parse(capturedBody);
    expect(parsed.system).toBeUndefined();
  });

  test("throws on rate limit (429)", async () => {
    mockFetch({ status: 429, body: { error: "rate limited" } });
    await expect(sendDirect("hi", null, TEST_CONFIG)).rejects.toThrow("Rate limited");
  });

  test("throws on auth error (401)", async () => {
    mockFetch({ status: 401, body: { error: "unauthorized" } });
    await expect(sendDirect("hi", null, TEST_CONFIG)).rejects.toThrow("Auth failed");
  });

  test("throws on server error (500)", async () => {
    mockFetch({ status: 500, body: { error: "internal error" } });
    await expect(sendDirect("hi", null, TEST_CONFIG)).rejects.toThrow("API error (500)");
  });

  test("concatenates multiple text blocks", async () => {
    mockFetch({
      status: 200,
      body: {
        content: [
          { type: "text", text: "Part 1" },
          { type: "text", text: "Part 2" },
        ],
        usage: { input_tokens: 10, output_tokens: 10 },
        model: "claude-sonnet-4-6",
      },
    });

    const result = await sendDirect("hi", null, TEST_CONFIG);
    expect(result.result).toBe("Part 1\nPart 2");
  });
});
