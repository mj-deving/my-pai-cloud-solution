// orchestrator.ts — Task Orchestrator: DAG-based workflow decomposition and execution
// Decomposes complex tasks into steps, assigns to isidore/gregor, manages dependencies.
// Persists workflows to disk for crash recovery. Uses Claude one-shot for decomposition.

import { readdir, readFile, writeFile, rename, mkdir, chmod } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config";
import type { ClaudeInvoker } from "./claude";
import type { ReversePipelineWatcher } from "./reverse-pipeline";
import type { PipelineTask } from "./pipeline";
import { escMd } from "./format";
import type { BranchManager } from "./branch-manager";
import type { RateLimiter } from "./rate-limiter";
import type { Verifier } from "./verifier";
import {
  WorkflowSchema,
  WorkflowStepSchema,
  safeParse,
  strictParse,
  type WorkflowStep,
  type Workflow,
} from "./schemas";
import { TraceCollector } from "./decision-trace";
import type { MemoryStore } from "./memory";

// Re-export types for backward compatibility
export type { WorkflowStep, Workflow };

export type NotifyCallback = (message: string) => Promise<void>;

// --- TaskOrchestrator ---

export class TaskOrchestrator {
  private workflows = new Map<string, Workflow>();
  private workflowsDir: string;
  private resultsDir: string;
  private branchManager: BranchManager | null = null;
  private rateLimiter: RateLimiter | null = null;
  private verifier: Verifier | null = null;
  private policyEngine: { check(action: string, context: Record<string, unknown>): Promise<{ allowed: boolean; reason: string }> } | null = null;
  // Phase C: optional memory store for outcome recording
  private memoryStore: MemoryStore | null = null;
  // Phase C: optional agent loader for dynamic decomposition + sub-delegation
  private agentLoader: {
    getAllAgents(): Array<{ id: string; name: string; description: string }>;
    getAgent(id: string): import("./agent-loader").AgentDefinition | undefined;
  } | null = null;
  // Live status: optional messenger for Telegram status updates
  private messenger: import("./messenger-adapter").MessengerAdapter | null = null;
  // Live status: per-workflow status message IDs
  private workflowStatusMsgs = new Map<string, number>();

  constructor(
    private config: Config,
    private claude: ClaudeInvoker,
    private reversePipeline: ReversePipelineWatcher | null,
    private onNotify?: NotifyCallback,
  ) {
    this.workflowsDir = join(config.pipelineDir, "workflows");
    this.resultsDir = join(config.pipelineDir, "results");
  }

  setBranchManager(branchManager: BranchManager): void {
    this.branchManager = branchManager;
  }

  // Phase 6A: Set rate limiter for dispatch gating
  setRateLimiter(limiter: RateLimiter): void {
    this.rateLimiter = limiter;
  }

  // Phase 6B: Set verifier for step result verification
  setVerifier(verifier: Verifier): void {
    this.verifier = verifier;
  }

  // Phase 4: Set policy engine for dispatch authorization
  setPolicyEngine(engine: { check(action: string, context: Record<string, unknown>): Promise<{ allowed: boolean; reason: string }> }): void {
    this.policyEngine = engine;
  }

  // Phase C: Set memory store for outcome recording
  setMemoryStore(store: MemoryStore): void {
    this.memoryStore = store;
  }

  // Phase C: Set agent loader for dynamic decomposition + sub-delegation
  setAgentLoader(loader: {
    getAllAgents(): Array<{ id: string; name: string; description: string }>;
    getAgent(id: string): import("./agent-loader").AgentDefinition | undefined;
  }): void {
    this.agentLoader = loader;
  }

  // Live status: Set messenger for Telegram status updates
  setMessenger(messenger: import("./messenger-adapter").MessengerAdapter): void {
    this.messenger = messenger;
  }

  setNotifyCallback(cb: NotifyCallback): void {
    this.onNotify = cb;
  }

  // --- Persistence ---

