// standalone/dashboard/claude-runner.ts — Minimal Claude CLI invoker for /api/send and A2A
// Replaces ClaudeInvoker.oneShot() with: guardrails regex, concurrency cap, timeout+SIGKILL,
// hook_failure rescue (extract stdout from non-zero exits).

import { scanForInjection } from "../../src/injection-scan";

export interface OneShotResult {
  result: string;
  error?: string;
}

const MAX_CONCURRENT = 2;
const DEFAULT_TIMEOUT_MS = 120_000; // 2 min for gateway requests

export class ClaudeRunner {
  private inFlight = 0;

  constructor(
    private claudeBinary: string,
    private timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  async oneShot(message: string): Promise<OneShotResult> {
    // Guardrails: block high-risk injection
    const scan = scanForInjection(message);
    if (scan.risk === "high") {
      return { result: "", error: `Blocked: injection risk (${scan.matched.join(", ")})` };
    }

    // Concurrency guard
    if (this.inFlight >= MAX_CONCURRENT) {
      return { result: "", error: "Too many concurrent requests (max 2)" };
    }

    this.inFlight++;
    try {
      return await this.spawn(message);
    } finally {
      this.inFlight--;
    }
  }

  get concurrentCount(): number {
    return this.inFlight;
  }

  private async spawn(message: string): Promise<OneShotResult> {
    const args = [this.claudeBinary, "-p", message, "--output-format", "json"];

    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(args, {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, SKIP_KNOWLEDGE_SYNC: "1" },
      });
    } catch (err) {
      const msg = String(err);
      if (msg.includes("ENOENT") || msg.includes("posix_spawn")) {
        return { result: "", error: `Claude binary not found: ${this.claudeBinary}` };
      }
      return { result: "", error: `Spawn error: ${msg}` };
    }

    // Timeout with SIGKILL escalation
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const timeout = setTimeout(() => {
      proc.kill();
      killTimer = setTimeout(() => proc.kill(9), 5_000);
    }, this.timeoutMs);

    let stdout: string, stderr: string, exitCode: number;
    try {
      stdout = await new Response(proc.stdout as ReadableStream).text();
      stderr = await new Response(proc.stderr as ReadableStream).text();
      exitCode = await proc.exited;
    } finally {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
    }

    // Hook failure rescue: if exit != 0 but stdout has valid content,
    // the response is usable (hook fired after Claude finished)
    if (exitCode !== 0 && stdout.trim()) {
      try {
        const parsed = JSON.parse(stdout);
        if (parsed.result) {
          return { result: parsed.result, error: `Warning: exit ${exitCode} (hook failure, result rescued)` };
        }
      } catch { /* not valid JSON, fall through to error */ }
    }

    if (exitCode !== 0) {
      return { result: "", error: `Exit ${exitCode}: ${stderr.slice(0, 500)}` };
    }

    // Parse Claude JSON output
    try {
      const parsed = JSON.parse(stdout);
      return { result: parsed.result ?? stdout.trim() };
    } catch {
      return { result: stdout.trim() };
    }
  }
}
