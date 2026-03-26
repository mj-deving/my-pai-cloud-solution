import { describe, test, expect, mock, beforeEach } from "bun:test";
import { GroupChatEngine } from "../group-chat";
import { MemoryStore } from "../memory";
import type { Config } from "../config";
import type { ClaudeInvoker, ClaudeResponse } from "../claude";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    groupChatMaxAgents: 5,
    memoryMaxEpisodes: 1000,
    memoryDecayLambda: 0.023,
    ...overrides,
  } as Config;
}

function mockClaude(): ClaudeInvoker {
  const oneShot = mock(async (prompt: string): Promise<ClaudeResponse> => ({
    sessionId: "test-session",
    result: `Response to: ${prompt.slice(0, 40)}`,
  }));
  return { oneShot } as unknown as ClaudeInvoker;
}

describe("GroupChatEngine", () => {
  test("dispatches to all participants and synthesizes", async () => {
    const claude = mockClaude();
    const engine = new GroupChatEngine(makeConfig(), claude, null, null);

    const result = await engine.chat("What is TypeScript?", [
      { name: "agent-a" },
      { name: "agent-b" },
    ]);

    expect(result.participants).toEqual(["agent-a", "agent-b"]);
    expect(result.responses.length).toBe(2);
    expect(result.synthesis).toBeTruthy();
    expect(result.moderator).toBe("moderator");
    // 2 agents + 1 moderator = 3 oneShot calls
    expect(claude.oneShot).toHaveBeenCalledTimes(3);
  });

  test("caps participants at maxAgents", async () => {
    const claude = mockClaude();
    const config = makeConfig({ groupChatMaxAgents: 2 } as Partial<Config>);
    const engine = new GroupChatEngine(config, claude, null, null);

    const result = await engine.chat("question", [
      { name: "a" }, { name: "b" }, { name: "c" }, { name: "d" },
    ]);

    expect(result.participants.length).toBe(2);
    // 2 agents + 1 moderator = 3
    expect(claude.oneShot).toHaveBeenCalledTimes(3);
  });

  test("handles agent errors gracefully", async () => {
    const claude = {
      oneShot: mock(async (prompt: string) => {
        if (prompt.includes("fail-agent")) throw new Error("agent crashed");
        return { sessionId: "s", result: "ok" } as ClaudeResponse;
      }),
    } as unknown as ClaudeInvoker;

    const engine = new GroupChatEngine(makeConfig(), claude, null, null);
    const result = await engine.chat("question", [
      { name: "good", systemPrompt: "be good" },
      { name: "bad", systemPrompt: "fail-agent" },
    ]);

    const good = result.responses.find(r => r.agent === "good");
    const bad = result.responses.find(r => r.agent === "bad");
    expect(good!.error).toBeUndefined();
    expect(bad!.error).toBe("agent crashed");
  });

  test("moderator synthesis is called with responses", async () => {
    const claude = mockClaude();
    const engine = new GroupChatEngine(makeConfig(), claude, null, null);

    const result = await engine.chat("test question", [{ name: "solo" }]);
    expect(result.synthesis).toContain("Response to:");
  });

  test("records to memory when memoryStore available", async () => {
    const claude = mockClaude();
    const store = new MemoryStore(":memory:", makeConfig());
    const engine = new GroupChatEngine(makeConfig(), claude, store, null);

    await engine.chat("test question", [{ name: "agent-x" }]);

    // Should have recorded agent response + synthesis = 2 episodes
    const count = store.getEpisodeCount();
    expect(count).toBe(2);
    store.close();
  });

  test("works without memoryStore", async () => {
    const claude = mockClaude();
    const engine = new GroupChatEngine(makeConfig(), claude, null, null);

    const result = await engine.chat("test", [{ name: "a" }]);
    expect(result.synthesis).toBeTruthy();
    expect(result.responses.length).toBe(1);
  });

  test("getStats returns maxAgents", () => {
    const claude = mockClaude();
    const engine = new GroupChatEngine(makeConfig(), claude, null, null);
    expect(engine.getStats()).toEqual({ maxAgents: 5 });
  });
});
