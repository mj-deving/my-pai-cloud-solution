/**
 * turn-recovery.ts — Unified retry/recovery policy for ClaudeInvoker.
 *
 * Replaces the duplicated boolean _isRetry logic across send(),
 * sendStreaming(), oneShot(), and quickShot() with a single
 * RecoveryPolicy that classifies errors and decides next action.
 */

import { isRateLimitError, isAuthError } from "./claude";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ErrorCategory =
  | "auth"
  | "quota"
  | "transient"
  | "empty"
  | "stale_session"
  | "hook_failure";

export interface RetryState {
  attempt: number;
  lastError: string;
  strategy: string;
}

export type RecoveryAction =
  | "fail_fast"
  | "backoff"
  | "fresh_session"
  | "cache_bust"
  | "log_continue";

export interface RecoveryStrategy {
  maxRetries: number;
  action: RecoveryAction;
  backoffMs?: number;
}

export interface RetryDecision {
  retry: boolean;
  action: string;
  waitMs: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_STRATEGIES: Record<ErrorCategory, RecoveryStrategy> = {
  auth: { maxRetries: 0, action: "fail_fast" },
  quota: { maxRetries: 0, action: "fail_fast" },
  transient: { maxRetries: 1, action: "fresh_session", backoffMs: 1000 },
  empty: { maxRetries: 1, action: "backoff", backoffMs: 500 },
  stale_session: { maxRetries: 1, action: "cache_bust", backoffMs: 0 },
  hook_failure: { maxRetries: 0, action: "log_continue" },
};

// ---------------------------------------------------------------------------
// RecoveryPolicy
// ---------------------------------------------------------------------------

export class RecoveryPolicy {
  private strategies: Record<ErrorCategory, RecoveryStrategy>;

  constructor(
    overrides?: Partial<Record<ErrorCategory, Partial<RecoveryStrategy>>>,
  ) {
    // Deep-copy defaults then merge overrides
    this.strategies = {} as Record<ErrorCategory, RecoveryStrategy>;
    for (const key of Object.keys(DEFAULT_STRATEGIES) as ErrorCategory[]) {
      this.strategies[key] = { ...DEFAULT_STRATEGIES[key] };
    }
    if (overrides) {
      for (const [key, patch] of Object.entries(overrides) as Array<
        [ErrorCategory, Partial<RecoveryStrategy>]
      >) {
        if (this.strategies[key] && patch) {
          Object.assign(this.strategies[key], patch);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // classify — turn an error string (+ optional exit code) into a category
  // -------------------------------------------------------------------------

  classify(errorDetail: string, exitCode?: number): ErrorCategory {
    // Empty response (no error text at all)
    if (errorDetail === "") return "empty";

    // Auth — reuse existing helper
    if (isAuthError(errorDetail)) return "auth";

    // Quota / rate-limit — reuse existing helper
    if (isRateLimitError(errorDetail)) return "quota";

    // Stale session
    if (errorDetail.includes("No conversation found with session ID"))
      return "stale_session";

    // Hook failure: non-zero exit but stdout may be valid
    if (exitCode !== undefined && exitCode !== 0) return "hook_failure";

    // Everything else is transient
    return "transient";
  }

  // -------------------------------------------------------------------------
  // shouldRetry — given a category and current state, decide what to do
  // -------------------------------------------------------------------------

  shouldRetry(category: ErrorCategory, state: RetryState): RetryDecision {
    const strategy = this.strategies[category];

    // Non-retryable actions
    if (
      strategy.action === "fail_fast" ||
      strategy.action === "log_continue"
    ) {
      return { retry: false, action: strategy.action, waitMs: 0 };
    }

    // Exhausted retries
    if (state.attempt >= strategy.maxRetries) {
      return { retry: false, action: strategy.action, waitMs: 0 };
    }

    return {
      retry: true,
      action: strategy.action,
      waitMs: strategy.backoffMs ?? 0,
    };
  }

  // -------------------------------------------------------------------------
  // State helpers
  // -------------------------------------------------------------------------

  initialState(): RetryState {
    return { attempt: 0, lastError: "", strategy: "" };
  }

  nextState(
    current: RetryState,
    error: string,
    strategy: string,
  ): RetryState {
    return {
      attempt: current.attempt + 1,
      lastError: error,
      strategy,
    };
  }
}
