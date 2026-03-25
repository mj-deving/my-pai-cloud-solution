import { describe, test, expect } from "bun:test";
import { ContextToolHandlers } from "../mcp/context-tools";
import { SummaryDAG } from "../summary-dag";
import type { Config } from "../config";

function makeConfig(): Config {
  return {
    memoryMaxEpisodes: 1000,
    memoryDecayLambda: 0.023,
    contextMaxTokens: 2000,
    contextMaxChars: 5000,
  } as Config;
}

function createHandlers(): { handlers: ContextToolHandlers; dag: SummaryDAG } {
  const dag = new SummaryDAG(":memory:");
  const handlers = new ContextToolHandlers(dag, makeConfig());
  return { handlers, dag };
}

function seedEpisodes(dag: SummaryDAG, count: number): void {
  for (let i = 0; i < count; i++) {
    dag.recordEpisode({
      timestamp: new Date(Date.now() - (count - i) * 60_000).toISOString(),
      source: "telegram",
      role: "user",
      content: `Episode ${i + 1} about CI/CD pipeline configuration and deployment`,
      importance: 3 + (i % 8),
    });
  }
}

describe("ContextToolHandlers", () => {
  test("suggest returns relevant context for a query", async () => {
    const { handlers, dag } = createHandlers();
    seedEpisodes(dag, 20);
    const result = await handlers.suggest({ query: "deployment" });
    expect(result.context).toBeTruthy();
    expect(result.episodeCount).toBeGreaterThan(0);
    expect(result.totalTokens).toBeGreaterThan(0);
    dag.close();
  });

  test("suggest respects maxTokens budget", async () => {
    const { handlers, dag } = createHandlers();
    seedEpisodes(dag, 50);
    const result = await handlers.suggest({
      query: "pipeline",
      maxTokens: 100,
    });
    expect(result.totalTokens).toBeLessThanOrEqual(150); // Some tolerance
    dag.close();
  });

  test("inject builds formatted context block for injection", async () => {
    const { handlers, dag } = createHandlers();
    seedEpisodes(dag, 10);
    const result = await handlers.inject({
      query: "pipeline configuration",
      project: undefined,
    });
    expect(result.contextBlock).toBeTruthy();
    expect(typeof result.contextBlock).toBe("string");
    // Should be formatted for injection
    expect(result.contextBlock.length).toBeGreaterThan(0);
    dag.close();
  });

  test("suggest returns empty for no matching episodes", async () => {
    const { handlers, dag } = createHandlers();
    const result = await handlers.suggest({
      query: "zyxwvutsrqp_nonexistent_term",
    });
    expect(result.episodeCount).toBe(0);
    dag.close();
  });
});
