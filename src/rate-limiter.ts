// rate-limiter.ts — Phase 6A: Cooldown rate limiter for Claude API failures
// Tracks recent failures within a sliding window. When threshold hit, pauses
// automated dispatch (pipeline + orchestrator) for a cooldown period.
// Interactive Telegram messages are NEVER blocked (ISC-A1).

import type { Config } from "./config";

export type RateLimiterEvent = "paused" | "resumed";
export type RateLimiterListener = (event: RateLimiterEvent) => void;

export class RateLimiter {
  private failures: number[] = []; // timestamps of recent failures
  private paused = false;
  private cooldownTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners: RateLimiterListener[] = [];

  private threshold: number;
  private windowMs: number;
  private cooldownMs: number;

  constructor(config: Config) {
    this.threshold = config.rateLimiterFailureThreshold;
    this.windowMs = config.rateLimiterWindowMs;
    this.cooldownMs = config.rateLimiterCooldownMs;
  }

  // Record a rate-limit failure (called by ClaudeInvoker on 429/overloaded)
  recordFailure(): void {
    const now = Date.now();
    this.failures.push(now);

    // Prune failures outside the window
    const cutoff = now - this.windowMs;
    this.failures = this.failures.filter((t) => t >= cutoff);

    // Trigger cooldown if threshold reached
    if (!this.paused && this.failures.length >= this.threshold) {
      this.paused = true;
      console.warn(
        `[rate-limiter] Paused — ${this.failures.length} failures in ${this.windowMs / 1000}s window (cooldown: ${this.cooldownMs / 1000}s)`,
      );
      this.emit("paused");

      // Auto-resume after cooldown
      this.cooldownTimer = setTimeout(() => {
        this.resume();
      }, this.cooldownMs);
    }
  }

  // Check if automated dispatch should be paused
  isPaused(): boolean {
    return this.paused;
  }

  // Manual resume (or auto-resume after cooldown)
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.failures = [];
    if (this.cooldownTimer) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
    }
    console.log("[rate-limiter] Resumed");
    this.emit("resumed");
  }

  // Subscribe to pause/resume events
  onEvent(listener: RateLimiterListener): void {
    this.listeners.push(listener);
  }

  // Dashboard-friendly status
  getStatus(): {
    paused: boolean;
    recentFailures: number;
    cooldownRemainingMs: number;
    threshold: number;
  } {
    // Prune stale failures for accurate count
    const cutoff = Date.now() - this.windowMs;
    this.failures = this.failures.filter((t) => t >= cutoff);

    return {
      paused: this.paused,
      recentFailures: this.failures.length,
      cooldownRemainingMs: this.paused && this.cooldownTimer
        ? Math.max(0, this.cooldownMs - (Date.now() - (this.failures[this.failures.length - 1] || Date.now())))
        : 0,
      threshold: this.threshold,
    };
  }

  // Cleanup timer on shutdown
  stop(): void {
    if (this.cooldownTimer) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
    }
  }

  private emit(event: RateLimiterEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error(`[rate-limiter] Listener error: ${err}`);
      }
    }
  }
}
