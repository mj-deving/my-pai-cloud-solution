# Phase 3: V2 Memory, Handoff & PRD Executor

> **Context:** Isidore Cloud V1 is a Telegram bridge + cross-user pipeline with 25 modules (~5,500 lines). Phase 1 added pipeline hardening (Zod, decision traces, idempotency). Phase 2 added a dashboard. Phase 3 evolves it into an autonomous agent with persistent memory, crash-proof handoff, and zero-manual-management PRD execution. The V2 architecture was designed in `V2-ARCHITECTURE.md`; this plan makes it implementable.
>
> **Approach:** Evolve in-place (Option A from V2-ARCHITECTURE.md). All V2 features are feature-flagged and additive — V1 behavior preserved when flags are off.

---

## Sub-Phase Ordering

```
V2-A: Memory Store          (foundation — no dependencies)
V2-B: Context Injection     (depends on V2-A)
V2-C: Handoff Mechanism     (depends on V2-A)
V2-D: PRD Executor          (depends on V2-A, V2-B)
```

V2-A must ship first. V2-B and V2-C can be built in parallel after V2-A. V2-D requires both V2-A and V2-B.

---

## V2-A: Memory Store (~1 session)

**What:** SQLite-backed episodic + semantic memory with optional vector search via sqlite-vec. Records Telegram messages, pipeline results, and workflow outcomes. Queryable by keyword or semantic similarity.

### New Files

| File | Class/Interface | Est. Lines | Purpose |
|------|----------------|-----------|---------|
| `src/memory.ts` | `MemoryStore` | ~200 | SQLite episodes + knowledge tables, record/query/distill/prune/stats |
| `src/embeddings.ts` | `EmbeddingProvider` | ~120 | Ollama embedding client + keyword-only fallback |

### Modified Files

| File | Change |
|------|--------|
| `src/config.ts` | Add 6 env vars (see Config section) |
| `src/schemas.ts` | Add `EpisodeSchema`, `KnowledgeSchema`, `MemoryQuerySchema` |
| `src/bridge.ts` | Init `MemoryStore` after idempotency, wire to dashboard, add to shutdown |
| `src/dashboard.ts` | Add `/api/memory` endpoint, add to constructor + SSE |

### Feature Flags

```
MEMORY_ENABLED=0          (default off — opt-in on VPS)
```

### Config Additions

```typescript
// config.ts EnvSchema additions
MEMORY_ENABLED: envBool(false),
MEMORY_DB_PATH: z.string().optional(),              // default: data/memory.db
MEMORY_OLLAMA_URL: z.string().optional(),            // default: http://localhost:11434
MEMORY_EMBEDDING_MODEL: z.string().optional(),       // default: nomic-embed-text
MEMORY_MAX_EPISODES: optionalInt(100, 100000, 10000),
MEMORY_DECAY_LAMBDA: z.string().optional().transform(v => v ? parseFloat(v) : 0.023),
```

### Schema Additions

```typescript
// New in schemas.ts
EpisodeSchema: { id, timestamp, source, project?, session_id?, role, content, summary?, metadata? }
KnowledgeSchema: { id, domain, key, content, confidence, source_episode_ids?, expires_at? }
MemoryQuerySchema: { query, project?, source?, maxResults?, maxTokens?, recencyBias? }
MemoryResultSchema: { episodes[], knowledge[], totalTokens }
```

### sqlite-vec Strategy

**Plan A — sqlite-vec available in Bun:**
- Check at runtime: `try { db.exec("SELECT vec_version()") }`
- If available: create `episode_embeddings` virtual table, use cosine similarity search
- Ollama generates embeddings via HTTP (`POST /api/embeddings`)

**Plan B — sqlite-vec NOT available (fallback):**
- Skip virtual table creation entirely
- `query()` uses FTS5 full-text search over content + summary fields
- `EmbeddingProvider.embed()` returns null, store skips vector insert
- Memory still works — just keyword search instead of semantic search
- Log once: `[memory] sqlite-vec not available, using keyword search fallback`

