// playbook.ts — PlaybookRunner: parse markdown checklists, execute steps via Claude,
// evaluate results with a separate QA agent (GAN pattern), retry on failure.

import type { Config } from "./config";
import type { ClaudeInvoker, ClaudeResponse } from "./claude";
import type { MemoryStore } from "./memory";

// --- Types ---

export interface PlaybookStep {
  index: number;
  description: string;
  checked: boolean;
}

export interface PlaybookConfig {
  project?: string;
  timeout?: number; // ms per step, default 120000
  onFailure: "stop" | "continue" | "ask";
  evaluatorEnabled: boolean; // default true
  maxRetries: number; // default 2
}

export interface StepResult {
  step: PlaybookStep;
  result: string;
  evaluation?: { passed: boolean; feedback: string };
  retries: number;
  error?: string;
}

export interface PlaybookResult {
  name: string;
  steps: StepResult[];
  completedSteps: number;
  totalSteps: number;
  status: "completed" | "partial" | "failed";
}

// --- Defaults ---

const DEFAULT_CONFIG: PlaybookConfig = {
  timeout: 120_000,
  onFailure: "stop",
  evaluatorEnabled: true,
  maxRetries: 2,
};

// --- Regex ---

// Matches: - [ ] description  or  - [x] description
const CHECKBOX_RE = /^-\s+\[([ xX])\]\s+(.+)$/;

// --- PlaybookRunner ---

export class PlaybookRunner {
  constructor(
    private config: Config,
    private claude: ClaudeInvoker,
    private memoryStore: MemoryStore | null,
  ) {}

  /**
   * Parse markdown text into playbook steps.
   * Extracts `- [ ] description` lines. Skips `- [x]` (already done).
   */
  parsePlaybook(markdown: string): PlaybookStep[] {
    if (!markdown.trim()) return [];

    const lines = markdown.split("\n");
    const steps: PlaybookStep[] = [];
    let index = 0;

    for (const line of lines) {
      const match = line.trim().match(CHECKBOX_RE);
      if (!match) continue;

      const checked = match[1]!.toLowerCase() === "x";
      const description = match[2]!.trim();

      if (checked) continue; // skip already-done items

      index++;
      steps.push({ index, description, checked: false });
    }

    return steps;
  }

  /**
   * Run a complete playbook: parse → execute each step → return results.
   */
  async run(
    name: string,
    markdown: string,
    options?: Partial<PlaybookConfig>,
  ): Promise<PlaybookResult> {
    const config: PlaybookConfig = { ...DEFAULT_CONFIG, ...options };
    const steps = this.parsePlaybook(markdown);

    if (steps.length === 0) {
      return {
        name,
        steps: [],
        completedSteps: 0,
        totalSteps: 0,
        status: "completed",
      };
    }

    const results: StepResult[] = [];
    let completedSteps = 0;

    for (const step of steps) {
      const stepResult = await this.executeStep(step, config);
      results.push(stepResult);

      const failed = !!stepResult.error;

      if (!failed) {
        completedSteps++;
      }

      if (failed) {
        if (config.onFailure === "stop" || config.onFailure === "ask") {
          // "ask" not implemented — treat as stop
          break;
        }
        // "continue" — keep going
      }
    }

    const totalSteps = steps.length;
    const status: PlaybookResult["status"] =
      completedSteps === totalSteps
        ? "completed"
        : completedSteps === 0 && results.some((r) => r.error)
          ? "failed"
          : "partial";

    // Record final summary in memory
    if (this.memoryStore) {
      await this.memoryStore.record({
        timestamp: new Date().toISOString(),
        source: "playbook",
        role: "system",
        content: `[Playbook: ${name}] Completed ${completedSteps}/${totalSteps} steps. Status: ${status}`,
        summary: `Playbook "${name}" ${status}: ${completedSteps}/${totalSteps}`,
        importance: 6,
        project: config.project ?? null,
      });
    }

    return { name, steps: results, completedSteps, totalSteps, status };
  }

