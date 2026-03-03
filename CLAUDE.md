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
  → (no auto-commit — use /sync on demand)
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

See `.ai/guides/design-decisions.md` for full phase-by-phase details. Core decisions:

- **Session sharing:** All channels share one session ID file. `claude --resume` continues the same conversation. Per-project sessions via `ProjectManager`.
- **One-shot pipeline:** Pipeline tasks from Gregor do NOT share Marius's session. Each gets a fresh Claude context.
- **Hook suppression:** Bridge sets `SKIP_KNOWLEDGE_SYNC=1` to prevent hooks firing on every `claude -p`.
- **Atomic writes:** Pipeline results use write-to-tmp + rename to prevent reading partial files.
- **Zod validation:** All cross-agent JSON boundaries validated via Zod schemas. Config env vars validated with range checks.
- **Feature flags:** All major subsystems gated behind env vars (default: off). Enables incremental rollout.

### Module Responsibilities

| Module | Role |
|--------|------|
| `bridge.ts` | Entry point — wires everything together via `MessengerAdapter`, graceful shutdown |
| `telegram.ts` | Grammy bot: auth middleware, all `/command` handlers, message forwarding |
| `telegram-adapter.ts` | `TelegramAdapter` — wraps `createTelegramBot()` behind `MessengerAdapter` interface |
| `messenger-adapter.ts` | `MessengerAdapter` interface — platform-agnostic messaging contract |
| `claude.ts` | `ClaudeInvoker` — spawns CLI, manages timeouts, handles stale session recovery |
| `session.ts` | `SessionManager` — reads/writes/archives the active session ID file |
| `projects.ts` | `ProjectManager` — project registry, handoff state, git sync, project creation |
| `pipeline.ts` | `PipelineWatcher` — polls tasks/, validates via Zod, dispatches with decision traces + idempotency |
| `reverse-pipeline.ts` | `ReversePipelineWatcher` — Isidore→Gregor delegation via reverse-tasks/results dirs |
| `orchestrator.ts` | `TaskOrchestrator` — DAG workflow decomposition, step dispatch, crash recovery |
| `branch-manager.ts` | `BranchManager` — task-specific branch checkout/release, lock persistence |
| `schemas.ts` | Zod schemas for all external data types + `safeParse`/`strictParse` helpers |
| `decision-trace.ts` | `TraceCollector` — structured decision logging at pipeline/orchestrator decision points |
| `agent-message.ts` | `AgentMessage` envelope type + mapping functions for inter-agent transport |
| `idempotency.ts` | `IdempotencyStore` — SQLite-backed duplicate task detection (sha256 op_id) |
| `agent-registry.ts` | `AgentRegistry` — SQLite agent tracking with heartbeat + stale detection |
| `resource-guard.ts` | `ResourceGuard` — memory-gated dispatch, `os.freemem()` check (Phase 6A) |
| `rate-limiter.ts` | `RateLimiter` — sliding window failure tracking, cooldown (Phase 6A) |
| `verifier.ts` | `Verifier` — result verification via separate Claude one-shot (Phase 6B) |
| `config.ts` | `loadConfig()` — Zod-validated env vars with range checks, feature flags |
| `format.ts` | `compactFormat()`, `chunkMessage()`, `escMd()` — formatting + Markdown escaping |
| `dashboard.ts` | `Dashboard` — Bun.serve HTTP server, REST API (8 endpoints), SSE real-time updates |
| `dashboard-html.ts` | `getDashboardHtml()` — self-contained HTML/CSS/JS dark-themed dashboard page |
| `memory.ts` | `MemoryStore` — SQLite episodic + semantic memory with FTS5 + optional sqlite-vec + project whiteboards (Phase 3 V2-A, Phase D) |
| `embeddings.ts` | `EmbeddingProvider` — Ollama embedding client + keyword-only fallback (Phase 3 V2-A) |
| `context.ts` | `ContextBuilder` — queries memory, formats context prefix with observation masking + whiteboard injection (Phase 3 V2-B, Phase D) |
| `prd-executor.ts` | `PRDExecutor` — autonomous PRD detection, parsing, execution, progress reporting (Phase 3 V2-D) |
| `prd-parser.ts` | `PRDParser` — Claude one-shot extraction of structured PRD from freeform text (Phase 3 V2-D) |
| `injection-scan.ts` | `scanForInjection()` — regex-based prompt injection detection, 18 patterns, log-only v1 (Phase 4) |
| `scheduler.ts` | `Scheduler` — SQLite-backed cron scheduler, 5-field cron parser, emits tasks to pipeline (Phase 4) |
| `policy.ts` | `PolicyEngine` — YAML-based action authorization, allow/deny/must_ask dispositions (Phase 4) |
| `synthesis.ts` | `SynthesisLoop` — periodic knowledge distillation from episodes, per-domain Claude synthesis + project whiteboards (Phase C, Phase D) |
| `agent-loader.ts` | `AgentLoader` — parses `.pai/agents/*.md` YAML+markdown definitions, self-registers in AgentRegistry (Phase C) |
| `status-message.ts` | `StatusMessage` — rate-limited editable Telegram message manager with init/update/finish/remove lifecycle |

## Cross-Instance Continuity

Cloud Isidore uses `memory.db` (via ContextBuilder) as its sole persistence layer. There is no file-based handoff mechanism — `memory.db` stores episodic and semantic memory, and ContextBuilder injects relevant context into each Claude invocation.

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
