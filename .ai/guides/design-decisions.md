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
