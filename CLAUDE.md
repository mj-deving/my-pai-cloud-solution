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

### Core Message Flow (Telegram)

```
Telegram message → Grammy bot (telegram.ts)
  → Auth middleware (checks Telegram user ID)
  → ClaudeInvoker.send() (claude.ts)
    → Bun.spawn: claude [--resume <session-id>] -p "message" --output-format json
    → Parse JSON, save session ID for next message
  → compactFormat() (format.ts) — strips PAI Algorithm verbosity
  → chunkMessage() — splits at 4000 chars for Telegram API
  → Reply to user
  → lightweightWrapup() (wrapup.ts) — non-blocking git add -u && commit
```

### Cross-User Pipeline Flow (Gregor collaboration)

```
Gregor writes JSON → /var/lib/pai-pipeline/tasks/task.json
  → PipelineWatcher (pipeline.ts) polls every 5s
  → Reads task, resolves cwd (with fallback if project dir missing)
  → Branch isolation: checkout pipeline/<taskId> branch (if enabled)
  → Bun.spawn: claude -p "prompt" --output-format json (one-shot, no session)
  → Writes result atomically (.tmp → rename) to results/
  → Moves task to ack/
  → Branch isolation: release branch, return to main
```

### Reverse Pipeline (Isidore → Gregor delegation)

```
/delegate or orchestrator step (assignee: gregor)
  → ReversePipelineWatcher writes JSON to reverse-tasks/
  → Gregor's side picks up and executes
  → Result written to reverse-results/
  → ReversePipelineWatcher polls, reads result, routes:
    - Workflow step → orchestrator.completeStep()/failStep()
    - Standalone → Telegram notification
```

### Task Orchestrator (DAG workflows)

```
/workflow create "complex task"
  → Claude one-shot decomposes into DAG steps
  → Each step: {id, description, assignee, dependsOn}
  → Orchestrator dispatches ready steps (all deps satisfied)
  → Parallel execution where dependencies allow
  → Isidore steps: local claude oneShot
  → Gregor steps: reverse pipeline delegation
  → Persists to workflows/*.json for crash recovery
```

### Key Design Decisions

- **Session sharing:** All channels (Telegram, SSH/tmux) share one session ID file (`~/.claude/active-session-id`). `claude --resume` continues the same conversation.
- **Per-project sessions:** `ProjectManager` maps each project to its own session ID in `~/.claude/handoff-state.json`. Switching projects saves/restores the session.
- **One-shot pipeline:** Pipeline tasks from Gregor do NOT share Marius's session. Each gets a fresh Claude context.
- **Hook suppression:** Bridge sets `SKIP_KNOWLEDGE_SYNC=1` in Claude's env to prevent hooks from firing on every `claude -p` invocation. Bridge handles sync explicitly via `/project` (pull) and `/done` (push).
- **Auto-commit:** After each Telegram response, `lightweightWrapup()` runs `git add -u && git commit` with a 10-second timeout. Only tracked files — never `git add -A`.
- **Atomic writes:** Pipeline results use write-to-tmp + rename pattern to prevent Gregor from reading partial files.
- **Concurrency pool:** Pipeline processes up to `PIPELINE_MAX_CONCURRENT` tasks simultaneously with per-project locking.
- **Branch isolation:** Pipeline tasks run on `pipeline/<taskId>` branches to prevent contamination of main. Wrapup has a branch guard.
- **DAG orchestrator:** Workflows decomposed via Claude, validated for cycles and referential integrity. Steps dispatched as dependencies resolve.

### Module Responsibilities

| Module | Role |
|--------|------|
| `bridge.ts` | Entry point — wires everything together, graceful shutdown |
| `telegram.ts` | Grammy bot: auth middleware, all `/command` handlers, message forwarding |
| `claude.ts` | `ClaudeInvoker` — spawns CLI, manages timeouts, handles stale session recovery |
| `session.ts` | `SessionManager` — reads/writes/archives the active session ID file |
| `projects.ts` | `ProjectManager` — project registry, handoff state, git sync, project creation |
| `pipeline.ts` | `PipelineWatcher` — polls tasks/, dispatches to Claude, writes results, concurrency pool |
| `reverse-pipeline.ts` | `ReversePipelineWatcher` — Isidore→Gregor delegation via reverse-tasks/results dirs |
| `orchestrator.ts` | `TaskOrchestrator` — DAG workflow decomposition, step dispatch, crash recovery |
| `branch-manager.ts` | `BranchManager` — task-specific branch checkout/release, lock persistence |
| `config.ts` | `loadConfig()` — reads env vars with defaults, validates required fields |
| `format.ts` | `compactFormat()`, `chunkMessage()`, `escMd()` — formatting + Markdown escaping |
| `wrapup.ts` | `lightweightWrapup()` — non-blocking git commit with branch guard |

## Cross-Instance Continuity

If `CLAUDE.handoff.md` exists in this directory, read it on session start. It contains the other instance's (local/Cloud) last session state.

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
- **Services:** `isidore-cloud-bridge` (Telegram + pipeline + orchestrator), `isidore-cloud-tmux` (persistent tmux)
