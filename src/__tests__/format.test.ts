import { describe, test, expect } from "bun:test";
import { chunkMessage, escMd } from "../format";

describe("chunkMessage", () => {
  test("returns single chunk when text fits within maxSize", () => {
    const result = chunkMessage("hello world", 100);
    expect(result).toEqual(["hello world"]);
  });

  test("splits at paragraph boundary", () => {
    const text = "first paragraph\n\nsecond paragraph";
    const result = chunkMessage(text, 25);
    expect(result.length).toBe(2);
    expect(result[0]).toContain("first paragraph");
    expect(result[1]).toContain("second paragraph");
  });

  test("splits at line boundary when no paragraph break", () => {
    const text = "line one\nline two\nline three";
    const result = chunkMessage(text, 15);
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  test("adds part indicators for multiple chunks", () => {
    const text = "a".repeat(50) + "\n\n" + "b".repeat(50);
    const result = chunkMessage(text, 60);
    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result[0]).toMatch(/^\[1\//);
    expect(result[1]).toMatch(/^\[2\//);
  });

  test("handles empty string", () => {
    const result = chunkMessage("", 100);
    expect(result).toEqual([""]);
  });

  test("hard-breaks when no natural break point found", () => {
    const text = "a".repeat(200);
    const result = chunkMessage(text, 50);
    expect(result.length).toBeGreaterThanOrEqual(4);
  });
});

describe("escMd", () => {
  test("escapes underscores", () => {
    expect(escMd("hello_world")).toBe("hello\\_world");
  });

  test("escapes asterisks", () => {
    expect(escMd("**bold**")).toBe("\\*\\*bold\\*\\*");
  });

  test("escapes backticks", () => {
    expect(escMd("`code`")).toBe("\\`code\\`");
  });

  test("escapes square brackets", () => {
    expect(escMd("[link]")).toBe("\\[link]");
  });

  test("leaves normal text unchanged", () => {
    expect(escMd("hello world 123")).toBe("hello world 123");
  });

  test("escapes multiple special chars in one string", () => {
    expect(escMd("_*`[")).toBe("\\_\\*\\`\\[");
  });
});
