import { describe, test, expect } from "bun:test";
import { MemoryToolHandlers } from "../mcp/memory-tools";
import { SummaryDAG } from "../summary-dag";

function createHandlers(): { handlers: MemoryToolHandlers; dag: SummaryDAG } {
  const dag = new SummaryDAG(":memory:");
  const handlers = new MemoryToolHandlers(dag);
  return { handlers, dag };
}

function seedEpisodes(dag: SummaryDAG, count: number): number[] {
  const ids: number[] = [];
  for (let i = 0; i < count; i++) {
    ids.push(
      dag.recordEpisode({
        timestamp: new Date(Date.now() - (count - i) * 60_000).toISOString(),
        source: "telegram",
        role: "user",
        content: `Episode ${i + 1} about deployment and testing`,
        importance: 3 + (i % 8),
      })
    );
  }
  return ids;
}

describe("MemoryToolHandlers", () => {
  test("store records episode and returns ID", async () => {
    const { handlers, dag } = createHandlers();
    const result = await handlers.store({
      content: "New episode from MCP",
      source: "telegram",
      role: "user",
      importance: 5,
    });
    expect(result.episodeId).toBeGreaterThan(0);
    dag.close();
  });

  test("recall searches episodes via FTS5", async () => {
    const { handlers, dag } = createHandlers();
    seedEpisodes(dag, 5);
    const result = await handlers.recall({ query: "deployment" });
    expect(result.episodes.length).toBeGreaterThan(0);
    dag.close();
  });

  test("search uses scored retrieval", async () => {
    const { handlers, dag } = createHandlers();
    seedEpisodes(dag, 10);
    const result = await handlers.search({
      query: "testing",
      maxResults: 5,
    });
    expect(result.episodes.length).toBeGreaterThan(0);
    expect(result.episodes.length).toBeLessThanOrEqual(5);
    dag.close();
  });

  test("expand returns source episodes for a summary", async () => {
    const { handlers, dag } = createHandlers();
    const ids = seedEpisodes(dag, 5);
    const summaryId = dag.create({
      parentId: null,
      depth: 0,
      content: "Test summary",
      sourceEpisodeIds: ids.slice(0, 3),
      tokenCount: 30,
    });
    const result = await handlers.expand({ summaryId });
    expect(result.episodes).toHaveLength(3);
    dag.close();
  });

  test("whiteboard read returns null for nonexistent project", async () => {
    const { handlers, dag } = createHandlers();
    const result = await handlers.whiteboardRead({ project: "nonexistent" });
    expect(result.content).toBeNull();
    dag.close();
  });

  test("whiteboard write then read returns content", async () => {
    const { handlers, dag } = createHandlers();
    await handlers.whiteboardWrite({
      project: "test-project",
      content: "Whiteboard content here",
    });
    const result = await handlers.whiteboardRead({ project: "test-project" });
    expect(result.content).toBe("Whiteboard content here");
    dag.close();
  });

  test("stats returns memory metrics", async () => {
    const { handlers, dag } = createHandlers();
    seedEpisodes(dag, 5);
    const stats = await handlers.stats();
    expect(stats.episodeCount).toBe(5);
    expect(stats.summaryCount).toBe(0);
    expect(typeof stats.storageSizeBytes).toBe("number");
    dag.close();
  });

  test("store with project field", async () => {
    const { handlers, dag } = createHandlers();
    const result = await handlers.store({
      content: "Project-specific episode",
      source: "pipeline",
      role: "assistant",
      project: "my-project",
      importance: 7,
    });
    expect(result.episodeId).toBeGreaterThan(0);
    dag.close();
  });

  test("search with project filter", async () => {
    const { handlers, dag } = createHandlers();
    dag.recordEpisode({
      timestamp: new Date().toISOString(),
      source: "telegram",
      role: "user",
      content: "Episode about deployment in project A",
      importance: 5,
      project: "project-a",
    });
    dag.recordEpisode({
      timestamp: new Date().toISOString(),
      source: "telegram",
      role: "user",
      content: "Episode about deployment in project B",
      importance: 5,
      project: "project-b",
    });
    const result = await handlers.search({
      query: "deployment",
      project: "project-a",
    });
    expect(result.episodes.length).toBeGreaterThan(0);
    expect(result.episodes.every((e) => e.project === "project-a")).toBe(true);
    dag.close();
  });
});
