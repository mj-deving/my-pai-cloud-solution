import { describe, test, expect, mock, beforeEach } from "bun:test";
import { PlaybookRunner } from "../playbook";
import type { ClaudeInvoker, ClaudeResponse } from "../claude";
import type { MemoryStore } from "../memory";
import type { Config } from "../config";

// --- helpers ---

function makeConfig(): Config {
  return {
    memoryMaxEpisodes: 1000,
    memoryDecayLambda: 0.023,
  } as Config;
}

function makeClaude(
  oneShotFn: (...args: any[]) => Promise<ClaudeResponse>,
): ClaudeInvoker {
  return { oneShot: mock(oneShotFn) } as unknown as ClaudeInvoker;
}

const OK_RESPONSE: ClaudeResponse = {
  sessionId: "",
  result: "done",
  usage: undefined,
};

function evalPass(): ClaudeResponse {
  return {
    sessionId: "",
    result: JSON.stringify({ passed: true, feedback: "Looks good" }),
    usage: undefined,
  };
}

function evalFail(feedback = "Needs improvement"): ClaudeResponse {
  return {
    sessionId: "",
    result: JSON.stringify({ passed: false, feedback }),
    usage: undefined,
  };
}

// --- parsePlaybook ---

describe("PlaybookRunner", () => {
  describe("parsePlaybook", () => {
    const runner = new PlaybookRunner(makeConfig(), makeClaude(() => Promise.resolve(OK_RESPONSE)), null);

    test("returns empty array for empty string", () => {
      expect(runner.parsePlaybook("")).toEqual([]);
    });

    test("parses single unchecked step", () => {
      const steps = runner.parsePlaybook("- [ ] Do the thing");
      expect(steps).toEqual([
        { index: 1, description: "Do the thing", checked: false },
      ]);
    });

    test("parses multiple steps with correct indices", () => {
      const md = `# My Playbook
- [ ] First step
- [ ] Second step
- [ ] Third step
`;
      const steps = runner.parsePlaybook(md);
      expect(steps).toHaveLength(3);
      expect(steps[0]!.index).toBe(1);
      expect(steps[1]!.index).toBe(2);
      expect(steps[2]!.index).toBe(3);
      expect(steps[2]!.description).toBe("Third step");
    });

    test("skips already-checked items", () => {
      const md = `- [x] Already done
- [ ] Still todo
- [x] Also done
- [ ] Also todo
`;
      const steps = runner.parsePlaybook(md);
      expect(steps).toHaveLength(2);
      expect(steps[0]!.description).toBe("Still todo");
      expect(steps[1]!.description).toBe("Also todo");
    });

    test("handles malformed lines gracefully", () => {
      const md = `- [ ] Valid step
- [] Missing space
Not a checkbox at all
- [x] Checked
- [ ] Another valid step
`;
      const steps = runner.parsePlaybook(md);
      expect(steps).toHaveLength(2);
      expect(steps[0]!.description).toBe("Valid step");
      expect(steps[1]!.description).toBe("Another valid step");
    });
  });

  // --- executeStep (via run with single step) ---

  describe("executeStep", () => {
    test("successful execution returns result", async () => {
      const claude = makeClaude(() =>
        Promise.resolve({ ...OK_RESPONSE, result: "Step completed successfully" }),
      );
      const runner = new PlaybookRunner(makeConfig(), claude, null);
      const result = await runner.run("test", "- [ ] Do something", {
        evaluatorEnabled: false,
      });
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0]!.result).toBe("Step completed successfully");
      expect(result.steps[0]!.retries).toBe(0);
      expect(result.status).toBe("completed");
    });

    test("evaluator passes on first try", async () => {
      let callCount = 0;
      const claude = makeClaude(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve(OK_RESPONSE);
        return Promise.resolve(evalPass());
      });
      const runner = new PlaybookRunner(makeConfig(), claude, null);
      const result = await runner.run("test", "- [ ] Do something", {
        evaluatorEnabled: true,
      });
      expect(result.steps[0]!.evaluation?.passed).toBe(true);
      expect(result.steps[0]!.retries).toBe(0);
    });

    test("evaluator failure triggers retry", async () => {
      let callCount = 0;
      const claude = makeClaude(() => {
        callCount++;
        // Call 1: execute (fail eval), 2: eval (fail), 3: retry execute, 4: eval (pass)
        if (callCount === 1) return Promise.resolve(OK_RESPONSE);
        if (callCount === 2) return Promise.resolve(evalFail());
        if (callCount === 3) return Promise.resolve({ ...OK_RESPONSE, result: "improved" });
        return Promise.resolve(evalPass());
      });
      const runner = new PlaybookRunner(makeConfig(), claude, null);
      const result = await runner.run("test", "- [ ] Do something", {
        evaluatorEnabled: true,
        maxRetries: 2,
      });
      expect(result.steps[0]!.retries).toBe(1);
      expect(result.steps[0]!.evaluation?.passed).toBe(true);
      expect(result.steps[0]!.result).toBe("improved");
    });

    test("max retries exhausted marks step as failed", async () => {
      const claude = makeClaude(() => {
        // Always fail evaluation
        return Promise.resolve(evalFail("Still bad"));
      });
      // Override: execution returns OK, eval always fails
      let callCount = 0;
      const claude2 = makeClaude(() => {
        callCount++;
        // Odd calls = execution, even calls = evaluation (always fail)
        if (callCount % 2 === 1) return Promise.resolve(OK_RESPONSE);
        return Promise.resolve(evalFail("Still bad"));
      });
      const runner = new PlaybookRunner(makeConfig(), claude2, null);
      const result = await runner.run("test", "- [ ] Do something", {
        evaluatorEnabled: true,
        maxRetries: 2,
      });
      expect(result.steps[0]!.evaluation?.passed).toBe(false);
      expect(result.steps[0]!.retries).toBe(2);
      expect(result.steps[0]!.error).toBeDefined();
    });

    test("evaluator disabled skips evaluation", async () => {
      const claude = makeClaude(() => Promise.resolve(OK_RESPONSE));
      const runner = new PlaybookRunner(makeConfig(), claude, null);
      const result = await runner.run("test", "- [ ] Do something", {
        evaluatorEnabled: false,
      });
      expect(result.steps[0]!.evaluation).toBeUndefined();
      expect((claude.oneShot as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
    });
  });

  // --- evaluate ---

  describe("evaluate", () => {
    test("passes valid result", async () => {
      let callCount = 0;
      const claude = makeClaude(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve(OK_RESPONSE);
        return Promise.resolve(evalPass());
      });
      const runner = new PlaybookRunner(makeConfig(), claude, null);
      const result = await runner.run("test", "- [ ] Do something", {
        evaluatorEnabled: true,
      });
      expect(result.steps[0]!.evaluation).toEqual({
        passed: true,
        feedback: "Looks good",
      });
    });

    test("fails poor result", async () => {
      let callCount = 0;
      const claude = makeClaude(() => {
        callCount++;
        if (callCount % 2 === 1) return Promise.resolve(OK_RESPONSE);
        return Promise.resolve(evalFail("Output is incomplete"));
      });
      const runner = new PlaybookRunner(makeConfig(), claude, null);
      const result = await runner.run("test", "- [ ] Do something", {
        evaluatorEnabled: true,
        maxRetries: 0,
      });
      expect(result.steps[0]!.evaluation?.passed).toBe(false);
      expect(result.steps[0]!.evaluation?.feedback).toBe("Output is incomplete");
    });

    test("handles malformed JSON response gracefully", async () => {
      let callCount = 0;
      const claude = makeClaude(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve(OK_RESPONSE);
        // Return non-JSON
        return Promise.resolve({
          ...OK_RESPONSE,
          result: "I think it looks fine, no issues found",
        });
      });
      const runner = new PlaybookRunner(makeConfig(), claude, null);
      const result = await runner.run("test", "- [ ] Do something", {
        evaluatorEnabled: true,
      });
      // Should default to passed=false on parse failure (fail-safe)
      expect(result.steps[0]!.evaluation?.passed).toBe(false);
    });
  });

  // --- run ---

  describe("run", () => {
    test("full playbook success", async () => {
      let callCount = 0;
      const claude = makeClaude(() => {
        callCount++;
        return Promise.resolve({ ...OK_RESPONSE, result: `Result ${callCount}` });
      });
      const runner = new PlaybookRunner(makeConfig(), claude, null);
      const result = await runner.run(
        "deploy",
        "- [ ] Step one\n- [ ] Step two\n- [ ] Step three",
        { evaluatorEnabled: false },
      );
      expect(result.name).toBe("deploy");
      expect(result.completedSteps).toBe(3);
      expect(result.totalSteps).toBe(3);
      expect(result.status).toBe("completed");
      expect(result.steps).toHaveLength(3);
    });

    test("partial with stop-on-failure", async () => {
      let callCount = 0;
      const claude = makeClaude(() => {
        callCount++;
        if (callCount === 2) {
          return Promise.resolve({ ...OK_RESPONSE, result: "", error: "Claude failed" });
        }
        return Promise.resolve(OK_RESPONSE);
      });
      const runner = new PlaybookRunner(makeConfig(), claude, null);
      const result = await runner.run(
        "test",
        "- [ ] Step one\n- [ ] Step two\n- [ ] Step three",
        { evaluatorEnabled: false, onFailure: "stop" },
      );
      expect(result.status).toBe("partial");
      expect(result.completedSteps).toBe(1);
      expect(result.steps).toHaveLength(2); // stopped after step 2
    });

    test("continue mode skips failures", async () => {
      let callCount = 0;
      const claude = makeClaude(() => {
        callCount++;
        if (callCount === 2) {
          return Promise.resolve({ ...OK_RESPONSE, result: "", error: "Claude failed" });
        }
        return Promise.resolve(OK_RESPONSE);
      });
      const runner = new PlaybookRunner(makeConfig(), claude, null);
      const result = await runner.run(
        "test",
        "- [ ] Step one\n- [ ] Step two\n- [ ] Step three",
        { evaluatorEnabled: false, onFailure: "continue" },
      );
      expect(result.status).toBe("partial");
      expect(result.completedSteps).toBe(2); // steps 1 and 3
      expect(result.steps).toHaveLength(3); // all three attempted
    });

    test("records to memory when memoryStore available", async () => {
      const recordMock = mock(() => Promise.resolve(1));
      const memoryStore = {
        record: recordMock,
      } as unknown as MemoryStore;

      const claude = makeClaude(() => Promise.resolve(OK_RESPONSE));
      const runner = new PlaybookRunner(makeConfig(), claude, memoryStore);
      await runner.run("deploy", "- [ ] Step one\n- [ ] Step two", {
        evaluatorEnabled: false,
      });
      // One record per step + one final summary
      expect(recordMock.mock.calls.length).toBeGreaterThanOrEqual(2);
      // Check that records use source "playbook"
      const firstCall = (recordMock.mock.calls as any[][])[0]![0] as any;
      expect(firstCall.source).toBe("playbook");
      expect(firstCall.importance).toBe(6);
    });

    test("empty playbook returns completed with zero steps", async () => {
      const claude = makeClaude(() => Promise.resolve(OK_RESPONSE));
      const runner = new PlaybookRunner(makeConfig(), claude, null);
      const result = await runner.run("empty", "", { evaluatorEnabled: false });
      expect(result.status).toBe("completed");
      expect(result.completedSteps).toBe(0);
      expect(result.totalSteps).toBe(0);
      expect(result.steps).toEqual([]);
    });
  });
});
