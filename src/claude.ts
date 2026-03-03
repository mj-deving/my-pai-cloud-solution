// claude.ts — Wrapper for invoking Claude Code CLI with --resume
// Handles session resumption, JSON output parsing, and timeout management

import type { Config } from "./config";
import type { SessionManager } from "./session";
import { readFile } from "node:fs/promises";
import { ClaudeJsonOutputSchema, safeParse } from "./schemas";

export interface ClaudeResponse {
  sessionId: string;
  result: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
  error?: string;
}

// Rate-limit error patterns in Claude CLI stderr
const RATE_LIMIT_PATTERNS = ["rate_limit", "429", "overloaded", "Too many requests"];

function isRateLimitError(stderr: string): boolean {
  return RATE_LIMIT_PATTERNS.some((p) => stderr.includes(p));
}

export interface ContextBuilderLike {
  buildContext(message: string, project?: string, source?: string): Promise<string | null>;
  invalidate?(): void;
}

export interface SubDelegateAgent {
  id: string;
  name: string;
  executionTier: 1 | 2 | 3;
  memoryScope: "project" | "global" | "none";
  constraints: string[];
  systemPrompt: string;
}

export class ClaudeInvoker {
  private cwd?: string;
  private rateLimiter?: { recordFailure(): void };
  private contextBuilder?: ContextBuilderLike;
  private algoLiteTemplate: string | null = null;

  constructor(
    private config: Config,
    private sessions: SessionManager,
  ) {}

  // Phase 6A: Wire rate limiter for failure detection
  setRateLimiter(rl: { recordFailure(): void }): void {
    this.rateLimiter = rl;
  }

  // V2-B: Wire context builder for memory-augmented prompts
  setContextBuilder(cb: ContextBuilderLike): void {
    this.contextBuilder = cb;
  }

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
    // V2-B: Prepend memory context if context builder is wired
    let prompt = message;
    if (this.contextBuilder) {
      const ctx = await this.contextBuilder.buildContext(message);
      if (ctx) prompt = `${ctx}\n\n---\n\n${message}`;
    }

    const sessionId = await this.sessions.current();

