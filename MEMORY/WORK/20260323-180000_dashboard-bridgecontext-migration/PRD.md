---
task: Dashboard BridgeContext migration with TDD approach
slug: 20260323-180000_dashboard-bridgecontext-migration
effort: standard
phase: complete
updated: 2026-03-23T18:05:00+01:00
progress: 8/8
mode: interactive
started: 2026-03-23T18:00:00+01:00
updated: 2026-03-23T18:00:30+01:00
---

## Context

Refactor Dashboard constructor from 15 positional args to BridgeContext bag pattern. TelegramAdapter already uses this pattern — Dashboard is the last holdout. Pure refactor, no behavior change. User requires TDD (test first) and fabric code review post-implementation.

### Risks
- Test helper might not cover all BridgeContext fields leading to type errors
- Dashboard internal nullable fields vs BridgeContext non-null core fields (claude, sessions, modeManager)

## Criteria

- [x] ISC-1: Test helper makeCtx() builds valid BridgeContext with defaults
- [x] ISC-2: Test for basic Dashboard accepts makeCtx() without positional args
- [x] ISC-3: Test for Dashboard with mock claude uses makeCtx override
- [x] ISC-4: Dashboard constructor accepts single BridgeContext parameter
- [x] ISC-5: Dashboard private fields assigned from ctx in constructor body
- [x] ISC-6: bridge.ts passes ctx bag instead of 15 positional args
- [x] ISC-7: All 221+ tests pass after migration
- [x] ISC-8: Type check passes (bunx tsc --noEmit)
- [x] ISC-A-1: No Dashboard method bodies modified

## Decisions

- 2026-03-23 18:02: Keep private fields over storing ctx directly — avoids touching method bodies
- 2026-03-23 18:04: Drop ?? null per code review — BridgeContext types already guarantee nullability
- 2026-03-23 18:04: Skip extracting makeCtx to shared helper — YAGNI, one consumer today

## Verification

- ISC-1: makeCtx() in gateway.test.ts builds full BridgeContext with 23 fields, all defaults null
- ISC-2: `new Dashboard(makeCtx())` — first beforeAll block, line 56
- ISC-3: `new Dashboard(makeCtx({ config, claude: mockClaude }))` — line 175
- ISC-4: `constructor(ctx: BridgeContext)` — dashboard.ts line 65
- ISC-5: 15 field assignments from ctx — dashboard.ts lines 66-80
- ISC-6: `new Dashboard(ctx)` — bridge.ts line 559 (was 6 lines, now 1)
- ISC-7: `bun test` — 221 pass, 0 fail, 284ms
- ISC-8: `npx tsc --noEmit` — clean, no errors
- ISC-A-1: `start()` at line 87 unchanged, all method bodies identical to pre-refactor
- Capability: /simplify invoked — 3 agents reviewed; fixed ?? null redundancy and inline imports
