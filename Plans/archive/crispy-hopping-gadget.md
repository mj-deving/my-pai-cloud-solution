# Persistence Redesign Plan — Cloud Isidore

## Context

The sync cleanup is **DONE** (commit 76e3040): HandoffManager deleted, knowledge sync removed, cron wrapper gone (~670 lines). `/sync` = git push, `/pull` = git pull, `deploy.sh` handles rsync + git sync.

What remains is the **persistence optimization** — making Cloud Isidore's memory system actually useful for long-running conversational continuity. Current state: 19 episodes, 5 knowledge entries after weeks. FTS5 keyword search only. No importance scoring, no conversation tracking, no session summarization.

Research findings (Mem0 2025, Letta/MemGPT, Stanford Generative Agents, Observational Memory 2026) point to a clear priority order: **record better → retrieve better → continuity → synthesis**.

---

## What Changes

### Phase 1: Record Better (highest impact, lowest effort)

**Problem:** Episodes are raw full messages with no importance scoring and often-null summaries. Long Algorithm output fills the store with noise. When pruning triggers, important memories are lost.

**Files to modify:**
- `src/memory.ts` — add `importance` (INTEGER 1-10), `access_count` (INTEGER), `last_accessed` (TEXT) columns to episodes table
- `src/telegram.ts:750-758` — where `memoryStore.record()` is called for user + assistant episodes; add summary + importance generation
- `src/claude.ts` — add `rateImportance()` method using haiku quickShot (cheap, fast)

**Changes:**
1. **Schema migration** — add 3 columns to episodes table (`importance`, `access_count`, `last_accessed`) with defaults (importance=5, access_count=0, last_accessed=timestamp)
2. **Summary generation at record time** — before recording an assistant episode, use `quickShot` (haiku) to generate a 50-token summary. Cost: ~$0.001 per message. Store in `summary` field.
3. **Importance scoring at record time** — same haiku call rates importance 1-10. Prompt: "Rate poignancy where 1=mundane scheduling, 10=critical decision or insight."
4. **Smart truncation** — for assistant episodes, strip Algorithm formatting/phase headers before storing. Store the substance, not the ceremony. Cap episode content at 1000 chars.
5. **Access tracking** — when `query()` returns episodes, increment `access_count` and update `last_accessed` for each returned row.
6. **Importance-aware pruning** — replace current "delete oldest" with: delete lowest `importance * recency_score` first. Never prune episodes with importance >= 8.

**Success criteria:** Episodes have non-null summaries and importance scores. Pruning preserves high-importance episodes regardless of age.

---

### Phase 2: Retrieve Better (high impact)

**Problem:** Context injection uses a frozen 5-minute snapshot queried by the raw message text. No conversation-level tracking. No recency weighting. No importance weighting. Observation masking is window-based, not importance-based.

**Files to modify:**
- `src/context.ts` — replace frozen snapshot with conversation-aware context building
- `src/memory.ts` — add scored query method

**Changes:**
1. **Scored retrieval** — new `scoredQuery()` method that ranks results by: `score = (0.4 * recency) + (0.3 * importance/10) + (0.3 * fts5_relevance)`. Recency = `0.995 ^ hours_since_creation`. FTS5 relevance = normalized BM25 rank.
2. **Conversation topic tracking** — ContextBuilder maintains a rolling "conversation topic" string (updated by summarizing the last 3-5 message pairs). Snapshot invalidates on topic shift (cosine distance of keyword overlap), not on timer.
3. **Budget-based injection** — allocate context budget: whiteboard (20%), knowledge (20%), recent episodes (30%), conversation summary (30%). Currently it's just "everything until char limit."
4. **Importance-based masking** — replace window-based observation masking. Episodes with importance >= 7 always get full content. Lower-importance episodes get summary-only regardless of position.

**Success criteria:** Context injection varies with conversation topic. High-importance episodes always surface. Budget allocation prevents any one category from starving the others.

---

### Phase 3: Session Continuity (medium impact)

