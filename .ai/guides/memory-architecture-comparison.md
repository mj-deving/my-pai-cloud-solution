# Memory Architecture Comparison — DAI Cloud vs Gregor (OpenClaw + PARA)

> Reference doc comparing the two memory systems running on the same VPS.
> Written 2026-03-07. Updated to reflect Gregor's PARA deployment (GUIDE.md Phase 10.7).

---

## Philosophy

**DAI Cloud (Isidore)** treats memory as a **curated knowledge base** — importance matters, synthesis is explicit, projects are isolated. Episodic memory is primary; knowledge is derivative. SQL-first.

**Gregor (OpenClaw + PARA)** treats memory as a **structured file system** — PARA categories organize by actionability, three cron tiers consolidate over time, and the FadeMem pattern lets unimportant facts decay naturally through file aging. Markdown-first.

---

## Schema

### DAI Cloud (Normalized SQL)

```sql
-- Episodic memory (raw conversations)
CREATE TABLE episodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  source TEXT NOT NULL,            -- "telegram", "pipeline", "synthesis"
  project TEXT,                    -- nullable, project scope
  session_id TEXT,
  role TEXT NOT NULL,              -- "user", "assistant", "system"
  content TEXT NOT NULL,
  summary TEXT,
  metadata TEXT,                   -- JSON
  importance INTEGER DEFAULT 5,   -- 0-10
  access_count INTEGER DEFAULT 0,
  last_accessed TEXT
);

-- Distilled knowledge (derivative)
CREATE TABLE knowledge (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL,            -- "pipeline", "orchestrator", "system"
  key TEXT NOT NULL,               -- kebab-case identifier
  content TEXT NOT NULL,           -- 1-3 sentence facts
  confidence REAL DEFAULT 0.5,
  source_episode_ids TEXT,         -- JSON array
  expires_at TEXT,
  UNIQUE(domain, key)
);

-- Full-text search
CREATE VIRTUAL TABLE episodes_fts USING fts5(content, summary, content=episodes, content_rowid=id);

-- Optional vector search
CREATE VIRTUAL TABLE episode_embeddings USING vec0(episode_id INTEGER PRIMARY KEY, embedding float[768]);
```

### Gregor (Flat Chunks + PARA Directory Overlay)

**Base layer:** memory-core chunks (~400 tokens, 80 overlap) + embeddings (float[384]) in SQLite. Indexed via `memory/**/*.md` recursive glob.

**PARA overlay:**
```
~/.openclaw/workspace/memory/
  daily/              # Raw daily logs — HOT tier
    2026-03-07.md
  projects/           # Active goals with deadlines — HOT tier
    openclaw-bot.md
    supercolony.md
  areas/              # Ongoing responsibilities — WARM tier
    vps-ops.md
    security.md
  resources/          # Reference material — WARM tier
    provider-pricing.md
    cli-patterns.md
  archive/            # Completed/inactive — COLD tier
    2026-02/
      2026-02-summary.md
  meta/               # Consolidation state & scoring
    importance-scores.json
    consolidation-state.json
```

No episode/knowledge split at the DB level — PARA categories provide the semantic separation via file structure.

---

## Write Path

### DAI Cloud: Explicit `memory.record()`

```
Message arrives → ClaudeInvoker processes → ModeManager logs
  → MemoryStore.record(episode)
    → Insert to episodes (timestamp, role, content, importance=5)
    → FTS5 triggers auto-index
    → If embeddings available: embed + store in vec0
    → Prune if over maxEpisodes (protect importance >= 8)
```

Sources: `"telegram"`, `"pipeline"`, `"synthesis"`, `"session_summary"`

### Gregor: Auto-Capture + PARA Routing

```
Message arrives → LLM processes → post-response hook fires
  → Auto-capture: extract memories from conversation
  → Pre-compaction flush: write lasting notes to memory/daily/YYYY-MM-DD.md
  → memory-core indexes all memory/**/*.md via recursive glob

Nightly cron (3AM):
  → Read today's daily file
  → Extract and route facts to PARA categories:
    → Active project updates → memory/projects/<name>.md
    → Operational learnings → memory/areas/<name>.md
    → Reference facts → memory/resources/<name>.md
  → Deduplicates against existing content before appending
```

Two-stage write: immediate capture to daily files, then nightly cron routes to structured PARA files.

---

## Read Path & Scoring

### DAI Cloud: Composite Scored Query

Three-way blend:
```
score = 0.4 × recency + 0.3 × importance + 0.3 × relevance

recency    = 0.995^(hours_since)     // half-life ≈ 5.75 days
importance = episode.importance / 10  // normalized 0-1
relevance  = 1 / (1 + |fts_rank|)    // inverse FTS rank
```

Retrieval: FTS5 keyword search (OR semantics) → fetch 3× candidates → score → top N within token budget.

Optional: vector search via sqlite-vec when available, graceful fallback to FTS5.

### Gregor: Hybrid Search + MMR + Temporal Decay

```
finalScore = 0.7 × vectorScore + 0.3 × textScore

vectorScore: cosine similarity from embeddinggemma-300m (384-dim, local)
textScore:   normalized BM25 rank
```

