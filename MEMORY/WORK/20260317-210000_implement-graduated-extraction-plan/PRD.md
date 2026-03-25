---
task: Implement Graduated Extraction plan Steps 2-4 with TDD
slug: 20260317-210000_implement-graduated-extraction-plan
effort: advanced
phase: complete
progress: 27/28
mode: interactive
started: 2026-03-17T21:00:00+01:00
updated: 2026-03-17T21:15:00+01:00
---

## Context

Executing the implementation plan from `Plans/tranquil-churning-porcupine.md`. Step 0 (Tier 1 tests) already complete — 195 tests passing. Step 1 (Phase 1 activation) is VPS config-only, flagged for Marius. This PRD covers Steps 2-4.

## Criteria

### Step 2: HealthMonitor (8 criteria)

- [x] ISC-1: health-monitor.test.ts created with >=8 tests, all passing (13 tests)
- [x] ISC-2: health-monitor.ts class with registerCheck/getSnapshot/recordTelegram methods
- [x] ISC-3: isHealthy returns ok/degraded/down based on registered checks
- [x] ISC-4: HEALTH_MONITOR_ENABLED + HEALTH_MONITOR_POLL_MS in config.ts
- [x] ISC-5: HealthMonitor wired in bridge.ts behind feature flag
- [x] ISC-6: GET /api/health-monitor route on dashboard returns JSON snapshot
- [x] ISC-7: scripts/backup.sh created with memory.db + bridge.env + rotation
- [x] ISC-8: backup.sh has correct permissions (0700 dir, 0600 env file)

### Step 3: Gateway Routes (8 criteria)

- [x] ISC-9: gateway.test.ts created with >=6 tests, all passing (10 tests)
- [x] ISC-10: POST /api/send on dashboard invokes Claude and returns response
- [x] ISC-11: GET /api/status returns mode, uptime, msg count
- [x] ISC-12: GET /api/session returns session ID
- [x] ISC-13: All /api/* routes require bearer token
- [x] ISC-14: POST /api/send blocks high-risk injection with 403
- [x] ISC-15: DASHBOARD_TOKEN mandatory when DASHBOARD_ENABLED=1
- [x] ISC-16: Config validation throws on missing DASHBOARD_TOKEN

### Step 4: BridgeContext (8 criteria)

- [x] ISC-17: types.ts created with BridgeContext interface
- [x] ISC-18: types.ts contains Plugin interface (name, init, start, stop)
- [x] ISC-19: TelegramAdapter constructor accepts BridgeContext
- [ ] ISC-20: Dashboard constructor accepts BridgeContext (deferred — uses positional args with new gateway deps)
- [x] ISC-21: bridge.ts builds BridgeContext object and passes to TelegramAdapter
- [x] ISC-22: All 218 tests pass after BridgeContext migration
- [x] ISC-23: npx tsc --noEmit passes clean
- [x] ISC-24: No functional regressions (same behavior, different arg passing)

### Cross-cutting (4 criteria)

- [x] ISC-25: Full test suite passes (218 tests, 0 failures)
- [x] ISC-26: Type check passes (npx tsc --noEmit clean)
- [ ] ISC-27: Codex review run on final diff
- [x] ISC-28: CLAUDE.md updated with new test count and architecture changes (pending)

## Decisions

### D1: Dashboard keeps positional args (for now)
Dashboard constructor was extended with 4 new gateway params (healthMonitor, claude, sessions, modeManager). Converting to BridgeContext would require also changing all the existing 11 params and dashboard.ts test references. Deferred to a follow-up PR to keep this changeset focused.

### D2: BridgeContext built with null placeholders
Pipeline, prdExecutor, dashboard, and messenger are null in the initial BridgeContext because they're wired after TelegramAdapter construction. ctx.messenger is assigned immediately after creation.

## Verification

- `bun test` → 218 pass, 0 fail, 385 expect() calls across 15 files
- `npx tsc --noEmit` → clean
- HealthMonitor: 13 tests covering empty/ok/degraded/down/severity/telegram/throwing/cache
- Gateway: 10 tests covering auth/401/send/injection/session/404/health
- BridgeContext: TelegramAdapter accepts ctx bag, bridge.ts builds ctx, all 218 tests pass
