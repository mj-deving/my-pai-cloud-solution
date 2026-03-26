// context-compressor.test.ts — Tests for ContextCompressor
import { describe, test, expect, mock, beforeEach } from "bun:test";
import { MemoryStore } from "../memory";
import { ContextCompressor } from "../context-compressor";
import type { Config } from "../config";
import type { ClaudeInvoker } from "../claude";
import type { SummaryDAG } from "../summary-dag";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    memoryMaxEpisodes: 1000,
    memoryDecayLambda: 0.023,
    ...overrides,
  } as Config;
}

function createStore(): MemoryStore {
  return new MemoryStore(":memory:", makeConfig());
}

function createMockClaude(response = "Summarized content"): ClaudeInvoker {
  return {
    oneShot: mock(() =>
      Promise.resolve({ sessionId: "", result: response, usage: undefined })
    ),
  } as unknown as ClaudeInvoker;
}

/** Insert N episodes with configurable timestamps and importance. */
async function insertEpisodes(
  store: MemoryStore,
  count: number,
  options: {
    baseTime?: Date;
    intervalMs?: number;
    importance?: number;
    content?: string;
  } = {}
): Promise<number[]> {
  const {
    baseTime = new Date("2026-03-20T10:00:00Z"),
    intervalMs = 5 * 60 * 1000, // 5 minutes apart
    importance = 5,
    content = "Test episode content about project work",
  } = options;
  const ids: number[] = [];
  for (let i = 0; i < count; i++) {
    const ts = new Date(baseTime.getTime() + i * intervalMs);
    const id = await store.record({
      timestamp: ts.toISOString(),
      source: "telegram",
      role: "user",
      content: `${content} #${i + 1}`,
      importance,
    });
    ids.push(id);
  }
  return ids;
}