    // Build args: use --resume only if we have a real session ID from a prior Claude response
    const args = [this.config.claudeBinary];
    if (sessionId) {
      args.push("--resume", sessionId);
    }
    args.push("-p", prompt, "--output-format", "json");

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
        // Phase 6A: Detect rate-limit errors and record for cooldown
        if (isRateLimitError(stderr)) {
          this.rateLimiter?.recordFailure();
        }
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
      const parseResult = safeParse(ClaudeJsonOutputSchema, stdout, "claude/send");
      if (parseResult.success) {
        const parsed = parseResult.data;
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
      } else {
        // Parse failed — return raw stdout
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
    // V2-B: Prepend memory context if context builder is wired
    let prompt = message;
    if (this.contextBuilder) {
      const ctx = await this.contextBuilder.buildContext(message);
      if (ctx) prompt = `${ctx}\n\n---\n\n${message}`;
    }

    const args = [
      this.config.claudeBinary,
      "-p",
      prompt,
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
        // Phase 6A: Detect rate-limit errors and record for cooldown
        if (isRateLimitError(stderr)) {
          this.rateLimiter?.recordFailure();
        }
        return {
          sessionId: "",
          result: "",
          error: `Claude exited with code ${exitCode}: ${stderr.slice(0, 500)}`,
        };
      }

      const oneShotParse = safeParse(ClaudeJsonOutputSchema, stdout, "claude/oneShot");
      if (oneShotParse.success) {
        const parsed = oneShotParse.data;
        return {
          sessionId: parsed.session_id || "",
          result: parsed.result || stdout,
          usage: parsed.usage,
        };
      } else {
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

  // Phase 6C: Quick one-shot with lightweight model (no session persistence)
  async quickShot(message: string, model?: string): Promise<ClaudeResponse> {
    const modelName = model || this.config.quickModel || "haiku";
    const args = [
      this.config.claudeBinary,
      "-p",
      message,
      "--model",
      modelName,
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
        if (isRateLimitError(stderr)) {
          this.rateLimiter?.recordFailure();
        }
        return {
          sessionId: "",
          result: "",
          error: `Claude exited with code ${exitCode}: ${stderr.slice(0, 500)}`,
        };
      }

      const quickParse = safeParse(ClaudeJsonOutputSchema, stdout, "claude/quickShot");
      if (quickParse.success) {
        const parsed = quickParse.data;
        return {
          sessionId: parsed.session_id || "",
          result: parsed.result || stdout,
          usage: parsed.usage,
        };
      } else {
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

  // Phase C: Sub-delegation to a registered agent with tier-based invocation
  async subDelegate(
    agent: SubDelegateAgent,
    task: string,
    options?: { project?: string; cwd?: string; algoLiteTemplate?: string },
  ): Promise<ClaudeResponse> {
    // Build composed prompt
    const parts: string[] = [];

    // 1. Algo Lite template (tier 2 only)
    if (agent.executionTier === 2) {
      const template = options?.algoLiteTemplate || await this.loadAlgoLiteTemplate();
      if (template) parts.push(template);
    }

    // 2. Agent system prompt
    if (agent.systemPrompt) {
      parts.push(`--- Agent: ${agent.name} ---\n${agent.systemPrompt}`);
    }

    // 3. Constraints block
    if (agent.constraints.length > 0) {
      parts.push(`Constraints:\n${agent.constraints.map(c => `- ${c}`).join("\n")}`);
    }

    // 4. Memory context (if scope allows)
    if (agent.memoryScope !== "none" && this.contextBuilder) {
      const project = agent.memoryScope === "project" ? options?.project : undefined;
      const ctx = await this.contextBuilder.buildContext(task, project);
      if (ctx) parts.push(ctx);
    }

    // 5. Task prompt
    parts.push(`--- Task ---\n${task}`);

    const composedPrompt = parts.join("\n\n");

    // Tier-based invocation
    switch (agent.executionTier) {
      case 3:
        // Tier 3: Quick one-shot (haiku)
        return this.quickShot(composedPrompt);

      case 2: {
        // Tier 2: Full model with limited turns (algo-lite)
        const args = [
          this.config.claudeBinary,
          "-p", composedPrompt,
          "--max-turns", "10",
          "--output-format", "json",
        ];

        try {
          const proc = Bun.spawn(args, {
            stdout: "pipe",
            stderr: "pipe",
            cwd: options?.cwd || this.cwd,
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
            if (isRateLimitError(stderr)) this.rateLimiter?.recordFailure();
            return { sessionId: "", result: "", error: `Claude exited with code ${exitCode}: ${stderr.slice(0, 500)}` };
          }

          const parsed = safeParse(ClaudeJsonOutputSchema, stdout, "claude/subDelegate");
          if (parsed.success) {
            return { sessionId: parsed.data.session_id || "", result: parsed.data.result || stdout, usage: parsed.data.usage };
          }
          return { sessionId: "", result: stdout.trim() };
        } catch (err) {
          return { sessionId: "", result: "", error: `Sub-delegation error: ${err}` };
        }
      }

      case 1:
        // Tier 1: Full model one-shot (no turn limit)
        return this.oneShot(composedPrompt);

      default:
        return this.oneShot(composedPrompt);
    }
  }

  private async loadAlgoLiteTemplate(): Promise<string | null> {
    if (this.algoLiteTemplate !== null) return this.algoLiteTemplate;
    try {
      const templatePath = `${process.env.HOME || "/home/isidore_cloud"}/projects/my-pai-cloud-solution/prompts/algo-lite.md`;
      this.algoLiteTemplate = await readFile(templatePath, "utf-8");
      return this.algoLiteTemplate;
    } catch {
      console.warn("[claude] Could not load algo-lite template");
      this.algoLiteTemplate = "";
      return null;
    }
  }
}
