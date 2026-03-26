import { describe, test, expect } from "bun:test";
import { MemoryStore } from "../memory";
import type { Config } from "../config";

function makeConfig(): Config {
  return {
    memoryMaxEpisodes: 1000,
    memoryDecayLambda: 0.023,
  } as Config;
}

function createStore(): MemoryStore {
  return new MemoryStore(":memory:", makeConfig());
}

const BASE = {
  timestamp: "2026-03-26T12:00:00Z",
  source: "telegram" as const,
  role: "user" as const,
};

describe("Retrieval Isolation", () => {
  test("1:1 scope filters out group episodes", async () => {
    const store = createStore();
    await store.record({ ...BASE, content: "hello world private", channel: "1:1" } as any);
    await store.record({ ...BASE, content: "hello world group", channel: "group" } as any);

    const result = await store.query({ query: "hello world", channelScope: "1:1" });
    expect(result.episodes.length).toBe(1);
    expect(result.episodes[0]!.content).toContain("private");
    store.close();
  });

  test("all scope includes group episodes", async () => {
    const store = createStore();
    await store.record({ ...BASE, content: "hello world private", channel: "1:1" } as any);
    await store.record({ ...BASE, content: "hello world group", channel: "group" } as any);

    const result = await store.query({ query: "hello world", channelScope: "all" });
    expect(result.episodes.length).toBe(2);
    store.close();
  });

  test("specific group scope returns matching group only", async () => {
    const store = createStore();
    await store.record({ ...BASE, content: "hello world alpha", channel: "group:alpha" } as any);
    await store.record({ ...BASE, content: "hello world beta", channel: "group:beta" } as any);

    const result = await store.query({ query: "hello world", channelScope: "group:alpha" });
    expect(result.episodes.length).toBe(1);
    expect(result.episodes[0]!.content).toContain("alpha");
    store.close();
  });

  test("default scope is backward compatible (null channel returned)", async () => {
    const store = createStore();
    await store.record({ ...BASE, content: "hello world legacy" });
    await store.record({ ...BASE, content: "hello world group", channel: "group" } as any);

    // Default channelScope is "1:1" — null channel episodes should be included
    const result = await store.query({ query: "hello world" });
    expect(result.episodes.length).toBe(1);
    expect(result.episodes[0]!.content).toContain("legacy");
    store.close();
  });

  test("scoredQuery respects channel scope", async () => {
    const store = createStore();
    await store.record({ ...BASE, content: "hello world private", channel: "1:1" } as any);
    await store.record({ ...BASE, content: "hello world group", channel: "group" } as any);

    const result = await store.scoredQuery({ query: "hello world", channelScope: "all" });
    expect(result.episodes.length).toBe(2);

    const scoped = await store.scoredQuery({ query: "hello world", channelScope: "1:1" });
    expect(scoped.episodes.length).toBe(1);
    store.close();
  });
});
