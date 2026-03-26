# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

PAI cloud assistant ("Isidore Cloud") on a VPS for 24/7 mobile access. Currently uses a custom Telegram bridge; migrating to Claude Channels as primary access surface (see `Plans/phase-fg-channels-remote-control.md`). Runs alongside Gregor/OpenClaw on the same server.

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

# Backup memory.db + bridge.env (WAL checkpoint, 7-day rotation)
bash scripts/backup.sh
# Cron: 0 3 * * * /home/isidore_cloud/projects/my-pai-cloud-solution/scripts/backup.sh
```

```bash
# Run tests (384 tests across 30 files)
bun test

# Pre-commit verification (type check + tests + Codex review)
bash scripts/review-and-fix.sh

# Type check
npx tsc --noEmit

# Review a cloud/* branch (local, via Codex CLI)
bash scripts/review-cloud.sh cloud/<branch-name>

# Install pre-push hook on VPS (blocks direct pushes to main)
bash scripts/install-vps-hook.sh
```

### Two-Layer Review Workflow

**Layer 1 (local, before commit):**
1. Make changes
2. `npx tsc --noEmit` + `bun test`
3. `codex review --base HEAD` on the diff
4. Fix findings
5. Commit + push to `cloud/` branch

**Layer 2 (GitHub, after push):**
6. PR created → Codex bot auto-reviews on GitHub
7. Fix any new findings, push again
8. `/merge` when clean

## Architecture

### Dual-Mode System

The bridge operates in two modes, managed by `ModeManager`:

- **Workspace Mode** (default): The agent's "home" — autonomous operations, agent-to-agent interactions, scheduled tasks, daily memory. Auto-session management with wrapup on context pressure.
- **Project Mode**: Focused work on a git-tracked repo. Invoked via `/project`. Manual session management. Syncs with local Claude Code instance.

Every Telegram reply includes a **statusline** showing current mode, time, message count, context %, and episode count.

### Core Message Flow (Telegram)

```
Telegram message → Grammy bot (telegram.ts)
  → bot.catch (global error handler — prevents unhandled crashes)
  → Auth middleware (checks Telegram user ID)
  → ClaudeInvoker.send() (claude.ts)
    → Bun.spawn: claude [--resume <session-id>] -p "message" --output-format stream-json
    → Parse JSON, save session ID for next message
  → compactFormat() (format.ts) — strips PAI Algorithm verbosity
  → chunkMessage() — splits at 4000 chars for Telegram API
  → Append statusline (mode/time/msg count/context%)
  → safeReply() — Markdown with parse-error-only fallback to plain text
  → Reply to user
  → ModeManager.recordMessage() — track session metrics
  → Auto-wrapup check (suggest-only at 70% context fill, both modes)
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
- **Auto-wrapup:** ModeManager tracks real context fill via CLI usage data. Suggests wrapup at 70% (both modes), never force-rotates. `/keep` dismisses suggestion.
- **One-shot pipeline:** Pipeline tasks from Gregor do NOT share Marius's session. Each gets a fresh Claude context.
- **PAI hooks:** 16 hooks enabled on VPS (security, context loading, ratings, PRD sync, learnings). 7 disabled (Kitty terminal, voice). See `.ai/guides/bridge-mechanics.md`.
- **Atomic writes:** Pipeline results use write-to-tmp + rename to prevent reading partial files.
- **Zod validation:** All cross-agent JSON boundaries validated via Zod schemas. Config env vars validated with range checks.
- **Mandatory dashboard auth:** `DASHBOARD_TOKEN` is required when `DASHBOARD_ENABLED=1`. Bridge refuses to start without it. Gateway routes (`/api/send`) run injection scan and block high-risk prompts with 403. Concurrency capped at 2 simultaneous sends.
- **Feature flags:** All major subsystems gated behind env vars (default: off). Enables incremental rollout. S1: `DAG_ENABLED`, `MCP_*_ENABLED`, `LOOP_DETECTION_ENABLED`. S2: `A2A_ENABLED` (requires dashboard), `BRIDGE_CONTEXT_INJECTION`. S3: `PLAYBOOK_ENABLED`, `WORKTREE_ENABLED`, `CONTEXT_COMPRESSION_ENABLED`. S4: `GUARDRAILS_ENABLED`, `A2A_CLIENT_ENABLED`, `GROUP_CHAT_ENABLED`, `GROUP_CHAT_MAX_AGENTS`.

