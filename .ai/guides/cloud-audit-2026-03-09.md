# Cloud Bridge Audit — 2026-03-09

## Retry Pattern Analysis

### Claude CLI exit-1 retries (recurring)
- **Dates observed:** Mar 6 (2x), Mar 8 (1x)
- **Symptom:** `[claude] Recoverable error (exit 1), retrying fresh:` with empty error detail
- **Root cause:** CLI crashes before producing any output. Streaming mode (`--verbose`) routes all to stdout; stderr is empty; accumulatedText is empty because no stream events emitted before crash
- **Code path:** `claude.ts:337-341` — fallback chain `authError → stderr → accumulatedText` all empty
- **Likely trigger:** DAI hook crash on startup (16 hooks enabled) or transient CLI issue
- **Retry behavior:** Single retry only (`!isRetry` guard). Fresh session. Usually succeeds.
- **Fix:** Improve error logging to capture exit code context even when all outputs empty

### GrammyError Markdown crash (Mar 7)
- **Symptom:** `400: Bad Request: can't parse entities: Can't find end of the entity starting at byte offset 45`
- **Root cause:** Help texts contain `[cloud/branch-name]` — `[` starts link syntax in Telegram Markdown v1
- **Compounding factor:** No `bot.catch` global error handler → unhandled error crashes process
- **Affected commands:** `/help review`, `/help merge` (confirmed); potentially any `parse_mode: "Markdown"` reply
- **Fix needed:** (1) Add `bot.catch` handler, (2) wrap all `ctx.reply(..., { parse_mode: "Markdown" })` with try-catch fallback

### Stale session retries (Feb 26)
- **Symptom:** `[pipeline] Bad session 00000000..., retrying fresh`
- **Root cause:** Pipeline tasks using dummy session ID
- **Status:** Working as designed — not a bug

## Missing Testing Infrastructure

### Current state
- Zero test files in repo
- Verification via manual Telegram testing only
- No pre-deploy checks

### Recommended test priorities
1. `src/__tests__/claude.test.ts` — retry logic, error path coverage, streaming parser
2. `src/__tests__/telegram-markdown.test.ts` — all help texts + reply formatting
3. `src/__tests__/format.test.ts` — compactFormat, chunkMessage
4. `scripts/smoke-test.sh` — pre-deploy gate (tsc + import check)
5. Codex-driven test generation via CodexBridge RepoAudit workflow

### Framework
- `bun test` built-in, zero dependencies
- Test files: `src/__tests__/*.test.ts`

## DAI-Customization Repo Additions

### Recommended new workflows
1. `Workflows/TestGeneration.md` — Codex-generated test files
2. `Workflows/PreDeployCheck.md` — safe-mode diff review before deploy
3. `References/ErrorPatterns.md` — known failure pattern library

### Integration improvements
- `/sync` Codex review findings → memory.db semantic entries (learning loop)
- Test coverage audit workflow
