// claude.ts — Wrapper for invoking Claude Code CLI with --resume
// Handles session resumption, JSON output parsing, and timeout management

import type { Config } from "./config";
import type { SessionManager } from "./session";
import { readFile } from "node:fs/promises";
import { ClaudeJsonOutputSchema, safeParse } from "./schemas";
import { RecoveryPolicy } from "./turn-recovery";
import type { RetryState } from "./turn-recovery";

export interface ClaudeResponse {
  sessionId: string;
  result: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  /** Per-turn usage from last assistant event — accurate context window fill.
   *  Falls back to accumulated `usage` when not available. */
  lastTurnUsage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  contextWindow?: number;
  error?: string;
  retried?: boolean;
}

export type ProgressEvent =
  | { type: "phase"; phase: string }
  | { type: "tool_start"; tool: string; detail?: string }
  | { type: "tool_end"; tool: string }
  | { type: "text_chunk"; text: string }
  | { type: "content"; text: string }
  | { type: "isc_progress"; done: number; total: number };

// Rate-limit error patterns in Claude CLI stderr
const RATE_LIMIT_PATTERNS = ["rate_limit", "429", "overloaded", "Too many requests"];

export function isRateLimitError(stderr: string): boolean {
  return RATE_LIMIT_PATTERNS.some((p) => stderr.includes(p));
}

const AUTH_ERROR_PATTERNS = ["authentication_failed", "OAuth token", "authentication_error"];

export function isAuthError(text: string): boolean {
  return AUTH_ERROR_PATTERNS.some((p) => text.includes(p));
}