### Module Responsibilities

See `ARCHITECTURE.md` for full file reference (30+ modules). Entry points:

- **`bridge.ts`** — wires everything together, graceful shutdown
- **`telegram.ts`** — Grammy bot: commands, message forwarding, statusline, auto-wrapup, `bot.catch`, `safeReply`
- **`claude.ts`** — `ClaudeInvoker`: spawns CLI, stream-json parsing, importance scoring, `streamError` capture
- **`memory.ts`** — `MemoryStore`: SQLite episodic + semantic memory, FTS5, whiteboards
- **`context.ts`** — `ContextBuilder`: scored retrieval, topic tracking, budget injection
- **`pipeline.ts`** — `PipelineWatcher`: polls tasks/, Zod validation, concurrent dispatch
- **`github.ts`** — GitHub PR operations via `gh` CLI: create/reuse PR, upsert review comment, merge PR
- **`config.ts`** — Zod-validated env vars with range checks, feature flags
- **`message-classifier.ts`** — Routes messages to direct API (Sonnet) or CLI (Opus) based on complexity
- **`direct-api.ts`** — Lightweight Anthropic API client via `Bun.fetch()` (Graduated Extraction Phase 1)
- **`review-learning.ts`** — Parses Codex P0-P3 findings, stores as knowledge entries in memory.db
- **`health-monitor.ts`** — `HealthMonitor`: periodic subsystem checks, Telegram delivery tracking, `/health` + `/diag` commands
- **`types.ts`** — `BridgeContext` bag (replaces positional constructor args) + `Plugin` interface (type-only)
- **`summary-dag.ts`** — `SummaryDAG`: hierarchical DAG summaries over episodes, fresh-tail protection, FTS5 UPDATE trigger
- **`summarizer.ts`** — `Summarizer`: three-tier fallback (normal→aggressive→deterministic) with two-phase tool-arg truncation
- **`loop-detection.ts`** — `LoopDetector`: per-session tool-call hashing, 3-phase escalation (warn→instruct→hard stop), Map-based LRU
- **`turn-recovery.ts`** — `RecoveryPolicy`: unified error classification + retry logic for all ClaudeInvoker paths (6 categories: auth, quota, transient, empty, stale_session, hook_failure)
- **`a2a-server.ts`** — `A2AServer`: JSON-RPC 2.0 agent-to-agent server mounted on Dashboard. Agent card (public), message/send, message/stream (auth required, session-isolated via oneShot)
- **`playbook.ts`** — `PlaybookRunner`: parse markdown checkboxes, execute via oneShot, GAN evaluator pattern (separate QA oneShot per step, retry on failure)
- **`worktree-pool.ts`** — `WorktreePool`: acquire/release git worktrees, sprint contract validation, stale cleanup, injectable gitRunner
- **`context-compressor.ts`** — `ContextCompressor`: three-pass compression (consolidate→extract knowledge→prune), multi-pass support, DAG integration
- **`guardrails.ts`** — `Guardrails`: pre-execution authorization gate for bridge-owned operations (pipeline, oneShot, playbooks). Allowlist/denylist with regex matching and context filtering
- **`a2a-client.ts`** — `A2AClient`: outbound A2A protocol client. Discovers agents via agent card, sends messages via JSON-RPC 2.0
- **`group-chat.ts`** — `GroupChatEngine`: multi-agent group chat with moderator synthesis. Dispatches to N agents in parallel, records with channel isolation
- **`qr-generator.ts`** — QR code generation for mobile dashboard access (data URL output)
- **`src/hooks/`** — Claude Code hooks for VPS: `memory-query.ts` (shared FTS5 query lib), `user-prompt-submit.ts`, `post-tool-use.ts`, `session-start.ts`
- **`src/mcp/`** — MCP servers: `pai-memory-server.ts` (8 tools), `pai-context-server.ts` (2 tools), `memory-tools.ts`, `context-tools.ts`, `shared.ts`
- **`src/__tests__/`** — 384 tests across 30 files

## Cross-Instance Continuity