**Problem:** When the bridge restarts or `/clear` is used, conversational context is lost. No summarization happens. Next session starts cold. `handoff-state.json` is a separate file that could be in memory.db.

**Files to modify:**
- `src/session.ts` — add `summarizeAndArchive()` method
- `src/context.ts` — add session-start context recovery
- `src/memory.ts` — add system state storage methods (replace handoff-state.json)
- `src/projects.ts` — migrate handoff state to memory.db knowledge table
- `src/telegram.ts` — wire summarization into `/clear` handler and bridge shutdown

**Changes:**
1. **Session summary on clear/restart** — when `/clear` fires or bridge shuts down, generate a conversation summary via haiku quickShot: "Summarize this conversation in 3-5 bullets: what was discussed, what was decided, what's pending." Store as a high-importance episode (importance=9, source="session_summary").
2. **Session recovery on start** — on first message after restart, ContextBuilder queries for the most recent `source="session_summary"` episode and includes it at the top of context: "Previous conversation summary: ..."
3. **State consolidation** — move handoff-state.json content (activeProject, sessions map) into memory.db knowledge table: `domain="system", key="active_project"` and `domain="system", key="project_sessions"`. Remove the file.
4. **Graceful degradation** — if summary generation fails (Claude unavailable), skip it silently. Don't block shutdown.

**Success criteria:** After `/clear` + new message, Isidore references what was discussed in the previous session. No more handoff-state.json file.

---

### Phase 4: Better Synthesis (lower priority, do later)

**Problem:** 4 runs produced 5 entries. Source-domain grouping is too coarse. No cross-domain patterns. No quality feedback loop.

**Files to modify:**
- `src/synthesis.ts` — improve grouping and add importance-triggered synthesis

**Changes (outline only — detail when we get here):**
1. **Importance-triggered synthesis** — trigger when sum of unsynthesized episode importance > 50 (in addition to scheduled runs)
2. **Topic-based grouping** — group episodes by extracted topic keywords, not just source domain
3. **Knowledge quality scoring** — track access_count on knowledge entries. Prune entries never accessed after 30 days.
4. **Cross-domain synthesis** — one synthesis pass that looks across all domains for patterns

---

## What We DON'T Do

- **No Ollama/sqlite-vec installation** — FTS5 + importance scoring + smart ranking is good enough for now
- **No "neverending conversation" redesign** — session summaries + memory context handles 90% of the need
- **No schema overhaul** — additive columns only, migration-safe
- **No new dependencies** — everything uses existing Bun + SQLite + Claude CLI

---

## Verification

1. **Phase 1:** Deploy → send 5 messages via Telegram → query memory.db → verify all episodes have non-null summary and importance 1-10
2. **Phase 2:** Switch conversation topics mid-chat → verify context injection changes with topic (check `[Memory Context]` in Claude logs)
3. **Phase 3:** `/clear` → send new message → verify response references previous conversation. Check `handoff-state.json` no longer exists.
4. **Phase 4:** Run synthesis → verify new knowledge entries grouped by topic, not just source

---

## Implementation Order

Phase 1 first (standalone, no dependencies). Phase 2 depends on Phase 1 (needs importance column). Phase 3 is independent of Phase 2. Phase 4 is deferred.

**Other `.record()` call sites** that benefit from Phase 1 schema changes (no code changes needed — additive columns with defaults):
- `src/pipeline.ts:475` — pipeline outcome episodes
- `src/orchestrator.ts:633` — workflow outcome episodes
- `src/prd-executor.ts:81,174` — PRD detection + step result episodes
- `src/synthesis.ts:231` — synthesis run summary episodes

**Also:** Update `Plans/sync-and-persistence-redesign.md` to mark sync as DONE and point to this plan for persistence phases.

**Estimated scope:** Phase 1 ≈ 150 lines changed. Phase 2 ≈ 100 lines. Phase 3 ≈ 120 lines + file deletion. Total ≈ ~370 lines across 6 files.
