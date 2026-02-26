# Session: /deleteproject + Path Auto-Detection

**Date:** 2026-02-26 19:30
**Duration:** ~50min
**Mode:** full
**Working Directory:** /home/mj/projects/my-pai-cloud-solution

## Summary

Built two new features for the Telegram bridge: `/deleteproject` command for removing projects from the registry, and path auto-detection that discovers project directories at the conventional `~/projects/<name>` location when the registry path is null. Both deployed and tested via Telegram on VPS.

## Work Done

- Built `/deleteproject` command — registry-only deletion with exact name match, cleans handoff state, shows manual cleanup commands
- Fixed TypeScript strict mode error: `splice(idx, 1)[0]` returns `T | undefined`, added `!` assertion
- Built path auto-detection in `ProjectManager.autoDetectPath()` — checks `~/projects/<name>/.git/HEAD`
- Fixed ordering bug: auto-detection was in `setActiveProject()` but `ensureCloned()` bailed on null path first; moved detection to `ensureCloned()`
- Added `autoDetected` flag to both `ensureCloned()` and `setActiveProject()` return types for "(auto-detected)" label in Telegram reply
- Removed duplicated `## Current State` section from CLAUDE.md (lives in MEMORY.md only)
- Updated MEMORY.md and CLAUDE.local.md with all new features
- Deployed 3 times to VPS during iterative testing
- Cleaned up test-auto and test-project from VPS registry and directories

## Decisions Made

| Decision | Rationale | Alternatives Considered |
|----------|-----------|------------------------|
| Registry-only deletion for /deleteproject | Too destructive to auto-delete VPS dirs or GitHub repos from Telegram | Full deletion with confirmation prompt |
| Exact name match for deletion | Partial matching (like getProject uses) too risky for destructive ops | Partial match with confirmation |
| Auto-detect in ensureCloned() not setActiveProject() | ensureCloned runs first and bails on null path before setActiveProject | Only in setActiveProject (broken flow) |
| Convention-based detection (~/projects/<name>) | Matches /newproject's VPS_PROJECTS_DIR and existing project layout | Env var, config file, filesystem scan |

## Key Files Modified

| File | Change Type | Description |
|------|-------------|-------------|
| src/projects.ts | edited | Added deleteProject(), autoDetectPath(), updated ensureCloned() and setActiveProject() |
| src/telegram.ts | edited | Added /deleteproject handler, /start listing, auto-detected label in /project reply |
| CLAUDE.md | edited | Removed duplicated Current State section |

## Learnings

- TypeScript strict mode: `Array.splice()` returns `T | undefined` even when index is validated — need `!` assertion
- Flow ordering matters: when multiple methods check the same condition (null path), auto-detection must happen at the earliest check point, not the latest
- `bunx` not available on local WSL machine — use `npx` for tsc instead
- PAI SecurityValidator hook blocks `gh repo delete` everywhere (SSH and local) — must be run by user manually

## Open Items

- [ ] Marius must run `gh repo delete mj-deving/test-auto --yes` and `gh repo delete mj-deving/test-project --yes`
- [ ] Remove Wrapup.md.bak after confirming hygiene fix works
- [ ] Email bridge (C6) awaiting IMAP/SMTP credentials

## Context for Next Session

/deleteproject and path auto-detection are fully deployed on VPS. Two GitHub repos (test-auto, test-project) still exist and need manual deletion by Marius. Next feature work is Gregor collaboration maturity (session-based pipeline tasks, priority queuing) unless C6 credentials arrive first.
