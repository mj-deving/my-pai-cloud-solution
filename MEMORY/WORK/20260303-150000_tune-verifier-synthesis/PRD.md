---
task: Tune verifier to not flag max_turns as error for synthesis tasks
slug: 20260303-150000_tune-verifier-synthesis
effort: standard
phase: complete
progress: 8/8
mode: algorithm
started: 2026-03-03T15:00:00+01:00
updated: 2026-03-03T15:00:00+01:00
---

## Context

Scheduler emits synthesis tasks with `max_turns: 10` (scheduler.ts:157). Pipeline dispatches these to Claude CLI with `--max-turns 10` AND fires `synthesisLoop.run()` as a side-effect (pipeline.ts:428). The Claude dispatch is redundant for synthesis tasks — real work happens in the synthesis loop. When Claude hits the turn limit, the verifier sees incomplete output and flags FAIL, creating noise.

Two issues to fix:
1. Pipeline should skip verification for `type: "synthesis"` tasks (dispatch result is irrelevant)
2. Verifier prompt should recognize `max_turns` as an acceptable exit reason for any task type

### Risks
- Overly broad skip could hide real synthesis failures
- Modifying verifier prompt could mask legitimate truncation errors

## Criteria

- [x] ISC-1: Pipeline skips verifier for tasks with `type: "synthesis"`
- [x] ISC-2: Pipeline skips verifier for tasks with `type: "prd"`
- [x] ISC-3: Verifier prompt instructs Claude that max_turns exit is acceptable
- [x] ISC-4: Verifier prompt distinguishes max_turns from genuine errors
- [x] ISC-5: Existing verifier behavior unchanged for normal pipeline tasks
- [x] ISC-6: Decision trace emitted when verification is skipped
- [x] ISC-7: Type check passes (`bunx tsc --noEmit`)
- [x] ISC-8: Log message emitted when verification skipped for synthesis/prd

## Decisions

## Verification

- ISC-1: PASS — `skipVerifyTypes` includes "synthesis" (pipeline.ts:363)
- ISC-2: PASS — `skipVerifyTypes` includes "prd" (pipeline.ts:363)
- ISC-3: PASS — Instruction #4 in verifier prompt (verifier.ts:126)
- ISC-4: PASS — "Only flag FAIL if clearly wrong/harmful/unrelated" (verifier.ts:126)
- ISC-5: PASS — Guard condition preserves normal task verification path (pipeline.ts:364)
- ISC-6: PASS — Trace with reason_code "verification_skipped" (pipeline.ts:381-386)
- ISC-7: PASS — `bunx tsc --noEmit` clean
- ISC-8: PASS — console.log with type and task ID (pipeline.ts:380)
