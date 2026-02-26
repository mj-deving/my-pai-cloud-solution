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
}

// Priority levels — higher number = processed first
const PRIORITY_ORDER: Record<string, number> = { high: 3, normal: 2, low: 1 };

export class PipelineWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private processing = false; // Prevent overlapping poll cycles
  private tasksDir: string;
  private resultsDir: string;
  private ackDir: string;

  constructor(private config: Config) {
    this.tasksDir = join(config.pipelineDir, "tasks");
    this.resultsDir = join(config.pipelineDir, "results");
    this.ackDir = join(config.pipelineDir, "ack");
  }

  // Start polling for task files
  start(): void {
    if (this.timer) return;
    console.log(
      `[pipeline] Watching ${this.tasksDir} (poll every ${this.config.pipelinePollIntervalMs}ms)`,
    );
    this.timer = setInterval(
      () => this.poll(),
      this.config.pipelinePollIntervalMs,
    );
    // Also poll immediately on start
    this.poll();
  }

  // Stop polling
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log("[pipeline] Watcher stopped");
    }
  }

  // One poll cycle: scan tasks/, sort by priority, process in order
  private async poll(): Promise<void> {
    if (this.processing) return; // Skip if prior cycle still running
    this.processing = true;

    try {
      const files = await readdir(this.tasksDir);
      const taskFiles = files.filter((f) => f.endsWith(".json"));

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

      // Process in priority order
      for (const { filename, task } of parsed) {
        await this.processTask(filename, task);
      }
    } catch (err) {
      // readdir failure (permissions, dir missing) — log but don't crash
      console.warn(`[pipeline] Poll error: ${err}`);
    } finally {
      this.processing = false;
    }
  }

  // Process a single pre-parsed task
  private async processTask(filename: string, task: PipelineTask): Promise<void> {
    const taskPath = join(this.tasksDir, filename);

    console.log(
      `[pipeline] Processing task ${task.id} from ${task.from} [${task.priority || "normal"}] (${task.prompt.slice(0, 80)}...)`,
    );

    // 1. Dispatch to Claude
    const result = await this.dispatch(task);

    // 2. Write result atomically (write .tmp, rename)
    const resultFilename = `${task.id}.json`;
    const resultTmpPath = join(this.resultsDir, `${resultFilename}.tmp`);
    const resultFinalPath = join(this.resultsDir, resultFilename);

    try {
      await writeFile(resultTmpPath, JSON.stringify(result, null, 2) + "\n", "utf-8");
      await rename(resultTmpPath, resultFinalPath);
      console.log(`[pipeline] Result written: ${resultFilename} (${result.status})`);
    } catch (err) {
      console.error(`[pipeline] Failed to write result for ${task.id}: ${err}`);
      // Clean up tmp file if it exists
      try { await unlink(resultTmpPath); } catch { /* ignore */ }
      return; // Don't ack if result write failed
    }

    // 3. Move task to ack/
    const ackPath = join(this.ackDir, filename);
    try {
      await rename(taskPath, ackPath);
      console.log(`[pipeline] Task ${task.id} moved to ack/`);
    } catch (err) {
      console.warn(`[pipeline] Failed to move ${filename} to ack/: ${err}`);
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
    // Build the prompt — include context and constraints if provided
    let prompt = task.prompt;
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
        return this.buildResult(
          task,
          "completed",
          parsed.result || stdout,
          parsed.usage,
          undefined,
          warnings,
          sessionId,
        );
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
    };
  }
}
