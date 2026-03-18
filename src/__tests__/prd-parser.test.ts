import { describe, test, expect, mock } from "bun:test";
import { PRDParser } from "../prd-parser";
import type { ClaudeInvoker } from "../claude";

// Valid PRD JSON matching ParsedPRDSchema
const VALID_PRD_JSON = JSON.stringify({
  title: "Test Feature",
  description: "A test feature for validation",
  project: "my-project",
  requirements: ["req1", "req2"],
  constraints: ["must be fast"],
  estimatedComplexity: "simple",
  suggestedSteps: [
    { description: "step 1", assignee: "isidore", dependsOn: [] },
    { description: "step 2", assignee: "gregor", dependsOn: ["0"] },
  ],
});

// Minimal valid PRD (empty arrays)
const MINIMAL_PRD_JSON = JSON.stringify({
  title: "Minimal",
  description: "Minimal PRD",
  project: null,
  requirements: [],
  constraints: [],
  estimatedComplexity: "simple",
  suggestedSteps: [],
});

function mockClaude(response: { result: string; error?: string | null }): ClaudeInvoker {
  return {
    oneShot: mock(() => Promise.resolve(response)),
  } as unknown as ClaudeInvoker;
}

function mockClaudeThrows(error: Error): ClaudeInvoker {
  return {
    oneShot: mock(() => Promise.reject(error)),
  } as unknown as ClaudeInvoker;
}

describe("PRDParser", () => {
  // --- Valid JSON ---
  test("parses valid JSON response into ParsedPRD", async () => {
    const claude = mockClaude({ result: VALID_PRD_JSON, error: null });
    const parser = new PRDParser(claude);
    const { prd, error } = await parser.parse("build a feature");

    expect(error).toBeUndefined();
    expect(prd).not.toBeNull();
    expect(prd!.title).toBe("Test Feature");
    expect(prd!.requirements).toEqual(["req1", "req2"]);
    expect(prd!.suggestedSteps).toHaveLength(2);
    expect(prd!.suggestedSteps[0]!.assignee).toBe("isidore");
  });

  // --- JSON in code block ---
  test("extracts JSON from markdown code block", async () => {
    const claude = mockClaude({
      result: `Here is the PRD:\n\`\`\`json\n${MINIMAL_PRD_JSON}\n\`\`\``,
      error: null,
    });
    const parser = new PRDParser(claude);
    const { prd, error } = await parser.parse("something");

    expect(error).toBeUndefined();
    expect(prd).not.toBeNull();
    expect(prd!.title).toBe("Minimal");
  });

  test("extracts JSON from code block without json language tag", async () => {
    const claude = mockClaude({
      result: `\`\`\`\n${MINIMAL_PRD_JSON}\n\`\`\``,
      error: null,
    });
    const parser = new PRDParser(claude);
    const { prd, error } = await parser.parse("something");

    expect(error).toBeUndefined();
    expect(prd).not.toBeNull();
    expect(prd!.title).toBe("Minimal");
  });

  // --- Raw JSON embedded in text ---
  test("extracts raw JSON object from surrounding text", async () => {
    const claude = mockClaude({
      result: `Here is the PRD: ${VALID_PRD_JSON} Hope this helps!`,
      error: null,
    });
    const parser = new PRDParser(claude);
    const { prd, error } = await parser.parse("something");

    expect(error).toBeUndefined();
    expect(prd).not.toBeNull();
    expect(prd!.title).toBe("Test Feature");
  });

  // --- No JSON found ---
  test("returns error when no JSON found in response", async () => {
    const claude = mockClaude({
      result: "I cannot parse this into a structured format.",
      error: null,
    });
    const parser = new PRDParser(claude);
    const { prd, error } = await parser.parse("something");

    expect(prd).toBeNull();
    expect(error).toContain("No JSON found");
  });

  // --- Invalid schema ---
  test("returns error for JSON that fails schema validation", async () => {
    const invalidJson = JSON.stringify({ title: "Only Title" }); // missing required fields
    const claude = mockClaude({ result: invalidJson, error: null });
    const parser = new PRDParser(claude);
    const { prd, error } = await parser.parse("something");

    expect(prd).toBeNull();
    expect(error).toContain("Schema validation failed");
  });

  // --- oneShot error ---
  test("propagates oneShot error response", async () => {
    const claude = mockClaude({ result: "", error: "Claude CLI timed out" });
    const parser = new PRDParser(claude);
    const { prd, error } = await parser.parse("something");

    expect(prd).toBeNull();
    expect(error).toBe("Claude CLI timed out");
  });

  // --- Invalid enum value ---
  test("returns error for invalid estimatedComplexity enum value", async () => {
    const invalidEnum = JSON.stringify({
      title: "T",
      description: "D",
      project: null,
      requirements: [],
      constraints: [],
      estimatedComplexity: "trivial", // not in "simple"|"medium"|"complex"
      suggestedSteps: [],
    });
    const claude = mockClaude({ result: invalidEnum, error: null });
    const parser = new PRDParser(claude);
    const { prd, error } = await parser.parse("something");

    expect(prd).toBeNull();
    expect(error).toContain("Schema validation failed");
  });

  // --- Greedy regex edge case ---
  test("handles response with multiple JSON objects (greedy regex)", async () => {
    const claude = mockClaude({
      result: `Option A: {"bad":"json"} and Option B: {"also":"bad"}`,
      error: null,
    });
    const parser = new PRDParser(claude);
    const { prd, error } = await parser.parse("something");

    // The greedy regex captures from first { to last }, producing invalid JSON
    // Either it fails schema validation or JSON parse — both are acceptable
    expect(prd).toBeNull();
    expect(error).toBeTruthy();
  });

  // --- oneShot throws ---
  test("catches oneShot exception and returns parse error", async () => {
    const claude = mockClaudeThrows(new Error("network failure"));
    const parser = new PRDParser(claude);
    const { prd, error } = await parser.parse("something");

    expect(prd).toBeNull();
    expect(error).toContain("Parse error:");
    expect(error).toContain("network failure");
  });
});