export function isRecoverableError(errorDetail: string): boolean {
  if (isAuthError(errorDetail)) return false;
  if (isRateLimitError(errorDetail)) return false;
  if (errorDetail.includes("No conversation found with session ID")) return false;
  return true;
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
  private activeProc: { kill(signal?: number): void; killed: boolean } | null = null;
  private recoveryPolicy = new RecoveryPolicy();

  constructor(
    private config: Config,
    private sessions: SessionManager,
  ) {}

  /** Kill the active Claude child process (used by loop detection hard stop). */
  cancel(): boolean {
    if (this.activeProc && !this.activeProc.killed) {
      try {
        this.activeProc.kill();
        console.log("[claude] Active process cancelled by loop detector");
        return true;
      } catch (err) {
        console.warn(`[claude] Failed to cancel process: ${err}`);
        return false;
      } finally {
        this.activeProc = null;
      }
    }
    return false;
  }

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

  // Direct API fast-path — bypass CLI for simple messages
  async sendDirect(message: string): Promise<ClaudeResponse> {
    const { sendDirect: apiSend } = await import("./direct-api");

    // Build context from memory if available
    let systemPrompt: string | null = null;
    if (this.contextBuilder) {
      systemPrompt = await this.contextBuilder.buildContext(message) ?? null;
    }

    try {
      const resp = await apiSend(message, systemPrompt, {
        apiKey: this.config.directApiKey,
        model: this.config.directApiModel,
        maxTokens: this.config.directApiMaxTokens,
      });

      return {
        sessionId: "",
        result: resp.result,
        // Don't set usage — prevents ModeManager from overwriting CLI context tracking
        // with unrelated Sonnet token counts
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[claude] Direct API error: ${msg}`);

      if (msg.includes("429") || msg.includes("Rate limited")) {
        this.rateLimiter?.recordFailure();
      }

      return {
        sessionId: "",
        result: "",
        error: msg,
      };
    }
  }

  // Send a message to the active session and get a response
  // If onProgress is provided, uses stream-json for live status updates
  async send(message: string, onProgress?: (event: ProgressEvent) => void, _retryState?: RetryState): Promise<ClaudeResponse> {
    const retryState = _retryState || this.recoveryPolicy.initialState();
    // V2-B: Prepend memory context if context builder is wired
    let prompt = message;
    if (this.contextBuilder) {
      const ctx = await this.contextBuilder.buildContext(message);
      if (ctx) prompt = `${ctx}\n\n---\n\n${message}`;
    }

    const sessionId = await this.sessions.current();

    // If onProgress provided, use streaming path
    if (onProgress) {
      return this.sendStreaming(prompt, sessionId, onProgress, retryState);
    }

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
      this.activeProc = proc;

      // Timeout handling
      const timeout = setTimeout(() => {
        proc.kill();
        this.activeProc = null;
      }, this.config.maxClaudeTimeoutMs);

      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;
      this.activeProc = null;

      clearTimeout(timeout);

      if (exitCode !== 0) {
        // Use RecoveryPolicy for retry decisions (handles stale sessions, rate limits, etc.)
        const category = this.recoveryPolicy.classify(stderr, exitCode);
        if (category === "quota") this.rateLimiter?.recordFailure();
        const decision = this.recoveryPolicy.shouldRetry(category, retryState);
        if (decision.retry) {
          console.warn(`[claude] ${category} error (exit ${exitCode}), retrying: ${stderr.slice(0, 100)}`);
          this.rateLimiter?.recordFailure();
          if (decision.action === "fresh_session" || decision.action === "cache_bust") {
            await this.sessions.newSession();
          }
          if (decision.waitMs > 0) await Bun.sleep(decision.waitMs);
          const nextState = this.recoveryPolicy.nextState(retryState, stderr.slice(0, 200), decision.action);
          const retryResult = await this.send(message, onProgress, nextState);
          retryResult.retried = true;
          return retryResult;
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

        // Extract contextWindow from modelUsage
        let contextWindow: number | undefined;
        if (parsed.modelUsage) {
          const firstModel = Object.values(parsed.modelUsage)[0];
          if (firstModel?.contextWindow) {
            contextWindow = firstModel.contextWindow;
          }
        }

        return {
          sessionId: realSessionId,
          result: parsed.result || stdout,
          usage: parsed.usage,
          contextWindow,
        };
      } else {
        // Parse failed — return raw stdout
        return {
          sessionId: sessionId || "",
          result: stdout.trim(),
        };
      }
    } catch (err) {
      const category = this.recoveryPolicy.classify(String(err));
      const decision = this.recoveryPolicy.shouldRetry(category, retryState);
      if (decision.retry) {
        console.warn(`[claude] Spawn exception (${category}), retrying: ${String(err).slice(0, 100)}`);
        this.rateLimiter?.recordFailure();
        await this.sessions.newSession();
        const nextState = this.recoveryPolicy.nextState(retryState, String(err).slice(0, 200), decision.action);
        const retryResult = await this.send(message, onProgress, nextState);
        retryResult.retried = true;
        return retryResult;
      }
      return {
        sessionId: sessionId || "",
        result: "",
        error: `Failed to invoke Claude: ${err}`,
      };
    }
  }

  // Streaming send — reads NDJSON events, emits progress, accumulates result
  private async sendStreaming(
    prompt: string,
    sessionId: string | null,
    onProgress: (event: ProgressEvent) => void,
    retryState?: RetryState,
  ): Promise<ClaudeResponse> {
    const state = retryState || this.recoveryPolicy.initialState();
    const args = [this.config.claudeBinary];
    if (sessionId) {
      args.push("--resume", sessionId);
    }
    args.push("-p", prompt, "--output-format", "stream-json", "--verbose");

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
      this.activeProc = proc;

      const timeout = setTimeout(() => {
        proc.kill();
        this.activeProc = null;
      }, this.config.maxClaudeTimeoutMs);

      // Read NDJSON stream line by line
      let accumulatedText = "";
      let extractedSessionId = "";
      let extractedUsage: ClaudeResponse["usage"] | undefined;
      let extractedLastTurnUsage: ClaudeResponse["usage"] | undefined;
      let extractedContextWindow: number | undefined;
      let authError = "";
      let streamError = ""; // Captures non-auth errors from stream events
      const toolBlocks = new Map<number, string>(); // index → tool name
      const decoder = new TextDecoder();
      let buffer = "";

      const reader = proc.stdout.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let newlineIdx: number;
          while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, newlineIdx).trim();
            buffer = buffer.slice(newlineIdx + 1);
            if (!line) continue;

            try {
              const parsed = JSON.parse(line);
              this.processStreamEvent(parsed, onProgress, toolBlocks, {
                getText: () => accumulatedText,
                appendText: (t: string) => { accumulatedText += t; },
                setSessionId: (id: string) => { extractedSessionId = id; },
                setUsage: (u: ClaudeResponse["usage"]) => { extractedUsage = u; },
                setLastTurnUsage: (u: ClaudeResponse["usage"]) => { extractedLastTurnUsage = u; },
                setContextWindow: (cw: number) => { extractedContextWindow = cw; },
                setAuthError: (err: string) => { authError = err; },
                setStreamError: (err: string) => { if (!streamError) streamError = err; },
              });
            } catch {
              // Unparseable line — ignore
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      // Process any remaining buffer
      if (buffer.trim()) {
        try {
          const parsed = JSON.parse(buffer.trim());
          this.processStreamEvent(parsed, onProgress, toolBlocks, {
            getText: () => accumulatedText,
            appendText: (t: string) => { accumulatedText += t; },
            setSessionId: (id: string) => { extractedSessionId = id; },
            setUsage: (u: ClaudeResponse["usage"]) => { extractedUsage = u; },
            setLastTurnUsage: (u: ClaudeResponse["usage"]) => { extractedLastTurnUsage = u; },
            setContextWindow: (cw: number) => { extractedContextWindow = cw; },
            setAuthError: (err: string) => { authError = err; },
            setStreamError: (err: string) => { if (!streamError) streamError = err; },
          });
        } catch { /* ignore */ }
      }

      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;
      this.activeProc = null;
      clearTimeout(timeout);

      if (exitCode !== 0) {
        // Error cascade: auth error → stream-captured error → stderr → accumulated text
        // In verbose/streaming mode, stderr is often empty (all output routed to stdout as JSON)
        const errorDetail = authError
          ? `authentication_failed: ${authError}`
          : streamError
            ? streamError.slice(0, 500)
            : stderr.trim()
              ? stderr.slice(0, 500)
              : accumulatedText.slice(0, 500);
        if (streamError) {
          console.error(`[claude] Stream error captured: ${streamError.slice(0, 200)}`);
        }
        // Use RecoveryPolicy for retry decisions
        const category = this.recoveryPolicy.classify(errorDetail, exitCode);
        const decision = this.recoveryPolicy.shouldRetry(category, state);
        if (decision.retry) {
          console.warn(`[claude] ${category} error (exit ${exitCode}), retrying: ${errorDetail.slice(0, 100)}`);
          this.rateLimiter?.recordFailure();
          if (decision.action === "fresh_session" || decision.action === "cache_bust") {
            await this.sessions.newSession();
          }
          if (decision.waitMs > 0) await Bun.sleep(decision.waitMs);
          onProgress({ type: "phase", phase: "RETRY" });
          const nextState = this.recoveryPolicy.nextState(state, errorDetail.slice(0, 200), decision.action);
          const retryResult = await this.sendStreaming(prompt, null, onProgress, nextState);
          retryResult.retried = true;
          return retryResult;
        }
        return {
          sessionId: sessionId || "",
          result: "",
          error: `Claude exited with code ${exitCode}: ${errorDetail}`,
        };
      }

      // Resolve session ID: prefer extracted, then read from session file
      const realSessionId = extractedSessionId || (await this.sessions.current()) || sessionId || "";
      if (realSessionId && realSessionId !== sessionId) {
        await this.sessions.saveSession(realSessionId);
      }

      return {
        sessionId: realSessionId,
        result: accumulatedText || "",
        usage: extractedUsage,
        lastTurnUsage: extractedLastTurnUsage,
        contextWindow: extractedContextWindow,
      };
    } catch (err) {
      const category = this.recoveryPolicy.classify(String(err));
      const decision = this.recoveryPolicy.shouldRetry(category, state);
      if (decision.retry) {
        console.warn(`[claude] Spawn exception (streaming, ${category}), retrying: ${String(err).slice(0, 100)}`);
        this.rateLimiter?.recordFailure();
        await this.sessions.newSession();
        if (decision.waitMs > 0) await Bun.sleep(decision.waitMs);
        onProgress({ type: "phase", phase: "RETRY" });
        const nextState = this.recoveryPolicy.nextState(state, String(err).slice(0, 200), decision.action);
        const retryResult = await this.sendStreaming(prompt, null, onProgress, nextState);
        retryResult.retried = true;
        return retryResult;
      }
      return {
        sessionId: sessionId || "",
        result: "",
        error: `Failed to invoke Claude (streaming): ${err}`,
      };
    }
  }

  // Phase detection regex
  private static PHASE_RE = /━━━.*?(OBSERVE|THINK|PLAN|BUILD|EXECUTE|VERIFY|LEARN).*━━━/;
  private static PHASE_RE_GLOBAL = /━━━.*?(OBSERVE|THINK|PLAN|BUILD|EXECUTE|VERIFY|LEARN).*━━━/g;
  // ISC checkbox detection
  private static ISC_CHECKED_RE = /- \[x\]/gi;
  private static ISC_UNCHECKED_RE = /- \[ \]/g;

  /** Extract a short detail string from tool input (file path, command, pattern). */
  static extractToolDetail(tool: string, input?: Record<string, unknown>): string | undefined {
    if (!input) return undefined;
    switch (tool) {
      case "Read": return typeof input.file_path === "string" ? input.file_path.split("/").slice(-2).join("/") : undefined;
      case "Write": return typeof input.file_path === "string" ? input.file_path.split("/").slice(-2).join("/") : undefined;
      case "Edit": return typeof input.file_path === "string" ? input.file_path.split("/").slice(-2).join("/") : undefined;
      case "Glob": return typeof input.pattern === "string" ? input.pattern : undefined;
      case "Grep": return typeof input.pattern === "string" ? input.pattern.slice(0, 40) : undefined;
      case "Bash": return typeof input.command === "string" ? input.command.slice(0, 50) : undefined;
      case "Task": return typeof input.description === "string" ? input.description.slice(0, 40) : undefined;
      case "WebSearch": return typeof input.query === "string" ? input.query.slice(0, 40) : undefined;
      case "WebFetch": return typeof input.url === "string" ? input.url.slice(0, 50) : undefined;
      default: return undefined;
    }
  }

  private processStreamEvent(
    parsed: unknown,
    onProgress: (event: ProgressEvent) => void,
    toolBlocks: Map<number, string>,
    state: {
      getText: () => string;
      appendText: (t: string) => void;
      setSessionId: (id: string) => void;
      setUsage: (u: ClaudeResponse["usage"]) => void;
      setLastTurnUsage: (u: ClaudeResponse["usage"]) => void;
      setContextWindow: (cw: number) => void;
      setAuthError?: (err: string) => void;
      setStreamError?: (err: string) => void;
    },
  ): void {
    if (typeof parsed !== "object" || parsed === null) return;
    const obj = parsed as Record<string, unknown>;

    // Capture top-level error events (e.g. CLI error objects in the stream)
    if (obj.type === "error" && typeof obj.error === "object" && obj.error !== null) {
      const errObj = obj.error as Record<string, unknown>;
      const errMsg = typeof errObj.message === "string" ? errObj.message : JSON.stringify(errObj);
      state.setStreamError?.(errMsg);
      return;
    }

    // Handle CLI result event (final event in stream-json output)
    if (obj.type === "result") {
      if (typeof obj.session_id === "string") state.setSessionId(obj.session_id);
      if (typeof obj.result === "string") state.appendText(obj.result);

      // Extract full usage with cache tokens
      const usage = obj.usage as Record<string, unknown> | undefined;
      if (usage) {
        state.setUsage({
          input_tokens: (usage.input_tokens as number) || 0,
          output_tokens: (usage.output_tokens as number) || 0,
          cache_creation_input_tokens: (usage.cache_creation_input_tokens as number) || 0,
          cache_read_input_tokens: (usage.cache_read_input_tokens as number) || 0,
        });
      }

      // Extract contextWindow from modelUsage
      const modelUsage = obj.modelUsage as Record<string, Record<string, unknown>> | undefined;
      if (modelUsage) {
        const firstModel = Object.values(modelUsage)[0];
        if (firstModel?.contextWindow) {
          state.setContextWindow(firstModel.contextWindow as number);
        }
      }
      return; // Don't fall through to stream_event handling
    }

    // Handle top-level assistant events (session_id, content, per-turn usage)
    if (obj.type === "assistant") {
      if (typeof obj.session_id === "string" && obj.session_id) {
        state.setSessionId(obj.session_id);
      }
      // Detect errors (returned as error field on assistant events)
      if (typeof obj.error === "string" && obj.error) {
        if (isAuthError(obj.error)) {
          state.setAuthError?.(obj.error);
        } else {
          state.setStreamError?.(obj.error);
        }
      }

      // Extract text + tool_use from message.content for live phase/tool detection
      // CLI stream-json emits assistant events (not content_block_delta), so this is
      // the only place we can detect phases and tools during processing.
      const msg = obj.message as Record<string, unknown> | undefined;
      const content = msg?.content as Array<Record<string, unknown>> | undefined;
      if (content && Array.isArray(content)) {
        // Emit thinking indicator for thinking blocks
        const hasThinking = content.some(b => (b as Record<string, unknown>).type === "thinking");
        if (hasThinking) {
          onProgress({ type: "phase", phase: "thinking" });
        }
        let messageText = "";
        for (const block of content) {
          if (block.type === "text" && typeof block.text === "string") {
            messageText += block.text;
          }
          if (block.type === "tool_use" && typeof block.name === "string") {
            const idx = typeof block.index === "number" ? block.index : toolBlocks.size;
            if (!toolBlocks.has(idx)) {
              toolBlocks.set(idx, block.name as string);
              const detail = ClaudeInvoker.extractToolDetail(block.name as string, block.input as Record<string, unknown> | undefined);
              onProgress({ type: "tool_start", tool: block.name as string, detail });
            }
          }
        }
        // Emit content event for text blocks (live preview in status message)
        if (messageText) {
          onProgress({ type: "content", text: messageText });
        }
        if (messageText) {
          // Detect PAI mode header (═══ PAI | NATIVE MODE / ALGORITHM MODE / MINIMAL)
          const modeMatch = messageText.match(/PAI \| (NATIVE|ALGORITHM|MINIMAL)/);
          if (modeMatch) {
            const paiMode = modeMatch[1]!;
            if (paiMode === "ALGORITHM") {
              onProgress({ type: "phase", phase: "ALGORITHM" });
            } else {
              onProgress({ type: "phase", phase: paiMode });
            }
          }
          // Detect Algorithm phase markers
          const allPhases = [...messageText.matchAll(ClaudeInvoker.PHASE_RE_GLOBAL)];
          if (allPhases.length > 0) {
            const phase = allPhases[allPhases.length - 1]![1]!;
            onProgress({ type: "phase", phase });
          }
          // ISC progress
          const checked = (messageText.match(ClaudeInvoker.ISC_CHECKED_RE) || []).length;
          const unchecked = (messageText.match(ClaudeInvoker.ISC_UNCHECKED_RE) || []).length;
          if (checked + unchecked > 0) {
            onProgress({ type: "isc_progress", done: checked, total: checked + unchecked });
          }
        }
      }

      // Extract per-turn usage from message.usage — this represents actual context
      // window fill for THIS turn (not accumulated across agentic tool-use loops).
      // The LAST assistant event's usage = current context fill.
      const usage = msg?.usage as Record<string, unknown> | undefined;
      if (usage && typeof usage.input_tokens === "number") {
        state.setLastTurnUsage({
          input_tokens: (usage.input_tokens as number) || 0,
          output_tokens: (usage.output_tokens as number) || 0,
          cache_creation_input_tokens: (usage.cache_creation_input_tokens as number) || 0,
          cache_read_input_tokens: (usage.cache_read_input_tokens as number) || 0,
        });
      }
      return;
    }

    // Handle top-level result objects (session_id, result) — legacy fallback
    if (typeof obj.session_id === "string" && obj.session_id) {
      state.setSessionId(obj.session_id);
    }
    if (typeof obj.result === "string" && obj.result) {
      state.appendText(obj.result);
    }

    // Handle stream_event wrapper
    if (obj.type !== "stream_event" || typeof obj.event !== "object" || obj.event === null) return;
    const event = obj.event as Record<string, unknown>;

    switch (event.type) {
      case "message_start": {
        // Extract session_id from message.id if available
        const msg = event.message as Record<string, unknown> | undefined;
        if (msg?.id && typeof msg.id === "string") {
          state.setSessionId(msg.id);
        }
        break;
      }

      case "content_block_start": {
        const block = event.content_block as Record<string, unknown> | undefined;
        const idx = typeof event.index === "number" ? event.index : -1;
        if (block?.type === "tool_use" && typeof block.name === "string") {
          toolBlocks.set(idx, block.name);
          onProgress({ type: "tool_start", tool: block.name });
        }
        break;
      }

      case "content_block_delta": {
        const delta = event.delta as Record<string, unknown> | undefined;
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          state.appendText(delta.text);
          onProgress({ type: "text_chunk", text: delta.text });

          // Check for Algorithm phase markers — find the LAST phase in accumulated text
          const fullText = state.getText();
          const allPhases = [...fullText.matchAll(ClaudeInvoker.PHASE_RE_GLOBAL)];
          if (allPhases.length > 0) {
            onProgress({ type: "phase", phase: allPhases[allPhases.length - 1]![1]! });
          }

          // Check for ISC progress
          const checked = (fullText.match(ClaudeInvoker.ISC_CHECKED_RE) || []).length;
          const unchecked = (fullText.match(ClaudeInvoker.ISC_UNCHECKED_RE) || []).length;
          if (checked + unchecked > 0) {
            onProgress({ type: "isc_progress", done: checked, total: checked + unchecked });
          }
        }
        break;
      }

      case "content_block_stop": {
        const idx = typeof event.index === "number" ? event.index : -1;
        const toolName = toolBlocks.get(idx);
        if (toolName) {
          onProgress({ type: "tool_end", tool: toolName });
          toolBlocks.delete(idx);
        }
        break;
      }

      case "message_delta": {
        const usage = event.usage as { output_tokens?: number } | undefined;
        if (usage?.output_tokens) {
          // Cumulative usage — we'll get final count at the end
          state.setUsage({ input_tokens: 0, output_tokens: usage.output_tokens });
        }
        break;
      }
    }
  }

  // One-shot invocation (no session resume — for cron/automation)
  // Uses RecoveryPolicy for hook-failure rescue (ISC-24)
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
        // Classify error via RecoveryPolicy
        const category = this.recoveryPolicy.classify(stderr || "exit-" + exitCode, exitCode);
        if (category === "quota") {
          this.rateLimiter?.recordFailure();
        }
        // Hook failure rescue: non-zero exit but stdout may have valid output
        if (category === "hook_failure" && stdout.trim()) {
          const rescueParse = safeParse(ClaudeJsonOutputSchema, stdout, "claude/oneShot-rescue");
          if (rescueParse.success && rescueParse.data.result) {
            console.warn(`[claude] oneShot exited ${exitCode} but rescued output (${category})`);
            return {
              sessionId: rescueParse.data.session_id || "",
              result: rescueParse.data.result,
              usage: rescueParse.data.usage,
            };
          }
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
        const category = this.recoveryPolicy.classify(stderr || "exit-" + exitCode, exitCode);
        if (category === "quota") {
          this.rateLimiter?.recordFailure();
        }
        // Hook failure rescue: non-zero exit but stdout may have valid output
        if (category === "hook_failure" && stdout.trim()) {
          const rescueParse = safeParse(ClaudeJsonOutputSchema, stdout, "claude/quickShot-rescue");
          if (rescueParse.success && rescueParse.data.result) {
            console.warn(`[claude] quickShot exited ${exitCode} but rescued output (${category})`);
            return {
              sessionId: rescueParse.data.session_id || "",
              result: rescueParse.data.result,
              usage: rescueParse.data.usage,
            };
          }
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

  // Persistence: Generate summary + importance score for an episode via haiku
  async rateAndSummarize(content: string): Promise<{ summary: string; importance: number }> {
    const truncated = content.slice(0, 500);
    const prompt = `Rate this message and summarize it. Return ONLY a JSON object with two fields:
- "summary": a concise 1-sentence summary (max 50 tokens)
- "importance": integer 1-10 where 1=mundane scheduling/greeting, 5=normal conversation, 8=key decision/insight, 10=critical system change

Message:
${truncated}

Respond with ONLY valid JSON, no markdown.`;

    try {
      const response = await this.quickShot(prompt);
      if (response.error || !response.result) {
        return { summary: content.slice(0, 100), importance: 5 };
      }

      // Try to parse JSON from response
      const jsonMatch = response.result.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        const summary = typeof parsed.summary === "string" ? parsed.summary.slice(0, 200) : content.slice(0, 100);
        const importance = typeof parsed.importance === "number"
          ? Math.max(1, Math.min(10, Math.round(parsed.importance)))
          : 5;
        return { summary, importance };
      }
    } catch {
      // Fallback on any error
    }
    return { summary: content.slice(0, 100), importance: 5 };
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
