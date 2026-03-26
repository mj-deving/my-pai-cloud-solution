// pipeline.ts — Cross-user task queue watcher for Gregor↔Isidore Cloud collaboration
// Polls /var/lib/pai-pipeline/tasks/ for JSON task files, dispatches to Claude,
// writes results to results/, moves processed tasks to ack/.
//
// Task schema (written by Gregor):
//   { id, from, to, timestamp, type, priority, mode, project, prompt, context?, constraints?, session_id?, timeout_minutes?, max_turns? }
//
// Result schema (written by this watcher):
//   { id, taskId, from, to, timestamp, status, result, usage?, error?, warnings?, session_id? }

import { readdir, rename, writeFile, readFile, unlink, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config";
import type { TaskOrchestrator } from "./orchestrator";
import type { BranchManager } from "./branch-manager";
import type { ResourceGuard } from "./resource-guard";
import type { RateLimiter } from "./rate-limiter";
import type { Verifier } from "./verifier";
import { IdempotencyStore } from "./idempotency";
import {
  PipelineTaskSchema,
  ClaudeJsonOutputSchema,
  safeParse,
  type PipelineTask,
  type PipelineResult,
  type StructuredResult,
  type DecisionTrace,
} from "./schemas";
import { TraceCollector } from "./decision-trace";
import { scanForInjection } from "./injection-scan";
import type { PolicyEngine } from "./policy";
import type { MemoryStore } from "./memory";

// Re-export types for backward compatibility
export type { PipelineTask, PipelineResult, StructuredResult };

// Priority levels — higher number = processed first
const PRIORITY_ORDER: Record<string, number> = { high: 3, normal: 2, low: 1 };

export class PipelineWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private tasksDir: string;
  private resultsDir: string;
  private ackDir: string;
  // Phase 4: Concurrency pool — replaces single `processing` boolean
  private activeCount = 0;
  private maxConcurrent: number;
  private inFlight = new Set<string>(); // Filenames currently being processed
  private activeProjects = new Set<string>(); // Projects with active tasks (per-project lock)
  // Phase 2: session-project affinity — prevents cross-project session contamination
  private sessionProjectMap = new Map<string, string>();
  // Phase 5B: optional orchestrator for type:"orchestrate" tasks
  private orchestrator: TaskOrchestrator | null = null;
  // Phase 5C: optional branch manager for task-specific branches
  private branchManager: BranchManager | null = null;
  // Phase 6A: optional resource guard and rate limiter
  private resourceGuard: ResourceGuard | null = null;
  private rateLimiter: RateLimiter | null = null;
  // Phase 6B: optional verifier for independent result verification
  private verifier: Verifier | null = null;
  // Phase 1: optional idempotency store for dedup
  private idempotencyStore: IdempotencyStore | null = null;
  // Phase 3 V2-D: optional PRD executor for type:"prd" tasks
  private prdExecutor: { execute(text: string, project?: string): Promise<unknown> } | null = null;
  // Phase 4: injection scanning flag
  private injectionScanEnabled: boolean;
  // Phase 4: optional policy engine for dispatch authorization
  private policyEngine: PolicyEngine | null = null;
  private guardrails: { check(operation: string, context?: string): { allowed: boolean; reason: string } } | null = null;
  // Phase C: optional memory store for outcome recording
  private memoryStore: MemoryStore | null = null;
  // Phase C: optional synthesis loop for type:"synthesis" tasks
  private synthesisLoop: { run(): Promise<unknown> } | null = null;
  // Workspace: optional daily memory writer for type:"daily-memory" tasks
  private dailyMemoryWriter: { writeDailyMemory(): Promise<unknown> } | null = null;
  // Live status: optional messenger for Telegram status updates
  private messenger: import("./messenger-adapter").MessengerAdapter | null = null;

  constructor(private config: Config) {
    this.tasksDir = join(config.pipelineDir, "tasks");
    this.resultsDir = join(config.pipelineDir, "results");
    this.ackDir = join(config.pipelineDir, "ack");
    this.maxConcurrent = config.pipelineMaxConcurrent;
    this.injectionScanEnabled = config.injectionScanEnabled;
  }

  // Start polling for task files
  start(): void {
    if (this.timer) return;
    console.log(
      `[pipeline] Watching ${this.tasksDir} (poll every ${this.config.pipelinePollIntervalMs}ms, max concurrent: ${this.maxConcurrent})`,
    );
    this.timer = setInterval(
      () => this.poll(),
      this.config.pipelinePollIntervalMs,
    );
    // Also poll immediately on start
    this.poll();
  }

  // Set orchestrator for type:"orchestrate" task hook
  setOrchestrator(orchestrator: TaskOrchestrator): void {
    this.orchestrator = orchestrator;
  }

  // Set branch manager for task-specific branch isolation
  setBranchManager(branchManager: BranchManager): void {
    this.branchManager = branchManager;
  }

  // Phase 6A: Set resource guard for memory-based dispatch gating
  setResourceGuard(guard: ResourceGuard): void {
    this.resourceGuard = guard;
  }

  // Phase 6A: Set rate limiter for failure-based cooldown
  setRateLimiter(limiter: RateLimiter): void {
    this.rateLimiter = limiter;
  }

  // Phase 6B: Set verifier for independent result verification
  setVerifier(verifier: Verifier): void {
    this.verifier = verifier;
  }

  // Phase 1: Set idempotency store for duplicate detection
  setIdempotencyStore(store: IdempotencyStore): void {
    this.idempotencyStore = store;
  }

  // Phase 3 V2-D: Set PRD executor for type:"prd" task routing
  setPRDExecutor(executor: { execute(text: string, project?: string): Promise<unknown> }): void {
    this.prdExecutor = executor;
  }

  // Phase 4: Set policy engine for dispatch authorization
  setPolicyEngine(engine: PolicyEngine): void {
    this.policyEngine = engine;
  }

  // Session 4: Wire guardrails for pre-dispatch authorization
  setGuardrails(g: { check(operation: string, context?: string): { allowed: boolean; reason: string } }): void {
    this.guardrails = g;
  }

  // Phase C: Set memory store for outcome recording
  setMemoryStore(store: MemoryStore): void {
    this.memoryStore = store;
  }

  // Workspace: Set daily memory writer for type:"daily-memory" tasks
  setDailyMemoryWriter(writer: { writeDailyMemory(): Promise<unknown> }): void {
    this.dailyMemoryWriter = writer;
  }

  // Phase C: Set synthesis loop for type:"synthesis" tasks
  setSynthesisLoop(loop: { run(): Promise<unknown> }): void {
    this.synthesisLoop = loop;
  }

  // Live status: Set messenger for Telegram status updates
  setMessenger(messenger: import("./messenger-adapter").MessengerAdapter): void {
    this.messenger = messenger;
  }

  // Get pipeline status (for /pipeline dashboard)
  getStatus(): { active: number; max: number; inFlight: string[] } {
    return {
      active: this.activeCount,
      max: this.maxConcurrent,
      inFlight: Array.from(this.inFlight),
    };
  }

  // Stop polling
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log("[pipeline] Watcher stopped");
    }
  }

  // One poll cycle: scan tasks/, sort by priority, dispatch up to available slots
  private async poll(): Promise<void> {
    // Phase 6A: Skip entire poll cycle if rate limiter is in cooldown
    if (this.rateLimiter?.isPaused()) return;

    // How many slots are free?
    const availableSlots = this.maxConcurrent - this.activeCount;
    if (availableSlots <= 0) return; // All slots busy

    try {
      const files = await readdir(this.tasksDir);
      const taskFiles = files.filter(
        (f) => f.endsWith(".json") && !this.inFlight.has(f),
      );

      if (taskFiles.length === 0) return;

      // Read and parse all tasks first (for priority sorting)
      const parsed: Array<{ filename: string; task: PipelineTask }> = [];
      for (const file of taskFiles) {
        const taskPath = join(this.tasksDir, file);
        try {
          const raw = await readFile(taskPath, "utf-8");
          const result = safeParse(PipelineTaskSchema, raw, `pipeline/task/${file}`);
          if (!result.success) {
            console.warn(`[pipeline] Skipping ${file}: ${result.error}`);
            continue;
          }
          const task = result.data;
          if (!task.id || !task.prompt) {
            console.warn(`[pipeline] Skipping ${file}: missing id or prompt`);
            continue;
          }
          parsed.push({ filename: file, task });
        } catch (err) {
          // File still being written or unreadable — skip, retry next cycle
          console.warn(`[pipeline] Skipping ${file}: ${err}`);
          continue;
        }
      }

      // Sort by priority (high > normal > low), tie-break by timestamp then filename
      parsed.sort((a, b) => {
        const pa = PRIORITY_ORDER[a.task.priority || "normal"] ?? PRIORITY_ORDER["normal"]!;
        const pb = PRIORITY_ORDER[b.task.priority || "normal"] ?? PRIORITY_ORDER["normal"]!;
        if (pa !== pb) return pb - pa; // Higher priority first
        if (a.task.timestamp && b.task.timestamp) {
          return a.task.timestamp.localeCompare(b.task.timestamp);
        }
        return a.filename.localeCompare(b.filename);
      });

      // Select tasks to dispatch — respect available slots + per-project lock
      const batch: Array<{ filename: string; task: PipelineTask }> = [];
      const batchProjects = new Set<string>();
      for (const entry of parsed) {
        if (batch.length >= availableSlots) break;
        // Phase 6A: Stop batching if memory is too low
        if (this.resourceGuard && !this.resourceGuard.canDispatch()) break;
        const project = entry.task.project || "";
        // Per-project lock: skip if this project already has an active or batched task
        if (project && (this.activeProjects.has(project) || batchProjects.has(project))) {
          continue;
        }
        batch.push(entry);
        if (project) batchProjects.add(project);
      }

      if (batch.length === 0) return;

      // Launch batch concurrently — fire-and-forget, processTask manages its own lifecycle
      for (const { filename, task } of batch) {
        this.inFlight.add(filename);
        this.activeCount++;
        if (task.project) this.activeProjects.add(task.project);
        // Do NOT await — let tasks run concurrently
        this.processTask(filename, task).catch((err) => {
          console.error(`[pipeline] Uncaught error in processTask ${task.id}: ${err}`);
        });
      }
    } catch (err) {
      // readdir failure (permissions, dir missing) — log but don't crash
      console.warn(`[pipeline] Poll error: ${err}`);
    }
  }

  // Process a single pre-parsed task (manages its own concurrency lifecycle)
  private async processTask(filename: string, task: PipelineTask): Promise<void> {
    const taskPath = join(this.tasksDir, filename);
    let taskBranch: string | null = null;
    const traces = new TraceCollector();
    let statusMsgId: number | null = null;
    const startTime = Date.now();

    const sendStatus = async () => {
      if (this.messenger) {
        try {
          const handle = await this.messenger.sendStatusMessage(
            `Pipeline ${task.id.slice(0, 8)} [${task.type || "task"}] ${task.priority || "normal"}`,
          );
          statusMsgId = handle.messageId;
        } catch { /* status is optional */ }
      }
    };

    const updateStatus = (text: string) => {
      if (!this.messenger || !statusMsgId) return;
      this.messenger.editMessage(statusMsgId, text).catch(() => {});
    };

    try {
      console.log(
        `[pipeline] Processing task ${task.id} from ${task.from} [${task.priority || "normal"}] (active: ${this.activeCount}/${this.maxConcurrent}) (${task.prompt.slice(0, 80)}...)`,
      );

      // Phase 1: Idempotency check — skip if already processed (before status notification)
      if (this.idempotencyStore) {
        const opId = task.op_id || (task.auto_op_id !== false ? IdempotencyStore.generateOpId(task.prompt) : null);
        if (opId && this.idempotencyStore.isDuplicate(opId)) {
          traces.emit({
            phase: "dispatch",
            decision: `Skipped duplicate task ${task.id}`,
            reason_code: "duplicate",
            context: { op_id: opId },
          });
          console.log(`[pipeline] Skipping duplicate task ${task.id} (op_id: ${opId.slice(0, 12)}...)`);
          // Move to ack without dispatching — no Telegram notification for duplicates
          const ackPath = join(this.ackDir, filename);
          try { await rename(taskPath, ackPath); } catch { /* ignore */ }
          return;
        }
      }

      // Phase 4: Injection scanning — log-only, does not block dispatch
      if (this.injectionScanEnabled) {
        const scan = scanForInjection(task.prompt);
        if (scan.risk !== "none") {
          traces.emit({
            phase: "dispatch",
            decision: `Injection scan: ${scan.risk} risk (${scan.matched.join(", ")})`,
            reason_code: "injection_scan",
            context: { risk: scan.risk, patterns: scan.matched },
          });
          console.warn(`[pipeline] Injection scan for ${task.id}: ${scan.risk} risk — ${scan.matched.join(", ")}`);
        }
      }

      // Phase 4: Policy check — block dispatch if policy denies
      if (this.policyEngine) {
        const policyResult = await this.policyEngine.check("pipeline.dispatch", {
          from: task.from,
          project: task.project,
          type: task.type,
          priority: task.priority,
        });
        if (!policyResult.allowed) {
          traces.emit({
            phase: "dispatch",
            decision: `Policy denied task ${task.id}: ${policyResult.reason}`,
            reason_code: "policy_denied",
            context: { rule: policyResult.rule, disposition: policyResult.disposition },
          });
          console.warn(`[pipeline] Policy denied task ${task.id}: ${policyResult.reason}`);
          // Write error result and ack
          const result = this.buildResult(task, "error", undefined, undefined, `Policy denied: ${policyResult.reason}`);
          result.decision_traces = traces.getTraces();
          const resultPath = join(this.resultsDir, filename);
          const tmpPath = join(this.resultsDir, `${filename}.tmp`);
          try {
            await writeFile(tmpPath, JSON.stringify(result, null, 2) + "\n", "utf-8");
            await rename(tmpPath, resultPath);
          } catch (writeErr) {
            console.error(`[pipeline] Failed to write policy-denied result for ${task.id}: ${writeErr}`);
            try { await unlink(tmpPath); } catch { /* ignore */ }
            return;
          }
          const ackPath = join(this.ackDir, filename);
          try { await rename(join(this.tasksDir, filename), ackPath); } catch { /* ignore */ }
          return;
        }
      }

      // Phase 6A: Resource guard check — defer if memory dropped since poll()
      if (this.resourceGuard && !this.resourceGuard.canDispatch()) {
        traces.emit({
          phase: "dispatch",
          decision: `Deferred task ${task.id} — low memory`,
          reason_code: "memory_low",
        });
        console.log(`[pipeline] Deferring task ${task.id}: low memory`);
        return;
      }

      // Phase 6A: Rate limiter check — defer if cooldown activated since poll()
      if (this.rateLimiter?.isPaused()) {
        traces.emit({
          phase: "dispatch",
          decision: `Deferred task ${task.id} — rate limited`,
          reason_code: "rate_limited",
        });
        console.log(`[pipeline] Deferring task ${task.id}: rate limited`);
        return;
      }

      // Phase 5C: Create task-specific branch before dispatch
      if (this.branchManager && task.project) {
        try {
          const { cwd } = await this.resolveCwd(task);
          if (cwd) {
            taskBranch = await this.branchManager.checkout(cwd, task.id, "pipeline");
            if (taskBranch) {
              updateStatus(`Pipeline ${task.id.slice(0, 8)} ...branch: ${taskBranch.slice(0, 20)}`);
              console.log(`[pipeline] Task ${task.id} running on branch ${taskBranch}`);
            }
          }
        } catch (err) {
          console.warn(`[pipeline] Branch checkout failed for ${task.id}, proceeding without isolation: ${err}`);
          traces.emit({
            phase: "dispatch",
            decision: `Branch checkout failed for ${task.id}: ${err}`,
            reason_code: "branch_checkout_error",
          });
        }
      }

      // Send status notification (after dedup/policy checks pass)
      await sendStatus();

      // Hook-only types: synthesis and daily-memory have dedicated handlers,
      // skip the Claude CLI dispatch to avoid wasting turns/cost.
      const hookOnlyTypes = new Set(["synthesis", "daily-memory"]);
      let result: PipelineResult;

      if (hookOnlyTypes.has(task.type || "")) {
        updateStatus(`Pipeline ${task.id.slice(0, 8)} ...running hook`);
        traces.emit({
          phase: "dispatch",
          decision: `Hook-only dispatch for ${task.type} task ${task.id}`,
          reason_code: "hook_only",
          context: { type: task.type },
        });
        result = this.buildResult(task, "completed", `Hook-only: ${task.type} handler will execute`);
      } else {
        // 1. Dispatch to Claude
        updateStatus(`Pipeline ${task.id.slice(0, 8)} ...dispatching`);
        traces.emit({
          phase: "dispatch",
          decision: `Dispatching task ${task.id}`,
          reason_code: "dispatched",
          context: { project: task.project, priority: task.priority },
        });
        result = await this.dispatch(task);
      }

      // Phase 6B: Verify completed results before writing
      // Skip verification for synthesis/prd tasks — their dispatch result is not the
      // actual output (synthesis loop and PRD executor handle the real work separately).
      const skipVerifyTypes = new Set(["synthesis", "prd"]);
      if (this.verifier && result.status === "completed" && !skipVerifyTypes.has(task.type || "")) {
        updateStatus(`Pipeline ${task.id.slice(0, 8)} ...verifying`);
        try {
          const { cwd } = await this.resolveCwd(task);
          const verification = await this.verifier.verify(task.prompt, result.result || "", cwd);
          if (!verification.passed) {
            console.warn(`[pipeline] Verification failed for ${task.id}: ${verification.concerns}`);
            traces.emit({
              phase: "verify",
              decision: `Verification failed for ${task.id}`,
              reason_code: "verification_failed",
              context: { verdict: verification.verdict },
            });
            result.status = "error";
            result.error = `Verification failed: ${verification.concerns || verification.verdict}`;
            result.warnings = [...(result.warnings || []), `Verifier: ${verification.verdict}`];
          }
        } catch (err) {
          console.warn(`[pipeline] Verifier crashed for ${task.id}: ${err}`);
          traces.emit({
            phase: "verify",
            decision: `Verifier error for ${task.id}: ${err}`,
            reason_code: "verification_error",
          });
          result.warnings = [...(result.warnings || []), `Verifier error: ${err}`];
        }
      } else if (this.verifier && result.status === "completed" && skipVerifyTypes.has(task.type || "")) {
        console.log(`[pipeline] Skipping verification for ${task.type} task ${task.id}`);
        traces.emit({
          phase: "verify",
          decision: `Skipped verification for ${task.type} task ${task.id}`,
          reason_code: "verification_skipped",
          context: { type: task.type },
        });
      }

      // Phase 5C: Include branch in result
      if (taskBranch) {
        result.branch = taskBranch;
      }

      // Phase 1: Include decision traces in result
      const collectedTraces = traces.getTraces();
      if (collectedTraces.length > 0) {
        result.decision_traces = collectedTraces;
      }

      // 2. Write result atomically (write .tmp, rename)
      // Use source task filename so submitter can look up result by the same name they submitted
      const resultFilename = filename;
      const resultTmpPath = join(this.resultsDir, `${resultFilename}.tmp`);
      const resultFinalPath = join(this.resultsDir, resultFilename);

      try {
        await writeFile(resultTmpPath, JSON.stringify(result, null, 2) + "\n", "utf-8");
        await rename(resultTmpPath, resultFinalPath);
        console.log(`[pipeline] Result written: ${resultFilename} (${result.status})`);
      } catch (err) {
        console.error(`[pipeline] Failed to write result for ${task.id}: ${err}`);
        try { await unlink(resultTmpPath); } catch { /* ignore */ }
        return; // Don't ack if result write failed
      }

      // Phase 1: Record idempotency after successful result write
      if (this.idempotencyStore) {
        const opId = task.op_id || (task.auto_op_id !== false ? IdempotencyStore.generateOpId(task.prompt) : null);
        if (opId) {
          this.idempotencyStore.record(opId, task.id, result.status, resultFilename);
        }
      }

      // 2b. Orchestrator hook — type:"orchestrate" tasks trigger workflow creation
      if (this.orchestrator && task.type === "orchestrate") {
        this.orchestrator.handleOrchestrationTask(task).catch((err) => {
          console.error(`[pipeline] Orchestrator hook error for ${task.id}: ${err}`);
        });
      }

      // V2-D: PRD executor hook — type:"prd" tasks route to PRDExecutor
      if (this.prdExecutor && task.type === "prd") {
        this.prdExecutor.execute(task.prompt, task.project).catch((err) => {
          console.error(`[pipeline] PRD executor hook error for ${task.id}: ${err}`);
        });
      }

      // Phase C: Synthesis hook — type:"synthesis" tasks route to SynthesisLoop
      if (this.synthesisLoop && task.type === "synthesis") {
        this.synthesisLoop.run().catch((err) => {
          console.error(`[pipeline] Synthesis loop hook error for ${task.id}: ${err}`);
        });
      }

      // Workspace: Daily memory hook — type:"daily-memory" tasks route to DailyMemoryWriter
      if (this.dailyMemoryWriter && task.type === "daily-memory") {
        this.dailyMemoryWriter.writeDailyMemory().catch((err) => {
          console.error(`[pipeline] Daily memory hook error for ${task.id}: ${err}`);
        });
      }

      // Phase C: Record pipeline outcome episode in memory
      if (this.memoryStore) {
        const summary = `Pipeline task ${task.id} ${result.status}: ${(result.result || result.error || "").slice(0, 200)}`;
        // Score pipeline task importance by type
        const taskId = task.id || "";
        const pipelineImportance = taskId.includes("daily-memory") ? 8
          : taskId.includes("health") ? 3
          : taskId.includes("synthesis") ? 2
          : 3;
        this.memoryStore.record({
          timestamp: new Date().toISOString(),
          source: "pipeline",
          project: task.project ?? null,
          session_id: result.session_id ?? null,
          role: "system",
          content: `Task: ${task.prompt.slice(0, 500)}\nResult: ${(result.result || result.error || "").slice(0, 500)}`,
          summary,
          importance: pipelineImportance,
          metadata: { taskId: task.id, status: result.status, from: task.from, priority: task.priority || "normal" },
        }).catch((err) => {
          console.warn(`[pipeline] Failed to record outcome episode for ${task.id}: ${err}`);
        });
      }

      // 3. Move task to ack/
      const ackPath = join(this.ackDir, filename);
      try {
        await rename(taskPath, ackPath);
        console.log(`[pipeline] Task ${task.id} moved to ack/`);
      } catch (err) {
        console.warn(`[pipeline] Failed to move ${filename} to ack/: ${err}`);
      }

      // Final status update + send result content
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      if (this.messenger) {
        const icon = result.status === "completed" ? "\u2713" : "\u2717";
        const statusLine = `${icon} Pipeline ${task.id.slice(0, 8)} [${task.type || "task"}]: ${result.status} (${elapsed}s)`;

        if (statusMsgId) {
          this.messenger.editMessage(statusMsgId, statusLine).catch(() => {});
        }

        // Send result content (or error) as a separate message
        // Skip for hook-only types — their result is just an internal marker, not useful output
        const isHookOnly = hookOnlyTypes.has(task.type || "");
        const content = result.status === "completed"
          ? result.result?.trim()
          : result.error?.trim();
        if (content && !isHookOnly) {
          const truncated = content.length > 3500
            ? content.slice(0, 3500) + "\n...(truncated)"
            : content;
          this.messenger.sendDirectMessage(
            `${statusLine}\n\n${truncated}`,
            { parseMode: "Markdown" },
          ).catch(() => {});
        }
      }
    } finally {
      // Phase 5C: Release branch lock and return to base branch
      // Wrapped in try/catch so a throw here cannot skip counter cleanup below
      try {
        if (this.branchManager && taskBranch && task.project) {
          const { cwd } = await this.resolveCwd(task);
          if (cwd) {
            await this.branchManager.release(cwd, task.id).catch((err) => {
              console.warn(`[pipeline] Branch release error for ${task.id}: ${err}`);
            });
          }
        }
      } catch (err) {
        console.warn(`[pipeline] Branch cleanup failed for ${task.id}: ${err}`);
      }
      // Phase 4: Release concurrency resources — MUST run unconditionally
      this.inFlight.delete(filename);
      this.activeCount--;
      if (task.project) this.activeProjects.delete(task.project);
    }
  }

  // Resolve working directory for a task with graceful fallback
  // Returns { cwd, warnings } — cwd is always valid or undefined
  private async resolveCwd(
    task: PipelineTask,
  ): Promise<{ cwd: string | undefined; warnings: string[] }> {
    if (!task.project) return { cwd: undefined, warnings: [] };

    // Reject path traversal attempts — project names must be simple directory names
    if (task.project.includes("..") || task.project.includes("/") || task.project.includes("\\")) {
      console.warn(`[pipeline] Task ${task.id}: rejected project name "${task.project}" — path traversal`);
      return { cwd: undefined, warnings: [`cwd rejected: project "${task.project}" contains path traversal`] };
    }

    const warnings: string[] = [];
    const projectDir = `/home/isidore_cloud/projects/${task.project}`;

    // Try the exact project directory first
    if (await this.dirExists(projectDir)) {
      return { cwd: projectDir, warnings };
    }

    // Fallback to $HOME — task still gets processed, just without project context
    const home = process.env.HOME || "/home/isidore_cloud";
    warnings.push(
      `cwd fallback: ${home} used instead of ${projectDir} (directory does not exist)`,
    );
    console.warn(
      `[pipeline] Task ${task.id}: project dir ${projectDir} does not exist, falling back to ${home}`,
    );
    return { cwd: home, warnings };
  }

  // Check if a directory exists
  private async dirExists(path: string): Promise<boolean> {
    try {
      const s = await stat(path);
      return s.isDirectory();
    } catch {
      return false;
    }
  }

  // Invoke Claude and build result (one-shot or --resume for multi-turn)
  private async dispatch(task: PipelineTask): Promise<PipelineResult> {
    // Session 4: Guardrails check
    if (this.guardrails) {
      const decision = this.guardrails.check(task.prompt, "pipeline");
      if (!decision.allowed) {
        return {
          id: crypto.randomUUID(),
          taskId: task.id,
          from: "isidore",
          to: task.from,
          timestamp: new Date().toISOString(),
          status: "error",
          error: `Guardrails blocked: ${decision.reason}`,
        };
      }
    }

    // Phase 2: Session-project affinity guard
    // If session_id maps to a different project, warn and drop --resume
    if (task.session_id && task.project) {
      const boundProject = this.sessionProjectMap.get(task.session_id);
      if (boundProject && boundProject !== task.project) {
        const warning = `session_id ${task.session_id.slice(0, 8)}... belongs to project "${boundProject}", not "${task.project}" — running as one-shot`;
        console.warn(`[pipeline] ${warning}`);
        const result = await this.dispatch({ ...task, session_id: undefined });
        result.warnings = [...(result.warnings || []), warning];
        return result;
      }
    }

    // Build the prompt — include context and constraints if provided
    let prompt = task.prompt;

    // Phase 3: Prepend escalation context so Claude understands the escalation chain
    if (task.escalation) {
      const esc = task.escalation;
      const parts = [
        `[ESCALATED TASK] This was escalated from ${task.from}.`,
        `Reason: ${esc.reason}`,
        `Triggers: ${esc.criteria.join(", ")}`,
      ];
      if (esc.gregor_partial_result) {
        parts.push(`Previous partial result:\n${esc.gregor_partial_result}`);
      }
      prompt = parts.join("\n") + `\n\nTask:\n${prompt}`;
    }

    if (task.context && Object.keys(task.context).length > 0) {
      prompt += `\n\nContext: ${JSON.stringify(task.context)}`;
    }
    if (task.constraints && Object.keys(task.constraints).length > 0) {
      prompt += `\n\nConstraints: ${JSON.stringify(task.constraints)}`;
    }

    // Resolve working directory with fallback
    const { cwd, warnings } = await this.resolveCwd(task);

    try {
      const args = [this.config.claudeBinary];

      // Pass --resume if task includes a session_id (multi-turn)
      if (task.session_id) {
        args.push("--resume", task.session_id);
      }

      // Pass --max-turns if task specifies it (e.g., overnight PRD runs)
      if (task.max_turns) {
        args.push("--max-turns", String(task.max_turns));
      }

      args.push("-p", prompt, "--output-format", "json");

      const proc = Bun.spawn(args, {
        stdout: "pipe",
        stderr: "pipe",
        cwd,
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: undefined,
          SKIP_KNOWLEDGE_SYNC: "1",
        },
      });

      // Per-task timeout: use task.timeout_minutes if provided, else global default
      const timeoutMs = task.timeout_minutes
        ? task.timeout_minutes * 60 * 1000
        : this.config.maxClaudeTimeoutMs;
      const timeout = setTimeout(() => proc.kill(), timeoutMs);
      let stdout: string, stderr: string, exitCode: number;
      try {
        stdout = await new Response(proc.stdout).text();
        stderr = await new Response(proc.stderr).text();
        exitCode = await proc.exited;
      } finally {
        clearTimeout(timeout);
      }

      // Handle bad/stale session — retry without --resume
      // Catches: invalid UUID format, expired session, unknown session ID
      if (exitCode !== 0 && task.session_id && (
        stderr.includes("No conversation found with session ID") ||
        stderr.includes("--resume requires a valid session ID")
      )) {
        const warning = `session_id ${task.session_id.slice(0, 8)}... was invalid, ran as one-shot`;
        console.warn(`[pipeline] Bad session ${task.session_id.slice(0, 8)}... for task ${task.id}, retrying fresh`);
        const retryResult = await this.dispatch({ ...task, session_id: undefined });
        // Preserve the warning in the retry result
        retryResult.warnings = [...(retryResult.warnings || []), warning];
        return retryResult;
      }

      if (exitCode !== 0) {
        // Feed rate limiter on API overload errors (matches claude.ts RATE_LIMIT_PATTERNS)
        if (this.rateLimiter && /rate_limit|429|overloaded|Too many requests/.test(stderr)) {
          this.rateLimiter.recordFailure();
        }
        return this.buildResult(task, "error", undefined, undefined, `Exit ${exitCode}: ${stderr.slice(0, 500)}`, warnings);
      }

      // Parse Claude JSON output
      const parseResult = safeParse(ClaudeJsonOutputSchema, stdout, `pipeline/claude-output/${task.id}`);
      if (parseResult.success) {
        const parsed = parseResult.data;
        const sessionId = parsed.session_id || undefined;

        // Phase 2: Record session-project affinity for future mismatch detection
        if (sessionId && task.project) {
          this.sessionProjectMap.set(sessionId, task.project);
          // Evict oldest entry when map exceeds cap to prevent unbounded growth
          if (this.sessionProjectMap.size > 10_000) {
            const oldest = this.sessionProjectMap.keys().next().value;
            if (oldest) this.sessionProjectMap.delete(oldest);
          }
        }

        const pipelineResult = this.buildResult(
          task,
          "completed",
          parsed.result || stdout,
          parsed.usage,
          undefined,
          warnings,
          sessionId,
          parsed.structured as StructuredResult | undefined,
        );

        // Phase 3: Mark escalation as handled when task had escalation context
        if (task.escalation) {
          pipelineResult.escalation_handled = true;
        }

        return pipelineResult;
      } else {
        // Parse failed — use raw stdout, no session_id available
        return this.buildResult(task, "completed", stdout.trim(), undefined, undefined, warnings);
      }
    } catch (err) {
      return this.buildResult(task, "error", undefined, undefined, `Dispatch error: ${err}`, warnings);
    }
  }

  private buildResult(
    task: PipelineTask,
    status: "completed" | "error",
    result?: string,
    usage?: { input_tokens: number; output_tokens: number },
    error?: string,
    warnings?: string[],
    session_id?: string,
    structured?: StructuredResult,
    branch?: string,
    decision_traces?: DecisionTrace[],
  ): PipelineResult {
    return {
      id: crypto.randomUUID(),
      taskId: task.id,
      from: "isidore_cloud",
      to: task.from,
      timestamp: new Date().toISOString(),
      status,
      ...(result !== undefined && { result }),
      ...(usage && { usage }),
      ...(error && { error }),
      ...(warnings && warnings.length > 0 && { warnings }),
      ...(session_id && { session_id }),
      ...(structured && { structured }),
      ...(branch && { branch }),
      ...(decision_traces && decision_traces.length > 0 && { decision_traces }),
    };
  }
}