  /**
   * Execute a single step with optional evaluation + retry.
   */
  private async executeStep(
    step: PlaybookStep,
    config: PlaybookConfig,
  ): Promise<StepResult> {
    let retries = 0;
    let lastResult = "";
    let lastEvaluation: { passed: boolean; feedback: string } | undefined;
    let lastError: string | undefined;

    for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
      if (attempt > 0) retries++;

      // Build prompt — include feedback on retries
      let prompt = step.description;
      if (attempt > 0 && lastEvaluation) {
        prompt = `${step.description}\n\nPrevious attempt feedback: ${lastEvaluation.feedback}\n\nPlease improve your response based on this feedback.`;
      }

      // Execute
      const response = await this.claude.oneShot(prompt);

      if (response.error && !response.result) {
        lastError = response.error;
        lastResult = response.result || "";

        // Record step failure in memory
        await this.recordStep(step, config, lastResult, lastEvaluation, lastError);

        return {
          step,
          result: lastResult,
          evaluation: lastEvaluation,
          retries,
          error: lastError,
        };
      }

      lastResult = response.result;
      lastError = undefined;

      // Evaluate if enabled
      if (!config.evaluatorEnabled) {
        // Record step success
        await this.recordStep(step, config, lastResult, undefined, undefined);
        return { step, result: lastResult, retries, evaluation: undefined };
      }

      lastEvaluation = await this.evaluate(step, lastResult);

      if (lastEvaluation.passed) {
        await this.recordStep(step, config, lastResult, lastEvaluation, undefined);
        return { step, result: lastResult, evaluation: lastEvaluation, retries };
      }

      // If this was the last attempt, return with failure
      if (attempt === config.maxRetries) {
        const error = `Evaluation failed after ${retries} retries: ${lastEvaluation.feedback}`;
        await this.recordStep(step, config, lastResult, lastEvaluation, error);
        return {
          step,
          result: lastResult,
          evaluation: lastEvaluation,
          retries,
          error,
        };
      }
    }

    // Should not reach here, but satisfy TypeScript
    return {
      step,
      result: lastResult,
      evaluation: lastEvaluation,
      retries,
      error: lastError,
    };
  }

  /**
   * Run evaluator on step result (separate oneShot — GAN pattern).
   * Returns { passed, feedback }. Defaults to passed=true if JSON parse fails.
   */
  private async evaluate(
    step: PlaybookStep,
    result: string,
  ): Promise<{ passed: boolean; feedback: string }> {
    const prompt = `You are a QA agent. Grade this result against the task. Be skeptical — identify real issues, don't approve mediocre work.

Task: ${step.description}
Result: ${result}

Respond with JSON: {"passed": true/false, "feedback": "specific feedback"}`;

    const response = await this.claude.oneShot(prompt);

    try {
      // Try to extract JSON from the response
      const text = response.result.trim();
      // Handle possible markdown code blocks
      const jsonMatch = text.match(/\{[\s\S]*"passed"[\s\S]*\}/);
      if (!jsonMatch) {
        return { passed: false, feedback: "Evaluation parse failed — defaulting to fail for safety" };
      }
      const parsed = JSON.parse(jsonMatch[0]);
      if (typeof parsed.passed !== "boolean") {
        return { passed: false, feedback: "Evaluation parse failed — defaulting to fail for safety" };
      }
      return { passed: parsed.passed, feedback: String(parsed.feedback || "") };
    } catch {
      return { passed: false, feedback: "Evaluation parse failed — defaulting to fail for safety" };
    }
  }

  /**
   * Record a step result in memory.db if memoryStore is available.
   */
  private async recordStep(
    step: PlaybookStep,
    config: PlaybookConfig,
    result: string,
    evaluation: { passed: boolean; feedback: string } | undefined,
    error: string | undefined,
  ): Promise<void> {
    if (!this.memoryStore) return;

    const name = config.project ?? "unknown";
    const evalInfo = evaluation
      ? ` | Eval: ${evaluation.passed ? "PASS" : "FAIL"} — ${evaluation.feedback}`
      : "";
    const errorInfo = error ? ` | Error: ${error}` : "";

    await this.memoryStore.record({
      timestamp: new Date().toISOString(),
      source: "playbook",
      project: config.project ?? null,
      role: "system",
      content: `[Playbook] Step ${step.index}: ${step.description}\nResult: ${result.slice(0, 500)}${evalInfo}${errorInfo}`,
      summary: `Playbook step: ${step.description}`,
      importance: 6,
    });
  }
}
