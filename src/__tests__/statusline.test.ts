import { describe, test, expect } from "bun:test";
import { formatStatusline, type GitInfo } from "../statusline";
import type { BridgeMode } from "../mode";

const WORKSPACE: BridgeMode = { type: "workspace" };
const PROJECT: BridgeMode = { type: "project", name: "my-project" };

const baseStats = {
  time: "14:30",
  messageCount: 5,
  episodeCount: 3,
};

describe("formatStatusline", () => {
  // --- Mode rendering ---
  test("workspace mode includes house icon and workspace label", () => {
    const result = formatStatusline(WORKSPACE, baseStats);
    expect(result).toContain("\u{1F3E0}"); // 🏠
    expect(result).toContain("workspace");
  });

  test("project mode includes folder icon and project name", () => {
    const result = formatStatusline(PROJECT, baseStats);
    expect(result).toContain("\u{1F4C1}"); // 📁
    expect(result).toContain("my-project");
  });

  // --- Context bar rendering ---
  test("0% context renders all-empty bar", () => {
    const result = formatStatusline(WORKSPACE, { ...baseStats, contextPercent: 0 });
    expect(result).toContain("\u2591".repeat(10)); // all empty
    expect(result).toContain("0%");
  });

  test("50% context renders approximately half filled", () => {
    const result = formatStatusline(WORKSPACE, { ...baseStats, contextPercent: 50 });
    expect(result).toContain("50%");
    // 5 filled + 5 empty
    expect(result).toContain("\u2588".repeat(5));
  });

  test("100% context renders all-filled bar", () => {
    const result = formatStatusline(WORKSPACE, { ...baseStats, contextPercent: 100 });
    expect(result).toContain("\u2588".repeat(10)); // all filled
    expect(result).toContain("100%");
  });

  test("values above 100 are clamped to 100", () => {
    const result = formatStatusline(WORKSPACE, { ...baseStats, contextPercent: 150 });
    expect(result).toContain("100%");
    expect(result).toContain("\u2588".repeat(10));
  });

  test("values below 0 are clamped to 0", () => {
    const result = formatStatusline(WORKSPACE, { ...baseStats, contextPercent: -10 });
    expect(result).toContain("0%");
    expect(result).toContain("\u2591".repeat(10));
  });

  // --- Optional fields ---
  test("git info shown when provided", () => {
    const git: GitInfo = { branch: "cloud/test", changed: 3, untracked: 1 };
    const result = formatStatusline(PROJECT, { ...baseStats, git });
    expect(result).toContain("cloud/test");
    expect(result).toContain("~3");
    expect(result).toContain("+1");
  });

  test("format mode shown when provided", () => {
    const result = formatStatusline(WORKSPACE, { ...baseStats, formatMode: "light" });
    expect(result).toContain("light");
  });

  // --- Stats in line 2 ---
  test("message count shown in output", () => {
    const result = formatStatusline(WORKSPACE, baseStats);
    expect(result).toContain("msg 5");
  });

  test("episode count shown in output", () => {
    const result = formatStatusline(WORKSPACE, baseStats);
    expect(result).toContain("3ep");
  });

  // --- Defaults ---
  test("contextPercent undefined defaults to 0% bar", () => {
    const result = formatStatusline(WORKSPACE, baseStats);
    expect(result).toContain("CTX");
    expect(result).toContain("0%");
  });

  // --- Header ---
  test("output contains PAI header separator", () => {
    const result = formatStatusline(WORKSPACE, baseStats);
    expect(result).toContain("PAI");
    expect(result).toContain("\u2550"); // ═
  });
});
