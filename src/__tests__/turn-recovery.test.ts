import { describe, it, expect } from "bun:test";
import { RecoveryPolicy } from "../turn-recovery";
import type { ErrorCategory, RetryState } from "../turn-recovery";

describe("RecoveryPolicy", () => {
  const policy = new RecoveryPolicy();

  describe("classify", () => {
    it("classifies auth errors correctly", () => {
      expect(policy.classify("authentication_failed")).toBe("auth");
      expect(policy.classify("OAuth token expired")).toBe("auth");
      expect(policy.classify("authentication_error: invalid")).toBe("auth");
    });

    it("classifies quota errors correctly", () => {
      expect(policy.classify("rate_limit exceeded")).toBe("quota");
      expect(policy.classify("HTTP 429 Too Many Requests")).toBe("quota");
      expect(policy.classify("server overloaded")).toBe("quota");
      expect(policy.classify("Too many requests")).toBe("quota");
    });

    it("classifies stale session errors correctly", () => {
      expect(policy.classify("No conversation found with session ID abc123")).toBe("stale_session");
    });

    it("classifies hook failure errors correctly (exit code 1 only)", () => {
      expect(policy.classify("hook failure", 1)).toBe("hook_failure");
      // Exit codes > 1 are infrastructure errors, classified as transient
      expect(policy.classify("some error", 2)).toBe("transient");
      expect(policy.classify("OOM killed", 137)).toBe("transient");
    });

    it("classifies empty response correctly", () => {
      expect(policy.classify("")).toBe("empty");
    });

    it("classifies transient errors as fallback", () => {
      expect(policy.classify("connection reset by peer")).toBe("transient");
      expect(policy.classify("unexpected EOF")).toBe("transient");
    });
  });

  describe("shouldRetry", () => {
    it("auth errors never retry", () => {
      const state = policy.initialState();
      const result = policy.shouldRetry("auth", state);
      expect(result.retry).toBe(false);
      expect(result.action).toBe("fail_fast");
    });

    it("quota errors never retry (rate limiter handles it)", () => {
      const state = policy.initialState();
      const result = policy.shouldRetry("quota", state);
      expect(result.retry).toBe(false);
      expect(result.action).toBe("fail_fast");
    });

    it("transient errors retry once then stop", () => {
      const state0 = policy.initialState();
      const first = policy.shouldRetry("transient", state0);
      expect(first.retry).toBe(true);
      expect(first.action).toBe("fresh_session");
      expect(first.waitMs).toBeGreaterThan(0);

      const state1 = policy.nextState(state0, "connection reset", "fresh_session");
      const second = policy.shouldRetry("transient", state1);
      expect(second.retry).toBe(false);
    });

    it("stale session retries once with cache_bust", () => {
      const state0 = policy.initialState();
      const result = policy.shouldRetry("stale_session", state0);
      expect(result.retry).toBe(true);
      expect(result.action).toBe("cache_bust");

      const state1 = policy.nextState(state0, "stale", "cache_bust");
      const result2 = policy.shouldRetry("stale_session", state1);
      expect(result2.retry).toBe(false);
    });

    it("empty response retries once", () => {
      const state0 = policy.initialState();
      const result = policy.shouldRetry("empty", state0);
      expect(result.retry).toBe(true);

      const state1 = policy.nextState(state0, "", "backoff");
      expect(policy.shouldRetry("empty", state1).retry).toBe(false);
    });

    it("hook failure does not retry", () => {
      const state = policy.initialState();
      const result = policy.shouldRetry("hook_failure", state);
      expect(result.retry).toBe(false);
      expect(result.action).toBe("log_continue");
    });
  });

  describe("RetryState tracking", () => {
    it("initialState starts at attempt 0", () => {
      const state = policy.initialState();
      expect(state.attempt).toBe(0);
      expect(state.lastError).toBe("");
      expect(state.strategy).toBe("");
    });

    it("nextState increments attempt and records error", () => {
      const state0 = policy.initialState();
      const state1 = policy.nextState(state0, "connection reset", "fresh_session");
      expect(state1.attempt).toBe(1);
      expect(state1.lastError).toBe("connection reset");
      expect(state1.strategy).toBe("fresh_session");
    });
  });

  describe("custom overrides", () => {
    it("custom strategy overrides work", () => {
      const custom = new RecoveryPolicy({
        transient: { maxRetries: 3, backoffMs: 5000 },
      });
      const state0 = custom.initialState();
      const r1 = custom.shouldRetry("transient", state0);
      expect(r1.retry).toBe(true);
      expect(r1.waitMs).toBe(5000);

      // Should allow up to 3 retries
      let state = state0;
      for (let i = 0; i < 3; i++) {
        const r = custom.shouldRetry("transient", state);
        expect(r.retry).toBe(true);
        state = custom.nextState(state, "err", "fresh_session");
      }
      // 4th attempt should fail
      expect(custom.shouldRetry("transient", state).retry).toBe(false);
    });
  });
});
