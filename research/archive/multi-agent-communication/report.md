# Multi-Agent Communication & Collaboration Patterns

**Research Report for Isidore Cloud Ecosystem**
**Date:** 2026-02-28
**Context:** 2-3 AI agent instances on single VPS, expandable to 10+. Currently using filesystem-based JSON pipeline (poll + dispatch).

---

## Table of Contents

1. [Communication Patterns](#1-communication-patterns)
2. [Agent Discovery](#2-agent-discovery)
3. [Task Delegation Patterns](#3-task-delegation-patterns)
4. [Notable Implementations](#4-notable-implementations)
5. [Practical Recommendations](#5-practical-recommendations)
6. [Protocol Proposal](#6-protocol-proposal)
7. [Migration Path](#7-migration-path-from-current-pipeline)

---

## 1. Communication Patterns

### 1A. Message Passing

| Pattern | How It Works | Latency | Complexity | Best Scale |
|---------|-------------|---------|------------|------------|
| **Filesystem (current)** | JSON files in shared dirs, polling | 1-5s (poll interval) | Very low | 2-5 agents |
| **Unix Domain Sockets** | Stream/datagram via `/tmp/agent-*.sock` | <1ms | Low | 2-20 agents |
| **Pub/Sub (Redis)** | Agents subscribe to channels, publish messages | <1ms | Medium | 5-100+ agents |
| **Point-to-Point (TCP)** | Direct socket connections between agents | <1ms | Medium | 2-10 agents |
| **Broadcast (UDP multicast)** | All agents receive all messages | <1ms | Low | 5-50 agents |

**Analysis for your context:**

- **Filesystem polling** is what you have now. It works well at 2-3 agents because the simplicity outweighs the latency cost. The 5-second poll interval is acceptable for tasks that take minutes to execute. The atomic write pattern (`.tmp` then rename) prevents partial reads. The main limitation: at 10+ agents, you get O(N) polling overhead and no ordering guarantees across agents.

- **Unix Domain Sockets** are the natural next step for a single VPS. Bun has native support via `Bun.listen()` and `Bun.connect()` on Unix sockets. Zero network overhead, kernel-mediated, and they support both stream (reliable) and datagram (fire-and-forget) modes. Each agent listens on `/tmp/pai-agent-{name}.sock` and peers connect directly. This eliminates polling entirely.

- **Redis Pub/Sub** becomes valuable at 5+ agents. It provides channel-based routing (agents subscribe to their own channel plus broadcast channels), message persistence via Redis Streams, consumer groups for load balancing, and built-in backpressure. Redis adds an external dependency but consolidates state management, task queues, and pub/sub into one service.

### 1B. Shared State

| Approach | Consistency | Persistence | Complexity | Best For |
|----------|------------|-------------|------------|----------|
| **Shared filesystem** | Eventual (fsync) | Yes | Very low | Config, task files, results |
| **SQLite (single writer)** | Strong (WAL mode) | Yes | Low | Task queues, agent state, audit log |
| **Redis** | Strong (single-threaded) | Optional (RDB/AOF) | Medium | Hot state, pub/sub, counters |
| **PostgreSQL** | Strong (MVCC) | Yes | High | Complex queries, multi-table joins |

**Analysis:**

- **SQLite in WAL mode** is the sweet spot for 2-10 agents on a single VPS. Bun has native `bun:sqlite` with zero-copy performance. WAL mode allows concurrent readers with a single writer. Perfect for: task queue (single writer dispatches), agent registry (heartbeats), result aggregation (append-only). No external process to manage.

- **Redis** is justified at 10+ agents or when you need pub/sub + state in one system. It replaces both the filesystem polling AND shared state with a single sub-millisecond service. Redis Streams provide exactly-once delivery with consumer groups, which is critical for task distribution at scale.

- **Shared filesystem** remains viable for results and artifacts (large outputs, file attachments) at any scale. Don't try to push large blobs through sockets or Redis -- keep the filesystem for that.

### 1C. RPC-Style

| Pattern | Protocol | Bun Support | Latency | Best For |
|---------|----------|-------------|---------|---------|
| **HTTP/REST** | HTTP/1.1 or HTTP/2 | `Bun.serve()` native | 1-5ms | Request/response, health checks |
| **Unix Socket + HTTP** | HTTP over UDS | `Bun.serve({ unix: path })` | <1ms | Same as HTTP but no TCP overhead |
| **Bun IPC** | Bun-native structured clone | `Bun.spawn({ ipc })` | <1ms | Parent-child only |
| **gRPC** | HTTP/2 + Protobuf | Via `@grpc/grpc-js` | 1-3ms | Typed contracts, streaming |
| **JSON-RPC over WebSocket** | WS | `Bun.serve({ websocket })` | <1ms | Bidirectional, persistent connection |

**Analysis:**

- **HTTP over Unix sockets** (`Bun.serve({ unix: "/tmp/pai-agent-isidore.sock" })`) is the recommended RPC pattern. You get the full HTTP ecosystem (status codes, headers, content types) with zero TCP overhead. Each agent runs its own HTTP server on a Unix socket. Agents call each other with `fetch("unix:///tmp/pai-agent-gregor.sock/api/task")`. Bun supports this natively.

- **Bun IPC** is excellent but limited to parent-child process relationships. It uses structured clone serialization over Unix domain sockets internally. Ideal for the bridge spawning Claude processes, which you already do. Not suitable for peer-to-peer agent communication.

- **JSON-RPC over WebSocket** is worth considering for persistent bidirectional channels between agents that need ongoing conversation (e.g., a pair working on the same file). WebSocket support in Bun is native and performant.

### Scale Recommendations

| Scale | Primary Communication | Shared State | RPC |
|-------|----------------------|--------------|-----|
| **2-3 agents** | Filesystem (keep current) or Unix sockets | SQLite WAL | HTTP over Unix socket |
| **4-9 agents** | Unix sockets + simple pub/sub | SQLite WAL | HTTP over Unix socket |
| **10+ agents** | Redis Pub/Sub + Streams | Redis + SQLite (audit) | HTTP over Unix socket |

---

## 2. Agent Discovery

### 2A. Static Registry

```typescript
// agents.json — static agent registry
{
  "agents": [
    {
      "id": "isidore",
      "socket": "/tmp/pai-agent-isidore.sock",
      "capabilities": ["typescript", "pipeline", "telegram", "orchestration"],
      "owner": "marius",
      "priority": 1
    },
    {
      "id": "gregor",
      "socket": "/tmp/pai-agent-gregor.sock",
      "capabilities": ["research", "analysis", "code-review", "overnight-queue"],
      "owner": "marius",
      "priority": 2
    }
  ]
}
```

**Pros:** Zero infrastructure, human-readable, version-controlled, trivial to implement.
**Cons:** Manual updates when agents change, no health awareness, stale entries if agent crashes.

**Verdict for 2-3 agents:** This is all you need. Add a health check endpoint (`GET /health`) that returns agent status, and poll it every 30 seconds.

### 2B. Dynamic Discovery with Heartbeat

```typescript
// Each agent announces itself on startup and heartbeats every 10s
interface AgentHeartbeat {
  id: string;
  socket: string;
  capabilities: string[];
  load: number;          // 0.0-1.0 current utilization
  lastHeartbeat: number; // Unix timestamp
  version: string;
  status: "ready" | "busy" | "draining";
}

// Central registry (SQLite or Redis hash)
// Agent is "alive" if lastHeartbeat < 30 seconds ago
// Agent is "dead" if lastHeartbeat > 60 seconds ago → remove from routing
```

**Pros:** Self-healing, load-aware, agents can join/leave without config changes.
**Cons:** Requires heartbeat infrastructure, adds complexity.

**Verdict for 10+ agents:** Dynamic discovery becomes essential. Without it, adding agent #11 requires editing config on every other agent. With it, a new agent starts up, announces itself, and is immediately routable.

### 2C. What's NOT Appropriate

- **mDNS/Bonjour:** Designed for LAN service discovery. Overkill and fragile for processes on the same machine.
- **Service mesh (Consul, Istio):** Designed for distributed microservices across multiple hosts. Massive overhead for single-VPS.
- **Kubernetes service discovery:** You're on a single VPS, not a cluster.

### Scale Recommendations

| Scale | Discovery | Implementation |
|-------|-----------|----------------|
| **2-3 agents** | Static JSON config + health endpoint | `agents.json` + `GET /health` every 30s |
| **4-9 agents** | Static config + heartbeat table | SQLite `agent_registry` table, 10s heartbeat |
| **10+ agents** | Dynamic heartbeat + capability index | Redis hash + sorted sets for capability lookup |

---

## 3. Task Delegation Patterns

### 3A. Work Queues

**Simple FIFO Queue (current approach):**
Your current pipeline is essentially a filesystem-based work queue. Tasks land in `tasks/`, get processed in directory-listing order (roughly FIFO), and move to `ack/`. This works but has no priority awareness beyond your `PRIORITY_ORDER` sort.

**Priority Queue (current approach, enhanced):**
You already sort by priority within each poll batch. A SQLite-backed queue would make this more robust:

```typescript
// SQLite priority queue
CREATE TABLE task_queue (
  id TEXT PRIMARY KEY,
  priority INTEGER DEFAULT 2,  -- 1=low, 2=normal, 3=high, 4=critical
  created_at INTEGER NOT NULL,
  claimed_by TEXT,              -- agent ID or NULL
  claimed_at INTEGER,
  status TEXT DEFAULT 'pending', -- pending, claimed, running, completed, failed
  payload JSON NOT NULL,
  result JSON,
  error TEXT
);

// Claim next task (atomic): agent grabs highest-priority unclaimed task
UPDATE task_queue
SET claimed_by = ?, claimed_at = ?, status = 'claimed'
WHERE id = (
  SELECT id FROM task_queue
  WHERE status = 'pending'
  ORDER BY priority DESC, created_at ASC
  LIMIT 1
)
RETURNING *;
```

### 3B. Capability-Based Routing

Instead of "whoever picks it up first," route tasks to agents that can handle them:

```typescript
interface TaskRoutingRule {
  // Match criteria
  taskType?: string;         // "code-review", "research", "deploy"
  projectMatch?: string;     // glob pattern for project name
  requiredCapabilities?: string[]; // agent must have ALL of these

  // Routing action
  preferredAgent?: string;   // try this agent first
  fallbackAgents?: string[]; // if preferred is busy
  loadBalance?: boolean;     // distribute across capable agents
}

// Example routing rules
const rules: TaskRoutingRule[] = [
  { taskType: "code-review",  requiredCapabilities: ["typescript", "code-review"], preferredAgent: "gregor" },
  { taskType: "deploy",       requiredCapabilities: ["deploy", "ssh"], preferredAgent: "isidore" },
  { taskType: "research",     requiredCapabilities: ["research"], loadBalance: true },
  { taskType: "overnight-prd", requiredCapabilities: ["analysis"], preferredAgent: "gregor" },
];
```

### 3C. Auction/Bidding

Agents bid on tasks based on their current capacity and suitability:

```typescript
// 1. Dispatcher broadcasts task availability
interface TaskAnnouncement {
  taskId: string;
  type: string;
  estimatedMinutes: number;
  deadline?: number;
}

// 2. Agents respond with bids
interface AgentBid {
  agentId: string;
  taskId: string;
  confidence: number;       // 0.0-1.0 how well-suited
  estimatedMinutes: number; // agent's own estimate
  currentLoad: number;      // 0.0-1.0
  score: number;            // composite: confidence * (1 - currentLoad)
}

// 3. Dispatcher awards to highest score
// Timeout: if no bids within 5s, assign to least-loaded capable agent
```

**When to use:** Only at 5+ agents where load balancing matters. At 2-3 agents, the overhead of bidding exceeds the benefit -- just use capability routing with static preferences.

### 3D. How Modern Frameworks Handle Delegation

| Framework | Delegation Pattern | Key Mechanism |
|-----------|-------------------|---------------|
| **AutoGen** | Conversation-based | Agents "talk" to decide who handles what; GroupChat manager selects next speaker |
| **CrewAI** | Role-based hierarchy | Manager agent assigns tasks to workers based on role definitions |
| **LangGraph** | Graph edges | Static or conditional edges determine which node (agent) runs next |
| **Magentic-One** | Orchestrator loops | Orchestrator maintains task/progress ledgers, assigns to specialized agents |
| **Claude Code Teams** | Lead + teammates | Lead creates tasks, teammates self-select from shared task list |

### Scale Recommendations

| Scale | Delegation | Why |
|-------|-----------|-----|
| **2-3 agents** | Static capability routing | You know your agents. Hard-code preferences. |
| **4-9 agents** | Capability routing + priority queue | SQLite queue, agents claim work matching their capabilities |
| **10+ agents** | Auction/bidding + load balancing | Dynamic load distribution, self-organizing |

---

## 4. Notable Implementations

### 4A. Claude Code Agent Teams (Anthropic, Feb 2026)

**Architecture:** JSON files on disk. No database, no message broker, no IPC.

**How it works:**
- One session acts as team lead, coordinates work
- Teammates are independent Claude Code sessions, each with own context window
- Communication via `SendMessage` tool (writes to teammate's inbox file)
- Shared `TaskCreate`/`TaskList` for work coordination
- Team lead creates tasks, teammates pick them up

**Key design insight:** The entire multi-agent system is filesystem-based JSON -- proving that for AI agent coordination, you do NOT need fancy infrastructure. The bottleneck is LLM inference time (seconds to minutes), not message passing latency (milliseconds).

**Relevance to Isidore:** This validates your current filesystem approach. Claude Code's agent teams are essentially the same pattern as your pipeline: JSON files in a shared directory. The difference is they add structured task management (TaskCreate/TaskList) and direct messaging (SendMessage) on top.

**Takeaway:** For AI agents where each "task" takes 30s-5min of LLM processing, filesystem IPC is not just acceptable -- it's pragmatically optimal. The infrastructure complexity of Redis/sockets is only justified when you need sub-second coordination or 10+ agents.

### 4B. AutoGen (Microsoft, v0.4+)

**Architecture:** Event-driven, asynchronous kernel (AutoGen-Core) with high-level API (AgentChat).

**Key patterns:**
- **Two-agent chat:** Simplest -- two agents converse until task complete
- **Sequential chat:** Chain of conversations with carryover mechanism
- **Group chat:** N agents with a "speaker selection" policy (round-robin, LLM-selected, or custom function)
- **Swarm:** Event-driven handoffs between agents based on conversation state

**Design insight:** AutoGen v0.4 decouples message delivery from message handling. This means you can swap transport (in-process, cross-process, cross-machine) without changing agent logic. The event-driven design naturally supports both static workflows and dynamic, conversation-driven routing.

**Current status:** AutoGen is now in maintenance mode. Microsoft is migrating to the Microsoft Agent Framework (GA targeted Q1 2026), which merges AutoGen concepts with Semantic Kernel.

**Takeaway:** The conversation-as-protocol pattern is powerful for AI agents. Instead of RPC-style "do this task," agents negotiate through dialogue. This is more flexible but harder to debug. Best suited for research/analysis tasks, less suited for deterministic pipelines.

### 4C. CrewAI

**Architecture:** Role-based hierarchy with manager/worker/researcher archetypes.

**Key patterns:**
- **Role definition:** Each agent has a role (string), goal, backstory, and allowed tools
- **Task delegation:** Manager assigns tasks to workers based on role match
- **Sequential process:** Tasks execute in defined order, output feeds to next task
- **Hierarchical process:** Manager dynamically assigns and re-assigns based on progress
- **Flows:** Event-driven workflows for production (added 2025)

**Design insight:** CrewAI's power is in its simplicity -- you define roles in natural language, and the framework handles delegation. The "crew" metaphor maps well to real-world team structures. However, it's Python-only with no TypeScript port.

**Takeaway:** The role-based capability model is directly applicable to your system. You already have implicit roles (Isidore = bridge/orchestrator, Gregor = overnight analysis). Making these explicit with capability declarations enables automatic routing.

### 4D. LangGraph

**Architecture:** Directed graph of nodes (agents/functions) connected by edges (decision logic), with persistent shared state.

**Key patterns:**
- **StateGraph:** Central state object that persists across the graph, enabling retries and branching
- **Conditional edges:** Runtime decisions about which node executes next
- **Cycles:** Unlike DAGs, LangGraph supports cycles (agent loops, retry patterns)
- **Subgraphs:** Nested graphs for modular agent teams
- **Checkpointing:** State snapshots for debugging and recovery

**Design insight:** LangGraph treats multi-agent orchestration as a state machine problem. The graph is the workflow, nodes are agents, edges are transitions, and state flows through. This gives you: (1) visual debugging (the graph IS the architecture diagram), (2) deterministic replay (checkpoint any state), (3) human-in-the-loop at any node.

**Relevance:** Your TaskOrchestrator already implements a DAG-based workflow. LangGraph's contribution is showing that cycles (retry loops) and persistent checkpointing are essential for production. Your orchestrator could benefit from adding cycle support for retry patterns.

**Takeaway:** Graph-based orchestration is the most production-ready pattern for complex workflows. TypeScript implementation via LangGraph.js exists but is tightly coupled to LangChain. Better to implement the pattern (stateful graph with conditional edges) than adopt the framework.

### 4E. Magentic-One (Microsoft)

**Architecture:** Orchestrator + 4 specialized agents (WebSurfer, FileSurfer, Coder, ComputerTerminal).

**Key patterns:**
- **Dual-loop orchestration:** Outer loop manages "task ledger" (facts, guesses, plan), inner loop manages "progress ledger" (current progress, agent assignment)
- **Ledger-based coordination:** Instead of message passing, the orchestrator maintains structured ledgers that agents read/write
- **Model-agnostic:** Each agent can use a different LLM (GPT-4o for complex tasks, smaller models for routine work)
- **Self-correction:** Orchestrator detects stalls and re-plans

**Design insight:** The dual-loop pattern separates "what needs to happen" (task ledger) from "what is happening" (progress ledger). This is similar to your orchestrator's workflow decomposition, but with an added re-planning capability when tasks stall.

**Takeaway:** The ledger pattern is directly implementable. Your orchestrator already has workflow persistence (`workflows/*.json`). Adding a progress ledger that tracks per-step status, elapsed time, and stall detection would enable automatic re-planning.

### Implementation Comparison Matrix

| Feature | Claude Code Teams | AutoGen v0.4 | CrewAI | LangGraph | Magentic-One |
|---------|------------------|-------------|--------|-----------|-------------|
| **Language** | Any (CLI) | Python | Python | Python/JS | Python |
| **IPC mechanism** | Filesystem JSON | In-process events | In-process | In-process graph | In-process |
| **Discovery** | Static (team definition) | Code-defined | Code-defined | Graph-defined | Fixed topology |
| **Delegation** | Task list + self-select | Speaker selection | Role-based | Edge conditions | Orchestrator assigns |
| **State sharing** | Shared filesystem | Message passing | Task context | StateGraph object | Ledger objects |
| **Persistence** | JSON on disk | Optional checkpoints | None built-in | Checkpoint system | Ledger files |
| **Scale limit** | ~10 (filesystem) | ~50 (in-process) | ~20 (role complexity) | ~100 (graph size) | 5 (fixed topology) |
| **TypeScript** | Yes (CLI-based) | No | No | Yes (LangGraph.js) | No |

---

## 5. Practical Recommendations

### 5A. Simplest Effective Pattern for 2-3 Agents (NOW)

**Recommendation: Enhanced Filesystem Pipeline + SQLite Registry**

Your current filesystem pipeline is not a limitation -- it's a validated pattern (Claude Code teams use the same approach). For 2-3 agents, enhance it rather than replace it:

```
Current:  JSON files → poll → dispatch → result files
Enhanced: JSON files → poll → dispatch → result files
          + SQLite agent registry (heartbeat, capabilities)
          + SQLite task audit log (what ran where, when, outcome)
          + Health endpoint per agent (HTTP over Unix socket)
```

**What to add (in order of value):**

1. **Agent registry table** (SQLite): Track which agents are alive, their capabilities, current load. This is 50 lines of code and gives you capability-based routing.

2. **Task audit log** (SQLite): Every task submission, claim, completion, failure logged with timestamps. Enables debugging "why did task X go to agent Y?" and performance analysis.

3. **Health endpoint** per agent: `Bun.serve({ unix: "/tmp/pai-agent-isidore.sock" })` with `GET /health` returning `{ status, load, uptime, activeTasks }`. Other agents and monitoring can check this.

4. **Structured error propagation**: When a task fails, include: error type, stack trace, partial result, retry-eligible flag. Your current `PipelineResult` has `error?: string` -- make it structured.

**Why NOT sockets for communication yet:** Your tasks take 30s-5min each. The 5-second poll interval is <2% overhead. Switching to push-based communication saves 5 seconds per task but adds socket lifecycle management, connection pooling, and reconnection logic. Not worth it at 2-3 agents.

### 5B. Upgrade Path to 10+ Agents

**Phase 1 (Current → 5 agents): Keep filesystem, add SQLite**

```
filesystem pipeline (proven, simple)
  + SQLite agent registry
  + SQLite task queue (replaces directory polling)
  + capability-based routing
  + health monitoring
```

The key change: move the task queue from filesystem to SQLite. Instead of polling a directory, agents poll a SQLite table with atomic `UPDATE ... RETURNING` for claiming tasks. This gives you: priority ordering, deduplication, claimed-by tracking, retry management, and audit trail -- all in one query.

**Phase 2 (5 → 10 agents): Add message bus**

```
SQLite task queue (persistence + audit)
  + Redis pub/sub (real-time notifications)
  + Redis Streams (ordered task delivery)
  + Unix socket health endpoints → Redis health hashes
```

The key change: add Redis as a real-time notification layer ON TOP of SQLite. SQLite remains the source of truth for task state. Redis pub/sub notifies agents "new task available" instantly (eliminating polling). Redis Streams provide ordered, exactly-once delivery for task assignment.

**Phase 3 (10+ agents): Full Redis + agent mesh**

```
Redis Streams (task queue + delivery)
  + Redis pub/sub (events, health, coordination)
  + Redis hashes (agent registry, hot state)
  + SQLite (cold storage, audit, analytics)
  + Dynamic agent discovery (heartbeat + capability index)
  + Auction-based task delegation
```

The key change: Redis becomes the primary coordination layer. SQLite drops to audit/analytics. Agents self-register, discover peers, and bid on tasks dynamically.

### 5C. Cross-Cutting Concerns

#### Agent Health Monitoring

```typescript
interface AgentHealth {
  id: string;
  status: "ready" | "busy" | "draining" | "dead";
  uptime: number;
  activeTasks: number;
  maxConcurrent: number;
  memoryUsageMB: number;
  lastHeartbeat: number;
  failureCount: number;       // sliding window (last hour)
  averageTaskDurationMs: number;
}

// Health check protocol:
// 1. Each agent exposes GET /health on its Unix socket
// 2. Monitor polls every 10s (or agents push heartbeat to SQLite/Redis)
// 3. Agent "dead" after 3 missed heartbeats (30s)
// 4. Dead agent's claimed tasks are re-queued with retry flag
```

#### Task Routing

```typescript
function routeTask(task: PipelineTask, agents: AgentHealth[]): string | null {
  // 1. Filter to alive agents with required capabilities
  const capable = agents.filter(a =>
    a.status !== "dead" &&
    hasCapabilities(a.id, task.type)
  );

  // 2. Filter to agents with capacity
  const available = capable.filter(a =>
    a.activeTasks < a.maxConcurrent
  );

  // 3. Score by suitability (lower is better)
  const scored = available.map(a => ({
    id: a.id,
    score: a.activeTasks / a.maxConcurrent  // load ratio
      + (a.failureCount * 0.1)               // penalize unreliable
      - (isPreferred(a.id, task.type) ? 0.5 : 0) // prefer specialists
  }));

  // 4. Return lowest score, or null if no agents available
  scored.sort((a, b) => a.score - b.score);
  return scored[0]?.id ?? null;
}
```

#### Result Aggregation

```typescript
interface AggregatedResult {
  workflowId: string;
  totalTasks: number;
  completed: number;
  failed: number;
  pending: number;
  results: Map<string, PipelineResult>;

  // Computed
  successRate: number;
  totalDurationMs: number;
  bottleneckTask: string;    // longest-running task ID
  errorSummary: string[];    // deduplicated error messages
}

// Aggregation happens in the orchestrator after all DAG steps complete
// Write aggregated result to results/workflow-<taskId>.json (you already do this)
```

#### Error Propagation

```typescript
interface StructuredError {
  type: "timeout" | "crash" | "rate-limited" | "validation" | "claude-error";
  message: string;
  stack?: string;
  retryable: boolean;
  retryAfterMs?: number;
  partialResult?: string;     // what was accomplished before failure
  context: {
    agentId: string;
    taskId: string;
    phase: string;            // which pipeline phase failed
    attemptNumber: number;
  };
}

// Error propagation chain:
// Agent error → PipelineResult.error (structured) → Orchestrator →
//   if retryable: re-queue with attempt+1, backoff
//   if not retryable: mark workflow step failed, notify dependents
//   if critical: halt workflow, alert via Telegram
```

---

## 6. Protocol Proposal

### Message Envelope (Universal)

Every inter-agent message uses this envelope, regardless of transport (filesystem, socket, Redis):

```typescript
interface AgentMessage {
  // Routing
  id: string;                 // UUID v7 (time-sortable)
  from: string;               // sender agent ID
  to: string | "*";           // recipient agent ID or "*" for broadcast
  replyTo?: string;           // message ID this replies to (for request/response)

  // Classification
  type: "task" | "result" | "heartbeat" | "event" | "query" | "command";
  priority: 1 | 2 | 3 | 4;   // low, normal, high, critical

  // Metadata
  timestamp: string;          // ISO 8601
  ttl?: number;               // seconds until message expires
  correlationId?: string;     // groups related messages (e.g., all messages in a workflow)

  // Payload (type-specific)
  payload: TaskPayload | ResultPayload | HeartbeatPayload | EventPayload | QueryPayload | CommandPayload;
}
```

### Payload Types

```typescript
interface TaskPayload {
  project: string;
  prompt: string;
  context?: Record<string, unknown>;
  constraints?: Record<string, unknown>;
  timeout_minutes?: number;
  max_turns?: number;
  requiredCapabilities?: string[];
  session_id?: string;
}

interface ResultPayload {
  taskId: string;
  status: "completed" | "error" | "partial";
  result?: string;
  structured?: StructuredResult;
  error?: StructuredError;
  usage?: { inputTokens: number; outputTokens: number; durationMs: number };
}

interface HeartbeatPayload {
  status: "ready" | "busy" | "draining";
  capabilities: string[];
  load: number;
  activeTasks: number;
  memoryMB: number;
  version: string;
}

interface EventPayload {
  event: string;              // "agent.started" | "agent.stopping" | "task.claimed" | "workflow.completed"
  data: Record<string, unknown>;
}

interface QueryPayload {
  query: "capabilities" | "status" | "task-status";
  params?: Record<string, unknown>;
}

interface CommandPayload {
  command: "drain" | "resume" | "shutdown" | "reconfigure";
  params?: Record<string, unknown>;
}
```

### Backward Compatibility with Current Pipeline

The current `PipelineTask` maps cleanly to `AgentMessage`:

```typescript
// Current PipelineTask → AgentMessage
function pipelineTaskToMessage(task: PipelineTask): AgentMessage {
  return {
    id: task.id,
    from: task.from,
    to: task.to,
    type: "task",
    priority: task.priority === "high" ? 3 : task.priority === "low" ? 1 : 2,
    timestamp: task.timestamp,
    payload: {
      project: task.project ?? "default",
      prompt: task.prompt,
      context: task.context,
      constraints: task.constraints,
      timeout_minutes: task.timeout_minutes,
      max_turns: task.max_turns,
      session_id: task.session_id,
    } as TaskPayload,
  };
}
```

### Transport Adapters

The protocol is transport-agnostic. Each transport implements:

```typescript
interface Transport {
  send(msg: AgentMessage): Promise<void>;
  subscribe(agentId: string, handler: (msg: AgentMessage) => void): void;
  unsubscribe(agentId: string): void;
}

// Filesystem transport (current -- backward compatible)
class FilesystemTransport implements Transport { /* write JSON to tasks/ */ }

// Unix socket transport (Phase 1 upgrade)
class UnixSocketTransport implements Transport { /* HTTP over UDS */ }

// Redis transport (Phase 2 upgrade)
class RedisTransport implements Transport { /* pub/sub + streams */ }

// Composite transport (migration period -- write to both)
class CompositeTransport implements Transport {
  constructor(private primary: Transport, private fallback: Transport) {}
  async send(msg: AgentMessage) {
    try { await this.primary.send(msg); }
    catch { await this.fallback.send(msg); }
  }
}
```

---

## 7. Migration Path from Current Pipeline

### Current State Assessment

Your current pipeline (`pipeline.ts`) is a well-implemented filesystem-based work queue with:
- Polling at 5s intervals
- Priority sorting within batches
- Concurrency pool with per-project locking
- Atomic file writes (tmp + rename)
- Branch isolation per task
- Resource guard + rate limiter + verifier

This is solid infrastructure. The migration should PRESERVE these patterns while upgrading the transport and coordination layers.

### Migration Steps

**Step 1: Introduce AgentMessage envelope (0 infrastructure change)**
- Wrap existing `PipelineTask` in the `AgentMessage` envelope
- Update `PipelineWatcher` to parse both old and new formats (backward compatible)
- Update `PipelineResult` to use `ResultPayload` structure
- All existing filesystem transport continues working

**Step 2: Add SQLite agent registry + task log (minimal infrastructure)**
- `bun:sqlite` is built-in, zero dependencies
- Create `agent_registry` table (heartbeats, capabilities, load)
- Create `task_log` table (audit trail of every task)
- `PipelineWatcher` writes to both filesystem AND SQLite
- Health endpoint on Unix socket per agent

**Step 3: Replace filesystem polling with SQLite queue (same infrastructure)**
- Move task queue from directory scan to SQLite `task_queue` table
- Atomic claim with `UPDATE ... RETURNING` (replaces `readdir` + `rename`)
- Keep filesystem for result delivery (large payloads)
- Keep filesystem for backward compatibility (Gregor's `pai-submit.sh` still writes JSON files; a small adapter reads them into SQLite)

**Step 4: Add push notifications via Unix socket (when 4+ agents)**
- Each agent listens on `/tmp/pai-agent-{name}.sock`
- When a task is queued, notify the target agent immediately via socket
- Fallback to polling if socket connection fails
- SQLite remains source of truth; sockets are notification-only

**Step 5: Add Redis layer (when 10+ agents)**
- Redis pub/sub replaces Unix socket notifications
- Redis Streams replace SQLite task queue for hot path
- SQLite drops to cold storage / audit
- Full dynamic discovery via Redis hashes

### Migration Timeline Estimate

| Step | Effort | Prerequisite | Agents |
|------|--------|-------------|--------|
| Step 1 (envelope) | 2-3 hours | None | 2-3 |
| Step 2 (SQLite registry) | 3-4 hours | Step 1 | 2-3 |
| Step 3 (SQLite queue) | 4-6 hours | Step 2 | 3-5 |
| Step 4 (Unix sockets) | 4-6 hours | Step 3 | 4-9 |
| Step 5 (Redis) | 8-12 hours | Step 4 | 10+ |

Each step is independently valuable and backward compatible. You can stop at any step and have a working system.

---

## Sources

- [Claude Code Agent Teams Documentation](https://code.claude.com/docs/en/agent-teams)
- [Claude Code Agent Teams Deep Dive](https://www.claudecodecamp.com/p/claude-code-agent-teams-how-they-work-under-the-hood)
- [AutoGen Conversation Patterns](https://microsoft.github.io/autogen/0.2/docs/tutorial/conversation-patterns/)
- [Microsoft Agent Framework Migration](https://learn.microsoft.com/en-us/agent-framework/migration-guide/from-autogen/)
- [CrewAI Framework Review](https://latenode.com/blog/ai-frameworks-technical-infrastructure/crewai-framework/crewai-framework-2025-complete-review-of-the-open-source-multi-agent-ai-platform)
- [CrewAI Role-Based Orchestration](https://www.digitalocean.com/community/tutorials/crewai-crash-course-role-based-agent-orchestration)
- [LangGraph Architecture Guide](https://latenode.com/blog/ai-frameworks-technical-infrastructure/langgraph-multi-agent-orchestration/langgraph-ai-framework-2025-complete-architecture-guide-multi-agent-orchestration-analysis)
- [LangGraph Multi-Agent Orchestration](https://latenode.com/blog/ai-frameworks-technical-infrastructure/langgraph-multi-agent-orchestration/langgraph-multi-agent-orchestration-complete-framework-guide-architecture-analysis-2025)
- [Magentic-One (Microsoft Research)](https://www.microsoft.com/en-us/research/articles/magentic-one-a-generalist-multi-agent-system-for-solving-complex-tasks/)
- [Magentic Agent Orchestration](https://learn.microsoft.com/en-us/semantic-kernel/frameworks/agent/agent-orchestration/magentic)
- [Redis AI Agent Architecture Patterns](https://redis.io/blog/ai-agent-architecture-patterns/)
- [Redis Multi-Agent Systems](https://redis.io/blog/multi-agent-systems-coordinated-ai/)
- [Bun IPC Documentation](https://bun.com/docs/guides/process/ipc)
- [Bun Unix Socket API](https://bun.com/reference/bun/Socket)
- [From Tasks to Swarms: Agent Teams in Claude Code](https://alexop.dev/posts/from-tasks-to-swarms-agent-teams-in-claude-code/)
