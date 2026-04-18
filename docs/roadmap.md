---
summary: "Isidore Cloud roadmap — 4-move additive bridge-to-native migration plan with per-move status"
read_when: ["roadmap", "bridge retirement", "phase 5", "move 1", "move 2", "move 3", "move 4", "channels migration"]
---

# Isidore Cloud — Roadmap

> Bridge-to-native migration. Updated 2026-04-18 based on research synthesis at
> `MEMORY/WORK/20260418-104310_research-bridge-to-native-patterns/research-report.md`.

## Where we are (2026-04-18)

All 5 VPS services are live. Phases 1–4 and 6 from the original channels-migration plan are complete. Phase 5 (bridge retirement) has been refreshed into a 4-move additive migration.

| # | Component | Status |
|---|-----------|--------|
| 1 | `isidore-cloud-bridge` — Grammy Telegram bot + dashboard + scheduler | ACTIVE (primary surface) |
| 2 | `isidore-cloud-channels` — Claude Code with `--channels plugin:telegram@claude-plugins-official` | ACTIVE (supplementary) |
| 3 | `isidore-cloud-pipeline` — standalone pipeline watcher | ACTIVE |
| 4 | `isidore-cloud-dashboard` — extracted dashboard | ACTIVE |
| 5 | `isidore-cloud-remote` — Claude Remote Control server mode | ACTIVE |
| 6 | PAI hooks (`user-prompt-submit`, `post-tool-use`, `session-start`, `stop` NEW) | 3 deployed, Stop hook ready to register |
| 7 | MCP servers (`pai-memory`, `pai-context`) | ACTIVE |
| 8 | Project skills (`/sync`, `/wrapup`, `/deploy`, `/review`, `/newproject`, `/group_chat`) | SHIPPED (Phase 2) |

## The 4-move bridge retirement plan

**Goal:** migrate the bridge's unique value out into native Claude Code hooks + skills + standalone daemons, then shut Grammy down — but only once the Channels plugin is stable enough (tracked by Anthropic issue [#36477](https://github.com/anthropics/claude-code/issues/36477)).

Beads ticket: `my-pai-cloud-solution-bng` (parent). Sub-tickets: `25x` (Move 1), `679` (Move 2), `9xj` (Move 3), `rtz` (Move 4, gated).

### Move 1 — Turn-recording Stop hook [`my-pai-cloud-solution-25x`, IN PROGRESS]

Stop hook writes completed turns to `memory.db` so Channels + native sessions record conversations the same way the bridge's `ClaudeInvoker.recordTurn()` did.

**Artefacts landed:**
- `src/hooks/stop.ts` — hook entry point + pure functions (`parseStopInput`, `extractLastTurn`, `scoreTurnImportance`, `writeTurnEpisode`)
- `src/__tests__/stop-hook.test.ts` — 17 unit tests, all green
- Reentrancy guard (`stop_hook_active`) prevents the infinite-loop footgun
- Heuristic importance score inline (upgraded in Move 3)

