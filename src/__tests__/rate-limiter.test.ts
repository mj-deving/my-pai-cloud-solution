import { describe, test, expect } from "bun:test";
import { RateLimiter } from "../rate-limiter";
import type { Config } from "../config";

// Minimal config for RateLimiter
function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    rateLimiterFailureThreshold: 3,
    rateLimiterWindowMs: 10_000,
    rateLimiterCooldownMs: 5_000,
    ...overrides,
  } as Config;
}

describe("RateLimiter", () => {
  test("isPaused returns false initially", () => {
    const rl = new RateLimiter(makeConfig());
    expect(rl.isPaused()).toBe(false);
  });

  test("isPaused returns false after fewer failures than threshold", () => {
    const rl = new RateLimiter(makeConfig());
    rl.recordFailure();
    rl.recordFailure();
    expect(rl.isPaused()).toBe(false);
  });

  test("recordFailure triggers pause at threshold", () => {
    const rl = new RateLimiter(makeConfig());
    rl.recordFailure();
    rl.recordFailure();
    rl.recordFailure();
    expect(rl.isPaused()).toBe(true);
    rl.stop();
  });

  test("resume resets paused state", () => {
    const rl = new RateLimiter(makeConfig({ rateLimiterFailureThreshold: 1 }));
    rl.recordFailure();
    expect(rl.isPaused()).toBe(true);
    rl.resume();
    expect(rl.isPaused()).toBe(false);
    rl.stop();
  });

  test("resume is no-op when not paused", () => {
    const rl = new RateLimiter(makeConfig());
    rl.resume();
    expect(rl.isPaused()).toBe(false);
  });

  test("resume clears failure history", () => {
    const rl = new RateLimiter(makeConfig({ rateLimiterFailureThreshold: 2 }));
    rl.recordFailure();
    rl.recordFailure();
    expect(rl.isPaused()).toBe(true);
    rl.resume();
    rl.recordFailure();
    expect(rl.isPaused()).toBe(false);
    rl.stop();
  });

  test("getStatus returns accurate state", () => {
    const rl = new RateLimiter(makeConfig({ rateLimiterFailureThreshold: 5 }));
    rl.recordFailure();
    rl.recordFailure();
    const status = rl.getStatus();
    expect(status.paused).toBe(false);
    expect(status.recentFailures).toBe(2);
    expect(status.threshold).toBe(5);
    expect(status.cooldownRemainingMs).toBe(0);
  });

  test("getStatus shows paused state after threshold", () => {
    const rl = new RateLimiter(makeConfig({ rateLimiterFailureThreshold: 1 }));
    rl.recordFailure();
    const status = rl.getStatus();
    expect(status.paused).toBe(true);
    expect(status.recentFailures).toBe(1);
    rl.stop();
  });

  test("onEvent listener receives pause event", () => {
    const rl = new RateLimiter(makeConfig({ rateLimiterFailureThreshold: 1 }));
    const events: string[] = [];
    rl.onEvent((e) => events.push(e));
    rl.recordFailure();
    expect(events).toContain("paused");
    rl.stop();
  });

  test("onEvent listener receives resumed event", () => {
    const rl = new RateLimiter(makeConfig({ rateLimiterFailureThreshold: 1 }));
    const events: string[] = [];
    rl.onEvent((e) => events.push(e));
    rl.recordFailure();
    rl.resume();
    expect(events).toContain("resumed");
    rl.stop();
  });

  test("stop cleans up cooldown timer", () => {
    const rl = new RateLimiter(makeConfig({ rateLimiterFailureThreshold: 1 }));
    rl.recordFailure();
    expect(rl.isPaused()).toBe(true);
    rl.stop();
  });
});
