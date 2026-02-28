# HZL Deep-Dive Research Report

**Date:** 2026-02-28
**Researcher:** Isidore Cloud (Nova)
**Repo:** https://github.com/tmchow/hzl
**Version analyzed:** 2.1.0
**Commit activity:** Active (last push: 2026-02-28)

---

## 1. Project Overview

### What is HZL?

HZL is a **durable shared task ledger** designed specifically for AI coding agents and multi-agent systems. The name comes from the mascot, and the project tagline is: "Agents wake into fresh sessions -- HZL preserves continuity across those wakes so they can resume work, hand off context, and coordinate through shared project pools."

### Problem It Solves

AI coding agents (Claude Code, OpenClaw, Codex, Gemini) are **stateless by nature** -- each session starts fresh with no memory of prior work. HZL solves the **cross-session continuity problem** by providing a persistent, shared, event-sourced task ledger that agents can read/write through a CLI. It enables:

1. **Session continuity** -- An agent can resume where it left off via checkpoints
2. **Multi-agent coordination** -- Multiple agents can claim tasks from shared project pools without races
3. **Handoff workflows** -- Agent A completes its task and creates a follow-on for Agent B with carried context
4. **Delegation** -- Agent A can delegate subtasks and optionally pause itself until the delegated work is done
5. **Observability** -- A Kanban-style web dashboard shows task state across all agents

### Who Made It?

