---
task: Reduce Ollama not-available log spam to one-time message
slug: 20260303-151000_reduce-ollama-log-spam
effort: standard
phase: complete
progress: 8/8
mode: algorithm
started: 2026-03-03T15:10:00+01:00
updated: 2026-03-03T15:10:00+01:00
---

## Context

`EmbeddingProvider.healthCheck()` retries every 5 minutes when Ollama is unavailable. Each retry logs "Ollama not available, using keyword search fallback". On VPS (no Ollama), this produces ~288 log lines/day of pure noise. Fix: log once at startup, suppress repeated "still not available" messages, but still log state transitions (became available, became unavailable).

## Criteria

- [x] ISC-1: "Ollama not available" logged only once at first health check failure
- [x] ISC-2: Subsequent retry failures produce no log output
- [x] ISC-3: State transition to available still logs success message
- [x] ISC-4: State transition from available to unavailable still logs warning
- [x] ISC-5: Retry timer still fires every 5 minutes (logic unchanged)
- [x] ISC-6: Retry timer still clears when Ollama becomes available
- [x] ISC-7: Type check passes (`bunx tsc --noEmit`)
- [x] ISC-8: No new class properties or methods beyond a boolean flag

## Decisions

## Verification
