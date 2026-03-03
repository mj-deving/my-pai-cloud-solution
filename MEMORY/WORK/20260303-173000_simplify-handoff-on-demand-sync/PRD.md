---
task: Simplify handoff to on-demand sync
slug: 20260303-173000_simplify-handoff-on-demand-sync
effort: extended
phase: complete
progress: 18/18
mode: algorithm
started: 2026-03-03T17:30:00+01:00
updated: 2026-03-03T17:45:00+01:00
---

## Context

Handoff is currently a confused mix of overlapping mechanisms: `/done` does git push + knowledge sync, `/handoff` does the same plus a status summary, `HandoffManager` writes JSON files on shutdown/inactivity but is disconnected from both commands, and `recordActivity()` is dead code. The `ProjectManager` also has its own `HandoffState` for per-project sessions.

Marius wants to work on Cloud for **days** without auto-commits, then sync to local **once** on demand. The current design auto-commits after every response (`lightweightWrapup`) and has an inactivity timer that writes handoff files nobody reads.

### Goal

One simple mental model: **work on Cloud freely, `/sync` when ready to hand off to local.** No auto-commits, no inactivity timers, no overlapping commands.

### What changes

1. **Kill auto-commits** — remove `lightweightWrapup()` calls from message handler
2. **Kill inactivity timer** — remove from HandoffManager
3. **Kill `recordActivity()`** — dead code
4. **Merge `/done` + `/handoff` into `/sync`** — one command that does: git add -u + commit + push + knowledge sync + status summary
5. **Wire HandoffManager.writeOutgoing() into `/sync`** — so the JSON handoff file is written on demand
6. **Keep shutdown writeOutgoing()** — safety net, bridge shutdown still writes handoff
7. **Remove `/done` and `/handoff` commands** — replaced by `/sync`

### Risks

- Removing auto-commits means Cloud work is only in working tree until `/sync` — crash = lost uncommitted work (mitigated: shutdown hook still commits, and git working tree survives process restart)
- Users (Marius) must remember to `/sync` before switching to local
- Config removal is safe — HANDOFF_INACTIVITY_MINUTES not set on VPS bridge.env (verified)

## Criteria

- [x] ISC-1: lightweightWrapup() call removed from telegram.ts message:text handler
- [x] ISC-2: /sync command exists in telegram.ts replacing /done and /handoff
- [x] ISC-3: /sync does git add -u + commit + push via projects.syncPush()
- [x] ISC-4: /sync does knowledge sync push via projects.knowledgeSyncPush()
- [x] ISC-5: /sync calls handoffManager.writeOutgoing() when handoffManager available
- [x] ISC-6: /sync shows status summary (project, git result, knowledge result, session, local pickup instructions)
- [x] ISC-7: /done command removed from telegram.ts
- [x] ISC-8: /handoff command removed from telegram.ts
- [x] ISC-9: /help text updated to show /sync instead of /done and /handoff
- [x] ISC-10: HandoffManager.recordActivity() method removed
- [x] ISC-11: HandoffManager inactivity timer removed (startInactivityTimer, inactivityTimer, inactivityMs, lastActivityTime)
- [x] ISC-12: HandoffManager constructor no longer starts timer
- [x] ISC-13: HandoffManager.stop() method removed (no timer to clear)
- [x] ISC-14: config.ts HANDOFF_INACTIVITY_MINUTES env var removed
- [x] ISC-15: Config interface handoffInactivityMinutes field removed
- [x] ISC-16: HANDOFF-CHEATSHEET.md updated to reflect /sync and no auto-commits
- [x] ISC-17: wrapup.ts deleted (zero callers after ISC-1)
- [x] ISC-18: bunx tsc --noEmit passes with zero errors

## Decisions

- Merged /done + /handoff into single /sync — simpler mental model
- Removed AUTO_COMMIT_ENABLED config alongside lightweightWrapup — both dead
- Kept shutdown writeOutgoing() as safety net — only code path that auto-writes handoff
- Removed HandoffManager.stop() entirely (not just simplified) — no state to clean up

## Verification

- `bunx tsc --noEmit` passes clean (exit 0)
- telegram.ts: /sync command at former /done+/handoff location, calls syncPush + knowledgeSyncPush + writeOutgoing
- telegram.ts: no lightweightWrapup import or call, no /done or /handoff commands
- handoff.ts: 139 lines (was 187), no timer, no recordActivity, no stop()
- config.ts: no HANDOFF_INACTIVITY_MINUTES, no AUTO_COMMIT_ENABLED, no autoCommitEnabled, no handoffInactivityMinutes
- wrapup.ts: deleted
- CLAUDE.md: module table updated, flow diagram updated
- HANDOFF-CHEATSHEET.md: /sync replaces /done+/handoff, no auto-commits documented
