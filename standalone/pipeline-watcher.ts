#!/usr/bin/env bun
// standalone/pipeline-watcher.ts — Lightweight pipeline watcher daemon
// Polls /var/lib/pai-pipeline/tasks/ for JSON task files, dispatches to Claude CLI,
// writes results to results/, moves processed tasks to ack/.
//
// Replaces the 855-line bridge-coupled PipelineWatcher with a ~100-line standalone daemon.
// Keeps: poll, validate, sort, dispatch, atomic write, ack, concurrency, injection scan, timeout.
// Drops: orchestrator, branch manager, resource guard, rate limiter, verifier, idempotency,
//        policy engine, memory recording, synthesis/daily-memory hooks, Telegram status.

import { readdir, readFile, writeFile, rename, unlink, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  PipelineTaskSchema,
  ClaudeJsonOutputSchema,
  safeParse,
  type PipelineTask,
  type PipelineResult,
} from "../src/schemas";
import { scanForInjection } from "../src/injection-scan";

// --- Configuration (env vars with defaults) ---

const PIPELINE_DIR = process.env.PIPELINE_DIR ?? "/var/lib/pai-pipeline";
const CLAUDE_BINARY = process.env.CLAUDE_BINARY ?? "claude";
const POLL_INTERVAL_MS = parseInt(process.env.PIPELINE_POLL_INTERVAL_MS ?? "5000", 10);
const MAX_CONCURRENT = parseInt(process.env.PIPELINE_MAX_CONCURRENT ?? "1", 10);
const DEFAULT_TIMEOUT_MS = parseInt(process.env.PIPELINE_TIMEOUT_MS ?? "300000", 10);
const HOME = process.env.HOME ?? "/home/isidore_cloud";

const TASKS_DIR = join(PIPELINE_DIR, "tasks");
const RESULTS_DIR = join(PIPELINE_DIR, "results");
const ACK_DIR = join(PIPELINE_DIR, "ack");

const PRIORITY_ORDER: Record<string, number> = { high: 3, normal: 2, low: 1 };

class FatalBinaryError extends Error {
  constructor(msg: string) { super(msg); this.name = "FatalBinaryError"; }
}

// --- State ---

let activeCount = 0;
const inFlight = new Set<string>();
let shuttingDown = false;
let polling = false; // Reentrancy guard for poll()

// --- Startup validation ---

async function validateSetup(): Promise<void> {
  // Fatal: claude binary must exist
  try {
    const proc = Bun.spawn([CLAUDE_BINARY, "--version"], { stdout: "pipe", stderr: "pipe" });
    const exitCode = await proc.exited;
    if (exitCode !== 0) throw new Error(`claude --version exited ${exitCode}`);
    const version = (await new Response(proc.stdout).text()).trim();
    console.log(`[pipeline] Claude binary: ${CLAUDE_BINARY} (${version})`);
  } catch (err) {
    console.error(`[pipeline] FATAL: Claude binary not found at "${CLAUDE_BINARY}": ${err}`);
    process.exit(1);
  }

  // Fatal: pipeline directories must exist
  for (const dir of [TASKS_DIR, RESULTS_DIR, ACK_DIR]) {
    try {
      const s = await stat(dir);
      if (!s.isDirectory()) throw new Error("not a directory");
    } catch {
      console.error(`[pipeline] FATAL: Pipeline directory missing: ${dir}`);
      process.exit(1);
    }
  }
}

// --- Core: poll cycle ---

async function poll(): Promise<void> {
  if (shuttingDown || polling) return;
  polling = true;

  try {
    await pollInner();
  } finally {
    polling = false;
  }
}

