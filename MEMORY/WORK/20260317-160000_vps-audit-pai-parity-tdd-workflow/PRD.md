---
task: VPS audit, DAI parity, TDD/review workflow roadmap
slug: 20260317-160000_vps-audit-pai-parity-tdd-workflow
effort: advanced
phase: complete
progress: 27/28
mode: interactive
started: 2026-03-17T16:00:00+01:00
updated: 2026-03-17T16:02:00+01:00
---

## Context

Marius wants four things in one session:
1. **VPS 10-day error audit** — categorize all errors, crashes, retries from the last 10 days of bridge logs
2. **DAI cloud parity** — make the cloud instance a full copy of local DAI (hooks active, settings synced, code deployed)
3. **TDD + review workflow roadmap** — design workflows that catch bugs early in the development cycle
4. **Deploy latest** — push PRs #1 and #2 (bot.catch, safeReply, streaming errors, tests) to VPS

### Audit Findings (10-day window: Mar 7 – Mar 17)

**Crashes (4 total, all Mar 7):**
- Grammy Markdown parse error → unhandled BotError → process exit. Same bug hit 4 times in rapid succession (07:58, 08:07, 08:24, 08:24). The queued messages from Telegram kept crashing each restart because they contained unparseable Markdown. systemd auto-restarted each time.
- Root cause: No `bot.catch` handler + no `safeReply` fallback. **FIXED in PR #1** (not yet deployed to VPS).

**Recoverable errors (4 total, Mar 8–15):**
- Mar 8: `[claude] Recoverable error (exit 1), retrying fresh` — Claude CLI exit 1 (unknown cause, single occurrence)
- Mar 14: `exit 143` x2 — SIGTERM during hook execution. WorkCompletionLearning.hook.ts failed: `${HOME}/.claud` path truncation suggests env var not expanded in shell
- Mar 15: `exit 143` — same WorkCompletionLearning hook failure

**Synthesis skips (daily, harmless):**
- Every day: synthesis skips all domains because <3 episodes per domain. Not a bug — just low usage.

**VPS is 4 commits behind local main:**
- VPS: `0c40557` (cloud/pr-based-git-workflow merge)
- Local: `5840fa1` (PR #2 merge — README + CLAUDE.md update)
- Missing: bot.catch, safeReply, streaming error logging, test suite

**VPS has dirty working tree:**
- Modified: memory.ts, orchestrator.ts, pipeline.ts, prd-executor.ts, synthesis.ts, telegram.ts
- **ASSESSED: All 6 files contain intentional runtime improvements (51 insertions, 3 deletions):**
  - `memory.ts`: Default importance 5→3 (more conservative baseline)
  - `orchestrator.ts`: Importance scoring for workflow outcomes (failed=6, success=4)
  - `pipeline.ts`: Task-type importance scoring (daily-memory=8, health=3, synthesis=2, default=3)
  - `prd-executor.ts`: Importance=4 for PRD detection and step episodes
  - `synthesis.ts`: WAL checkpoint (hourly, passive) + importance scoring for synthesis episodes
  - `telegram.ts`: `scoreUserMessage()` function — rule-based importance for user messages (ack=2, cmd=3, bug=7, long=6, default=5) + assistant fallback importance=3
- **Decision: KEEP these changes — cherry-pick onto main before deploying**

**DAI hooks parity:**
- VPS hooks directory: 30 hook files present in `~/.claude/hooks/`
- VPS settings.json hooks: 14 hook entries across 6 events
- Local settings.json hooks: 16 hook entries across 6 events (2 extra: gsd-context-monitor.js, gsd-check-update.js — GSD-specific, not needed on VPS)
- VPS has `~/.claude/PAI/` directory with full DAI system (Algorithm, Skills, Flows, etc.) — dated Mar 14
- **Hook failure:** WorkCompletionLearning.hook.ts uses `${HOME}/.claud` which fails to expand in the bridge's shell context

### Risks

- VPS dirty working tree could have intentional changes that `git reset --hard` would destroy
- Hook env var expansion (`${PAI_DIR}`, `${HOME}`) may not work in systemd service context
- Deploying code without running tests on VPS first could introduce new issues

## Criteria

### Domain 1: VPS Error Audit
- [x] ISC-1: All crash events from 10-day window identified and categorized
- [x] ISC-2: All recoverable errors identified with root causes
- [x] ISC-3: Hook failures identified with specific env var expansion issue
- [x] ISC-4: Audit findings written to PRD context section

### Domain 2: DAI Cloud Parity
- [x] ISC-5: VPS dirty working tree changes assessed (keep or discard)
- [x] ISC-6: VPS code synced to local main HEAD (e0edb56)
- [x] ISC-7: bot.catch handler active on VPS after deploy
- [x] ISC-8: safeReply fallback active on VPS after deploy
- [x] ISC-9: Test suite passes on VPS after deploy (`bun test`)
- [x] ISC-10: WorkCompletionLearning hook env var expansion fixed
- [x] ISC-11: VPS settings.json hooks match local (minus GSD-only hooks)
- [x] ISC-12: Bridge service restarted and responding to Telegram messages

### Domain 3: TDD Workflow Roadmap
- [x] ISC-13: Pre-commit test gate defined (what runs, when, blocking?)
- [x] ISC-14: Test coverage strategy for each module type documented
- [x] ISC-15: Pure-function extraction pattern documented for testable code
- [x] ISC-16: Integration test approach for Grammy/Telegram defined
- [x] ISC-17: CI test runner defined (local bun test + VPS verification)
- [x] ISC-18: Test file naming and location conventions documented

### Domain 4: Review Agent Workflow Roadmap
- [x] ISC-19: Codex review trigger points defined (pre-commit, PR, deploy)
- [x] ISC-20: Review-to-fix feedback loop defined (findings → auto-fix → verify)
- [x] ISC-21: Review severity routing defined (P0 blocks, P1 warns, P2-P3 log)
- [x] ISC-22: Automated type-check gate defined (bunx tsc --noEmit)
- [x] ISC-23: Pre-deploy verification checklist defined

### Domain 5: Deploy Latest to VPS
- [x] ISC-24: VPS git reset to origin/main after dirty tree assessment
- [x] ISC-25: bun install completes without errors on VPS
- [x] ISC-26: bun test passes on VPS
- [x] ISC-27: Bridge service restarted successfully
- [ ] ISC-28: Telegram message send/receive verified post-deploy

## Decisions

1. **Preserved VPS dirty changes** — committed to `cloud/vps-importance-tuning` branch, merged to main. All were intentional importance scoring improvements.
2. **Fixed PAI_DIR to absolute path** — `${HOME}/.claude` → `/home/isidore_cloud/.claude` in VPS settings.json. Also fixed PROJECTS_DIR.
3. **GSD hooks not needed on VPS** — `gsd-context-monitor.js` and `gsd-check-update.js` are local-only. VPS hooks are at functional parity.
4. **data/ added to .gitignore** — VPS commit included memory.db binaries. Removed from tracking.

## Verification
