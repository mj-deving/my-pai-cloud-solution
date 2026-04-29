---
task: Validate bridge retirement plan freshness
slug: 20260418-102356_validate-bridge-retirement-plan
effort: standard
phase: observe
progress: 0/10
mode: interactive
started: 2026-04-18T10:23:56+02:00
updated: 2026-04-18T10:38:00+02:00
---

## Context

User asked to retire the Telegram bridge, but first wants a freshness check against the current DAI state since DAI has evolved since the plan was drafted. Plan source: beads `my-pai-cloud-solution-bng` (created 2026-04-17) + `Plans/phase-fg-channels-remote-control.md` + visual plan `~/.claude/diagrams/channels-migration-plan.html`.

**Original Phase 5 prerequisites (from beads ticket):**
(a) turn recording hook, (b) importance scoring hook (Haiku), (c) proactive notifications via Channels, (d) scheduler → cron migration. Blocked on Phase 2.

**Key dates:**
- Plan drafted: 2026-04-17
- Phase 2 completed: 2026-04-17 (same day; 44/44 ISC, PRD marked `phase: complete`)
- MEMORY.md last wrapup: 2026-04-02
- Today: 2026-04-18

### Risks
- **MEMORY.md is 16 days stale** — may misstate current VPS state, leading to bogus "blockers"
- **Retirement plan may assume Phase 4/6 incomplete** — but they appear to be live
- **Shadow-mode duration (2-3 weeks) may be excessive** — Channels has been live since 2026-03-26 (~3 weeks of parallel run already)
- **Original 4 blockers may no longer map 1:1 to real gaps** — Claude Code capabilities have evolved (v2.1.84 → v2.1.92)

## Criteria

- [x] ISC-1: Phase 2 (commands→skills) status confirmed via PRD + .claude/skills/ listing
- [x] ISC-2: Phase 4 (dashboard extract) deployment status confirmed via `systemctl is-active isidore-cloud-dashboard`
- [x] ISC-3: Phase 6 (Remote Control) enablement status confirmed via `systemctl is-active isidore-cloud-remote`
- [x] ISC-4: Current VPS Claude CLI version recorded (v2.1.92, vs plan baseline v2.1.84)
- [x] ISC-5: Blocker (a) turn recording — current location identified (bridge-only in ClaudeInvoker)
- [x] ISC-6: Blocker (b) importance scoring — current location identified (bridge-only in ClaudeInvoker)
- [x] ISC-7: Blocker (c) proactive notifications — current mechanism identified (bridge `/api/send` + scheduler)
- [x] ISC-8: Blocker (d) scheduler — current location identified (`src/scheduler.ts`, gated by `SCHEDULER_ENABLED`)
- [x] ISC-9: Freshness verdict per prerequisite reported with evidence
- [x] ISC-10: Refreshed plan proposed with updated prerequisites and shortened shadow duration

## Decisions

- **MEMORY.md will be updated** as part of wrapup, not this session — memory staleness was the finding, not the fix
- **No code changes this session** — validation only. User must approve refreshed plan before execution
- **Keep Standard effort** — 10 atomic criteria for a freshness audit is appropriate; this isn't a code-producing run
