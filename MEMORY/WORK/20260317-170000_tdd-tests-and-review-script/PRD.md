---
task: Add config, schemas, rate-limiter tests plus review script
slug: 20260317-170000_tdd-tests-and-review-script
effort: advanced
phase: complete
progress: 26/26
mode: interactive
started: 2026-03-17T17:00:00+01:00
updated: 2026-03-17T17:15:00+01:00
---

## Context

Implement TDD foundation items 2-4 from the roadmap. Add test coverage for the three highest-risk untested modules (config.ts, schemas.ts, rate-limiter.ts) and create the automated review-and-fix script.

## Criteria

### config.ts tests
- [x] ISC-1: Test file exists at src/__tests__/config.test.ts
- [x] ISC-2: loadConfig throws on missing TELEGRAM_BOT_TOKEN
- [x] ISC-3: loadConfig throws on missing TELEGRAM_ALLOWED_USER_ID
- [x] ISC-4: loadConfig returns valid Config with minimal required env vars
- [x] ISC-5: Boolean env vars parse "0" as false and "1" as true
- [x] ISC-6: Optional int env vars use fallback when not set
- [x] ISC-7: Optional int env vars reject out-of-range values
- [x] ISC-8: TELEGRAM_ALLOWED_USER_ID rejects non-numeric strings

### schemas.ts tests
- [x] ISC-9: Test file exists at src/__tests__/schemas.test.ts
- [x] ISC-10: PipelineTaskSchema accepts valid task JSON
- [x] ISC-11: PipelineTaskSchema rejects task missing required fields
- [x] ISC-12: PipelineTaskSchema rejects task with extra fields (strict mode)
- [x] ISC-13: PipelineResultSchema accepts valid result JSON
- [x] ISC-14: EpisodeSchema accepts valid episode with all source types
- [x] ISC-15: EpisodeSchema rejects importance outside 1-10 range
- [x] ISC-16: safeParse returns success for valid data
- [x] ISC-17: safeParse returns failure with message for invalid data
- [x] ISC-18: safeParse handles malformed JSON string gracefully
- [x] ISC-19: strictParse throws on invalid data

### rate-limiter.ts tests
- [x] ISC-20: Test file exists at src/__tests__/rate-limiter.test.ts
- [x] ISC-21: isPaused returns false initially
- [x] ISC-22: recordFailure triggers pause after threshold failures
- [x] ISC-23: resume resets paused state and clears failures
- [x] ISC-24: getStatus returns accurate failure count and pause state

### review-and-fix.sh
- [x] ISC-25: Script exists at scripts/review-and-fix.sh and is executable
- [x] ISC-26: Script runs type check and test gates (exits on failure)

## Decisions

1. Used regex for env cleanup in config tests instead of 20+ startsWith checks
2. Removed redundant `as Partial<Config>` casts in rate-limiter tests
3. Skipped shared test-utils.ts — premature for 2 test files
4. Kept tsc re-run in review-and-fix.sh auto-fix section for safety

## Verification

- 88 tests, 0 failures, 297ms across 5 files
- Type check clean (npx tsc --noEmit)
- /simplify ran 3 parallel review agents, fixed 2 findings (env cleanup regex, redundant casts)
