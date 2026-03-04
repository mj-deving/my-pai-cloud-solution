---
task: Cloud wrapup writes MEMORY.md and CLAUDE.local.md in project mode
slug: 20260304-165500_cloud-wrapup-writes-memory-files
effort: standard
phase: complete
progress: 8/8
mode: algorithm
started: 2026-03-04T16:55:00+01:00
updated: 2026-03-04T17:14:00+01:00
---

## Context

Cloud bridge's `/wrapup` only saves a summary episode to memory.db. It writes no files. This means MEMORY.md and CLAUDE.local.md on VPS stay stale, breaking continuity with local workflows. Cloud Isidore should mirror local wrapup Steps 3+4: synthesize MEMORY.md and update CLAUDE.local.md. CLAUDE.md hygiene (Step 6) is skipped — requires interactive approval not possible in bridge.

### Risks
- quickShot (haiku) may produce lower-quality synthesis than full Claude session
- Auto-memory path computation must match Claude Code's internal convention exactly

## Criteria

- [x] ISC-1: `computeAutoMemoryPath(projectDir)` returns correct `~/.claude/projects/{slug}/memory/MEMORY.md` path
- [x] ISC-2: `performWrapup()` reads current MEMORY.md from auto-memory path (graceful if missing)
- [x] ISC-3: quickShot prompt synthesizes MEMORY.md from current content + recent episodes
- [x] ISC-4: Synthesized MEMORY.md written to auto-memory path (mkdir -p if needed)
- [x] ISC-5: quickShot prompt generates CLAUDE.local.md from recent episodes
- [x] ISC-6: CLAUDE.local.md written to project dir
- [x] ISC-7: File writing only happens in project mode (skipped in workspace mode)
- [x] ISC-8: `bunx tsc --noEmit` passes clean

## Decisions

## Verification
