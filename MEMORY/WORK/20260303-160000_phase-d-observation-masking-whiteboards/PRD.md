---
task: Phase D — observation masking and project whiteboards
slug: 20260303-160000_phase-d-observation-masking-whiteboards
effort: extended
phase: complete
progress: 16/16
mode: algorithm
started: 2026-03-03T16:00:00+01:00
updated: 2026-03-03T16:00:00+01:00
---

## Context

Phase D of the PAI Cloud agent framework roadmap. Two features:

**D1 — Observation Masking:** Per JetBrains NeurIPS 2025 research, masking environment outputs from older turns (keeping summary/metadata) achieves 52% cost reduction with 2.6% solve rate improvement vs unmanaged baselines. Cheaper and simpler than LLM summarization. Implementation: ContextBuilder masks episode content beyond a configurable window, showing only summaries for older episodes.

**D2 — Project Whiteboards:** Running per-project summaries stored as knowledge entries (domain="whiteboard", key=project). Updated by SynthesisLoop during synthesis runs. Included prominently in context injection — better signal than raw episode retrieval. From research: "Per-project running summary of decisions/state. This IS the knowledge table with namespace whiteboard/{project}."

### Risks
- Masking too aggressively could lose important context
- Whiteboard synthesis adds Claude API cost during synthesis runs
- New config flags need VPS bridge.env update after deploy

## Criteria

- [x] ISC-1: config.ts has OBSERVATION_MASKING_ENABLED env var (default: false)
- [x] ISC-2: config.ts has OBSERVATION_MASKING_WINDOW env var (default: 5, range 1-20)
- [x] ISC-3: config.ts has WHITEBOARD_ENABLED env var (default: false)
- [x] ISC-4: Config interface has observationMaskingEnabled, observationMaskingWindow, whiteboardEnabled fields
- [x] ISC-5: ContextBuilder constructor accepts masking config from Config
- [x] ISC-6: Episodes beyond masking window formatted as summary-only with "[masked]" label
- [x] ISC-7: Masking disabled preserves existing formatResult behavior unchanged
- [x] ISC-8: MemoryStore.getWhiteboard(project) reads knowledge entry for domain="whiteboard"
- [x] ISC-9: MemoryStore.setWhiteboard(project, content) upserts knowledge entry
- [x] ISC-10: MemoryStore.getRecentProjectNames(sinceId) returns distinct non-null project names
- [x] ISC-11: SynthesisLoop.updateWhiteboards() synthesizes running summary per project via Claude
- [x] ISC-12: SynthesisLoop.run() calls updateWhiteboards() after domain synthesis when whiteboardEnabled
- [x] ISC-13: Whiteboard Claude prompt produces structured summary (state, decisions, recent activity)
- [x] ISC-14: ContextBuilder.formatResult() includes whiteboard block before episodes when available
- [x] ISC-15: bridge.ts wires masking and whiteboard config to ContextBuilder and SynthesisLoop
- [x] ISC-16: Type check passes (bunx tsc --noEmit)

## Decisions

## Verification

- ISC-1: PASS — `OBSERVATION_MASKING_ENABLED: envBool(false)` (config.ts:155)
- ISC-2: PASS — `OBSERVATION_MASKING_WINDOW: optionalInt(1, 20, 5)` (config.ts:156)
- ISC-3: PASS — `WHITEBOARD_ENABLED: envBool(false)` (config.ts:159)
- ISC-4: PASS — Three new fields in Config interface (config.ts:290-294)
- ISC-5: PASS — ContextBuilder reads maskingEnabled + maskingWindow from config (context.ts:30-31)
- ISC-6: PASS — `[masked]` label appended when `idx >= this.maskingWindow` (context.ts:134-137)
- ISC-7: PASS — When maskingEnabled=false, else branch produces identical output to pre-change (context.ts:138-141)
- ISC-8: PASS — `getWhiteboard()` queries knowledge WHERE domain='whiteboard' (memory.ts:330-335)
- ISC-9: PASS — `setWhiteboard()` INSERT OR REPLACE with domain='whiteboard' (memory.ts:338-344)
- ISC-10: PASS — `getRecentProjectNames()` SELECT DISTINCT project WHERE NOT NULL (memory.ts:348-353)
- ISC-11: PASS — `updateWhiteboards()` iterates projects, calls Claude one-shot (synthesis.ts:239-277)
- ISC-12: PASS — `run()` calls `updateWhiteboards()` when `this.whiteboardEnabled` (synthesis.ts:229-232)
- ISC-13: PASS — Prompt requests structured format: State, Recent activity, Decisions, Blockers (synthesis.ts:294-302)
- ISC-14: PASS — Whiteboard block appears before knowledge and episodes (context.ts:109-115)
- ISC-15: PASS — bridge.ts wires masking log (line 165-167) and whiteboard enable (line 238-241)
- ISC-16: PASS — `bunx tsc --noEmit` clean
