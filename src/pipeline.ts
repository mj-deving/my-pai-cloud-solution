// pipeline.ts — Cross-user task queue watcher for Gregor↔Isidore Cloud collaboration
// Polls /var/lib/pai-pipeline/tasks/ for JSON task files, dispatches to Claude,
// writes results to results/, moves processed tasks to ack/.
//
// Task schema (written by Gregor):
//   { id, from, to, timestamp, type, priority, mode, project, prompt, context?, constraints? }
//
// Result schema (written by this watcher):
//   { id, taskId, from, to, timestamp, status, result, usage?, error? }

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
}

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

  // One poll cycle: scan tasks/, process any found
  private async poll(): Promise<void> {
    if (this.processing) return; // Skip if prior cycle still running
    this.processing = true;

    try {
      const files = await readdir(this.tasksDir);
      const taskFiles = files.filter((f) => f.endsWith(".json"));

      for (const file of taskFiles) {
        await this.processTaskFile(file);
      }
    } catch (err) {
      // readdir failure (permissions, dir missing) — log but don't crash
      console.warn(`[pipeline] Poll error: ${err}`);
    } finally {
      this.processing = false;
    }
  }

  // Process a single task file
  private async processTaskFile(filename: string): Promise<void> {
    const taskPath = join(this.tasksDir, filename);

    // 1. Read and parse task JSON
    let task: PipelineTask;
    try {
      const raw = await readFile(taskPath, "utf-8");
      task = JSON.parse(raw) as PipelineTask;
    } catch (err) {
      // Malformed JSON or file still being written — skip, retry next cycle
      console.warn(`[pipeline] Skipping ${filename}: ${err}`);
      return;
    }

    // 2. Validate required fields
    if (!task.id || !task.prompt) {
      console.warn(
        `[pipeline] Skipping ${filename}: missing id or prompt`,
      );
      return;
    }

    console.log(
      `[pipeline] Processing task ${task.id} from ${task.from} (${task.prompt.slice(0, 80)}...)`,
    );

    // 3. Dispatch to Claude via one-shot invocation
    const result = await this.dispatch(task);

    // 4. Write result atomically (write .tmp, rename)
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

    // 5. Move task to ack/
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

  // Invoke Claude one-shot and build result
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
      const args = [this.config.claudeBinary, "-p", prompt, "--output-format", "json"];
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

      if (exitCode !== 0) {
        return this.buildResult(task, "error", undefined, undefined, `Exit ${exitCode}: ${stderr.slice(0, 500)}`, warnings);
      }

      // Parse Claude JSON output
      try {
        const parsed = JSON.parse(stdout);
        return this.buildResult(
          task,
          "completed",
          parsed.result || stdout,
          parsed.usage,
          undefined,
          warnings,
        );
      } catch {
        // JSON parse failed — use raw stdout
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
    };
  }
}
