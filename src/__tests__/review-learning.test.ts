import { describe, test, expect } from "bun:test";
import { parseReviewFindings } from "../review-learning";

describe("parseReviewFindings", () => {
  test("extracts single P0 finding", () => {
    const input = "[P0] SQL injection in dynamic query on line 42";
    const findings = parseReviewFindings(input);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("P0");
    expect(findings[0]!.text).toContain("SQL injection");
    expect(findings[0]!.line).toBe(1);
  });

  test("extracts multiple findings with different severities", () => {
    const input = `Some preamble text
[P1] Missing error handler in message pipeline
[P2] Console.log left in production path
[P0] Secret token logged to stdout`;
    const findings = parseReviewFindings(input);
    expect(findings).toHaveLength(3);
    // Sorted by severity: P0 first
    expect(findings[0]!.severity).toBe("P0");
    expect(findings[1]!.severity).toBe("P1");
    expect(findings[2]!.severity).toBe("P2");
  });

  test("captures continuation lines after finding", () => {
    const input = `[P1] Unhandled promise rejection
  in src/pipeline.ts:42
  Bun.spawn without .catch()`;
    const findings = parseReviewFindings(input);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.text).toContain("Bun.spawn without .catch()");
  });

  test("stops continuation at blank line", () => {
    const input = `[P1] First finding
continuation

[P2] Second finding`;
    const findings = parseReviewFindings(input);
    expect(findings).toHaveLength(2);
    expect(findings[0]!.text).not.toContain("Second finding");
  });

  test("stops continuation at next [PX] marker", () => {
    const input = `[P1] First finding
[P2] Second finding immediately after`;
    const findings = parseReviewFindings(input);
    expect(findings).toHaveLength(2);
    expect(findings[0]!.text).not.toContain("Second");
  });

  test("returns empty array for no findings", () => {
    const input = "All looks good! No issues found.";
    const findings = parseReviewFindings(input);
    expect(findings).toHaveLength(0);
  });

  test("returns empty array for empty string", () => {
    expect(parseReviewFindings("")).toHaveLength(0);
  });

  test("handles all severity levels", () => {
    const input = `[P0] critical
[P1] bug
[P2] improvement
[P3] style`;
    const findings = parseReviewFindings(input);
    expect(findings).toHaveLength(4);
    expect(findings.map(f => f.severity)).toEqual(["P0", "P1", "P2", "P3"]);
  });

  test("preserves original line numbers", () => {
    const input = `preamble
more preamble
[P2] Finding on line 3`;
    const findings = parseReviewFindings(input);
    expect(findings[0]!.line).toBe(3);
  });
});