- **Trevin Chow** ([@tmchow](https://github.com/tmchow)) -- Primary author
- **Kalid Azad** ([@kazad](https://github.com/kazad)) -- Contributor
- MIT License, 14 stars, tied to the [OpenClaw](https://openclaw.ai) ecosystem

### Tech Stack

| Component | Technology |
|-----------|-----------|
| Language | TypeScript (strict, ESM) |
| Runtime | Node.js >= 22.14.0 |
| Package manager | pnpm (monorepo with workspaces) |
| Database | SQLite via `libsql` (better-sqlite3 fork with Turso sync support) |
| Validation | Zod v4 |
| CLI framework | Commander.js |
| Web server | Node.js `http` (zero frameworks) |
| Testing | Vitest with coverage |
| Build | TypeScript compiler (`tsc`) |
| CI/CD | GitHub Actions, semantic-release, conventional commits |
| Distribution | npm (`hzl-cli`), Homebrew tap |

---

## 2. Architecture

### Monorepo Structure

```
hzl/
  packages/
    hzl-core/     -- Business logic library (event sourcing, services, projections)
    hzl-cli/      -- CLI wrapper (Commander.js, thin command layer)
    hzl-web/      -- Kanban web dashboard (embedded HTML, Node http server)
  openclaw/       -- OpenClaw-specific integration prompts
  skills/         -- Claude Code skill definitions
  .claude-plugin/ -- Claude Code marketplace plugin
  snippets/       -- Reusable doc snippets with auto-sync
  validation/     -- Analysis and test scenarios
```

### Core Architecture: Event Sourcing + CQRS

HZL's architecture is fundamentally **event-sourced**. This is the most architecturally significant decision:

```
                    ┌─────────────┐
                    │  hzl CLI    │
                    │ (Commander) │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │  Services   │  TaskService, WorkflowService,
                    │   Layer     │  ProjectService, ValidationService
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
       ┌──────▼──────┐ ┌──▼───┐ ┌──────▼──────┐
       │ EventStore  │ │      │ │ Projection  │
       │ (events.db) │ │      │ │   Engine    │
       │ append-only │ │      │ │ (cache.db)  │
       └─────────────┘ │      │ └─────────────┘
                        │      │
                   ┌────▼──────▼────┐
                   │   SQLite WAL   │
                   │  (libsql/     │
                   │   Turso sync)  │
                   └────────────────┘
```

**Two-database design:**

1. **`events.db`** -- The append-only event store (source of truth). Contains immutable events. Has SQLite triggers that literally `RAISE(ABORT)` on UPDATE or DELETE attempts. This is the synced database when using Turso.

2. **`cache.db`** -- Local-only derived state. Contains projection tables (`tasks_current`, `task_dependencies`, `task_tags`, `task_comments`, etc.). Fully rebuildable from events. Never synced.

### Event Types (12 total)

```typescript
enum EventType {
  TaskCreated        // New task with title, project, deps, tags, metadata
  StatusChanged      // Kanban transitions: backlog -> ready -> in_progress -> done
  TaskMoved          // Cross-project move
  DependencyAdded    // DAG edge created
  DependencyRemoved  // DAG edge removed
  TaskUpdated        // Field-level update (title, description, tags, priority, etc.)
  TaskArchived       // Soft delete
  CommentAdded       // Steering comments from agents
  CheckpointRecorded // Progress snapshots with arbitrary JSON data
  ProjectCreated     // New project pool
  ProjectRenamed     // Project rename
  ProjectDeleted     // Project removal
}
```

### Event Envelope

Every event carries rich metadata for tracing:

```typescript
interface EventEnvelope {
  event_id: string;       // ULID
  task_id: string;        // Which task this event is about
  type: EventType;
  data: Record<string, unknown>;  // Event-specific payload (Zod-validated)
  author?: string;        // Human/agent name
  agent_id?: string;      // Machine identifier
  session_id?: string;    // Which session produced this
  correlation_id?: string; // Trace across events
  causation_id?: string;  // What caused this event
  timestamp: string;      // ISO-8601, DB-assigned
}
```

### Projection System

Six projectors maintain derived read-model tables from the event stream:

| Projector | Table(s) | Purpose |
|-----------|----------|---------|
| `TasksCurrentProjector` | `tasks_current` | Materialized current state of each task |
| `DependenciesProjector` | `task_dependencies` | DAG edges for availability checks |
| `TagsProjector` | `task_tags` | Denormalized tag filtering |
| `SearchProjector` | `task_search` (FTS5) | Full-text search over titles/descriptions |
| `CommentsCheckpointsProjector` | `task_comments`, `task_checkpoints` | Agent notes and progress snapshots |
| `ProjectsProjector` | `projects` | Project metadata |

The `ProjectionEngine` coordinates all projectors, tracking cursor position per projector so they can catch up independently.

---

## 3. Key Features (Technical Detail)

### 3.1 Atomic Task Claiming

The most critical feature for multi-agent coordination. Uses `BEGIN IMMEDIATE` transactions to prevent race conditions:

```typescript
// TaskService.claimTask() -- uses withWriteTransaction()
// which calls db.exec('BEGIN IMMEDIATE') to acquire exclusive write lock
claimTask(taskId: string, options: ClaimTaskOptions): Task {
  return withWriteTransaction(this.eventsDb, this.cacheDb, () => {
    // 1. Verify task exists and is in 'ready' status
    // 2. Verify all dependencies are 'done'
    // 3. Append StatusChanged event (ready -> in_progress)
    // 4. Apply projection
    // 5. Return updated task
  });
}
```

`claimNext()` ranks candidates by: priority DESC, due_at ASC (nulls last), created_at ASC, task_id ASC. Filters by project, tags, and parent. Excludes tasks that have children (leaf-only policy).

**Anti-herd stagger:** When multiple agents poll `claim --next` simultaneously, a deterministic hash-based delay (default 1s window) desynchronizes them:

```typescript
function calculateClaimStaggerOffsetMs(agent: string, windowMs: number, nowMs: number): number {
  const bucket = Math.floor(nowMs / windowMs);
  const seed = `${agent}:${bucket}`;
  const hash = createHash('sha256').update(seed).digest();
  return hash.readUInt32BE(0) % windowMs;
}
```

### 3.2 Task Leasing

Tasks can be claimed with a lease (`--lease 30` for 30 minutes). If a lease expires, the task becomes "stuck" and can be stolen by another agent:

```bash
hzl task stuck                              # List stuck tasks
hzl task steal <id> --if-expired --agent b  # Steal expired lease
```

### 3.3 Workflow System (3 Built-In Workflows)

HZL has three atomic, idempotent workflows:

**`workflow run start`** -- Session boot for an agent:
1. Check if agent has any in-progress tasks (resume them)
2. If no in-progress tasks, claim the next eligible task
3. Resume policy: `first` (oldest), `latest`, or `priority` (default)
4. Returns the selected task + alternates list

**`workflow run handoff`** -- Agent session transition:
1. Complete source task (mark done)
2. Create follow-on task with carried context
3. Carry last N checkpoints (default 3, max 4000 chars) as description
4. Optionally assign to specific agent or project pool

**`workflow run delegate`** -- Subtask creation:
1. Create delegated task from parent
2. Add dependency edge (parent depends on delegated) by default
3. Optionally pause parent (set to blocked)
4. Record checkpoint on parent ("delegated to: <task-id>")

All workflows support **idempotency** via `--op-id` (explicit key) or `--auto-op-id` (deterministic hash of normalized inputs). The `workflow_ops` table tracks operation state.

### 3.4 Decision Traces

Every claim operation returns a structured `decision_trace` explaining exactly WHY a task was/wasn't selected:

```json
{
  "decision_trace": {
    "version": "v1",
    "mode": "next",
    "filters": { "project": "infra" },
    "eligibility": {
      "status_ready_required": true,
      "dependencies_done_required": true,
      "leaf_only_required": true
    },
    "outcome": {
      "selected": true,
      "reason_code": "claimed",
      "reason": "Highest-ranked eligible task was claimed",
      "task_id": "01HX..."
    },
    "alternatives": [...]
  }
}
```

### 3.5 Checkpoints and Comments

Agents record progress checkpoints with arbitrary structured data:

```bash
hzl task checkpoint <id> "implemented auth middleware" --data '{"files_changed": 3}'
hzl task progress <id> 75  # 0-100 progress indicator
hzl task comment <id> "blocked on API key"
```

Checkpoints are carried across handoffs, providing **cross-session context**.

### 3.6 Dependencies (DAG)

Full directed acyclic graph support:
- Tasks can depend on tasks in other projects (cross-project dependencies)
- A task is only "available" (claimable) when ALL dependencies are `done`
- `hzl dep list --blocking-only` shows what's blocking what
- Cycle detection via `ValidationService`

### 3.7 Hook System (Outbox Pattern)

When tasks reach `done`, HZL can fire webhooks using a durable outbox pattern:

```
Config: hooks.on_done.url = "https://api.example.com/webhook"
```

The `HookDrainService` implements:
- Outbox table with status tracking (queued/processing/delivered/failed)
- Lock-based claiming with stale lock recovery
- Exponential backoff with jitter (base 30s, max 6h)
- TTL-based expiration (24h default)
- Max 5 delivery attempts
- `hzl hook drain` command for cron-scheduled delivery

### 3.8 Database Sync (Turso/libsql)

HZL supports three connection modes:
- **`local-only`** -- Default. SQLite file on disk.
- **`remote-replica`** -- Events.db synced to Turso cloud. Local reads, remote writes.
- **`offline-sync`** -- Bidirectional offline sync with Turso.

Sync policies: `manual`, `opportunistic` (default, stale-based), `strict` (sync before/after every operation).

### 3.9 Web Dashboard

Embedded Kanban board served via `hzl serve` on port 3456. Features:
- REST API: `/api/tasks`, `/api/events`, `/api/stats`, `/api/tasks/:id`
- Server-Sent Events (SSE) for live updates: `/api/events/stream`
- Poll-based change detection (2s interval)
- Subtask badges, blocked-by indicators
- Date range filtering (1d, 3d, 7d, 14d, 30d)
- Due month filtering

### 3.10 Full-Text Search (FTS5)

SQLite FTS5 virtual table over task titles and descriptions:

```bash
hzl task search "authentication middleware"
```

### 3.11 Database Locking

File-based lock with stale detection (checks if PID is running via `process.kill(pid, 0)`):

```typescript
// O_EXCL ensures atomic creation
const fd = fs.openSync(this.lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
```

Exponential backoff on lock contention: 5ms, 10ms, 20ms, 40ms, 80ms, 100ms max.

### 3.12 Validation

`ValidationService` checks:
- Dependency cycles (graph traversal)
- Missing dependency references
- Orphaned tasks

```bash
hzl validate  # Run all validation checks
```

### 3.13 Backup & Export

- `hzl export-events` -- Dump event stream as NDJSON
- `BackupService` for import/export operations

### 3.14 Agent Stats

```bash
hzl agent stats              # Per-agent task counts by status
hzl stats                    # Global stats (total, by-status, projects)
```

---

## 4. Agent Ecosystem

### Multi-Agent Coordination Model

HZL uses a **project-pool model** for multi-agent routing:

```
Project "frontend" ──────── Agent Alpha claims from this pool
Project "backend"  ──────── Agent Beta claims from this pool
Project "devops"   ──────── Agent Gamma claims from this pool
```

**Key design:** Tasks are NOT assigned to agents at creation time. Instead, tasks are created in project pools, and agents claim from pools. This decouples task creation from agent routing.

**Agent discovery:** There is NO agent registry. Agents are identified by string names passed via `--agent`. Any string is a valid agent identity. The system tracks which agent claimed which task via the `agent` field on `tasks_current`.

**Communication:** Agents do NOT communicate directly. All coordination happens through the shared task ledger:
1. Agent A creates task in project pool
2. Agent B polls with `workflow run start` and claims it
3. Agent B records checkpoints during work
4. Agent B completes or hands off
5. Agent A can query task status to see progress

### OpenClaw Integration

HZL is tightly integrated with the OpenClaw multi-agent platform:
- `openclaw/OPENCLAW-TOOLS-PROMPT.md` -- Provides the default operating loop
- `openclaw/skills/hzl/SKILL.md` -- OpenClaw-specific skill
- Agent roster management instructions in the tools prompt

### Claude Code Integration

- `.claude-plugin/` -- Full Claude Code marketplace plugin
- `skills/hzl/SKILL.md` -- Claude Code skill for task management
- `.claude/hooks/protect-production-data.sh` -- Hook to prevent agents from modifying user data
- `CLAUDE.md`, `AGENTS.md`, `GEMINI.md` -- AI-specific documentation files

---

## 5. Plugin/Extension System

### Modularity

HZL has a **three-layer modular architecture**:

1. **`hzl-core`** -- Pure library, zero CLI dependency. Can be imported into any Node.js application.
2. **`hzl-cli`** -- Thin CLI wrapper. Each command is a separate file in `src/commands/`.
3. **`hzl-web`** -- Optional dashboard. Depends on hzl-core, not on hzl-cli.

### Extension Points

| Extension Point | Mechanism |
|----------------|-----------|
| Webhooks on completion | `hooks.on_done` config + `hzl hook drain` |
| Custom projections | Implement `Projector` interface, register with `ProjectionEngine` |
| Database sync | libsql/Turso sync URLs in config |
| Claude Code skill | `.claude-plugin/` marketplace format |
| Agent documentation | Snippet system with auto-sync to multiple targets |

### No Plugin System Per Se

HZL does NOT have a formal plugin API. It is designed as a **standalone tool** that agents interact with via CLI. The extension model is:
- Use the CLI as the interface (all output is JSON by default)
- Write webhooks for external integrations
- Import `hzl-core` as a library for deeper integration

---

## 6. Personalization

### Agent Identity

Agents are identified by simple string names. There is NO personality, customization, or behavioral profile system. HZL is purely a task coordination tool -- it does not handle agent identity, prompts, or personality.

The `agent` field on tasks and events is just a string label for tracking who did what.

### Project Configuration

Minimal project-level customization:
- `defaultProject` -- Default project for task creation
- `defaultAuthor` -- Default author for events
- `leaseMinutes` -- Default lease duration
- `claimStaggerMs` -- Anti-herd delay window

---

## 7. Memory System

### Cross-Session Memory via Checkpoints

HZL's "memory" is the **checkpoint system**:

```bash
hzl task checkpoint <id> "Implemented auth flow. Next: add refresh tokens." \
  --data '{"files": ["src/auth.ts", "src/tokens.ts"], "tests_passing": true}'
```

Checkpoints are stored as events (`CheckpointRecorded`) with:
- Name/text (up to 256 chars)
- Arbitrary JSON data (up to 16KB)
- Progress percentage (0-100)

### Context Carrying (Handoff)

The `workflow run handoff` command carries checkpoints from the completed task to the new task:
- Default: last 3 checkpoints, max 4000 chars
- Carried as the new task's description field
- This is the primary mechanism for **cross-session context transfer**

### No Vector Store / Embeddings / Semantic Memory

HZL has **no vector store, no embeddings, no semantic search beyond FTS5**. It is a structured task ledger, not a memory system. The checkpoint data is plain JSON, not vectors.

### Full Event History

The complete event history for any task is available via:
```bash
hzl task history <id>    # Full event stream for a task
hzl task show <id>       # Current state + comments + checkpoints
```

---

## 8. Strengths

### 8.1 Event Sourcing is Excellent for Agent Coordination

The append-only event store with SQLite triggers preventing modification is a brilliant choice:
- **Complete audit trail** -- Every action by every agent is recorded immutably
- **Rebuildable state** -- If cache corrupts, rebuild from events
- **Time travel** -- Can replay events to understand what happened
- **Conflict-free** -- Append-only means no update conflicts in multi-agent scenarios

### 8.2 Atomic Claiming Prevents Race Conditions

`BEGIN IMMEDIATE` + write transaction pattern guarantees that two agents calling `claim --next` simultaneously will get different tasks. This is a HARD requirement for multi-agent systems that most naive implementations get wrong.

### 8.3 Decision Traces are Exceptional

The `decision_trace` in claim responses is remarkably well-designed for AI agent debugging. When an agent can't claim a task, it gets a structured explanation of WHY, with alternatives. This is far superior to generic error messages.

### 8.4 Workflow Idempotency

The `workflow_ops` table with operation-level idempotency means agents can safely retry operations without creating duplicates. Critical for unreliable network/session scenarios.

### 8.5 Clean Separation of Concerns

The three-package monorepo (core/cli/web) with hzl-core as a pure library is excellent. It means:
- Core logic is testable without CLI overhead
- Web dashboard is optional
- Other tools can import hzl-core directly

### 8.6 Comprehensive Test Suite

Vitest with property-based testing (fast-check), concurrency stress tests, migration tests, and integration tests. The concurrency tests actually spawn worker processes to verify atomic claiming.

### 8.7 Documentation System

The snippet-sync system (source snippets in `/snippets/`, auto-injected into multiple targets via pre-commit hooks) is clever for keeping agent documentation consistent across Claude, Codex, Gemini, and OpenClaw.

### 8.8 Turso Sync for Distributed Agents

The libsql/Turso sync capability means geographically distributed agents can share a task ledger without custom sync infrastructure.

---

## 9. Weaknesses/Limitations

### 9.1 CLI-Only Interface (No API Server by Default)

All agent interaction is through `hzl` CLI commands. There is NO persistent API server (the web dashboard is read-only). This means:
- Every operation spawns a new process
- Database connection setup/teardown on every command
- No persistent connections, no WebSocket for real-time updates to agents
- Latency per operation = process spawn + DB open + query + DB close

### 9.2 No Agent Registry or Discovery

Agents are just strings. There is no:
- Agent health monitoring
- Agent capability declaration
- Agent availability tracking
- Dynamic agent assignment based on skills/load

### 9.3 No Real-Time Notifications to Agents

HZL is **poll-based only**. Agents must periodically run `workflow run start` or `task list` to discover new work. There is no push mechanism to notify agents when tasks become available.

### 9.4 Limited Checkpoint Context

Checkpoint text is limited to 256 chars, data to 16KB. For complex multi-session work, this may not carry enough context. The handoff carry limit (4000 chars default) further constrains context transfer.

### 9.5 No Subtask Decomposition Intelligence

HZL tracks parent/child relationships but has NO built-in task decomposition. An agent (or human) must manually create subtasks. Compare to our DAG orchestrator which uses Claude to decompose tasks.

### 9.6 No Priority Queue Sophistication

Priority is a simple 0-3 integer. No deadline-aware scheduling, no workload balancing, no estimated-effort weighting.

### 9.7 Node.js 22 Requirement

Requires Node.js >= 22.14.0. This is a fairly recent version requirement that may limit adoption.

### 9.8 No Built-In Rate Limiting for Agents

While there is sync rate limiting, there is no mechanism to prevent a single agent from overwhelming the system with rapid operations.

### 9.9 Single-Machine SQLite (Without Turso)

Without Turso, the SQLite database is local to one machine. Multiple agents must share filesystem access to the same `.db` file, which limits deployment topologies.

---

## 10. Comparison to Our System

| Dimension | HZL | Isidore Cloud (Our System) |
|-----------|-----|---------------------------|
| **Architecture** | Event-sourced SQLite + projections | JSON files in shared directories (tasks/, results/) |
| **Communication** | CLI per-operation | Bun.spawn of `claude -p`, file-based pipeline |
| **Multi-agent model** | Project pools + claim from CLI | Named agents (Isidore/Gregor) with dedicated directories |
| **Task format** | Rich structured (12 event types, Zod-validated) | JSON task files with prompt, timeout, priority |
| **DAG/Dependencies** | Built-in with availability gating | TaskOrchestrator with DAG decomposition via Claude |
| **Orchestration** | Manual (agent decides what to do) | Automated (orchestrator dispatches based on dependency resolution) |
| **Handoff** | `workflow run handoff` (structured, carries checkpoints) | Reverse pipeline (file-based delegation) |
| **Session management** | Session ID in event envelope only | Per-project session sharing with handoff state |
| **Real-time** | Poll-based (CLI) + SSE (dashboard only) | File polling (5s) + Telegram real-time |
| **User interface** | Web Kanban dashboard | Telegram bot (mobile-first) |
| **Concurrency control** | SQLite `BEGIN IMMEDIATE` transactions | Per-project file locking + concurrency pool |
| **Branch isolation** | None | `pipeline/<taskId>` git branches |
| **Task decomposition** | Manual | AI-powered via Claude one-shot |
| **Resource management** | None | ResourceGuard (memory-gated), RateLimiter, Verifier |
| **Database** | SQLite (event-sourced, durable) | Flat JSON files (ephemeral, consumed after processing) |
| **Identity/Personality** | None (agent = string) | Full agent identities with voice, personality, sessions |
| **Sync** | Turso cloud sync | Git push/pull, rsync deploy |
| **Runtime** | Node.js 22 | Bun |

### Key Architectural Differences

1. **Event sourcing vs. ephemeral files:** HZL keeps a permanent, immutable history. Our system consumes tasks and moves them to `ack/`. HZL's approach is more auditable; ours is simpler.

2. **CLI vs. programmatic:** HZL agents interact via CLI (new process per operation). Our agents interact via Bun.spawn of Claude CLI (programmatic, in-process orchestration).

3. **Pool-based vs. named-agent:** HZL's project pools decouple tasks from agents. Our system has named agents (Isidore, Gregor) with explicit routing. HZL is more flexible; ours is more deterministic.

4. **Manual vs. automated orchestration:** HZL agents decide their own workflow. Our orchestrator automatically dispatches work based on DAG resolution. HZL gives agents more autonomy; ours gives the system more control.

---

## 11. Adoption Assessment

### Feature-by-Feature Assessment

| # | HZL Feature | Verdict | Rationale |
|---|-------------|---------|-----------|
| 1 | **Event sourcing** | **INSPIRE** | Our file-based approach works but lacks auditability. Consider event-sourcing our pipeline tasks for debugging/replay. However, full adoption would be over-engineering since our task lifecycle is simpler (create -> process -> ack). |
| 2 | **Atomic claiming** | **INSPIRE** | Our concurrency pool + per-project locking already handles this, but HZL's `BEGIN IMMEDIATE` pattern is more elegant. Could improve our locking if we ever hit race conditions. Currently not a problem. |
| 3 | **Decision traces** | **ADOPT** | Brilliant idea. When our pipeline rejects or fails a task, we should return structured decision traces explaining why. Currently our error handling is unstructured. Easy to add to `pipeline.ts` result files. |
| 4 | **Checkpoints** | **INSPIRE** | Our system uses session continuity + CLAUDE.local.md for context. HZL's structured checkpoints with JSON data could enhance our pipeline results -- add a `checkpoints` array to result files so Gregor can see intermediate progress. |
| 5 | **Workflow handoff** | **INSPIRE** | We already have reverse pipeline for delegation. HZL's handoff pattern (complete + create follow-on with carried context) is a cleaner abstraction. Consider adding a `handoff` task type to our pipeline. |
| 6 | **Workflow delegate** | **SKIP** | We already have this via `/delegate` command and reverse pipeline. Our implementation is more tightly integrated with Telegram UX. |
| 7 | **Project pools** | **INSPIRE** | Our named-agent routing is simpler but less flexible. Project pools could be useful if we add more agents beyond Isidore/Gregor. Not needed now with only 2 agents. |
| 8 | **Web dashboard** | **SKIP** | We use Telegram as our primary UI. A Kanban dashboard would be nice-to-have but not critical for our mobile-first use case. Could revisit later. |
| 9 | **Hook outbox pattern** | **ADOPT** | The durable outbox with exponential backoff and lock-based claiming is production-grade. Our pipeline currently has no webhook/notification system for task completion beyond writing result files. Adopting this pattern for notifying Telegram of Gregor pipeline completions would be more robust than our current polling. |
| 10 | **Turso sync** | **SKIP** | We use git + rsync for sync. Adding a Turso dependency for task sync is unnecessary complexity for our 2-agent setup. |
| 11 | **FTS5 search** | **SKIP** | Our pipeline tasks are transient. We don't need to search historical tasks. |
| 12 | **Lease-based claiming** | **INSPIRE** | Our pipeline has `timeout_minutes` but no lease tracking or steal mechanism. If a task processor crashes, the task sits in limbo. HZL's lease + stuck + steal pattern could improve our reliability. |
| 13 | **Idempotency keys** | **ADOPT** | Our pipeline lacks idempotency guarantees. If Gregor submits the same task twice, we process it twice. Adding an `op_id` field to task files with dedup checking would prevent this. Simple to implement. |
| 14 | **Anti-herd stagger** | **SKIP** | With only 2 agents and sequential task processing, we don't have herd behavior. |
| 15 | **Validation service** | **INSPIRE** | Our DAG orchestrator does cycle detection during decomposition, but a standalone validation command would be useful for debugging workflow state. |
| 16 | **Agent stats** | **INSPIRE** | We track nothing about pipeline task stats over time. Adding simple counters (tasks processed, avg time, failure rate) to our pipeline would improve observability. Our rate-limiter already tracks failures but doesn't expose stats. |
| 17 | **Snippet sync system** | **SKIP** | Clever but our documentation is simpler (CLAUDE.md + CLAUDE.local.md). Not worth the build complexity. |
| 18 | **Claude Code plugin format** | **SKIP** | We don't distribute as a plugin. Our system is a deployed service, not a reusable tool. |
| 19 | **Zod event validation** | **ADOPT** | Our task JSON schema is loosely validated. Adding Zod schemas for pipeline task and result files would catch contract mismatches earlier (we already had the `to` vs `to_agent` schema bug with Gregor). |
| 20 | **Database migrations** | **SKIP** | We don't use a database. If we ever move to SQLite, this pattern is good to know. |

### Summary

| Verdict | Count | Features |
|---------|-------|----------|
| **ADOPT** | 4 | Decision traces, Hook outbox pattern, Idempotency keys, Zod validation |
| **INSPIRE** | 7 | Event sourcing, Atomic claiming, Checkpoints, Handoff workflows, Project pools, Lease-based claiming, Agent stats |
| **SKIP** | 9 | Workflow delegate, Dashboard, Turso sync, FTS5, Anti-herd, Snippet sync, Plugin format, Migrations, Validation CLI |

---

## 12. Integration Path (HZL as Bolt-On Plugin)

### Could HZL Be Used Alongside Our System?

**Yes, but with caveats.** HZL could serve as a persistent task ledger alongside our existing file-based pipeline. Here is how it would integrate:

### Architecture: HZL as Sidecar State Store

```
                         ┌──────────────┐
                         │ Telegram Bot  │
                         │ (bridge.ts)   │
                         └───────┬───────┘
                                 │
                    ┌────────────▼────────────┐
                    │   Pipeline Watcher      │
                    │   (pipeline.ts)         │
                    │                         │
                    │  ┌──── hzl CLI ────┐    │
                    │  │ - task add      │    │
                    │  │ - task claim    │    │
                    │  │ - task checkpoint│   │
                    │  │ - task complete │    │
                    │  └─────────────────┘    │
                    │                         │
                    │  ┌── File Pipeline ──┐  │
                    │  │ tasks/ -> results/ │  │
                    │  │ (existing flow)   │  │
                    │  └──────────────────┘   │
                    └─────────────────────────┘
```

### Interface Boundary

The integration would be at the **PipelineWatcher level**:

1. **Before processing a task:** Call `hzl task add` to register the task in HZL, then `hzl task claim --agent isidore`
2. **During processing:** Call `hzl task checkpoint <id> "progress"` at intervals
3. **After completion:** Call `hzl task complete <id>` and write result file as usual
4. **On failure:** Call `hzl task comment <id> "failed: <reason>"` + `hzl task set-status <id> blocked`

### Implementation Sketch

```typescript
// In pipeline.ts, after picking up a task file:
import { execSync } from 'child_process';

function registerWithHzl(task: PipelineTask): string {
  const result = execSync(
    `hzl task add "${task.prompt.slice(0, 128)}" -p pipeline --format json`,
    { encoding: 'utf-8' }
  );
  return JSON.parse(result).task_id;
}

function claimInHzl(hzlTaskId: string): void {
  execSync(`hzl task claim ${hzlTaskId} --agent isidore`);
}

function checkpointInHzl(hzlTaskId: string, message: string): void {
  execSync(`hzl task checkpoint ${hzlTaskId} "${message}"`);
}

function completeInHzl(hzlTaskId: string): void {
  execSync(`hzl task complete ${hzlTaskId}`);
}
```

### Concerns with Bolt-On Approach

1. **Process spawn overhead:** Each HZL CLI call spawns a new Node.js process. With many pipeline tasks, this adds up. Could use `hzl-core` as a library import instead, but that requires Node.js (we run Bun).

2. **Dual state:** Having both file-based pipeline state AND HZL event state creates dual-source-of-truth risk. Need clear ownership: files are the execution pipeline, HZL is the audit/observability layer.

3. **Dependency mismatch:** HZL requires Node.js >= 22. Our system runs on Bun. The CLI would work fine (it's just a subprocess), but importing hzl-core as a library would require compatibility testing with Bun's Node.js API compatibility.

4. **Overkill for 2 agents:** HZL's full event-sourcing machinery is designed for N agents in a pool. With just Isidore and Gregor, the overhead may not be justified.

### Recommended Integration Path

**Phase 1: Cherry-pick patterns, not the tool.**
- Add Zod schemas to pipeline task/result files
- Add decision traces to pipeline results
- Add idempotency checking to pipeline watcher
- Implement outbox pattern for completion notifications

**Phase 2: Evaluate HZL as observability layer (optional).**
- Install `hzl-cli` on VPS
- Mirror pipeline task lifecycle to HZL for audit trail and dashboard
- Use the web dashboard for cross-agent visibility
- Keep file-based pipeline as primary execution path

**Phase 3: Consider HZL as primary (only if scaling beyond 2 agents).**
- If we add 3+ agents, HZL's project-pool model becomes valuable
- Replace file-based pipeline with HZL task lifecycle
- Keep Telegram bridge as the user interface
- Use HZL hooks for Telegram notifications

---

## Appendix: Key Source Files Reference

| File | Lines (approx) | Role |
|------|----------------|------|
| `packages/hzl-core/src/events/types.ts` | ~250 | Event type definitions, Zod schemas, field limits |
| `packages/hzl-core/src/events/store.ts` | ~130 | Append-only event persistence |
| `packages/hzl-core/src/db/schema.ts` | ~200 | SQLite DDL for events.db and cache.db |
| `packages/hzl-core/src/db/datastore.ts` | ~170 | Database connection management, sync |
| `packages/hzl-core/src/db/lock.ts` | ~100 | File-based database locking |
| `packages/hzl-core/src/db/sync-policy.ts` | ~100 | Turso sync policy (manual/opportunistic/strict) |
| `packages/hzl-core/src/projections/engine.ts` | ~80 | Projection coordinator |
| `packages/hzl-core/src/projections/tasks-current.ts` | ~200 | Main state projection |
| `packages/hzl-core/src/projections/dependencies.ts` | ~50 | DAG edge projection |
| `packages/hzl-core/src/services/task-service.ts` | ~900 | Core business logic (claim, complete, checkpoint) |
| `packages/hzl-core/src/services/workflow-service.ts` | ~600 | Built-in workflows (start, handoff, delegate) |
| `packages/hzl-core/src/services/hook-drain-service.ts` | ~350 | Outbox-based webhook delivery |
| `packages/hzl-cli/src/commands/task/claim.ts` | ~400 | Claim command with decision traces |
| `packages/hzl-cli/src/commands/workflow/run.ts` | ~300 | Workflow execution commands |
| `packages/hzl-cli/src/config.ts` | ~250 | Configuration with XDG, dev mode, Turso |
| `packages/hzl-web/src/server.ts` | ~500 | Kanban dashboard server with SSE |
