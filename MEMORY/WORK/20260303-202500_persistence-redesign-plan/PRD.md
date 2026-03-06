---
task: Revise sync-and-persistence-redesign plan focusing on persistence optimization
slug: 20260303-202500_persistence-redesign-plan
effort: extended
phase: think
progress: 0/18
mode: algorithm
started: 2026-03-03T20:25:00+01:00
updated: 2026-03-03T20:25:00+01:00
---

## Context

Marius completed the sync cleanup (deleted HandoffManager, knowledge sync, cron wrapper — ~670 lines). The planning doc at `Plans/sync-and-persistence-redesign.md` still describes the old three-system problem. It needs to be revised to: (1) mark sync as done, (2) focus entirely on persistence redesign/optimization — the unfulfilled parts of the original vision.

Current persistence state: memory.db has 19 episodes and 5 knowledge entries after weeks of use. FTS5 keyword search only (no vector). 5-minute frozen snapshot caching. Basic observation masking. Synthesis has run 4 times producing 5 entries. handoff-state.json still file-based. No session summarization, no conversation-level tracking, no "neverending conversation" model.

## Criteria

- [ ] ISC-1: Plan doc marks sync cleanup as DONE with summary
- [ ] ISC-2: Plan doc removes/archives the "three overlapping sync mechanisms" section
- [ ] ISC-3: Plan doc has a "Current State" section showing what persistence exists today
- [ ] ISC-4: Current State section includes VPS memory.db stats (19 episodes, 5 knowledge, FTS5-only)
- [ ] ISC-5: Plan doc has a "Problems" section listing specific persistence gaps
- [ ] ISC-6: Problems section covers memory quality (low episode count, no importance scoring)
- [ ] ISC-7: Problems section covers context injection limitations (frozen snapshot, no conversation tracking)
- [ ] ISC-8: Problems section covers session continuity (no summarization on clear/restart)
- [ ] ISC-9: Problems section covers synthesis quality (5 entries from 4 runs)
- [ ] ISC-10: Problems section covers state fragmentation (handoff-state.json separate from memory.db)
- [ ] ISC-11: Plan doc has phased roadmap with at least 3 phases
- [ ] ISC-12: Each phase has clear scope, deliverables, and success criteria
- [ ] ISC-13: Phase 1 addresses memory recording quality (more episodes, better summaries)
- [ ] ISC-14: Phase 2 addresses context injection intelligence (conversation tracking, topic detection)
- [ ] ISC-15: Phase 3 addresses session continuity (summarization, recovery)
- [ ] ISC-16: Plan doc has a "What Good Looks Like" section updated for persistence focus
- [ ] ISC-17: Plan doc has "Constraints" section updated with current technical reality
- [ ] ISC-18: Plan doc replaces original "Starting Questions" with concrete next actions

## Decisions

## Verification
