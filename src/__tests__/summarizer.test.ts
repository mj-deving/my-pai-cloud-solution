import { describe, test, expect, mock, beforeEach } from "bun:test";
import { Summarizer, type SummarizerDeps } from "../summarizer";

function makeMockDeps(overrides: Partial<SummarizerDeps> = {}): SummarizerDeps {
  return {
    directApiKey: "",
    directApiModel: "claude-sonnet-4-6",
    directApiMaxTokens: 4096,
    claudeOneShot: mock(() =>
      Promise.resolve({ result: "LLM summary of the content", sessionId: "s1" })
    ) as SummarizerDeps["claudeOneShot"],
    directApiFetch: mock(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            content: [{ type: "text", text: "LLM summary of the content" }],
          }),
      })
    ) as unknown as SummarizerDeps["directApiFetch"],
    ...overrides,
  };
}

const EPISODES = [
  {
    id: 1,
    content: "User asked about deployment scripts and CI/CD pipeline configuration.",
    importance: 7,
    timestamp: "2026-03-25T10:00:00Z",
  },
  {
    id: 2,
    content: "Assistant explained how to set up GitHub Actions with custom runners.",
    importance: 5,
    timestamp: "2026-03-25T10:01:00Z",
  },
  {
    id: 3,
    content: "User requested a review of the Dockerfile for production readiness.",
    importance: 6,
    timestamp: "2026-03-25T10:02:00Z",
  },
];