Post-processing pipeline:
1. **Candidate pool**: 4× maxResults candidates from both indexes
2. **MMR deduplication** (lambda=0.7): prevents redundant chunks
3. **Temporal decay**: `score × 0.5^(age_days / 30)` — 30-day half-life
4. **Min score threshold**: drop results < 0.35
5. **Max results**: 6 (default)

PARA files searched identically — the recursive glob `memory/**/*.md` covers all subdirectories. No special handling per category.

---

## Context Injection

### DAI Cloud: Budget-Allocated, Topic-Aware

```
Total budget split across 4 components:
  Whiteboard:      20%  — running project state summary
  Knowledge:       20%  — distilled facts from synthesis
  Episodes:        30%  — recent relevant conversations
  Session Summary: 30%  — previous session wrapup

Topic tracking:
  Extract keywords → Jaccard similarity with previous topic
  If < 0.3 → new topic → invalidate cached snapshot
  Snapshot frozen for 5 min or until topic shift

Importance masking:
  importance >= 7: full content injected
  importance <  7: summary only (first 80 chars)
```

### Gregor: Brute-Force Bootstrap + Memory Search

```
Every message:
  Inject ALL workspace files (CLAUDE.md, etc.) up to 150K chars
  No caching/snapshot — re-injected every turn
  Enables Anthropic prompt caching (byte-identical prefix = 10% cost)

Memory retrieval:
  Top 6 chunks by hybrid search score
  Searches across ALL PARA directories via recursive glob
  Separate from bootstrap injection
```

---

## Knowledge Distillation

### DAI Cloud: Active SynthesisLoop

```
Periodic scheduled run (policy-gated):
  1. Fetch episodes since lastSynthesizedId
  2. Group by source domain
  3. For each domain with enough episodes:
     → Call Claude one-shot: extract patterns from episode batch
     → Parse JSON: [{key, content, confidence}, ...]
     → Write to knowledge table (deduplicated by domain/key)
  4. Generate per-project whiteboards (status, activity, decisions, blockers)
  5. Update lastSynthesizedId
```

Knowledge has **lineage** (source_episode_ids) and **confidence** scores. Single-tier, on-demand.

### Gregor: 3-Tier Cron Consolidation (FadeMem Pattern)

**Two distillation layers:**

**Layer 1 — Implicit:** Pre-compaction flush writes lasting notes to `memory/daily/YYYY-MM-DD.md` when context nears ~88% capacity.

**Layer 2 — Explicit 3-tier cron pipeline:**

| Cron | Schedule | Model | What it does | Cost |
|------|----------|-------|-------------|------|
| **Nightly** | `0 3 * * *` | Haiku | Extract today's daily → route to projects/, areas/, resources/ | $0.90/mo |
| **Weekly** | `0 3 * * 0` (Sun) | Haiku | Deduplicate PARA files, update importance scores, archive stale entries | $0.20/mo |
| **Monthly** | `0 3 1 * *` | Haiku | Compress daily files >90 days old into archive/YYYY-MM-summary.md | $0.08/mo |

**Total consolidation cost: $1.18/month**

**FadeMem mechanism** (no code changes needed):
- **Important facts** get consolidated forward by nightly/weekly crons → file mtime resets → stays "fresh" to the 30-day temporal decay
- **Unimportant facts** are never re-touched → mtime ages → temporal decay naturally deprioritizes them
- Result: mimics FadeMem research (Jan 2026) — 82.1% critical fact retention at 55% storage

---

## Pruning & Retention

### DAI Cloud: Importance-Based

```
IF episode_count > maxEpisodes:
  DELETE lowest-scoring episodes
  WHERE importance < 8
  ORDER BY (importance × recency_factor) ASC
```

- Importance >= 8: **never pruned** (hard guarantee)
- No time-based expiry — only capacity-based
- Access count tracked (not yet used in pruning)

### Gregor: TTL + Temporal Decay + Importance Scoring

**Context pruning** (in-session):
```
cache-ttl mode, 2h TTL for tool results
Keep last 8 assistant messages always
```

**Memory pruning** (cron-driven):
```
Weekly synthesis scores all PARA entries:
  score = recency (40%) + reference_frequency (30%) + cross_reference_count (30%)
  Range: 0.0 — 1.0

Important facts (high score):
  → Consolidated forward by crons, mtime reset, stays fresh
  → Survives 30-day temporal decay indefinitely

Unimportant facts (low score):
  → Never re-touched, mtime ages
  → Temporal decay naturally deprioritizes in search
  → Monthly cron compresses 90d+ dailies into archive summaries
```

Scores tracked in `meta/importance-scores.json`:
```json
{
  "version": 1,
  "scores": {
    "projects/openclaw-bot.md": {
      "overall": 0.92,
      "recency": 0.95,
      "reference_frequency": 0.87,
      "cross_reference_count": 0.91
    }
  }
}
```

**DB-level cleanup:**
- Session chunks > 14 days → deleted
- Embedding cache > 30 days → deleted

---

## Embeddings

