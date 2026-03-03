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
- **DAG orchestrator:** Workflows decomposed via Claude, validated for cycles and referential integrity. Steps dispatched as dependencies resolve. Workflow-completion results written to `results/workflow-<taskId>.json`.
- **Per-task timeout:** Pipeline tasks can specify `timeout_minutes` (overrides 5min default) and `max_turns` (passed to CLI). Essential for overnight PRD queue processing.
- **Pipeline sessions:** `session_id` pass-through from task JSON, plus session-project affinity guard (in-memory Map) to prevent cross-project session contamination.
- **Pipeline priority:** Tasks sorted by `PRIORITY_ORDER` (high=3, normal=2, low=1) within each poll batch.
- **Quick model (Phase 6C):** `--model haiku` via `claude.quickShot()` for lightweight tasks. Feature-flagged `QUICK_MODEL`.
- **Resource guard / rate limiter / verifier (Phase 6):** Memory-gated dispatch, failure-rate circuit breaker, result verification via separate Claude one-shot. All feature-flagged.
- **Zod validation (Phase 1):** All cross-agent JSON boundaries validated via Zod schemas (`safeParse`/`strictParse`). Config env vars validated with range checks. Only internal trusted data (projects.ts, verifier.ts) uses raw `JSON.parse`.
- **Decision traces (Phase 1):** Every pipeline dispatch decision (skip, dedup, gate, dispatch) recorded as structured traces in result JSON. `decision_traces` field is optional for backward compat.
- **Idempotency (Phase 1):** SQLite-backed `processed_ops` table with sha256 op_id. Prevents duplicate task dispatch. Feature-flagged `PIPELINE_DEDUP_ENABLED`.
- **Agent registry (Phase 1):** SQLite `agents` table with heartbeat + stale detection. Feature-flagged `AGENT_REGISTRY_ENABLED`. Shares DB file with idempotency store.
- **MessengerAdapter (Phase 1):** Platform-agnostic interface. `bridge.ts` has zero Grammy/Telegram imports — depends only on `MessengerAdapter`. `TelegramAdapter` wraps existing `createTelegramBot()` without rewriting `telegram.ts`. Future messengers implement the same interface.
- **Dashboard (Phase 2):** Bun.serve web UI on localhost:3456 with REST API + SSE real-time updates. Dark Kanban board, health panels, agent status, workflow progress, history search, decision trace viewer. Feature-flagged `DASHBOARD_ENABLED`. Access via SSH tunnel; nginx reverse proxy config included for future external access.
- **Memory Store (Phase 3 V2-A):** SQLite-backed episodic + semantic memory. FTS5 keyword search with optional sqlite-vec vector search via Ollama embeddings. Records Telegram messages, pipeline results, workflow outcomes. Feature-flagged `MEMORY_ENABLED`.
- **Context Injection (Phase 3 V2-B):** Queries MemoryStore before each Claude invocation, prepends relevant context to prompt. Respects token budget (`CONTEXT_MAX_TOKENS`). Feature-flagged `CONTEXT_INJECTION_ENABLED`.
- **Handoff (Phase 3 V2-C):** Structured JSON handoff objects for cross-instance state transfer. Auto-writes on shutdown, inactivity timeout. Reads incoming handoff on startup. Feature-flagged `HANDOFF_ENABLED`.
- **PRD Executor (Phase 3 V2-D):** Autonomous PRD execution pipeline. Detects PRD-like messages by length/structure, parses via Claude one-shot, executes steps, reports progress via Telegram. Routes through orchestrator for medium+ complexity. Feature-flagged `PRD_EXECUTOR_ENABLED`.
- **Injection Scanning (Phase 4):** Regex-based prompt injection detection at pipeline ingest. 18 patterns across 4 categories (system override, role switching, data exfiltration, prompt leaking). V1 is log-only (warns in decision traces, does not block). Feature-flagged `INJECTION_SCAN_ENABLED` (default: true).
- **Scheduler (Phase 4):** SQLite-backed cron scheduler for autonomous task self-initiation. 5-field cron parser with ranges, steps, lists. Emits task JSON to pipeline tasks/ directory. Built-in schedules: daily memory synthesis (02:00 UTC), weekly health review (Sunday 03:00 UTC). Managed via `/schedule` Telegram command. Feature-flagged `SCHEDULER_ENABLED`. Shares DB file with agent registry.
- **Policy Engine (Phase 4):** YAML-based machine-readable action authorization. Rules with allow/deny/must_ask dispositions. Default: deny (missing rule = blocked). `must_ask` triggers Telegram notification. Checked before pipeline dispatch and orchestrator step dispatch. Policy violations logged as decision traces. Feature-flagged `POLICY_ENABLED`.
- **Synthesis Loop (Phase C):** Periodic knowledge distillation from accumulated episodes. Groups episodes by source domain, calls Claude one-shot per domain to extract reusable knowledge. Writes entries via `MemoryStore.distill()`. State persisted in `synthesis_state` SQLite table. Triggered by scheduler via `type: "synthesis"` pipeline tasks. Feature-flagged `SYNTHESIS_ENABLED`.
- **Agent Definitions (Phase C):** Declarative `.pai/agents/*.md` files with YAML frontmatter + markdown system prompt. Fields: name, execution_tier (1-3), memory_scope, constraints, delegation_permissions, tool_restrictions, self_register. `AgentLoader` parses and caches definitions. Self-registers in `AgentRegistry`. Used by orchestrator for dynamic decomposition prompts. Feature-flagged `AGENT_DEFINITIONS_ENABLED`.
- **Sub-delegation (Phase C):** `ClaudeInvoker.subDelegate()` dispatches tasks to registered agents with tier-based invocation: tier 1 = full oneShot, tier 2 = limited turns with algo-lite template, tier 3 = quickShot (haiku). Prompt composed from algo-lite template + system prompt + constraints + memory context + task.
- **Algorithm Lite (Phase C):** Lightweight 3-phase protocol (CRITERIA → EXECUTE → VERIFY) for tier 2 sub-delegated agents. Template at `prompts/algo-lite.md`, injected as prompt prefix.

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
| `wrapup.ts` | `lightweightWrapup()` — non-blocking git commit with branch guard |
| `memory.ts` | `MemoryStore` — SQLite episodic + semantic memory with FTS5 + optional sqlite-vec (Phase 3 V2-A) |
| `embeddings.ts` | `EmbeddingProvider` — Ollama embedding client + keyword-only fallback (Phase 3 V2-A) |
| `context.ts` | `ContextBuilder` — queries memory, formats context prefix for Claude prompts (Phase 3 V2-B) |
| `handoff.ts` | `HandoffManager` — cross-instance state transfer, inactivity auto-write (Phase 3 V2-C) |
| `prd-executor.ts` | `PRDExecutor` — autonomous PRD detection, parsing, execution, progress reporting (Phase 3 V2-D) |
| `prd-parser.ts` | `PRDParser` — Claude one-shot extraction of structured PRD from freeform text (Phase 3 V2-D) |
| `injection-scan.ts` | `scanForInjection()` — regex-based prompt injection detection, 18 patterns, log-only v1 (Phase 4) |
| `scheduler.ts` | `Scheduler` — SQLite-backed cron scheduler, 5-field cron parser, emits tasks to pipeline (Phase 4) |
| `policy.ts` | `PolicyEngine` — YAML-based action authorization, allow/deny/must_ask dispositions (Phase 4) |
| `synthesis.ts` | `SynthesisLoop` — periodic knowledge distillation from episodes, per-domain Claude synthesis (Phase C) |
| `agent-loader.ts` | `AgentLoader` — parses `.pai/agents/*.md` YAML+markdown definitions, self-registers in AgentRegistry (Phase C) |

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