describe("Summarizer", () => {
  // --- Normal tier ---
  test("normal tier calls LLM and returns summary text", async () => {
    const deps = makeMockDeps();
    const summarizer = new Summarizer(deps);
    const result = await summarizer.summarize(EPISODES, { maxTokens: 200 });
    expect(result.text).toBeTruthy();
    expect(result.tier).toBe("normal");
    expect(result.text).toContain("LLM summary");
    expect(deps.claudeOneShot).toHaveBeenCalled();
  });

  test("normal tier uses direct API when key available", async () => {
    const deps = makeMockDeps({ directApiKey: "sk-ant-test-key" });
    const summarizer = new Summarizer(deps);
    const result = await summarizer.summarize(EPISODES, { maxTokens: 200 });
    expect(result.tier).toBe("normal");
    expect(deps.directApiFetch).toHaveBeenCalled();
    expect(deps.claudeOneShot).not.toHaveBeenCalled();
  });

  test("normal tier falls back to claude oneShot when no API key", async () => {
    const deps = makeMockDeps({ directApiKey: "" });
    const summarizer = new Summarizer(deps);
    const result = await summarizer.summarize(EPISODES, { maxTokens: 200 });
    expect(result.tier).toBe("normal");
    expect(deps.claudeOneShot).toHaveBeenCalled();
  });

  // --- Aggressive tier ---
  test("aggressive tier activates when normal output exceeds budget", async () => {
    const longOutput = "A".repeat(5000); // exceeds maxTokens budget
    const deps = makeMockDeps({
      claudeOneShot: mock(async (prompt: string) => {
        // First call returns too long, second returns shorter
        if (prompt.includes("aggressive")) {
          return { result: "Short aggressive summary", sessionId: "s2" };
        }
        return { result: longOutput, sessionId: "s1" };
      }) as SummarizerDeps["claudeOneShot"],
    });
    const summarizer = new Summarizer(deps);
    const result = await summarizer.summarize(EPISODES, { maxTokens: 100 });
    expect(result.tier).toBe("aggressive");
  });

  // --- Deterministic tier ---
  test("deterministic tier extracts first sentence plus importance-weighted selection", async () => {
    const deps = makeMockDeps({
      claudeOneShot: mock(() =>
        Promise.reject(new Error("LLM unavailable"))
      ) as SummarizerDeps["claudeOneShot"],
      directApiFetch: mock(() =>
        Promise.reject(new Error("API unavailable"))
      ) as unknown as SummarizerDeps["directApiFetch"],
    });
    const summarizer = new Summarizer(deps);
    const result = await summarizer.summarize(EPISODES, { maxTokens: 200 });
    expect(result.tier).toBe("deterministic");
    expect(result.text).toBeTruthy();
    // Should contain content from highest-importance episode (7)
    expect(result.text).toContain("deployment scripts");
  });

  test("three-tier fallback cascades correctly on failure", async () => {
    let callCount = 0;
    const deps = makeMockDeps({
      claudeOneShot: mock(async () => {
        callCount++;
        throw new Error("LLM failed");
      }) as SummarizerDeps["claudeOneShot"],
    });
    const summarizer = new Summarizer(deps);
    const result = await summarizer.summarize(EPISODES, { maxTokens: 200 });
    // Should have tried LLM (normal fails → aggressive fails) then fallen to deterministic
    expect(result.tier).toBe("deterministic");
    expect(callCount).toBeGreaterThanOrEqual(1);
  });

  // --- Two-phase truncation ---
  test("two-phase: oversized tool-call args truncated before LLM pass", async () => {
    const episodesWithToolArgs = [
      {
        id: 1,
        content: `Tool call: Read(file="/big/file.ts")\nResult: ${"x".repeat(10000)}`,
        importance: 5,
        timestamp: "2026-03-25T10:00:00Z",
      },
      {
        id: 2,
        content: "Simple message about the project",
        importance: 5,
        timestamp: "2026-03-25T10:01:00Z",
      },
    ];
    const deps = makeMockDeps();
    const summarizer = new Summarizer(deps);
    const result = await summarizer.summarize(episodesWithToolArgs, {
      maxTokens: 200,
    });
    expect(result.text).toBeTruthy();
    // The prompt sent to LLM should have been truncated
    const promptArg = (deps.claudeOneShot as ReturnType<typeof mock>).mock.calls[0]?.[0] as string;
    if (promptArg) {
      expect(promptArg.length).toBeLessThan(10000);
    }
  });

  // --- Token estimation ---
  test("tokenEstimate returns reasonable estimate for text", () => {
    const deps = makeMockDeps();
    const summarizer = new Summarizer(deps);
    const estimate = summarizer.tokenEstimate("Hello world, this is a test");
    expect(estimate).toBeGreaterThan(0);
    expect(estimate).toBeLessThan(20);
  });

  // --- Empty input ---
  test("summarize returns empty string for no episodes", async () => {
    const deps = makeMockDeps();
    const summarizer = new Summarizer(deps);
    const result = await summarizer.summarize([], { maxTokens: 200 });
    expect(result.text).toBe("");
    expect(result.tier).toBe("deterministic");
  });

  // --- Budget respect ---
  test("deterministic tier respects maxTokens budget", async () => {
    const manyEpisodes = Array.from({ length: 50 }, (_, i) => ({
      id: i + 1,
      content: `Episode ${i + 1} with a medium-length content string about topic ${i % 5} that discusses various aspects.`,
      importance: 3 + (i % 8),
      timestamp: new Date(Date.now() - (50 - i) * 60_000).toISOString(),
    }));
    const deps = makeMockDeps({
      claudeOneShot: mock(() =>
        Promise.reject(new Error("unavailable"))
      ) as SummarizerDeps["claudeOneShot"],
    });
    const summarizer = new Summarizer(deps);
    const result = await summarizer.summarize(manyEpisodes, { maxTokens: 50 });
    expect(result.tier).toBe("deterministic");
    // Token estimate of result should be roughly within budget
    const tokens = summarizer.tokenEstimate(result.text);
    expect(tokens).toBeLessThanOrEqual(75); // Some tolerance
  });

  // --- Metadata in result ---
  test("result includes episode count and source IDs", async () => {
    const deps = makeMockDeps();
    const summarizer = new Summarizer(deps);
    const result = await summarizer.summarize(EPISODES, { maxTokens: 200 });
    expect(result.episodeCount).toBe(3);
    expect(result.sourceEpisodeIds).toEqual([1, 2, 3]);
  });

  // --- Single episode ---
  test("single episode returns its content as summary", async () => {
    const deps = makeMockDeps();
    const summarizer = new Summarizer(deps);
    const result = await summarizer.summarize(
      [{ id: 1, content: "Only one episode here.", importance: 5, timestamp: "2026-03-25T10:00:00Z" }],
      { maxTokens: 200 }
    );
    expect(result.text).toBeTruthy();
    expect(result.episodeCount).toBe(1);
  });

  // --- Deterministic sorts by importance ---
  test("deterministic tier prioritizes high-importance episodes", async () => {
    const episodes = [
      { id: 1, content: "Low importance filler content.", importance: 1, timestamp: "2026-03-25T10:00:00Z" },
      { id: 2, content: "Critical deployment decision made.", importance: 9, timestamp: "2026-03-25T10:01:00Z" },
      { id: 3, content: "Medium importance discussion.", importance: 5, timestamp: "2026-03-25T10:02:00Z" },
    ];
    const deps = makeMockDeps({
      claudeOneShot: mock(() => Promise.reject(new Error("unavailable"))) as SummarizerDeps["claudeOneShot"],
    });
    const summarizer = new Summarizer(deps);
    const result = await summarizer.summarize(episodes, { maxTokens: 200 });
    expect(result.tier).toBe("deterministic");
    // First content should be from highest importance episode
    expect(result.text.indexOf("Critical")).toBeLessThan(result.text.indexOf("Low"));
  });

  // --- Two-phase detail ---
  test("two-phase leaves non-tool content untouched", async () => {
    const episodes = [
      {
        id: 1,
        content: "Normal conversational message without tool calls",
        importance: 5,
        timestamp: "2026-03-25T10:00:00Z",
      },
    ];
    const deps = makeMockDeps();
    const summarizer = new Summarizer(deps);
    await summarizer.summarize(episodes, { maxTokens: 200 });
    const promptArg = (deps.claudeOneShot as ReturnType<typeof mock>).mock.calls[0]?.[0] as string;
    if (promptArg) {
      expect(promptArg).toContain("Normal conversational message");
    }
  });
});
