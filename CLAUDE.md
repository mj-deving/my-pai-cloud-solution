# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Telegram bridge + cross-user pipeline that deploys a PAI assistant ("Isidore Cloud") to a VPS for 24/7 mobile access. Runs alongside Gregor/OpenClaw on the same server.

**Owner:** Marius
**GitHub:** [mj-deving/my-pai-cloud-solution](https://github.com/mj-deving/my-pai-cloud-solution)

## Build & Run Commands

```bash
# Install dependencies
bun install

# Type check (no emit — Bun runs TypeScript directly)
bunx tsc --noEmit

# Verify compilation (alternative — Bun's bundler)
bun build src/bridge.ts --no-bundle

# Run locally (needs TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOWED_USER_ID env vars)
bun run src/bridge.ts

# Deploy to VPS (rsync + bun install + restart service)
bash scripts/deploy.sh

# Restart bridge on VPS after deploy
ssh isidore_cloud 'sudo systemctl restart isidore-cloud-bridge'

# View live bridge logs
ssh isidore_cloud 'sudo journalctl -u isidore-cloud-bridge -f'
```

No test suite exists. Verify changes by deploying and testing via Telegram commands or pipeline task files.

## Architecture

### Dual-Mode System

The bridge operates in two modes, managed by `ModeManager`:

- **Workspace Mode** (default): The agent's "home" — autonomous operations, agent-to-agent interactions, scheduled tasks, daily memory. Auto-session management with wrapup on context pressure.
- **Project Mode**: Focused work on a git-tracked repo. Invoked via `/project`. Manual session management. Syncs with local Claude Code instance.

Every Telegram reply includes a **statusline** showing current mode, time, message count, context %, and episode count.

### Core Message Flow (Telegram)

```
Telegram message → Grammy bot (telegram.ts)
  → Auth middleware (checks Telegram user ID)
  → ClaudeInvoker.send() (claude.ts)
    → Bun.spawn: claude [--resume <session-id>] -p "message" --output-format json
    → Parse JSON, save session ID for next message
  → compactFormat() (format.ts) — strips PAI Algorithm verbosity
  → chunkMessage() — splits at 4000 chars for Telegram API
  → Append statusline (mode/time/msg count/context%)
  → Reply to user
  → ModeManager.recordMessage() — track session metrics
  → Auto-wrapup check (workspace mode: warns at 80%, rotates at threshold)
  → Importance-triggered synthesis flush (workspace mode)
  → (no auto-commit — use /sync on demand)
```

### Cross-User Pipeline & Orchestrator

See `ARCHITECTURE.md` for detailed flow diagrams. Summary:

- **Forward pipeline:** Gregor writes JSON tasks → `PipelineWatcher` polls, dispatches one-shot Claude, writes results atomically
- **Reverse pipeline:** `/delegate` or orchestrator → writes to reverse-tasks/ → Gregor executes → result routed back
- **Orchestrator:** `/workflow create` → Claude decomposes into DAG steps → parallel dispatch to Isidore (local) or Gregor (reverse pipeline)

### Key Design Decisions

See `.ai/guides/design-decisions.md` for full phase-by-phase details. Core decisions:

- **Session sharing:** All channels share one session ID file. `claude --resume` continues the same conversation. Per-project sessions via `ProjectManager`. Workspace has its own session stored in memory.db.
- **Dual-mode:** Workspace mode (default) for autonomous/general work with auto-session management. Project mode for focused git-repo work with manual session control.
- **Auto-wrapup:** In workspace mode, ModeManager tracks token/message counts. Warns at 80% threshold, rotates session at 100%. `/keep` extends by 50%.
- **One-shot pipeline:** Pipeline tasks from Gregor do NOT share Marius's session. Each gets a fresh Claude context.
- **Hook suppression:** Bridge sets `SKIP_KNOWLEDGE_SYNC=1` to prevent hooks firing on every `claude -p`.
- **Atomic writes:** Pipeline results use write-to-tmp + rename to prevent reading partial files.
- **Zod validation:** All cross-agent JSON boundaries validated via Zod schemas. Config env vars validated with range checks.
- **Feature flags:** All major subsystems gated behind env vars (default: off). Enables incremental rollout.

### Module Responsibilities

See `ARCHITECTURE.md` for full file reference (30+ modules). Entry points:

- **`bridge.ts`** — wires everything together, graceful shutdown
- **`telegram.ts`** — Grammy bot: commands, message forwarding, statusline, auto-wrapup
- **`claude.ts`** — `ClaudeInvoker`: spawns CLI, stream-json parsing, importance scoring
- **`memory.ts`** — `MemoryStore`: SQLite episodic + semantic memory, FTS5, whiteboards
- **`context.ts`** — `ContextBuilder`: scored retrieval, topic tracking, budget injection
- **`pipeline.ts`** — `PipelineWatcher`: polls tasks/, Zod validation, concurrent dispatch
- **`config.ts`** — Zod-validated env vars with range checks, feature flags

## Cross-Instance Continuity

Cloud Isidore uses `memory.db` (via ContextBuilder) as its sole persistence layer. There is no file-based handoff mechanism — `memory.db` stores episodic and semantic memory, project state (active project, sessions map), and session summaries. ContextBuilder injects relevant context into each Claude invocation with importance-based scoring. Session summaries are generated on `/clear`, `/wrapup`, and bridge shutdown for cross-session continuity. Daily memory files are written to `~/workspace/memory/YYYY-MM-DD.md` by cron.

## Telegram Commands

- **Mode:** `/workspace` (`/home`), `/project <name>`, `/wrapup`, `/keep`, `/start`, `/status`
- **Session:** `/clear` (summary + reset), `/compact`, `/new`, `/oneshot`, `/quick`
- **Git:** `/sync` (commit+push), `/pull`
- **Pipeline:** `/delegate`, `/workflow create`, `/workflows`, `/cancel`, `/branches`, `/pipeline`
- **Admin:** `/schedule`, `/newproject`, `/deleteproject`

## Conventions

- **Runtime:** Bun + TypeScript, no compilation step. Bun runs `.ts` directly.
- **Commit messages:** Clear "why", prefixed by area when helpful (e.g., `fix:`, `feat:`, `docs:`)
- **File naming:** kebab-case
- **Paths:** `paths.local` and `paths.vps` in project registry accept `string | null` for cloud-only or local-only projects
- **deploy.sh excludes:** `CLAUDE.local.md` is never overwritten on VPS — each instance keeps its own identity file

## VPS Details

- **IP:** 213.199.32.18
- **SSH alias:** `isidore_cloud` (isidore_cloud user), `vps` (openclaw user)
- **Linux user:** `isidore_cloud`
- **Project dir:** `/home/isidore_cloud/projects/my-pai-cloud-solution/`
- **Config:** `/home/isidore_cloud/.config/isidore_cloud/bridge.env`
- **Pipeline:** `/var/lib/pai-pipeline/{tasks,results,ack,reverse-tasks,reverse-results,reverse-ack,workflows}` — shared via `pai` group (setgid 2770)
- **Workspace:** `/home/isidore_cloud/workspace/` — daily memory files, git-tracked
- **Services:** `isidore-cloud-bridge` (Telegram + pipeline + orchestrator), `isidore-cloud-tmux` (persistent tmux)
