# Context Engineering for AI Agents: State of the Art (2025-2026)

**Research Date:** 2026-03-02
**Researcher:** Alex Rivera (Multi-Perspective Analyst)
**Scope:** Production patterns, framework implementations, trade-offs
**Sources:** 15+ primary sources including Anthropic, Manus, Google ADK, Factory.ai, JetBrains Research, academic papers

---

## Table of Contents

1. [The Discipline: What Context Engineering Is](#1-the-discipline)
2. [Dynamic Context Injection](#2-dynamic-context-injection)
3. [Context Budgeting](#3-context-budgeting)
4. [Prompt Caching Strategies](#4-prompt-caching)
5. [Context Compression](#5-context-compression)
6. [Retrieval-Augmented Context & Agent Memory](#6-rag-and-agent-memory)
7. [Context Routing for Multi-Agent Systems](#7-context-routing)
8. [Production Trade-offs & Honest Difficulties](#8-trade-offs)
9. [Implications for PAI](#9-implications-for-pai)
10. [Sources](#10-sources)

---

## 1. The Discipline: What Context Engineering Is

### 1.1 Origin of the Term

The term "context engineering" was popularized in mid-2025 by Shopify CEO Tobi Lutke and quickly endorsed by Andrej Karpathy (former Tesla AI Director, early OpenAI researcher). Karpathy's definitive statement:

> "+1 for 'context engineering' over 'prompt engineering'. People associate prompts with short task descriptions you'd give an LLM in your day-to-day use. When in every industrial-strength LLM app, context engineering is the delicate art and science of filling the context window with just the right information for the next step."

Simon Willison (creator of Datasette, prolific AI blogger) further amplified the term, noting it would "stick" because unlike "prompt engineering," it has an inferred definition much closer to the intended meaning. He emphasized that context engineering captures the fact that **the previous responses from the model are a key part of the process** -- not just the user prompt.

### 1.2 The Distinction from Prompt Engineering

| Dimension | Prompt Engineering | Context Engineering |
|-----------|-------------------|-------------------|
| **Scope** | Crafting a single instruction | Designing the entire information environment |
| **Lifecycle** | Ends when you craft a good prompt | Begins with systems that assemble memory, knowledge, tools, data |
| **Metaphor** | Writing a good question | Writing the full screenplay |
| **Components** | Task description, few-shot examples | System prompt + RAG + memory + tools + state + history + compacting |
| **Runtime behavior** | Static | Dynamic -- assembled per-turn from multiple sources |
| **Failure mode** | Bad phrasing | Wrong information, stale state, context rot, token waste |

As the Addyo/O'Reilly framing puts it: think of an LLM like a CPU with its context window as RAM. Your role as engineer is like an operating system -- you dynamically load that working memory with just the right code and data for the task.

### 1.3 Core Principles (Production-Validated)

From Anthropic's engineering guide, Manus production lessons, Google ADK architecture, and the 12-Factor Agent framework, these principles have converged:

1. **Context is a finite resource.** Treat it like operating systems treat memory and CPU cycles -- budget, compact, and intelligently page it.

2. **Smallest set of high-signal tokens.** Find the minimal set that maximizes likelihood of the desired outcome (Anthropic).

3. **Language models are mimics.** They imitate the pattern of behavior in the context. If your context is full of similar past action-observation pairs, the model follows that pattern even when suboptimal (Anthropic).

4. **Context engineering IS the job.** As Cognition AI observed, context engineering has effectively become the primary responsibility of engineers building AI agents.

5. **Sophistication beats scale.** A small, well-engineered team with a less powerful model, guided by careful context management, consistently outperforms large teams with frontier models but poor context discipline (multiple sources confirm this).

6. **Do the simplest thing that works.** Smarter models require less prescriptive engineering, allowing agents to operate with more autonomy (Anthropic). The meta-principle.

---

## 2. Dynamic Context Injection

### 2.1 The Core Pattern

Dynamic context injection is the real-time or on-demand feeding of relevant information into a language model during inference. Unlike static prompt engineering (all context included at session start), dynamic injection provides flexible, situation-specific updates based on the current task, user request, or external data.

### 2.2 Just-in-Time Retrieval (Anthropic Pattern)

Rather than pre-loading all possible data into context, maintain lightweight identifiers (file paths, URLs, stored queries) and dynamically retrieve via tools during execution.

**How Claude Code does it:** Uses Bash commands (head, tail), glob, and grep to analyze large datasets without loading full objects into context. The agent explores progressively -- metadata signals (file naming, folder hierarchies, timestamps) inform decisions about what to actually load.

**Benefits:**
- Progressive disclosure through exploration
- Self-managed context windows keep focus on relevant subsets
- Agent learns what it needs rather than being front-loaded

**Trade-off:** Runtime exploration slower than pre-computed retrieval; requires thoughtful tool design to prevent agents wasting context on dead-ends.

### 2.3 Google ADK: Compiled Views over State

ADK treats context as a "compiled view over a richer stateful system." The framework uses an LLM Flow with ordered processors that transform underlying state into presentation:

```
Request Processors (instructions, identity, contents)
  -> Response Processors (planning, code execution)
  -> Context Cache Processors (optimization)
```

Each processor builds on previous outputs, providing natural insertion points for custom filtering, compaction, caching, and multi-agent routing. Context is built through named, ordered processors -- not ad-hoc string concatenation -- making the compilation step observable and testable.

**Key insight:** Every model call and sub-agent sees the minimum context required. This is enforced architecturally, not by convention.

### 2.4 Manus: Action Space Management

Manus does not dynamically remove tools from context. Instead, they **mask token logits during decoding** to prevent or enforce selection of certain actions.

Three function-calling modes:
- **Auto:** Model chooses whether to call functions
- **Required:** Model must call a function (unconstrained which one)
- **Specified:** Model restricted to specific tool subset via response prefilling

Design pattern: Consistent action name prefixes (e.g., `browser_*`, `shell_*`) enable logit masking without stateful prompt processors. The tools stay in context (maintaining KV-cache stability) but the model is constrained at decode time.

### 2.5 Proactive vs Reactive Memory Retrieval (ADK)

Two patterns for injecting memory into context:
- **Reactive recall:** Agent explicitly searches memory when it decides it needs information
- **Proactive recall:** System automatically injects relevant memories based on similarity to current input, before the agent even asks

Production systems typically combine both. The system proactively injects high-confidence matches, and the agent can reactively search for edge cases.

---

## 3. Context Budgeting

### 3.1 The Token Budget Framework

From production optimization research (Maxim.ai), a specific allocation model:

| Component | Budget | Rationale |
|-----------|--------|-----------|
| **System Instructions** | 10-15% | Disproportionate influence on behavior |
| **Tool Context** | 15-20% | Tool descriptions and parameters |
| **Knowledge Context** | 30-40% | Retrieved information and domain knowledge |
| **History Context** | 20-30% | Conversation history and previous interactions |
| **Buffer Reserve** | 10-15% | Emergency capacity for unexpected expansion |

### 3.2 The Four-Tier Priority Hierarchy

Context should be prioritized in tiers:

1. **Highest:** Current task objectives and immediate constraints
2. **Medium:** Recent conversation history and user preferences
3. **Lower:** Historical summaries
4. **External:** Detailed historical data stored externally, not consuming context until needed

### 3.3 Compression Ratios by Component Type

Production-validated compression ratios:
- **Historical context:** 3:1 to 5:1 (summarize older turns)
- **Tool outputs:** 10:1 to 20:1 (extract relevant fields, discard verbose output)
- **Overall context reduction:** 60% reduction achievable without information loss for conversation agents

### 3.4 Cost Implications

Concrete example from production: A customer service agent with 15 conversation turns generates ~$0.07 per conversation. At 10,000 daily conversations:
- **Unoptimized:** $255,000/year
- **With basic context compression (60% reduction):** $102,000/year
- **Savings:** $153,000/year

Token consumption must account for: system prompts + user input + tool outputs + conversation history + retrieved documents. Each of these is a budget line item, not an afterthought.

### 3.5 The Manus Input-Output Ratio Problem

Manus reports a 100:1 token ratio (input to output) for their agent. This means the agent reads 100 tokens for every 1 it writes. For chatbots the ratio is much lower, but for agents doing multi-step tool-use tasks, the input side dominates cost.

This has a critical implication: **optimizing input tokens (via context engineering) has 100x more cost impact than optimizing output tokens** for agentic workloads.

---

## 4. Prompt Caching Strategies

### 4.1 How Prompt Caching Works

Prompt caching stores the KV-cache (intermediate attention states) of processed tokens. A new query sharing the same prefix can skip recomputing that portion and directly reuse cached results.

The KV-cache stores key-value pairs for each attention head at each layer. For a 70B parameter model, this can be 10-20GB of GPU memory per request. Caching the prefix avoids recomputing these expensive attention matrices.

### 4.2 Provider-Specific Performance (December 2025 / Early 2026)

| Provider | Cost Reduction | Latency (TTFT) Improvement | Notes |
|----------|---------------|---------------------------|-------|
| **Anthropic** | 90% for cached tokens ($0.30 vs $3.00/MTok) | 20-23% TTFT improvement | Most consistent across caching strategies |
| **OpenAI** | 50% for cached tokens | 31% optimal, -8.8% with naive full-context | Automatic caching enabled by default |
| **Google Gemini** | Moderate | 6.1% TTFT improvement | Negative performance (-2.9%) when excluding tool results |

### 4.3 Cache-Friendly Prompt Architecture

**The golden rule:** Place static content at the beginning, variable content at the end.

Specific patterns that maximize cache hits:

1. **System prompt isolation:** Place unique identifiers (UUIDs, cache breakers) AFTER static system instructions. This ensures only reusable content gets cached.

2. **No timestamps in system prompts.** Manus learned this the hard way -- timestamps destroy cache hit rates because even a one-token difference invalidates the entire downstream cache.

3. **Deterministic serialization.** If you serialize JSON into context (e.g., memory records, tool schemas), ensure stable key ordering. Non-deterministic serialization causes cache misses even when content is logically identical.

4. **Consistent routing for self-hosted models.** Use session IDs to route requests to the same distributed worker (e.g., vLLM). Different workers have different caches.

5. **Tool result exclusion from cached prefix.** Implement cache boundaries (UUIDs) after tool results to prevent caching of session-specific outputs that won't produce future hits.

### 4.4 The Naive Caching Anti-Pattern

Research on 500+ agent sessions found that **naively enabling full-context caching can paradoxically increase latency.** Dynamic tool calls and results trigger cache writes for content that will never be reused across sessions. The overhead of writing to cache exceeds the benefit.

Strategic boundary control (caching only the stable prefix) consistently outperforms naive approaches.

### 4.5 Cache Retention

- **In-memory policy:** Cached prefixes remain active for 5-10 minutes of inactivity, up to 1 hour maximum
- **Extended retention:** Up to 24 hours
- **Minimum threshold:** Providers require 1,024-4,096 tokens before caching activates, meaning larger system prompts unlock greater benefits

### 4.6 Architecture Implications for Agents

For agentic workloads spanning 30-50+ tool calls per session, prompt caching is essential. The pattern:

```
[CACHED: System prompt + tool schemas + few-shot examples]
[CACHE BOUNDARY]
[UNCACHED: Conversation history + tool results + current query]
```

This divides the context window into a stable prefix (instructions, summaries) and a variable suffix (latest interactions). ADK's context cache processors implement this split explicitly.

---

## 5. Context Compression

### 5.1 Compression Taxonomy

Three categories of text-based prompt compression (from academic survey + production validation):

**Token Pruning** (e.g., LongLLMLingua, Selective-Context, PCRL):
- Discards irrelevant tokens based on information-theoretic measures
- Fast, no LLM call required for the pruning itself
- Risk: losing critical tokens the heuristic misjudged

**Abstractive Compression** (e.g., Prompt-SAW, RECOMP, PRCA):
- Generates summaries by synthesizing information
- Higher quality but requires an LLM call (cost)
- Risk: hallucinating or losing precise details (file paths, error messages)

**Extractive Compression** (e.g., RECOMP, reranker-based):
- Selects documents, sentences, or phrases from original without alteration
- Preserves exact wording of selected content
- Risk: may miss information spread across multiple passages

### 5.2 Observation Masking (JetBrains Research, December 2025)

The most cost-effective compression strategy from production benchmarks:

**How it works:** Preserves agent reasoning and action history in full. Replaces older environment observations (tool outputs, web page content, file reads) with placeholders once they exceed a fixed window.

**Implementation:** SWE-agent uses a rolling window, keeping the latest 10 turns of observations intact and masking everything older.

**Results (SWE-bench Verified, 500 instances):**
- 52% cost reduction with Qwen3-Coder 480B
- 2.6% solve rate IMPROVEMENT (not just maintenance -- masking actually helps)
- Matched or exceeded LLM summarization in 4 of 5 test settings

**Why it works better than summarization:** Summarization generates costly API calls (sometimes exceeding 7% of total cost per instance) and causes trajectory elongation (13-15% longer runs), offsetting efficiency gains.

### 5.3 LLM Summarization

**Implementation:** OpenHands uses prompt-based summarization of 21 turns while keeping 10 most recent turns uncompressed.

**Trade-off:** Better theoretical ability to handle infinite context scaling, but the cost of the summarization calls and the tendency toward trajectory elongation (agents take more steps when working from summaries) reduce the net benefit.

**Hybrid recommendation (JetBrains):** Use observation masking as the primary mechanism, with selective LLM summarization for cases where context truly needs indefinite scaling.

### 5.4 ACON Framework (ICML 2025)

ACON uses natural language feedback to optimize compression guidelines, rather than gradient-based fine-tuning:

**Two complementary strategies:**
1. **History compression:** Summarizes accumulated actions and observations when history exceeds threshold
2. **Observation compression:** Extracts essential details from raw observations, filtering distractions

**Optimization approach:**
- Contrastive learning: compares successful trajectories (uncompressed) against failed ones (compressed) to identify what was lost
- LLM-guided refinement: an optimizer LLM analyzes failures and suggests guideline improvements
- Two-phase: utility maximization first, then compression maximization while maintaining performance

**Results:**
- 26-54% peak token reduction while maintaining or improving task success
- Smaller models benefit enormously: Qwen3-14B gains 32% accuracy on AppWorld with compressed contexts
- Compressed guidelines distill into smaller models preserving over 95% of teacher performance

### 5.5 Factory.ai Two-Threshold System

Factory implements persistent, incremental summary maintenance with two key thresholds:

- **T_max:** Compression trigger (the "fill line")
- **T_retained:** Maximum tokens kept after compression (the "drain line"), always lower than T_max

The gap between these thresholds controls compression frequency:

| Gap | Behavior | Trade-off |
|-----|----------|-----------|
| **Narrow (T_retained near T_max)** | Frequent compression | Higher summarization overhead, prompt cache invalidation |
| **Wide (T_retained much less than T_max)** | Infrequent compression | Risk of aggressive truncation losing information |

**Critical lesson:** Over-aggressive compression backfires. Once key artifacts are summarized away, the agent must re-fetch them, adding extra inference calls and latency. The goal is minimizing tokens **per task**, not per request.

### 5.6 Compression Evaluation (Factory.ai Benchmark)

Factory developed a probe-based evaluation framework testing whether agents can continue working after compression. Four probe types: Recall, Artifact, Continuation, Decision.

**Results across 36,611 production messages:**

| Method | Overall Score | Accuracy | Context Awareness | Artifact Trail |
|--------|--------------|----------|-------------------|---------------|
| Factory (anchored iterative) | 3.70/5.0 | 4.04 | 4.01 | 2.45 |
| Anthropic | 3.44/5.0 | 3.74 | 3.56 | 2.33 |
| OpenAI | 3.35/5.0 | 3.43 | 3.64 | 2.19 |

**Key findings:**
- Structure matters most: "anchored iterative summarization" with dedicated sections for files, decisions, and intent prevents information drift
- Higher compression percentages do not guarantee efficiency
- **Artifact tracking remains unsolved:** All methods scored poorly (2.19-2.45/5.0) on file tracking -- this is an open problem

### 5.7 What to Preserve During Compression

For software engineering agents (Factory's domain), the critical preservation list:
- Session intent and stated requirements
- High-level action sequences
- Artifact trails (file modifications, test results)
- Breadcrumbs for reconstructing truncated context (file paths, function names)
- Error messages and stack traces
- Architectural decisions and their rationale

---

## 6. Retrieval-Augmented Context & Agent Memory

### 6.1 The Evolution: RAG -> Agentic RAG -> Agent Memory

The field has evolved through three stages (Leonie Monigatti):

1. **RAG (2023-2024):** Read-only retrieval. Information retrieved once from external source, fed to LLM. Focus: optimizing retrieval techniques (vector, hybrid, keyword).

2. **Agentic RAG (2024-2025):** Agent decides whether retrieval is necessary and selects appropriate tools. Focus: routing and orchestration.

3. **Agent Memory (2025-2026):** Read-write operations. Systems dynamically create, retrieve, modify, and delete information during inference through tool calls. Focus: managing the full information lifecycle.

The critical distinction: RAG retrieves from a static knowledge base; agent memory manages a living, mutable store that the agent itself writes to.

### 6.2 Memory Types (Production Taxonomy)

| Type | Content | Lifetime | Example |
|------|---------|----------|---------|
| **Episodic** | Temporal events, interactions | Per-session to permanent | "User asked about X on March 1" |
| **Semantic** | Factual knowledge, domain info | Long-term, updated | "Project uses Bun + TypeScript" |
| **Procedural** | Behavioral rules, how-to | Long-term, rarely changed | "Always run tests before commit" |

Production systems (including PAI's own MemoryStore) typically implement all three, with episodic being the most write-heavy and procedural the most stable.

### 6.3 Hybrid Search (Vector + Keyword + Temporal)

Modern agent memory requires hybrid search combining three modalities:

**Vector search (semantic):** Embedding-based similarity search. Finds conceptually related memories even when phrasing differs. Requires embedding model (e.g., Ollama, OpenAI embeddings).

**Keyword search (lexical/BM25/FTS5):** Exact term matching. Critical for technical content where precise names (function names, file paths, error codes) must match exactly. FTS5 in SQLite is the production-grade lightweight option.

**Temporal filtering:** Recency weighting and time-range filtering. Prevents stale context propagation -- outdated information fed to the model produces hallucinations grounded in superseded information. TimescaleDB and custom time-decay scoring are common approaches.

**Hybrid combination:** The standard approach is reciprocal rank fusion (RRF) or weighted score combination:
```
final_score = w_vector * vector_score + w_keyword * keyword_score + w_temporal * temporal_decay
```

### 6.4 MemGPT/Letta: Virtual Context Management

MemGPT (now Letta) pioneered the OS-inspired tiered memory model:

**Core Memory (always in context):** Compressed representation of essential facts and personal information. Analogous to CPU registers -- always accessible, tiny footprint.

**Recall Memory (searchable, on-demand):** Searchable database enabling reconstruction of specific memories through semantic search. Analogous to RAM.

**Archival Memory (long-term storage):** Important information that can be moved back into core or recall memory as needed. Analogous to disk.

The agent self-manages its own memory, deciding what to promote from archival to core and what to evict. This is the key innovation: the agent edits its own memory blocks rather than passively recording and retrieving.

**2026 development:** Letta is introducing "Context Repositories" -- a rebuild based on programmatic context management and git-based versioning. Memory becomes version-controlled.

### 6.5 LangGraph: State Management & Checkpointing

LangGraph implements context persistence through:

**Short-term memory:** Thread-scoped state persisted via checkpointers (InMemorySaver, SqliteSaver, PostgresSaver, RedisSaver). Every state transition is checkpointed, enabling time-travel debugging.

**Long-term memory:** Persistent stores shared across conversational threads. Scoped to custom namespaces, not just thread IDs. The namespace hierarchy pattern: `["project", name, "facts"]`.

**Reducer-driven state:** TypedDict schemas with Annotated types model complex workflow contexts. The centralized state acts as shared memory accessible to all graph nodes.

### 6.6 Zep: Temporal Knowledge Graphs

Zep introduced temporal knowledge graph architecture for agent memory, addressing the temporal dimension that vector stores alone miss. Knowledge is stored as graph relationships with temporal metadata, enabling queries like "what did the user believe about X before learning Y?"

---

## 7. Context Routing for Multi-Agent Systems

### 7.1 Google ADK: Scoped Context Handoffs

ADK enforces strict context scoping between agents through two patterns:

**Agents as Tools:** Specialized agents receive only focused prompts and necessary artifacts -- no ancestral history. The parent agent calls the child like a tool, passing minimal context and receiving a condensed response.

**Agent Transfer:** Full control handoff with configurable context inclusion via `include_contents` knobs. The framework controls exactly what history transfers.

### 7.2 Narrative Casting (ADK)

When transferring context between agents, ADK performs "narrative casting" -- reframing prior assistant messages to prevent the new agent from misattributing prior actions to itself.

Without this, Agent B receiving Agent A's conversation history would think it performed Agent A's actions, leading to confusion about its own capabilities and state. Narrative casting rewrites "I searched for X and found Y" to "The previous agent searched for X and found Y."

### 7.3 Sub-Agent Context Isolation (Anthropic)

Specialized sub-agents handle focused tasks with clean context windows; the main agent coordinates the high-level plan:

- Each sub-agent explores extensively (10,000+ tokens internally)
- Returns a condensed summary (1,000-2,000 tokens)
- Achieves clear separation of concerns

This pattern showed **substantial improvement over single-agent systems** on complex research tasks.

### 7.4 Codified Context Infrastructure (arXiv 2602.20478)

A three-tier system for organizing project knowledge across multi-agent architectures:

**Tier 1 -- Hot Memory (~660 lines):** Concise constitution loaded in every session. Establishes conventions, naming standards, orchestration protocols.

**Tier 2 -- Domain Specialists (~9,300 lines across 19 agents):** Specialized agent specifications embedding project-specific expertise. Over 50% of content is domain knowledge rather than behavioral instructions -- contradicting brevity-optimization trends.

**Tier 3 -- Cold Memory (~16,250 lines across 34 documents):** On-demand knowledge retrievable via MCP search tools.

**Key finding:** This architecture supported a single developer building a 108,000-line C# distributed system across 283 sessions. Trigger tables automatically route tasks to appropriate specialists based on modified file patterns.

**Primary failure mode:** Specification staleness. Outdated documentation misled agents into generating code conflicting with recent architecture changes.

### 7.5 Artifact Management (ADK)

Large binary or textual data is managed separately by an ArtifactService, referenced by name rather than embedded in prompts. Agents access artifacts via `LoadArtifactsTool` only when needed -- the artifact metadata is in context but the content is not, until explicitly requested.

---

## 8. Production Trade-offs & Honest Difficulties

### 8.1 Context Rot

**The problem:** As conversations lengthen, accumulated false starts, exploratory rabbit holes, and stale tool outputs create "noisy" context that reduces coherence. Transformer architecture enables n-squared pairwise token relationships; as length increases, the model's ability to capture these relationships gets stretched thin.

**Not a cliff, a gradient:** Models remain capable at longer contexts but show reduced precision for information retrieval and long-range reasoning. The "needle-in-a-haystack" benchmarks reveal this clearly.

**Mitigations:**
- Regular context pruning and fresh summaries at phase boundaries
- Explicit phase boundaries marking historical vs current work
- Deliberate context reset at natural task boundaries
- Anthropic's Algorithm v3.5.0 pattern: "if accumulated tool outputs and reasoning exceed ~60% of working context, self-summarize before proceeding"

### 8.2 The Artifact Tracking Problem

All compression methods score poorly (2.19-2.45 out of 5.0) on file tracking. When agents modify files across many turns, compression loses track of which files were modified, what state they are in, and which changes matter.

**Current best practice:** Maintain a separate artifact index outside of the main compression pipeline. Factory's "anchored iterative summarization" with dedicated file sections helps, but the problem remains unsolved.

### 8.3 Error Trace Preservation (Manus)

Counter-intuitive finding: "Leave the wrong turns in the context." Preserving failed actions and error traces helps models implicitly update beliefs and avoid repetition. Cleaning up errors from context removes valuable signal.

Error recovery is underrepresented in benchmarks despite being "the clearest indicator of true agentic behavior."

### 8.4 Few-Shot Brittleness

Structured variation in actions/observations (different serialization templates, alternate phrasing, minor formatting noise) prevents agents from pattern-matching into brittle behaviors. If all your examples look identical, the agent will rigidly follow that pattern even when the situation calls for deviation.

### 8.5 The "Tokens Per Task" vs "Tokens Per Request" Tension

Optimizing compression per-request (minimize tokens in each API call) can increase total tokens per-task (the agent re-fetches information that was compressed away). The correct optimization target is total cost to complete the task, not cost per individual call.

### 8.6 Tool Count Degradation

The Berkeley Function-Calling Leaderboard shows models perform worse with excessive tools. A quantized Llama 3.1 8B model fails completely with 46 tools but succeeds with 19. Even frontier models show degradation. XML tool descriptions are more token-efficient than JSON (12-Factor Agent recommendation).

### 8.7 Summarization Trajectory Elongation

LLM summarization causes agents to take 13-15% more steps to complete tasks. Working from summaries rather than raw context, agents explore more cautiously and redundantly -- they compensate for reduced confidence in their understanding of prior state.

---

## 9. Implications for PAI

### 9.1 Current PAI Context Architecture

PAI's context system (ContextBuilder, MemoryStore, HandoffManager) already implements several patterns identified as state-of-the-art:

- **SQLite-backed memory with FTS5:** Matches the recommended lightweight hybrid search pattern
- **Episodic + semantic memory types:** Aligns with the production taxonomy
- **Context token budget (CONTEXT_MAX_TOKENS):** Implements budgeting
- **Feature flags for gradual rollout:** Matches production deployment best practices
- **Handoff for cross-instance state:** Addresses the context continuity problem

### 9.2 Specific Improvements Suggested by Research

**KV-Cache Optimization (from Manus):**
- Audit system prompt for timestamps or dynamic content that breaks cache
- Ensure deterministic JSON serialization in ContextBuilder output
- Place static instructions before dynamic memory injection
- The 100:1 input/output ratio applies to PAI pipeline tasks -- context optimization has outsized cost impact

**Observation Masking (from JetBrains):**
- For pipeline tasks averaging ~50 tool calls, implement observation masking as the primary compression
- Keep latest N turns of tool output intact, replace older observations with placeholders
- This is simpler and more effective than LLM summarization for most cases

**Two-Threshold Compression (from Factory.ai):**
- Implement T_max / T_retained gap for the bridge conversation context
- Use anchored iterative summarization with dedicated sections for files and decisions
- Maintain separate artifact index for file tracking (the unsolved problem)

**Structured Note-Taking (from Anthropic):**
- PAI's todo.md pattern in the Algorithm already does this
- Extend to pipeline tasks: agents writing structured notes that persist outside context window
- The Manus "recitation mechanism" (writing and reading todo.md) pushes global plans into recent attention

**Tiered Context (from Codified Context paper):**
- PAI's CLAUDE.md / CLAUDE.local.md / MEMORY.md three-file system maps cleanly to the three-tier model
- CLAUDE.md = Hot Memory (loaded every session)
- CLAUDE.local.md = Domain State (session-specific)
- MEMORY.md = Warm Memory (operational knowledge)
- Consider adding explicit Cold Memory tier via MCP or tool-based retrieval

**Agent Handoff Narrative Casting (from ADK):**
- When handing off between local and cloud Isidore, or between Isidore and Gregor, reframe prior assistant messages
- Prevent receiving agent from misattributing prior agent's actions to itself

**Cache-Friendly Prompt Structure:**
- ContextBuilder should emit memory in a deterministic order after the system prompt
- Session-specific content (current message, recent history) should come last
- This maximizes Anthropic's 90% cached token discount

### 9.3 Architecture Alignment

PAI's existing architecture maps well to the ADK four-layer model:

| ADK Layer | PAI Equivalent | Status |
|-----------|---------------|--------|
| Working Context | System prompt + ContextBuilder output | Implemented |
| Session | SessionManager + conversation history | Implemented |
| Memory | MemoryStore (FTS5 + optional vectors) | Implemented, flags off |
| Artifacts | File system (project files, PRDs) | Implicit, not formalized |

The main gap is the Artifact layer -- PAI does not have explicit artifact management (reference by name, load on demand). The file system serves this role implicitly, but a formal ArtifactService could improve context efficiency for pipeline tasks working across many files.

---

## 10. Sources

### Primary Sources (Deep-Dived)

1. [Anthropic: Effective Context Engineering for AI Agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) -- Anthropic's production guide covering system prompts, just-in-time retrieval, compaction, sub-agents, and context rot.

2. [Manus: Context Engineering for AI Agents -- Lessons from Building Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus) -- Production lessons from Manus including KV-cache optimization, action space management, error trace preservation, and the todo.md attention manipulation pattern.

3. [Google Developers Blog: Architecting Efficient Context-Aware Multi-Agent Framework for Production](https://developers.googleblog.com/architecting-efficient-context-aware-multi-agent-framework-for-production/) -- Google ADK architecture with tiered storage, compiled views, pipeline processing, narrative casting, and artifact management.

4. [JetBrains Research: Cutting Through the Noise -- Smarter Context Management for LLM-Powered Agents](https://blog.jetbrains.com/research/2025/12/efficient-context-management/) -- Observation masking vs LLM summarization benchmarks on SWE-bench Verified (500 instances).

5. [Factory.ai: Compressing Context](https://factory.ai/news/compressing-context) -- Two-threshold compression system (T_max/T_retained), anchored iterative summarization, and the "tokens per task" principle.

6. [Factory.ai: Evaluating Context Compression](https://factory.ai/news/evaluating-compression) -- Probe-based evaluation framework across 36,611 production messages. Factory vs Anthropic vs OpenAI comparison.

7. [ACON: Optimizing Context Compression for Long-Horizon LLM Agents (arXiv 2510.00615)](https://arxiv.org/html/2510.00615v1) -- Natural language feedback optimization for compression guidelines. 26-54% token reduction.

8. [Don't Break the Cache: Evaluation of Prompt Caching for Long-Horizon Agentic Tasks (arXiv 2601.06007)](https://arxiv.org/html/2601.06007v1) -- 500+ agent session benchmark comparing caching strategies across GPT-4o, Claude Sonnet 4.5, Gemini 2.5 Pro.

9. [Codified Context: Infrastructure for AI Agents in a Complex Codebase (arXiv 2602.20478)](https://arxiv.org/html/2602.20478v1) -- Three-tier context infrastructure supporting 108K-line codebase across 283 sessions.

### Origin & Framing Sources

10. [Andrej Karpathy on X (June 2025)](https://x.com/karpathy/status/1937902205765607626) -- The "+1 for context engineering" statement.

11. [Simon Willison: Context Engineering (June 2025)](https://simonwillison.net/2025/jun/27/context-engineering/) -- Why the term will stick.

12. [Addyo/O'Reilly: Context Engineering -- Bringing Engineering Discipline to Prompts](https://addyo.substack.com/p/context-engineering-bringing-engineering) -- The LLM-as-CPU / context-as-RAM mental model.

### Framework Sources

13. [MemGPT/Letta: Virtual Context Management](https://www.leoniemonigatti.com/blog/memgpt.html) -- Tiered memory architecture, self-editing memory blocks.

14. [LangGraph State Management (2025)](https://sparkco.ai/blog/mastering-langgraph-state-management-in-2025) -- Reducer-driven state, checkpointing, thread-scoped vs cross-thread memory.

15. [12-Factor Agents (GitHub)](https://github.com/humanlayer/12-factor-agents) -- Production patterns including explicit context management, stateless agent design, XML over JSON for token efficiency.

16. [Leonie Monigatti: From RAG to Agent Memory](https://www.leoniemonigatti.com/blog/from-rag-to-agent-memory.html) -- The evolution narrative from read-only retrieval to read-write agent memory.

17. [Maxim.ai: Context Engineering for AI Agents -- Token Economics](https://www.getmaxim.ai/articles/context-engineering-for-ai-agents-production-optimization-strategies/) -- Token budget allocation framework with specific percentages.

---

*Research conducted using multi-perspective analysis across 8 parallel search angles and 12 deep-dive source investigations. Perspectives balanced: framework vendor (Anthropic, Google, LangChain), independent research (JetBrains, Factory.ai, academic), practitioner (Manus, 12-Factor Agent, Codified Context), and community thought leadership (Karpathy, Willison).*
