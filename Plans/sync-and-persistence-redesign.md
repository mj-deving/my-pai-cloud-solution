# Sync & Persistence Redesign — Planning Prompt

## Status Quo (as of 2026-03-03)

### Three Overlapping Sync Mechanisms

**1. Knowledge Sync (`sync-knowledge.sh`)** — PAI memory/identity
- Syncs: USER/, RELATIONSHIP/, LEARNING/, WORK/, SESSIONS/ dirs + per-project CLAUDE.local.md continuity
- Transport: Private `pai-knowledge` GitHub repo as intermediary
- Local → push on SessionEnd hook (automatic), pull on SessionStart hook (automatic)
- Cloud → push on `/sync`, pull on `/project` switch
- VPS cron: pull+push every 2h (10am-10pm) via `cron-knowledge-sync.sh`
- **Problem:** Local hooks haven't fired since Feb 28. VPS cron syncs with itself. The 143 PRD session dirs in WORK/ and SESSIONS/ are local-only PAI artifacts — Cloud Isidore doesn't use them (it has its own SQLite memory.db).

**2. Project Code Sync (`project-sync.sh`)** — actual source code
- Syncs: git repos of whatever project is active
- Transport: Each project's own GitHub repo
- Cloud → push on `/sync`, pull on `/project` switch
- Local → manual `git pull` / `git push`
- **This works fine.** Clear, simple, understood.

**3. HandoffManager** — structured JSON state snapshots
- Writes: JSON file to `~/.claude/handoff/` with active project, session ID, branch, uncommitted changes, workflows, memory episode count
- Triggers: `/sync` command, bridge shutdown
- Reads: bridge startup (`readIncoming()`), dashboard API
- **Problem:** Nothing consumes the data. `readIncoming()` logs and discards. Dashboard shows it but nobody looks. The same state is already in `handoff-state.json` (ProjectManager) and `CLAUDE.local.md` (knowledge sync).

### What Actually Provides Continuity Today

| Need | What provides it | Notes |
|------|-----------------|-------|
| Active project + per-project sessions | `handoff-state.json` (ProjectManager) | Works, persists across restarts |
| Code changes between instances | Git push/pull per project | Works |
| Session context for Claude | `CLAUDE.local.md` → knowledge sync → `CLAUDE.handoff.md` | Fragile — depends on hooks firing, CLAUDE.handoff.md not auto-loaded |
| Episodic memory on Cloud | `memory.db` (SQLite, Cloud-only) | Not synced, local has no equivalent |
| Distilled knowledge on Cloud | `memory.db` knowledge table | Not synced |
| PAI identity/learnings | `pai-knowledge` repo dirs | Synced but stale (local hooks not firing) |

### What's Redundant or Dead

- `HandoffManager` — JSON snapshot nobody reads, redundant with handoff-state.json
- `CLAUDE.local.md` continuity sync — artifact of local wrapup flow. Cloud Isidore should have its own persistence that doesn't depend on a file written by a local skill
- `WORK/` and `SESSIONS/` sync — 143 local PRD session dirs have no consumer on Cloud. Cloud has its own MEMORY/WORK/ in the project repo
- `cron-knowledge-sync.sh` — syncs VPS with itself when local never pushes
- `recordActivity()` — already deleted
- `lightweightWrapup()` / auto-commits — already deleted

---

## The Problem

Cloud Isidore's persistence and sync is a patchwork of mechanisms designed for a local-first world that was extended to Cloud as an afterthought. The result:

1. **Three sync systems** where one or two would do
2. **Continuity depends on hooks that don't fire** (local SessionStart/SessionEnd)
3. **Cloud Isidore has no self-contained persistence** — it depends on knowledge sync from local, CLAUDE.local.md written by a local wrapup skill, and a handoff-state.json that only tracks project/session IDs
4. **Memory is split** — Cloud has SQLite episodic/semantic memory (memory.db), local has file-based PAI memory dirs. They don't talk to each other.
5. **No neverending conversation model** — Telegram chat is either "project mode" (with /project, /sync) or freeform messaging. There's no designed persistence for long-running conversational context across sessions.

---

## The Vision

### Cloud Isidore as Standalone Agent

Cloud Isidore should be a **self-managing, self-improving agent** that:

- Runs 24/7 on VPS, reachable via Telegram
- Has **neverending conversational continuity** — you can chat across days/weeks and it remembers context through intelligent memory management, session persistence, context injection, and context engineering
- Manages its own state without depending on local hooks or manual sync
- Has **two modes:**
  1. **Chat mode** — freeform conversation, neverending, Isidore manages its own memory and context
  2. **Project mode** — explicit `/project` switch, syncs with local git when `/sync` is called
- Requires **minimal human management** but provides easy monitoring (dashboard, logs) and debuggability
- Gets **iteratively polished** over many sessions — the system improves itself through learning signals, synthesis loops, and feedback cycles
- Has smart routing (direct answers vs Algorithm vs workflows vs delegation) and smart memory (what to remember, what to forget, what to inject into context)

### Sync Simplified

For the sync piece specifically:

- **Project code:** Git push/pull. Already works. Keep it.
- **Knowledge/memory:** Cloud Isidore should be the **primary** memory holder (it runs 24/7). Local instance is the visitor. Cloud shouldn't depend on local pushing knowledge — Cloud should BE the knowledge source.
- **Handoff to local:** On-demand via `/sync`. Pushes code. For context continuity, the intelligent memory system should make `CLAUDE.handoff.md` unnecessary — if Claude's context injection is good enough, the next session (local or cloud) auto-recovers from memory.

### What "Good" Looks Like

- One persistence system (not three)
- Cloud Isidore doesn't need local hooks to function
- Conversation context survives across sessions through memory + context injection (not file-based CLAUDE.local.md)
- `/sync` is the only explicit sync action (pushes code + whatever state transfer is needed)
- `/project` pulls code + whatever is needed from local
- Dashboard shows real state, useful for monitoring
- System improves over time with minimal intervention

---

## Constraints

- Runtime: Bun + TypeScript on VPS, no compilation
- Memory: SQLite (memory.db) with FTS5 keyword search (no Ollama/sqlite-vec on VPS)
- Claude CLI: `claude -p` for one-shot, `claude --resume` for sessions, `--output-format stream-json` for streaming
- Telegram: Grammy bot, single authorized user, 4000 char message limit
- VPS: 32GB RAM, plenty of headroom
- No test suite — verify by deploying and testing via Telegram

---

## Starting Questions for Planning

1. Should HandoffManager be deleted entirely, or repurposed as the single state persistence layer (replacing handoff-state.json)?
2. Should knowledge sync be simplified to code-only (git push/pull) with Cloud memory.db as the source of truth?
3. What does "neverending conversation" look like technically? Session ID persistence + memory context injection + what else?
4. How should Cloud's memory.db knowledge feed back to local sessions? (Or should it — maybe local just reads CLAUDE.handoff.md and that's enough?)
5. What's the minimum viable persistence redesign that unblocks the greater agent-in-the-loop vision?
