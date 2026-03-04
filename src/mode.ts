// mode.ts — Dual-mode system: workspace vs project mode
// Tracks current mode, message counts, cumulative tokens for auto-wrapup logic.

import type { Config } from "./config";

export type BridgeMode =
  | { type: "workspace" }
  | { type: "project"; name: string };

export class ModeManager {
  private mode: BridgeMode = { type: "workspace" };
  private messageCount = 0;
  private cumulativeTokens = 0;
  private listeners: Array<(mode: BridgeMode) => void> = [];
  private keepRequested = false;
  private warningSent = false;

  getCurrentMode(): BridgeMode {
    return this.mode;
  }

  getMessageCount(): number {
    return this.messageCount;
  }

  getCumulativeTokens(): number {
    return this.cumulativeTokens;
  }

  isKeepRequested(): boolean {
    return this.keepRequested;
  }

  isWarningSent(): boolean {
    return this.warningSent;
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
  recordMessage(usage?: { input_tokens: number; output_tokens: number }): void {
    this.messageCount++;
    if (usage) {
      this.cumulativeTokens += usage.input_tokens + usage.output_tokens;
    }
  }

  /** Reset on session rotation (auto-wrapup or manual). */
  resetSessionMetrics(): void {
    this.messageCount = 0;
    this.cumulativeTokens = 0;
    this.keepRequested = false;
    this.warningSent = false;
  }

  /** User sent /keep — extend threshold. */
  requestKeep(): void {
    this.keepRequested = true;
    this.warningSent = false;
  }

  /** Mark that a warning was sent to the user. */
  markWarningSent(): void {
    this.warningSent = true;
  }

  /**
   * Check if auto-wrapup should trigger (workspace mode only).
   * Returns { trigger, warning, reason } where:
   * - trigger: true if wrapup should execute now
   * - warning: true if we should warn the user (approaching threshold)
   * - reason: human-readable explanation
   */
  shouldAutoWrapup(config: Config): { trigger: boolean; warning: boolean; reason: string } {
    if (this.mode.type !== "workspace") {
      return { trigger: false, warning: false, reason: "project mode" };
    }

    const maxMessages = this.keepRequested
      ? Math.ceil(config.workspaceSessionMaxMessages * 1.5)
      : config.workspaceSessionMaxMessages;
    const tokenThreshold = this.keepRequested
      ? Math.ceil(config.workspaceSessionTokenThreshold * 1.5)
      : config.workspaceSessionTokenThreshold;

    // Check token threshold
    if (this.cumulativeTokens >= tokenThreshold) {
      return { trigger: true, warning: false, reason: `token limit reached (${this.cumulativeTokens}/${tokenThreshold})` };
    }

    // Check message count threshold
    if (this.messageCount >= maxMessages) {
      return { trigger: true, warning: false, reason: `message limit reached (${this.messageCount}/${maxMessages})` };
    }

    // Warning at 80% of either threshold
    const tokenPercent = this.cumulativeTokens / tokenThreshold;
    const messagePercent = this.messageCount / maxMessages;

    if (!this.warningSent && (tokenPercent >= 0.8 || messagePercent >= 0.8)) {
      const contextPercent = Math.round(Math.max(tokenPercent, messagePercent) * 100);
      const remaining = Math.max(1, maxMessages - this.messageCount);
      return {
        trigger: false,
        warning: true,
        reason: `context at ${contextPercent}%, auto-freshening in ~${remaining} messages. /keep to stay.`,
      };
    }

    return { trigger: false, warning: false, reason: "within limits" };
  }

  /** Get estimated context usage percentage for statusline. */
  getContextPercent(config: Config): number | undefined {
    if (this.mode.type !== "workspace") return undefined;
    const maxMessages = this.keepRequested
      ? Math.ceil(config.workspaceSessionMaxMessages * 1.5)
      : config.workspaceSessionMaxMessages;
    const tokenThreshold = this.keepRequested
      ? Math.ceil(config.workspaceSessionTokenThreshold * 1.5)
      : config.workspaceSessionTokenThreshold;
    const tokenPercent = this.cumulativeTokens / tokenThreshold;
    const messagePercent = this.messageCount / maxMessages;
    return Math.round(Math.max(tokenPercent, messagePercent) * 100);
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