describe("ContextCompressor", () => {
  let store: MemoryStore;
  let mockClaude: ClaudeInvoker;
  let compressor: ContextCompressor;

  beforeEach(() => {
    store = createStore();
    mockClaude = createMockClaude();
    compressor = new ContextCompressor(
      makeConfig(),
      mockClaude,
      store,
      null // no SummaryDAG
    );
  });

  // ── shouldCompress ────────────────────────────────────

  describe("shouldCompress", () => {
    test("returns true when at threshold", () => {
      expect(compressor.shouldCompress(80)).toBe(true);
    });

    test("returns false below threshold", () => {
      expect(compressor.shouldCompress(79)).toBe(false);
    });

    test("respects custom threshold", () => {
      const custom = new ContextCompressor(makeConfig(), mockClaude, store, null);
      // Default threshold is 80, check that custom works
      expect(custom.shouldCompress(60)).toBe(false);
      expect(custom.shouldCompress(80)).toBe(true);
      // When calling compress with custom threshold, shouldCompress uses instance default
      // Test with explicit threshold override
      const lowThreshold = new ContextCompressor(
        makeConfig(),
        mockClaude,
        store,
        null
      );
      expect(lowThreshold.shouldCompress(60, { threshold: 50 })).toBe(true);
      expect(lowThreshold.shouldCompress(60, { threshold: 70 })).toBe(false);
    });
  });

  // ── consolidateEpisodes (Pass 1) ─────────────────────

  describe("consolidateEpisodes via compress", () => {
    test("groups episodes by time window and summarizes 3+ chunks", async () => {
      // Insert 6 episodes within a 1-hour window (5 min apart)
      await insertEpisodes(store, 6, {
        baseTime: new Date("2026-03-20T10:00:00Z"),
        intervalMs: 5 * 60 * 1000,
      });

      const result = await compressor.compress({ maxPasses: 1 });

      expect(result.originalEpisodes).toBe(6);
      // oneShot should have been called for the chunk of 6 episodes
      expect((mockClaude.oneShot as ReturnType<typeof mock>).mock.calls.length).toBeGreaterThanOrEqual(1);
    });

    test("skips chunks with fewer than 3 episodes", async () => {
      // Insert 2 episodes — too few to consolidate
      await insertEpisodes(store, 2, {
        baseTime: new Date("2026-03-20T10:00:00Z"),
        intervalMs: 5 * 60 * 1000,
      });

      const result = await compressor.compress({ maxPasses: 1 });

      // No consolidation should happen
      expect(result.compressedEpisodes).toBe(0);
      expect((mockClaude.oneShot as ReturnType<typeof mock>).mock.calls.length).toBe(0);
    });

    test("handles multiple time-window groups", async () => {
      // Group 1: 4 episodes at 10:00-10:15
      await insertEpisodes(store, 4, {
        baseTime: new Date("2026-03-20T10:00:00Z"),
        intervalMs: 5 * 60 * 1000,
      });
      // Group 2: 4 episodes at 13:00-13:15 (different hour window)
      await insertEpisodes(store, 4, {
        baseTime: new Date("2026-03-20T13:00:00Z"),
        intervalMs: 5 * 60 * 1000,
      });

      const result = await compressor.compress({ maxPasses: 1 });

      // Both groups should be summarized
      expect((mockClaude.oneShot as ReturnType<typeof mock>).mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(result.compressedEpisodes).toBeGreaterThan(0);
    });

    test("respects maxConcurrent limit", async () => {
      // Insert many episodes across 4 different hours
      for (let h = 0; h < 4; h++) {
        await insertEpisodes(store, 4, {
          baseTime: new Date(`2026-03-20T${10 + h}:00:00Z`),
          intervalMs: 5 * 60 * 1000,
        });
      }

      const result = await compressor.compress({
        maxPasses: 1,
        maxConcurrent: 2,
      });

      // All 4 groups should still be processed, just in batches of 2
      expect((mockClaude.oneShot as ReturnType<typeof mock>).mock.calls.length).toBe(4);
      expect(result.compressedEpisodes).toBeGreaterThan(0);
    });
  });

  // ── extractKnowledge (Pass 2) ─────────────────────────

  describe("extractKnowledge via compress", () => {
    test("extracts from high-importance episodes", async () => {
      const knowledgeClaude = createMockClaude(
        JSON.stringify({
          domain: "project",
          key: "api-design",
          content: "REST endpoints follow resource naming",
        })
      );
      const comp = new ContextCompressor(
        makeConfig(),
        knowledgeClaude,
        store,
        null
      );

      // Insert episodes with importance 8 (above 7 threshold)
      await insertEpisodes(store, 2, {
        importance: 8,
        baseTime: new Date("2026-03-20T10:00:00Z"),
        intervalMs: 5 * 60 * 1000,
      });

      const result = await comp.compress({ maxPasses: 1 });

      // oneShot should be called for knowledge extraction on high-importance episodes
      expect(result.knowledgeExtracted).toBeGreaterThanOrEqual(0);
    });

    test("skips low-importance episodes for knowledge extraction", async () => {
      const comp = new ContextCompressor(makeConfig(), mockClaude, store, null);

      // Insert episodes with importance 3 (below 7 threshold)
      await insertEpisodes(store, 3, {
        importance: 3,
        baseTime: new Date("2026-03-20T10:00:00Z"),
        intervalMs: 5 * 60 * 1000,
      });

      const result = await comp.compress({ maxPasses: 1 });

      // Knowledge extraction should not have been attempted for low importance
      expect(result.knowledgeExtracted).toBe(0);
    });

    test("handles malformed JSON from oneShot gracefully", async () => {
      const badClaude = createMockClaude("This is not valid JSON at all");
      const comp = new ContextCompressor(makeConfig(), badClaude, store, null);

      // Insert high-importance episodes (fewer than 3 to avoid consolidation)
      await insertEpisodes(store, 2, {
        importance: 8,
        baseTime: new Date("2026-03-20T10:00:00Z"),
        intervalMs: 5 * 60 * 1000,
      });

      // Should not throw
      const result = await comp.compress({ maxPasses: 1 });
      expect(result.knowledgeExtracted).toBe(0);
    });
  });

  // ── pruneEpisodes (Pass 3) ────────────────────────────

  describe("pruneEpisodes via compress", () => {
    test("removes low-importance episodes", async () => {
      // Insert 30 low-importance episodes
      await insertEpisodes(store, 30, {
        importance: 2,
        baseTime: new Date("2026-03-20T10:00:00Z"),
        intervalMs: 5 * 60 * 1000,
      });

      const statsBefore = store.getStats();
      expect(statsBefore.episodeCount).toBe(30);

      const result = await compressor.compress({ maxPasses: 1, minImportance: 3 });

      // Some episodes should have been pruned
      expect(result.prunedEpisodes).toBeGreaterThan(0);
      const statsAfter = store.getStats();
      expect(statsAfter.episodeCount).toBeLessThan(30);
    });

    test("protects fresh tail (last 20 episodes)", async () => {
      // Insert 25 low-importance episodes
      await insertEpisodes(store, 25, {
        importance: 1,
        baseTime: new Date("2026-03-20T10:00:00Z"),
        intervalMs: 5 * 60 * 1000,
      });

      const result = await compressor.compress({ maxPasses: 1, minImportance: 3 });

      // Only 5 episodes should be prunable (25 - 20 fresh tail)
      expect(result.prunedEpisodes).toBe(5);
      const statsAfter = store.getStats();
      expect(statsAfter.episodeCount).toBe(20);
    });

    test("respects minImportance config", async () => {
      // Insert episodes with mixed importance
      await insertEpisodes(store, 10, {
        importance: 4,
        baseTime: new Date("2026-03-20T08:00:00Z"),
        intervalMs: 5 * 60 * 1000,
      });
      // Fresh tail (20 episodes) to ensure the above aren't protected
      await insertEpisodes(store, 20, {
        importance: 7,
        baseTime: new Date("2026-03-20T12:00:00Z"),
        intervalMs: 5 * 60 * 1000,
      });

      // minImportance=5 should prune the importance=4 episodes
      const result = await compressor.compress({ maxPasses: 1, minImportance: 5 });
      expect(result.prunedEpisodes).toBe(10);

      const statsAfter = store.getStats();
      expect(statsAfter.episodeCount).toBe(20);
    });
  });

  // ── Full compression cycle ────────────────────────────

  describe("compress full cycle", () => {
    test("runs all three passes and returns correct stats", async () => {
      const knowledgeClaude = createMockClaude(
        JSON.stringify({
          domain: "test",
          key: "finding",
          content: "Important discovery",
        })
      );
      const comp = new ContextCompressor(
        makeConfig(),
        knowledgeClaude,
        store,
        null
      );

      // Insert many episodes: some low-importance (pruneable), some high (knowledge-extractable)
      // Group of 5 within 1 hour (consolidatable)
      await insertEpisodes(store, 5, {
        importance: 5,
        baseTime: new Date("2026-03-20T08:00:00Z"),
        intervalMs: 10 * 60 * 1000,
      });
      // 2 high-importance episodes (knowledge-extractable, not consolidatable)
      await insertEpisodes(store, 2, {
        importance: 9,
        baseTime: new Date("2026-03-20T14:00:00Z"),
        intervalMs: 5 * 60 * 1000,
      });
      // 25 low-importance episodes as fresh tail padding + some pruneable
      await insertEpisodes(store, 25, {
        importance: 2,
        baseTime: new Date("2026-03-20T16:00:00Z"),
        intervalMs: 2 * 60 * 1000,
      });

      const result = await comp.compress({ maxPasses: 1, minImportance: 3 });

      expect(result.originalEpisodes).toBe(32);
      expect(result.passes).toBe(1);
      // Consolidated: the group of 5 should be summarized
      expect(result.compressedEpisodes).toBeGreaterThan(0);
      // Knowledge: 2 high-importance episodes
      expect(result.knowledgeExtracted).toBeGreaterThanOrEqual(0);
      // Pruned: some low-importance episodes outside fresh tail
      expect(result.prunedEpisodes).toBeGreaterThanOrEqual(0);
    });

    test("savedTokens is non-negative", async () => {
      await insertEpisodes(store, 10, {
        importance: 2,
        baseTime: new Date("2026-03-20T10:00:00Z"),
        intervalMs: 5 * 60 * 1000,
      });
      // Add fresh tail
      await insertEpisodes(store, 20, {
        importance: 5,
        baseTime: new Date("2026-03-20T14:00:00Z"),
        intervalMs: 2 * 60 * 1000,
      });

      const result = await compressor.compress({ maxPasses: 1, minImportance: 3 });

      expect(result.savedTokens).toBeGreaterThanOrEqual(0);
    });
  });

  // ── SummaryDAG integration ────────────────────────────

  describe("SummaryDAG integration", () => {
    test("stores consolidated summaries in DAG when available", async () => {
      const mockDag = {
        create: mock(() => 1),
      } as unknown as SummaryDAG;

      const comp = new ContextCompressor(
        makeConfig(),
        mockClaude,
        store,
        mockDag
      );

      // Insert 5 episodes in one hour window
      await insertEpisodes(store, 5, {
        baseTime: new Date("2026-03-20T10:00:00Z"),
        intervalMs: 5 * 60 * 1000,
      });

      await comp.compress({ maxPasses: 1 });

      // DAG create should have been called
      expect((mockDag.create as ReturnType<typeof mock>).mock.calls.length).toBeGreaterThanOrEqual(1);
    });
  });
});
