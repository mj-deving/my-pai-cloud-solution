# Phase 1: Pipeline Hardening — Implementation Plan

## Context

The PAI Cloud Solution (Telegram bridge + cross-user pipeline) needs hardening before Phase 2 (dashboard) and Phase 3 (V2 features). Currently: all JSON parsing is unvalidated (`JSON.parse(x) as Type`), no structured decision logging, no duplicate-task prevention, no messenger abstraction, and state lives in flat JSON files. Phase 1 adds 6 components to fix this — all feature-flagged and backward-compatible.

**Prior decisions** (from V2-ARCHITECTURE.md, HZL research):
- ADOPT: Zod validation, decision traces, idempotency keys, hook outbox pattern
- Modules with clean interfaces, NOT plugin framework
- MessengerAdapter abstraction now (platform agnosticism as architectural principle)

---

## New Files (7)

| File | Purpose | ~Lines |
|------|---------|--------|
| `src/schemas.ts` | Zod schemas for all external data types + safeParse/strictParse helpers | 280 |
| `src/decision-trace.ts` | DecisionTrace type + TraceCollector builder | 70 |
| `src/agent-message.ts` | AgentMessage envelope + mapping functions (pipelineTaskToMessage, resultToMessage) | 120 |
| `src/idempotency.ts` | SQLite-backed IdempotencyStore (processed_ops table, sha256 op_id generation) | 110 |
| `src/agent-registry.ts` | SQLite AgentRegistry (agents table, heartbeat, stale detection) | 140 |
| `src/messenger-adapter.ts` | MessengerAdapter interface (sendDirectMessage, registerCommand, start/stop) | 70 |
| `src/telegram-adapter.ts` | TelegramAdapter wrapping existing createTelegramBot() — NO telegram.ts rewrite | 120 |

## Modified Files (7)

| File | Changes |
|------|---------|
| `src/config.ts` | Zod-based env validation (replaces 17 raw parseInt calls), 5 new feature flags |
| `src/pipeline.ts` | safeParse for task+result JSON, TraceCollector at 5 decision points, idempotency check before dispatch |
| `src/orchestrator.ts` | safeParse for workflow/step JSON, TraceCollector at 5 dispatch points |
| `src/claude.ts` | safeParse for Claude CLI JSON output (3 sites) |
| `src/reverse-pipeline.ts` | safeParse for task+result JSON (2 sites) |
| `src/branch-manager.ts` | strictParse for branch lock JSON (1 site) |
| `src/bridge.ts` | Wire MessengerAdapter, SQLite registry+idempotency, replace Grammy Bot type |

## Unchanged Files

`telegram.ts`, `session.ts`, `projects.ts`, `format.ts`, `wrapup.ts`, `resource-guard.ts`, `rate-limiter.ts`, `verifier.ts`

---

## Implementation Order (9 commits)

### Commit 1: Zod schemas foundation
**Files:** `package.json`, `src/schemas.ts` (new)

- `bun add zod`
- Create `src/schemas.ts` with Zod schemas for:
  - `PipelineTaskSchema` (21 fields, strict mode, gains `op_id`/`auto_op_id` optional fields)
  - `PipelineResultSchema` (15 fields, gains `decision_traces` optional array)
  - `WorkflowStepSchema`, `WorkflowSchema`
  - `ClaudeJsonOutputSchema` (passthrough — Claude may add fields)
  - `BranchLockSchema`, `BranchLockMapSchema`
  - `DecisionTraceSchema`, `AgentMessageSchema`
- Export `safeParse(schema, raw, label)` → `{success, data} | {success: false, error}`
- Export `strictParse(schema, raw, label)` → throws on failure (for internal data)
- Types re-exported via `z.infer<typeof Schema>`

### Commit 2: Config Zod validation
**Files:** `src/config.ts`

- Define `EnvSchema` using Zod with `.transform(Number).pipe(z.number().int().min(X).max(Y))` for all numeric env vars
- Replace raw `parseInt()` calls (17 sites) with validated env object
- Add new Config fields + env vars:

| Env Var | Config Field | Default |
|---------|-------------|---------|
| `PIPELINE_DEDUP_ENABLED` | `pipelineDedupEnabled` | `true` |
| `AGENT_REGISTRY_ENABLED` | `agentRegistryEnabled` | `false` |
| `AGENT_REGISTRY_DB_PATH` | `agentRegistryDbPath` | `/var/lib/pai-pipeline/agent-registry.db` |
| `AGENT_REGISTRY_HEARTBEAT_INTERVAL_MS` | `agentRegistryHeartbeatIntervalMs` | `10000` |
| `AGENT_REGISTRY_STALE_THRESHOLD_MS` | `agentRegistryStaleThresholdMs` | `60000` |
| `MESSENGER_TYPE` | `messengerType` | `"telegram"` |

