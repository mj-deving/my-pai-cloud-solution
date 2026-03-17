import { describe, test, expect } from "bun:test";
import { classifyMessage, type MessageRoute } from "../message-classifier";
import type { BridgeMode } from "../mode";

const WORKSPACE: BridgeMode = { type: "workspace" };
const PROJECT: BridgeMode = { type: "project", name: "my-project" };

describe("classifyMessage", () => {
  // --- Commands → cli ---
  test("commands always route to cli", () => {
    expect(classifyMessage("/sync", WORKSPACE)).toBe("cli");
    expect(classifyMessage("/project foo", WORKSPACE)).toBe("cli");
    expect(classifyMessage("/status", WORKSPACE)).toBe("cli");
    expect(classifyMessage("/help", WORKSPACE)).toBe("cli");
  });

  // --- Project mode → cli ---
  test("project mode always routes to cli", () => {
    expect(classifyMessage("hi", PROJECT)).toBe("cli");
    expect(classifyMessage("what time is it?", PROJECT)).toBe("cli");
    expect(classifyMessage("thanks", PROJECT)).toBe("cli");
  });

  // --- Developer keywords → cli ---
  test("developer keywords route to cli", () => {
    expect(classifyMessage("refactor the auth module", WORKSPACE)).toBe("cli");
    expect(classifyMessage("fix the bug in pipeline", WORKSPACE)).toBe("cli");
    expect(classifyMessage("deploy to VPS", WORKSPACE)).toBe("cli");
    expect(classifyMessage("git status", WORKSPACE)).toBe("cli");
    expect(classifyMessage("review the changes", WORKSPACE)).toBe("cli");
    expect(classifyMessage("debug this error", WORKSPACE)).toBe("cli");
    expect(classifyMessage("build the project", WORKSPACE)).toBe("cli");
    expect(classifyMessage("create a new feature", WORKSPACE)).toBe("cli");
    expect(classifyMessage("investigate the crash", WORKSPACE)).toBe("cli");
  });

  // --- File/path references → cli ---
  test("file references route to cli", () => {
    expect(classifyMessage("look at src/bridge.ts", WORKSPACE)).toBe("cli");
    expect(classifyMessage("check the package.json", WORKSPACE)).toBe("cli");
    expect(classifyMessage("read ~/.claude/settings.json", WORKSPACE)).toBe("cli");
    expect(classifyMessage("what's in the .env file?", WORKSPACE)).toBe("cli");
  });

  // --- Long messages → cli ---
  test("long messages route to cli", () => {
    const longMsg = "a".repeat(301);
    expect(classifyMessage(longMsg, WORKSPACE)).toBe("cli");
  });

  test("messages at 300 chars route to direct", () => {
    const exactMsg = "a".repeat(300);
    expect(classifyMessage(exactMsg, WORKSPACE)).toBe("direct");
  });

  // --- Explicit CLI request → cli ---
  test("explicit cli requests route to cli", () => {
    expect(classifyMessage("use claude for this", WORKSPACE)).toBe("cli");
    expect(classifyMessage("think deeply about this", WORKSPACE)).toBe("cli");
    expect(classifyMessage("run the algorithm on this", WORKSPACE)).toBe("cli");
  });

  // --- Simple messages → direct ---
  test("greetings route to direct", () => {
    expect(classifyMessage("hi", WORKSPACE)).toBe("direct");
    expect(classifyMessage("good morning", WORKSPACE)).toBe("direct");
    expect(classifyMessage("hey there", WORKSPACE)).toBe("direct");
  });

  test("simple questions route to direct", () => {
    expect(classifyMessage("what time is it?", WORKSPACE)).toBe("direct");
    expect(classifyMessage("how are you?", WORKSPACE)).toBe("direct");
    expect(classifyMessage("whats the weather like?", WORKSPACE)).toBe("direct");
  });

  test("acknowledgments route to direct", () => {
    expect(classifyMessage("thanks", WORKSPACE)).toBe("direct");
    expect(classifyMessage("ok cool", WORKSPACE)).toBe("direct");
    expect(classifyMessage("got it", WORKSPACE)).toBe("direct");
  });

  test("general knowledge questions route to direct", () => {
    expect(classifyMessage("explain quantum computing", WORKSPACE)).toBe("direct");
    expect(classifyMessage("what is the capital of France?", WORKSPACE)).toBe("direct");
    expect(classifyMessage("summarize today", WORKSPACE)).toBe("direct");
  });

  // --- Edge cases ---
  test("empty string routes to direct", () => {
    expect(classifyMessage("", WORKSPACE)).toBe("direct");
  });

  test("whitespace-only routes to direct", () => {
    expect(classifyMessage("   ", WORKSPACE)).toBe("direct");
  });
});
