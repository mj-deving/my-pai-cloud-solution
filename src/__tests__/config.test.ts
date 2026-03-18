import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { loadConfig } from "../config";

// Minimal valid env for loadConfig
const MINIMAL_ENV = {
  TELEGRAM_BOT_TOKEN: "123456:ABC-DEF",
  TELEGRAM_ALLOWED_USER_ID: "443039215",
};

// Save and restore process.env around each test
let savedEnv: NodeJS.ProcessEnv;

const CONFIG_ENV_PATTERN = /^(TELEGRAM_|PIPELINE_|REVERSE_PIPELINE_|ORCHESTRATOR_|BRANCH_ISOLATION_|RESOURCE_GUARD_|RATE_LIMITER_|VERIFIER_|DASHBOARD_|MEMORY_|CONTEXT_|PRD_|INJECTION_|SCHEDULER_|POLICY_|SYNTHESIS_|AGENT_|OBSERVATION_|WHITEBOARD_|WORKSPACE_|CODEX_|STATUS_|EMAIL_)/;
const CONFIG_ENV_EXACT = new Set(["SESSION_ID_FILE", "CLAUDE_BINARY", "HANDOFF_STATE_FILE", "PROJECT_SYNC_SCRIPT", "QUICK_MODEL", "MESSENGER_TYPE"]);

beforeEach(() => {
  savedEnv = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (CONFIG_ENV_PATTERN.test(key) || CONFIG_ENV_EXACT.has(key)) {
      delete process.env[key];
    }
  }
});

afterEach(() => {
  process.env = savedEnv;
});

describe("loadConfig", () => {
  test("throws on missing TELEGRAM_BOT_TOKEN", () => {
    Object.assign(process.env, { TELEGRAM_ALLOWED_USER_ID: "12345" });
    expect(() => loadConfig()).toThrow("TELEGRAM_BOT_TOKEN");
  });

  test("throws on missing TELEGRAM_ALLOWED_USER_ID", () => {
    Object.assign(process.env, { TELEGRAM_BOT_TOKEN: "token" });
    expect(() => loadConfig()).toThrow("TELEGRAM_ALLOWED_USER_ID");
  });

  test("returns valid Config with minimal required env vars", () => {
    Object.assign(process.env, MINIMAL_ENV);
    const config = loadConfig();
    expect(config.telegramBotToken).toBe("123456:ABC-DEF");
    expect(config.telegramAllowedUserId).toBe(443039215);
    expect(config.pipelineEnabled).toBe(true);
    expect(config.telegramMaxChunkSize).toBe(4000);
    expect(config.maxClaudeTimeoutMs).toBe(300_000);
  });

  test("boolean env vars parse '0' as false", () => {
    Object.assign(process.env, MINIMAL_ENV, {
      PIPELINE_ENABLED: "0",
      MEMORY_ENABLED: "0",
      CODEX_AUTOFIX: "0",
    });
    const config = loadConfig();
    expect(config.pipelineEnabled).toBe(false);
    expect(config.memoryEnabled).toBe(false);
    expect(config.codexAutofixEnabled).toBe(false);
  });

  test("boolean env vars parse '1' as true", () => {
    Object.assign(process.env, MINIMAL_ENV, {
      MEMORY_ENABLED: "1",
      DASHBOARD_ENABLED: "1",
      DASHBOARD_TOKEN: "test-token",
    });
    const config = loadConfig();
    expect(config.memoryEnabled).toBe(true);
    expect(config.dashboardEnabled).toBe(true);
  });

  test("optional int env vars use fallback when not set", () => {
    Object.assign(process.env, MINIMAL_ENV);
    const config = loadConfig();
    expect(config.pipelinePollIntervalMs).toBe(5_000);
    expect(config.pipelineMaxConcurrent).toBe(1);
    expect(config.rateLimiterFailureThreshold).toBe(3);
    expect(config.rateLimiterWindowMs).toBe(300_000);
    expect(config.dashboardPort).toBe(3456);
  });

  test("optional int env vars accept valid values", () => {
    Object.assign(process.env, MINIMAL_ENV, {
      PIPELINE_MAX_CONCURRENT: "8",
      DASHBOARD_PORT: "8080",
    });
    const config = loadConfig();
    expect(config.pipelineMaxConcurrent).toBe(8);
    expect(config.dashboardPort).toBe(8080);
  });

  test("optional int env vars reject out-of-range values", () => {
    Object.assign(process.env, MINIMAL_ENV, {
      PIPELINE_MAX_CONCURRENT: "999", // max is 32
    });
    expect(() => loadConfig()).toThrow();
  });

  test("TELEGRAM_ALLOWED_USER_ID rejects non-numeric strings", () => {
    Object.assign(process.env, {
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_ALLOWED_USER_ID: "not-a-number",
    });
    expect(() => loadConfig()).toThrow();
  });

  test("TELEGRAM_ALLOWED_USER_ID rejects negative numbers", () => {
    Object.assign(process.env, {
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_ALLOWED_USER_ID: "-1",
    });
    expect(() => loadConfig()).toThrow();
  });

  test("quickModel defaults to 'haiku'", () => {
    Object.assign(process.env, MINIMAL_ENV);
    const config = loadConfig();
    expect(config.quickModel).toBe("haiku");
  });

  test("quickModel accepts custom value", () => {
    Object.assign(process.env, MINIMAL_ENV, { QUICK_MODEL: "sonnet" });
    const config = loadConfig();
    expect(config.quickModel).toBe("sonnet");
  });
});
