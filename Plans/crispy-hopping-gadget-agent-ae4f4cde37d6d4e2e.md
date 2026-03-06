# AI Agent Memory Architecture: Actionable Patterns & Specific Techniques

Research compiled 2026-03-03 for PAI Cloud Solution memory system.

---

## 1. Episodic vs Semantic Memory

### Storage Pattern (CoALA Framework / Industry Consensus)

| Layer | What it stores | Where | Lifecycle |
|-------|---------------|-------|-----------|
| **Working memory** | Current conversation, extracted constraints, intermediate tool results | Context window (ephemeral) | Dies with session |
| **Episodic memory** | Timestamped events: "user asked X, agent did Y, result was Z" | SQLite rows with timestamps | Decays, summarizable |
| **Semantic memory** | Distilled facts: "user prefers TypeScript", "project uses Bun" | SQLite rows (domain/key) | Stable, versioned |
| **Procedural memory** | System prompts, guidelines, tool definitions | Markdown files on disk | Manual updates |

### Promotion Pattern: Episodes to Knowledge

No industry-standard automatic trigger exists. Best observed patterns:

- **Mem0 approach**: LLM-powered extraction after every message pair. Processes (message_t-1, message_t) plus conversation summary S plus last m=10 messages. LLM decides ADD/UPDATE/DELETE/NOOP against existing memories.
- **Synthesis loop approach** (your current pattern): Periodic batch -- collect episodes by domain, run LLM synthesis, write to semantic store. Skip domains with < 3 episodes (your current SYNTHESIS_MIN_EPISODES).
- **Stanford Generative Agents**: Reflection triggers when sum of importance scores for recent events exceeds 150. Agents reflected ~2-3 times per simulated day.

**Actionable**: Your synthesis loop is already the right pattern. The key improvement would be adding importance scoring to episodes so you can trigger synthesis on importance-sum thresholds rather than just count thresholds.

---

## 2. Conversation Continuity Across Sessions

### Technique 1: Running Summary (Recommended for CLI agents)

- Keep last N raw messages + a rolling summary of everything before them
- **Letta/MemGPT**: When context approaches window limit, evict ~70% of oldest messages, recursively summarize them with existing summary
- **Practical trigger**: Summarize every ~10 messages, or when message buffer exceeds a token threshold (e.g., 4000 tokens of raw messages)
- Older messages have progressively less influence on recursive summaries -- this is acceptable and intended

### Technique 2: Memory Extraction Per Turn (Mem0 Pattern)

- After each turn pair, extract candidate memories using LLM
- Compare candidates against top s=10 semantically similar existing memories
- Apply ADD/UPDATE/DELETE/NOOP via LLM function-calling
- Store as natural language facts (not raw conversation)
- **Result**: 90% token savings, 91% lower p95 latency vs full-context (1.44s vs 17.1s)

### Technique 3: Observational Memory (Compression-First)

- Two background agents: Observer (compresses conversation into dated observations) and Reflector (distills patterns)
- Compressed observations stay in context -- eliminates retrieval entirely
- Text content: 3-6x compression. Tool-heavy workloads: 5-40x compression
- **Cost reduction**: ~10x vs raw context approaches

### What to Use for PAI Cloud

Your ContextBuilder already does memory injection. The gap is conversation-level continuity. Pattern:
1. Store a running summary in memory.db (episodic, domain="session_summary", key=session_id)
2. On session start, inject: running summary + last N episodes + relevant semantic memories
3. After every ~10 turns (or token threshold), update the running summary via LLM

---

## 3. Context Window Management

### Budget Allocation (Synthesized from Multiple Sources)

No single standard exists, but this allocation pattern appears across Letta, Mem0, and production systems:

| Component | Budget % | Notes |
|-----------|----------|-------|
| System prompt + procedural | 15-25% | Fixed cost, compress aggressively |
| Semantic memories (facts) | 10-15% | Most stable, highest value per token |
| Episodic memories (recent) | 10-15% | Recency-weighted selection |
| Running conversation summary | 5-10% | Lossy but consistent |
| Current conversation (raw) | 40-50% | The actual work happening now |
| Tool results / scratch | remainder | Ephemeral |

### Relevance Scoring: The Stanford Formula (Battle-Tested)