async function pollInner(): Promise<void> {
  const availableSlots = MAX_CONCURRENT - activeCount;
  if (availableSlots <= 0) return;

  let files: string[];
  try {
    files = (await readdir(TASKS_DIR)).filter(f => f.endsWith(".json") && !inFlight.has(f));
  } catch (err) {
    console.warn(`[pipeline] Poll error: ${err}`);
    return;
  }

  // Skip tasks that already have a result (ack failed on previous run)
  const filtered: string[] = [];
  for (const f of files) {
    try {
      await stat(join(RESULTS_DIR, f));
      // Result exists — ack must have failed. Move to ack now.
      console.warn(`[pipeline] Result exists for ${f} but not acked — re-acking`);
      try { await rename(join(TASKS_DIR, f), join(ACK_DIR, f)); } catch { /* ignore */ }
    } catch {
      filtered.push(f); // No result yet — eligible for dispatch
    }
  }
  files = filtered;

  if (files.length === 0) return;

  // Parse and validate
  const parsed: Array<{ filename: string; task: PipelineTask }> = [];
  for (const file of files) {
    try {
      const raw = await readFile(join(TASKS_DIR, file), "utf-8");
      const result = safeParse(PipelineTaskSchema, raw, `pipeline/task/${file}`);
      if (!result.success) {
        console.warn(`[pipeline] Skipping ${file}: ${result.error}`);
        continue;
      }
      if (!result.data.id || !result.data.prompt) {
        console.warn(`[pipeline] Skipping ${file}: missing id or prompt`);
        continue;
      }
      parsed.push({ filename: file, task: result.data });
    } catch (err: any) {
      if (err?.code !== "ENOENT") console.warn(`[pipeline] Skipping ${file}: ${err}`);
    }
  }

  // Sort by priority, tie-break by timestamp
  parsed.sort((a, b) => {
    const pa = PRIORITY_ORDER[a.task.priority ?? "normal"] ?? 2;
    const pb = PRIORITY_ORDER[b.task.priority ?? "normal"] ?? 2;
    if (pa !== pb) return pb - pa;
    if (a.task.timestamp && b.task.timestamp) return a.task.timestamp.localeCompare(b.task.timestamp);
    return a.filename.localeCompare(b.filename);
  });

  // Dispatch up to available slots
  for (const { filename, task } of parsed.slice(0, availableSlots)) {
    inFlight.add(filename);
    activeCount++;
    processTask(filename, task).catch(err => {
      if (err instanceof FatalBinaryError) {
        console.error(`[pipeline] Stopping daemon — Claude binary unavailable`);
        shuttingDown = true;
        process.exit(1);
      }
      console.error(`[pipeline] Uncaught error processing ${task.id}: ${err}`);
    });
  }
}

// --- Core: process a single task ---

async function processTask(filename: string, task: PipelineTask): Promise<void> {
  const taskPath = join(TASKS_DIR, filename);

  try {
    console.log(`[pipeline] Processing ${task.id} [${task.priority ?? "normal"}] (${activeCount}/${MAX_CONCURRENT}): ${task.prompt.slice(0, 80)}...`);

    // Build prompt with context/constraints FIRST (before injection scan)
    let prompt = task.prompt;
    if (task.escalation) {
      const esc = task.escalation;
      const parts = [
        `[ESCALATED TASK] This was escalated from ${task.from}.`,
        `Reason: ${esc.reason}`,
        `Triggers: ${esc.criteria.join(", ")}`,
      ];
      if (esc.gregor_partial_result) parts.push(`Previous partial result:\n${esc.gregor_partial_result}`);
      prompt = parts.join("\n") + `\n\nTask:\n${prompt}`;
    }
    if (task.context && Object.keys(task.context).length > 0) {
      prompt += `\n\nContext: ${JSON.stringify(task.context)}`;
    }
    if (task.constraints && Object.keys(task.constraints).length > 0) {
      prompt += `\n\nConstraints: ${JSON.stringify(task.constraints)}`;
    }

    // Injection scan on FULL assembled prompt (including escalation, context, constraints)
    const scan = scanForInjection(prompt);
    if (scan.risk !== "none") {
      console.warn(`[pipeline] Injection scan ${task.id}: ${scan.risk} risk — ${scan.matched.join(", ")}`);
    }

    // Resolve cwd
    const cwd = await resolveCwd(task);

    // Dispatch to Claude CLI
    const result = await dispatch(task, prompt, cwd);

    // Write result atomically (unique tmp name prevents collision on concurrent writers)
    const tmpPath = join(RESULTS_DIR, `${filename}.${process.pid}.${Date.now()}.tmp`);
    const finalPath = join(RESULTS_DIR, filename);
    try {
      await writeFile(tmpPath, JSON.stringify(result, null, 2) + "\n", "utf-8");
      await rename(tmpPath, finalPath);
      console.log(`[pipeline] Result written: ${filename} (${result.status})`);
    } catch (err) {
      console.error(`[pipeline] Failed to write result for ${task.id}: ${err}`);
      try { await unlink(tmpPath); } catch { /* ignore */ }
      return; // Don't ack if result write failed
    }

    // Move task to ack/
    try {
      await rename(taskPath, join(ACK_DIR, filename));
      console.log(`[pipeline] Task ${task.id} acked`);
    } catch (err) {
      console.warn(`[pipeline] Failed to ack ${filename}: ${err}`);
    }
  } finally {
    inFlight.delete(filename);
    activeCount--;
  }
}

// --- Dispatch to Claude CLI ---

