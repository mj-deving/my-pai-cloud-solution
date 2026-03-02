// policy.ts — Machine-readable policy engine for autonomous operation boundaries
// Loads rules from policy.yaml at startup. Every autonomous action is checked
// against policy before dispatch. Default disposition: DENY (missing rule = blocked).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

export type Disposition = "allow" | "deny" | "must_ask";

export interface PolicyRule {
  action: string;
  disposition: Disposition;
  conditions?: Record<string, unknown>;
  description?: string;
}

export interface PolicyConfig {
  version: number;
  default_disposition: Disposition;
  rules: PolicyRule[];
}

export interface PolicyCheckResult {
  allowed: boolean;
  disposition: Disposition;
  rule: string; // matched rule action or "default"
  reason: string;
}

export type EscalationCallback = (action: string, context: Record<string, unknown>) => Promise<void>;

export class PolicyEngine {
  private config: PolicyConfig;
  private onEscalate: EscalationCallback | null = null;

  constructor(policyPath: string) {
    this.config = this.loadPolicy(policyPath);
    console.log(`[policy] Loaded ${this.config.rules.length} rules (default: ${this.config.default_disposition})`);
  }

  /** Set callback for must_ask escalations (typically sends Telegram message). */
  setEscalationCallback(cb: EscalationCallback): void {
    this.onEscalate = cb;
  }

  /**
   * Check whether an action is allowed.
   * Returns the disposition and matched rule.
   * For must_ask, triggers the escalation callback.
   */
  async check(action: string, context: Record<string, unknown> = {}): Promise<PolicyCheckResult> {
    // Find matching rule — first match wins
    const rule = this.findRule(action);

    if (!rule) {
      // No rule matched — use default disposition
      const disposition = this.config.default_disposition;
      return {
        allowed: disposition === "allow",
        disposition,
        rule: "default",
        reason: `No rule for "${action}", using default: ${disposition}`,
      };
    }

    // Check conditions if present
    if (rule.conditions && !this.matchConditions(rule.conditions, context)) {
      // Conditions not met — treat as default
      const disposition = this.config.default_disposition;
      return {
        allowed: disposition === "allow",
        disposition,
        rule: "default",
        reason: `Rule "${rule.action}" conditions not met, using default: ${disposition}`,
      };
    }

    if (rule.disposition === "must_ask") {
      // Fire escalation callback
      if (this.onEscalate) {
        await this.onEscalate(action, context);
      }
      return {
        allowed: false,
        disposition: "must_ask",
        rule: rule.action,
        reason: rule.description || `Action "${action}" requires human approval`,
      };
    }

    return {
      allowed: rule.disposition === "allow",
      disposition: rule.disposition,
      rule: rule.action,
      reason: rule.description || `Rule "${rule.action}": ${rule.disposition}`,
    };
  }

  /** Get all rules (for dashboard/listing). */
  getRules(): PolicyRule[] {
    return [...this.config.rules];
  }

  /** Get default disposition. */
  getDefaultDisposition(): Disposition {
    return this.config.default_disposition;
  }

  private findRule(action: string): PolicyRule | undefined {
    // Exact match first, then prefix match (e.g., "pipeline.*" matches "pipeline.dispatch")
    for (const rule of this.config.rules) {
      if (rule.action === action) return rule;
      if (rule.action.endsWith(".*")) {
        const prefix = rule.action.slice(0, -2);
        if (action.startsWith(prefix)) return rule;
      }
    }
    return undefined;
  }

  private matchConditions(conditions: Record<string, unknown>, context: Record<string, unknown>): boolean {
    for (const [key, expected] of Object.entries(conditions)) {
      const actual = context[key];
      if (actual !== expected) return false;
    }
    return true;
  }

  private loadPolicy(path: string): PolicyConfig {
    try {
      const raw = readFileSync(path, "utf-8");
      const parsed = parseYaml(raw) as PolicyConfig;

      if (!parsed || typeof parsed !== "object") {
        throw new Error("Policy file is not a valid YAML object");
      }

      return {
        version: parsed.version ?? 1,
        default_disposition: parsed.default_disposition ?? "deny",
        rules: Array.isArray(parsed.rules) ? parsed.rules : [],
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        console.warn(`[policy] Policy file not found at ${path}, using empty ruleset with default deny`);
        return { version: 1, default_disposition: "deny", rules: [] };
      }
      throw err;
    }
  }
}