```
score = alpha_recency * recency + alpha_importance * importance + alpha_relevance * relevance
```

- All alpha values = 1 (equal weighting, normalize each component to [0,1] via min-max)
- **Recency**: Exponential decay with factor 0.995 per time-unit since last access
- **Importance**: 1-10 integer assigned at creation time (LLM rates "poignancy": 1 = brushing teeth, 10 = major life event)
- **Relevance**: Cosine similarity between query embedding and memory embedding

### Practical Retrieval for SQLite Without Full Vector DB

**Hybrid search pipeline** (from production implementations):

1. FTS5 keyword search first (fast, precise)
2. Embedding cosine similarity second (slower, fuzzy)
3. Merge via Reciprocal Rank Fusion: `RRF(d) = sum(1 / (k + rank(d)))` where k=60
4. Final score: `vectorWeight * vectorScore + textWeight * textScore`
   - Default weights: vector 0.7, text 0.3
   - minScore threshold: 0.35
   - maxResults: 6
   - candidateMultiplier: 4 (fetch 4x more candidates than needed, then re-rank)

### "Lost in the Middle" Effect

Relevant information placed in the middle of context suffers 30%+ performance drop. Place high-importance memories at the START or END of the context injection block.

---

## 4. SQLite-Specific Patterns

### Schema Pattern (Composite from Multiple Sources)

```sql
-- Episodes table
CREATE TABLE episodes (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    domain TEXT NOT NULL,
    timestamp REAL NOT NULL,
    importance INTEGER DEFAULT 5,  -- 1-10 scale
    access_count INTEGER DEFAULT 0,
    last_accessed REAL,
    trust_score REAL DEFAULT 1.0,
    metadata TEXT DEFAULT '{}',
    embedding BLOB  -- raw float32 array, nullable
);

-- FTS5 index (zero-config keyword search)
CREATE VIRTUAL TABLE episodes_fts USING fts5(
    id, content, domain,
    content=episodes, content_rowid=rowid
);

-- Semantic/knowledge table
CREATE TABLE knowledge (
    id TEXT PRIMARY KEY,
    domain TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    version INTEGER DEFAULT 1,
    parent_id TEXT,  -- previous version
    superseded INTEGER DEFAULT 0,
    timestamp REAL NOT NULL,
    UNIQUE(domain, key)
);
```

### FTS5 Optimization

- FTS5 handles stemming, phrase matching, and BM25 ranking out of the box
- BM25 scores are negative (lower = better match) -- invert for combination with other scores
- Use `bm25(episodes_fts)` rank function
- Normalize: `textScore = 1 / (1 + max(0, bm25Rank))`

### Embedding Storage Without Vector DB

Two options:
1. **sqlite-vec extension**: Store embeddings as BLOB in same DB, query with cosine similarity. Works with `nomic-embed-text` via Ollama (384 dimensions).
2. **In-memory dictionary fallback**: Load embeddings into memory map on startup. Works for < 100k memories at 384 dimensions (~150MB RAM).
3. **FTS5-only fallback**: If no embedding provider, use keyword search only. Your current approach.

### Graceful Degradation

If embedding provider returns zero vector, use only keyword results. If FTS5 unavailable, use only vector results. Always have a working fallback path.

---

## 5. Memory Lifecycle

### Importance Scoring at Creation

- **Stanford method**: LLM assigns 1-10 at memory creation. Prompt: "On a scale of 1 to 10, where 1 is purely mundane and 10 is extremely poignant, rate the likely poignancy of the following memory."
- **Trust scoring** (production pattern):
  ```
  score = 0.5 (base)
        + 0.3 if verified
        + 0.1 if < 7 days old
        + min(0.1 * corroboration_count, 0.2)
  cap at 1.0
  ```

### Decay Function

- **Exponential decay**: `recency = 0.995 ^ hours_since_last_access`
- **Access reinforcement**: Each retrieval resets the last_accessed timestamp
- **MongoDB pattern defaults**: decay_factor=0.99 per period, reinforcement_factor=1.1 per access

### Pruning Strategy

