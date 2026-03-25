import { describe, test, expect } from "bun:test";
import { SummaryDAG } from "../summary-dag";

function createDAG(): SummaryDAG {
  return new SummaryDAG(":memory:");
}

function seedEpisodes(dag: SummaryDAG, count: number): number[] {
  const ids: number[] = [];
  for (let i = 0; i < count; i++) {
    ids.push(
      dag.recordEpisode({
        timestamp: new Date(Date.now() - (count - i) * 60_000).toISOString(),
        source: "telegram",
        role: "user",
        content: `Episode ${i + 1} content about topic ${i % 3}`,
        importance: 3 + (i % 8),
      })
    );
  }
  return ids;
}

describe("SummaryDAG", () => {
  // --- Schema ---
  test("summaries table exists after construction", () => {
    const dag = createDAG();
    // Query the table — should not throw
    const row = dag.getSummaryCount();
    expect(row).toBe(0);
    dag.close();
  });

  test("episodes table gains confidence column via migration", () => {
    const dag = createDAG();
    const ids = seedEpisodes(dag, 1);
    const ep = dag.getEpisode(ids[0]!);
    expect(ep).toBeDefined();
    expect(ep!.confidence).toBe(1.0);
    dag.close();
  });

  // --- create ---
  test("create() inserts summary and returns numeric ID", () => {
    const dag = createDAG();
    const ids = seedEpisodes(dag, 5);
    const summaryId = dag.create({
      parentId: null,
      depth: 0,
      content: "Summary of first 5 episodes",
      sourceEpisodeIds: ids,
      tokenCount: 50,
    });
    expect(summaryId).toBeGreaterThan(0);
    expect(typeof summaryId).toBe("number");
    dag.close();
  });

  test("create() stores metadata as JSON", () => {
    const dag = createDAG();
    const ids = seedEpisodes(dag, 3);
    const summaryId = dag.create({
      parentId: null,
      depth: 0,
      content: "Summary with metadata",
      sourceEpisodeIds: ids,
      tokenCount: 30,
      metadata: { strategy: "normal", tier: 1 },
    });
    const summary = dag.getById(summaryId);
    expect(summary).toBeDefined();
    expect(summary!.metadata).toEqual({ strategy: "normal", tier: 1 });
    dag.close();
  });

  // --- getChildren ---
  test("getChildren() returns child summaries by parent_id", () => {
    const dag = createDAG();
    const ids = seedEpisodes(dag, 10);
    const parentId = dag.create({
      parentId: null,
      depth: 0,
      content: "Root summary",
      sourceEpisodeIds: ids.slice(0, 5),
      tokenCount: 40,
    });
    const child1 = dag.create({
      parentId,
      depth: 1,
      content: "Child 1",
      sourceEpisodeIds: ids.slice(0, 3),
      tokenCount: 20,
    });
    const child2 = dag.create({
      parentId,
      depth: 1,
      content: "Child 2",
      sourceEpisodeIds: ids.slice(3, 5),
      tokenCount: 20,
    });
    const children = dag.getChildren(parentId);
    expect(children).toHaveLength(2);
    expect(children.map((c) => c.id)).toEqual(
      expect.arrayContaining([child1, child2])
    );
    dag.close();
  });

  // --- getByDepth ---
  test("getByDepth() returns summaries at specific depth", () => {
    const dag = createDAG();
    const ids = seedEpisodes(dag, 10);
    dag.create({
      parentId: null,
      depth: 0,
      content: "Depth 0 summary",
      sourceEpisodeIds: ids.slice(0, 5),
      tokenCount: 40,
    });
    dag.create({
      parentId: null,
      depth: 1,
      content: "Depth 1 summary",
      sourceEpisodeIds: ids.slice(5, 10),
      tokenCount: 40,
    });
    const depth0 = dag.getByDepth(0);
    expect(depth0).toHaveLength(1);
    expect(depth0[0]!.content).toBe("Depth 0 summary");
    dag.close();
  });

  // --- expand ---
  test("expand() returns source episodes for a summary", () => {
    const dag = createDAG();
    const ids = seedEpisodes(dag, 5);
    const summaryId = dag.create({
      parentId: null,
      depth: 0,
      content: "Summary for expansion",
      sourceEpisodeIds: ids.slice(0, 3),
      tokenCount: 30,
    });
    const episodes = dag.expand(summaryId);
    expect(episodes).toHaveLength(3);
    expect(episodes.map((e) => e.id)).toEqual(ids.slice(0, 3));
    dag.close();
  });

  // --- Fresh tail protection ---
  test("getFreshTailIds() excludes last N episodes from summarization candidates", () => {
    const dag = createDAG();
    const ids = seedEpisodes(dag, 30);
    const freshTail = dag.getFreshTailIds(20);
    expect(freshTail).toHaveLength(20);
    // Fresh tail should be the LAST 20 episodes
    expect(freshTail).toEqual(ids.slice(10));
    dag.close();
  });

  test("getFreshTailIds() returns all episodes when fewer than N exist", () => {
    const dag = createDAG();
    const ids = seedEpisodes(dag, 5);
    const freshTail = dag.getFreshTailIds(20);
    expect(freshTail).toHaveLength(5);
    expect(freshTail).toEqual(ids);
    dag.close();
  });

  test("getSummarizableSince() excludes fresh tail episodes", () => {
    const dag = createDAG();
    const ids = seedEpisodes(dag, 30);
    const summarizable = dag.getSummarizableSince(0, 20);
    expect(summarizable).toHaveLength(10);
    // Should be the first 10 (not in fresh tail)
    expect(summarizable.map((e) => e.id)).toEqual(ids.slice(0, 10));
    dag.close();
  });

  // --- FTS5 update trigger ---
  test("FTS5 search finds episodes by summary text after update", () => {
    const dag = createDAG();
    const ids = seedEpisodes(dag, 3);
    // Update summary on an episode
    dag.updateEpisodeSummary(ids[0]!, "unique searchable keyword xylophone");
    const results = dag.searchFTS("xylophone");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.id).toBe(ids[0]!);
    dag.close();
  });

  // --- Summary count ---
  test("getSummaryCount() returns correct count", () => {
    const dag = createDAG();
    seedEpisodes(dag, 5);
    dag.create({
      parentId: null,
      depth: 0,
      content: "Summary 1",
      sourceEpisodeIds: [1, 2],
      tokenCount: 20,
    });
    dag.create({
      parentId: null,
      depth: 0,
      content: "Summary 2",
      sourceEpisodeIds: [3, 4],
      tokenCount: 20,
    });
    expect(dag.getSummaryCount()).toBe(2);
    dag.close();
  });

  // --- Confidence column ---
  test("confidence defaults to 1.0 for new episodes", () => {
    const dag = createDAG();
    const ids = seedEpisodes(dag, 1);
    const ep = dag.getEpisode(ids[0]!);
    expect(ep!.confidence).toBe(1.0);
    dag.close();
  });
});