async function dispatch(task: PipelineTask, prompt: string, cwd?: string): Promise<PipelineResult> {
  const args = [CLAUDE_BINARY];
  if (task.max_turns) args.push("--max-turns", String(task.max_turns));
  args.push("-p", prompt, "--output-format", "json");

  const timeoutMs = task.timeout_minutes ? task.timeout_minutes * 60_000 : DEFAULT_TIMEOUT_MS;

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      cwd,
      env: { ...process.env, SKIP_KNOWLEDGE_SYNC: "1" },
    });
  } catch (err) {
    const msg = String(err);
    if (msg.includes("ENOENT") || msg.includes("posix_spawn")) {
      // Binary missing — fatal. Throw so processTask's finally block cleans up,
      // then the caller triggers daemon shutdown.
      console.error(`[pipeline] FATAL: Claude binary missing: ${CLAUDE_BINARY}`);
      throw new FatalBinaryError(msg);
    }
    return buildResult(task, "error", undefined, `Spawn error: ${msg}`);
  }

  // Timeout with SIGKILL escalation: SIGTERM first, then SIGKILL after 5s
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  const timeout = setTimeout(() => {
    proc.kill();
    killTimer = setTimeout(() => proc.kill(9), 5_000);
  }, timeoutMs);

  let stdout: string, stderr: string, exitCode: number;
  try {
    stdout = await new Response(proc.stdout as ReadableStream).text();
    stderr = await new Response(proc.stderr as ReadableStream).text();
    exitCode = await proc.exited;
  } finally {
    clearTimeout(timeout);
    if (killTimer) clearTimeout(killTimer);
  }

  // ENOENT in stderr (binary removed during execution)
  if (exitCode !== 0 && (stderr.includes("ENOENT") || stderr.includes("posix_spawn"))) {
    console.error(`[pipeline] FATAL: Claude binary disappeared during execution`);
    throw new FatalBinaryError(stderr.slice(0, 200));
  }

  if (exitCode !== 0) {
    return buildResult(task, "error", undefined, `Exit ${exitCode}: ${stderr.slice(0, 500)}`);
  }

  // Parse Claude JSON output
  const parseResult = safeParse(ClaudeJsonOutputSchema, stdout, `pipeline/claude-output/${task.id}`);
  if (parseResult.success) {
    const parsed = parseResult.data;
    return buildResult(task, "completed", parsed.result ?? stdout, undefined, parsed.usage);
  }
  return buildResult(task, "completed", stdout.trim());
}

// --- Helpers ---

async function resolveCwd(task: PipelineTask): Promise<string | undefined> {
  if (!task.project) return undefined;
  if (task.project.includes("..") || task.project.includes("/") || task.project.includes("\\")) {
    console.warn(`[pipeline] Rejected project "${task.project}" — path traversal`);
    return undefined;
  }
  const dir = join(HOME, "projects", task.project);
  try {
    const s = await stat(dir);
    if (s.isDirectory()) return dir;
  } catch { /* fall through */ }
  console.warn(`[pipeline] Project dir ${dir} missing, using ${HOME}`);
  return HOME;
}

function buildResult(
  task: PipelineTask,
  status: "completed" | "error",
  result?: string,
  error?: string,
  usage?: { input_tokens: number; output_tokens: number },
): PipelineResult {
  return {
    id: crypto.randomUUID(),
    taskId: task.id,
    from: "isidore_cloud",
    to: task.from,
    timestamp: new Date().toISOString(),
    status,
    ...(result !== undefined && { result }),
    ...(error && { error }),
    ...(usage && { usage }),
  };
}

// --- Graceful shutdown ---

function shutdown(signal: string): void {
  console.log(`[pipeline] Received ${signal}, shutting down...`);
  shuttingDown = true;
  // Wait for in-flight tasks to complete (max 30s)
  const deadline = Date.now() + 30_000;
  const check = setInterval(() => {
    if (activeCount === 0 || Date.now() > deadline) {
      clearInterval(check);
      console.log(`[pipeline] Shutdown complete (${activeCount} tasks still active)`);
      process.exit(0);
    }
  }, 500);
}

// --- Main ---

await validateSetup();

console.log(`[pipeline] Started — polling ${TASKS_DIR} every ${POLL_INTERVAL_MS}ms (max concurrent: ${MAX_CONCURRENT})`);
const pollTimer = setInterval(poll, POLL_INTERVAL_MS);
poll(); // Immediate first poll

// Export pollTimer ref for shutdown cleanup
process.on("SIGTERM", () => { clearInterval(pollTimer); shutdown("SIGTERM"); });
process.on("SIGINT", () => { clearInterval(pollTimer); shutdown("SIGINT"); });