Cloud Isidore uses `memory.db` (via ContextBuilder) as its primary persistence layer — episodic and semantic memory, project state, and session summaries. ContextBuilder injects relevant context into each Claude invocation with importance-based scoring. In project mode, `/wrapup` writes MEMORY.md (session continuity + operational knowledge) and CLAUDE.md (architecture hygiene) via quickShot synthesis — two-file system, no CLAUDE.local.md. Context % tracks actual window fill via `lastTurnUsage` from the last CLI assistant event (not accumulated usage). Daily memory files written to `~/workspace/memory/YYYY-MM-DD.md` by cron.

## Telegram Commands

- **Mode:** `/workspace` (`/home`), `/project <name>`, `/wrapup`, `/keep`, `/start`, `/status`, `/help`
- **Session:** `/clear` (summary + reset), `/compact`, `/verbose` (light/raw output), `/new`, `/oneshot`, `/quick`
- **Git:** `/sync` (commit+push), `/pull`, `/review` (Codex branch review), `/merge` (merge cloud/* to main)
- **Pipeline:** `/delegate`, `/workflow create`, `/workflows`, `/cancel`, `/branches`, `/pipeline`, `/group_chat`
- **Admin:** `/deploy` (self-deploy from Telegram), `/schedule`, `/newproject`, `/deleteproject`, `/reauth`
- **Gateway:** `POST /api/send` (invoke Claude via HTTP), `GET /api/session`, `GET /api/status`, `GET /api/health-monitor` -- all on dashboard port (:3456), require `DASHBOARD_TOKEN` bearer auth

## Git Workflow (MANDATORY)

- **Never push to `main` directly.** A pre-push hook blocks it.
- **Always create a `cloud/<description>` branch** for your changes.
- **PR-based flow:** `/sync` pushes and creates a GitHub PR automatically. Codex review is posted as a PR comment. If `CODEX_AUTOFIX=1`, review findings are auto-fixed via `codex exec --full-auto`. `/merge` merges the PR via `gh pr merge`, syncs local main, and cleans up the branch.
- **Manual fallback:** `git checkout -b cloud/<description>` → commit → `git push -u origin cloud/<description>` → tell Marius.
- Marius can also review via Codex CLI (`scripts/review-cloud.sh`) or GitHub PR comments.

## Conventions

- **Runtime:** Bun + TypeScript, no compilation step. Bun runs `.ts` directly.
- **Commit messages:** Clear "why", prefixed by area when helpful (e.g., `fix:`, `feat:`, `docs:`)
- **File naming:** kebab-case
- **Paths:** `paths.local` and `paths.vps` in project registry accept `string | null` for cloud-only or local-only projects
- **Knowledge base:** `.ai/guides/` — referenceable technical docs. Guides: `bridge-mechanics.md`, `design-decisions.md`, `memory-architecture-comparison.md`, `tdd-review-workflow.md`, `channels-maestro-evolution.md`
- **Plans:** `Plans/` — implementation plans. Active: `pai-evolution-master-plan.md` (v4, Sessions 1-4 complete), `phase-fg-channels-remote-control.md` (v2.1, Channels + Remote Control migration)

## VPS Details

- **IP:** 213.199.32.18
- **SSH alias:** `isidore_cloud` (isidore_cloud user), `vps` (openclaw user)
- **Linux user:** `isidore_cloud`
- **Project dir:** `/home/isidore_cloud/projects/my-pai-cloud-solution/`
- **Config:** `/home/isidore_cloud/.config/isidore_cloud/bridge.env`
- **Pipeline:** `/var/lib/pai-pipeline/{tasks,results,ack,reverse-tasks,reverse-results,reverse-ack,workflows}` — shared via `pai` group (setgid 2770)
- **Workspace:** `/home/isidore_cloud/workspace/` — daily memory files, git-tracked
- **Services:** `isidore-cloud-bridge` (Telegram + pipeline + orchestrator — PRIMARY), `isidore-cloud-remote` (Remote Control server mode — SUPPLEMENTARY, pending trust), `isidore-cloud-channels` (Claude Channels Telegram plugin — SUPPLEMENTARY, pending bot token), `isidore-cloud-tmux` (persistent tmux)
