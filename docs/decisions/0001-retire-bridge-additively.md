---
summary: "ADR-0001: retire the Telegram bridge via 4-move additive hook migration, gated on Channels stability"
read_when: ["ADR", "bridge retirement", "architecture decision", "phase 5", "channels", "hooks"]
---

# ADR-0001: Retire the Telegram bridge additively, not in one pass

- **Status:** Accepted
- **Date:** 2026-04-18
- **Context document:** `MEMORY/WORK/20260418-104310_research-bridge-to-native-patterns/research-report.md`

## Context

Isidore Cloud runs a 6,600-LOC Grammy-based Telegram bridge (`src/bridge.ts` + `src/telegram.ts`) that wraps `claude -p` invocations and provides commands, memory, pipeline, dashboard, and scheduler. Claude Channels has shipped as a native Telegram plugin and has been running alongside the bridge since 2026-03-26. The original Phase 5 plan (tracked as beads `my-pai-cloud-solution-bng`) called for a 2–3 week parallel run followed by bridge retirement.

Deep research (9 parallel agents, 2026-04-18) surfaced two facts that change the plan:

1. **The bridge is substrate, not scaffolding.** `ModeManager`, `HealthMonitor`, `MessageClassifier`, guardrails, and the gateway injection-scan have no clean native equivalents. Retiring them by deletion would silently lose functionality.
2. **Claude Channels has open bugs that directly block retirement.** Most critical: [anthropics/claude-code#36477](https://github.com/anthropics/claude-code/issues/36477) — "Channels stops after first reply, no workaround."

## Decision

Retire the bridge through a 4-move additive migration. Do NOT delete bridge code until an explicit decision gate passes.

| # | Move | Action | Gating |
|---|------|--------|--------|
| 1 | Turn-recording Stop hook | New `src/hooks/stop.ts` writing to `memory.db` | None — ship first |
| 2 | `notify.sh` + systemd timers | New `scripts/notify.sh`, new `deploy/systemd/isidore-cloud-notify@.{service,timer}.example` | Depends on Move 1 for verification parity |
| 3 | Importance-scoring hook (Haiku) | New `src/hooks/importance-scorer.ts`, decoupled rescoring pass | Depends on Move 1 |
| 4 | Grammy shutdown | Set `TELEGRAM_BOT_TOKEN=""`, two-week fallback, then `systemctl disable --now isidore-cloud-bridge` | Depends on Moves 1–3 AND upstream fix for #36477 AND 0% message-drop during 7-day parallel run |

## Alternatives considered

1. **Big-bang retirement (original plan).** Rejected: Channels bugs would cause silent message loss; no rollback path once bridge code is removed.
2. **Keep the bridge forever.** Rejected: duplicated state between bridge and Channels causes drift; maintenance of two surfaces doubles the on-call surface area.
3. **Rewrite the bridge as a thin wrapper around Channels.** Rejected: adds complexity without removing code. The hook migration achieves the same end-state with less scaffolding.
4. **Abandon Channels, go bridge-only.** Rejected: Channels + Remote Control are real mobile-first wins the bridge cannot provide, and Anthropic is actively investing in them.

## Consequences

Positive:
- Each move is independently reversible
- Hooks run in BOTH bridge and Channels sessions — no functionality loss during parallel run
- Anthropic bug fixes land without blocking our timeline
- Clean final state: Claude Code + Channels + 5 hooks + 6 skills + 4 standalone services

Negative:
- Statusline, `compactFormat`, and `MessageClassifier` are consciously lost (documented in `docs/roadmap.md`)
- Move 4 timing is out of our control (tied to upstream issue resolution)
- Adds 2 new hooks to maintain on top of existing 3

Neutral:
- SQLite schema stays unchanged — the Stop hook writes to the same `episodes` table the bridge has been writing to
- Bridge code stays in-tree until Move 4 tag (`pre-bridge-retirement`), so git history preserves the full story

## Follow-ups tracked in beads

- `my-pai-cloud-solution-25x` — Move 1 (Stop hook)
- `my-pai-cloud-solution-679` — Move 2 (notify.sh + systemd)
- `my-pai-cloud-solution-9xj` — Move 3 (Haiku scorer)
- `my-pai-cloud-solution-rtz` — Move 4 (Grammy shutdown, gated)
