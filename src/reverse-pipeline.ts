// reverse-pipeline.ts — Reverse pipeline: Isidore Cloud delegates tasks to Gregor
// Writes tasks to reverse-tasks/, polls reverse-results/ for completions.
// Uses same PipelineTask/PipelineResult schemas as the forward pipeline.

import { readdir, readFile, rename, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config";
import type { PipelineTask, PipelineResult } from "./pipeline";
import type { Verifier } from "./verifier";
import { PipelineTaskSchema, PipelineResultSchema, safeParse } from "./schemas";

// Serializable metadata for pending delegations — NO closures, NO functions
export interface PendingDelegation {
  taskId: string;
  prompt: string;
  project?: string;
  workflowId?: string;
  stepId?: string;
  delegatedAt: string;
}

// Callback type for result notifications (wired by bridge.ts)
export type ResultCallback = (
  taskId: string,
  result: PipelineResult,
  delegation: PendingDelegation,
) => Promise<void>;

export class ReversePipelineWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private reverseTasksDir: string;
  private reverseResultsDir: string;
  private reverseAckDir: string;
  private pendingDelegations = new Map<string, PendingDelegation>();
  // Phase 6B: optional verifier for Gregor result verification
  private verifier: Verifier | null = null;

  constructor(
    private config: Config,
    private onResult?: ResultCallback,
  ) {
    this.reverseTasksDir = join(config.pipelineDir, "reverse-tasks");
    this.reverseResultsDir = join(config.pipelineDir, "reverse-results");
    this.reverseAckDir = join(config.pipelineDir, "reverse-ack");
  }

  // Set callback after construction (allows bridge.ts to wire bot after init)
  setResultCallback(cb: ResultCallback): void {
    this.onResult = cb;
  }

  // Phase 6B: Set verifier for independent result verification
  setVerifier(verifier: Verifier): void {
    this.verifier = verifier;
  }

  // Reconstruct pending delegations from directory state after restart
  // Returns count of recovered in-flight delegations
  async loadPending(): Promise<PendingDelegation[]> {
    const recovered: PendingDelegation[] = [];

    try {
      const taskFiles = await readdir(this.reverseTasksDir);
      const ackFiles = new Set(await readdir(this.reverseAckDir).catch(() => []));
      const resultFiles = new Set(
        (await readdir(this.reverseResultsDir).catch(() => []))
          .map((f) => f.replace(".json", "")),
      );

      for (const file of taskFiles) {
        if (!file.endsWith(".json")) continue;

        // If task is already acked, skip
        if (ackFiles.has(file)) continue;

        try {
          const raw = await readFile(join(this.reverseTasksDir, file), "utf-8");
          const parseResult = safeParse(PipelineTaskSchema, raw, `reverse-pipeline/task/${file}`);
          if (!parseResult.success) {
            console.warn(`[reverse-pipeline] Skipping invalid task file ${file}: ${parseResult.error}`);
            continue;
          }
          const task = parseResult.data;

          // Skip if result already exists (will be picked up by poll)
          if (resultFiles.has(task.id)) continue;

          const delegation: PendingDelegation = {
            taskId: task.id,
            prompt: task.prompt.slice(0, 100),
            project: task.project,
            workflowId: (task.context as Record<string, string>)?.workflow_id,
            stepId: (task.context as Record<string, string>)?.step_id,
            delegatedAt: task.timestamp,
          };

          this.pendingDelegations.set(task.id, delegation);
          recovered.push(delegation);
        } catch (err) {
          console.warn(`[reverse-pipeline] Skipping unreadable task file ${file}: ${err}`);
        }
      }

      if (recovered.length > 0) {
        console.log(`[reverse-pipeline] Recovered ${recovered.length} in-flight delegation(s)`);
      }
    } catch (err) {
      console.warn(`[reverse-pipeline] loadPending error: ${err}`);
    }

    return recovered;
  }

  // Delegate a task to Gregor via the reverse pipeline
  async delegateToGregor(
    prompt: string,
    project?: string,
    priority?: string,
    workflowId?: string,
    stepId?: string,
  ): Promise<string> {
    const taskId = crypto.randomUUID();

    const task: PipelineTask = {
      id: taskId,
      from: "isidore_cloud",
      to: "gregor",
      timestamp: new Date().toISOString(),
      type: "delegate",
      priority: priority || "normal",
      project,
      prompt,
      // Store workflow metadata in context for crash recovery
      ...(workflowId && {
        context: {
          workflow_id: workflowId,
          step_id: stepId,
        },
      }),
    };

    // Track pending delegation (serializable metadata only)
    const delegation: PendingDelegation = {
      taskId,
      prompt: prompt.slice(0, 100),
      project,
      workflowId,
      stepId,
      delegatedAt: task.timestamp,
    };
    this.pendingDelegations.set(taskId, delegation);

    // Atomic write: .tmp → rename
    const filename = `${taskId}.json`;
    const tmpPath = join(this.reverseTasksDir, `${filename}.tmp`);
    const finalPath = join(this.reverseTasksDir, filename);

    await writeFile(tmpPath, JSON.stringify(task, null, 2) + "\n", "utf-8");
    await rename(tmpPath, finalPath);

    console.log(`[reverse-pipeline] Delegated task ${taskId.slice(0, 8)}... to gregor (${prompt.slice(0, 60)}...)`);
    return taskId;
  }

  // Start polling for results from Gregor
  start(): void {
    if (this.timer) return;
    const interval = this.config.reversePipelinePollIntervalMs;
    console.log(
      `[reverse-pipeline] Watching ${this.reverseResultsDir} (poll every ${interval}ms)`,
    );
    this.timer = setInterval(() => this.poll(), interval);
    // Also poll immediately on start
    this.poll();
  }

  // Stop polling
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log("[reverse-pipeline] Watcher stopped");
    }
  }

  // Get current pending delegations (for /pipeline status)
  getPending(): PendingDelegation[] {
    return Array.from(this.pendingDelegations.values());
  }

  // One poll cycle: scan reverse-results/ for completed delegations
  private async poll(): Promise<void> {
    try {
      const files = await readdir(this.reverseResultsDir);
      const resultFiles = files.filter((f) => f.endsWith(".json"));

      for (const file of resultFiles) {
        const resultPath = join(this.reverseResultsDir, file);

        try {
          const raw = await readFile(resultPath, "utf-8");
          const resultParse = safeParse(PipelineResultSchema, raw, `reverse-pipeline/result/${file}`);
          if (!resultParse.success) {
            console.warn(`[reverse-pipeline] Skipping ${file}: ${resultParse.error}`);
            continue;
          }
          const result = resultParse.data;

          if (!result.taskId) {
            console.warn(`[reverse-pipeline] Skipping ${file}: missing taskId`);
            continue;
          }

          // Match to pending delegation
          const delegation = this.pendingDelegations.get(result.taskId);

          console.log(
            `[reverse-pipeline] Result received for task ${result.taskId.slice(0, 8)}... (${result.status})` +
              (delegation ? "" : " [no matching delegation]"),
          );

          // Phase 6B: Verify completed results before routing
          if (this.verifier && result.status === "completed") {
            const resultText = result.result || (result as unknown as Record<string, unknown>).summary as string || "";
            const promptText = delegation?.prompt || "unknown";
            const verification = await this.verifier.verify(promptText, resultText);
            if (!verification.passed) {
              console.warn(`[reverse-pipeline] Verification failed for ${result.taskId.slice(0, 8)}...: ${verification.concerns}`);
              result.status = "error";
              result.error = `Verification failed: ${verification.concerns || verification.verdict}`;
            }
          }

          // Notify via callback
          if (this.onResult) {
            try {
              await this.onResult(
                result.taskId,
                result,
                delegation || {
                  taskId: result.taskId,
                  prompt: "unknown",
                  delegatedAt: new Date().toISOString(),
                },
              );
            } catch (err) {
              console.error(`[reverse-pipeline] Notification callback error: ${err}`);
            }
          }

          // Remove from pending
          this.pendingDelegations.delete(result.taskId);

          // Move result to ack/
          const ackPath = join(this.reverseAckDir, file);
          try {
            await rename(resultPath, ackPath);
          } catch (err) {
            console.warn(`[reverse-pipeline] Failed to move ${file} to ack/: ${err}`);
          }
        } catch (err) {
          // Malformed JSON or partial write — skip, retry next cycle
          console.warn(`[reverse-pipeline] Skipping ${file}: ${err}`);
        }
      }
    } catch (err) {
      // readdir failure — log but don't crash
      console.warn(`[reverse-pipeline] Poll error: ${err}`);
    }
  }
}
