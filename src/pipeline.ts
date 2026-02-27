// pipeline.ts — Cross-user task queue watcher for Gregor↔Isidore Cloud collaboration
// Polls /var/lib/pai-pipeline/tasks/ for JSON task files, dispatches to Claude,
// writes results to results/, moves processed tasks to ack/.
//
// Task schema (written by Gregor):
//   { id, from, to, timestamp, type, priority, mode, project, prompt, context?, constraints?, session_id? }
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

// Inbound task from the pipeline
export interface PipelineTask {
  id: string;
  from: string;
  to: string;
  timestamp: string;
  type: string;
  priority?: string;
  mode?: string; // "async" | "sync"
  project?: string;
  prompt: string;
  context?: Record<string, unknown>;
  constraints?: Record<string, unknown>;
  session_id?: string; // Resume a prior pipeline conversation
  // Phase 3: Escalation metadata — why Gregor escalated this task
  escalation?: {
    reason: string; // Why Gregor escalated
    criteria: string[]; // Which classifier triggers fired
    gregor_partial_result?: string; // What Gregor accomplished before escalating
  };
}

// Structured result for machine-parseable output (Phase 2)
export interface StructuredResult {
  summary: string;
  artifacts?: Array<{ path: string; type: string; description: string }>;
  follow_up_needed?: boolean;
  suggested_next_prompt?: string;
}

// Outbound result written to results/
export interface PipelineResult {
  id: string;
  taskId: string;
  from: string;
  to: string;
  timestamp: string;
  status: "completed" | "error";
  result?: string;
  usage?: { input_tokens: number; output_tokens: number };
  error?: string;
  warnings?: string[];
  session_id?: string; // Session ID for follow-up tasks
  structured?: StructuredResult; // Machine-parseable output (Phase 2)
  // Phase 3: Escalation acknowledgment
  escalation_handled?: boolean; // True when task had escalation context
  recommendations_for_sender?: string; // Advice for Gregor on similar future tasks
  // Phase 5C: Branch isolation
  branch?: string; // Task branch name when branch isolation was active
}

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

  constructor(private config: Config) {
    this.tasksDir = join(config.pipelineDir, "tasks");
    this.resultsDir = join(config.pipelineDir, "results");
    this.ackDir = join(config.pipelineDir, "ack");
    this.maxConcurrent = config.pipelineMaxConcurrent;
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

  // Get pipeline status (for /pipeline dashboard)
  getStatus(): { active: number; max: number; inFlight: number } {
    return {
      active: this.activeCount,
      max: this.maxConcurrent,
      inFlight: this.inFlight.size,
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
          const task = JSON.parse(raw) as PipelineTask;
          if (!task.id || !task.prompt) {
            console.warn(`[pipeline] Skipping ${file}: missing id or prompt`);
            continue;
          }
          parsed.push({ filename: file, task });
        } catch (err) {
          // Malformed JSON or file still being written — skip, retry next cycle
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

    try {
      console.log(
        `[pipeline] Processing task ${task.id} from ${task.from} [${task.priority || "normal"}] (active: ${this.activeCount}/${this.maxConcurrent}) (${task.prompt.slice(0, 80)}...)`,
      );

      // Phase 5C: Create task-specific branch before dispatch
      if (this.branchManager && task.project) {
        const { cwd } = await this.resolveCwd(task);
        if (cwd) {
          taskBranch = await this.branchManager.checkout(cwd, task.id, "pipeline");
          if (taskBranch) {
            console.log(`[pipeline] Task ${task.id} running on branch ${taskBranch}`);
          }
        }
      }

      // 1. Dispatch to Claude
      const result = await this.dispatch(task);

      // Phase 6B: Verify completed results before writing
      if (this.verifier && result.status === "completed") {
        const { cwd } = await this.resolveCwd(task);
        const verification = await this.verifier.verify(task.prompt, result.result || "", cwd);
        if (!verification.passed) {
          console.warn(`[pipeline] Verification failed for ${task.id}: ${verification.concerns}`);
          result.status = "error";
          result.error = `Verification failed: ${verification.concerns || verification.verdict}`;
          result.warnings = [...(result.warnings || []), `Verifier: ${verification.verdict}`];
        }
      }

      // Phase 5C: Include branch in result
      if (taskBranch) {
        result.branch = taskBranch;
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

      // 2b. Orchestrator hook — type:"orchestrate" tasks trigger workflow creation
      if (this.orchestrator && task.type === "orchestrate") {
        this.orchestrator.handleOrchestrationTask(task).catch((err) => {
          console.error(`[pipeline] Orchestrator hook error for ${task.id}: ${err}`);
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
    } finally {
      // Phase 5C: Release branch lock and return to base branch
      if (this.branchManager && taskBranch && task.project) {
        const { cwd } = await this.resolveCwd(task);
        if (cwd) {
          await this.branchManager.release(cwd, task.id).catch((err) => {
            console.warn(`[pipeline] Branch release error for ${task.id}: ${err}`);
          });
        }
      }
      // Phase 4: Release concurrency resources — always runs, even on crash
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

      const timeout = setTimeout(() => proc.kill(), this.config.maxClaudeTimeoutMs);
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;
      clearTimeout(timeout);

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
        return this.buildResult(task, "error", undefined, undefined, `Exit ${exitCode}: ${stderr.slice(0, 500)}`, warnings);
      }

      // Parse Claude JSON output
      try {
        const parsed = JSON.parse(stdout);
        const sessionId = parsed.session_id || undefined;

        // Phase 2: Record session-project affinity for future mismatch detection
        if (sessionId && task.project) {
          this.sessionProjectMap.set(sessionId, task.project);
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
      } catch {
        // JSON parse failed — use raw stdout, no session_id available
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
    };
  }
}