**Plan C — Ollama not running:**
- `EmbeddingProvider` health-checks Ollama on init (`GET /api/tags`)
- If down: disable embedding, use FTS5 only
- Periodically retry (every 5 min) to auto-recover if Ollama starts later

### Verification

- `bunx tsc --noEmit` passes
- Unit: create MemoryStore, record 3 episodes, query by keyword, verify results
- Integration: set `MEMORY_ENABLED=1`, start bridge, send Telegram message, verify episode recorded in SQLite
- Dashboard: `/api/memory` returns stats (episode count, knowledge count, storage size)
- Fallback: start without Ollama, verify keyword search works, no crashes

---

## V2-B: Context Injection (~1 session)

**What:** Before each Claude invocation (Telegram or pipeline), query MemoryStore for relevant context and prepend it to the prompt. Selective injection based on project + recency.

### New Files

| File | Class/Interface | Est. Lines | Purpose |
|------|----------------|-----------|---------|
| `src/context.ts` | `ContextBuilder` | ~100 | Queries memory, formats injection block, respects token budget |

### Modified Files

| File | Change |
|------|--------|
| `src/config.ts` | Add 2 env vars |
| `src/claude.ts` | Add `setContextBuilder()`, prepend context in `send()` and `oneShot()` |
| `src/pipeline.ts` | Add context injection before dispatch (line ~420) |
| `src/telegram.ts` | Wire context builder to message handling flow |
| `src/bridge.ts` | Init ContextBuilder, wire to ClaudeInvoker and PipelineWatcher |

### Feature Flags

```
CONTEXT_INJECTION_ENABLED=0    (default off)
```

### Config Additions

```typescript
CONTEXT_INJECTION_ENABLED: envBool(false),
CONTEXT_MAX_TOKENS: optionalInt(500, 8000, 2000),  // budget per injection
```

### Integration Detail

**ClaudeInvoker changes:**
```typescript
// claude.ts — new setter
setContextBuilder(cb: { buildContext(message: string, project?: string): Promise<string | null> }): void

// In send() and oneShot(), before spawning:
if (this.contextBuilder) {
  const ctx = await this.contextBuilder.buildContext(message, this.currentProject);
  if (ctx) prompt = `${ctx}\n\n---\n\n${message}`;
}
```

