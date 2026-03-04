// mode.ts — Dual-mode system: workspace vs project mode
// Tracks current mode, real context window fill via CLI usage data.

import type { ClaudeResponse } from "./claude";

export type BridgeMode =
  | { type: "workspace" }
  | { type: "project"; name: string };

export class ModeManager {
  private mode: BridgeMode = { type: "workspace" };
  private messageCount = 0;
  private lastUsage: ClaudeResponse["usage"] | undefined;
  private lastTurnUsage: ClaudeResponse["usage"] | undefined;
  private contextWindowSize: number = 200_000; // default, updated from CLI
  private listeners: Array<(mode: BridgeMode) => void> = [];
  private suggestionSent = false;
  private suggestionDismissed = false;

  getCurrentMode(): BridgeMode {
    return this.mode;
  }

  getMessageCount(): number {
    return this.messageCount;
  }

  getLastUsage(): ClaudeResponse["usage"] | undefined {
    return this.lastUsage;
  }

  switchToProject(name: string): void {
    this.mode = { type: "project", name };
    this.notify();
  }

  switchToWorkspace(): void {
    this.mode = { type: "workspace" };
    this.notify();
  }

  /** Called after each message response to track session metrics. */
  recordMessage(usage?: ClaudeResponse["usage"], contextWindow?: number, lastTurnUsage?: ClaudeResponse["usage"]): void {
    this.messageCount++;
    if (usage) {
      // Accumulated usage across all agentic turns (for /status display)
      this.lastUsage = usage;
    }
    if (lastTurnUsage) {
      // Per-turn usage from last assistant event — accurate context window fill.
      // This represents the actual tokens in the context window for the final
      // API call, not accumulated across tool-use loops.
      this.lastTurnUsage = lastTurnUsage;
    }
    if (contextWindow) {
      this.contextWindowSize = contextWindow;
    }
  }

  /** Reset on session rotation (wrapup or manual). */
  resetSessionMetrics(): void {
    this.messageCount = 0;
    this.lastUsage = undefined;
    this.lastTurnUsage = undefined;
    this.suggestionSent = false;
    this.suggestionDismissed = false;
  }

  /** User sent /keep — dismiss the wrapup suggestion. */
  requestKeep(): void {
    this.suggestionDismissed = true;
  }

  /** Mark that a suggestion was sent to the user. */
  markSuggestionSent(): void {
    this.suggestionSent = true;
  }

  /**
   * Get real context usage percentage from CLI usage data.
   * Prefers lastTurnUsage (per-turn, accurate context fill) over
   * accumulated usage (which inflates when Claude uses tools).
   * Returns undefined if no usage data yet.
   */
  getContextPercent(): number | undefined {
    // Prefer per-turn usage (from last assistant event) — accurate context fill
    const usage = this.lastTurnUsage || this.lastUsage;
    if (!usage) return undefined;
    const total = (usage.input_tokens || 0) +
                  (usage.cache_creation_input_tokens || 0) +
                  (usage.cache_read_input_tokens || 0);
    return Math.min(Math.round((total / this.contextWindowSize) * 100), 99);
  }

  /**
   * Check if we should suggest a wrapup to the user.
   * Suggest-only — never force-rotates. Single suggestion at 70% context fill.
   * Works for both modes.
   */
  shouldSuggestWrapup(): { suggest: boolean; reason: string } {
    const pct = this.getContextPercent();
    if (pct == null) return { suggest: false, reason: "no data" };
    if (this.suggestionDismissed) return { suggest: false, reason: "dismissed" };
    if (this.suggestionSent) return { suggest: false, reason: "already suggested" };
    if (pct >= 70) {
      return {
        suggest: true,
        reason: `Context at ${pct}%. /compact to compress, /wrapup to start fresh, /keep to dismiss.`,
      };
    }
    return { suggest: false, reason: "within limits" };
  }

  onChange(listener: (mode: BridgeMode) => void): void {
    this.listeners.push(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.mode);
      } catch (err) {
        console.warn(`[mode] Listener error: ${err}`);
      }
    }
  }
}
