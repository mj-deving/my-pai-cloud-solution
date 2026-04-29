# Agent Context & Memory Architecture — Comprehensive Research Report

**Date:** 2026-03-01 (initial), 2026-03-02 (completed + extended)
**Requested by:** Marius
**Context:** Designing a custom agent framework that synthesizes the best of all existing frameworks, built on DAI infrastructure
**Sources:** 17 research agents across 3 sessions, 100+ primary sources, 10 frameworks analyzed, 8+ academic papers, YouTube transcript, 3 open-source codebases

---

## Table of Contents

**Part I — Framework Analysis (Original Research, 2026-03-01)**
1. [OpenClaw Video: Context Rot Warning](#1-openclaw-video)
2. [OpenClaw Architecture (Codebase)](#2-openclaw-architecture)
3. [MemGPT / Letta — Self-Editing Memory](#3-memgpt-letta)
4. [LangGraph — Namespace Hierarchy](#4-langgraph)
5. [CrewAI — Hierarchical Scopes](#5-crewai)
6. [AutoGen/AG2 — Context Variables](#6-autogen-ag2)
7. [Semantic Kernel — Whiteboard Pattern](#7-semantic-kernel)

**Part II — Gap-Fill Research (2026-03-02)**
8. [Claude Agent SDK — Compaction & File Memory](#8-claude-agent-sdk)
9. [OpenCode — Client-Server & Part Storage](#9-opencode)
10. [Context Engineering SOTA](#10-context-engineering-sota)
11. [Multi-Agent Isolation Patterns](#11-multi-agent-isolation)
12. [Context Window Optimization (Numbers)](#12-context-window-optimization)
13. [Contrarian Analysis — The Case Against Complexity](#13-contrarian-analysis)
14. [Hermes Agent — Persistent Personal Agent](#14-hermes-agent)

**Part III — Synthesis**
15. [DAI Framework Analysis (from Pai-Exploration)](#15-pai-framework-analysis)
16. [Unified Synthesis & Recommendations](#16-synthesis)

---

# Part I — Framework Analysis

## 1. OpenClaw Video: Context Rot Warning

**Speaker:** Roman (Top 3% NeurIPS paper author)
**URL:** https://youtu.be/Bo4Shk2FCvk

### Key Architecture Points

OpenClaw is an "exoskeleton" around an LLM with four fundamental zones:

1. **Triggers** — What wakes the agent: heartbeats (30min timer), cron jobs, webhooks
2. **Injection** — What's in context every turn: system prompt (soul.md, agents.md, memory.md), JSONL conversation history, tool schemas, safety prompts
3. **Tools** — What the agent can do: memory RAG, computer/browser control, skills/plugins, all in an agentic loop
4. **Output** — Where results go: Telegram, Discord, etc.

### Critical Warning: Context Rot

| Timeline | Fixed Token Overhead | Performance Impact |
|----------|---------------------|-------------------|
| Day 1 | ~7,000 tokens | Baseline |
| After 1 month | ~45,000 tokens | Up to 40% performance decrease |
| After 6 months | 37K workspace + 7.5K skills + unbounded tools | 50-90% performance decrease, ~$0.52/msg extra |

**Root cause:** Memory files grow, skills accumulate, session summaries pile up. OpenClaw has hard truncation limits that cause "catastrophic forgetting."

**Roman's recommendation:** Build single-purpose "sniper agents" instead of one bloated generalist. A purpose-built email agent needs only ~1,400 tokens of overhead.

---

## 2. OpenClaw Architecture (Codebase)

### Three-Tier Memory Model

| Tier | Storage | Lifecycle | Injection |
|------|---------|-----------|-----------|
| Ephemeral | `memory/YYYY-MM-DD.md` | Daily logs | Retrieved by relevance only |
| Durable | `MEMORY.md` (workspace) | Curated, long-lived | Brute-force injected every message |
| Session | `sessions/YYYY-MM-DD-slug.md` | Per-session transcripts | Indexed, not injected |

### Context Injection Pipeline (per LLM call)

```
STATIC (cacheable, ~20K tokens):
  Tool schemas → Workspace files → Skills metadata

DYNAMIC (recomputed per message):
  Memory chunks (6 @ ~700 chars, hybrid retrieval) → Conversation history → Tool results
```

### Key Design Decisions

- **Hybrid memory search:** `0.7 * vectorScore + 0.3 * BM25Score` with MMR dedup and 30-day temporal decay
- **Compaction cascade:** Pruning (TTL on tool results) → Auto-compaction (summarize old turns) → Retry
- **Memory flush before compaction:** Distills session to daily memory file before compaction discards it
- **Prompt caching:** Static prefix cached at 10% cost. 80% savings ($94.50/mo → $9.45/mo at 30 msgs/day)
- **Single workspace per agent:** No multi-project concept. Each agent = one identity, one memory store

### Limitations

- No project-scoped memory (single workspace)
- Context rot from accumulated workspace files
- Multi-user requires separate agent instances
- Known cache-busting from dynamic content in system prompt

---

## 3. MemGPT / Letta — Self-Editing Memory

### Core Innovation: LLM as Memory Manager

MemGPT treats the context window as RAM. The LLM itself decides what stays in context and what gets evicted to "disk."

**In-Context ("RAM"):**
- System Instructions (fixed, immutable)
- Working Context / Core Memory — **agent-editable** scratchpad (memory blocks: `human`, `persona`, `task`, ~2K chars each)
- Conversational Context — FIFO queue with recursive summarization

**Out-of-Context ("Disk"):**
- Recall Memory — complete unabridged history, searchable by text/date
- Archival Memory — general knowledge base, vector-searchable

### Self-Editing Memory Tools

- `memory_replace` — surgical find-and-replace within a memory block
- `memory_insert` — append to a block
- `memory_rethink` — complete rewrite of a block
- `archival_memory_insert/search` — write/query long-term storage
- `conversation_search` — query full history

### Context Overflow Handling

1. At 70% capacity: system injects "memory pressure warning"
2. Agent proactively saves important context to core/archival memory
3. At 100%: force-evict 50% of FIFO queue
4. Evicted messages → recursive summary (incorporates previous summary)

### Latest Innovations (2025-2026)

- **Sleep-time compute:** Background agent reorganizes memory during idle periods
- **Context Repositories (MemFS):** Git-backed markdown filesystem for memory. Every edit = git commit. Enables rollbacks, branching, parallel coordination via worktrees
- **Agent File Format (.af):** Serializable agent state for checkpointing/sharing

### Key Insight

Letta's core innovation — the agent editing its own memory — is the most powerful pattern. Self-editing memory blocks let the agent maintain a running "what matters" summary rather than relying on raw episode retrieval.

---

## 4. LangGraph — Namespace Hierarchy

### Dual Memory Architecture

**Thread-Level (Checkpointer) — "RAM":**
- Automatic checkpoint at every super-step
- Scoped by `thread_id` (conversation/session)
- Time travel: replay from any checkpoint, fork with modified state

**Cross-Thread (Store) — "Disk":**
- Explicit read/write via `store.put()` / `store.search()`
- Namespace hierarchy: `["user", "443039215", "preferences"]`
- Three patterns: Profile (single doc), Collection (append-only facts), Procedural (self-improving instructions)

### Multi-Agent Isolation

- **Shared state:** Subgraph shares parent's state schema
- **Isolated state (recommended):** Wrapper function transforms state between parent and subgraph

### Key Insight

LangGraph's **namespace hierarchy** is the cleanest solution to project-scoped memory. Thread IDs control short-term continuity. Namespaces control long-term knowledge. They're orthogonal.

---

## 5. CrewAI — Hierarchical Scopes

- Single `Memory` class with LLM-driven auto-categorization
- Filesystem-like scope paths: `/project/alpha`, `/agent/researcher/findings`
- `MemoryScope` (read-write subtree) vs `MemorySlice` (read-only cross-scope view)
- Composite scoring: semantic similarity + recency decay + importance
- Multi-user NOT solved out of the box

### Key Insight

CrewAI's hierarchical scope model maps naturally to: `/workspace/` (global), `/project/name/` (project-specific), `/agent/name/` (private working memory).

---

## 6. AutoGen/AG2 — Context Variables

### Model Context (what the LLM sees per turn)

- `UnboundedChatCompletionContext` — keeps all messages
- `BufferedChatCompletionContext` — last N messages
- `TokenLimitedChatCompletionContext` — within token budget
- `HeadAndTailChatCompletionContext` — first N + last M (preserves setup + recency)

Each agent gets its own instance — **per-agent isolation by construction**.

### Context Variables (Brilliant Pattern)

Context variables are **deliberately invisible to the LLM by default.** Agents access them only through tool functions, system message templates, or dedicated summary tools. This prevents token waste, data leakage, and unpredictable prompt behavior.

### Key Insight

Structured state (current project, session IDs, pipeline status) should travel between instances as structured data, NOT as prompt text.

---

## 7. Semantic Kernel — Whiteboard Pattern

- **AIContextProvider interface:** Providers attach to AgentThread, inject context per invocation
- **WhiteboardProvider:** AI-maintained structured summary of decisions/requirements that survives chat truncation
- **Multi-dimensional scoping:** ApplicationId, AgentId, ThreadId, UserId
- **Process Framework:** Event-driven DAG with automatic state checkpointing

### Key Insight

The **WhiteboardProvider** fills a gap: maintain a running structured summary of decisions/requirements/state, more valuable than raw episode retrieval because it's curated and compact.

---

# Part II — Gap-Fill Research (2026-03-02)

## 8. Claude Agent SDK — Compaction & File Memory

**Full report:** `research/agent-context-memory-architecture/agents/claude-agent-sdk.md`

### Design Philosophy

The SDK pushes context management to three layers: (1) server-side compaction, (2) client-side memory tool, (3) subagent context isolation. Everything is deliberately simple, transparent, and debuggable.

### Session Management

- Sessions persist to `~/.claude/projects/` by default
- **Session forking** (novel): branch a conversation to explore alternatives without modifying original
- **Checkpoint resumption:** resume from specific message UUID within session
- No automatic cross-session memory — each new session starts fresh unless explicitly resumed

### Server-Side Compaction (API Feature)

- Triggers at configurable threshold (default 150K, min 50K tokens)
- Claude generates summary, inserts `compaction` block
- **Pause-after-compaction pattern:** inject preserved messages before continuing
- Custom summarization prompts replace default behavior
- Total token budget enforcement via compaction counter

### Context Editing (Fine-Grained)

- `clear_tool_uses` — clear old tool results while keeping N most recent
- Exclude specific tools from clearing (e.g., memory tool results survive)
- Thinking block management for extended thinking models

### Memory Tool (Client-Side, File-Based)

- Agent creates/reads/edits/deletes text files in `/memories/` directory
- Injected prompt: "ASSUME INTERRUPTION — your context window might be reset at any moment"
- Multi-session pattern: progress log + feature checklist + init script, read on startup
- NOT a vector store — deliberately simple and transparent

### Subagent Isolation

- Completely separate context windows per subagent
- 3-5 subagents run in parallel per batch
- Subagents as **context compression engines**: process 50K tokens, return 1,500 tokens
- 90% time reduction vs sequential execution (Anthropic's internal research system)
- No sub-subagent nesting, no direct subagent-to-subagent communication

### Context Awareness (Novel)

Claude models receive explicit token budget updates after each tool call:
```xml
<system_warning>Token usage: 35000/200000; 165000 remaining</system_warning>
```
Models self-regulate context usage — unique to Anthropic, not found in other frameworks.

### What the SDK Does NOT Have

- No built-in vector stores or embedding-based retrieval
- No automatic episodic memory recording
- No semantic search over past interactions
- No cross-session automatic learning

### Key Insight

Compaction as an API feature is the most elegant approach — it pushes summarization to the provider, ensuring consistent quality. The "assume interruption" philosophy drives proactive state persistence. Subagents are context compression engines, not just parallelism tools.

---

## 9. OpenCode (anomalyco/opencode) — Client-Server & Part Storage

**Full report:** `research/agent-context-memory-architecture/agents/opencode.md`

### Scale & Stack

114K+ GitHub stars, 700+ contributors, 2.5M+ monthly active developers. TypeScript + Bun + SQLite (same stack as DAI). Hono HTTP server, Vercel AI SDK, Drizzle ORM.

### Core Architecture: Client-Server Separation

```
Terminal UI ─────┐
Desktop App ─────┤
VS Code Ext ─────┼──→ HTTP Server (Hono, port 4096) ──→ Agent Loop
Web App ─────────┤         │                                  │
SDK Clients ─────┘    REST + SSE                         SQLite DB
```

All frontends are thin clients over HTTP+SSE. The agent loop is completely decoupled from any specific UI. Internal Event Bus (`Bus` namespace) decouples agent loop from client connections.

### Part-Based Message Storage (Most Transferable Pattern)

Messages decomposed into typed "Parts" stored in `PartTable`:
- Text, tool calls, files, reasoning, compaction summaries, subtask records
- Enables: granular streaming, selective filtering, audit trails, session forking
- **Append-only data model** — no destructive updates, compaction creates new parts alongside originals

### Context Compaction with Rule Preservation

- **75% auto-compaction threshold** (hardcoded)
- Uses active model for summarization, not heuristic truncation
- Summary explicitly includes **"Rules & Constraints" section** preserving user directives, permissions, project instructions
- Originals never deleted — enables compaction reversal and pre-compaction forking

### Agent System

- Agents defined as **Markdown files** with YAML frontmatter: description, model, tools, permissions, steps, system prompt
- Two modes: primary (full access) vs subagent (scoped)
- Step limits cap agentic iterations
- Subagent-to-subagent delegation with configurable depth limits

### Instance Context Pattern (Novel)

Every HTTP request scoped to an "Instance" providing lazy-initialized, memoized per-request workspace context (config, tools, plugins, providers). Prevents cross-project contamination at the middleware level.

### MCP Token Bloat Warning

4 MCP servers burn ~51K tokens (46.9% of context window) from tool definitions loaded at startup. Lazy loading proposed but unsolved. **Critical cautionary tale for any MCP integration.**

### Key Insight

Client-server separation is the winning pattern — multiple frontends become thin clients. Part-based message storage unlocks capabilities impossible with blob storage. Compaction with rule preservation creates "immune memory" that survives all compression. DAI's parallel DAG execution is architecturally ahead of OpenCode's sequential subtask model.

---

## 10. Context Engineering State-of-the-Art

**Full report:** `research/agent-context-memory-architecture/agents/context-engineering-sota.md`

### The Discipline

Context engineering (term popularized by Karpathy & Willison, mid-2025) is the "delicate art and science of filling the context window with just the right information for the next step." It replaced "prompt engineering" as the term for what practitioners actually do.

> "Think of an LLM like a CPU with its context window as RAM. Your role as engineer is like an operating system — you dynamically load that working memory with just the right code and data for the task." — Addyo/O'Reilly

### Core Principles (Production-Validated)

1. **Context is a finite resource.** Budget, compact, and intelligently page it.
2. **Smallest set of high-signal tokens.** Maximize outcome likelihood per token. (Anthropic)
3. **Language models are mimics.** If context is full of similar past action-observation pairs, the model follows that pattern even when suboptimal. (Anthropic)
4. **Sophistication beats scale.** Small team + weak model + great context > large team + frontier model + poor context.
5. **Do the simplest thing that works.** Smarter models require less prescriptive engineering. (Anthropic)

### Dynamic Context Injection Patterns

**Just-in-Time Retrieval (Anthropic):** Maintain lightweight identifiers, dynamically retrieve via tools during execution. Progressive disclosure through exploration.

**Google ADK: Compiled Views over State.** Context as "compiled view over a richer stateful system." Ordered processors transform state into presentation. Each processor builds on previous outputs.

**Manus: Action Space Management.** Mask token logits during decoding instead of removing tools from context. Maintains KV-cache stability while constraining model behavior.

**Proactive vs Reactive Memory (ADK):** System automatically injects high-confidence matches (proactive). Agent searches for edge cases (reactive). Combine both.

### Token Budget Framework

| Component | Budget | Rationale |
|-----------|--------|-----------|
| System Instructions | 10-15% | Disproportionate influence on behavior |
| Tool Context | 15-20% | Tool descriptions and parameters |
| Knowledge Context | 30-40% | Retrieved information, domain knowledge |
| History Context | 20-30% | Conversation history |
| Buffer Reserve | 10-15% | Emergency capacity |

**Manus input-output ratio:** 100:1 for agentic workloads. Optimizing input tokens has 100x more cost impact than optimizing output tokens.

### Observation Masking > LLM Summarization

**JetBrains Research (NeurIPS 2025), SWE-bench Verified (500 instances):**
- Observation masking: **52% cost reduction** with **2.6% solve rate improvement**
- Summarization: 7% of total cost per instance, causes **13-15% trajectory elongation**
- In 4 of 5 test settings, masking beat or matched summarization

**How it works:** Preserve agent reasoning/actions in full. Replace older environment observations (tool outputs) with placeholders after N turns.

### Artifact Tracking is Unsolved

Factory.ai benchmark across 36,611 production messages: ALL compression methods scored below 2.5/5.0 on file tracking. Best practice: maintain separate artifact index outside compression pipeline.

### The "Tokens Per Task" Principle

Optimizing per-request (minimize each API call) can increase total tokens per-task (agent re-fetches compressed-away information). **Correct optimization target: total cost to complete the task.**

### KV-Cache is the #1 Production Metric

**Manus reports 10x cost difference** between cached and uncached tokens. Rules:
- No timestamps in system prompts (kills cache)
- Deterministic JSON serialization
- Stable tool schema ordering
- Static instructions before dynamic content

### Key Insight

Context engineering has converged: Anthropic, Manus, Google ADK, and Factory.ai independently arrived at similar patterns (tiered storage, cache-friendly prefixes, observation masking over summarization). The field is maturing from art to engineering discipline.

---

## 11. Multi-Agent Isolation Patterns

**Full report:** `research/agent-context-memory-architecture/agents/multi-agent-isolation.md`

### The Cardinal Rule

**Isolation is the default, sharing is the exception.** All production frameworks agree.

### Context Leakage Prevention — 6 Mechanisms

| Mechanism | Framework | How It Works |
|-----------|-----------|-------------|
| Schema-level isolation | LangGraph | Subgraphs with transformation boundaries |
| Per-agent memory instances | AutoGen/AG2 | Separate ChatCompletionContext per agent |
| Scope hierarchies | CrewAI | MemoryScope (read-write) vs MemorySlice (read-only) |
| Context variables invisible-by-default | AG2 | Structured state hidden from LLM |
| Self-editing memory blocks | Letta | Agent curates own context, others can't modify |
| Cryptographic boundaries | Emerging | Bit-commitment, verifiable secret sharing |

### The 17x Error Trap

The defining anti-pattern of 2025 (Sean Moran): unstructured "bag of agents" amplifies errors exponentially. **Fix: centralized orchestration** with 6 functional planes (Control, Planning, Context, Execution, Assurance, Mediation).

### Two Standardized Protocols

- **Google A2A:** Agent-to-agent (HTTPS + JSON-RPC 2.0), 50+ partners, Linux Foundation
- **Anthropic MCP:** Agent-to-tool (JSON-RPC 2.0), Linux Foundation (AAIF)

### Permission Models — 7 Documented

Read-only views, write-through cache, append-only log, provenance-tracked RBAC, hybrid RBAC+ABAC, capability-based access, dynamic access graphs.

### State Synchronization — 6 Patterns

Last-writer-wins, event sourcing, CRDTs (CodeCRDT 2025), git-based merge (Letta), optimistic concurrency, centralized orchestrator.

### Ten Anti-Patterns

1. Bag of agents (unstructured, 17x error amplification)
2. Context pollution (cross-agent leakage)
3. Monoculture collapse (all agents same model/prompt)
4. Conformity bias (agents agree too readily)
5. Specification ambiguity (41.77% of failures)
6. Unstructured communication (36.94% of failures)
7. Missing verification (21.30% of failures)
8. Context rot (accumulated stale context)
9. Resource ownership violation (concurrent modification)
10. Silent cascading failures (error propagation without detection)

### Production Reality Check

- Only **2% of organizations** have deployed agentic AI at scale
- **41-86.7% failure rates** in unstructured multi-agent systems
- **68% of production agents** execute 10 or fewer steps before human intervention

### Key Insight

Centralized orchestration suppresses error amplification. Result passing (DAI's current pipeline pattern) is correct for 2-3 agent systems. Three-level memory scoping (global/project/agent) is the production consensus. Provenance tracking on memory fragments prevents hallucination propagation.

---

## 12. Context Window Optimization (Numbers)

**Full report:** `research/agent-context-memory-architecture/agents/context-window-optimization.md`

### The Performance Cliff

| Study | Model | Critical Threshold | Impact |
|-------|-------|-------------------|--------|
| Intelligence Degradation (Jan 2026) | Qwen2.5-7B | 43.2% of max context | F1 drops 45.5% (0.556 → 0.302) |
| Context Discipline (Dec 2025) | Multiple | 4K-15K words | Non-linear inference time increase |
| Chroma Context Rot (2025) | 18 LLMs, 194K API calls | Varies | GPT-3.5: 60.29% task refusal at long contexts |
| Lost in the Middle (Liu 2023) | Multiple | Middle positions | Beginning/end: 85-95% accuracy. Middle: 76-82% |
| CMU LTI | Multiple | 85% utilization | 23% performance degradation |

**Rule of thumb:** 200K model → reliable to ~130K (65%). Smaller models cliff at 40-50%. **Target 60-80% for large models, never exceed 85%.**

### Compression Ratios (Production)

| Type | Target Ratio | Method |
|------|-------------|--------|
| Historical context | 3:1 to 5:1 | Batch summarize older turns |
| Tool outputs | 10:1 to 20:1 | Extract relevant fields only |
| Sub-agent results | 20:1 to 50:1 | Return 1,500 token summary from 50K+ processed |
| Overall reduction | 60% achievable | Without information loss for conversation agents |

### Prompt Caching Benchmarks (DeepResearchBench, Jan 2026)

500 agent sessions, 10,000-token system prompts:

| Model | Cost Reduction | TTFT Improvement |
|-------|---------------|-----------------|
| GPT-5.2 | **79.6%** | 13.0% |
| Claude Sonnet 4.5 | **78.5%** | 22.9% |
| Gemini 2.5 Pro | 41.4% | 6.1% |
| GPT-4o | 45.9% | **30.9%** |

### Temporal Decay Formula (FadeMem/CO-RE 2026)

```
v(t) = v(0) * exp(-λ * (t - τ)^β)

λ = 0.1 (base decay rate)
β = 0.8 (long-term, gradual decay, half-life ~11.25 days)
β = 1.2 (short-term, rapid decay, half-life ~5.02 days)
Promote threshold: 0.7 → move to long-term
Demote threshold: 0.3 → move to short-term
```

Alternative: Memoria Framework uses 0.995 per hour (~0.886 per day).

### Hybrid Retrieval (BM25 + Vector + Temporal)

| Approach | Recall | Accuracy | Failure Rate |
|----------|--------|----------|-------------|
| Vector only | 1x | baseline | baseline |
| Hybrid (BM25 + vector) | **3-3.5x** | **+11-15%** | **-49%** |

**RRF formula:** `score(d) = Σ(1 / (60 + rank_i(d)))` for each retriever i.
**Temporal weighting:** `final_score = 0.75 * RRF_score + 0.25 * exp(-0.1 * hours_since_creation)`

### Key Insight

The optimal operating range for context is 60-80% utilization with compaction at 70-75%. Observation masking is strictly better than LLM summarization for cost. Hybrid retrieval (BM25 + vector) dramatically outperforms either alone. Memory formation (storing extracted facts, not compressed transcripts) achieves 80-90% token reduction with 26% quality improvement.

---

## 13. Contrarian Analysis — The Case Against Complexity

**Full report:** `research/agent-context-memory-architecture/agents/contrarian-analysis.md`

### Challenge 1: "More Memory = Better Agent"

**Evidence against:** Edinburgh/NVIDIA DMS research found **8x less memory improved accuracy by 12 points**. The mechanism: reducing retrieval noise allows the model to focus on the actual task rather than processing irrelevant retrieved context.

### Challenge 2: "RAG Solves Everything"

**Failure modes in production:**
- Retrieval noise: irrelevant documents dilute attention
- Context fragmentation: splitting documents at chunk boundaries loses coherence
- "Always retrieve" anti-pattern: retrieving when unnecessary adds latency + noise
- Cost scaling: retrieval overhead exceeds benefit for simple queries

### Challenge 3: "Agents Need Long-Term Memory"

**When stateless is better:**
- Pipeline/batch tasks (DAI already does this right)
- One-shot queries where prior context is irrelevant
- Tasks where stale memory causes more harm than starting fresh
- Stateless agents scale linearly; stateful agents have coordination overhead

### Challenge 4: "Multi-Agent Systems Need Shared Context"

**When isolation is strictly better:**
- Prevents the 17x error amplification (Moran 2025)
- Eliminates coordination tax below the threshold where specialization pays off
- Single-agent outperforms multi-agent for tasks under 10 steps

### Challenge 5: "Vector Search is the Future"

**BM25 wins in practice:**
- GitHub chose BM25 for code search over embeddings
- Letta filesystem benchmark: grep (74%) beat graph-based memory (68.5%)
- Medical document classification: BM25 outperformed vector search
- Tool familiarity > tool sophistication (agents work better with familiar tools)

### Challenge 6: "Context Windows are the Bottleneck"

**It's what you put IN, not the size:**
- Anthropic: "find the smallest set of high-signal tokens"
- 8K-32K sufficient for most production cases
- Compaction is the first lever, not bigger windows
- Quality of context has more impact than quantity

### Challenge 7: The "Memory Tax"

- Retrieval latency: 50-200ms per memory query
- Token waste: verbose memory injection consumes budget
- Infrastructure cost: embedding models, vector stores, maintenance
- **Threshold:** Memory tax exceeds benefit when retrieval precision drops below ~70%

### The Simplicity Argument

- **90-95% of agent pilots fail** (Gartner predicts 40% cancellation by 2028)
- "Bag of agents" pattern is the #1 failure mode
- Over-engineering cost is real and measurable
- Deliberate simplicity rationale: fewer failure modes, easier debugging, faster iteration

### Key Insight

The evidence overwhelmingly supports conservative, disciplined memory architecture over sophisticated systems. DAI's existing decisions — FTS5 primary, vector optional, pipeline isolation, structured handoffs — are validated by the data. **Enable V2 features conservatively, measure before expanding, treat every context token as a finite resource.**

---

## 14. Hermes Agent — Persistent Personal Agent

**Repository:** [NousResearch/hermes-agent](https://github.com/nousresearch/hermes-agent) (1,442 stars in 5 days, MIT, Python)
**Full report:** `research/hermes-agent/report.md`

### What It Is

NousResearch's complete agent product — not a framework, but a deployable persistent AI agent with CLI, multi-platform messaging gateway (Telegram, Discord, Slack, WhatsApp), memory, skills, cron scheduling, and RL training integration. Launched 2026-02-26. Alpha maturity. NousResearch is the most credible open-source model fine-tuning lab outside major corps ($50-65M Series A from Paradigm).

**Architecturally the closest open-source sibling to DAI/Isidore Cloud:** persistent daemon, Telegram bridge, session memory, skills, cross-session continuity, scheduling. Parallel evolution toward the same goal from different starting points.

### Core Architecture

```
hermes CLI ──┐
             ├──→ AIAgent (run_agent.py, ~1,800 lines)
Gateway ─────┤      ├── ToolRegistry (self-registration singleton)
             │      ├── ContextCompressor (protect-head + protect-tail, summarize middle)
RL Batch ────┘      ├── MemoryStore (MEMORY.md + USER.md, frozen snapshot injection)
                    ├── SessionDB (SQLite WAL + FTS5)
                    ├── SkillsSystem (progressive disclosure, self-authoring)
                    └── Delegate (subagent spawning, depth-limited)
```

- **LLM interface:** OpenAI Python SDK (any OpenAI-compatible endpoint, OpenRouter default = 200+ models)
- **Execution:** Standard ReAct loop, max 60 iterations
- **Terminal:** 5 sandboxed backends (local, Docker, SSH, Singularity, Modal)
- **Tools:** ~35 built-in (web, browser, file, terminal, vision, memory, skills, delegation, cron)

### 14.1 Frozen Snapshot Memory Injection (Most Significant Innovation)

Two file-backed memory stores in `~/.hermes/memories/`:
- **MEMORY.md** — Agent's notes (environment facts, project conventions, lessons learned)
- **USER.md** — User profile (name, role, preferences, style)

**The key pattern:** Memory is loaded at session start, frozen as a snapshot in the system prompt, and never updated mid-session. Mid-session memory writes update only the on-disk files. The agent sees live state through tool responses, not through the system prompt.

```python
class MemoryStore:
    def load_from_disk(self):
        self.memory_entries = self._read_file("MEMORY.md")
        self.user_entries = self._read_file("USER.md")
        # Frozen snapshot for system prompt — never changes mid-session
        self._system_prompt_snapshot = {
            "memory": self._render_block("memory", self.memory_entries),
            "user": self._render_block("user", self.user_entries),
        }
```

**Why this matters for DAI:** DAI's `ContextBuilder` queries `MemoryStore` before each Claude invocation, creating a slightly different prompt prefix every turn. This invalidates Claude's prompt cache. Frozen snapshot preserves cache stability → ~75% input token cost reduction. With Claude Sonnet 4.5 showing 78.5% cost reduction from caching (DeepResearchBench), this is the single highest-ROI pattern in this entire report.

### 14.2 Character-Bounded Curated Memory

Memory stores use **character limits** (2,200 chars for memory, 1,375 chars for user profile) rather than token limits. This is model-independent — same memory works regardless of model.

The agent must actively curate: consolidate, replace, and remove entries rather than append indefinitely. Memory tool schema description instructs proactive saving:

> "WHEN TO SAVE (do this proactively, don't wait to be asked): User shares a preference... You discover something about the environment... User corrects you..."

**Comparison:** Letta's self-editing memory blocks (Section 3) operate at the memory-block level. Hermes operates at the individual-entry level with substring matching for replace/remove. Both force curation; Hermes is simpler but less flexible.

### 14.3 Context Compression

Protect-first-N + protect-last-N, summarize everything in between using a cheap auxiliary model (Gemini Flash). Summary targets ~2,500 tokens, asks for neutral factual description of actions, results, decisions, file names.

- Token tracking uses **actual API response counts** (not estimates)
- Falls back to simple truncation if no auxiliary model available
- Can fire multiple times per session
- Tracked via `compression_count`

**Comparison with other frameworks:**

| Framework | Compaction Approach | Trigger |
|-----------|-------------------|---------|
| Hermes | Head+tail, summarize middle (auxiliary model) | 85% of context |
| Claude SDK | Server-side compaction (provider generates summary) | Configurable (default 150K) |
| OpenCode | Active model summarizes, preserves rules section | 75% hardcoded |
| OpenClaw | Pruning → compaction → retry cascade | Progressive |
| Letta | Recursive summary of evicted messages | FIFO overflow |

### 14.4 Self-Registration Tool Pattern

Each tool file is self-contained: schema, handler, availability check, and registry call all co-located.

```python
# tools/web_search.py
from tools.registry import registry

SCHEMA = {"name": "web_search", "description": "...", "parameters": {...}}

def handler(args):
    ...

registry.register("web_search", "web", SCHEMA, handler)
```

Adding a new tool = 1 new file + 1 line in toolsets. No central switch statement, no parallel data structures. Clean for a growing toolset.

### 14.5 Progressive Disclosure Skills + Self-Authoring

Three-tier skill loading minimizes token cost:
1. `skills_categories()` — category names (~50 tokens)
2. `skills_list(category)` — name + description (~3K tokens)
3. `skill_view(name)` — full content

The agent can also **create and edit skills** via `skill_manage()`. System prompt nudges:

> "After completing a complex task (5+ tool calls), fixing a tricky error, or discovering a non-trivial workflow, consider saving the approach as a skill."

This creates a self-improvement feedback loop — closer to Letta's self-editing memory but applied to procedural knowledge rather than declarative facts.

### 14.6 Context File Injection Scanning

All context files (`AGENTS.md`, `.cursorrules`, `SOUL.md`) are scanned for prompt injection before entering the system prompt:

```python
_CONTEXT_THREAT_PATTERNS = [
    (r'ignore\s+(previous|all|above|prior)\s+instructions', "prompt_injection"),
    (r'do\s+not\s+tell\s+the\s+user', "deception_hide"),
    (r'system\s+prompt\s+override', "sys_prompt_override"),
    ...
]
```

Content with invisible Unicode characters or threat patterns is blocked. Most frameworks blindly inject these files.

### 14.7 Multi-Agent: Delegation Without Orchestration

`delegate_task` tool spawns isolated subagents:
- Single or batch parallel (up to 3)
- Each child gets fresh `AIAgent` with isolated context
- Blocked tools: `delegate_task` (no recursion), `clarify` (no user interaction), `memory` (no shared writes)
- `MAX_DEPTH = 2` prevents recursive delegation
- Only final summary enters parent context (intermediate tool calls excluded)

**No workflow engine.** Unlike DAI's DAG orchestrator, Hermes has no dependency resolution, crash recovery, or workflow persistence. Complex tasks rely entirely on the model's implicit planning.

### 14.8 RL Training Integration (Unique)

The agent doubles as an RL training environment (Atropos integration):
- Batch trajectory generation for fine-tuning datasets
- 11 tool call parsers for different model families (Hermes, Qwen, DeepSeek, Llama, Mistral, GLM, Kimi)
- **Toolset distributions** — probabilistic toolset sampling creates training diversity
- Same codebase for production and training → flywheel effect

### 14.9 Strengths & Weaknesses

**Strengths:** Complete product (not a library), model-agnostic (200+ models via OpenRouter), well-designed memory (frozen snapshot + bounds + scanning), skills self-improvement loop, RL training pipeline (unique), clean tool registration, strong security awareness.

**Weaknesses:** Python-only (slower than TS/Bun for daemon), no native Anthropic API support (must proxy), basic context compression (no semantic scoring), memory bounds too tight (2,200 chars ≈ weeks before forced curation loss), no structured workflow engine, monolithic gateway (one platform crash takes all down), 5 days old.

### Key Insight

Hermes Agent validates DAI's architectural direction and provides three immediately adoptable patterns: (1) frozen snapshot memory injection for prompt cache stability, (2) character-bounded curated memory to prevent context rot, (3) injection scanning for cross-user pipeline security. DAI is already ahead on structured workflows, cross-agent collaboration, and type safety.

---

# Part III — Synthesis

## 15. DAI Framework Analysis

**Source:** Comprehensive audit of `~/projects/Pai-Exploration/` (14 exploration docs, 756KB)

### What DAI v4.0.1 Already Has

| Component | Scale | Status |
|-----------|-------|--------|
| Event-driven hooks | 20 hooks across 6 lifecycle events | Working |
| Skills ecosystem | 48 SKILL.md files, 159 workflows | Working |
| Algorithm v3.5.0 | 7-phase structured execution with ISC criteria | Working |
| Identity system | 7 layers (persona, principal, rules, preferences, voice, data, memory) | Working |
| Three-tier memory | HOT (session) → WARM (MEMORY.md) → COLD (durable storage) | Capture working, synthesis broken |
| Dynamic context | SessionStart hooks inject relationship, learning, work context | Working |
| Tools | 30+ TypeScript utilities | Working |

### The #1 Problem: "Remembers Everything, Learns Nothing"

- System captures ~960 KB/day across 6 subsystems
- Auto-consumes only ~5% (MEMORY.md synthesis, partial relationship notes)
- Synthesis tools exist (LearningPatternSynthesis, RelationshipReflect, WisdomFrameUpdater) but **none are scheduled**
- **Fix effort:** 6-9 hours of scheduling work (not new code)

### Architectural Patterns Worth Adopting in the New Framework

1. **ISC criteria system** — Atomic, verifiable, splitting-tested ideal state specification
2. **Three-tier memory** — HOT (working) → WARM (save game) → COLD (durable)
3. **Event-driven hooks** — Clean lifecycle: SessionStart → UserPromptSubmit → PreToolUse → PostToolUse → Stop → SessionEnd
4. **Fire-and-forget background tasks** — Synthesis, archival, maintenance without blocking
5. **Dynamic context injection** — Load topic-specific docs on-demand, not at startup
6. **Capability invocation tracking** — Verify selected skills/tools are actually invoked (prevent phantom invocation)
7. **Personality traits system** — Quantified 12-dimension model affecting communication style

### Design Gaps to Avoid in the New Framework

1. **Synthesis loop must be closed** — Schedule consumption, not just capture
2. **Wisdom Frames are phantom** — Referenced but never built; either build or remove
3. **False positive filtering** — Rating parser needs standalone number detection
4. **Dead code cleanup** — WorkCompletionLearning produces zero output
5. **Memory lifecycle management** — Retention policies (SECURITY/ and VOICE/ grow indefinitely)
6. **THREAD.md unfilled templates** — Phase logging overhead rarely justified

---

## 16. Unified Synthesis & Architecture Recommendations

### The Validated Dual-Mode Model

Every framework, every production system, every research paper validates this separation:

**Mode A: "Workspace" (Agent-to-Agent / Pipeline)**
- Lean context (~1,400-2,000 tokens overhead)
- No project CLAUDE.md loaded
- No session continuity (one-shot)
- No memory injection (or workspace-only knowledge)
- AG2-style context variables: structured task metadata invisible to LLM
- Observation masking for tool outputs if context grows
- This is how DAI pipeline tasks already work

**Mode B: "Project" (Direct Telegram / Interactive)**
- Full project context (CLAUDE.md, session, handoff state)
- Memory filtered by active project (LangGraph-style namespace)
- Session continuity via `--resume` with compaction at 70%
- Context injection: project-scoped episodes + knowledge + whiteboard
- Self-editing memory blocks for persistent project knowledge
- Running summary (Whiteboard pattern) for key decisions
- Cache-friendly prompt structure (static prefix → dynamic suffix)

### Consensus Architecture from 10 Frameworks

```
┌─────────────────────────────────────────────────────────────┐
│                     CONTEXT WINDOW                          │
│                                                             │
│  ┌──────────────────────────────────────┐  STATIC PREFIX    │
│  │ System Instructions (10-15%)        │  (cacheable)      │
│  │ Tool Schemas (15-20%)               │                   │
│  │ Project Rules (compaction-immune)    │                   │
│  └──────────────────────────────────────┘                   │
│                                                             │
│  ┌──────────────────────────────────────┐  SEMI-STATIC       │
│  │ Memory Snapshot (frozen at start)   │  (session-stable)  │
│  │   ├── Curated memory (≤5K chars)    │                   │
│  │   └── User profile (≤2K chars)      │                   │
│  └──────────────────────────────────────┘                   │
│                                                             │
│  ┌──────────────────────────────────────┐  DYNAMIC          │
│  │ Knowledge Context (30-40%)          │  (per-turn)       │
│  │   ├── Whiteboard (running summary)  │                   │
│  │   ├── Retrieved episodes (scoped)   │                   │
│  │   └── Artifact index (file paths)   │                   │
│  ├──────────────────────────────────────┤                   │
│  │ History Context (20-30%)            │                   │
│  │   ├── Recent turns (full)           │                   │
│  │   ├── Older turns (masked obs.)     │                   │
│  │   └── Compaction summaries          │                   │
│  ├──────────────────────────────────────┤                   │
│  │ Buffer Reserve (10-15%)             │                   │
│  └──────────────────────────────────────┘                   │
│                                                             │
│  Compaction trigger: 70-75% utilization                     │
│  Performance cliff: >85% utilization                        │
│  Target operating range: 60-80%                             │
└─────────────────────────────────────────────────────────────┘
```

### Memory Architecture (Validated Design)

```
┌─────────────────────────────────────────────────┐
│                  Memory System                   │
│              (SQLite + FTS5 primary)             │
├─────────────────────────────────────────────────┤
│  Episodes (timestamped, source-tagged)          │
│    ├── project: "my-pai-cloud" | null           │
│    ├── source: "telegram" | "pipeline" | ...    │
│    ├── role: "user" | "assistant" | "system"    │
│    └── provenance: { agent, confidence }        │
├─────────────────────────────────────────────────┤
│  Knowledge (curated, self-editable)             │
│    ├── namespace: "project/my-pai-cloud"        │
│    ├── namespace: "workspace/global"            │
│    └── namespace: "agent/isidore"               │
├─────────────────────────────────────────────────┤
│  Whiteboard (running summary per project)       │
│    ├── decisions[]                              │
│    ├── requirements[]                           │
│    ├── artifact_index[] (file paths + states)   │
│    └── active_context                           │
├─────────────────────────────────────────────────┤
│  Retrieval Pipeline                             │
│    ├── FTS5 keyword search (primary)            │
│    ├── sqlite-vec similarity (optional boost)   │
│    ├── Temporal decay: exp(-0.1 * hours)        │
│    └── RRF fusion if hybrid available           │
└─────────────────────────────────────────────────┘

Injection Rules:
  Mode A (workspace): No injection, or workspace/* knowledge only
  Mode B (project):   Project-scoped episodes + knowledge + whiteboard
                      → Budget to CONTEXT_MAX_TOKENS (conservative: ≤1,500 tokens)
                      → Static prefix first (cache-friendly)
                      → Observation masking for older tool outputs
```

### Priority Implementation Patterns

| Priority | Pattern | Source | Impact | Effort |
|----------|---------|--------|--------|--------|
| 1 | **Frozen snapshot memory injection** | Hermes Agent | ~75% input cost reduction via cache stability | Small |
| 2 | Project + source filters on MemoryStore.search() | LangGraph, all frameworks | Prevents cross-project pollution | Small |
| 3 | **Character-bounded curated memory** (≤5K chars) | Hermes Agent, Letta | Prevents context rot, forces curation | Small |
| 4 | Mode-aware context injection (workspace vs project) | All frameworks | Dual-mode separation | Small |
| 5 | Cache-friendly prompt structure | Manus, Anthropic, Hermes | 78-80% cost reduction on cached prefix | Small |
| 6 | Observation masking (not summarization) | JetBrains NeurIPS | 52% cost reduction, better quality | Medium |
| 7 | **Injection scanning on pipeline tasks** | Hermes Agent | Defense-in-depth for cross-user tasks | Small |
| 8 | Whiteboard / running summary per project | Semantic Kernel | Better than raw episode retrieval | Medium |
| 9 | Compaction-immune rules tagging | OpenCode | Critical rules survive compression | Small |
| 10 | Self-editing memory blocks | Letta, Hermes skills | Agent curates its own knowledge | Medium |
| 11 | Part-based message storage | OpenCode | Unlocks streaming, filtering, forking | Large |
| 12 | Client-server separation (HTTP+SSE) | OpenCode | Multiple frontends, testability | Large |
| 13 | Artifact index (separate from compression) | Factory.ai, ADK | Solves the unsolved tracking problem | Medium |
| 14 | Progressive disclosure skills | Hermes Agent | Token-efficient skill loading | Medium |
| 15 | Narrative casting for handoffs | Google ADK | Prevents agent identity confusion | Small |
| 16 | Markdown agent definitions | OpenCode, Hermes | Democratizes agent creation | Medium |

### What NOT to Do (Evidence-Based)

1. **Don't over-engineer memory** — 8x less memory improved accuracy by 12 points
2. **Don't default to LLM summarization** — Observation masking is cheaper and better
3. **Don't share session state** between unrelated tasks (pipeline already avoids this)
4. **Don't eager-load MCP tools** — 51K tokens for 4 servers = 46.9% context burn
5. **Don't inject all memory** into every prompt (context rot)
6. **Don't chase vector search** before proving FTS5 insufficient (BM25 beat vectors in multiple benchmarks)
7. **Don't build "bag of agents"** — centralized orchestration or bust (17x error amplification)
8. **Don't put timestamps in system prompts** — kills KV-cache (Manus learned this the hard way)
9. **Don't optimize tokens per request** — optimize tokens per task (re-fetching compressed data costs more)
10. **Don't exceed 85% context utilization** — performance cliff is real and model-dependent

### Recommended Implementation Path

**Phase 1: Scoped Memory + Cache Stability (enable what exists + quick wins)**
1. **Frozen snapshot injection** — Add `freeze()` to `ContextBuilder`. Query once at session start, return frozen result on subsequent calls. Reset on new session/handoff.
2. Add project + source filters to `MemoryStore.search()`
3. **Character-bounded memory** — Add configurable budget (≤5K chars) to `ContextBuilder` with entry-level curation.
4. Update `ContextBuilder` for mode-aware injection
5. Enable `CONTEXT_INJECTION_ENABLED=1` with conservative budget (≤1,500 tokens)
6. **Injection scanning** — Lightweight regex on pipeline task prompts (invisible Unicode + threat patterns)
7. Add narrative casting to handoff messages

**Phase 2: Context Engineering (new capabilities)**
8. Implement observation masking for pipeline tasks
9. Design whiteboard table structure (decisions + requirements + artifact index)
10. Implement cache-friendly prompt ordering in `ContextBuilder`
11. Add compaction-immune tagging for injected rules

**Phase 3: Agent Framework Foundations**
12. Prototype self-editing memory via Claude tool
13. Design markdown agent definition format (`.pai/agents/`)
14. Implement progressive disclosure skill loading
15. Explore client-server separation (Hono HTTP layer)
16. Close DAI's synthesis loop (schedule LearningPatternSynthesis etc.)

**Phase 4: Advanced Patterns**
17. Part-based message storage migration
18. Session forking capability
19. Sleep-time memory refinement
20. Artifact management service
21. Self-registration tool pattern (for growing tool ecosystem)

---

## Research Metrics (Combined)

### Session 1 (2026-03-01)
- **Agents launched:** 9 (3 Claude, 3 Gemini, 2 Perplexity, 1 Grok)
- **Agents returned:** 5 (4 hit API rate limits)
- **Additional sources:** YouTube transcript, OpenClaw codebase (16 file reads)
- **Frameworks covered:** MemGPT/Letta, LangGraph, CrewAI, AutoGen/AG2, Semantic Kernel, OpenClaw

### Session 2 (2026-03-02)
- **Agents launched:** 6 (2 Claude, 1 Gemini, 2 Perplexity, 1 Grok)
- **Agents returned:** 6 (all successful)
- **Additional sources:** Pai-Exploration project audit (14 docs, 756KB)
- **Frameworks added:** Claude Agent SDK, OpenCode
- **New topics:** Context engineering SOTA, multi-agent isolation, context window optimization, contrarian analysis

### Session 3 (2026-03-02, afternoon)
- **Agents launched:** 2 (1 Claude, 1 Gemini)
- **Agents returned:** 2 (all successful)
- **Source files examined:** 22 (Hermes Agent repo via GitHub API)
- **Framework added:** Hermes Agent (NousResearch)

### Combined Totals
- **Total research agents:** 17 (13 returned successfully)
- **Frameworks analyzed:** 10 (OpenClaw, MemGPT/Letta, LangGraph, CrewAI, AutoGen/AG2, Semantic Kernel, Claude Agent SDK, OpenCode, Google ADK, Hermes Agent)
- **Academic papers cited:** 8+ (JetBrains NeurIPS, Lost in the Middle, ACON ICML, Intelligence Degradation, Context Rot, FadeMem, Codified Context, DMS)
- **Production systems analyzed:** 5 (Manus, Factory.ai, Anthropic internal, OpenClaw, DAI)
- **Primary sources:** 100+
- **Total tokens synthesized from:** ~700K+ tokens of research

### Individual Report Locations

All reports live in the project repo under `research/`:

| Report | Location |
|--------|----------|
| Main synthesis (this file) | `research/agent-context-memory-architecture/report.md` |
| Claude Agent SDK | `research/agent-context-memory-architecture/agents/claude-agent-sdk.md` |
| OpenCode | `research/agent-context-memory-architecture/agents/opencode.md` |
| Context Engineering SOTA | `research/agent-context-memory-architecture/agents/context-engineering-sota.md` |
| Multi-Agent Isolation | `research/agent-context-memory-architecture/agents/multi-agent-isolation.md` |
| Context Window Optimization | `research/agent-context-memory-architecture/agents/context-window-optimization.md` |
| Contrarian Analysis | `research/agent-context-memory-architecture/agents/contrarian-analysis.md` |
| Hermes Agent (Claude deep-dive) | `research/hermes-agent/agents/claude-researcher.md` |
| Hermes Agent (Gemini ecosystem) | `research/hermes-agent/agents/gemini-researcher.md` |
| Hermes Agent (synthesis) | `research/hermes-agent/report.md` |
| HZL Framework | `research/hzl-framework/report.md` |
| Persona Framework | `research/persona-framework/report.md` |
| Multi-Agent Communication | `research/multi-agent-communication/report.md` |