**PipelineWatcher changes:**
- In dispatch(), before building prompt (line ~420): query memory for task.project context
- Inject as prefix if context found, respecting task.max_turns (don't waste turns on context)

### Verification

- Type check passes
- Send Telegram message about a topic, then send follow-up — verify context includes prior episode
- Pipeline task with project field — verify memory context prepended to prompt
- With CONTEXT_INJECTION_ENABLED=0 — verify zero behavior change

---

## V2-C: Handoff Mechanism (~1 session)

**What:** Structured handoff objects for cross-instance state transfer (local Marius ↔ VPS Isidore Cloud). Auto-writes on shutdown, /handoff command, and inactivity timeout. Reads on startup.

### New Files

| File | Class/Interface | Est. Lines | Purpose |
|------|----------------|-----------|---------|
| `src/handoff.ts` | `HandoffManager` | ~180 | Write/read/archive handoff objects, auto-triggers, memory sync pointer |

### Modified Files

| File | Change |
|------|--------|
| `src/config.ts` | Add 3 env vars |
| `src/schemas.ts` | Add `HandoffObjectSchema` |
| `src/bridge.ts` | Init HandoffManager, wire to shutdown, wire to MemoryStore |
| `src/telegram.ts` | Enhance /handoff command (currently manual CLAUDE.local.md) |
| `src/wrapup.ts` | Trigger handoff write alongside git commit |
| `src/session.ts` | Expose metadata for handoff (current project, branch) |

### Feature Flags

```
HANDOFF_ENABLED=0    (default off)
```

### Config Additions

```typescript
HANDOFF_ENABLED: envBool(false),
HANDOFF_DIR: z.string().optional(),               // default: ~/.claude/handoff/
HANDOFF_INACTIVITY_MINUTES: optionalInt(5, 120, 30),
```

### HandoffObject Schema

```typescript
HandoffObjectSchema = z.object({
  version: z.literal(1),
  timestamp: z.string(),
  direction: z.enum(["local-to-cloud", "cloud-to-local"]),
  activeProject: z.string().nullable(),
  sessionId: z.string().nullable(),
  branch: z.string(),
  uncommittedChanges: z.boolean(),
  activePRD: z.string().nullable(),
  activeWorkflows: z.array(z.string()),
  pendingTasks: z.array(z.string()),
  recentWorkSummary: z.string(),
  nextSteps: z.array(z.string()),
  blockers: z.array(z.string()),
  lastEpisodeId: z.number(),
  memoryDbHash: z.string(),
});
```

### Verification

- Type check passes
- /handoff command writes JSON to handoff dir, pushes via knowledge sync
- Bridge shutdown (SIGTERM) writes handoff object
- Bridge startup reads incoming handoff, logs context
- Inactivity timer fires after configured minutes, writes standby handoff

---

## V2-D: PRD Executor (~2 sessions)

**What:** Autonomous PRD execution pipeline. Detects PRDs from Telegram messages or pipeline tasks, parses into structured plans, sets up workspace, executes with ISC verification, reports progress.

### New Files

| File | Class/Interface | Est. Lines | Purpose |
|------|----------------|-----------|---------|
| `src/prd-executor.ts` | `PRDExecutor` | ~300 | Orchestrates PRD lifecycle: detect → parse → setup → execute → verify → report |
| `src/prd-parser.ts` | `PRDParser` | ~120 | Claude one-shot to extract structured PRD from freeform text |

### Modified Files

| File | Change |
|------|--------|
| `src/config.ts` | Add 4 env vars |
| `src/schemas.ts` | Add `ParsedPRDSchema`, `PRDProgressSchema` |
| `src/bridge.ts` | Init PRDExecutor, wire dependencies |
| `src/telegram.ts` | Add PRD detection in message handler, /prd command |
| `src/pipeline.ts` | Route `type: "prd"` tasks to PRDExecutor instead of generic dispatch |
| `src/dashboard.ts` | Add `/api/prds` endpoint for active PRD status |

### Feature Flags

```
PRD_EXECUTOR_ENABLED=0    (default off)
```

### Config Additions

```typescript
PRD_EXECUTOR_ENABLED: envBool(false),
PRD_DETECTION_MIN_LENGTH: optionalInt(100, 5000, 500),   // min chars to trigger PRD detection
PRD_MAX_RETRIES: optionalInt(1, 10, 3),
PRD_PROGRESS_INTERVAL_MS: optionalInt(5000, 60000, 15000),
```

### ParsedPRD Schema

```typescript
ParsedPRDSchema = z.object({
  title: z.string(),
  description: z.string(),
  project: z.string().nullable(),
  requirements: z.array(z.string()),
  constraints: z.array(z.string()),
  estimatedComplexity: z.enum(["simple", "medium", "complex"]),
  suggestedSteps: z.array(z.object({
    description: z.string(),
    assignee: z.enum(["isidore", "gregor", "ask"]),
    dependsOn: z.array(z.string()),
  })),
});
```

### Execution Flow

```
1. Detect PRD (Telegram heuristic or pipeline type:"prd")
2. Parse via PRDParser (Claude one-shot → ParsedPRD)
3. Detect project (from PRD content + project registry)
   └─ If ambiguous: ask user via Telegram
4. Setup workspace
   ├─ Switch to project (ensureCloned, syncPull)
   ├─ Create branch: prd/<slug>
   └─ Load memory context for project
5. Execute steps
   ├─ Simple (1-3 steps): direct claude oneShot per step
   ├─ Medium (4-10 steps): create workflow via orchestrator
   └─ Complex (10+ steps): decompose into sub-PRDs
6. After each step:
   ├─ Record to memory (episodic)
   ├─ Report progress via Telegram
   └─ Verify step output
7. Final verification (all ISC criteria)
8. Write result to pipeline results/
9. Commit + push on feature branch
10. Notify user via Telegram with summary
```

### Verification

- Type check passes
- Send long structured message via Telegram — verify PRD detection triggers
- Pipeline task with type:"prd" — verify routing to PRDExecutor
- Simple PRD: parse → detect project → execute → verify → report
- SIGTERM during PRD execution: verify graceful stop, state recorded for resume
- Dashboard: /api/prds shows active PRD status

---

## Bridge.ts Wiring Summary

```typescript
// V2-A: Memory Store
let memoryStore: MemoryStore | null = null;
if (config.memoryEnabled) {
  memoryStore = new MemoryStore(config.memoryDbPath, config);
  console.log(`[bridge] Memory store initialized (${memoryStore.getStats().episodeCount} episodes)`);
}

// V2-B: Context Injection
let contextBuilder: ContextBuilder | null = null;
if (config.contextInjectionEnabled && memoryStore) {
  contextBuilder = new ContextBuilder(memoryStore, config);
  claude.setContextBuilder(contextBuilder);
  console.log("[bridge] Context injection enabled");
}

// V2-C: Handoff Manager
let handoffManager: HandoffManager | null = null;
if (config.handoffEnabled) {
  handoffManager = new HandoffManager(config, sessions, projects, memoryStore, orchestrator);
  const incoming = handoffManager.readIncoming();
  if (incoming) console.log(`[bridge] Loaded handoff from ${incoming.direction} (${incoming.timestamp})`);
}

// V2-D: PRD Executor
let prdExecutor: PRDExecutor | null = null;
if (config.prdExecutorEnabled) {
  prdExecutor = new PRDExecutor(config, claude, projects, memoryStore, orchestrator, messenger);
  console.log("[bridge] PRD executor enabled");
}

// Dashboard wiring (extend existing)
if (config.dashboardEnabled) {
  dashboard = new Dashboard(config, pipeline, orchestrator, reversePipeline,
    rateLimiter, resourceGuard, agentRegistry, idempotencyStore,
    memoryStore, handoffManager, prdExecutor);  // V2 additions
}

// Shutdown (add before existing shutdown items)
async function shutdown() {
  handoffManager?.writeOutgoing();   // V2-C: save state before exit
  prdExecutor?.stop();               // V2-D: graceful PRD abort
  memoryStore?.close();              // V2-A: close SQLite
  // ... existing shutdown sequence ...
}
```

---

## Dependency Check: sqlite-vec in Bun

**sqlite-vec** is a C extension. In Bun, native extensions load via `db.loadExtension()` on the `bun:sqlite` Database object. The plan:

1. **Build time:** `bun install sqlite-vec` (npm package provides prebuilt binaries)
2. **Runtime:** `db.loadExtension("vec0")` — if it throws, fallback to FTS5
3. **FTS5 is built into bun:sqlite** — always available, no extension needed
4. **Test on VPS first** before committing to vector search in production

If sqlite-vec proves problematic, the entire memory system still works via FTS5 keyword search. Vector search is a quality improvement, not a hard requirement.

---

## Scope Estimates

| Sub-Phase | New Files | Modified Files | Est. Lines Added | Sessions |
|-----------|-----------|---------------|-----------------|----------|
| V2-A: Memory Store | 2 | 4 | ~400 | 1 |
| V2-B: Context Injection | 1 | 5 | ~200 | 1 |
| V2-C: Handoff Mechanism | 1 | 6 | ~280 | 1 |
| V2-D: PRD Executor | 2 | 6 | ~550 | 2 |
| **Total** | **6 new** | **~10 modified** | **~1,430** | **~5 sessions** |

---

## Implementation Order (Recommended)

1. **Session 1:** V2-A (Memory Store + embeddings) — the foundation everything depends on
2. **Session 2:** V2-B (Context Injection) — highest user-visible impact after memory
3. **Session 3:** V2-C (Handoff Mechanism) — enables reliable local↔cloud switching
4. **Session 4-5:** V2-D (PRD Executor) — the capstone, autonomous execution
5. **Optional Session 6:** V2 polish — dashboard memory panels, FTS5 tuning, handoff UX
