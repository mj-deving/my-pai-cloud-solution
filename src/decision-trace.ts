// decision-trace.ts — Structured decision logging for pipeline and orchestrator
// Each decision point emits a trace explaining what happened and why.

import type { DecisionTrace } from "./schemas";

/**
 * Create a single decision trace entry.
 */
export function createTrace(params: {
  phase: string;
  decision: string;
  reason_code: string;
  context?: Record<string, unknown>;
}): DecisionTrace {
  return {
    timestamp: new Date().toISOString(),
    phase: params.phase,
    decision: params.decision,
    reason_code: params.reason_code,
    context: params.context,
  };
}

/**
 * Collects decision traces during a single task processing lifecycle.
 */
export class TraceCollector {
  private traces: DecisionTrace[] = [];

  emit(params: {
    phase: string;
    decision: string;
    reason_code: string;
    context?: Record<string, unknown>;
  }): void {
    this.traces.push(createTrace(params));
  }

  getTraces(): DecisionTrace[] {
    return [...this.traces];
  }

  clear(): void {
    this.traces = [];
  }
}
