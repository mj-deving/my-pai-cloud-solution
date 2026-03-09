---
task: "Add bot.catch, fix retry error logging, create test suite"
slug: "20260309-190000_grammy-crash-retry-logging-tests"
effort: Advanced
phase: complete
progress: 24/24
mode: algorithm
started: 2026-03-09T19:00:00+01:00
updated: 2026-03-09T19:05:00+01:00
---

## Context

Three priority fixes for the Isidore Cloud bridge:

1. **Grammy crash prevention**: No `bot.catch` handler exists. Any unhandled GrammyError (e.g. Markdown parse failure in ctx.reply) crashes the entire bridge process. Confirmed Mar 7 crash. ~35 `ctx.reply(..., { parse_mode: "Markdown" })` calls exist without try-catch fallback.

2. **Retry error logging**: `claude.ts:337-341` — when streaming mode CLI dies, stderr is empty (--verbose routes all to stdout as JSON). The `errorDetail` fallback to `accumulatedText` works but may contain the full response text rather than the actual error. Need to capture error info from stream events.

3. **Test suite creation**: No tests exist. Create `bun test` infrastructure with priority tests for retry paths and Markdown safety.

### Risks
- Wrapping every ctx.reply individually is tedious and error-prone — need a helper
- Test suite must not require Telegram bot token or VPS access
- accumulatedText fallback in retry logging may already be reasonable — verify before changing

## Criteria

- [x] ISC-1: bot.catch handler registered on Grammy Bot instance
- [x] ISC-2: bot.catch logs error details to console.error
- [x] ISC-3: bot.catch does not crash the process
- [x] ISC-4: safeReply helper wraps ctx.reply with Markdown fallback to plain text
- [x] ISC-5: /help command uses safeReply for individual help texts
- [x] ISC-6: /status command uses safeReply
- [x] ISC-7: /projects command uses safeReply
- [x] ISC-8: /sync command uses safeReply
- [x] ISC-9: /deploy command uses safeReply
- [x] ISC-10: /review command uses safeReply
- [x] ISC-11: /merge command uses safeReply
- [x] ISC-12: sendDirectMessage in telegram-adapter uses try-catch with plain text fallback
- [x] ISC-13: Streaming error detail captures error field from assistant events
- [x] ISC-14: errorDetail prefers authError, then stream-captured error, then stderr, then accumulatedText
- [x] ISC-15: Error field extraction logged to console for debugging
- [x] ISC-16: src/__tests__ directory created
- [x] ISC-17: format.test.ts tests chunkMessage boundary splitting
- [x] ISC-18: format.test.ts tests escMd special character escaping
- [x] ISC-19: claude.test.ts tests extractToolDetail for each tool type
- [x] ISC-20: claude.test.ts tests isRateLimitError pattern matching
- [x] ISC-21: claude.test.ts tests isAuthError pattern matching
- [x] ISC-22: claude.test.ts tests isRecoverableError logic
- [x] ISC-23: bunx tsc --noEmit passes with all changes
- [x] ISC-24: bun test passes all test files

## Decisions

- Used `safeReply` helper over individual try-catch to avoid repetition
- Kept /help's existing try-catch since it already had the pattern
- Added `streamError` as new error capture channel in processStreamEvent, separate from authError
- Exported error detection functions from claude.ts for testability
- Tests are pure-function tests (no Grammy/Telegram mocking needed)

## Verification

- tsc --noEmit: clean (0 errors)
- bun test: 41 pass, 0 fail across 2 files (139ms)
- bot.catch: registered at telegram.ts:103, logs via console.error
- safeReply: defined at telegram.ts:137, used by all Markdown reply calls
- sendDirectMessage: try-catch with plain text fallback at telegram-adapter.ts:64-71
- Error cascade: authError → streamError → stderr → accumulatedText at claude.ts:340-348