  async loadWorkflows(): Promise<number> {
    try {
      await mkdir(this.workflowsDir, { recursive: true });
      const files = await readdir(this.workflowsDir);
      let count = 0;

      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          const raw = await readFile(join(this.workflowsDir, file), "utf-8");
          const wf = strictParse(WorkflowSchema, raw, `orchestrator/workflow/${file}`);
          if (wf.id) {
            this.workflows.set(wf.id, wf);
            count++;
          }
        } catch (err) {
          console.warn(`[orchestrator] Skipping ${file}: ${err}`);
        }
      }

      if (count > 0) {
        console.log(`[orchestrator] Loaded ${count} workflow(s) from disk`);
      }

      // Resume active workflows
      for (const wf of this.workflows.values()) {
        if (wf.status === "active") {
          this.advanceWorkflow(wf.id).catch((err) => {
            console.warn(`[orchestrator] Failed to resume workflow ${wf.id.slice(0, 8)}...: ${err}`);
          });
        }
      }

      return count;
    } catch (err) {
      console.warn(`[orchestrator] loadWorkflows error: ${err}`);
      return 0;
    }
  }

  private async saveWorkflow(wf: Workflow): Promise<void> {
    wf.updatedAt = new Date().toISOString();
    const filename = `${wf.id}.json`;
    const tmpPath = join(this.workflowsDir, `${filename}.tmp`);
    const finalPath = join(this.workflowsDir, filename);
    await writeFile(tmpPath, JSON.stringify(wf, null, 2) + "\n", "utf-8");
    await rename(tmpPath, finalPath);
  }

  // --- Workflow creation ---

  async createWorkflow(
    description: string,
    project?: string,
    originTaskId?: string,
    originFrom?: string,
    delegationDepth = 0,
  ): Promise<{ workflow?: Workflow; error?: string }> {
    // Delegation depth guard
    if (delegationDepth >= this.config.orchestratorMaxDelegationDepth) {
      return { error: `Delegation depth limit (${this.config.orchestratorMaxDelegationDepth}) reached` };
    }

    // Decompose via Claude one-shot
    const prompt = this.buildDecompositionPrompt(description, project);
    const response = await this.claude.oneShot(prompt);

    if (response.error) {
      return { error: `Decomposition failed: ${response.error}` };
    }

    // Parse steps from Claude's response
    let rawSteps: unknown[];
    try {
      const text = response.result || "";
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        return { error: "Decomposition returned no JSON array" };
      }
      const parsed = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(parsed)) {
        return { error: "Decomposition result is not an array" };
      }
      rawSteps = parsed;
    } catch (err) {
      return { error: `Failed to parse decomposition: ${err}` };
    }

    // Build WorkflowStep[] from raw output — map through schema for validation
    const steps: WorkflowStep[] = rawSteps.map((raw: any) => {
      const step = {
        id: String(raw.id || ""),
        description: String(raw.description || ""),
        prompt: String(raw.prompt || raw.description || ""),
        assignee: raw.assignee === "gregor" ? ("gregor" as const) : ("isidore" as const),
        status: "pending" as const,
        dependsOn: Array.isArray(raw.dependsOn) ? raw.dependsOn.map(String) : [],
        project,
        retryCount: 0,
      };
      // Validate shape (non-strict — Claude may produce extra fields)
      const result = WorkflowStepSchema.safeParse(step);
      return result.success ? result.data : step;
    });

    // Validate DAG
    const validation = this.validateDecomposition(steps);
    if (!validation.valid) {
      return { error: `Validation failed: ${validation.errors.join("; ")}` };
    }

    // Steps with unmet deps start as "blocked"
    for (const step of steps) {
      if (step.dependsOn.length > 0) {
        step.status = "blocked";
      }
    }

    const workflow: Workflow = {
      id: crypto.randomUUID(),
      originTaskId: originTaskId || "",
      originFrom: originFrom || "marius",
      description,
      status: "active",
      steps,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      delegationDepth,
    };

    this.workflows.set(workflow.id, workflow);
    await this.saveWorkflow(workflow);
    console.log(`[orchestrator] Created workflow ${workflow.id.slice(0, 8)}... (${steps.length} steps)`);

    // Send initial status
    await this.updateWorkflowStatus(workflow);

    // Start advancing
    await this.advanceWorkflow(workflow.id);
    return { workflow };
  }

  // --- Validation ---

  validateDecomposition(steps: WorkflowStep[]): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (steps.length === 0) {
      errors.push("At least 1 step required");
      return { valid: false, errors };
    }

    if (steps.length > 10) {
      errors.push(`Maximum 10 steps allowed, got ${steps.length}`);
    }

    const stepIds = new Set(steps.map((s) => s.id));

    for (const step of steps) {
      if (!step.id) {
        errors.push("Step missing id");
        continue;
      }

      if (step.assignee !== "isidore" && step.assignee !== "gregor") {
        errors.push(`Step ${step.id}: invalid assignee "${step.assignee}"`);
      }

      if (step.dependsOn.includes(step.id)) {
        errors.push(`Step ${step.id}: self-dependency`);
      }

      for (const dep of step.dependsOn) {
        if (!stepIds.has(dep)) {
          errors.push(`Step ${step.id}: depends on unknown step "${dep}"`);
        }
      }

      if (!step.prompt) {
        errors.push(`Step ${step.id}: missing prompt`);
      }
    }

    // Cycle detection via topological sort
    if (errors.length === 0) {
      if (this.detectCycle(steps)) {
        errors.push("Circular dependency detected in step graph");
      }
    }

    return { valid: errors.length === 0, errors };
  }

  private detectCycle(steps: WorkflowStep[]): boolean {
    const inDegree = new Map<string, number>();
    const adj = new Map<string, string[]>();

    for (const step of steps) {
      inDegree.set(step.id, 0);
      adj.set(step.id, []);
    }

    for (const step of steps) {
      for (const dep of step.dependsOn) {
        adj.get(dep)?.push(step.id);
        inDegree.set(step.id, (inDegree.get(step.id) || 0) + 1);
      }
    }

    const queue: string[] = [];
    for (const [id, deg] of inDegree) {
      if (deg === 0) queue.push(id);
    }

    let sorted = 0;
    while (queue.length > 0) {
      const node = queue.shift()!;
      sorted++;
      for (const neighbor of adj.get(node) || []) {
        const newDeg = (inDegree.get(neighbor) || 1) - 1;
        inDegree.set(neighbor, newDeg);
        if (newDeg === 0) queue.push(neighbor);
      }
    }

    return sorted !== steps.length;
  }

  // --- Workflow advancement (idempotent) ---

  async advanceWorkflow(workflowId: string): Promise<void> {
    const wf = this.workflows.get(workflowId);
    if (!wf || wf.status !== "active") return;

    // Timeout check
    const elapsed = Date.now() - new Date(wf.createdAt).getTime();
    if (elapsed > this.config.orchestratorWorkflowTimeoutMs) {
      await this.timeoutWorkflow(wf);
      return;
    }

    // Unblock steps whose dependencies are all completed
    for (const step of wf.steps) {
      if (step.status === "blocked") {
        const allDepsMet = step.dependsOn.every((depId) => {
          const dep = wf.steps.find((s) => s.id === depId);
          return dep?.status === "completed";
        });
        if (allDepsMet) {
          step.status = "pending";
        }
      }
    }

    // Find steps ready to dispatch
    const ready = wf.steps.filter((s) => s.status === "pending");

    if (ready.length === 0) {
      // Check if workflow is complete
      const allDone = wf.steps.every(
        (s) => s.status === "completed" || s.status === "failed",
      );
      if (allDone) {
        const anyFailed = wf.steps.some((s) => s.status === "failed");
        wf.status = anyFailed ? "failed" : "completed";
        wf.completedAt = new Date().toISOString();
        await this.saveWorkflow(wf);
        await this.notifyCompletion(wf);
      }
      return;
    }

    // Idempotency guard: transition to in_progress BEFORE dispatch
    for (const step of ready) {
      step.status = "in_progress";
      step.startedAt = new Date().toISOString();
    }
    await this.saveWorkflow(wf);

    // Update live status
    await this.updateWorkflowStatus(wf);

    // Dispatch after save — prevents double-dispatch on concurrent advanceWorkflow() calls
    for (const step of ready) {
      this.dispatchStep(wf, step).catch((err) => {
        console.error(`[orchestrator] Dispatch error for ${step.id}: ${err}`);
        this.failStep(wf.id, step.id, `Dispatch error: ${err}`).catch(console.error);
      });
    }
  }

  // --- Step dispatch ---

  private async dispatchStep(wf: Workflow, step: WorkflowStep): Promise<void> {
    // Phase 4: Policy check before dispatch
    if (this.policyEngine) {
      const policyResult = await this.policyEngine.check("orchestrator.dispatch_step", {
        assignee: step.assignee,
        project: step.project,
        workflowId: wf.id,
      });
      if (!policyResult.allowed) {
        console.warn(`[orchestrator] Policy denied step ${step.id}: ${policyResult.reason}`);
        await this.failStep(wf.id, step.id, `Policy denied: ${policyResult.reason}`);
        return;
      }
    }

    // Phase 6A: Defer if rate limiter is in cooldown
    if (this.rateLimiter?.isPaused()) {
      console.log(`[orchestrator] Deferring ${step.id} — rate limiter paused`);
      step.status = "pending";
      step.startedAt = undefined;
      await this.saveWorkflow(wf);
      return;
    }

    console.log(
      `[orchestrator] Dispatching ${step.id} (${step.assignee}) in workflow ${wf.id.slice(0, 8)}...`,
    );

    if (step.assignee === "gregor") {
      if (!this.reversePipeline) {
        await this.failStep(wf.id, step.id, "Reverse pipeline not available");
        return;
      }
      // Delegate to Gregor — result comes back via reverse pipeline callback
      const taskId = await this.reversePipeline.delegateToGregor(
        step.prompt,
        step.project,
        undefined, // priority
        wf.id,     // workflowId — for result routing
        step.id,   // stepId — for result routing
      );
      step.taskId = taskId;
      await this.saveWorkflow(wf);
    } else {
      // Isidore step — execute via Claude one-shot
      // Phase 5C: Branch isolation for isidore steps with a project
      let taskBranch: string | null = null;
      const projectDir = step.project
        ? `/home/isidore_cloud/projects/${step.project}`
        : null;

      if (this.branchManager && projectDir) {
        taskBranch = await this.branchManager.checkout(
          projectDir,
          `${wf.id.slice(0, 8)}-${step.id}`,
          "orchestrator",
        );
      }

      try {
        // Try sub-delegation to a specialized agent
        const agent = this.resolveAgent(step);
        let response;
        if (agent) {
          console.log(`[orchestrator] Sub-delegating ${step.id} to agent "${agent.id}" (tier ${agent.executionTier})`);
          response = await this.claude.subDelegate(agent, step.prompt, {
            project: step.project,
            cwd: projectDir || undefined,
          });
        } else {
          response = await this.claude.oneShot(step.prompt);
        }
        if (response.error) {
          await this.failStep(wf.id, step.id, response.error);
        } else {
          await this.completeStep(wf.id, step.id, response.result || "");
        }
      } finally {
        // Release branch lock
        if (this.branchManager && projectDir && taskBranch) {
          await this.branchManager.release(
            projectDir,
            `${wf.id.slice(0, 8)}-${step.id}`,
          ).catch((err) => {
            console.warn(`[orchestrator] Branch release error for ${step.id}: ${err}`);
          });
        }
      }
    }
  }

  // --- Step completion / failure ---

  async completeStep(workflowId: string, stepId: string, result: string): Promise<void> {
    const wf = this.workflows.get(workflowId);
    if (!wf) return;

    const step = wf.steps.find((s) => s.id === stepId);
    if (!step || step.status === "completed") return; // Idempotent

    // Phase 6B: Verify result before marking complete
    if (this.verifier) {
      const verification = await this.verifier.verify(step.prompt, result);
      if (!verification.passed) {
        console.warn(`[orchestrator] Verification failed for ${stepId}: ${verification.concerns}`);
        await this.failStep(workflowId, stepId, `Verification failed: ${verification.concerns || verification.verdict}`);
        return;
      }
    }

    step.status = "completed";
    step.result = result.slice(0, 2000); // Cap stored result size
    step.completedAt = new Date().toISOString();
    await this.saveWorkflow(wf);
    await this.updateWorkflowStatus(wf);

    console.log(`[orchestrator] Step ${stepId} completed in workflow ${workflowId.slice(0, 8)}...`);
    await this.advanceWorkflow(workflowId);
  }

  async failStep(workflowId: string, stepId: string, error: string): Promise<void> {
    const wf = this.workflows.get(workflowId);
    if (!wf) return;

    const step = wf.steps.find((s) => s.id === stepId);
    if (!step) return;

    step.retryCount++;

    // Retry once before giving up
    if (step.retryCount <= 1) {
      console.log(`[orchestrator] Retrying step ${stepId} (attempt ${step.retryCount + 1})`);
      step.status = "pending";
      step.error = undefined;
      await this.saveWorkflow(wf);
      await this.advanceWorkflow(workflowId);
      return;
    }

    // Permanently failed
    step.status = "failed";
    step.error = error;
    step.completedAt = new Date().toISOString();

    wf.status = "failed";
    wf.completedAt = new Date().toISOString();
    await this.saveWorkflow(wf);
    await this.updateWorkflowStatus(wf);

    console.error(`[orchestrator] Step ${stepId} failed in workflow ${workflowId.slice(0, 8)}...: ${error}`);

    await this.notify(
      `**Workflow failed**\nID: \`${workflowId.slice(0, 8)}...\`\n` +
        `Description: ${escMd(wf.description)}\n` +
        `Failed step: ${step.id} (${step.assignee})\n` +
        `Error: ${escMd(error)}`,
    );

    await this.writeWorkflowResult(wf);
  }

  // --- Cancellation / timeout ---

  async cancelWorkflow(workflowId: string): Promise<boolean> {
    const wf = this.workflows.get(workflowId);
    if (!wf || wf.status !== "active") return false;

    wf.status = "cancelled";
    wf.completedAt = new Date().toISOString();

    for (const step of wf.steps) {
      if (step.status === "pending" || step.status === "blocked") {
        step.status = "failed";
        step.error = "Workflow cancelled";
      }
    }

    await this.saveWorkflow(wf);
    console.log(`[orchestrator] Workflow ${workflowId.slice(0, 8)}... cancelled`);
    return true;
  }

  private async timeoutWorkflow(wf: Workflow): Promise<void> {
    const completed = wf.steps.filter((s) => s.status === "completed");
    const timedOut = wf.steps.filter(
      (s) => s.status !== "completed" && s.status !== "failed",
    );

    wf.status = "failed";
    wf.completedAt = new Date().toISOString();

    for (const step of timedOut) {
      step.status = "failed";
      step.error = "Workflow timeout";
    }

    await this.saveWorkflow(wf);
    console.warn(`[orchestrator] Workflow ${wf.id.slice(0, 8)}... timed out`);

    await this.notify(
      `**Workflow timed out**\nID: \`${wf.id.slice(0, 8)}...\`\n` +
        `Description: ${escMd(wf.description)}\n` +
        `Completed: ${completed.length}/${wf.steps.length} steps\n` +
        `Timed out: ${timedOut.map((s) => s.id).join(", ")}`,
    );

    await this.writeWorkflowResult(wf);
  }

  // --- Notifications ---

  private async notify(message: string): Promise<void> {
    if (this.onNotify) {
      try {
        await this.onNotify(message);
      } catch (err) {
        console.error(`[orchestrator] Notification error: ${err}`);
      }
    }
  }

  private async notifyCompletion(wf: Workflow): Promise<void> {
    const completed = wf.steps.filter((s) => s.status === "completed").length;
    const failed = wf.steps.filter((s) => s.status === "failed").length;
    const status = wf.status === "completed" ? "completed" : "failed";

    await this.notify(
      `**Workflow ${status}**\nID: \`${wf.id.slice(0, 8)}...\`\n` +
        `Description: ${escMd(wf.description)}\n` +
        `Steps: ${completed}/${wf.steps.length} completed`,
    );

    // Phase C: Record workflow outcome episode in memory
    if (this.memoryStore) {
      this.memoryStore.record({
        timestamp: new Date().toISOString(),
        source: "orchestrator",
        project: wf.steps[0]?.project ?? null,
        session_id: null,
        role: "system",
        content: `Workflow ${status}: ${wf.description}\nSteps: ${completed}/${wf.steps.length} completed, ${failed} failed`,
        summary: `Workflow ${wf.id.slice(0, 8)} ${status}: ${completed}/${wf.steps.length} steps`,
        metadata: { workflowId: wf.id, status: wf.status, stepCount: wf.steps.length },
      }).catch((err) => {
        console.warn(`[orchestrator] Failed to record outcome episode for ${wf.id}: ${err}`);
      });
    }

    await this.writeWorkflowResult(wf);
  }

  // Write workflow result to results/ for Gregor consumption
  private async writeWorkflowResult(wf: Workflow): Promise<void> {
    if (!wf.originTaskId) return; // Only write for pipeline-originated workflows

    const completed = wf.steps.filter((s) => s.status === "completed");
    const failed = wf.steps.filter((s) => s.status === "failed");

    // Build step-level summary
    const stepSummaries = wf.steps.map((s) => {
      let line = `[${s.status}] ${s.id} (${s.assignee}): ${s.description}`;
      if (s.result) line += `\n  Result: ${s.result.slice(0, 500)}`;
      if (s.error) line += `\n  Error: ${s.error}`;
      return line;
    });

    const duration = wf.completedAt && wf.createdAt
      ? Math.round((new Date(wf.completedAt).getTime() - new Date(wf.createdAt).getTime()) / 1000)
      : null;

    const result = {
      id: `workflow-result-${wf.id}`,
      taskId: wf.originTaskId,
      workflowId: wf.id,
      from: "isidore_cloud",
      to: wf.originFrom,
      timestamp: new Date().toISOString(),
      type: "workflow_completion",
      status: wf.status === "completed" ? "completed" as const : "error" as const,
      result: [
        `Workflow ${wf.status}: ${wf.description}`,
        `Steps: ${completed.length}/${wf.steps.length} completed, ${failed.length} failed`,
        duration !== null ? `Duration: ${duration}s` : null,
        "",
        ...stepSummaries,
      ].filter(Boolean).join("\n"),
      error: wf.status !== "completed"
        ? `Workflow ${wf.status}: ${failed.map((s) => `${s.id}: ${s.error}`).join("; ")}`
        : undefined,
    };

    // Atomic write: .tmp → rename
    const filename = `workflow-${wf.originTaskId}.json`;
    const tmpPath = join(this.resultsDir, `${filename}.tmp`);
    const finalPath = join(this.resultsDir, filename);

    try {
      await writeFile(tmpPath, JSON.stringify(result, null, 2) + "\n", "utf-8");
      await chmod(tmpPath, 0o660);
      await rename(tmpPath, finalPath);
      console.log(`[orchestrator] Wrote workflow result to results/${filename}`);
    } catch (err) {
      console.error(`[orchestrator] Failed to write workflow result: ${err}`);
    }
  }

  // --- Pipeline hook ---

  async handleOrchestrationTask(task: PipelineTask): Promise<void> {
    console.log(`[orchestrator] Handling orchestration task ${task.id}`);
    const result = await this.createWorkflow(
      task.prompt,
      task.project,
      task.id,
      task.from,
    );

    if (result.error) {
      console.error(`[orchestrator] Failed to create workflow from task ${task.id}: ${result.error}`);
    }
  }

  // --- Queries ---

  getActiveWorkflows(): Workflow[] {
    return Array.from(this.workflows.values()).filter((w) => w.status === "active");
  }

  getWorkflow(id: string): Workflow | undefined {
    // Exact match
    const exact = this.workflows.get(id);
    if (exact) return exact;

    // Prefix match (short IDs from Telegram)
    for (const [wfId, wf] of this.workflows) {
      if (wfId.startsWith(id)) return wf;
    }
    return undefined;
  }

  getAllWorkflows(): Workflow[] {
    return Array.from(this.workflows.values());
  }

  getWorkflowSummary(wf: Workflow): string {
    const completed = wf.steps.filter((s) => s.status === "completed").length;
    const inProgress = wf.steps.filter((s) => s.status === "in_progress").length;
    const failed = wf.steps.filter((s) => s.status === "failed").length;

    let msg = `**Workflow: \`${wf.id.slice(0, 8)}...\`**\n`;
    msg += `Status: ${wf.status}\n`;
    msg += `Description: ${wf.description}\n`;
    msg += `Steps: ${completed}/${wf.steps.length} completed`;
    if (inProgress > 0) msg += `, ${inProgress} running`;
    if (failed > 0) msg += `, ${failed} failed`;
    msg += `\n\n`;

    const statusLabel: Record<string, string> = {
      completed: "[done]",
      in_progress: "[running]",
      pending: "[pending]",
      blocked: "[blocked]",
      failed: "[failed]",
    };

    for (const step of wf.steps) {
      const label = statusLabel[step.status] || `[${step.status}]`;
      msg += `${step.id} ${label} (${step.assignee}) ${step.description}\n`;
    }

    return msg;
  }

  // --- Live status ---

  private async updateWorkflowStatus(wf: Workflow): Promise<void> {
    if (!this.messenger) return;
    const completed = wf.steps.filter(s => s.status === "completed").length;
    const lines = [`Workflow ${wf.id.slice(0, 8)} (${completed}/${wf.steps.length} steps)`];
    const icons: Record<string, string> = {
      completed: "\u2713", in_progress: "\u2699", pending: " ", blocked: "\u2022", failed: "\u2717",
    };
    for (const step of wf.steps) {
      const icon = icons[step.status] || "?";
      lines.push(`[${icon}] ${step.id} (${step.assignee}) ${step.description.slice(0, 40)}`);
    }
    const text = lines.join("\n");

    const existingId = this.workflowStatusMsgs.get(wf.id);
    if (existingId) {
      this.messenger.editMessage(existingId, text).catch(() => {});
    } else {
      try {
        const handle = await this.messenger.sendStatusMessage(text);
        this.workflowStatusMsgs.set(wf.id, handle.messageId);
      } catch { /* status optional */ }
    }
  }

  // --- Sub-delegation ---

  /** Resolve an agent definition for a workflow step based on description/assignee. */
  private resolveAgent(step: WorkflowStep): import("./agent-loader").AgentDefinition | undefined {
    if (!this.agentLoader) return undefined;

    // Check if step description contains an agent ID pattern like "(code-reviewer)"
    const agentIdMatch = step.description.match(/\(([a-z0-9-]+)\)/);
    if (agentIdMatch) {
      const agent = this.agentLoader.getAgent(agentIdMatch[1]!);
      if (agent) return agent;
    }

    // Keyword fallback: match agent names/ids in the step description
    const allAgents = this.agentLoader.getAllAgents();
    const descLower = step.description.toLowerCase();
    for (const a of allAgents) {
      if (descLower.includes(a.id) || descLower.includes(a.name.toLowerCase())) {
        return this.agentLoader.getAgent(a.id);
      }
    }

    return undefined;
  }

  // --- Decomposition prompt ---

  private buildDecompositionPrompt(description: string, project?: string): string {
    // Phase C: Build dynamic agent list from loaded definitions
    let agentList = `- isidore: Complex analysis, code review, architecture, debugging, documentation, PAI skills
- gregor: Discord/OpenClaw ops, simple file operations, status checks, log analysis, cron, monitoring`;

    if (this.agentLoader) {
      const agents = this.agentLoader.getAllAgents();
      if (agents.length > 0) {
        const agentLines = agents.map(a => `- ${a.id}: ${a.description || a.name}`);
        agentList += `\n\nSPECIALIZED SUB-AGENTS (invoked by isidore via sub-delegation):\n${agentLines.join("\n")}`;
      }
    }

    return `You are a task orchestrator. Decompose this task into discrete steps.

AVAILABLE AGENTS:
${agentList}

RULES:
- Each step must have: id (step-NNN), description, prompt, assignee, dependsOn[]
- dependsOn references other step IDs (empty array if no dependencies)
- assignee must be exactly "isidore" or "gregor"
- Maximum 10 steps per workflow
- No circular dependencies
- To use a sub-agent, include its ID in the step description.
  Example: "Code review (code-reviewer): Review pipeline changes"

Return ONLY a JSON array of steps. No explanation.

TASK: ${description}
PROJECT: ${project || "none"}`;
  }
}
