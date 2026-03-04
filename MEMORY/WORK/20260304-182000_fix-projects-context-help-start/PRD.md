---
task: Fix projects, context %, /help, /start commands
slug: 20260304-182000_fix-projects-context-help-start
effort: Advanced
phase: complete
progress: 24/24
mode: execute
started: 2026-03-04T18:20:00+01:00
updated: 2026-03-04T18:45:00+01:00
---

## Context

Four bugs reported from Telegram testing:

1. **Projects:** Only `my-pai-cloud-solution` appears in `/projects`. `config/projects.json` has only one entry. Need to populate with all projects from the project registry, or at least allow adding them.
2. **Context %:** Statusline shows wildly wrong context percentages (55→40→21→177%). Root cause: `usage` from CLI's `type: "result"` event is ACCUMULATED across all agentic turns within a single CLI invocation. When Claude uses tools, multiple API calls happen, and input_tokens get summed — easily exceeding the 200k window. Fix: capture the LAST `type: "assistant"` event's `message.usage` for per-turn context fill instead.
3. **`/start`:** Shows `/wrapup — Manual session wrapup (workspace)` — outdated, wrapup works in both modes. Also references CLAUDE.local.md which no longer exists.
4. **`/help`:** No `/help` command exists. Need a `/help [command]` handler.

### Risks
- `type: "assistant"` events may not always include `message.usage` — need fallback ✅ handled via `lastTurnUsage || lastUsage`
- Non-streaming path (`send()` without onProgress) doesn't get per-turn data — but it's only used for `/compact`, not for context tracking ✅ confirmed

## Criteria

### Bug 1: Project Registry
- [x] ISC-1: `config/projects.json` contains all 6 projects from project registry
- [x] ISC-2: Each project entry has correct name, displayName, git URL, and paths
- [x] ISC-3: Projects with no VPS path have `paths.vps: null`
- [x] ISC-4: `/projects` lists all active projects on Telegram

### Bug 2: Context % Calculation
- [x] ISC-5: `processStreamEvent` extracts `message.usage` from `type: "assistant"` events
- [x] ISC-6: Last assistant event's usage stored separately from accumulated result usage
- [x] ISC-7: `sendStreaming` returns `lastTurnUsage` field in ClaudeResponse
- [x] ISC-8: `ClaudeResponse` interface includes optional `lastTurnUsage` field
- [x] ISC-9: `ModeManager.recordMessage()` accepts and stores `lastTurnUsage`
- [x] ISC-10: `getContextPercent()` uses `lastTurnUsage` when available, falls back to `usage`
- [x] ISC-11: Context % stays ≤100 for normal resumed sessions (min cap at 99)
- [x] ISC-12: Fallback to result `usage` when no assistant usage available

### Bug 3: /start Command
- [x] ISC-13: `/start` shows `/wrapup` without "(workspace)" qualifier
- [x] ISC-14: `/start` command list doesn't reference CLAUDE.local.md
- [x] ISC-15: `/start` shows `/help` in command list

### Bug 4: /help Command
- [x] ISC-16: `/help` with no args shows grouped command overview
- [x] ISC-17: `/help <command>` shows detailed help for specific command
- [x] ISC-18: `/help wrapup` describes two-file system (MEMORY.md + CLAUDE.md)
- [x] ISC-19: `/help` registered before catch-all message handler
- [x] ISC-20: Unrecognized `/help <cmd>` shows "unknown command" + available list

### Anti-Criteria
- [x] ISC-A1: Context % never displays >100% (capped at 99)
- [x] ISC-A2: `/help` output never mentions CLAUDE.local.md (grep: 0 matches)
- [x] ISC-A3: No changes to quickShot or pipeline paths
- [x] ISC-A4: No changes to non-streaming `send()` path usage handling

## Decisions

- Context % uses `lastTurnUsage` (from `type: "assistant"` events) rather than accumulated `usage` (from `type: "result"` event). This gives the actual context window fill per API call, not the total consumed across agentic tool-use loops.
- Cap context % at 99 via `Math.min()` as safety net.
- Project git URLs use HTTPS (not SSH) to match VPS's PAT authentication.
- Projects with no VPS path use `autoClone: true` — system auto-clones on first `/project` switch.

## Verification

- `bunx tsc --noEmit` passes clean
- 6 projects in registry confirmed via JSON parse
- No CLAUDE.local.md references in telegram.ts (grep: 0 matches)
- `/help` command registered at line 148 (before catch-all handler)
- lastTurnUsage chain: claude.ts:388 → claude.ts:316 → telegram.ts:1152 → mode.ts:53 → mode.ts:87
