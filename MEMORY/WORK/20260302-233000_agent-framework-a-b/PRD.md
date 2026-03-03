---
task: Agent framework Phase A completion + Phase B scheduler & policy
slug: 20260302-233000_agent-framework-a-b
effort: advanced
phase: complete
progress: 28/28
mode: algorithm
started: 2026-03-02T23:30:00+01:00
updated: 2026-03-02T23:30:00+01:00
---

## Context

Implementing the agent framework plan from `Plans/agent-framework-plan.md`. Phase A is 5/6 complete (frozen snapshots, char budget, project filters, config, VPS deploy all done). Only A4 (injection scanning) remains. Phase B (scheduler + policy engine) is fully unstarted — this achieves L3 conditional autonomy.

### Risks
- Injection scanning false positives could block legitimate pipeline tasks
- Scheduler must not create runaway autonomous loops — needs policy gatekeeping
- Policy engine must default-deny for safety — missing policy = blocked, not allowed
- SQLite contention between scheduler, pipeline, and agent registry on same DB
- Telegram command additions must not break existing command routing

## Criteria

### Phase A Completion — Injection Scanning (A4)

- [x] ISC-1: injection-scan.ts exports scanForInjection(text) returning ScanResult
- [x] ISC-2: Detects system prompt override patterns (e.g. "ignore previous instructions")
- [x] ISC-3: Detects role-switching attempts (e.g. "you are now", "act as")
- [x] ISC-4: Detects data exfiltration patterns (e.g. "send to", "POST http")
- [x] ISC-5: ScanResult includes risk level (none/low/medium/high) and matched patterns
- [x] ISC-6: Pipeline.ts calls scanForInjection before dispatch
- [x] ISC-7: High-risk scan triggers warning in decision traces, does NOT block (log-only v1)
- [x] ISC-8: Config flag INJECTION_SCAN_ENABLED with default true

### Phase B — Scheduler (B1, B3, B5)

- [x] ISC-9: scheduler.ts exports Scheduler class with SQLite-backed schedule store
- [x] ISC-10: Schedule table: id, name, cron_expr, task_template JSON, enabled, last_run, next_run
- [x] ISC-11: Scheduler.tick() checks due schedules and emits task JSON to pipeline tasks/
- [x] ISC-12: Cron expression parsing supports minute/hour/day/month/weekday fields
- [x] ISC-13: Scheduler wired into bridge.ts startup with configurable poll interval
- [x] ISC-14: Built-in schedule: daily memory synthesis (02:00 UTC)
- [x] ISC-15: Built-in schedule: weekly system health review (Sunday 03:00 UTC)
- [x] ISC-16: Config flags: SCHEDULER_ENABLED, SCHEDULER_POLL_INTERVAL_MS, SCHEDULER_DB_PATH

### Phase B — Policy Engine (B2, B4)

- [x] ISC-17: policy.ts exports PolicyEngine class that loads rules from policy.yaml
- [x] ISC-18: policy.yaml defines actions with allow/deny/must_ask disposition
- [x] ISC-19: PolicyEngine.check(action, context) returns allow/deny/escalate
- [x] ISC-20: Default disposition is deny (missing rule = blocked)
- [x] ISC-21: must_ask actions trigger Telegram notification to Marius for approval
- [x] ISC-22: Pipeline.ts calls policy check before task dispatch
- [x] ISC-23: Orchestrator.ts calls policy check before step dispatch
- [x] ISC-24: Policy violations logged as decision traces

### Phase B — Telegram Command (B6)

- [x] ISC-25: /schedule command lists all schedules with status
- [x] ISC-26: /schedule enable <name> and /schedule disable <name> toggle schedules
- [x] ISC-27: /schedule run <name> triggers immediate execution

### Integration

- [x] ISC-28: bunx tsc --noEmit passes with all new files

## Decisions

## Verification

- `bunx tsc --noEmit` passes clean (0 errors)
- injection-scan.ts: 18 regex patterns across 4 categories (system-override, role-switch, exfil, leak), risk levels none/low/medium/high
- scheduler.ts: SQLite table with 7 columns, 5-field cron parser (expandField handles */step, ranges, lists), nextCronOccurrence searches 366 days
- policy.ts: YAML-based rules with first-match + prefix glob, default deny, must_ask escalation callback
- policy.yaml: 14 rules covering pipeline, scheduler, orchestrator, delegation, git, system, memory, PRD
- pipeline.ts: scanForInjection called before dispatch (log-only), policy check blocks+writes error result
- orchestrator.ts: policy check at dispatchStep entry, fails step on deny
- bridge.ts: scheduler + policy init after handoff, wired to pipeline/orchestrator/messenger, shutdown cleanup
- telegram.ts: /schedule command with list/enable/disable/run subcommands
- config.ts: 6 new env vars (INJECTION_SCAN_ENABLED, SCHEDULER_ENABLED, SCHEDULER_POLL_INTERVAL_MS, SCHEDULER_DB_PATH, POLICY_ENABLED, POLICY_FILE)
