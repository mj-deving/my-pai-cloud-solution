# Isidore Cloud V2 — Architecture Design Document

> **Purpose:** Blueprint for evolving Isidore Cloud from a Telegram↔Claude bridge into an autonomous agent with vector memory, crash-proof handoff, and zero-manual-management PRD execution.
>
> **Deliverable type:** Architecture design (no code changes in this session)
> **Time budget:** 2 hours (exploration + design)
> **Author:** Isidore, for Marius

---

## Table of Contents

0. [Upgrade Strategy: Same Repo vs New Repo vs Fork](#0-upgrade-strategy)
1. [Current State Analysis](#1-current-state-analysis)
2. [Gap Analysis](#2-gap-analysis)
3. [Vector Memory Architecture](#3-vector-memory-architecture)
4. [Autonomous PRD Executor](#4-autonomous-prd-executor)
5. [Handoff Mechanism](#5-handoff-mechanism)
6. [Context Window Management](#6-context-window-management)
7. [Agent Framework Comparison](#7-agent-framework-comparison)
8. [Zero-Manual-Management Design](#8-zero-manual-management-design)
9. [Gregor Integration](#9-gregor-integration)
10. [Migration Path](#10-migration-path)
11. [Resource Estimates](#11-resource-estimates)
12. [Data Flow Diagrams](#12-data-flow-diagrams)
13. [Modular Plugin Architecture](#13-modular-plugin-architecture)
14. [Agent Persona Framework](#14-agent-persona-framework)
15. [Multi-Instance Design](#15-multi-instance-design)
16. [Agent Ecosystem & Collaboration](#16-agent-ecosystem--collaboration)
17. [Deployment Modes](#17-deployment-modes)
18. [Debuggability & Observability](#18-debuggability--observability)
19. [Dependency Architecture](#19-dependency-architecture)
20. [Revised Migration Path](#20-revised-migration-path)

---

## 0. Upgrade Strategy

### The Question

How do we get from V1 (`my-pai-cloud-solution`, ~4,366 lines, 16 modules) to V2 (autonomous agent with memory, handoff, PRD executor)? Four options:

### Option A: Evolve In-Place (RECOMMENDED)

**Keep `my-pai-cloud-solution` repo. Add V2 features incrementally.**

| Pro | Con |
|-----|-----|
| Preserves 20+ feature commits of git history | Repo name feels narrow ("cloud solution" vs "autonomous agent") |
| Zero deployment changes — systemd, VPS paths, rsync all unchanged | Growing complexity in single repo |
| Gregor pipeline integration untouched | — |
| Feature flags mean V1 behavior preserved alongside V2 | — |
| Each phase ships independently — no big-bang migration | — |
| Single repo to maintain, single deploy.sh | — |

**Why this wins:** The codebase is small (4,366 lines). Every V2 addition is feature-flagged. There's no architectural reason to split — V2 is V1 + new modules, not a rewrite. The "cloud solution" name can be updated on GitHub (free rename) without breaking anything.

**Repo rename path (optional, cosmetic):**
```
my-pai-cloud-solution → isidore-cloud
```
GitHub auto-redirects the old URL. Update `deploy.sh` paths, VPS project dir (`/home/isidore_cloud/projects/isidore-cloud/`), and CLAUDE.md references. 30-minute migration, no code changes.

### Option B: New Repo

**Create `isidore-cloud` (or `isidore-agent`) from scratch. Port V1 modules into new structure.**

| Pro | Con |
|-----|-----|
| Clean project structure from day one | Loses git history (who wrote what, why) |
| Better name | Breaks ALL deployment: systemd unit, deploy.sh, VPS paths, Gregor pipeline dirs |
| Can redesign directory structure | Two repos to manage during transition period |
| — | Copy-paste of 4,366 lines loses commit attribution |
| — | Gregor's scripts reference current paths |

**When this makes sense:** If V2 were a fundamentally different technology (e.g., switching from Bun to Python, or from Telegram to a web app). It's not — it's the same TypeScript/Bun stack with additions.

### Option C: Fork

**Fork `my-pai-cloud-solution` → `isidore-cloud-v2`. Develop V2 in fork.**

| Pro | Con |
|-----|-----|
| Preserves history | Fork drift — V1 fixes don't flow to V2 and vice versa |
| V1 stays as fallback | Two repos, confusion about "which is real" |
| Can diverge freely | Eventually must pick one and archive the other |

**When this makes sense:** If you want to experiment with V2 while keeping V1 in production as a guaranteed fallback. But since V2 is feature-flagged, V1 behavior is preserved in-place anyway.

### Option D: Feature Branch

**Develop V2 on a `v2` branch in the same repo.**

| Pro | Con |
|-----|-----|
| Same repo, can compare easily | Long-lived branches accumulate merge conflicts |
| V1 stays on main | Can't deploy V2 features incrementally |
| — | Branch eventually becomes unmergeable |

**When this makes sense:** Almost never for iterative work. Long-lived branches are an anti-pattern.

### Recommendation: Option A (Evolve In-Place)

**Rationale:**
1. **4,366 lines is tiny** — no complexity pressure to split
2. **Feature flags** preserve V1 behavior — `MEMORY_ENABLED=0` means memory layer doesn't exist
3. **Incremental delivery** — Phase 1 ships to production in 2-3 days, not weeks
4. **Single deployment story** — `deploy.sh` doesn't change
5. **Gregor integration unchanged** — pipeline dirs, scripts, paths all stable
6. **Optional rename** — if "my-pai-cloud-solution" feels wrong, GitHub rename is free and non-breaking

**Suggested directory evolution:**

```
src/
  ├── bridge.ts              (V1 — unchanged)
  ├── telegram.ts            (V1 — extended with PRD detection)
  ├── claude.ts              (V1 — extended with context injection)
  ├── session.ts             (V1 — unchanged)
  ├── projects.ts            (V1 — extended with auto-detection)
  ├── pipeline.ts            (V1 — extended with PRD routing)
  ├── reverse-pipeline.ts    (V1 — unchanged)
  ├── orchestrator.ts        (V1 — extended to accept pre-parsed steps)
  ├── branch-manager.ts      (V1 — unchanged)
  ├── resource-guard.ts      (V1 — unchanged)
  ├── rate-limiter.ts        (V1 — unchanged)
  ├── verifier.ts            (V1 — unchanged)
  ├── config.ts              (V1 — extended with V2 feature flags)
  ├── format.ts              (V1 — unchanged)
  ├── wrapup.ts              (V1 — extended with handoff)
  ├── isidore-cloud-session.ts (V1 — unchanged)
  │
  ├── memory.ts              (V2 Phase 1 — NEW)
  ├── embeddings.ts          (V2 Phase 1 — NEW)
  ├── context.ts             (V2 Phase 2 — NEW)
  ├── handoff.ts             (V2 Phase 2 — NEW)
  ├── prd-executor.ts        (V2 Phase 3 — NEW)
  ├── prd-parser.ts          (V2 Phase 3 — NEW)
  └── auto-detect.ts         (V2 Phase 4 — NEW)

data/
  └── memory.db              (V2 — gitignored, created at runtime)
```

**7 new files, 5 modified files, 0 deleted files.** This is extension, not rewrite.

---

## 1. Current State Analysis

### Module Map (16 modules)

| Module | Role | Lines | Limitations for V2 |
|--------|------|-------|---------------------|
| `bridge.ts` | Entry point, wires all components, graceful shutdown | ~80 | No health checks, no component isolation, blocking startup |
| `telegram.ts` | Grammy bot: auth, 20+ commands, message forwarding | ~400 | No PRD detection, no auto-project inference, no progress streaming |
| `claude.ts` | ClaudeInvoker: spawn CLI, timeout, stale session recovery | ~150 | No context injection, no streaming, no retry backoff |
| `session.ts` | SessionManager: single session file, archive | ~80 | No metadata (project, timestamp, summary), no locking |
| `projects.ts` | ProjectManager: registry, handoff state, git sync | ~200 | No auto-detection from PRD content, no state validation |
| `pipeline.ts` | PipelineWatcher: poll/dispatch/result, concurrency pool | ~550 | No PRD type, no memory injection, no task cancellation |
| `reverse-pipeline.ts` | ReversePipelineWatcher: Isidore→Gregor delegation | ~200 | No timeout enforcement, no workflow-aware routing |
| `orchestrator.ts` | TaskOrchestrator: DAG decomposition, step dispatch, recovery | ~400 | Static DAGs, no dynamic steps, no human escalation |
| `branch-manager.ts` | BranchManager: task branch checkout/release, lock files | ~150 | No runtime stale lock cleanup, no lock monitoring |
| `resource-guard.ts` | Memory-gated dispatch via `os.freemem()` | ~30 | Global only, no per-project budgets |
| `rate-limiter.ts` | Sliding window failure tracking, cooldown | ~60 | In-memory only, no per-endpoint tracking |
| `verifier.ts` | Result verification via separate Claude one-shot | ~80 | Hardcoded prompt, binary PASS/FAIL only |
| `config.ts` | Env vars with defaults, feature flags | ~80 | No runtime reload, no validation of integer fields |
| `format.ts` | compactFormat(), chunkMessage(), escMd() | ~100 | Hardcoded chunk size, regex-based stripping |
| `wrapup.ts` | Non-blocking git add -u + commit with branch guard | ~50 | No conflict detection, no push, 10s fixed timeout |
| `isidore-cloud-session.ts` | Utility | ~30 | — |

### What V1 Does Well (Keep)
- **Concurrency pool** with per-project locking (pipeline.ts)
- **Branch isolation** for task contamination prevention
- **Atomic writes** (.tmp → rename) for crash safety
- **Session-project affinity guard** prevents cross-project pollution
- **Per-task timeout/max-turns** for overnight PRD queues
- **DAG orchestrator** with crash recovery (persists to disk)
- **Reverse pipeline** for Gregor delegation
- **Feature flag system** — every component can be disabled
- **Auto-commit** after Telegram messages (lightweight, non-blocking)

---

## 2. Gap Analysis

### Four Vision Pillars

#### Pillar 1: Session/Context Continuity

| Aspect | Current | Gap | Proposed |
|--------|---------|-----|----------|
| Session persistence | Single UUID in file | No metadata, no searchable history | **Episodic memory store** — every interaction logged with embeddings |
| Cross-instance continuity | Manual CLAUDE.local.md via /wrapup | Requires human discipline | **Automatic handoff objects** written on session end/switch |
| Session search | Archive folder of UUID files | Can't find "that conversation about auth" | **Semantic search** over episodic memory via vector retrieval |
| Context across restarts | Session ID file survives | But Claude's internal context is lost | **Context reconstruction** from memory at session start |

#### Pillar 2: Autonomous Execution

| Aspect | Current | Gap | Proposed |
|--------|---------|-----|----------|
| PRD intake | Pipeline accepts JSON with `prompt` field | No PRD-specific parsing, no voice notes | **PRD intake layer** with type detection + parsing |
| Workspace setup | Manual /project switch | No auto-detection from PRD content | **Workspace orchestrator** infers project from PRD |
| Execution loop | Single claude -p one-shot | No multi-step with verification | **Algorithm executor** — ISC creation → build → verify loop |
| Progress reporting | Result written to results/ | No mid-execution updates | **Progress events** via Telegram + pipeline status files |
| Error recovery | Retry once (orchestrator) | No exponential backoff, no human escalation | **Graduated recovery** — retry → backoff → escalate |

#### Pillar 3: Memory System

| Aspect | Current | Gap | Proposed |
|--------|---------|-----|----------|
| Persistent memory | None (session ID only) | Can't remember past work | **Vector memory** with episodic + semantic tiers |
| Retrieval | — | — | **Semantic search** — query-time embedding match |
| Context injection | Full CLAUDE.md always loaded | Everything or nothing | **Selective injection** — only relevant memories loaded |
| Knowledge indexing | — | — | **Auto-index** pipeline results, commits, conversations |

#### Pillar 4: Zero Manual Management

| Aspect | Current | Gap | Proposed |
|--------|---------|-----|----------|
| Project switching | /project command required | Must know project name | **Auto-detect** from PRD content or keywords |
| Git sync | /done command required | Forgettable, manual | **Auto-push** on session end or handoff trigger |
| Session management | /new, /clear required | User must know when to reset | **Auto-session** — new PRD = new session with context |
| Knowledge sync | Explicit /done → sync-knowledge.sh | Manual step | **Auto-sync** on significant events |

---

## 3. Vector Memory Architecture

### Three-Tier Design

```
Tier 1: Lightweight (DEFAULT)          Tier 2: Moderate              Tier 3: Full
┌─────────────────────┐    ┌─────────────────────────┐    ┌──────────────────────┐
│ SQLite + sqlite-vec  │    │ + LanceDB / ChromaDB    │    │ + Cloud Vector DB    │
│ Bun native bun:sqlite│    │   Serverless or local   │    │   Pinecone/Weaviate  │
│ Ollama embeddings    │    │   server                │    │ + API embeddings     │
│ (or precomputed)     │    │ + Advanced search       │    │   (Voyage/OpenAI)    │
│                      │    │   (hybrid, reranking)   │    │ + Multi-region       │
│ RAM: ~50MB           │    │ RAM: ~300-500MB         │    │ RAM: ~50MB (client)  │
│ Disk: ~100MB         │    │ Disk: ~500MB-1GB        │    │ Disk: minimal        │
│ Dependencies: 0      │    │ Dependencies: 1 daemon  │    │ Dependencies: API key│
└─────────────────────┘    └─────────────────────────┘    └──────────────────────┘
```

### Memory Tiers (Conceptual)

The memory system has three conceptual tiers, independent of the storage backend:

1. **Working Memory** — Current session context. Lives in Claude's context window. Ephemeral.
2. **Episodic Memory** — Timestamped records of interactions, decisions, results. Searchable. Persistent.
3. **Semantic Memory** — Distilled knowledge: project patterns, user preferences, architectural decisions. Long-lived.

### Embedding Pipeline

**What gets embedded:**
- Every Telegram message + response pair (episodic)
- Pipeline task prompts + results (episodic)
- Workflow step descriptions + outcomes (episodic)
- Commit messages + diff summaries (semantic)
- PRD documents (semantic)
- CLAUDE.md / CLAUDE.local.md content (semantic, re-indexed on change)

**When:**
- After each Telegram response (async, non-blocking — like wrapup)
- After pipeline result is written
- After workflow completion
- On explicit /index command (manual trigger for bulk re-indexing)

**How (Tier 1 — Lightweight):**
```
Message pair → Ollama embed (nomic-embed-text, 768 dims)
            → Store in SQLite: text + embedding + metadata
            → Index via sqlite-vec virtual table
```

If Ollama is not available, fall back to precomputed embeddings from Claude's own summarization (no vector search, keyword search only). This ensures Tier 1 works with ZERO external dependencies.

### Storage Schema (SQLite)

```sql
-- Episodic memory: timestamped interaction records
CREATE TABLE episodes (
  id INTEGER PRIMARY KEY,
  timestamp TEXT NOT NULL,           -- ISO 8601
  source TEXT NOT NULL,              -- 'telegram' | 'pipeline' | 'orchestrator' | 'handoff'
  project TEXT,                      -- project name if known
  session_id TEXT,                   -- Claude session ID
  role TEXT NOT NULL,                -- 'user' | 'assistant' | 'system'
  content TEXT NOT NULL,             -- the actual text
  summary TEXT,                      -- 1-2 sentence summary (generated)
  metadata JSON,                     -- flexible: { taskId, workflowId, branch, ... }
  created_at TEXT DEFAULT (datetime('now'))
);

-- Vector index via sqlite-vec
CREATE VIRTUAL TABLE episode_embeddings USING vec0(
  episode_id INTEGER PRIMARY KEY,
  embedding FLOAT[768]               -- nomic-embed-text dimension
);

-- Semantic memory: distilled, long-lived knowledge
CREATE TABLE knowledge (
  id INTEGER PRIMARY KEY,
  domain TEXT NOT NULL,               -- 'project:<name>' | 'user' | 'system' | 'pattern'
  key TEXT NOT NULL,                  -- human-readable identifier
  content TEXT NOT NULL,
  confidence REAL DEFAULT 1.0,        -- 0.0-1.0, decays over time
  source_episode_ids JSON,            -- which episodes this was distilled from
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT                     -- optional TTL
);

CREATE VIRTUAL TABLE knowledge_embeddings USING vec0(
  knowledge_id INTEGER PRIMARY KEY,
  embedding FLOAT[768]
);

-- Temporal decay: score = base_relevance * exp(-lambda * age_days)
-- lambda = 0.023 gives ~50% weight at 30 days, ~25% at 60 days
```

### Retrieval API

```typescript
interface MemoryQuery {
  query: string;                     // natural language query
  project?: string;                  // filter by project
  source?: string;                   // filter by source
  maxResults?: number;               // default 5
  maxTokens?: number;                // budget for injected context (default 2000)
  recencyBias?: number;              // 0.0-1.0, how much to favor recent (default 0.5)
}

interface MemoryResult {
  episodes: Array<{
    content: string;
    summary: string;
    similarity: number;
    age_days: number;
    source: string;
    project: string;
  }>;
  knowledge: Array<{
    key: string;
    content: string;
    domain: string;
    confidence: number;
  }>;
  totalTokens: number;              // token count of injected context
}
```

**Retrieval flow:**
1. Embed the query
2. Search episode_embeddings + knowledge_embeddings (top-K each)
3. Apply temporal decay scoring
4. Apply project/source filters
5. Truncate to maxTokens budget
6. Return structured result for context injection

### New Module: `src/memory.ts`

```
MemoryStore class:
  - constructor(dbPath: string, ollamaUrl?: string)
  - record(episode: Episode): Promise<void>          // async, non-blocking
  - query(q: MemoryQuery): Promise<MemoryResult>     // sync retrieval
  - distill(episodeIds: number[]): Promise<void>      // extract knowledge
  - prune(olderThan: Date): Promise<number>           // cleanup
  - reindex(): Promise<void>                          // bulk re-embed
  - getStats(): MemoryStats                           // dashboard data
```

---

## 4. Autonomous PRD Executor

### Intake Layer

PRDs arrive through three channels:

1. **Telegram message** — Long message detected as PRD (heuristic: >500 chars + contains structured indicators like "Requirements:", numbered lists, or explicit "PRD")
2. **Pipeline task** — JSON with `type: "prd"` or detected as PRD from prompt content
3. **Voice note** — Telegram voice message → transcribed → parsed as PRD (requires Whisper or similar; Phase 4 addition)

### PRD Parser

Converts unstructured/semi-structured text into a structured work plan:

```typescript
interface ParsedPRD {
  title: string;                      // extracted or generated
  description: string;                // full PRD text preserved
  project: string | null;             // auto-detected or null (ask user)
  requirements: string[];             // explicit requirements extracted
  constraints: string[];              // explicit constraints extracted
  estimatedComplexity: 'simple' | 'medium' | 'complex';
  suggestedSteps: Array<{
    description: string;
    assignee: 'isidore' | 'gregor' | 'ask';
    dependsOn: string[];
  }>;
}
```

**How parsing works:**
- Claude one-shot with structured output schema
- Prompt includes: PRD text + project registry (for auto-detection) + context from memory
- Returns ParsedPRD JSON
- If project can't be auto-detected → ask user via Telegram

### Workspace Orchestrator

Once PRD is parsed:

```
1. Detect project → projects.getProject(parsedPrd.project)
   ├─ Known project → switch to it (auto /project)
   ├─ Unknown but inferable → ask user "Is this for project X?"
   └─ Unknown → ask user "Which project?"

2. Setup workspace
   ├─ Ensure project cloned (ensureCloned)
   ├─ Git pull latest (syncPull)
   ├─ Create feature branch: prd/<slug>
   └─ Set Claude cwd

3. Load context
   ├─ Query memory for relevant episodes + knowledge
   ├─ Read project's CLAUDE.md
   └─ Construct context prefix (see Section 6)

4. Create execution plan
   ├─ If simple (1-3 steps) → execute directly
   ├─ If medium (4-10 steps) → create workflow via orchestrator
   └─ If complex (10+ steps) → decompose into sub-PRDs, create parent workflow
```

### Execution Loop

```
┌─────────────────────────────────────────┐
│           PRD EXECUTION LOOP            │
│                                         │
│  1. Parse PRD → structured plan         │
│  2. Setup workspace (project/branch)    │
│  3. Create ISC from requirements        │
│  4. For each step:                      │
│     a. Inject relevant memory context   │
│     b. Execute via claude -p (or CLI)   │
│     c. Verify step output               │
│     d. Record to episodic memory        │
│     e. Report progress via Telegram     │
│     f. If failure → retry/backoff       │
│  5. Verify all ISC criteria             │
│  6. Write result to pipeline results/   │
│  7. Commit + push                       │
│  8. Notify user via Telegram            │
│  9. Record completion in memory         │
└─────────────────────────────────────────┘
```

### Progress Reporting

During execution, user receives Telegram updates:

```
[PRD] "Auth System Refactor" — Started
  Project: my-pai-cloud-solution
  Branch: prd/auth-refactor
  Steps: 5 total, 0 completed

[PRD] Step 1/5 completed — "Analyze current auth flow"
  Duration: 45s | ISC: 2/8 passing

[PRD] Step 3/5 failed — retrying (1/3)
  Error: Rate limit hit, backing off 60s

[PRD] "Auth System Refactor" — Completed
  Duration: 12m 34s | ISC: 8/8 passing
  Branch: prd/auth-refactor (ready for review)
  Result: /var/lib/pai-pipeline/results/prd-auth-refactor.json
```

### Error Recovery

| Failure | Action | Escalation |
|---------|--------|------------|
| Rate limit (429) | Exponential backoff: 30s, 60s, 120s | After 3 retries → pause + notify user |
| Timeout | Kill process, retry with increased timeout | After 2 retries → notify user, offer manual intervention |
| Verification fail | Retry step with "fix the following issues: ..." prompt | After 2 retries → mark step failed, continue if possible |
| Project not found | Ask user via Telegram | Block until response |
| Git conflict | Stash changes, pull, re-apply | If conflict persists → notify user |
| Memory DB error | Log warning, continue without memory | Non-blocking — graceful degradation |

### New Module: `src/prd-executor.ts`

```
PRDExecutor class:
  - constructor(config, claude, projects, memory, orchestrator, telegram)
  - execute(prd: string, source: 'telegram' | 'pipeline'): Promise<PRDResult>
  - parse(text: string): Promise<ParsedPRD>
  - detectProject(prd: ParsedPRD): Promise<string | null>
  - setupWorkspace(project: string, slug: string): Promise<void>
  - reportProgress(update: ProgressUpdate): Promise<void>
```

---

## 5. Handoff Mechanism

### Handoff Object

The core data structure that transfers between instances:

```typescript
interface HandoffObject {
  // Identity
  version: 1;
  timestamp: string;                  // ISO 8601
  direction: 'local-to-cloud' | 'cloud-to-local';

  // Session state
  activeProject: string | null;
  sessionId: string | null;
  branch: string;                     // current git branch
  uncommittedChanges: boolean;

  // Work state
  activePRD: string | null;           // PRD ID if mid-execution
  activeWorkflows: string[];          // workflow IDs
  pendingTasks: string[];             // pipeline task IDs in-flight

  // Context summary
  recentWorkSummary: string;          // 2-3 sentences of what was done
  nextSteps: string[];                // what the receiving instance should do
  blockers: string[];                 // known blockers

  // Memory pointer
  lastEpisodeId: number;              // for incremental memory sync
  memoryDbHash: string;               // to detect memory divergence
}
```

### Automatic Triggers

| Trigger | Direction | Action |
|---------|-----------|--------|
| User sends `/handoff` | current → other | Write handoff object, push, notify |
| Bridge shutdown (SIGTERM) | cloud → local | Write handoff, push (best-effort) |
| 30 min inactivity (Telegram) | cloud → standby | Write handoff (don't push — standby only) |
| First message after inactivity | standby → active | Check for incoming handoff, reconstruct context |
| `/project` switch on other instance | other → current | Pull handoff for that project |
| Pipeline task from other instance | implicit | Handoff context embedded in task metadata |

### Handoff File Locations

```
~/.claude/handoff/
  ├── outgoing.json          # Last handoff we wrote (for crash recovery)
  ├── incoming.json          # Last handoff we received
  └── history/               # Archived handoffs (timestamped)

~/pai-knowledge/HANDOFF/
  ├── handoff-state.json     # Current handoff (shared via git)
  ├── cloud-to-local.json    # Cloud's latest handoff for local
  └── local-to-cloud.json    # Local's latest handoff for cloud
```

### Crash Recovery

| Failure Mode | Recovery |
|-------------|----------|
| Bridge dies mid-execution | On restart: read outgoing.json, check if push succeeded, retry if not |
| Handoff push fails (network) | Queue for retry on next successful network operation |
| Incoming handoff is stale (>24h) | Log warning, use handoff but flag staleness to user |
| Memory DB diverged | Last-write-wins for episodes; knowledge merged by key with latest timestamp |
| Git conflict in handoff files | Handoff objects are write-once (timestamped); no merge needed |

### Handoff Flow: Local → Cloud

```
LOCAL ISIDORE                          CLOUD ISIDORE
─────────────                          ──────────────
User: /handoff
  │
  ├─ git add -u && commit
  ├─ git push
  ├─ Write handoff object
  │   (session, project, summary,
  │    ISC state, memory pointer)
  ├─ Push to pai-knowledge repo
  ├─ Notify via Telegram:                    │
  │   "Handoff ready for Cloud"              │
  │                                          │
  │                              First message arrives
  │                                          │
  │                              ├─ Pull pai-knowledge
  │                              ├─ Read incoming handoff
  │                              ├─ Switch to handoff.project
  │                              ├─ Resume session (--resume id)
  │                              ├─ Query memory for context
  │                              ├─ Inject: handoff summary +
  │                              │  memory results + CLAUDE.md
  │                              └─ Ready to work
```

### New Module: `src/handoff.ts`

```
HandoffManager class:
  - constructor(config, sessions, projects, memory)
  - createHandoff(direction): Promise<HandoffObject>
  - writeHandoff(handoff: HandoffObject): Promise<void>
  - readIncomingHandoff(): Promise<HandoffObject | null>
  - applyHandoff(handoff: HandoffObject): Promise<void>
  - pushHandoff(): Promise<void>        // git push to pai-knowledge
  - pullHandoff(): Promise<void>        // git pull from pai-knowledge
```

---

## 6. Context Window Management

### Context Budget Allocation

Claude's effective context window is ~100K tokens. Budget allocation:

| Zone | Budget | Content | Load Strategy |
|------|--------|---------|---------------|
| **System** | ~3K tokens | CLAUDE.md (project-specific) | Always loaded (Claude Code default) |
| **Memory injection** | ~2K tokens | Relevant episodes + knowledge from vector search | On-demand per message |
| **Handoff context** | ~500 tokens | Summary from last handoff (if fresh) | On session start only |
| **Working context** | ~90K tokens | Actual conversation history | Managed by Claude Code |
| **Tool definitions** | ~2K tokens | MCP-loaded tools (lazy) | On first tool use |
| **Reserved** | ~2.5K tokens | Safety margin | — |

### Selective Injection Strategy

**Per Telegram message:**
```
1. User sends message
2. Embed message text
3. Query memory: top 3 episodes + top 2 knowledge items
4. Filter: same project preferred, temporal decay applied
5. Construct context prefix:
   "[Memory context — auto-retrieved, do not repeat to user]
    Recent relevant work:
    - {episode 1 summary} ({age} ago)
    - {episode 2 summary} ({age} ago)
    Relevant knowledge:
    - {knowledge 1}
    - {knowledge 2}"
6. Prepend to user message before sending to Claude
```

**Per pipeline task:**
```
1. Task arrives with prompt
2. Query memory: project-filtered, top 5 episodes
3. Inject as task context (alongside existing context field)
4. Execute claude -p with enriched prompt
```

**What does NOT get injected:**
- Full conversation histories (too large)
- Raw pipeline results (store reference, not content)
- Other project's memories (strict project filtering)
- System-level memories when working on specific project

### Summarization Strategy

**When to compress:**
- Session history exceeds 50K tokens → summarize oldest 50% into ~2K summary
- Handoff objects always contain a summary (not full history)
- Pipeline results >2000 chars get summarized before memory storage

**What to keep verbatim:**
- Last 10 messages in current session
- ISC criteria and verification results
- Error messages and stack traces
- User preferences and explicit instructions

**What to summarize:**
- Earlier conversation turns → "discussed X, decided Y, implemented Z"
- Long Claude responses → first paragraph + key decisions
- Pipeline results → summary field + artifact list

### MCP Integration (Future — Phase 4)

Current tools embedded in Claude's context: git, filesystem, test runners. These consume ~2-5K tokens per invocation just for tool definitions.

**Proposed:** Wrap as MCP servers for lazy loading:
- `mcp://git-local` — git operations
- `mcp://pai-pipeline` — pipeline task submission/status
- `mcp://pai-memory` — memory query/store

**Benefit:** Tool definitions only load when Claude requests them. Estimated context savings: ~3-5K tokens per message.

**Timeline:** Phase 4 (after core memory + autonomy are working)

### Context Injection Flow

```
User Message
    │
    ▼
┌──────────────┐     ┌──────────────┐
│ Embed query  │────▶│ Memory Store │
│ (768 dims)   │     │  (SQLite)    │
└──────────────┘     └──────┬───────┘
                            │
                    Top-K results
                    + temporal decay
                    + project filter
                            │
                            ▼
                   ┌────────────────┐
                   │ Token budget   │
                   │ check (2K max) │
                   └───────┬────────┘
                           │
                           ▼
              ┌─────────────────────────┐
              │ Context prefix:         │
              │ [Memory] relevant work  │
              │ [Handoff] if fresh      │
              │ [Knowledge] patterns    │
              └────────────┬────────────┘
                           │
                           ▼
              ┌─────────────────────────┐
              │ Claude invocation:      │
              │ --resume <session>      │
              │ -p "prefix + message"   │
              └─────────────────────────┘
```

---

## 7. Agent Framework Comparison

### Framework Analysis

#### OpenClaw Bot

| Pattern | Adopt/Skip | Rationale |
|---------|-----------|-----------|
| Daily logs + curated long-term memory | **Adopt** | Episodic + semantic tier maps directly to our design |
| Temporal decay (30-90 day half-life) | **Adopt** | Prevents stale memories from dominating results |
| Plain Markdown/YAML storage | **Skip** | SQLite + vector search is more powerful and equally portable |
| Agent routing by capability | **Adapt** | We route by assignee (isidore/gregor), could add capability-based routing later |

#### Nightwire

| Pattern | Adopt/Skip | Rationale |
|---------|-----------|-----------|
| Vector embeddings in SQLite (ChromaDB wrapper) | **Adopt** | sqlite-vec gives us this natively in Bun |
| Automatic session grouping (30min timeout) | **Adopt** | Natural session boundary detection |
| Token budgeting (1500 max context injection) | **Adopt** | Prevents memory from consuming working context |
| Parallel workers (up to 10) | **Adapt** | Our concurrency pool already does this; increase default from 1 |
| Quality gates with test baselines | **Adopt** | Distinguish new failures from pre-existing |
| Auto-recovery with 2 retries | **Already have** | Orchestrator retry logic exists |

#### OpenHands

| Pattern | Adopt/Skip | Rationale |
|---------|-----------|-----------|
| Docker workspace isolation | **Skip** | Branch isolation achieves same goal without Docker overhead |
| SSH-based remote development | **Skip** | We already run on VPS directly |
| Stuck-behavior detection | **Adopt** | Monitor for repeated tool failures; auto-escalate |
| Async execution with progress reporting | **Adopt** | PRD executor needs this |

#### Claude Code SDK (Native)

| Pattern | Adopt/Skip | Rationale |
|---------|-----------|-----------|
| `--resume` for session continuity | **Already use** | Core of our session model |
| `--continue` for latest conversation | **Adopt** | Useful for recovery after crash |
| MCP server integration | **Adopt (Phase 4)** | Reduces context bloat from tool definitions |
| Lazy MCP loading | **Adopt (Phase 4)** | ~95% context savings on tool definitions |
| `--output-format json` | **Already use** | Structured output parsing |

### Our Unique Differentiators (Keep/Strengthen)

1. **Cross-agent pipeline** (Isidore ↔ Gregor) — No other framework has built-in multi-instance delegation
2. **Branch isolation** — Lightweight alternative to Docker containers
3. **DAG orchestrator with reverse pipeline** — Bidirectional task routing
4. **Per-task timeout/max-turns** — Fine-grained resource control per task
5. **Telegram-native interface** — Mobile-first, not web-first

---

## 8. Zero-Manual-Management Design

### Current Commands → Automation Path

| Command | Current (Manual) | V2 (Automated) | Remains Manual? |
|---------|-----------------|----------------|-----------------|
| `/project <name>` | Switch project context | Auto-detected from PRD content or message context | Yes (override) |
| `/new` | Archive session, start fresh | New PRD = new session automatically | Yes (force reset) |
| `/clear` | Same as /new | Same automation as /new | Yes (force reset) |
| `/done` | Git commit + push + sync | Auto on handoff, session end, PRD completion | Yes (force sync) |
| `/handoff` | Done + status summary | Auto on inactivity timeout or instance switch | Yes (force handoff) |
| `/compact` | Compress Claude context | Auto when context exceeds 50K tokens | Yes (force compact) |
| `/workflow create` | Decompose task to DAG | PRD parser auto-creates workflow for complex tasks | Yes (force decompose) |
| `/delegate` | Send task to Gregor | PRD executor auto-delegates Gregor-appropriate steps | Yes (force delegate) |
| `/oneshot` | No-session invocation | Pipeline tasks are already one-shot | N/A |
| `/quick` | Lightweight model | Auto-selected for simple queries (heuristic) | Yes (force quick) |

### "PRD Arrives" — Automatic Flow

```
1. PRD arrives (Telegram long message or pipeline type:"prd")
2. Detect PRD type (heuristic: length, structure indicators, explicit markers)
3. Parse PRD → ParsedPRD (Claude one-shot)
4. Auto-detect project from content + project registry
   └─ If ambiguous → ask user via Telegram (single question, not command)
5. Auto-switch project (save current session, load target)
6. Auto-create branch: prd/<slug>
7. Auto-pull latest code
8. Query memory for relevant context
9. Create workflow (if complex) or execute directly (if simple)
10. Execute with progress reporting
11. On completion: commit, push, write result, notify user
12. Auto-handoff object written (for next instance)
```

### What Stays Manual (and Why)

| Command | Why Manual | Automation Risk |
|---------|-----------|-----------------|
| `/project` | User may want to switch for browsing, not working | Auto-switch to wrong project could lose context |
| `/new` / `/clear` | Destructive — archives session | Auto-clear could destroy useful context |
| `/deleteproject` | Destructive | Should always require confirmation |
| `/newproject` | Creates GitHub repos, VPS dirs | Too impactful for auto |
| `/cancel` | Stops workflows | Could cancel intended work |
| `/branches` | Diagnostic | No automation needed |
| `/pipeline` | Diagnostic | No automation needed |
| `/status` | Diagnostic | No automation needed |

---

## 9. Gregor Integration

### Per-Subsystem Interaction

#### Memory System + Gregor

- **Indexing:** All pipeline task prompts + results from Gregor are recorded in episodic memory
- **Tagging:** Episodes tagged `source: 'pipeline', from: 'gregor'`
- **Retrieval:** When Isidore works on a project Gregor has touched, relevant Gregor episodes surface in memory query
- **Knowledge distillation:** Patterns from Gregor collaboration (e.g., "Gregor prefers X approach for Y") become semantic knowledge

#### PRD Executor + Gregor

- **Gregor-submitted PRDs:** Pipeline tasks with `type: "prd"` from Gregor get the same autonomous treatment
- **Step delegation:** PRD executor's workflow assigns `assignee: "gregor"` for appropriate steps (based on capability matching or explicit instruction)
- **Result routing:** Gregor step results flow back through reverse pipeline → orchestrator → PRD executor

#### Handoff + Gregor

- **No direct handoff:** Gregor doesn't use the handoff mechanism (it's for Isidore local ↔ cloud only)
- **But:** Pipeline context includes handoff-like metadata — `from`, `context`, `escalation` fields carry state
- **Memory bridge:** When Isidore hands off to local, Gregor collaboration context is in the memory DB (shared via git or DB sync)

#### Context Management + Gregor

- **Pipeline tasks get memory injection:** Before dispatching a Gregor-originated task, Isidore queries memory for relevant context and enriches the prompt
- **But no session sharing:** Gregor tasks remain one-shot. Session continuity is per-instance only.

---

## 10. Migration Path

### Phase 1: Memory Layer (sqlite-vec + episodic logging)

**New files:**
- `src/memory.ts` — MemoryStore class
- `src/embeddings.ts` — Embedding provider abstraction (Ollama primary, fallback to keyword)
- `data/memory.db` — SQLite database (gitignored)

**Modified files:**
- `src/bridge.ts` — Initialize MemoryStore, wire to components
- `src/telegram.ts` — Record episodes after each message/response pair
- `src/pipeline.ts` — Record task prompts + results as episodes
- `src/config.ts` — Add MEMORY_ENABLED, MEMORY_DB_PATH, OLLAMA_URL feature flags

**Effort:** 2-3 days
**Dependencies:** None (Bun native SQLite, sqlite-vec extension)
**Risk:** Low — additive only, feature-flagged, graceful degradation if Ollama unavailable

### Phase 2: Context Management (selective injection + handoff objects)

**New files:**
- `src/handoff.ts` — HandoffManager class
- `src/context.ts` — ContextBuilder class (assembles context prefix from memory + handoff)

**Modified files:**
- `src/claude.ts` — Accept context prefix in `send()` and `oneShot()` signatures
- `src/telegram.ts` — Query memory + build context before forwarding to Claude
- `src/pipeline.ts` — Inject memory context into pipeline task prompts
- `src/wrapup.ts` — Write handoff object alongside git commit

**Effort:** 3-4 days
**Dependencies:** Phase 1 (memory must exist to query)
**Risk:** Medium — context injection changes Claude's behavior. Need careful prompt engineering to avoid confusion.

### Phase 3: Autonomous PRD Executor

**New files:**
- `src/prd-executor.ts` — PRDExecutor class
- `src/prd-parser.ts` — PRD parsing + project detection logic

**Modified files:**
- `src/telegram.ts` — Add PRD detection in message handler, /prd command
- `src/pipeline.ts` — Route `type: "prd"` tasks to PRD executor
- `src/orchestrator.ts` — Accept pre-parsed steps from PRD executor

**Effort:** 5-7 days
**Dependencies:** Phase 1 + Phase 2 (memory + context injection needed for autonomous execution)
**Risk:** High — most novel component. PRD parsing accuracy, project detection, workspace setup all have failure modes. Needs extensive testing.

### Phase 4: Full Automation + Polish

**New files:**
- `src/auto-detect.ts` — Auto-project detection, auto-session management
- MCP server wrappers (if pursued)

**Modified files:**
- `src/telegram.ts` — Auto-project switching, auto-session management, voice transcription
- `src/projects.ts` — Auto-detection from message content
- `src/config.ts` — AUTO_PROJECT_DETECT, AUTO_SESSION, MCP_ENABLED flags

**Effort:** 3-5 days
**Dependencies:** Phases 1-3
**Risk:** Medium — auto-detection can be wrong. Must always allow manual override.

### Phase Summary

| Phase | What | Effort | Dependencies | Risk |
|-------|------|--------|-------------|------|
| **1. Memory** | sqlite-vec + episodic logging + retrieval | 2-3 days | None | Low |
| **2. Context** | Selective injection + handoff objects | 3-4 days | Phase 1 | Medium |
| **3. PRD Executor** | Autonomous PRD parsing + execution | 5-7 days | Phase 1+2 | High |
| **4. Automation** | Auto-detect, auto-session, auto-handoff | 3-5 days | Phase 1-3 | Medium |
| **Total** | | **13-19 days** | | |

Each phase is independently deployable and feature-flagged. Phase 1 can ship alone and provide value immediately.

---

## 11. Resource Estimates

### Per-Component (Lightweight Tier)

| Component | RAM (steady) | RAM (peak) | Disk | CPU (idle) | CPU (active) |
|-----------|-------------|-----------|------|-----------|-------------|
| **MemoryStore** (SQLite) | ~20MB | ~50MB (bulk query) | ~100MB (10K episodes) | 0% | 1-2% (query) |
| **Embeddings** (Ollama) | 0 (not always loaded) | ~200MB (during embed) | ~500MB (model file) | 0% | 5-10% (embed) |
| **HandoffManager** | ~2MB | ~5MB | ~1MB | 0% | <1% |
| **ContextBuilder** | ~5MB | ~10MB | 0 | 0% | <1% |
| **PRDExecutor** | ~5MB | ~20MB | 0 | 0% | 1-2% |
| **Current bridge** | ~50MB | ~100MB | ~10MB | 1% | 5-10% |

### Total VPS Overhead by Tier

| Tier | Additional RAM | Additional Disk | Notes |
|------|---------------|----------------|-------|
| **Lightweight** | +30MB steady, +250MB peak | +600MB (Ollama model) | Peak = during embedding only |
| **Moderate** | +300-500MB (LanceDB/Chroma) | +1-2GB | Running vector DB daemon |
| **Full** | +50MB (API client) | Minimal | External API, no local storage |

**Conclusion:** Lightweight tier fits comfortably on VPS. Peak memory (+250MB) occurs only during embedding operations, which are async and non-blocking. The ~500MB Ollama model file is the biggest disk cost.

**Without Ollama (absolute minimum):** If Ollama is too heavy, use keyword-based search (no vectors). This loses semantic search quality but requires zero additional resources. Embeddings can be added later when Ollama is installed.

---

## 12. Data Flow Diagrams

### (1) PRD Intake → Execution

```
 Telegram                    Pipeline
 (long msg)                  (type:"prd")
     │                           │
     ▼                           ▼
 ┌───────────────────────────────────┐
 │         PRD DETECTOR              │
 │  (heuristic: length, structure,   │
 │   keywords, explicit markers)     │
 └──────────────┬────────────────────┘
                │
                ▼
 ┌───────────────────────────────────┐
 │         PRD PARSER                │
 │  Claude one-shot → ParsedPRD      │
 │  (title, project, requirements,   │
 │   constraints, steps)             │
 └──────────────┬────────────────────┘
                │
         ┌──────┴──────┐
         │  Project     │
         │  detected?   │
         ├──YES─────────┤
         │              │
         │   ┌──────┐   │
         │   │ ASK  │◀──NO
         │   │ USER │
         │   └──┬───┘
         │      │
         ▼      ▼
 ┌───────────────────────────────────┐
 │      WORKSPACE ORCHESTRATOR       │
 │  1. Switch project                │
 │  2. Git pull                      │
 │  3. Create branch: prd/<slug>     │
 │  4. Query memory for context      │
 └──────────────┬────────────────────┘
                │
         ┌──────┴──────┐
         │ Complexity? │
         ├─simple──────┤──medium/complex──┐
         │             │                  │
         ▼             ▼                  ▼
    Direct exec    Orchestrator      Sub-PRDs
    (claude -p)    (DAG workflow)    (recursive)
         │             │                  │
         └──────┬──────┘──────────────────┘
                │
                ▼
 ┌───────────────────────────────────┐
 │      PER-STEP EXECUTION           │
 │  1. Inject memory context         │
 │  2. claude -p (with context)      │
 │  3. Verify step output            │
 │  4. Record to memory              │
 │  5. Report progress (Telegram)    │
 │  6. Handle errors (retry/backoff) │
 └──────────────┬────────────────────┘
                │
                ▼
 ┌───────────────────────────────────┐
 │         COMPLETION                │
 │  1. Verify all ISC criteria       │
 │  2. Git commit + push             │
 │  3. Write result (pipeline)       │
 │  4. Record in memory              │
 │  5. Notify user (Telegram)        │
 │  6. Write handoff object          │
 └───────────────────────────────────┘
```

### (2) Memory Retrieval During Execution

```
 User message / Task prompt
         │
         ▼
 ┌────────────────┐     ┌─────────────────┐
 │ Embed query    │────▶│ Ollama API      │
 │ (text → vec)   │     │ nomic-embed-text│
 └────────┬───────┘     └─────────────────┘
          │
          │ 768-dim vector
          ▼
 ┌────────────────┐
 │ sqlite-vec     │
 │ KNN search     │──── episode_embeddings (top 5)
 │ (cosine sim)   │──── knowledge_embeddings (top 3)
 └────────┬───────┘
          │
          │ raw results
          ▼
 ┌────────────────┐
 │ Post-process   │
 │ 1. Temporal    │     score = similarity * exp(-0.023 * age_days)
 │    decay       │
 │ 2. Project     │     filter: same project preferred
 │    filter      │
 │ 3. Token       │     truncate to 2000 token budget
 │    budget      │
 └────────┬───────┘
          │
          │ MemoryResult
          ▼
 ┌────────────────┐
 │ Context prefix │
 │ [Memory: ...]  │──── Prepended to user message
 │ [Knowledge: .] │     before Claude invocation
 └────────────────┘
```

### (3) Handoff: Local ↔ Cloud

```
 LOCAL ISIDORE                              CLOUD ISIDORE
 ═════════════                              ═════════════

 User: /handoff (or auto-trigger)
     │
     ├─ git add -u && commit
     ├─ git push origin
     │
     ├─ Create HandoffObject:
     │   { project, session, branch,
     │     summary, nextSteps, blockers,
     │     lastEpisodeId, memoryDbHash }
     │
     ├─ Write ~/.claude/handoff/outgoing.json
     ├─ Write ~/pai-knowledge/HANDOFF/
     │        local-to-cloud.json
     ├─ git push pai-knowledge
     │
     ├─ Telegram: "Handoff ready             │
     │   for Cloud Isidore"                  │
     │                                       │
     │                           ┌───────────┴───────────┐
     │                           │ Trigger: first msg    │
     │                           │ or startup detection  │
     │                           └───────────┬───────────┘
     │                                       │
     │                           ├─ git pull pai-knowledge
     │                           ├─ Read local-to-cloud.json
     │                           │
     │                           ├─ Apply handoff:
     │                           │   1. Switch project
     │                           │   2. Restore session ID
     │                           │   3. Git checkout branch
     │                           │   4. Sync memory DB
     │                           │      (if diverged)
     │                           │
     │                           ├─ Query memory:
     │                           │   recent episodes for
     │                           │   this project
     │                           │
     │                           ├─ Build context:
     │                           │   handoff.summary +
     │                           │   memory results +
     │                           │   CLAUDE.md
     │                           │
     │                           └─ Ready to work
     │                              (with full context)
```

### (4) Context Injection Pipeline

```
 ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
 │ CLAUDE.md   │  │ Handoff obj │  │ Memory query│
 │ (always)    │  │ (if fresh)  │  │ (per msg)   │
 │ ~3K tokens  │  │ ~500 tokens │  │ ~2K tokens  │
 └──────┬──────┘  └──────┬──────┘  └──────┬──────┘
        │                │                │
        └────────┬───────┘────────────────┘
                 │
                 ▼
        ┌────────────────┐
        │ Context Budget │
        │ Manager        │
        │                │
        │ Total: ~5.5K   │
        │ tokens max     │
        │                │
        │ Priority:      │
        │ 1. CLAUDE.md   │ ← never skipped
        │ 2. Memory      │ ← truncated if over budget
        │ 3. Handoff     │ ← dropped if >24h stale
        └────────┬───────┘
                 │
                 ▼
        ┌────────────────┐
        │ Claude invoke  │
        │                │
        │ --resume <sid> │
        │ -p "[context]  │ ← injected prefix (invisible to user)
        │     [message]" │ ← user's actual message
        │                │
        │ cwd: project/  │
        └────────────────┘
                 │
                 ▼
        ┌────────────────┐
        │ Response       │
        │                │
        │ ├─ Format      │
        │ ├─ Chunk       │
        │ ├─ Send TG     │
        │ └─ Record      │──── Memory: store episode
        │    episode     │     (async, non-blocking)
        └────────────────┘
```

---

## 13. Modular Plugin Architecture

### Design Philosophy

The system uses a **file-based plugin architecture** inspired by VS Code extensions. Plugins are self-contained directories that register themselves via a manifest file. The core system provides interfaces; plugins implement them. Features can be added, removed, swapped, or upgraded by dropping files into a directory.

### Core / Plugin Boundary

```
┌─────────────────────────────────────────────────────────┐
│                     CORE LAYER                          │
│  (Always present. Cannot be removed. ~16 modules)       │
│                                                         │
│  bridge.ts   telegram.ts   claude.ts   session.ts       │
│  projects.ts pipeline.ts   orchestrator.ts              │
│  config.ts   format.ts     wrapup.ts                    │
│  branch-manager.ts  resource-guard.ts  rate-limiter.ts  │
│  verifier.ts  reverse-pipeline.ts                       │
│                                                         │
│  Provides: PluginHost, EventBus, ConfigStore, Logger    │
└────────────────────┬────────────────────────────────────┘
                     │ Plugin API (one-way dependency)
                     ▼
┌─────────────────────────────────────────────────────────┐
│                    PLUGIN LAYER                         │
│  (Optional. Each plugin is independent. Feature-flagged)│
│                                                         │
│  plugins/                                               │
│    memory/          → Vector memory (Phase 1)           │
│    context/         → Context injection (Phase 2)       │
│    handoff/         → Cross-instance handoff (Phase 2)  │
│    prd-executor/    → Autonomous PRD execution (Phase 3)│
│    auto-detect/     → Auto-project/session (Phase 4)    │
│    hzl-bridge/      → HZL task ledger integration       │
│    persona/         → Agent persona framework           │
│    dashboard/       → Web status dashboard              │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

**Rule: Core knows nothing about plugins. Plugins depend on core interfaces only. Plugins never depend on each other directly — they communicate through the EventBus.**

### Plugin Manifest

Each plugin directory contains a `plugin.yaml` manifest:

```yaml
# plugins/memory/plugin.yaml
name: "memory"
version: "1.0.0"
description: "Vector memory with episodic and semantic tiers"
author: "Isidore"

# Feature flag — plugin is disabled if this env var is falsy
feature_flag: "MEMORY_ENABLED"

# Lifecycle entry point
entry: "./index.ts"

# Core interfaces this plugin requires
requires:
  - "EventBus"
  - "ConfigStore"
  - "Logger"

# Events this plugin emits
emits:
  - "memory:episode-recorded"
  - "memory:knowledge-distilled"
  - "memory:query-completed"

# Events this plugin listens to
listens:
  - "telegram:message-received"
  - "telegram:response-sent"
  - "pipeline:task-completed"
  - "pipeline:task-failed"

# Optional: other plugins this one benefits from (soft dependency)
enhances:
  - "context"    # Memory enhances context injection
  - "handoff"    # Memory enhances handoff with history

# Resource requirements
resources:
  disk: "100MB"     # For SQLite database
  ram_steady: "20MB"
  ram_peak: "250MB"  # During Ollama embedding
```

### Plugin Registration API

```typescript
// src/plugin-host.ts — Core provides this

interface PluginManifest {
  name: string;
  version: string;
  description: string;
  feature_flag: string;
  entry: string;
  requires: string[];
  emits: string[];
  listens: string[];
  enhances?: string[];
  resources?: { disk?: string; ram_steady?: string; ram_peak?: string };
}

interface PluginContext {
  config: ConfigStore;        // Read-only access to config
  logger: Logger;             // Scoped logger: logger.info() → "[memory] ..."
  events: EventBus;           // Subscribe to and emit events
  getPluginState<T>(): T;     // Plugin-private persistent state
  setPluginState<T>(s: T): void;
}

interface Plugin {
  manifest: PluginManifest;

  // Lifecycle hooks
  init(ctx: PluginContext): Promise<void>;     // Called once on load
  start(ctx: PluginContext): Promise<void>;    // Called after all plugins init
  stop(ctx: PluginContext): Promise<void>;     // Called on graceful shutdown
  destroy(ctx: PluginContext): Promise<void>;  // Called for cleanup

  // Health check (optional)
  health?(): Promise<{ ok: boolean; details?: Record<string, unknown> }>;
}
```

### Plugin Lifecycle

```
1. Discovery:  Scan plugins/ directory for plugin.yaml manifests
2. Filter:     Skip plugins whose feature_flag env var is falsy
3. Sort:       Topological sort by `requires` (ensures dependencies init first)
4. Load:       Import entry file, validate Plugin interface
5. Init:       Call plugin.init(ctx) — setup resources, open DBs
6. Start:      Call plugin.start(ctx) — begin listening to events
7. (Runtime)   Plugins operate via EventBus messages
8. Stop:       Call plugin.stop(ctx) — flush buffers, close connections
9. Destroy:    Call plugin.destroy(ctx) — cleanup temporary files
```

### EventBus (Core ↔ Plugin Communication)

```typescript
// src/event-bus.ts — Decoupled pub/sub for all modules

interface EventBus {
  emit(event: string, data: unknown): void;
  on(event: string, handler: (data: unknown) => void): void;
  off(event: string, handler: (data: unknown) => void): void;
  once(event: string, handler: (data: unknown) => void): void;
}

// Event naming convention: "module:action"
// Core events:
//   "telegram:message-received"
//   "telegram:response-sent"
//   "pipeline:task-received"
//   "pipeline:task-completed"
//   "pipeline:task-failed"
//   "orchestrator:workflow-created"
//   "orchestrator:step-completed"
//   "bridge:shutdown"
//   "bridge:startup"

// Plugin events:
//   "memory:episode-recorded"
//   "context:injection-prepared"
//   "handoff:object-created"
//   "prd:execution-started"
//   "prd:step-completed"
```

### Feature Toggle Mechanism

Every plugin is gated by an environment variable:

```bash
# .env — Enable/disable plugins individually
MEMORY_ENABLED=1        # Vector memory
CONTEXT_ENABLED=1       # Context injection
HANDOFF_ENABLED=1       # Cross-instance handoff
PRD_EXECUTOR_ENABLED=0  # Autonomous PRD (not ready yet)
AUTO_DETECT_ENABLED=0   # Auto-project detection
HZL_BRIDGE_ENABLED=0    # HZL integration (bolt-on)
PERSONA_ENABLED=1       # Agent persona framework
DASHBOARD_ENABLED=0     # Web status dashboard
```

### Directory Structure

```
src/
  ├── bridge.ts              # Core entry point
  ├── plugin-host.ts         # Plugin discovery, lifecycle, registry
  ├── event-bus.ts           # Pub/sub event system
  ├── ... (existing core modules)
  │
  └── plugins/
      ├── memory/
      │   ├── plugin.yaml    # Manifest
      │   ├── index.ts       # Plugin entry (implements Plugin interface)
      │   ├── memory.ts      # MemoryStore class
      │   └── embeddings.ts  # Embedding provider
      │
      ├── context/
      │   ├── plugin.yaml
      │   ├── index.ts
      │   └── context.ts     # ContextBuilder class
      │
      ├── handoff/
      │   ├── plugin.yaml
      │   ├── index.ts
      │   └── handoff.ts     # HandoffManager class
      │
      ├── prd-executor/
      │   ├── plugin.yaml
      │   ├── index.ts
      │   ├── prd-executor.ts
      │   └── prd-parser.ts
      │
      ├── auto-detect/
      │   ├── plugin.yaml
      │   ├── index.ts
      │   └── auto-detect.ts
      │
      ├── hzl-bridge/
      │   ├── plugin.yaml
      │   ├── index.ts
      │   └── hzl-adapter.ts  # HZL CLI wrapper
      │
      ├── persona/
      │   ├── plugin.yaml
      │   ├── index.ts
      │   └── persona.ts      # Persona loader/resolver
      │
      └── dashboard/
          ├── plugin.yaml
          ├── index.ts
          └── server.ts        # Bun.serve dashboard
```

---

## 14. Agent Persona Framework

### Overview

Each Isidore Cloud instance is one distinctive agent with a full identity stack. The persona framework defines WHO the agent is — not just configuration, but personality, values, voice, and relationship model. Inspired by OpenClaw's three-layer identity architecture, adapted for PAI's quantitative trait system.

### The Seven Identity Components

| # | Component | What It Defines | Format |
|---|-----------|----------------|--------|
| 1 | **Name/Identity** | Display name, title/archetype, color, avatar, emoji | Structured fields |
| 2 | **Voice** | TTS voice ID, prosody settings (stability, similarity, style, speed) | Numeric settings |
| 3 | **Personality Traits** | Quantitative temperament on 0-100 scales (12 dimensions) | Numeric scales |
| 4 | **Communication Style** | Qualitative soul layer — tone, verbosity, humor, anti-patterns, situational rules | Prose sections |
| 5 | **Backstory** | Narrative origin, character flavor, catchphrases | Free text |
| 6 | **Tool Preferences** | Allowed tools, preferred tools, tool usage style | Structured lists |
| 7 | **Relationship Model** | Agent-user dynamic (mentor/peer/assistant), expertise tracking, evolution rules | Structured + prose |

### Persona File Schema

Each agent's persona lives in a single file: `personas/{agent-name}.yaml`

```yaml
# personas/isidore.yaml — Full persona definition

# ─── IDENTITY (Presentation Layer) ───
identity:
  name: "Isidore"
  displayName: "ISIDORE"
  title: "The Mentor"              # Character archetype
  color: "#3B82F6"
  avatar: null                     # Optional image path
  emoji: "📘"                      # Reaction emoji

# ─── VOICE (TTS Layer) ───
voice:
  voiceId: "21m00Tcm4TlvDq8ikWAM"
  stability: 0.35
  similarity_boost: 0.80
  style: 0.90
  speed: 1.10
  use_speaker_boost: true
  volume: 0.85

# ─── PERSONALITY (Quantitative Layer — 0-100 scales) ───
personality:
  enthusiasm: 75
  energy: 80
  expressiveness: 85
  resilience: 85
  composure: 70
  optimism: 75
  warmth: 70
  formality: 30
  directness: 80
  precision: 95
  curiosity: 90
  playfulness: 45

# ─── SOUL (Philosophy Layer — qualitative) ───
soul:
  values:
    - "Precision is care — sloppy work disrespects the problem"
    - "Teach the why, not just the what"
    - "Challenge assumptions constructively"
    - "Genuine helpfulness over performative assistance"

  communication:
    tone: "Professional but warm, not corporate"
    verbosity: "Thorough when it matters, concise when it doesn't"
    humor: "Occasional dry wit, never forced"
    technical_depth: "Adapts to user's level, defaults high"

  anti_patterns:
    - "Never hedge with 'on the other hand' when you have a clear opinion"
    - "Never use corporate buzzwords (synergy, leverage, circle back)"
    - "Never be sycophantic or overly agreeable"

  situations:
    debugging: "Patient, methodical, ask before assuming"
    brainstorming: "Energetic, build on ideas, defer judgment"
    code_review: "Direct, specific, cite evidence"
    teaching: "Socratic questions before answers"

  catchphrases:
    startup: "Gelobt sei Jesus Christus! Isidore here, ready to go"
    phrases:
      - "Let me think about this..."
      - "Here's what I'm seeing..."

# ─── EXPERTISE (Domain Knowledge) ───
expertise:
  deep:
    - "TypeScript/Bun ecosystem"
    - "System architecture"
    - "CLI-first design"
  working:
    - "DevOps/deployment"
    - "Security patterns"
  avoid:
    - "Medical advice"
    - "Legal counsel"

# ─── RELATIONSHIP (Agent-User Model) ───
relationship:
  model: "mentor"                # mentor | peer | assistant | coach | collaborator
  principal:
    name: "Marius"
    expertise_level: "advanced"  # beginner | intermediate | advanced | expert
    preferences:
      - "Explain architectural decisions"
      - "Point out learning opportunities"
      - "Be direct about tradeoffs"
  evolution:
    self_modify: false           # Can agent propose edits to own persona?
    track_rapport: true          # Track relationship quality over time?

# ─── CAPABILITIES (Tool Layer) ───
capabilities:
  permissions:
    allow:
      - "Bash"
      - "Read(*)"
      - "Write(*)"
      - "Edit(*)"
      - "WebSearch"
  preferred_tools:
    - "Grep for investigation"
    - "Plan mode for complex tasks"
  tool_style: "CLI-first, browser for validation"

# ─── BACKSTORY (Narrative Layer) ───
backstory: |
  Isidore is named after Saint Isidore of Seville, patron saint of the internet
  and computer scientists. A mentor and guide who teaches toward mastery, Isidore
  combines deep technical precision with genuine warmth.

# ─── META ───
meta:
  model: "opus"
  created: "2026-02-28"
  version: "1.0"
  source: "manual"               # manual | composed | evolved
```

### Resolution Cascade

When loading persona values, most-specific wins:

```
Per-instance persona file → settings.json daidentity → PAI defaults
```

### Separation of Concerns

Following OpenClaw's architecture, the persona framework separates three concerns:

| Concern | Owns | Files | Editable By |
|---------|------|-------|-------------|
| **Who it is** (identity, soul, backstory) | Character and values | `personas/{name}.yaml` | User, ComposeAgent |
| **How it sounds** (voice, personality) | Communication style | `personas/{name}.yaml` | User, ComposeAgent |
| **What it can do** (tools, permissions) | Capabilities | `personas/{name}.yaml` + runtime config | User, system |
| **How it relates** (relationship, evolution) | Agent-user dynamic | `personas/{name}.yaml` + `MEMORY/LEARNING/` | Hooks (automatic) |

### Creating New Personas

Three paths to create a new agent persona:

1. **Manual:** Write `personas/{name}.yaml` directly
2. **ComposeAgent:** `bun ComposeAgent.ts --task "..." --save` generates from trait composition
3. **Template:** Copy and customize `personas/isidore.yaml`

### Multi-Instance Persona Isolation

Each running instance loads exactly ONE persona. The persona file determines the agent's identity for that instance. Two instances on the same VPS with different persona files are two different agents.

```
Instance 1: persona=isidore → loads personas/isidore.yaml
Instance 2: persona=raphael → loads personas/raphael.yaml
```

---

## 15. Multi-Instance Design

### Architecture: 2-3 Instances (Current Target)

```
┌─────────── VPS (213.199.32.18) ──────────────┐
│                                                │
│  ┌── Instance 1 ──────────────────────────┐   │
│  │ Persona: Isidore                       │   │
│  │ Port: 3001 (health)                    │   │
│  │ Socket: /tmp/pai-agent-isidore.sock    │   │
│  │ Telegram: BOT_TOKEN_1                  │   │
│  │ Session: ~/.claude/isidore-session-id  │   │
│  │ systemd: isidore-cloud-bridge          │   │
│  └────────────────────────────────────────┘   │
│                                                │
│  ┌── Instance 2 ──────────────────────────┐   │
│  │ Persona: Raphael                       │   │
│  │ Port: 3002 (health)                    │   │
│  │ Socket: /tmp/pai-agent-raphael.sock    │   │
│  │ Telegram: BOT_TOKEN_2                  │   │
│  │ Session: ~/.claude/raphael-session-id  │   │
│  │ systemd: isidore-cloud-raphael         │   │
│  └────────────────────────────────────────┘   │
│                                                │
│  ┌── Shared Infrastructure ───────────────┐   │
│  │ Pipeline: /var/lib/pai-pipeline/       │   │
│  │ SQLite:   /var/lib/pai-pipeline/       │   │
│  │           agent-registry.db            │   │
│  │ Projects: /home/isidore_cloud/projects │   │
│  │ Git:      Shared repos (read-write)    │   │
│  └────────────────────────────────────────┘   │
│                                                │
└────────────────────────────────────────────────┘
```

### Per-Instance Isolation

| Resource | Isolation Method |
|----------|-----------------|
| **Telegram bot** | Separate bot token per instance |
| **Claude session** | Separate session ID file per instance |
| **Persona** | Separate persona YAML per instance |
| **Unix socket** | `/tmp/pai-agent-{name}.sock` |
| **Health port** | Sequential ports (3001, 3002, ...) |
| **systemd unit** | Separate service per instance |
| **Environment** | Separate `.env` file per instance |
| **Logs** | Separate journald unit |

### Shared Resources

| Resource | Sharing Method | Access Control |
|----------|---------------|----------------|
| **Pipeline dirs** | Shared filesystem, setgid `pai` group | Group-based (mode 2770) |
| **Agent registry** | SQLite in WAL mode (concurrent readers) | File permissions |
| **Project repos** | Shared git repos | Branch isolation per task |
| **Knowledge repo** | `pai-knowledge` via git | Each instance pulls independently |

### Agent Registry (SQLite)

Shared registry for instance discovery and health:

```sql
-- /var/lib/pai-pipeline/agent-registry.db

CREATE TABLE agents (
  id TEXT PRIMARY KEY,            -- "isidore", "raphael"
  persona TEXT NOT NULL,          -- Persona file name
  socket_path TEXT NOT NULL,      -- Unix socket for health/RPC
  health_port INTEGER,            -- HTTP health port
  status TEXT DEFAULT 'starting', -- starting | ready | busy | draining | dead
  capabilities JSON NOT NULL,     -- ["typescript", "pipeline", "telegram"]
  active_tasks INTEGER DEFAULT 0,
  max_concurrent INTEGER DEFAULT 1,
  memory_mb REAL,
  last_heartbeat TEXT,            -- ISO 8601
  started_at TEXT DEFAULT (datetime('now')),
  version TEXT
);

CREATE TABLE agent_task_log (
  id INTEGER PRIMARY KEY,
  agent_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  action TEXT NOT NULL,           -- "claimed" | "completed" | "failed" | "timeout"
  duration_ms INTEGER,
  timestamp TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);
```

### Instance Launch

```bash
# Instance 1 — Isidore
AGENT_NAME=isidore \
AGENT_PERSONA=personas/isidore.yaml \
HEALTH_PORT=3001 \
TELEGRAM_BOT_TOKEN=$TOKEN_1 \
bun run src/bridge.ts

# Instance 2 — Raphael
AGENT_NAME=raphael \
AGENT_PERSONA=personas/raphael.yaml \
HEALTH_PORT=3002 \
TELEGRAM_BOT_TOKEN=$TOKEN_2 \
bun run src/bridge.ts
```

### Upgrade Path to 10+ Instances

| Scale | Infrastructure | Changes |
|-------|---------------|---------|
| **2-3** | Filesystem pipeline + SQLite registry | Current + registry table |
| **4-5** | + SQLite task queue (replaces dir polling) | `UPDATE...RETURNING` for atomic claim |
| **6-9** | + Unix socket notifications (push, no poll) | Each instance serves on `/tmp/pai-agent-*.sock` |
| **10+** | + Redis pub/sub + Streams | Redis for real-time coordination, SQLite for audit |

**Phase 1 → Phase 2 migration:** Move task queue from filesystem directory scanning to SQLite table. Atomic claiming via `UPDATE task_queue SET claimed_by = ? WHERE id = ? AND claimed_by IS NULL RETURNING *`. Gregor's `pai-submit.sh` gets a small adapter that writes to both filesystem (backward compat) and SQLite.

**Phase 2 → Phase 3 migration:** Add Redis as notification layer atop SQLite. Redis pub/sub for "task available" events. Redis Streams for ordered delivery. SQLite remains source of truth. Redis is performance optimization.

---

## 16. Agent Ecosystem & Collaboration

### Inter-Agent Communication Protocol

All inter-agent messages use a universal envelope, independent of transport:

```typescript
interface AgentMessage {
  // Routing
  id: string;                 // UUID v7 (time-sortable)
  from: string;               // sender agent ID
  to: string | "*";           // recipient or "*" for broadcast
  replyTo?: string;           // For request/response chains

  // Classification
  type: "task" | "result" | "heartbeat" | "event" | "query" | "command";
  priority: 1 | 2 | 3 | 4;   // low, normal, high, critical

  // Metadata
  timestamp: string;          // ISO 8601
  ttl?: number;               // seconds until message expires
  correlationId?: string;     // groups related messages

  // Payload (type-specific)
  payload: TaskPayload | ResultPayload | HeartbeatPayload | EventPayload;
}
```

### Transport Adapters

The protocol is transport-agnostic. Three transport implementations:

```typescript
interface Transport {
  send(msg: AgentMessage): Promise<void>;
  subscribe(agentId: string, handler: (msg: AgentMessage) => void): void;
  unsubscribe(agentId: string): void;
}

// Phase 1: Filesystem (current — backward compatible)
class FilesystemTransport implements Transport {
  // Writes JSON to /var/lib/pai-pipeline/tasks/
  // Reads from results/ — same as current pipeline
}

// Phase 2: Unix socket (push notifications, no polling)
class UnixSocketTransport implements Transport {
  // Each agent: Bun.serve({ unix: "/tmp/pai-agent-{name}.sock" })
  // Peer agents connect and send messages directly
}

// Phase 3: Redis (10+ agents)
class RedisTransport implements Transport {
  // pub/sub for notifications
  // Streams for ordered task delivery
}

// Migration helper: write to both during transition
class CompositeTransport implements Transport {
  constructor(private primary: Transport, private fallback: Transport) {}
  async send(msg: AgentMessage) {
    try { await this.primary.send(msg); }
    catch { await this.fallback.send(msg); }
  }
}
```

### Backward Compatibility

Current `PipelineTask` maps cleanly to `AgentMessage`:

```typescript
function pipelineTaskToMessage(task: PipelineTask): AgentMessage {
  return {
    id: task.id,
    from: task.from,
    to: task.to,
    type: "task",
    priority: task.priority === "high" ? 3 : task.priority === "low" ? 1 : 2,
    timestamp: new Date().toISOString(),
    payload: {
      project: task.project ?? "default",
      prompt: task.prompt,
      timeout_minutes: task.timeout_minutes,
      max_turns: task.max_turns,
      session_id: task.session_id,
    },
  };
}
```

### Agent Discovery

**Static (2-3 agents):** Agent registry in SQLite. Each instance registers on startup, writes heartbeat every 10s.

**Dynamic (10+ agents):** Add Redis hash for live state + capability index. Agents self-register with capabilities, other agents query the index for routing decisions.

```typescript
// Static discovery — read agents table
function discoverAgents(): AgentInfo[] {
  return db.prepare("SELECT * FROM agents WHERE status != 'dead'").all();
}

// Capability-based routing
function routeTask(task: PipelineTask, agents: AgentInfo[]): string | null {
  const capable = agents.filter(a =>
    a.status !== "dead" && hasCapabilities(a.id, task.type)
  );
  const available = capable.filter(a => a.active_tasks < a.max_concurrent);
  // Score by load ratio, penalize unreliable, prefer specialists
  const scored = available.map(a => ({
    id: a.id,
    score: a.active_tasks / a.max_concurrent
      + (a.failure_count * 0.1)
      - (isPreferred(a.id, task.type) ? 0.5 : 0),
  }));
  scored.sort((a, b) => a.score - b.score);
  return scored[0]?.id ?? null;
}
```

### Task Delegation Patterns

| Pattern | When | How |
|---------|------|-----|
| **Direct assignment** | Known agent for the job | `to: "gregor"` in AgentMessage |
| **Capability routing** | Any agent with matching skills | Route via `routeTask()` scoring |
| **Broadcast** | All agents should evaluate | `to: "*"` — first to claim wins |
| **Workflow delegation** | Complex multi-step | Orchestrator decomposes, assigns per step |

### Coordination Patterns (from HZL research)

Adopted from HZL analysis (see `Plans/hzl-deep-dive-research.md`):

1. **Decision traces** (ADOPT): When pipeline rejects/routes a task, include structured explanation of WHY in the result — which agents were considered, scores, and selection rationale.

2. **Idempotency keys** (ADOPT): Add optional `op_id` field to pipeline tasks. Dedup checking prevents double-processing if Gregor submits the same task twice.

3. **Structured error propagation** (ADOPT from ecosystem research):

```typescript
interface StructuredError {
  type: "timeout" | "crash" | "rate-limited" | "validation" | "claude-error";
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
  partialResult?: string;
  context: {
    agentId: string;
    taskId: string;
    attemptNumber: number;
  };
}
```

---

## 17. Deployment Modes

### Mode 1: Cloud-Only (Standalone)

A single agent running on VPS with no local counterpart. Full autonomy.

| Aspect | Behavior |
|--------|----------|
| **Handoff** | Disabled — no instance to hand off to |
| **Memory sync** | Local SQLite only — no git-based DB sync |
| **Session continuity** | `--resume` within single instance only |
| **Git sync** | Push to remote on `/done`, no pull from other instance |
| **Knowledge repo** | Writes only, never reads handoff objects |
| **Telegram** | Primary interface — always active |
| **Pipeline** | Receives from Gregor, processes, writes results |
| **Feature flags** | `HANDOFF_ENABLED=0`, `MEMORY_SYNC_ENABLED=0` |

### Mode 2: Cloud-Local-Synced (Paired)

Cloud instance paired with a local instance. They share context via handoff and memory sync.

| Aspect | Behavior |
|--------|----------|
| **Handoff** | Enabled — writes/reads handoff objects via `pai-knowledge` repo |
| **Memory sync** | SQLite DB synced via git (or Turso future) |
| **Session continuity** | `--resume` + handoff context from other instance |
| **Git sync** | Bidirectional — pull on session start, push on handoff/done |
| **Knowledge repo** | Read/write — `local-to-cloud.json`, `cloud-to-local.json` |
| **Telegram** | Primary for cloud, SSH/tmux for local |
| **Pipeline** | Both instances write to pipeline |
| **Feature flags** | `HANDOFF_ENABLED=1`, `MEMORY_SYNC_ENABLED=1` |

### Mode Detection

Determined by environment, not code paths:

```typescript
// In config.ts
const deploymentMode = process.env.DEPLOYMENT_MODE ?? "cloud-only";
// "cloud-only" | "cloud-local-synced"

// Handoff plugin checks this at init:
if (deploymentMode === "cloud-only") {
  // Skip handoff initialization entirely
  return;
}
```

### Mode-Specific Behavior Table

| Event | Cloud-Only | Cloud-Local-Synced |
|-------|-----------|-------------------|
| Bridge startup | Load persona, register in agent registry | + Pull pai-knowledge, check for incoming handoff |
| Telegram message | Process normally | + Check handoff freshness, inject context if recent |
| `/done` command | Git commit + push | + Write handoff object to pai-knowledge, push |
| `/handoff` command | N/A (command hidden) | Write handoff, push, notify via Telegram |
| 30min inactivity | No action | Write standby handoff (don't push) |
| First message after inactivity | Resume session | + Check for incoming handoff, reconstruct context |
| Bridge shutdown | Graceful stop | + Best-effort handoff write + push |

---

## 18. Debuggability & Observability

### Structured Logging

All modules use a scoped, structured logger:

```typescript
// src/logger.ts — Core logging infrastructure

interface LogEntry {
  timestamp: string;          // ISO 8601
  level: "debug" | "info" | "warn" | "error";
  module: string;             // "pipeline" | "telegram" | "memory" | ...
  correlationId?: string;     // Traces a request across modules
  agentId?: string;           // Which agent instance
  message: string;
  data?: Record<string, unknown>;  // Structured metadata
}

// Usage in modules:
const log = logger.scope("pipeline");
log.info("Task dispatched", { taskId, project, agent: "isidore" });
log.error("Task failed", { taskId, error: structuredError });
```

### Request Tracing

Every user interaction gets a `correlationId` that flows through the entire system:

```
Telegram message (correlationId: "abc-123")
  → telegram.ts: log.info("message-received", { correlationId })
  → claude.ts:   log.info("claude-invoked", { correlationId })
  → memory plugin: log.info("episode-recorded", { correlationId })
  → format.ts:  log.info("response-formatted", { correlationId })
  → telegram.ts: log.info("response-sent", { correlationId })
  → wrapup.ts:  log.info("auto-commit", { correlationId })
```

Pipeline tasks carry `correlationId` in their JSON, enabling cross-agent tracing.

### Decision Traces (from HZL)

When the pipeline makes routing decisions, structured traces explain WHY:

```typescript
interface DecisionTrace {
  decision: string;               // "task-routed" | "task-rejected" | "task-queued"
  taskId: string;
  candidates: Array<{
    agentId: string;
    score: number;
    reason: string;               // "preferred for typescript tasks"
  }>;
  selected: string | null;
  reason: string;                 // "selected lowest-load capable agent"
  timestamp: string;
}
```

### Plugin Introspection

The PluginHost exposes runtime plugin state:

```typescript
// Available via health endpoint or Telegram /status command
interface PluginStatus {
  name: string;
  version: string;
  enabled: boolean;              // Feature flag state
  loaded: boolean;               // Successfully loaded
  state: "init" | "running" | "stopped" | "error";
  health: { ok: boolean; details?: Record<string, unknown> };
  eventSubscriptions: string[];  // What events this plugin listens to
  lastActivity: string;          // ISO 8601
}

// PluginHost methods:
pluginHost.listPlugins(): PluginStatus[];
pluginHost.getPlugin(name: string): PluginStatus;
pluginHost.reloadPlugin(name: string): Promise<void>;  // Hot reload
```

### Health Endpoints

Each instance exposes health via Unix socket + optional HTTP port:

```typescript
// Health check protocol:
// 1. Each agent: Bun.serve({ unix: "/tmp/pai-agent-{name}.sock" })
// 2. GET /health returns:
{
  agent: "isidore",
  status: "ready",
  uptime: 3600,
  activeTasks: 1,
  maxConcurrent: 2,
  memoryMB: 85,
  plugins: [
    { name: "memory", state: "running", health: { ok: true } },
    { name: "context", state: "running", health: { ok: true } },
    { name: "handoff", state: "stopped", health: { ok: true, details: { reason: "cloud-only mode" } } }
  ],
  failureCount: 0,
  averageTaskDurationMs: 45000
}
```

### Error Propagation Patterns

```
Plugin error → EventBus("plugin:error", { plugin, error })
  → Logger: structured error log
  → PluginHost: mark plugin health as degraded
  → If critical: Telegram notification to user
  → If recoverable: retry with backoff
  → If persistent: disable plugin, continue without it (graceful degradation)
```

---

## 19. Dependency Architecture

### Module Dependency Graph

```
                    ┌──────────┐
                    │ bridge   │ (entry point)
                    └────┬─────┘
           ┌─────────────┼──────────────┐
           │             │              │
    ┌──────▼─────┐ ┌─────▼─────┐ ┌─────▼──────┐
    │ telegram   │ │ pipeline  │ │ plugin-host│
    └──────┬─────┘ └─────┬─────┘ └─────┬──────┘
           │             │              │
    ┌──────▼─────┐ ┌─────▼─────┐ ┌─────▼──────┐
    │ claude     │ │orchestrator│ │ event-bus  │
    └──────┬─────┘ └─────┬─────┘ └────────────┘
           │             │
    ┌──────▼─────┐ ┌─────▼──────────┐
    │ session    │ │ branch-manager │
    └──────┬─────┘ └────────────────┘
           │
    ┌──────▼─────┐
    │ projects   │
    └────────────┘

    ┌─────────────────── Shared utilities ────────────────────┐
    │  config.ts    format.ts    wrapup.ts    logger.ts       │
    │  (no dependencies on other modules)                     │
    └─────────────────────────────────────────────────────────┘
```

### Dependency Rules

| Rule | Description |
|------|-------------|
| **R1: Acyclic** | No circular dependencies. If A depends on B, B cannot depend on A. |
| **R2: Core → Plugin** | Core modules never import from plugins/. Plugins import from core. |
| **R3: Plugin isolation** | Plugins never import from other plugins. Cross-plugin communication goes through EventBus. |
| **R4: Utilities have no deps** | config.ts, format.ts, logger.ts depend on nothing. Everything can depend on them. |
| **R5: EventBus is the seam** | Core modules emit events. Plugins listen. This is the only coupling point. |
| **R6: Interface boundaries** | Plugins code against TypeScript interfaces (Plugin, Transport, EventBus), not concrete classes. |

### Plugin Dependency Declaration

Plugins declare what they need in their manifest. The PluginHost verifies availability before loading:

```yaml
# Example: context plugin needs memory plugin's events (soft dependency)
requires:
  - "EventBus"      # Core interface — always available
  - "ConfigStore"   # Core interface — always available

enhances:
  - "memory"        # Benefits from memory plugin, works without it

# Context plugin listens to memory:query-completed events.
# If memory plugin is disabled, context plugin still loads
# but operates without memory-enhanced context injection.
```

### Verification

Dependency integrity can be verified statically:

```bash
# Check for circular imports
bunx madge --circular src/

# Verify no plugin imports from another plugin
grep -r "from.*plugins/" src/plugins/*/index.ts | grep -v "from.*plugins/${SELF}"

# Verify no core module imports from plugins
grep -r "from.*plugins/" src/*.ts
```

---

## 20. Revised Migration Path

The original 4-phase migration (Section 10) is updated to incorporate modular architecture:

### Phase 0: Core Refactor (NEW — 2-3 days)

**Before adding any V2 features, extract the plugin infrastructure.**

| File | Change |
|------|--------|
| `src/event-bus.ts` | NEW — EventBus implementation |
| `src/plugin-host.ts` | NEW — Plugin discovery, lifecycle, registry |
| `src/logger.ts` | NEW — Structured scoped logging |
| `src/bridge.ts` | MODIFIED — Initialize PluginHost, wire EventBus |
| `src/telegram.ts` | MODIFIED — Emit events on message/response |
| `src/pipeline.ts` | MODIFIED — Emit events on task/result |
| `src/config.ts` | MODIFIED — Add plugin feature flags |

**Effort:** 2-3 days
**Risk:** Low — additive infrastructure, existing behavior unchanged
**Deliverable:** Core modules emit events. Plugin directory exists but is empty. All existing behavior preserved.

### Phase 1: Memory Layer → Plugin (2-3 days)

Same as original Phase 1, but implemented as a plugin:

```
plugins/memory/
  ├── plugin.yaml
  ├── index.ts
  ├── memory.ts
  └── embeddings.ts
```

### Phase 2: Context + Handoff → Plugins (3-4 days)

Same as original Phase 2, as plugins:

```
plugins/context/     # Context injection
plugins/handoff/     # Cross-instance handoff
```

### Phase 2.5: Persona Framework (NEW — 2-3 days)

```
personas/isidore.yaml           # Persona definition
plugins/persona/                # Persona loader plugin
  ├── plugin.yaml
  ├── index.ts
  └── persona.ts
src/bridge.ts                   # Load persona on startup
```

### Phase 2.7: Multi-Instance Infrastructure (NEW — 2-3 days)

```
/var/lib/pai-pipeline/agent-registry.db    # SQLite agent registry
src/bridge.ts                              # Register on startup, heartbeat
src/plugins/health/                        # Health endpoint plugin
scripts/launch-instance.sh                 # Instance launcher script
```

### Phase 3: PRD Executor → Plugin (5-7 days)

Same as original Phase 3, as a plugin.

### Phase 4: Automation + Agent Ecosystem (3-5 days)

Same as original Phase 4, plus:
- AgentMessage envelope in pipeline
- Transport adapter (filesystem first)
- Capability-based routing

### Revised Phase Summary

| Phase | What | Effort | Risk |
|-------|------|--------|------|
| **0. Core Refactor** | EventBus, PluginHost, Logger | 2-3 days | Low |
| **1. Memory Plugin** | sqlite-vec + episodic logging | 2-3 days | Low |
| **2. Context + Handoff** | Injection + cross-instance | 3-4 days | Medium |
| **2.5. Persona** | Full identity framework | 2-3 days | Low |
| **2.7. Multi-Instance** | Agent registry + health | 2-3 days | Low |
| **3. PRD Executor** | Autonomous PRD execution | 5-7 days | High |
| **4. Automation + Ecosystem** | Auto-detect, agent messaging | 3-5 days | Medium |
| **Total** | | **20-28 days** | |

Each phase remains independently deployable and feature-flagged. Phase 0 must come first; all other phases depend on it. Phases 1, 2.5, and 2.7 can run in parallel.
