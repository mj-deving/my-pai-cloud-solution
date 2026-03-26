import { describe, test, expect, beforeEach } from "bun:test";
import { Guardrails } from "../guardrails";
import type { Config } from "../config";

const mockConfig = { guardrailsEnabled: true } as unknown as Config;

describe("Guardrails", () => {
  let guard: Guardrails;

  beforeEach(() => {
    guard = new Guardrails(mockConfig);
  });

  test("default deny rules block destructive git operations in playbook context", () => {
    const r1 = guard.check("git push --force origin main", "playbook");
    expect(r1.allowed).toBe(false);
    expect(r1.reason).toContain("Destructive git");

    const r2 = guard.check("git reset --hard HEAD~1", "playbook");
    expect(r2.allowed).toBe(false);
  });

  test("default deny rules block rm -rf / in any context", () => {
    const r = guard.check("rm -rf /var/data");
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("Recursive deletion");
  });

  test("default deny rules block process killing in pipeline context", () => {
    const r = guard.check("kill -9 1234", "pipeline");
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("Process killing");
  });

  test("custom allow rules work", () => {
    guard.addAllowRule({ pattern: "bun\\s+test", action: "allow", reason: "Tests allowed" });
    const r = guard.check("bun test");
    expect(r.allowed).toBe(true);
    expect(r.rule?.reason).toBe("Tests allowed");
  });

  test("denylist takes precedence over allowlist", () => {
    guard.addAllowRule({ pattern: ".*", action: "allow", reason: "Allow all" });
    const r = guard.check("rm -rf /tmp");
    expect(r.allowed).toBe(false);
  });

  test("context filtering works — deny rule scoped to playbook does not fire in other contexts", () => {
    const r = guard.check("git push --force origin main", "pipeline");
    expect(r.allowed).toBe(true);
  });

  test("invalid regex does not crash", () => {
    guard.addDenyRule({ pattern: "[invalid(", action: "deny", reason: "bad regex" });
    const r = guard.check("anything");
    expect(r.allowed).toBe(true);
  });

  test("clearRules removes all rules", () => {
    guard.clearRules();
    expect(guard.getStats()).toEqual({ allowRules: 0, denyRules: 0 });
    const r = guard.check("rm -rf /");
    expect(r.allowed).toBe(true);
  });

  test("getStats returns correct counts", () => {
    const stats = guard.getStats();
    expect(stats.denyRules).toBe(3); // 3 default deny rules
    expect(stats.allowRules).toBe(0);
  });

  test("operations allowed by default when no allowlist configured", () => {
    const r = guard.check("echo hello");
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe("No restrictions configured");
  });
});