**Pattern source:** [`codenamev/claude_memory`](https://github.com/codenamev/claude_memory) schema and the [Anthropic harness-design guidance](https://anthropic.com/engineering/effective-harnesses-for-long-running-agents) on file-based handoff.

**Remaining to ship:**
- Register hook in global `~/.claude/settings.json` under `hooks.Stop`
- Deploy to VPS via `scripts/deploy.sh`
- Shadow-run 7 days: compare new episodes against `ClaudeInvoker.recordTurn` output

### Move 2 — `notify.sh` + systemd timers [`my-pai-cloud-solution-679`, READY]

Replace the bridge-owned `Scheduler` (`src/scheduler.ts`) with systemd timers calling `scripts/notify.sh`.

**Artefacts landed:**
- `scripts/notify.sh` — minimal Telegram Bot API push wrapper (30 LOC)
- `deploy/systemd/isidore-cloud-notify@.service.example` — templated oneshot unit
- `deploy/systemd/isidore-cloud-notify@.timer.example` — templated timer (default daily 08:00)
- Runbook: `docs/runbooks/scheduler-to-systemd.md`

**Remaining to ship:**
- Inventory current schedules: `bd -p PIPELINE_ENABLED=1 bun -e "…"` against the VPS scheduler DB
- Translate each schedule → `.timer` drop-in + optional `NOTIFY_CMD` env file
- Set `SCHEDULER_ENABLED=0` in `bridge.env` once parity is reached

**Rate-limit note:** Telegram Bot API: 30 msg/sec global, 1 msg/sec per chat, 20 msg/min per group. `notify.sh` does NOT implement backoff — callers must not loop tightly.

### Move 3 — Importance-scoring hook (Haiku, versioned prompt) [`my-pai-cloud-solution-9xj`, SCAFFOLDED]

Post-insert queue processor that rescores episodes using Claude Haiku. Decoupled from the Stop hook so turn latency stays constant.

**Artefacts landed:**
- `src/hooks/importance-scorer.ts` — pure scoring logic with `SCORER_PROMPT_VERSION` constant
- `src/__tests__/importance-scorer.test.ts` — 11 unit tests covering split/build/rescore/idempotency
- Idempotent: skips episodes already stamped with the current scorer version in metadata

**Remaining to ship:**
- `Scorer` adapter that calls Claude Haiku via Anthropic SDK (or `claude -p --model haiku` oneShot fallback)
- Periodic driver: cron or a light daemon that calls `rescoreEpisode(…)` on recent unscored episodes
- Optional: HTTP-decoupled pattern (POST turn payload to local writer) — follow [`disler/claude-code-hooks-multi-agent-observability`](https://github.com/disler/claude-code-hooks-multi-agent-observability) if DB contention appears

### Move 4 — Grammy shutdown [`my-pai-cloud-solution-rtz`, GATED]

**Cannot start until all three gates are green:**

1. Anthropic resolves (or documents workaround for) [channels stops-after-first-reply #36477](https://github.com/anthropics/claude-code/issues/36477)
2. Moves 1–3 stable in parallel run ≥ 7 days
3. Message-drop-rate instrumented at 0% during the parallel run

**Execution:**
1. Set `TELEGRAM_BOT_TOKEN=""` in `bridge.env` → bridge becomes a no-op Grammy loop
2. Keep process for 2 weeks as fallback (pipeline + dashboard already extracted, so these stay up)
3. `sudo systemctl disable --now isidore-cloud-bridge`
4. Archive `src/bridge.ts` + `src/telegram.ts` + remove Grammy deps
5. Tag `pre-bridge-retirement` before deleting any code

## Features we consciously lose

Documented so future-us doesn't mourn them:

- **Statusline** (mode / context% / msg count / episode count) — blocked upstream on [#6227](https://github.com/anthropics/claude-code/issues/6227)
- **`compactFormat`** of Algorithm verbosity — plugin sends raw Claude output
- **`MessageClassifier`** (Sonnet vs Opus routing) — skills pick model explicitly now
- **Bridge-specific slash commands** `/verbose /oneshot /quick /keep /reauth` — mapped to native CLI equivalents in CLAUDE.md Phase 2 notes

## Features preserved (via hooks, not lost)

- Turn recording (Move 1 — Stop hook)
- Importance scoring (Move 3 — decoupled scorer)
- Injection scanning (already a hook — `UserPromptSubmit`)
- Proactive notifications (Move 2 — cron → `notify.sh`)

## References

- Research synthesis: `MEMORY/WORK/20260418-104310_research-bridge-to-native-patterns/research-report.md`
- Decision record: `docs/decisions/0001-retire-bridge-additively.md`
- Runbook for Move 2: `docs/runbooks/scheduler-to-systemd.md`
- Original plan: `Plans/phase-fg-channels-remote-control.md`
- Visual plan: `~/.claude/diagrams/channels-migration-plan.html`