| Condition | Action |
|-----------|--------|
| Not accessed in 90 days AND trust_score < 0.5 | Archive or delete |
| Superseded by newer version (knowledge table) | Mark superseded=1, keep for history |
| Importance < 3 AND age > 30 days AND access_count < 2 | Candidate for pruning |
| Contradicted by newer memory | DELETE (Mem0 pattern) or mark invalidated |

### Memory Operations (Mem0 Lifecycle)

Every new piece of information goes through:
1. **Extract**: LLM identifies candidate facts from conversation
2. **Search**: Find top-10 semantically similar existing memories
3. **Decide**: LLM chooses operation via function-calling:
   - ADD: No semantic equivalent exists
   - UPDATE: Complementary information for existing memory
   - DELETE: Contradicts existing memory
   - NOOP: Already known, no change needed
4. **Execute**: Apply the operation atomically

### Consolidation / Synthesis

- **Trigger options**: Importance-sum threshold (150 in Stanford), episode count threshold (3+ in your synthesis loop), time-based (every N hours)
- **Process**: Gather recent episodes for domain, LLM synthesizes into knowledge entries
- **Key insight**: Reflections/synthesis outputs themselves become memories with high importance scores, creating a hierarchy

---

## Summary of Key Numbers

| Parameter | Value | Source |
|-----------|-------|--------|
| Recency decay factor | 0.995 per hour | Stanford Generative Agents |
| Importance scale | 1-10 integer | Stanford Generative Agents |
| Reflection trigger | importance sum > 150 | Stanford Generative Agents |
| Recent message window | m=10 messages | Mem0 |
| Similar memory retrieval | top s=10 | Mem0 |
| Message eviction ratio | ~70% of oldest | Letta/MemGPT |
| Summarize trigger | every ~10 messages | Industry practice |
| RRF constant k | 60 | Standard RRF |
| Hybrid search weights | vector 0.7, text 0.3 | Production implementations |
| Min relevance score | 0.35 | Production implementations |
| Max retrieval results | 6 | Production implementations |
| Candidate multiplier | 4x | Production implementations |
| Prune threshold: age | 90 days + trust < 0.5 | MongoDB AI Memory |
| Decay factor (alt) | 0.99 per period | MongoDB AI Memory |
| Reinforcement factor | 1.1 per access | MongoDB AI Memory |
| Similarity threshold | 0.7 (for reinforcement) | MongoDB AI Memory |
| Token savings (memory vs full) | 90%+ | Mem0 |
| Compression (observational) | 3-6x text, 5-40x tool-heavy | Observational Memory |
| Working memory capacity | 128K-1M tokens | Current models |
| Lost-in-middle penalty | 30%+ perf drop | Multiple studies |
| Memory summary target | ~50 tokens per entry | EchoVault |

---

## Sources

- [Generative Agents: Interactive Simulacra of Human Behavior (Stanford)](https://ar5iv.labs.arxiv.org/html/2304.03442)
- [Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory](https://arxiv.org/html/2504.19413v1)
- [Agent Memory: How to Build Agents that Learn and Remember (Letta)](https://www.letta.com/blog/agent-memory)
- [AI Agents in 2026: Practical Architecture (Andrii Furmanets)](https://andriifurmanets.com/blogs/ai-agents-2026-practical-architecture-tools-memory-evals-guardrails)
- [Making Sense of Memory in AI Agents (Leonie Monigatti)](https://www.leoniemonigatti.com/blog/memory-in-ai-agents.html)
- [Building a Universal Memory Layer for AI Agents (DEV Community)](https://dev.to/varun_pratapbhardwaj_b13/building-a-universal-memory-layer-for-ai-agents-architecture-patterns-and-implementation-4b5h)
- [Building Local Memory for Coding Agents / EchoVault](https://muhammadraza.me/2026/building-local-memory-for-coding-agents)
- [AI Agent Memory (Morph LLM)](https://www.morphllm.com/ai-agent-memory)
- [MongoDB AI Memory Service](https://github.com/mongodb-partners/ai-memory)
- [Memory for AI Agents: A New Paradigm of Context Engineering (The New Stack)](https://thenewstack.io/memory-for-ai-agents-a-new-paradigm-of-context-engineering/)
- [Observational Memory Cuts AI Agent Costs 10x (VentureBeat)](https://venturebeat.com/data/observational-memory-cuts-ai-agent-costs-10x-and-outscores-rag-on-long)
