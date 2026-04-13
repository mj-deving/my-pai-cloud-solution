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

## Verification Plan

After implementation, verify the architecture doc meets all ISC:

1. **ISC-C1:** Count modules in Section 1 → must be 16
2. **ISC-C2:** Check Section 2 → 4 pillars with current/gap/proposed
3. **ISC-C3:** Check Section 3 → 3 tiers with migration path
4. **ISC-C4:** Check Section 4 → voice, unstructured, formal all covered
5. **ISC-C5:** Check Section 5 → both directions + crash recovery
6. **ISC-C6:** Check Section 6 → budget table + injection strategy
7. **ISC-C7:** Check Section 7 → 4 frameworks with adopt/skip
8. **ISC-C8:** Check Section 8 → every /command has automation path
9. **ISC-C9:** Check Section 10 → 4 independent phases
10. **ISC-C10:** Search "Gregor" → present in sections 4, 5, 9, 10
11. **ISC-C11:** Check Section 11 → RAM/disk estimates per component
12. **ISC-C12:** Count diagrams → 4 present in Section 12
13. **ISC-A1:** Check Section 3 → lightweight tier has Ollama fallback to keyword
14. **ISC-A2:** Check Section 8 → all commands marked "Remains Manual: Yes"
15. **ISC-A3:** Check all sections → no module replacement proposed