| Aspect | DAI Cloud | Gregor |
|--------|-----------|--------|
| Model | Pluggable (EmbeddingProvider interface) | embeddinggemma-300m (local) |
| Dimensions | 768 | 384 |
| Storage | sqlite-vec (vec0) | sqlite-vec or LanceDB |
| Required? | No — graceful FTS5 fallback | Yes — core to hybrid search |
| Cache | None | JSON text cache (~19KB/entry) |
| Indexing | On write (per-episode) | Delta sync (only changed chunks) |
| Chunking | Per-episode (no chunking) | ~400 tokens, 80 overlap, semantic boundaries |

---

## Unique Features

### DAI Cloud Has, Gregor Doesn't

| Feature | Why it matters |
|---------|---------------|
| Explicit importance scoring (0-10) per episode | User controls what persists forever at record time |
| Domain-scoped synthesis | Grouped distillation prevents cross-domain noise |
| Project-scoped SQL queries | Filter episodes by project in a single query |
| Budget-allocated injection | Controlled per-component, prevents any one source dominating |
| Topic-drift detection | Jaccard similarity invalidates stale context snapshots |
| Access count tracking | Knows which memories get retrieved most |
| Knowledge table with confidence + lineage | Structured derivative knowledge with source tracking |
| Session summary episodes | Explicit wrapup context as first-class data |

### Gregor Has, DAI Cloud Doesn't

| Feature | Why it matters |
|---------|---------------|
| PARA directory structure | Semantic organization by actionability (projects/areas/resources/archive) |
| 3-tier cron consolidation | Nightly extract, weekly dedupe+score, monthly archive — automated lifecycle |
| FadeMem pattern | Important facts stay fresh via consolidation, unimportant decay naturally — no explicit delete |
| Importance scoring via cron (recency 40% + ref freq 30% + cross-ref 30%) | File-level importance with automatic scoring |
| MMR diversity ranking | Prevents redundant retrievals |
| Temporal decay in search (30-day half-life) | Old memories naturally lose relevance |
| Chunking with overlap | Preserves semantic context at boundaries |
| Delta sync indexing | Only re-embed changed chunks — faster |
| Anthropic prompt caching | Byte-identical system prompt = 10% cost on reads |
| Auto-capture (no explicit record call) | Zero-effort memory recording |
| Compaction safeguard | Prevents destructive context thrashing loops |
| Human-readable markdown files | Browse memory with any text editor, version with git |
| Archive summaries | Monthly compression of 90d+ dailies — 80.5% size reduction |

---

## Operational Comparison

| Dimension | DAI Cloud | Gregor |
|-----------|-----------|--------|
| **Schema** | Normalized SQL (episodes + knowledge) | Flat chunks + PARA directory overlay |
| **Organization** | By source domain (in SQL) | By actionability (PARA categories) |
| **Write trigger** | Explicit `memory.record()` | Auto-capture hook + PARA routing cron |
| **Knowledge creation** | SynthesisLoop: Claude distills from episode batch | 3-tier cron: nightly extract, weekly dedupe, monthly archive |
| **Pruning** | Importance-based (>= 8 protected, capacity-gated) | TTL + temporal decay + FadeMem (important facts consolidated forward) |
| **Importance scoring** | User-set per-episode (0-10) | Cron-computed per-file (recency 40% + ref freq 30% + cross-ref 30%) |
| **Context caching** | Topic-based snapshot (5 min TTL) | Prompt caching (Anthropic API level) |
| **Search** | FTS5 + optional vector | Hybrid: BM25 (0.3) + vector (0.7) + MMR + decay |
| **Decay** | Scoring-based (0.995^hours ≈ 5.75d half-life) | Temporal (30-day half-life) + FadeMem consolidation |
| **Deduplication** | Via synthesis (existing knowledge check) | Via MMR at retrieval + weekly cron dedupe |
| **Cross-project** | SQL filter by project column | PARA: separate files per project in projects/ |
| **Whiteboards** | Auto-generated per-project in knowledge table | PARA category files serve as persistent whiteboards |
| **Human-readable** | memory.db (requires SQL) | Markdown files (browsable, git-trackable) |
| **Consolidation cost** | Claude one-shot per synthesis run | $1.18/month (Haiku crons) |
| **Lifecycle** | Record → synthesize → prune | Daily → nightly route → weekly score → monthly archive |

---

## Key Gotchas

**DAI Cloud:**
- FTS5 uses OR semantics — partial matches recovered
- Recency decay is per-hour (0.995^hours), not per-day
- Access count tracked but not yet used in pruning/scoring
- No explicit embedding model requirement — can run FTS5-only

**Gregor:**
- `updated_at` is epoch in **milliseconds**, not seconds — DELETE queries must multiply by 1000
- Embedding cache stored as JSON text (3x size vs binary BLOB) — causes DB bloat
- TTL + keepLastAssistants too aggressive → compaction loop
- Prompt caching requires byte-identical system prompt (no dynamic timestamps)
- PARA directories must exist before crons run — init via `mkdir -p daily projects areas resources archive meta`
- After PARA init, must rebuild memory index: `openclaw memory index --force`
- Daily files moved from `memory/` root to `memory/daily/` — flush prompt must reference `memory/daily/`
