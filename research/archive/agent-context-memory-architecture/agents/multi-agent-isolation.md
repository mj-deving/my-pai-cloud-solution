# Multi-Agent Context Isolation, Shared State, and Inter-Agent Communication
## Production Patterns 2025-2026

**Date:** 2026-03-02
**Requested by:** Marius
**Context:** Informing PAI's multi-agent architecture (Isidore Cloud + Gregor + future agents)
**Research mode:** Extensive (9 vectors, 18+ web searches, 8 deep-dive fetches)
**Prior art:** Builds on 2026-03-01 agent-context-memory-architecture report

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Context Leakage Prevention Mechanisms](#2-context-leakage-prevention-mechanisms)
3. [Framework-Specific Isolation Architectures](#3-framework-specific-isolation-architectures)
4. [Inter-Agent Communication Protocols](#4-inter-agent-communication-protocols)
5. [Swarm Coordination Without Context Bloat](#5-swarm-coordination-without-context-bloat)
6. [Memory Scope Hierarchy](#6-memory-scope-hierarchy)
7. [Cross-Agent Memory Patterns](#7-cross-agent-memory-patterns)
8. [Permission Models for Shared State](#8-permission-models-for-shared-state)
9. [State Synchronization and Conflict Resolution](#9-state-synchronization-and-conflict-resolution)
10. [Failure Isolation and Security Boundaries](#10-failure-isolation-and-security-boundaries)
11. [Production Case Studies](#11-production-case-studies)
12. [Anti-Patterns and Lessons Learned](#12-anti-patterns-and-lessons-learned)
13. [Architecture Reference Diagrams](#13-architecture-reference-diagrams)
14. [Recommendations for PAI-Scale Systems](#14-recommendations-for-pai-scale-systems)

---

## 1. Executive Summary

Multi-agent AI systems in 2025-2026 have converged on a set of production patterns for context isolation, shared state management, and inter-agent communication. The core insight across all frameworks: **isolation is the default, sharing is the exception**. Failure rates of 41-86.7% in unstructured multi-agent deployments (the "bag of agents" anti-pattern) have driven the industry toward structured topologies with centralized orchestration, explicit state boundaries, and permission-controlled memory sharing.

Key findings:

- **Context leakage** is prevented through schema-level isolation (LangGraph subgraphs), per-agent memory instances (AutoGen), scope hierarchies (CrewAI), and self-editing memory blocks (Letta)
- **The 17x Error Trap**: Unstructured multi-agent networks amplify errors exponentially; centralized orchestration with functional planes suppresses this
- **Token budget management** follows a 10-15% system / 15-20% tools / 30-40% knowledge / 20-30% history / 10-15% buffer allocation pattern
- **Two standardized protocols** have emerged: Google's A2A (agent-to-agent, HTTPS/JSON-RPC) and Anthropic's MCP (agent-to-tool, JSON-RPC)
- **Git-based memory coordination** (Letta Context Repositories) enables multi-agent writes through worktrees with merge-based conflict resolution
- **OWASP Top 10 for Agentic Applications (2026)** codifies blast radius management, cascading failure containment, and zero-trust inter-agent communication
- **Only 2% of organizations** have deployed agentic AI at scale; 65% cite system complexity as the top barrier

---

## 2. Context Leakage Prevention Mechanisms

Context leakage occurs when information intended for one agent's context bleeds into another agent's decision-making. This is distinct from intentional sharing. The 2025-2026 landscape reveals five primary prevention mechanisms:

### 2.1 Schema-Level Isolation

**Pattern:** Each agent operates on a different state schema. Communication requires explicit transformation functions.

```
Parent Agent State:  { messages: [], plan: string, results: [] }
                          |
                    [transformation]
                          |
Child Agent State:   { query: string, documents: [] }
```

**Implementation:** LangGraph's isolated subgraph pattern. Parent state keys never leak to child. Input/output mapping functions serve as explicit information gates.

**Trade-off:** Maximum isolation at the cost of manual transformation code. Every piece of shared information must be explicitly mapped.

### 2.2 Per-Agent Memory Instances

**Pattern:** Each agent gets its own memory instance with independent storage. No shared memory region exists by default.

**Implementation:** AutoGen 0.4 creates separate `ChatCompletionContext` per agent. Each agent's context is a distinct object that cannot reference another's.

**Trade-off:** Strong isolation but requires explicit message passing for coordination. Agents cannot passively observe each other's state.

### 2.3 Scope Hierarchy with Access Control

**Pattern:** A single memory store with hierarchical scoping. Agents can only read/write within their assigned scope subtree.

```
/global/                    <- all agents can read
/project/my-pai-cloud/      <- project-scoped agents only
/agent/isidore/             <- private to Isidore
/agent/gregor/              <- private to Gregor
```

**Implementation:** CrewAI's `MemoryScope` (read-write subtree) and `MemorySlice` (read-only cross-scope view). Agents get scoped views that restrict visibility.

**Trade-off:** Flexible granularity but requires careful scope assignment. Misconfigured scopes can leak sensitive context.

### 2.4 Context Variables (Invisible-by-Default)

**Pattern:** Structured state that is deliberately invisible to the LLM unless explicitly surfaced through tools or system message templates.

**Implementation:** AG2's `ContextVariables`. Data travels with the conversation but is never injected into prompts unless explicitly requested through:
1. Tool functions with dependency injection
2. System message templates with `{variable}` placeholders
3. Dedicated summary tools

**Trade-off:** Prevents token waste and accidental leakage. However, agents cannot proactively use information they don't know exists.

### 2.5 Self-Editing Memory Blocks

**Pattern:** Agent explicitly manages what stays in its context through memory editing tools. Context is curated, not accumulated.

**Implementation:** Letta/MemGPT's `memory_replace`, `memory_insert`, `memory_rethink` tools. The agent decides what to remember and what to forget.

**Trade-off:** Most sophisticated approach but depends on LLM quality for curation decisions. Poor editing degrades over time.

### 2.6 Cryptographic Boundaries (Emerging)

**Pattern:** Information is shared through cryptographic commitment schemes. Agents reveal information incrementally through authenticated challenges.

**Implementation:** Research-stage. Proposed in the "Open Challenges in Multi-Agent Security" paper (arxiv 2505.02077). Uses bit-commitment, verifiable secret sharing, and zero-knowledge proofs.

**Trade-off:** Maximum security but significant complexity and latency overhead. Not yet production-ready.

---

## 3. Framework-Specific Isolation Architectures

### 3.1 LangGraph (LangChain)

**Isolation model:** Subgraph-based with two modes.

| Mode | State Schema | Communication | Use Case |
|------|-------------|---------------|----------|
| Shared State | Same keys between parent/child | Automatic via shared channels | Agents that share message history |
| Isolated State | Different schemas | Explicit transformation functions | Agents needing private state |

**Key mechanisms:**
- Namespace isolation: Each subgraph gets a unique namespace preventing state collision
- State transformation boundaries: Wrapper functions control exactly what information crosses graph boundaries
- Checkpointer modes: Stateless (fresh per invocation), stateful (accumulating), or disabled
- `include_contents` knob: Controls whether child agents see full context, minimal context, or no prior history

**Production pattern:** Wrap each subagent in its own StateGraph with a unique node name for stable namespace assignment. Avoid relying on call-order-based namespace assignment which breaks when code is refactored.

### 3.2 CrewAI

**Isolation model:** Unified memory with hierarchical scopes.

| Scope Level | Default Access | Configuration |
|-------------|---------------|---------------|
| Crew-level | All agents share everything | Default behavior |
| Agent-level | Scoped views restrict read/write | Explicit scope assignment |
| Per-project | Different storage directories | Storage path configuration |

**Key mechanisms:**
- `MemoryScope`: Read-write access to a single subtree
- `MemorySlice`: Read-only view across multiple branches
- LLM-driven analysis for auto-categorization of memories
- Composite scoring: semantic similarity + recency decay + importance

**Known limitation:** Multi-user isolation is NOT solved out of the box. This is a documented production issue.

### 3.3 AutoGen/AG2

**Isolation model:** Structural isolation through separate model contexts.

| Component | Isolation Boundary | Configuration |
|-----------|-------------------|---------------|
| Model Context | Per-agent instance | `UnboundedChatCompletionContext`, `BufferedChatCompletionContext`, `TokenLimitedChatCompletionContext`, `HeadAndTailChatCompletionContext` |
| Memory | Per-agent attachment | `memory=[]` list with ChromaDB/Redis/Mem0 backends |
| Context Variables | Invisible to LLM by default | Surfaced only through tools or templates |

**Key mechanisms:**
- `HeadAndTailChatCompletionContext`: Keeps first N + last M messages, preserving setup instructions and recent context
- Context-aware handoff: Evaluates context conditions before routing, substitutes current values into LLM condition prompts
- `UpdateSystemMessage`: Dynamically rewrites system prompt with current context variable values before each response

**Security note (2025):** Research identified CORBA attacks (Contagious Recursive Blocking Attacks) achieving 79-100% agent blocking within 1.6-1.9 dialogue turns, highlighting the need for isolation and dynamic interruption mechanisms.

### 3.4 OpenAI Agents SDK (Successor to Swarm)

**Isolation model:** Stateless handoff with context variables.

| Mechanism | Description |
|-----------|-------------|
| Handoffs | Transfer conversation + context to specialized agent |
| System prompt swap | Active agent's instructions replace previous agent's |
| Chat history persistence | Full history maintained across handoffs |
| Context variables | Structured data traveling with messages |
| Guardrails | Input/output validation running in parallel with execution |

**Key design decision:** "Only the instructions of the active Agent will be present at any given time. If there is an Agent handoff, the system prompt will change, but the chat history will not." This means agents share conversation history but NOT each other's instructions.

**Production guardrails:** Input validation, output validation, and safety checks run in parallel with agent execution. Fail-fast semantics when checks do not pass. Sandboxed code execution in isolated containers.

### 3.5 Letta (formerly MemGPT)

**Isolation model:** Self-editing memory blocks with git-based coordination.

| Memory Type | Scope | Mechanism |
|-------------|-------|-----------|
| Core memory blocks | Per-agent | Self-edited via memory tools |
| Recall memory | Per-agent | Complete unabridged history, searchable |
| Archival memory | Per-agent | Vector-searchable knowledge base |
| Shared blocks | Cross-agent | Multi-writer access |
| Context Repositories | Multi-agent | Git-backed filesystem with worktrees |

**Context Repositories (2025 innovation):**
- Memory stored as files in a git repository
- Every edit automatically committed with informative messages
- Multi-agent coordination through git worktrees: each subagent gets an isolated worktree
- Conflict resolution through standard git merge operations
- Enables rollbacks, changelogs, and branching for memory versioning

**Sleep-time compute:** Background agents reorganize memory during idle periods. Includes memory reflection (periodic review of conversation history) and memory defragmentation (organizing memories for long-horizon use).

### 3.6 Semantic Kernel (Microsoft)

**Isolation model:** Provider-based context injection with multi-dimensional scoping.

| Dimension | Purpose |
|-----------|---------|
| ApplicationId | System-level boundary |
| AgentId | Agent-level isolation |
| ThreadId | Conversation-level scoping |
| UserId | User-level partitioning |

**Key pattern:** WhiteboardProvider -- an AI-maintained structured summary of decisions/requirements that survives chat truncation. Unlike raw history, the whiteboard is curated and compact, preventing context rot.

### 3.7 Google ADK (Agent Development Kit)

**Isolation model:** Scoped handoffs with configurable content inheritance.

| Mode | What Child Sees |
|------|----------------|
| Full context | Complete working context from parent |
| Minimal context | Only new prompt and essential tool results |
| None | No prior history access |

**Key mechanism:** Role translation during handoff. Prior "Assistant" messages are re-cast as narrative context rather than appearing as the new agent's own outputs. This prevents identity confusion across agent boundaries.

---

## 4. Inter-Agent Communication Protocols

### 4.1 Protocol Landscape

The 2025-2026 landscape has two dominant standardized protocols plus several framework-specific approaches:

```
                        STANDARDIZED PROTOCOLS
    +----------------------------------------------------+
    |                                                      |
    |   A2A (Google)              MCP (Anthropic)          |
    |   Agent-to-Agent            Agent-to-Tool            |
    |   HTTPS + JSON-RPC 2.0     JSON-RPC 2.0             |
    |   Agent Cards for          Tool schemas for          |
    |   capability discovery     capability discovery      |
    |   Task lifecycle mgmt      Session-based isolation   |
    |   50+ tech partners        Linux Foundation (AAIF)   |
    |   Linux Foundation          Donated Dec 2025         |
    |                                                      |
    +----------------------------------------------------+

                    FRAMEWORK-SPECIFIC PATTERNS
    +----------------------------------------------------+
    |                                                      |
    |   Message Passing    Blackboard    Event-Driven      |
    |   (AutoGen, Swarm)   (CrewAI)      (LangGraph)      |
    |   Direct agent-to-   Shared store   State changes    |
    |   agent messages     all read/write  trigger actions |
    |                                                      |
    +----------------------------------------------------+
```

### 4.2 Google A2A Protocol

Released April 2025, now under the Linux Foundation with 50+ technology partners.

**Core primitives:**
- **Agent Cards:** JSON documents describing capabilities, connection info, authentication requirements
- **Tasks:** Defined lifecycle states (submitted, working, input-required, completed, failed, canceled)
- **Messages/Parts:** Content exchange using text, files, structured data
- **Communication modes:** Synchronous request/response, streaming (SSE), asynchronous push notifications

**Transport:** HTTPS with JSON-RPC 2.0. Security via API keys, OAuth 2.0, OpenID Connect.

**Version 0.3 (2025):** Added gRPC support, signed security cards, extended Python SDK.

**Isolation mechanism:** Agents are "opaque" to each other -- they interact only through the protocol, never sharing internal state or context directly. Each agent decides what to expose through its Agent Card.

### 4.3 Anthropic MCP (Model Context Protocol)

Announced November 2024, November 2025 specification update, donated to Linux Foundation December 2025.

**Primary use case:** Agent-to-tool communication, not agent-to-agent. Provides standardized way for agents to access external data sources and tools.

**Multi-agent relevance:**
- Session-based access control for task isolation
- Shared protocol for context exchange across agents using different tools
- June 2025: Anthropic demonstrated multi-agent research system using MCP for coordinated tool access

**Security concerns (April 2025):** Researchers identified prompt injection risks, tool permission issues allowing data exfiltration, and lookalike tools that can silently replace trusted ones.

### 4.4 Message Passing

**Pattern:** Agents send structured messages directly to each other.

**Implementations:**
- AutoGen: `ConversableAgent.send()` with message typing (request, inform, commit, reject)
- OpenAI Agents SDK: Handoff functions transferring conversation context
- A2A: Task-based message exchange

**Trade-offs:**
- Pro: Simple, explicit, traceable
- Con: O(n^2) communication complexity in fully-connected topologies
- Con: Sender must know recipient's interface

### 4.5 Blackboard/Shared Memory

**Pattern:** Agents read and write to a shared data store. No direct agent-to-agent messaging.

**Implementations:**
- CrewAI: Shared crew memory accessible to all agents
- Letta: Shared memory blocks for multi-writer access
- MemOS: MemStore pub/sub mechanism for memory sharing

**Trade-offs:**
- Pro: Decoupled -- agents don't need to know each other
- Pro: Natural accumulation of collective knowledge
- Con: Race conditions when multiple agents write simultaneously
- Con: Harder to trace information provenance
- Con: Hallucinations in shared memory contaminate all agents

### 4.6 Event-Driven

**Pattern:** State changes emit events. Agents subscribe to relevant event streams.

**Implementations:**
- LangGraph: State updates trigger node execution
- Semantic Kernel: Event-driven DAG with automatic state checkpointing
- MemOS v2.0: Redis Streams for scheduling and coordination

**Trade-offs:**
- Pro: Naturally decoupled and scalable
- Pro: Easy to add new agents without modifying existing ones
- Con: Event ordering and delivery guarantees add complexity
- Con: Debugging event chains is harder than tracing direct calls

### 4.7 Publish/Subscribe

**Pattern:** Agents subscribe to topics based on their role. Updates are broadcast to relevant subscribers.

**Implementations:**
- MemOS: MemStore pub/sub for open memory sharing
- LangGraph: Streaming state updates to parent/child graphs
- Custom implementations using Redis Streams, Kafka, etc.

**Trade-offs:**
- Pro: Agents receive only relevant updates
- Pro: New agents can subscribe without changing publishers
- Con: Topic design determines information flow -- poorly designed topics leak context

---

## 5. Swarm Coordination Without Context Bloat

### 5.1 The Context Explosion Problem

When N agents each carry the full conversation history, total token consumption scales as O(N * H) where H is history length. A 10-agent system with 50K tokens of history consumes 500K tokens per round. Production systems address this through five strategies:

### 5.2 Strategy 1: Explicit Context Scoping

**Implementation:** Google ADK's `include_contents` parameter.

```
Root Agent (50K context)
    |
    +--> Sub-Agent A (receives: latest query + 1 artifact = 2K)
    |
    +--> Sub-Agent B (receives: latest query + plan summary = 3K)
    |
    +--> Sub-Agent C (receives: latest query only = 500 tokens)
```

Each sub-agent receives only what it needs, not the full ancestral history.

### 5.3 Strategy 2: Context Compaction

**Implementation:** LangGraph, Google ADK.

Trigger compaction when context exceeds 70-75% of budget. Summarize older events over a sliding window:

```
Before compaction:
  Turn 1: [full message] Turn 2: [full message] ... Turn 50: [full message]
  = 45K tokens

After compaction:
  [Summary of turns 1-45: 500 tokens] Turn 46-50: [full messages: 5K tokens]
  = 5.5K tokens
```

**Production targets:**
- Historical context compression: 3:1 to 5:1 ratio
- Tool output compression: 10:1 to 20:1 ratio
- Trigger threshold: 70-75% context utilization
- Optimal operating range: 60-80% utilization

### 5.4 Strategy 3: Token Budget Partitioning

**Recommended allocation (production consensus 2025):**

| Budget Category | Allocation | Contents |
|----------------|------------|----------|
| System Instructions | 10-15% | Core behavioral guidelines, safety constraints |
| Tool Context | 15-20% | Tool descriptions, parameters, schemas |
| Knowledge Context | 30-40% | Retrieved information, domain knowledge |
| History Context | 20-30% | Conversation history, previous interactions |
| Buffer Reserve | 10-15% | Emergency capacity for unexpected expansion |

### 5.5 Strategy 4: Artifact Externalization

**Implementation:** Google ADK's artifacts pattern.

Large payloads (code files, documents, images) are stored as named objects external to the context window. Only a reference (URI + summary) appears in context. Full content is loaded on-demand.

```
In context:   { artifact: "analysis.py", summary: "Data processing script, 450 lines", uri: "artifact://run-123/analysis.py" }
On disk:      [full 450-line file]
```

### 5.6 Strategy 5: Role Translation During Handoff

**Implementation:** Google ADK.

When Agent A hands off to Agent B, prior "Assistant" messages from Agent A are re-cast as narrative context rather than appearing as Agent B's own outputs. This prevents:
- Identity confusion (Agent B doesn't think it said things Agent A said)
- Instruction contamination (Agent A's system prompt doesn't bleed through)
- Context inflation (narrative summaries are more compact than raw conversation)

### 5.7 Strategy 6: Budget-Aware Scaling (BATS)

**Research (2025):** Budget Aware Test-time Scaling dynamically adapts planning and verification depth based on available token budget. Rather than a fixed number of reasoning steps, the system allocates more compute to harder problems and less to easier ones, pushing the cost-performance Pareto frontier.

---

## 6. Memory Scope Hierarchy

### 6.1 Three-Level Scope Model

Production systems have converged on a three-level scope hierarchy:

```
+-----------------------------------------------------------+
|                    GLOBAL SCOPE                             |
|  Shared across all agents. Read-mostly.                    |
|  Examples: system config, user preferences, safety rules   |
+-----------------------------------------------------------+
           |                    |                    |
    +------v------+     +------v------+     +------v------+
    | PROJECT     |     | PROJECT     |     | PROJECT     |
    | SCOPE       |     | SCOPE       |     | SCOPE       |
    | Per-project |     | Per-project |     | Per-project |
    | knowledge   |     | knowledge   |     | knowledge   |
    +------+------+     +------+------+     +------+------+
           |                    |                    |
    +------v------+     +------v------+     +------v------+
    | AGENT       |     | AGENT       |     | AGENT       |
    | SCOPE       |     | SCOPE       |     | SCOPE       |
    | Private     |     | Private     |     | Private     |
    | working     |     | working     |     | working     |
    | memory      |     | memory      |     | memory      |
    +-------------+     +-------------+     +-------------+
```

### 6.2 Scope Definitions

| Scope | Read Access | Write Access | Persistence | Examples |
|-------|------------|-------------|-------------|----------|
| **Global** | All agents | Admin/system only | Permanent | User preferences, safety rules, contacts |
| **Project** | Agents assigned to project | Agents assigned to project | Per-project lifetime | Architecture docs, design decisions, issue history |
| **Agent** | Owning agent only | Owning agent only | Per-session or persistent | Working memory, scratchpad, intermediate results |

### 6.3 Framework Mapping

| Framework | Global | Project | Agent |
|-----------|--------|---------|-------|
| LangGraph | Store namespace `["global", "*"]` | Store namespace `["project", name, "*"]` | Thread-level checkpointer |
| CrewAI | Crew-level shared memory | Per-project storage directory | `MemoryScope` subtree |
| AutoGen/AG2 | Context variables (system-wide) | Not built-in (custom) | Per-agent `Memory` list |
| Letta | Shared memory blocks | Context Repository per project | Core memory blocks |
| Semantic Kernel | ApplicationId scope | ThreadId scope | AgentId scope |

### 6.4 Scope Composition

Scopes compose through inheritance with override:

```
Agent context = Global + Project + Agent (agent overrides project, project overrides global)
```

LangGraph implements this through namespace hierarchy:
```
store.put(["global", "preferences"], "theme", { value: "dark" })
store.put(["project", "pai-cloud", "preferences"], "theme", { value: "light" })
// Agent working on pai-cloud sees theme = "light" (project overrides global)
```

---

## 7. Cross-Agent Memory Patterns

### 7.1 Pattern 1: Result Passing (Simplest)

Agent A's output becomes Agent B's input. No shared memory store required.

```
Agent A: [research] --> result JSON --> Agent B: [analysis of result]
```

**Used by:** OpenAI Agents SDK handoffs, LangGraph state channels, PAI's current pipeline (Gregor writes result JSON, Isidore reads it).

**Trade-off:** Simple and explicit, but no persistent knowledge accumulation. Each interaction is stateless.

### 7.2 Pattern 2: Shared Knowledge Base

All agents read/write to a common knowledge store. Memory accumulates over time.

```
                   +------------------+
                   | Knowledge Base   |
                   | (vector store +  |
                   |  structured DB)  |
                   +--------+---------+
                   /        |        \
            Agent A     Agent B     Agent C
            (write)     (read)      (read/write)
```

**Used by:** CrewAI crew memory, Letta shared blocks, MongoDB-backed multi-agent memory.

**Trade-off:** Enables knowledge accumulation but risks context pollution (Agent A's hallucinations contaminate Agent B's reasoning). Requires provenance tracking.

### 7.3 Pattern 3: Memory Management Agent

A dedicated agent handles cross-team memory operations. Other agents read/write through this gatekeeper.

```
Agent A --> [write request] --> Memory Manager --> [validated write] --> Store
Agent B --> [read request]  --> Memory Manager --> [filtered read]  --> Agent B
```

**Used by:** Emerging pattern described in MongoDB memory engineering blog.

**Trade-off:** Centralizes quality control but adds latency and creates a single point of failure.

### 7.4 Pattern 4: Git-Based Memory Coordination (Letta)

Each agent gets a git worktree for isolated writes. Changes merge back through standard git operations.

```
Main branch (shared memory):  A -- B -- C
                                        \
Agent 1 worktree:                        D -- E
                                        \
Agent 2 worktree:                        F -- G
                                        \
After merge:                        D -- E -- F -- G -- H (merged)
```

**Used by:** Letta Context Repositories (2025).

**Trade-off:** Elegant conflict resolution through git merge. Enables parallel writes with automatic versioning. However, git merge conflicts in memory files may require LLM-assisted resolution.

### 7.5 Pattern 5: Publish/Subscribe Memory

Agents subscribe to memory topics. When any agent writes, subscribers are notified and can refresh their local view.

```
Agent A writes to topic "research-findings"
  --> Agent B (subscribed) receives notification, pulls relevant memories
  --> Agent C (not subscribed) remains unaware
```

**Used by:** MemOS v2.0 (MemStore), custom implementations using Redis Streams.

**Trade-off:** Decoupled and scalable but requires careful topic design. Over-broad topics leak context; over-narrow topics miss relevant information.

### 7.6 Pattern 6: Memory Federation (MemOS)

Memory is treated as a first-class system resource that can be scheduled, shared, and evolved -- analogous to how operating systems manage CPU and storage.

**MemCubes:** Standardized memory units encapsulating different information types (text knowledge, parameter adaptations, activation states). Can be composed, migrated between agents, and evolved over time.

**Performance:** 159% boost in temporal reasoning vs. OpenAI's memory systems. 38.98% overall improvement on LOCOMO benchmark.

**Used by:** MemOS v2.0 Stardust (December 2025).

---

## 8. Permission Models for Shared State

### 8.1 Model 1: Read-Only Views (Most Common)

Agents can read shared state but cannot modify it. Only designated writers (usually the orchestrator) can update.

```
Orchestrator: [read/write] --> Shared State <-- [read-only] : Worker Agents
```

**Used by:** LangGraph (parent reads subgraph output, subgraph cannot modify parent state in isolated mode), Google ADK's minimal context mode.

**Trade-off:** Safest model. Prevents state corruption from worker agents. Limits flexibility -- workers cannot contribute to shared knowledge directly.

### 8.2 Model 2: Write-Through Cache

Agent writes go through a validation layer before reaching shared state. The validation layer can reject, transform, or rate-limit writes.

```
Agent --> [proposed write] --> Validator --> [approved write] --> Shared State
```

**Used by:** Memory Management Agent pattern, CrewAI's LLM-driven analysis for auto-categorization.

**Trade-off:** Balances flexibility with safety. Validation adds latency. Validator quality determines system quality.

### 8.3 Model 3: Append-Only Log

Agents can only append to shared state, never modify or delete existing entries. Creates an immutable audit trail.

```
Time 1: Agent A appends: { finding: "X", confidence: 0.8 }
Time 2: Agent B appends: { finding: "Y", confidence: 0.9 }
Time 3: Agent A appends: { correction: "X was wrong", replaces: "Time 1" }
```

**Used by:** LangGraph events (every state change is a new event), Letta Context Repositories (every memory change is a git commit), pipeline result files.

**Trade-off:** Perfect auditability and traceability. State grows monotonically -- requires compaction strategies. Cannot "unsee" incorrect information.

### 8.4 Model 4: Provenance-Tracked RBAC

Each memory fragment carries immutable provenance (creating agent, accessed resources, timestamps). Access is computed dynamically based on the requesting agent's permissions and the fragment's provenance.

**Access rule:** Agent `a` serving user `u` can access fragment `m` only if:
- `m.contributing_agents` is a subset of agents `u` can invoke
- `m.accessed_resources` is a subset of resources `a` can access

**Used by:** Collaborative Memory framework (arxiv 2505.18279).

**Trade-off:** Most fine-grained model. Handles asymmetric privileges and dynamically evolving permissions. High implementation complexity.

### 8.5 Model 5: Hybrid RBAC + ABAC

Combines Role-Based Access Control for coarse boundaries with Attribute-Based Access Control for parameter-level constraints.

```
RBAC: Agent has role "researcher" -> can read knowledge base
ABAC: But only documents where sensitivity <= "internal" AND project == agent.current_project
```

**Used by:** Enterprise multi-agent deployments (Sendbird, Auth0 patterns).

**Trade-off:** Handles the dynamic nature of agent roles (an agent's "role" can change from moment to moment). More flexible than pure RBAC. More manageable than pure ABAC.

### 8.6 Model 6: Capability-Based Access

Agents hold unforgeable capability tokens that grant specific access rights. Tokens can be delegated, revoked, and composed.

**Used by:** Emerging pattern, aligned with zero-trust principles. MCP's tool-level permissions are a lightweight version of this.

**Trade-off:** Finest-grained control. Each tool invocation can have its own capability requirements. Complexity in token management and delegation chains.

### 8.7 Model 7: Dynamic Access Graphs

Bipartite graphs define which users can invoke which agents (User-Agent graph) and which agents can access which resources (Agent-Resource graph). Graphs update dynamically.

**Used by:** Collaborative Memory framework.

**Trade-off:** Handles real-time permission changes (e.g., revoking access mid-session). Graph computation adds overhead per access check.

---

## 9. State Synchronization and Conflict Resolution

### 9.1 Last-Writer-Wins (LWW)

**Pattern:** Most recent write to any key wins. Timestamp-based conflict resolution.

**Used by:** Most simple multi-agent systems, Redis-backed state stores.

**Trade-off:** Simple but can silently lose information. Agent A's important update gets overwritten by Agent B's later but less important update.

### 9.2 Event Sourcing

**Pattern:** Instead of storing current state, store the complete sequence of events that produced it. State is derived by replaying events.

**Used by:** LangGraph (state changes are events), pipeline task lifecycle.

**Trade-off:** Perfect audit trail and time-travel capability. State reconstruction cost grows with event count. Requires compaction/snapshotting.

### 9.3 CRDTs (Conflict-Free Replicated Data Types)

**Pattern:** Data structures mathematically guaranteed to converge without coordination. Every concurrent update is preserved.

**Notable 2025 work:** CodeCRDT (arxiv 2510.18893) -- observation-driven coordination where agents monitor shared state with observable updates and deterministic convergence, rather than explicit message passing.

**Used by:** Emerging in multi-agent systems. Well-established in distributed databases (Yjs, Automerge).

**Trade-off:** No data loss from concurrent writes. Limited to CRDT-compatible data structures (counters, sets, registers, sequences). Not all agent state naturally fits CRDT semantics.

### 9.4 Git-Based Merge (Letta)

**Pattern:** Each agent works in an isolated git worktree. Changes merge through standard git operations. Conflicts are resolved manually or via LLM-assisted merge.

**Used by:** Letta Context Repositories.

**Trade-off:** Familiar tooling. Supports complex data (files, structured documents). Merge conflicts require resolution logic. Well-suited for memory files but less so for rapidly-changing state.

### 9.5 Optimistic Concurrency with Retry

**Pattern:** Agent reads state, performs computation, attempts write with version check. If version changed, re-read and retry.

**Used by:** Database-backed state stores with version columns. PAI's idempotency store uses SHA256 op_id as version check.

**Trade-off:** High throughput for low-contention scenarios. Performance degrades under high contention (many retries). Can starve slow agents.

### 9.6 Centralized Orchestrator (Single Writer)

**Pattern:** Only the orchestrator writes to shared state. Worker agents return results; orchestrator integrates them.

**Used by:** 17x error trap research recommendation, PAI's current pipeline (Gregor writes results, pipeline watcher integrates).

**Trade-off:** Eliminates all synchronization complexity. Orchestrator becomes bottleneck and single point of failure. Most robust for small-scale systems (2-10 agents).

---

## 10. Failure Isolation and Security Boundaries

### 10.1 The Blast Radius Problem

When an agent fails or is compromised, the blast radius is the extent of damage to the overall system. OWASP's 2026 Top 10 for Agentic Applications identifies this as a critical concern.

**Key principle:** "Containment must exist outside the agent control plane." An agent cannot be trusted to contain itself.

### 10.2 Process-Level Isolation

**Pattern:** Each agent runs in its own container/process with restricted resources.

**Implementation:**
- Docker containers with CPU, memory, storage limits
- Dedicated VMs with hypervisor-level protection
- Separate user accounts with minimal privileges
- Network partitioning via software-defined networking

**Production example:** Fault-Tolerant Sandboxing (arxiv 2512.12806) achieves 100% interception rate for high-risk commands and 100% success rate in state rollback.

### 10.3 Circuit Breakers

**Pattern:** Monitor agent behavior for anomalies. Automatically isolate agents exhibiting problematic patterns.

**Design principles (2025-2026):**
- **Out-of-band:** Circuit breakers operate in the infrastructure layer, not inside the agent
- **Signal-based:** Monitor message volume, API call frequency, error rates, execution time
- **Graduated response:** Warning -> throttling -> isolation -> termination
- **Kill switch:** Human-triggered immediate agent shutdown capability

**PAI relevance:** PAI's existing `RateLimiter` (sliding window failure tracking + cooldown) and `ResourceGuard` (memory-gated dispatch) are lightweight circuit breakers.

### 10.4 State Separation

**FINOS AI Governance Framework recommendation:**
- Each agent type gets its own database instance or schema
- Separate encryption keys per agent type
- No shared memory regions between agents
- Isolated caching systems to prevent information leakage
- Database transaction isolation levels prevent cross-agent interference

### 10.5 Communication Security

**Zero-trust inter-agent communication:**
- Mutual authentication using certificates or tokens
- TLS 1.3+ encryption for all inter-agent transport
- Communication matrix defining which agent types may communicate
- Message filtering enforcing allowed message types per agent pair
- Agent-specific rate limiting at API gateways

### 10.6 Failure Containment Patterns

| Pattern | Mechanism | Recovery |
|---------|-----------|----------|
| Timeout + Rollback | Per-task timeout with filesystem snapshot | Restore pre-task state |
| Redundant Agents | Multiple agents for critical functions | Failover to healthy agent |
| Graceful Degradation | System continues with reduced capability | Notify human, queue work |
| Transactional Filesystem | Snapshot before execution, rollback on failure | 100% state recovery |
| Replay Testing | Re-run recorded actions in isolated environments | Detect cascading failures before production |

### 10.7 LLM Vaccination (Emerging)

**Pattern:** Seed agent memories with safely-handled malicious prompt examples. Reduces jailbreak propagation while preserving cooperation capability.

**Status:** Research-stage, proposed in arxiv 2505.02077.

---

## 11. Production Case Studies

### 11.1 Wells Fargo: Multi-Agent Banking Assistant

**Scale:** 35,000 bankers accessing 1,700 procedures.
**Result:** Response time from 10 minutes to 30 seconds.
**Architecture:** Specialized agents for different procedure categories, centralized orchestration.
**Isolation pattern:** Each agent has domain-specific knowledge base with read-only access to shared procedure repository.

### 11.2 Stripe: AI-Enhanced Payment Recovery

**Scale:** $6 billion in recovered payments (2024).
**Result:** 60% year-over-year improvement in retry success rates.
**Key insight:** "AI-enhanced routing between specialized agents beats any single super-agent."
**Isolation pattern:** Each retry strategy agent operates independently with shared access to payment state but isolated decision-making context.

### 11.3 AtlantiCare: Clinical AI Assistant

**Scale:** 50 providers in focused pilot.
**Result:** 80% adoption, 42% reduction in documentation time (66 minutes/day savings).
**Key insight:** Focused pilot with clear bounds before scaling.
**Isolation pattern:** Patient-scoped context with strict HIPAA-compliant boundaries between patient sessions.

### 11.4 Anthropic: Multi-Agent Research System (June 2025)

**Architecture:** MCP-powered multi-agent research system.
**Pattern:** Lead agent plans research tasks, spawns parallel subagents, each searches independently.
**Result:** Multi-agent system with Claude Opus 4 lead + Claude Sonnet 4 subagents outperformed single-agent Claude Opus 4 by 90.2% on internal evaluations.
**Isolation:** Each subagent gets task-specific context only. Results aggregated by lead agent.

### 11.5 Industry-Wide Statistics (2025-2026)

| Metric | Value | Source |
|--------|-------|--------|
| Organizations with agentic AI at scale | 2% | Industry surveys |
| Organizations in exploration phase | 61% | Industry surveys |
| Leaders citing system complexity as top barrier | 65% | Two consecutive quarters |
| Production agents executing <=10 steps before human | 68% | arxiv 2512.04123 |
| Agents relying on prompting (not fine-tuning) | 70% | arxiv 2512.04123 |
| Agents depending on human evaluation | 74% | arxiv 2512.04123 |
| Predicted agentic AI project cancellations by 2027 | 40%+ | Gartner |

---

## 12. Anti-Patterns and Lessons Learned

### 12.1 The "Bag of Agents" (17x Error Trap)

**Anti-pattern:** Throwing multiple LLMs at a problem without formal topology. Unstructured networks amplify errors exponentially.

**Why it fails:** Without centralized verification, each agent's errors propagate to all connected agents. With N agents each having error rate e, the system error rate approaches 1 - (1-e)^N.

**Fix:** Structured topology with centralized control plane. 10 core archetypes mapped into 6 functional planes: Control, Planning, Context, Execution, Assurance, Mediation.

### 12.2 Context Pollution Through Shared Memory

**Anti-pattern:** Agent A hallucinates information, stores it in shared memory, Agent B treats it as verified fact.

**Fix:** Provenance tracking on every memory fragment. Independent validation before shared memory writes. Verification agents with isolated prompts and separate context.

### 12.3 Monoculture Collapse

**Anti-pattern:** All agents built on the same LLM model exhibit correlated vulnerabilities to the same inputs.

**Fix:** Model diversity across agent types. Different models for different functions (e.g., Claude for reasoning, Gemini for search, GPT for code generation).

### 12.4 Conformity Bias (False Consensus)

**Anti-pattern:** Agents reinforce each other's errors rather than providing independent evaluation. Creates dangerous false consensus.

**Fix:** Independent evaluation paths. Each validator agent has its own context, not shared with the agents it's validating. Judge agents must never see the reasoning of the agents they're judging.

### 12.5 Specification Ambiguity (41.77% of failures)

**Anti-pattern:** Prose descriptions of agent roles and task requirements. Agents guess at requirements.

**Fix:** JSON schemas with explicit roles, capabilities, constraints, and success criteria. Machine-readable contracts, not prose.

### 12.6 Unstructured Communication (36.94% of failures)

**Anti-pattern:** Agents communicate through free-form natural language without explicit protocols.

**Fix:** Structured message types (request, inform, commit, reject) with schema validation. Explicit handoff protocols with defined state transfer.

### 12.7 Missing Verification (21.30% of failures)

**Anti-pattern:** Systems orchestrate elaborate workflows but never verify if work meets requirements.

**Fix:** Independent judge agents with isolated prompts. Verification checkpoints at every phase boundary. Clear resource ownership (each resource belongs to exactly one agent).

### 12.8 Context Rot (OpenClaw Warning)

**Anti-pattern:** Memory files grow, skills accumulate, session summaries pile up. Performance degrades over time.

| Timeline | Overhead | Performance Impact |
|----------|----------|--------------------|
| Day 1 | ~7K tokens | Baseline |
| 1 month | ~45K tokens | -40% performance |
| 6 months | 37K+ tokens | -50-90% performance |

**Fix:** Purpose-built "sniper agents" with ~1,400 tokens overhead instead of one bloated generalist. Aggressive compaction. Self-editing memory with eviction.

### 12.9 Resource Ownership Violation

**Anti-pattern:** Multiple agents read and write to the same file/database/API without coordination.

**Fix:** Each resource belongs to exactly one agent. Other agents access through the owning agent or through explicit coordination protocol.

### 12.10 Silent Cascading Failures

**Anti-pattern:** One agent's failure silently propagates through the system, appearing as correct behavior to downstream agents.

**Fix:** OWASP ASI08 recommendations: out-of-band circuit breakers, replay testing in isolated environments, blast-radius caps gating new deployments.

---

## 13. Architecture Reference Diagrams

### 13.1 Context Isolation Architecture

```
+------------------------------------------------------------------+
|                        ORCHESTRATOR                                |
|  - Centralized state management                                   |
|  - Conflict resolution                                            |
|  - Error suppression (17x trap prevention)                        |
|  - Token budget allocation                                        |
+-----+----+----+----+---------------------------------------------+
      |    |    |    |
      v    v    v    v
+------+ +------+ +------+ +------+
|Agent | |Agent | |Agent | |Agent |
|  A   | |  B   | |  C   | |  D   |
+------+ +------+ +------+ +------+
|Schema| |Schema| |Schema| |Schema|
|  A   | |  B   | |  C   | |  D   |
+------+ +------+ +------+ +------+
|Memory| |Memory| |Memory| |Memory|
|  A   | |  B   | |  C   | |  D   |
+------+ +------+ +------+ +------+
    \        |        |        /
     \       |        |       /
      v      v        v      v
    +---------------------------+
    |    SHARED KNOWLEDGE BASE   |
    |  (provenance-tracked,      |
    |   permission-controlled)   |
    +---------------------------+
```

### 13.2 Shared State Architecture

```
+------------------------------------------------------------------+
|                     SHARED STATE STORE                             |
+------------------------------------------------------------------+
| GLOBAL SCOPE (read-mostly)                                        |
|   user_prefs, safety_rules, system_config                         |
+------------------------------------------------------------------+
| PROJECT SCOPE (per-project read/write)                            |
|   /project/pai-cloud/  architecture, decisions, issues            |
|   /project/openclaw/   codebase, configs, tests                   |
+------------------------------------------------------------------+
| AGENT SCOPE (private per-agent)                                   |
|   /agent/isidore/  working_memory, scratchpad                     |
|   /agent/gregor/   working_memory, scratchpad                     |
+------------------------------------------------------------------+

ACCESS CONTROL:
  Read:  Agent reads Global + own Project + own Agent scope
  Write: Agent writes own Project + own Agent scope only
  Admin: System writes Global scope
```

### 13.3 Inter-Agent Communication Architecture

```
                    EXTERNAL (Cross-Organization)
                    +---------------------------+
                    |     A2A Protocol           |
                    |  (HTTPS + JSON-RPC 2.0)   |
                    |  Agent Cards for discovery |
                    +---------------------------+

                    TOOL ACCESS
                    +---------------------------+
                    |     MCP Protocol           |
                    |  (JSON-RPC 2.0)            |
                    |  Tool schemas for caps     |
                    +---------------------------+

                    INTERNAL (Same System)
    +----------+  message   +----------+
    | Agent A  |<---------->| Agent B  |  Direct message passing
    +----------+  passing   +----------+

    +----------+            +----------+
    | Agent A  |--write---->| Shared   |<--read---| Agent B |
    +----------+            | Memory   |          +----------+
                            +----------+          Blackboard pattern

    +----------+  publish   +----------+  subscribe  +----------+
    | Agent A  |----------->| Event    |<------------|  Agent B |
    +----------+            | Bus      |             +----------+
                            +----------+             Event-driven
```

### 13.4 Token Budget Architecture

```
TOTAL CONTEXT WINDOW (e.g., 200K tokens)
+------------------------------------------------------------------+
| SYSTEM INSTRUCTIONS (10-15%)                                      |
| Identity, safety rules, behavioral guidelines                     |
+------------------------------------------------------------------+
| TOOL CONTEXT (15-20%)                                             |
| Tool schemas, parameters, available capabilities                  |
+------------------------------------------------------------------+
| KNOWLEDGE CONTEXT (30-40%)                                        |
| Retrieved memories, project context, domain knowledge             |
+------------------------------------------------------------------+
| HISTORY CONTEXT (20-30%)                                          |
| Recent conversation, compacted summaries of older turns           |
+------------------------------------------------------------------+
| BUFFER RESERVE (10-15%)                                           |
| Emergency capacity for tool outputs, unexpected expansion         |
+------------------------------------------------------------------+

COMPACTION TRIGGERS:
  70-75% utilization -> Summarize older events (3:1 to 5:1 ratio)
  Tool outputs -> Reference-based storage (10:1 to 20:1 ratio)
  Per 5 turns -> Incremental summarization to 200-token digests
```

---

## 14. Recommendations for PAI-Scale Systems (2-10 Agents)

Based on all research, here are specific recommendations for PAI's architecture:

### 14.1 Keep Centralized Orchestration

PAI's current pattern (pipeline watcher as orchestrator, agents as workers) aligns with the strongest production pattern. The centralized orchestrator suppresses the 17x error trap. Do not move to peer-to-peer agent communication.

### 14.2 Implement Three-Level Memory Scoping

Add project and source filters to `MemoryStore.search()`:

```typescript
// Current: searches all episodes
memoryStore.search(query)

// Recommended: scoped search
memoryStore.search(query, {
  project: "my-pai-cloud",      // project scope
  source: "telegram",           // exclude pipeline noise
  scope: "project"              // don't return global unless asked
})
```

This is the highest-impact, lowest-effort improvement.

### 14.3 Add Provenance to Memory Fragments

Every memory fragment should carry:
- `source_agent`: Which agent created it (isidore, gregor, pipeline)
- `project`: Which project it belongs to
- `confidence`: How verified the information is
- `timestamp`: When it was created

This enables the provenance-tracked permission model and prevents context pollution.

### 14.4 Token Budget for Context Injection

Apply the production consensus allocation when building context for Claude invocations:
- System (CLAUDE.md, session state): 10-15%
- Tools: 15-20%
- Memory context: 30-40%
- Conversation history: 20-30%
- Buffer: 10-15%

### 14.5 Context Scoping for Pipeline vs Telegram

Pipeline tasks (one-shot, agent-to-agent) should receive MINIMAL context:
- Task description only
- No project CLAUDE.md unless explicitly relevant
- No conversation history
- AG2-style: structured metadata invisible to LLM

Telegram sessions (project mode, direct user interaction) should receive FULL scoped context:
- Project CLAUDE.md
- Session continuity
- Project-scoped memory injection
- Conversation history with compaction

### 14.6 Result Passing Over Shared Memory

For PAI's scale (2-3 agents), result passing (current pipeline pattern) is the right choice over shared memory. The overhead of a shared knowledge base with synchronization, provenance tracking, and access control is not justified until you have 5+ agents building on each other's work continuously.

### 14.7 Adopt Append-Only Semantics for Cross-Agent State

Pipeline results are already append-only (new file per result). Extend this to:
- Decision traces (already implemented)
- Handoff state (already implemented)
- Memory episodes (already implemented)

Never allow one agent to modify another agent's output. If corrections are needed, append a new entry referencing the original.

### 14.8 Circuit Breaker Enhancement

PAI's existing `RateLimiter` and `ResourceGuard` are good foundations. Add:
- Per-agent error tracking (not just global)
- Graduated response: warn -> throttle -> isolate
- Out-of-band monitoring (infrastructure-level, not agent-level)
- Kill switch for immediate agent shutdown

### 14.9 Future: Self-Editing Memory Blocks

When memory injection is proven stable, consider adding Letta-style self-editing memory. Let Isidore maintain a running summary of key decisions and project state, rather than relying only on raw episode retrieval.

### 14.10 Future: Git-Based Memory Coordination

If Gregor and Isidore need to build on each other's knowledge continuously, Letta's Context Repository pattern (git worktrees for isolated writes, merge for integration) is the most elegant solution. PAI already uses git extensively -- this would be a natural extension.

---

## Research Metrics

| Metric | Value |
|--------|-------|
| Web searches executed | 18 |
| Deep-dive page fetches | 10 |
| Frameworks analyzed | 8 (LangGraph, CrewAI, AutoGen/AG2, OpenAI Agents SDK, Letta, Semantic Kernel, Google ADK, MemOS) |
| Papers referenced | 6 (arxiv 2505.02077, 2512.12806, 2503.13657, 2510.18893, 2505.18279, 2512.04123) |
| Production case studies | 5 (Wells Fargo, Stripe, AtlantiCare, Anthropic, industry-wide) |
| Anti-patterns documented | 10 |
| Permission models documented | 7 |
| Communication protocols analyzed | 7 |
| Prior research incorporated | 2026-03-01 agent-context-memory-architecture report |
| Cross-references with PAI codebase | Pipeline, memory store, context builder, rate limiter, resource guard, handoff, idempotency |