### Commit 3: Replace all unsafe JSON.parse casts
**Files:** `src/pipeline.ts`, `src/orchestrator.ts`, `src/claude.ts`, `src/reverse-pipeline.ts`, `src/branch-manager.ts`

10 JSON.parse sites replaced:

| File | Line | Before | After |
|------|------|--------|-------|
| pipeline.ts | ~185 | `JSON.parse(raw) as PipelineTask` | `safeParse(PipelineTaskSchema, raw, label)` |
| pipeline.ts | ~466 | `JSON.parse(stdout)` | `safeParse(ClaudeJsonOutputSchema, stdout, label)` |
| orchestrator.ts | ~99 | `JSON.parse(raw) as Workflow` | `strictParse(WorkflowSchema, raw, label)` |
| orchestrator.ts | ~168 | `JSON.parse(jsonMatch[0])` | Parse + map through WorkflowStepSchema |
| claude.ts | ~107 | `JSON.parse(stdout)` | `safeParse(ClaudeJsonOutputSchema, stdout, label)` |
| claude.ts | ~181 | `JSON.parse(stdout)` | Same (oneShot) |
| claude.ts | ~246 | `JSON.parse(stdout)` | Same (quickShot) |
| reverse-pipeline.ts | ~77 | `JSON.parse(raw) as PipelineTask` | `safeParse(PipelineTaskSchema, raw, label)` |
| reverse-pipeline.ts | ~196 | `JSON.parse(raw) as PipelineResult` | `safeParse(PipelineResultSchema, raw, label)` |
| branch-manager.ts | ~30 | `JSON.parse(raw) as Record<...>` | `strictParse(BranchLockMapSchema, raw, label)` |

**Not touched** (internal-only data, no cross-agent boundary): `projects.ts:51`, `projects.ts:75`, `verifier.ts:85`

Remove duplicate type interfaces from pipeline.ts, orchestrator.ts, branch-manager.ts (now exported from schemas.ts).

### Commit 4: Decision traces
**Files:** `src/decision-trace.ts` (new), `src/pipeline.ts`, `src/orchestrator.ts`

- `createTrace(params)` → returns `DecisionTrace` object
- `TraceCollector` class with `.emit()`, `.getTraces()`, `.clear()`
- pipeline.ts: Create `TraceCollector` at start of `processTask()`, emit at 5 sites:
  1. Task validation skip (missing id/prompt) → `reason_code: "invalid_task"`
  2. Resource guard gate → `reason_code: "memory_low"`
  3. Per-project lock skip → `reason_code: "project_locked"`
  4. Rate limiter skip → `reason_code: "rate_limited"`
  5. Verifier rejection → `reason_code: "verification_failed"`
  6. Success → `reason_code: "dispatched"`
- Include `decision_traces: traceCollector.getTraces()` in result JSON
- orchestrator.ts: Same pattern at dispatchStep/failStep/advanceWorkflow decision points

### Commit 5: AgentMessage envelope
**Files:** `src/agent-message.ts` (new), `src/pipeline.ts`, `src/reverse-pipeline.ts`

- `AgentMessage` type: `{id, from, to, type, priority, timestamp, ttl?, correlationId?, payload}`
- Payload discriminated union: `TaskPayload | ResultPayload | HeartbeatPayload | EventPayload` (with `kind` discriminator)
- `pipelineTaskToMessage(task)` — maps PipelineTask → AgentMessage at pipeline boundary
- `resultToMessage(result)` — maps PipelineResult → AgentMessage at result boundary
- `heartbeatMessage(agentId, name, status, uptime)` — for registry heartbeats
- **No file format changes** — AgentMessage wraps at transport layer, PipelineTask/PipelineResult still written as-is to disk for Gregor compatibility

### Commit 6: SQLite registry + idempotency
**Files:** `src/agent-registry.ts` (new), `src/idempotency.ts` (new), `src/pipeline.ts`

**Both use same SQLite DB file** (different tables). Uses `bun:sqlite` (built-in, no npm package).

**IdempotencyStore:**
- `processed_ops` table: `op_id TEXT PK, task_id, status, result_path, processed_at, expires_at`
- `isDuplicate(opId)` — check before dispatch
- `record(opId, taskId, status, resultPath)` — record after completion
- `generateOpId(prompt)` — sha256 of normalized prompt (static method)
- WAL mode, busy_timeout=5000

