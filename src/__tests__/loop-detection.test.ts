import { describe, test, expect, mock } from "bun:test";
import { LoopDetector, hashToolCall } from "../loop-detection";

describe("hashToolCall", () => {
  test("produces consistent hash for same tool name and sorted args", () => {
    const hash1 = hashToolCall("Read", { file_path: "/a.ts", limit: 100 });
    const hash2 = hashToolCall("Read", { file_path: "/a.ts", limit: 100 });
    expect(hash1).toBe(hash2);
  });

  test("produces different hash for different args", () => {
    const hash1 = hashToolCall("Read", { file_path: "/a.ts" });
    const hash2 = hashToolCall("Read", { file_path: "/b.ts" });
    expect(hash1).not.toBe(hash2);
  });

  test("produces same hash regardless of arg order", () => {
    const hash1 = hashToolCall("Read", { file_path: "/a.ts", limit: 100 });
    const hash2 = hashToolCall("Read", { limit: 100, file_path: "/a.ts" });
    expect(hash1).toBe(hash2);
  });
});

describe("LoopDetector", () => {
  test("phase 1: warns at 3 identical tool calls", () => {
    const detector = new LoopDetector();
    const sessionId = "session-1";
    const call = { tool: "Read", args: { file_path: "/a.ts" } };

    expect(detector.record(sessionId, call)).toBeNull();
    expect(detector.record(sessionId, call)).toBeNull();
    const result = detector.record(sessionId, call);
    expect(result).not.toBeNull();
    expect(result!.phase).toBe(1);
    expect(result!.action).toBe("warn");
  });

  test("phase 2: instructs stop at 4 identical calls", () => {
    const detector = new LoopDetector();
    const sessionId = "session-2";
    const call = { tool: "Bash", args: { command: "ls" } };

    for (let i = 0; i < 3; i++) detector.record(sessionId, call);
    const result = detector.record(sessionId, call);
    expect(result).not.toBeNull();
    expect(result!.phase).toBe(2);
    expect(result!.action).toBe("instruct");
  });

  test("phase 3: hard-stops at 5 identical calls", () => {
    const detector = new LoopDetector();
    const sessionId = "session-3";
    const call = { tool: "Write", args: { file_path: "/x.ts", content: "a" } };

    for (let i = 0; i < 4; i++) detector.record(sessionId, call);
    const result = detector.record(sessionId, call);
    expect(result).not.toBeNull();
    expect(result!.phase).toBe(3);
    expect(result!.action).toBe("hard_stop");
  });

  test("different tool calls don't trigger detection", () => {
    const detector = new LoopDetector();
    const sessionId = "session-4";

    expect(detector.record(sessionId, { tool: "Read", args: { file_path: "/a.ts" } })).toBeNull();
    expect(detector.record(sessionId, { tool: "Read", args: { file_path: "/b.ts" } })).toBeNull();
    expect(detector.record(sessionId, { tool: "Read", args: { file_path: "/c.ts" } })).toBeNull();
    expect(detector.record(sessionId, { tool: "Read", args: { file_path: "/d.ts" } })).toBeNull();
    expect(detector.record(sessionId, { tool: "Read", args: { file_path: "/e.ts" } })).toBeNull();
  });

  test("LRU eviction cleans up old session data", () => {
    const detector = new LoopDetector({ maxSessions: 2 });
    const call = { tool: "Read", args: { file_path: "/a.ts" } };

    // Fill sessions 1 and 2
    detector.record("s1", call);
    detector.record("s1", call);
    detector.record("s2", call);

    // Add session 3 — should evict s1
    detector.record("s3", call);

    // s1 should be gone — recording again starts fresh (no warn at 3rd)
    expect(detector.record("s1", call)).toBeNull();
    expect(detector.record("s1", call)).toBeNull();
    // Now at 3rd call — would warn if counter was preserved, but it was evicted
    const result = detector.record("s1", call);
    expect(result).not.toBeNull();
    expect(result!.phase).toBe(1);
  });

  test("clearSession removes session tracking", () => {
    const detector = new LoopDetector();
    const sessionId = "session-clear";
    const call = { tool: "Read", args: { file_path: "/a.ts" } };

    detector.record(sessionId, call);
    detector.record(sessionId, call);
    detector.clearSession(sessionId);

    // After clear, counter resets
    expect(detector.record(sessionId, call)).toBeNull();
  });
});
