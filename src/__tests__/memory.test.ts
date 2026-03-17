import { describe, test, expect } from "bun:test";
import { MemoryStore } from "../memory";
import type { Config } from "../config";

// Minimal config for MemoryStore
function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    memoryMaxEpisodes: 1000,
    memoryDecayLambda: 0.023,
    ...overrides,
  } as Config;
}

function createStore(config?: Partial<Config>): MemoryStore {
  return new MemoryStore(":memory:", makeConfig(config));
}

const EPISODE = {
  timestamp: "2026-03-17T12:00:00Z",
  source: "telegram" as const,
  role: "user" as const,
  content: "Hello Isidore, how are you?",
};

describe("MemoryStore", () => {
  // --- record ---
  test("record() inserts episode and returns numeric ID", async () => {
    const store = createStore();
    const id = await store.record(EPISODE);
    expect(id).toBeGreaterThan(0);
    expect(typeof id).toBe("number");
    store.close();
  });

  test("record() uses default importance of 3", async () => {
    const store = createStore();
    const id = await store.record(EPISODE);
    const episodes = store.getEpisodesSince(0);
    expect(episodes[0]!.importance).toBe(3);
    store.close();
  });

  test("record() respects explicit importance", async () => {
    const store = createStore();
    await store.record({ ...EPISODE, importance: 8 });
    const episodes = store.getEpisodesSince(0);
    expect(episodes[0]!.importance).toBe(8);
    store.close();
  });

  test("record() stores metadata as JSON", async () => {
    const store = createStore();
    await store.record({ ...EPISODE, metadata: { route: "direct", model: "sonnet" } });
    const episodes = store.getEpisodesSince(0);
    expect(episodes[0]!.metadata).toEqual({ route: "direct", model: "sonnet" });
    store.close();
  });

  // --- getEpisodeCount ---
  test("getEpisodeCount() returns 0 for empty store", () => {
    const store = createStore();
    expect(store.getEpisodeCount()).toBe(0);
    store.close();
  });

  test("getEpisodeCount() returns correct count after inserts", async () => {
    const store = createStore();
    await store.record(EPISODE);
    await store.record({ ...EPISODE, content: "second message" });
    await store.record({ ...EPISODE, content: "third message" });
    expect(store.getEpisodeCount()).toBe(3);
    store.close();
  });

  test("getEpisodeCount() filters by project", async () => {
    const store = createStore();
    await store.record({ ...EPISODE, project: "project-a" });
    await store.record({ ...EPISODE, project: "project-a" });
    await store.record({ ...EPISODE, project: "project-b" });
    expect(store.getEpisodeCount("project-a")).toBe(2);
    expect(store.getEpisodeCount("project-b")).toBe(1);
    store.close();
  });

  // --- getSystemState / setSystemState ---
  test("getSystemState returns null for unknown key", () => {
    const store = createStore();
    expect(store.getSystemState("nonexistent")).toBeNull();
    store.close();
  });

  test("setSystemState + getSystemState roundtrip", () => {
    const store = createStore();
    store.setSystemState("workspace_session", "sess-123");
    expect(store.getSystemState("workspace_session")).toBe("sess-123");
    store.close();
  });

  test("setSystemState overwrites existing value", () => {
    const store = createStore();
    store.setSystemState("key", "value1");
    store.setSystemState("key", "value2");
    expect(store.getSystemState("key")).toBe("value2");
    store.close();
  });

  // --- distill / knowledge ---
  test("distill() creates knowledge entry", async () => {
    const store = createStore();
    await store.distill("codex-review", "P1: missing error handler", "Finding details...", [1, 2], 0.9);
    const entries = store.getKnowledgeByDomain("codex-review");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.key).toBe("P1: missing error handler");
    expect(entries[0]!.confidence).toBe(0.9);
    store.close();
  });

  test("distill() upserts on same domain+key", async () => {
    const store = createStore();
    await store.distill("test", "key1", "content1", [], 0.5);
    await store.distill("test", "key1", "content2", [], 0.8);
    const entries = store.getKnowledgeByDomain("test");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.content).toBe("content2");
    expect(entries[0]!.confidence).toBe(0.8);
    store.close();
  });

  test("getKnowledgeByDomain() returns empty for unknown domain", () => {
    const store = createStore();
    expect(store.getKnowledgeByDomain("nonexistent")).toHaveLength(0);
    store.close();
  });

  // --- whiteboard ---
  test("getWhiteboard returns null for unknown project", () => {
    const store = createStore();
    expect(store.getWhiteboard("unknown")).toBeNull();
    store.close();
  });

  test("setWhiteboard + getWhiteboard roundtrip", () => {
    const store = createStore();
    store.setWhiteboard("my-project", "## Status\nAll good");
    expect(store.getWhiteboard("my-project")).toBe("## Status\nAll good");
    store.close();
  });

  // --- getEpisodesSince ---
  test("getEpisodesSince() returns episodes after given ID", async () => {
    const store = createStore();
    const id1 = await store.record({ ...EPISODE, content: "first" });
    const id2 = await store.record({ ...EPISODE, content: "second" });
    await store.record({ ...EPISODE, content: "third" });

    const since = store.getEpisodesSince(id1);
    expect(since).toHaveLength(2);
    expect(since[0]!.content).toBe("second");
    expect(since[1]!.content).toBe("third");
    store.close();
  });

  test("getEpisodesSince(0) returns all episodes", async () => {
    const store = createStore();
    await store.record(EPISODE);
    await store.record({ ...EPISODE, content: "second" });
    expect(store.getEpisodesSince(0)).toHaveLength(2);
    store.close();
  });

  // --- getLastEpisodeId ---
  test("getLastEpisodeId() returns 0 for empty store", () => {
    const store = createStore();
    expect(store.getLastEpisodeId()).toBe(0);
    store.close();
  });

  test("getLastEpisodeId() returns highest ID", async () => {
    const store = createStore();
    await store.record(EPISODE);
    const id2 = await store.record({ ...EPISODE, content: "second" });
    expect(store.getLastEpisodeId()).toBe(id2);
    store.close();
  });

  // --- getStats ---
  test("getStats() returns accurate counts", async () => {
    const store = createStore();
    await store.record(EPISODE);
    await store.record({ ...EPISODE, content: "second" });
    await store.distill("test", "key1", "content", [], 0.7);

    const stats = store.getStats();
    expect(stats.episodeCount).toBe(2);
    expect(stats.knowledgeCount).toBe(1);
    expect(stats.hasVectorSearch).toBe(false);
    expect(stats.hasEmbeddings).toBe(false);
    expect(stats.storageSizeBytes).toBeGreaterThan(0);
    store.close();
  });

  // --- query (FTS5) ---
  test("query() finds episodes by keyword", async () => {
    const store = createStore();
    await store.record({ ...EPISODE, content: "Deploy the bridge to VPS" });
    await store.record({ ...EPISODE, content: "The weather is nice today" });

    const result = await store.query({ query: "bridge deploy" });
    expect(result.episodes.length).toBeGreaterThanOrEqual(1);
    expect(result.episodes[0]!.content).toContain("bridge");
    store.close();
  });

  test("query() returns empty for no match", async () => {
    const store = createStore();
    await store.record(EPISODE);
    const result = await store.query({ query: "xyznonexistent" });
    expect(result.episodes).toHaveLength(0);
    store.close();
  });
});
