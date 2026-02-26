// claude.ts — Wrapper for invoking Claude Code CLI with --resume
// Handles session resumption, JSON output parsing, and timeout management

import type { Config } from "./config";
import type { SessionManager } from "./session";

export interface ClaudeResponse {
  sessionId: string;
  result: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
  error?: string;
}

export class ClaudeInvoker {
  private cwd?: string;

  constructor(
    private config: Config,
    private sessions: SessionManager,
  ) {}

  // Set the working directory for Claude invocations (project switching)
  setWorkingDirectory(path: string | undefined): void {
    this.cwd = path;
    if (path) {
      console.log(`[claude] Working directory set to: ${path}`);
    }
  }

  getWorkingDirectory(): string | undefined {
    return this.cwd;
  }

  // Send a message to the active session and get a response
  async send(message: string): Promise<ClaudeResponse> {
    const sessionId = await this.sessions.current();

    // Build args: use --resume only if we have a real session ID from a prior Claude response
    const args = [this.config.claudeBinary];
    if (sessionId) {
      args.push("--resume", sessionId);
    }
    args.push("-p", message, "--output-format", "json");

    try {
      const proc = Bun.spawn(args, {
        stdout: "pipe",
        stderr: "pipe",
        cwd: this.cwd,
        env: {
          ...process.env,
          // Ensure no API key — use OAuth subscription only
          ANTHROPIC_API_KEY: undefined,
          // Suppress knowledge sync hooks — bridge handles sync explicitly
          // via /project (pull) and /done (push) commands
          SKIP_KNOWLEDGE_SYNC: "1",
        },
      });

      // Timeout handling
      const timeout = setTimeout(() => {
        proc.kill();
      }, this.config.maxClaudeTimeoutMs);

      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;

      clearTimeout(timeout);

      if (exitCode !== 0) {
        // If session ID is stale/expired, clear it and retry without --resume
        if (sessionId && stderr.includes("No conversation found with session ID")) {
          console.warn(`[claude] Stale session ${sessionId.slice(0, 8)}..., clearing and retrying fresh`);
          await this.sessions.newSession();
          return this.send(message);
        }
        return {
          sessionId: sessionId || "",
          result: "",
          error: `Claude exited with code ${exitCode}: ${stderr.slice(0, 500)}`,
        };
      }

      // Parse JSON output and persist the real session ID
      try {
        const parsed = JSON.parse(stdout);
        const realSessionId = parsed.session_id || sessionId || "";

        // Save the real session ID so subsequent messages use --resume
        if (realSessionId && realSessionId !== sessionId) {
          await this.sessions.saveSession(realSessionId);
        }

        return {
          sessionId: realSessionId,
          result: parsed.result || stdout,
          usage: parsed.usage,
        };
      } catch {
        // If JSON parsing fails, return raw stdout
        return {
          sessionId: sessionId || "",
          result: stdout.trim(),
        };
      }
    } catch (err) {
      return {
        sessionId: sessionId || "",
        result: "",
        error: `Failed to invoke Claude: ${err}`,
      };
    }
  }

  // One-shot invocation (no session resume — for cron/automation)
  async oneShot(message: string): Promise<ClaudeResponse> {
    const args = [
      this.config.claudeBinary,
      "-p",
      message,
      "--output-format",
      "json",
    ];

    try {
      const proc = Bun.spawn(args, {
        stdout: "pipe",
        stderr: "pipe",
        cwd: this.cwd,
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: undefined,
          SKIP_KNOWLEDGE_SYNC: "1",
        },
      });

      const timeout = setTimeout(() => {
        proc.kill();
      }, this.config.maxClaudeTimeoutMs);

      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;

      clearTimeout(timeout);

      if (exitCode !== 0) {
        return {
          sessionId: "",
          result: "",
          error: `Claude exited with code ${exitCode}: ${stderr.slice(0, 500)}`,
        };
      }

      try {
        const parsed = JSON.parse(stdout);
        return {
          sessionId: parsed.session_id || "",
          result: parsed.result || stdout,
          usage: parsed.usage,
        };
      } catch {
        return { sessionId: "", result: stdout.trim() };
      }
    } catch (err) {
      return {
        sessionId: "",
        result: "",
        error: `Failed to invoke Claude: ${err}`,
      };
    }
  }
}
