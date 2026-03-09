import { describe, test, expect } from "bun:test";
import { isRateLimitError, isAuthError, isRecoverableError, ClaudeInvoker } from "../claude";

describe("isRateLimitError", () => {
  test("detects rate_limit keyword", () => {
    expect(isRateLimitError("error: rate_limit exceeded")).toBe(true);
  });

  test("detects 429 status code", () => {
    expect(isRateLimitError("HTTP 429 Too Many Requests")).toBe(true);
  });

  test("detects overloaded", () => {
    expect(isRateLimitError("API is overloaded")).toBe(true);
  });

  test("detects Too many requests", () => {
    expect(isRateLimitError("Too many requests, please slow down")).toBe(true);
  });

  test("returns false for normal errors", () => {
    expect(isRateLimitError("connection timeout")).toBe(false);
  });

  test("returns false for empty string", () => {
    expect(isRateLimitError("")).toBe(false);
  });
});

describe("isAuthError", () => {
  test("detects authentication_failed", () => {
    expect(isAuthError("authentication_failed: token expired")).toBe(true);
  });

  test("detects OAuth token", () => {
    expect(isAuthError("OAuth token has expired")).toBe(true);
  });

  test("detects authentication_error", () => {
    expect(isAuthError("authentication_error: invalid credentials")).toBe(true);
  });

  test("returns false for rate limit errors", () => {
    expect(isAuthError("rate_limit exceeded")).toBe(false);
  });

  test("returns false for empty string", () => {
    expect(isAuthError("")).toBe(false);
  });
});

describe("isRecoverableError", () => {
  test("returns false for auth errors", () => {
    expect(isRecoverableError("authentication_failed: expired")).toBe(false);
  });

  test("returns false for rate limit errors", () => {
    expect(isRecoverableError("rate_limit exceeded")).toBe(false);
  });

  test("returns false for stale session errors", () => {
    expect(isRecoverableError("No conversation found with session ID abc123")).toBe(false);
  });

  test("returns true for generic errors", () => {
    expect(isRecoverableError("connection reset by peer")).toBe(true);
  });

  test("returns true for timeout errors", () => {
    expect(isRecoverableError("request timed out")).toBe(true);
  });

  test("returns true for empty string", () => {
    expect(isRecoverableError("")).toBe(true);
  });
});

describe("ClaudeInvoker.extractToolDetail", () => {
  test("extracts file path for Read tool", () => {
    const detail = ClaudeInvoker.extractToolDetail("Read", { file_path: "/home/user/projects/src/index.ts" });
    expect(detail).toBe("src/index.ts");
  });

  test("extracts file path for Write tool", () => {
    const detail = ClaudeInvoker.extractToolDetail("Write", { file_path: "/a/b/c.ts" });
    expect(detail).toBe("b/c.ts");
  });

  test("extracts file path for Edit tool", () => {
    const detail = ClaudeInvoker.extractToolDetail("Edit", { file_path: "/x/y.ts" });
    expect(detail).toBe("x/y.ts");
  });

  test("extracts pattern for Glob tool", () => {
    const detail = ClaudeInvoker.extractToolDetail("Glob", { pattern: "**/*.ts" });
    expect(detail).toBe("**/*.ts");
  });

  test("extracts pattern for Grep tool (truncated)", () => {
    const longPattern = "a".repeat(50);
    const detail = ClaudeInvoker.extractToolDetail("Grep", { pattern: longPattern });
    expect(detail).toBe(longPattern.slice(0, 40));
  });

  test("extracts command for Bash tool (truncated)", () => {
    const longCmd = "echo " + "x".repeat(60);
    const detail = ClaudeInvoker.extractToolDetail("Bash", { command: longCmd });
    expect(detail).toBe(longCmd.slice(0, 50));
  });

  test("extracts description for Task tool", () => {
    const detail = ClaudeInvoker.extractToolDetail("Task", { description: "Search for auth patterns" });
    expect(detail).toBe("Search for auth patterns");
  });

  test("extracts query for WebSearch tool", () => {
    const detail = ClaudeInvoker.extractToolDetail("WebSearch", { query: "Grammy bot error handling" });
    expect(detail).toBe("Grammy bot error handling");
  });

  test("extracts URL for WebFetch tool", () => {
    const detail = ClaudeInvoker.extractToolDetail("WebFetch", { url: "https://example.com/api/data" });
    expect(detail).toBe("https://example.com/api/data");
  });

  test("returns undefined for unknown tool", () => {
    const detail = ClaudeInvoker.extractToolDetail("UnknownTool", { data: "test" });
    expect(detail).toBeUndefined();
  });

  test("returns undefined when input is missing", () => {
    const detail = ClaudeInvoker.extractToolDetail("Read", undefined);
    expect(detail).toBeUndefined();
  });

  test("returns undefined when expected field is missing", () => {
    const detail = ClaudeInvoker.extractToolDetail("Read", { other_field: "test" });
    expect(detail).toBeUndefined();
  });
});
