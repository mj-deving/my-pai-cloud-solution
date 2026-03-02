---
task: Finish V2-B context injection — frozen snapshot, filters, char budget
slug: 20260302-170000_finish-v2b-context-injection
effort: standard
phase: complete
progress: 14/14
mode: algorithm
started: 2026-03-02T17:00:00+01:00
updated: 2026-03-02T17:00:00+01:00
---

## Context

V2-B context injection is partially implemented: `context.ts` (66 LOC) queries MemoryStore and formats results as a prompt prefix. `claude.ts` already has the `ContextBuilderLike` interface and calls `buildContext()` in both `send()` and `oneShot()`. `bridge.ts` wires it when `CONTEXT_INJECTION_ENABLED=1`.

Missing: (1) frozen snapshot caching for prompt cache stability (~75% cost reduction per research), (2) project+source filter passthrough, (3) char-bounded budget (research recommends 5K-8K chars).

Research insight: re-querying memory on every message creates a slightly different prompt prefix each time, invalidating Claude's prompt cache. Freezing the snapshot once per session preserves cache stability.

### Risks
- Stale snapshot could serve outdated context for too long — mitigate with 5-min TTL
- Char truncation could cut mid-sentence — mitigate by truncating at episode boundaries

## Criteria

- [x] ISC-1: ContextBuilder caches built context as frozen snapshot
- [x] ISC-2: Snapshot keyed by project name (undefined = default key)
- [x] ISC-3: Snapshot expires after 5-minute TTL
- [x] ISC-4: setProject() stores new project value on ContextBuilder
- [x] ISC-5: setProject() invalidates cached snapshot
- [x] ISC-6: invalidate() method clears the frozen snapshot
- [x] ISC-7: buildContext() returns cached snapshot when valid (not expired, same project)
- [x] ISC-8: buildContext() queries memory fresh when snapshot missing or expired
- [x] ISC-9: buildContext() accepts optional source filter parameter
- [x] ISC-10: Source filter passed through to memory.query()
- [x] ISC-11: Final output string hard-capped at contextMaxChars
- [x] ISC-12: CONTEXT_MAX_CHARS env var added to config (default 5000, range 1000-20000)
- [x] ISC-13: ContextBuilderLike interface extended with optional invalidate()
- [x] ISC-14: bunx tsc --noEmit passes with zero new type errors

## Decisions

## Verification

All 14/14 criteria pass. `bunx tsc --noEmit` clean. Three files modified: `src/context.ts` (rewritten from 66 to 149 LOC), `src/config.ts` (+3 lines), `src/claude.ts` (+1 line).
