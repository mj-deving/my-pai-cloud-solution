import { describe, test, expect } from "bun:test";
import { HealthMonitor } from "../health-monitor";
import type { Config } from "../config";

// Minimal config for HealthMonitor
function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    healthMonitorPollMs: 60_000,
    ...overrides,
  } as Config;
}

describe("HealthMonitor", () => {
  test("empty monitor returns overall ok with empty checks", () => {
    const hm = new HealthMonitor(makeConfig());
    const snap = hm.getSnapshot();
    expect(snap.overall).toBe("ok");
    expect(snap.checks).toEqual([]);
  });

  test("registered ok check returns overall ok", () => {
    const hm = new HealthMonitor(makeConfig());
    hm.registerCheck("db", () => ({ name: "db", status: "ok" }));
    const snap = hm.getSnapshot();
    expect(snap.overall).toBe("ok");
    expect(snap.checks).toHaveLength(1);
    expect(snap.checks[0]!.name).toBe("db");
    expect(snap.checks[0]!.status).toBe("ok");
  });

  test("registered degraded check returns overall degraded", () => {
    const hm = new HealthMonitor(makeConfig());
    hm.registerCheck("cache", () => ({
      name: "cache",
      status: "degraded",
      message: "high latency",
    }));
    const snap = hm.getSnapshot();
    expect(snap.overall).toBe("degraded");
    expect(snap.checks[0]!.status).toBe("degraded");
    expect(snap.checks[0]!.message).toBe("high latency");
  });

  test("registered down check returns overall down", () => {
    const hm = new HealthMonitor(makeConfig());
    hm.registerCheck("db", () => ({
      name: "db",
      status: "down",
      message: "connection refused",
    }));
    const snap = hm.getSnapshot();
    expect(snap.overall).toBe("down");
  });

  test("multiple checks — highest severity wins (down > degraded > ok)", () => {
    const hm = new HealthMonitor(makeConfig());
    hm.registerCheck("ok-check", () => ({ name: "ok-check", status: "ok" }));
    hm.registerCheck("degraded-check", () => ({
      name: "degraded-check",
      status: "degraded",
    }));
    const snap1 = hm.getSnapshot();
    expect(snap1.overall).toBe("degraded");

    // Now add a down check — should escalate to down
    hm.registerCheck("down-check", () => ({
      name: "down-check",
      status: "down",
    }));
    const snap2 = hm.getSnapshot();
    expect(snap2.overall).toBe("down");
    expect(snap2.checks).toHaveLength(3);
  });

  test("uptime increases and timestamp is ISO string", () => {
    const hm = new HealthMonitor(makeConfig());
    const snap = hm.getSnapshot();
    expect(snap.uptime).toBeGreaterThanOrEqual(0);
    expect(typeof snap.timestamp).toBe("string");
    // ISO 8601 format check
    expect(new Date(snap.timestamp).toISOString()).toBe(snap.timestamp);
  });

  test("recordTelegramSuccess and recordTelegramFailure are tracked", () => {
    const hm = new HealthMonitor(makeConfig());
    hm.recordTelegramSuccess();
    hm.recordTelegramSuccess();
    hm.recordTelegramFailure();
    const snap = hm.getSnapshot();
    expect(snap.telegram.success).toBe(2);
    expect(snap.telegram.failure).toBe(1);
    expect(snap.telegram.rate).toBeCloseTo(2 / 3);
  });

  test("telegram success rate above 0.8 does not degrade overall", () => {
    const hm = new HealthMonitor(makeConfig());
    // 9 success, 1 failure = 90% rate
    for (let i = 0; i < 9; i++) hm.recordTelegramSuccess();
    hm.recordTelegramFailure();
    const snap = hm.getSnapshot();
    expect(snap.telegram.rate).toBe(0.9);
    expect(snap.overall).toBe("ok");
  });

  test("telegram success rate below 0.8 degrades overall", () => {
    const hm = new HealthMonitor(makeConfig());
    // 3 success, 2 failure = 60% rate
    for (let i = 0; i < 3; i++) hm.recordTelegramSuccess();
    hm.recordTelegramFailure();
    hm.recordTelegramFailure();
    const snap = hm.getSnapshot();
    expect(snap.telegram.rate).toBe(0.6);
    expect(snap.overall).toBe("degraded");
  });

  test("check function that throws returns down with error message", () => {
    const hm = new HealthMonitor(makeConfig());
    hm.registerCheck("broken", () => {
      throw new Error("DB connection lost");
    });
    const snap = hm.getSnapshot();
    expect(snap.overall).toBe("down");
    expect(snap.checks[0]!.status).toBe("down");
    expect(snap.checks[0]!.message).toBe("DB connection lost");
  });

  test("getSnapshot returns cached result from last periodic run", () => {
    const hm = new HealthMonitor(makeConfig({ healthMonitorPollMs: 60_000 } as any));
    let callCount = 0;
    hm.registerCheck("counter", () => {
      callCount++;
      return { name: "counter", status: "ok" as const };
    });

    // start() triggers initial runChecks, caching result
    hm.start();
    const firstCount = callCount;
    expect(firstCount).toBeGreaterThanOrEqual(1);

    // getSnapshot should use cache, not re-run checks
    hm.getSnapshot();
    hm.getSnapshot();
    expect(callCount).toBe(firstCount);
    hm.stop();
  });

  test("stop clears the interval timer", () => {
    const hm = new HealthMonitor(makeConfig());
    hm.start();
    hm.stop();
    // No error on double-stop
    hm.stop();
  });

  test("telegram rate defaults to 1.0 with no messages", () => {
    const hm = new HealthMonitor(makeConfig());
    const snap = hm.getSnapshot();
    expect(snap.telegram.success).toBe(0);
    expect(snap.telegram.failure).toBe(0);
    expect(snap.telegram.rate).toBe(1.0);
  });
});
