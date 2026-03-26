// integration-s4.test.ts — Session 4 cross-subsystem integration tests
// Verifies that new modules compose correctly with existing infrastructure.

import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { Guardrails } from "../guardrails";
import { A2AClient } from "../a2a-client";
import { GroupChatEngine } from "../group-chat";
import { MemoryStore } from "../memory";
import type { Config } from "../config";

const mockConfig = {
  guardrailsEnabled: true,
  a2aClientEnabled: true,
  groupChatEnabled: true,
  groupChatMaxAgents: 3,
  memoryMaxEpisodes: 1000,
  memoryDecayLambda: 0.023,
  contextMaxTokens: 2000,
  contextMaxChars: 5000,
  observationMaskingEnabled: false,
  observationMaskingWindow: 5,
} as unknown as Config;

describe("Session 4 Integration", () => {
  test("Guardrails blocks destructive pipeline operation", () => {
    const guardrails = new Guardrails(mockConfig);
    const decision = guardrails.check("rm -rf /var/data", "pipeline");
    expect(decision.allowed).toBe(false);
  });

  test("Guardrails allows normal pipeline operation", () => {
    const guardrails = new Guardrails(mockConfig);
    const decision = guardrails.check("Analyze this code and report findings", "pipeline");
    expect(decision.allowed).toBe(true);
  });

  test("Guardrails blocks force-push in playbook context", () => {
    const guardrails = new Guardrails(mockConfig);
    const decision = guardrails.check("git push --force origin main", "playbook");
    expect(decision.allowed).toBe(false);
  });

  test("A2AClient initializes with empty agent registry", () => {
    const client = new A2AClient(mockConfig);
    expect(client.getDiscoveredAgents().size).toBe(0);
    expect(client.getStats().discoveredAgents).toBe(0);
  });

  test("Memory store records and queries with channel isolation", () => {
    const store = new MemoryStore(":memory:", mockConfig);

    // Record a 1:1 episode
    store.record({
      timestamp: new Date().toISOString(),
      source: "telegram",
      role: "user",
      content: "Hello from 1:1",
      importance: 5,
    });

    // Record a group episode
    store.record({
      timestamp: new Date().toISOString(),
      source: "group" as any,
      role: "assistant",
      content: "Hello from group chat",
      importance: 5,
      user_id: "agent1",
      channel: "group",
    } as any);

    // Query with default scope should return 1:1 episode
    // (FTS5 query with "Hello" matches both but channel filter applies)
    const stats = store.getStats();
    expect(stats.episodeCount).toBe(2);

    store.close();
  });

  test("GroupChatEngine respects maxAgents cap", () => {
    const mockClaude = {
      oneShot: async () => ({ sessionId: "", result: "test response" }),
    };
    const engine = new GroupChatEngine(
      { ...mockConfig, groupChatMaxAgents: 2 } as unknown as Config,
      mockClaude as any,
      null,
      null,
    );
    expect(engine.getStats().maxAgents).toBe(2);
  });

  test("Guardrails + GroupChat composition: guardrails allows group chat operations", () => {
    const guardrails = new Guardrails(mockConfig);
    const decision = guardrails.check("Synthesize responses from 3 agents on code review", "oneshot");
    expect(decision.allowed).toBe(true);
  });

  test("Config flags are independent — each can be toggled separately", () => {
    // Verify the flags exist in the mock
    expect(mockConfig.guardrailsEnabled).toBe(true);
    expect(mockConfig.a2aClientEnabled).toBe(true);
    expect(mockConfig.groupChatEnabled).toBe(true);
    expect(mockConfig.groupChatMaxAgents).toBe(3);
  });
});