**AgentRegistry:**
- `agents` table: `id TEXT PK, persona, status, capabilities JSON, last_heartbeat, registered_at`
- `register(id, persona, capabilities)` — upsert on startup
- `heartbeat(id)` — update timestamp
- `startHeartbeat(id, intervalMs)` / `stopHeartbeat()`
- `deregister(id)` — mark offline on shutdown
- `getAgents(staleThresholdMs?)` — list with stale detection

**Pipeline integration:**
- New `setIdempotencyStore(store)` setter on PipelineWatcher (follows existing DI pattern)
- Before dispatch: resolve op_id (explicit → auto-generated → skip), check isDuplicate, emit trace if skipped
- After completion: record operation

### Commit 7: MessengerAdapter + TelegramAdapter
**Files:** `src/messenger-adapter.ts` (new), `src/telegram-adapter.ts` (new)

**MessengerAdapter interface:**
```typescript
interface MessengerAdapter {
  sendDirectMessage(text: string, options?: MessageOptions): Promise<void>;
  sendTypingIndicator(): Promise<void>;
  registerCommand(command: string, handler: CommandHandler): void;
  registerMessageHandler(handler: MessageHandler): void;
  start(): Promise<void>;
  stop(): void;
  getUserId(): string | number;
  getMaxMessageSize(): number;
}
```

**TelegramAdapter (wrapping strategy):**
- Constructor calls `createTelegramBot()` internally — telegram.ts stays untouched
- `sendDirectMessage()` → `bot.api.sendMessage(userId, text, {parse_mode})`
- `start()` → wraps `bot.start()` in Promise
- `stop()` → `bot.stop()`
- `registerCommand()` / `registerMessageHandler()` → no-ops in Phase 1 (commands already registered inside createTelegramBot). Phase 2 migrates command registration to adapter.
- `getRawBot()` exposed temporarily for edge cases (should not be used by bridge.ts)

### Commit 8: Bridge.ts integration
**Files:** `src/bridge.ts`

- Replace `import { createTelegramBot } from "./telegram"` → `import { TelegramAdapter }` + `import type { MessengerAdapter }`
- Create `MessengerAdapter` based on `config.messengerType` (only "telegram" for now)
- Create `AgentRegistry` + `IdempotencyStore` if flags enabled (shared DB path)
- Register agent on startup, start heartbeat
- Replace all `bot.api.sendMessage(userId, msg, ...)` → `messenger.sendDirectMessage(msg, {parseMode: "Markdown"})` (4 callback sites: reversePipeline, orchestrator, rateLimiter, recovery notification)
- Wire `idempotencyStore` to pipeline via setter
- Graceful shutdown: deregister agent, close DB, stop messenger
- Replace `bot.start()` → `messenger.start()`
- **Result: zero Grammy/Telegram imports in bridge.ts**

### Commit 9: Type-check + verify
- `bunx tsc --noEmit` → 0 errors
- Deploy to VPS, test with flags off (V1 behavior), then flags on
- Send Telegram message, submit pipeline task, verify both paths work

---

## Verification Plan

| Check | Method | Pass Signal |
|-------|--------|-------------|
| Zod schemas cover all parse sites | `grep -n 'JSON.parse' src/*.ts` — only internal/trusted sites remain | 3 allowed sites (projects.ts x2, verifier.ts x1) |
| Config validates numeric ranges | Set `PIPELINE_MAX_CONCURRENT=abc`, verify startup crash with clear Zod error | Descriptive error, not NaN |
| Decision traces in results | Submit pipeline task, read result JSON for `decision_traces` array | Non-empty traces with reason_codes |
| Idempotency dedup | Submit same task twice with `op_id`, verify second skipped | Second task moves to ack/ without dispatch |
| Agent registry heartbeat | Start bridge with `AGENT_REGISTRY_ENABLED=1`, query SQLite | agents row with recent last_heartbeat |
| MessengerAdapter decoupling | `grep 'grammy\|Grammy\|Bot' src/bridge.ts` | Zero matches |
| Type safety | `bunx tsc --noEmit` | Exit code 0 |
| Backward compat | Deploy with all Phase 1 flags OFF | Identical V1 behavior |

## Deploy Notes

- `/var/lib/pai-pipeline/` already exists with pai group setgid 2770 — SQLite DB auto-creates there
- SQLite WAL mode creates `-wal` and `-shm` companion files in same directory
- No VPS setup needed beyond `bun install` (zod is the only new dependency)
- Rollback: set `PIPELINE_DEDUP_ENABLED=0` and `AGENT_REGISTRY_ENABLED=0` in bridge.env
