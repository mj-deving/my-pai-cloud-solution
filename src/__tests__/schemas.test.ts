import { describe, test, expect } from "bun:test";
import {
  PipelineTaskSchema,
  PipelineResultSchema,
  EpisodeSchema,
  safeParse,
  strictParse,
} from "../schemas";

// --- Valid fixtures ---

const VALID_TASK = {
  id: "task-001",
  from: "gregor",
  to: "isidore-cloud",
  timestamp: "2026-03-17T12:00:00Z",
  type: "one-shot",
  prompt: "Summarize the latest changes",
};

const VALID_RESULT = {
  id: "result-001",
  taskId: "task-001",
  from: "isidore-cloud",
  to: "gregor",
  timestamp: "2026-03-17T12:01:00Z",
  status: "completed" as const,
  result: "Changes summarized successfully",
};

const VALID_EPISODE = {
  timestamp: "2026-03-17T12:00:00Z",
  source: "telegram" as const,
  role: "user" as const,
  content: "Hello Isidore",
  importance: 5,
};

// --- PipelineTaskSchema ---

describe("PipelineTaskSchema", () => {
  test("accepts valid task JSON", () => {
    const result = PipelineTaskSchema.safeParse(VALID_TASK);
    expect(result.success).toBe(true);
  });

  test("accepts task with optional fields", () => {
    const result = PipelineTaskSchema.safeParse({
      ...VALID_TASK,
      priority: "high",
      project: "my-project",
      session_id: "sess-123",
      timeout_minutes: 5,
      op_id: "op-001",
    });
    expect(result.success).toBe(true);
  });

  test("rejects task missing 'id'", () => {
    const { id, ...noId } = VALID_TASK;
    const result = PipelineTaskSchema.safeParse(noId);
    expect(result.success).toBe(false);
  });

  test("rejects task missing 'from'", () => {
    const { from, ...noFrom } = VALID_TASK;
    const result = PipelineTaskSchema.safeParse(noFrom);
    expect(result.success).toBe(false);
  });

  test("rejects task missing 'to'", () => {
    const { to, ...noTo } = VALID_TASK;
    const result = PipelineTaskSchema.safeParse(noTo);
    expect(result.success).toBe(false);
  });

  test("rejects task missing 'prompt'", () => {
    const { prompt, ...noPrompt } = VALID_TASK;
    const result = PipelineTaskSchema.safeParse(noPrompt);
    expect(result.success).toBe(false);
  });

  test("rejects task with extra fields (strict mode)", () => {
    const result = PipelineTaskSchema.safeParse({
      ...VALID_TASK,
      unknownField: "should fail",
    });
    expect(result.success).toBe(false);
  });
});

// --- PipelineResultSchema ---

describe("PipelineResultSchema", () => {
  test("accepts valid result JSON", () => {
    const result = PipelineResultSchema.safeParse(VALID_RESULT);
    expect(result.success).toBe(true);
  });

  test("accepts result with optional usage", () => {
    const result = PipelineResultSchema.safeParse({
      ...VALID_RESULT,
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    expect(result.success).toBe(true);
  });

  test("rejects result with invalid status", () => {
    const result = PipelineResultSchema.safeParse({
      ...VALID_RESULT,
      status: "unknown",
    });
    expect(result.success).toBe(false);
  });

  test("rejects result missing 'taskId'", () => {
    const { taskId, ...noTaskId } = VALID_RESULT;
    const result = PipelineResultSchema.safeParse(noTaskId);
    expect(result.success).toBe(false);
  });
});

// --- EpisodeSchema ---

describe("EpisodeSchema", () => {
  test("accepts valid episode", () => {
    const result = EpisodeSchema.safeParse(VALID_EPISODE);
    expect(result.success).toBe(true);
  });

  test("accepts all valid source types", () => {
    const sources = [
      "telegram", "pipeline", "orchestrator", "handoff",
      "prd", "synthesis", "session_summary", "daily_memory",
    ];
    for (const source of sources) {
      const result = EpisodeSchema.safeParse({ ...VALID_EPISODE, source });
      expect(result.success).toBe(true);
    }
  });

  test("rejects invalid source type", () => {
    const result = EpisodeSchema.safeParse({
      ...VALID_EPISODE,
      source: "invalid_source",
    });
    expect(result.success).toBe(false);
  });

  test("rejects importance below 1", () => {
    const result = EpisodeSchema.safeParse({
      ...VALID_EPISODE,
      importance: 0,
    });
    expect(result.success).toBe(false);
  });

  test("rejects importance above 10", () => {
    const result = EpisodeSchema.safeParse({
      ...VALID_EPISODE,
      importance: 11,
    });
    expect(result.success).toBe(false);
  });

  test("accepts episode without optional fields", () => {
    const result = EpisodeSchema.safeParse({
      timestamp: "2026-03-17T12:00:00Z",
      source: "pipeline",
      role: "system",
      content: "Task completed",
    });
    expect(result.success).toBe(true);
  });
});

// --- safeParse ---

describe("safeParse", () => {
  test("returns success for valid data", () => {
    const result = safeParse(PipelineTaskSchema, VALID_TASK, "test");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe("task-001");
    }
  });

  test("returns success when parsing valid JSON string", () => {
    const result = safeParse(
      PipelineTaskSchema,
      JSON.stringify(VALID_TASK),
      "test",
    );
    expect(result.success).toBe(true);
  });

  test("returns failure with message for invalid data", () => {
    const result = safeParse(PipelineTaskSchema, { id: 123 }, "test");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeTruthy();
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  test("handles malformed JSON string gracefully", () => {
    const result = safeParse(PipelineTaskSchema, "{not valid json", "test");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("JSON");
    }
  });

  test("handles empty string gracefully", () => {
    const result = safeParse(PipelineTaskSchema, "", "test");
    expect(result.success).toBe(false);
  });
});

// --- strictParse ---

describe("strictParse", () => {
  test("returns data for valid input", () => {
    const data = strictParse(PipelineTaskSchema, VALID_TASK, "test");
    expect(data.id).toBe("task-001");
    expect(data.prompt).toBe("Summarize the latest changes");
  });

  test("throws on invalid data", () => {
    expect(() =>
      strictParse(PipelineTaskSchema, { id: "x" }, "test"),
    ).toThrow("[schemas]");
  });
});
