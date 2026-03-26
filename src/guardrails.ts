// guardrails.ts — Pre-execution authorization for bridge-owned operations
// Scoped to: pipeline tasks, oneShot invocations, playbook steps, A2A outbound calls
// NOT scoped to: Claude-native tool execution (no interception point exists)

import type { Config } from "./config";

export interface GuardrailsRule {
  pattern: string; // regex pattern to match operation description
  action: "allow" | "deny";
  reason: string;
  context?: string; // optional context filter (e.g., "playbook", "pipeline")
}

export interface GuardrailsDecision {
  allowed: boolean;
  rule?: GuardrailsRule;
  reason: string;
}

export class Guardrails {
  private allowlist: GuardrailsRule[] = [];
  private denylist: GuardrailsRule[] = [];
  private patternCache = new Map<string, RegExp>();

  constructor(private config: Config) {
    this.loadDefaultRules();
  }

  /** Check if an operation is allowed. Denylist takes precedence. */
  check(operation: string, context?: string): GuardrailsDecision {
    // Check denylist first (deny takes precedence)
    for (const rule of this.denylist) {
      if (this.matches(rule, operation, context)) {
        return { allowed: false, rule, reason: rule.reason };
      }
    }

    // If allowlist is non-empty, operation must match at least one rule
    if (this.allowlist.length > 0) {
      for (const rule of this.allowlist) {
        if (this.matches(rule, operation, context)) {
          return { allowed: true, rule, reason: rule.reason };
        }
      }
      return { allowed: false, reason: "Operation not in allowlist" };
    }

    // No allowlist configured = allow by default
    return { allowed: true, reason: "No restrictions configured" };
  }

  /** Add a rule to the allowlist. */
  addAllowRule(rule: GuardrailsRule): void {
    this.allowlist.push({ ...rule, action: "allow" });
  }

  /** Add a rule to the denylist. */
  addDenyRule(rule: GuardrailsRule): void {
    this.denylist.push({ ...rule, action: "deny" });
  }

  /** Clear all rules. */
  clearRules(): void {
    this.allowlist = [];
    this.denylist = [];
  }

  /** Get current rule counts. */
  getStats(): { allowRules: number; denyRules: number } {
    return { allowRules: this.allowlist.length, denyRules: this.denylist.length };
  }

  private matches(
    rule: GuardrailsRule,
    operation: string,
    context?: string,
  ): boolean {
    if (rule.context && context !== rule.context) return false;
    try {
      let regex = this.patternCache.get(rule.pattern);
      if (!regex) {
        if (rule.pattern.length > 200) return false;
        regex = new RegExp(rule.pattern, "i");
        this.patternCache.set(rule.pattern, regex);
      }
      return regex.test(operation);
    } catch {
      return false;
    }
  }

  private loadDefaultRules(): void {
    // Default deny: destructive git operations during playbook execution
    this.addDenyRule({
      pattern: "git\\s+(push\\s+--force|reset\\s+--hard|clean\\s+-fd)",
      action: "deny",
      reason: "Destructive git operations blocked during automated execution",
      context: "playbook",
    });
    // Default deny: rm -rf in any context
    this.addDenyRule({
      pattern: "rm\\s+-rf\\s+/",
      action: "deny",
      reason: "Recursive deletion of root paths blocked",
    });
    // Default deny: process kill in pipeline context
    this.addDenyRule({
      pattern: "kill\\s+-9|pkill|killall",
      action: "deny",
      reason: "Process killing blocked in automated context",
      context: "pipeline",
    });
  }
}
