# Design Decisions — Phase-Specific Reference

Detailed design decisions organized by implementation phase. Core architectural decisions live inline in `CLAUDE.md`.

---

## Phase 1 — Pipeline Hardening

- **Zod validation:** All cross-agent JSON boundaries validated via Zod schemas (`safeParse`/`strictParse`). Config env vars validated with range checks. Only internal trusted data (projects.ts, verifier.ts) uses raw `JSON.parse`.
- **Decision traces:** Every pipeline dispatch decision (skip, dedup, gate, dispatch) recorded as structured traces in result JSON. `decision_traces` field is optional for backward compat.
- **Idempotency:** SQLite-backed `processed_ops` table with sha256 op_id. Prevents duplicate task dispatch. Feature-flagged `PIPELINE_DEDUP_ENABLED`.
- **Agent registry:** SQLite `agents` table with heartbeat + stale detection. Feature-flagged `AGENT_REGISTRY_ENABLED`. Shares DB file with idempotency store.
- **MessengerAdapter:** Platform-agnostic interface. `bridge.ts` has zero Grammy/Telegram imports — depends only on `MessengerAdapter`. `TelegramAdapter` wraps existing `createTelegramBot()` without rewriting `telegram.ts`. Future messengers implement the same interface.

## Phase 2 — Dashboard

- **Dashboard:** Bun.serve web UI on localhost:3456 with REST API + SSE real-time updates. Dark Kanban board, health panels, agent status, workflow progress, history search, decision trace viewer. Feature-flagged `DASHBOARD_ENABLED`. Access via SSH tunnel; nginx reverse proxy config included for future external access.

## Phase 3 V2 — Memory, Context, Handoff, PRD

- **Memory Store (V2-A):** SQLite-backed episodic + semantic memory. FTS5 keyword search with optional sqlite-vec vector search via Ollama embeddings. Records Telegram messages, pipeline results, workflow outcomes. Feature-flagged `MEMORY_ENABLED`.
- **Context Injection (V2-B):** Queries MemoryStore before each Claude invocation, prepends relevant context to prompt. Respects token budget (`CONTEXT_MAX_TOKENS`). Feature-flagged `CONTEXT_INJECTION_ENABLED`.
- **Handoff (V2-C):** Structured JSON handoff objects for cross-instance state transfer. Auto-writes on shutdown, inactivity timeout. Reads incoming handoff on startup. Feature-flagged `HANDOFF_ENABLED`.
- **PRD Executor (V2-D):** Autonomous PRD execution pipeline. Detects PRD-like messages by length/structure, parses via Claude one-shot, executes steps, reports progress via Telegram. Routes through orchestrator for medium+ complexity. Feature-flagged `PRD_EXECUTOR_ENABLED`.

## Phase 6 — Reliability & Efficiency

- **Per-task timeout:** Pipeline tasks can specify `timeout_minutes` (overrides 5min default) and `max_turns` (passed to CLI). Essential for overnight PRD queue processing.
- **Pipeline sessions:** `session_id` pass-through from task JSON, plus session-project affinity guard (in-memory Map) to prevent cross-project session contamination.
- **Pipeline priority:** Tasks sorted by `PRIORITY_ORDER` (high=3, normal=2, low=1) within each poll batch.
- **Quick model (Phase 6C):** `--model haiku` via `claude.quickShot()` for lightweight tasks. Feature-flagged `QUICK_MODEL`.
- **Resource guard / rate limiter / verifier:** Memory-gated dispatch, failure-rate circuit breaker, result verification via separate Claude one-shot. All feature-flagged.

## Phase 4 — Scheduler, Policy, Injection Scan

- **Injection Scanning:** Regex-based prompt injection detection at pipeline ingest. 18 patterns across 4 categories (system override, role switching, data exfiltration, prompt leaking). V1 is log-only (warns in decision traces, does not block). Feature-flagged `INJECTION_SCAN_ENABLED` (default: true).
- **Scheduler:** SQLite-backed cron scheduler for autonomous task self-initiation. 5-field cron parser with ranges, steps, lists. Emits task JSON to pipeline tasks/ directory. Built-in schedules: daily memory synthesis (02:00 UTC), weekly health review (Sunday 03:00 UTC). Managed via `/schedule` Telegram command. Feature-flagged `SCHEDULER_ENABLED`. Shares DB file with agent registry.
- **Policy Engine:** YAML-based machine-readable action authorization. Rules with allow/deny/must_ask dispositions. Default: deny (missing rule = blocked). `must_ask` triggers Telegram notification. Checked before pipeline dispatch and orchestrator step dispatch. Policy violations logged as decision traces. Feature-flagged `POLICY_ENABLED`.

## Phase C — Synthesis, Agent Definitions, Sub-delegation

- **Synthesis Loop:** Periodic knowledge distillation from accumulated episodes. Groups episodes by source domain, calls Claude one-shot per domain to extract reusable knowledge. Writes entries via `MemoryStore.distill()`. State persisted in `synthesis_state` SQLite table. Triggered by scheduler via `type: "synthesis"` pipeline tasks. Feature-flagged `SYNTHESIS_ENABLED`.
- **Agent Definitions:** Declarative `.pai/agents/*.md` files with YAML frontmatter + markdown system prompt. Fields: name, execution_tier (1-3), memory_scope, constraints, delegation_permissions, tool_restrictions, self_register. `AgentLoader` parses and caches definitions. Self-registers in `AgentRegistry`. Used by orchestrator for dynamic decomposition prompts. Feature-flagged `AGENT_DEFINITIONS_ENABLED`.
- **Sub-delegation:** `ClaudeInvoker.subDelegate()` dispatches tasks to registered agents with tier-based invocation: tier 1 = full oneShot, tier 2 = limited turns with algo-lite template, tier 3 = quickShot (haiku). Prompt composed from algo-lite template + system prompt + constraints + memory context + task.
- **Algorithm Lite:** Lightweight 3-phase protocol (CRITERIA → EXECUTE → VERIFY) for tier 2 sub-delegated agents. Template at `prompts/algo-lite.md`, injected as prompt prefix.
