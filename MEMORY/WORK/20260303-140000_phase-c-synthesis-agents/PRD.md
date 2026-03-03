---
task: "Phase C: Synthesis loop + agent definitions implementation"
slug: "20260303-140000_phase-c-synthesis-agents"
effort: Advanced
phase: complete
progress: 28/28
mode: algorithm
started: 2026-03-03T14:00:00+01:00
updated: 2026-03-03T14:00:00+01:00
---

## Context

Phase 4 (scheduler, policy, injection scan) complete and deployed. Phase C closes L3-L4 autonomy gaps: periodic knowledge synthesis from accumulated episodes, and declarative agent definitions for scoped sub-delegation. Implementation follows approved plan with 6 components (C1-C6).

### Risks
- Circular import if synthesis.ts imports MemoryStore directly (mitigated by setter pattern)
- YAML frontmatter parsing edge cases in agent defs (mitigated by graceful skip)
- SynthesisLoop's Claude one-shot may fail if VPS has no context (mitigated by empty-result handling)

## Criteria

- [x] ISC-1: `"synthesis"` added to Episode source enum in schemas.ts
- [x] ISC-2: `"synthesis"` added to MemoryQuery source enum in schemas.ts
- [x] ISC-3: Pipeline records episode with `source: "pipeline"` after result write
- [x] ISC-4: Pipeline has `setMemoryStore()` setter and `setSynthesisLoop()` setter
- [x] ISC-5: Orchestrator records episode with `source: "orchestrator"` on workflow completion
- [x] ISC-6: Orchestrator has `setMemoryStore()` setter
- [x] ISC-7: Bridge wires memoryStore to pipeline and orchestrator via setters
- [x] ISC-8: `.pai/agents/synthesizer.md` exists with correct YAML frontmatter
- [x] ISC-9: `.pai/agents/code-reviewer.md` exists with correct YAML frontmatter
- [x] ISC-10: `.pai/agents/health-checker.md` exists with correct YAML frontmatter
- [x] ISC-11: `prompts/algo-lite.md` exists with 3-phase protocol
- [x] ISC-12: `src/synthesis.ts` exports SynthesisLoop class
- [x] ISC-13: SynthesisLoop.run() checks policy, fetches episodes, groups by domain
- [x] ISC-14: SynthesisLoop.run() invokes Claude oneShot for synthesis per domain
- [x] ISC-15: SynthesisLoop.run() writes knowledge entries via memoryStore.distill()
- [x] ISC-16: SynthesisLoop persists lastSynthesizedId in memory DB synthesis_state table
- [x] ISC-17: SynthesisLoop.getStats() returns lastRun, totalRuns, totalEntriesDistilled
- [x] ISC-18: memory.ts has getEpisodesSince(sinceId, limit) method
- [x] ISC-19: memory.ts has getKnowledgeByDomain(domain) method
- [x] ISC-20: `src/agent-loader.ts` exports AgentLoader class
- [x] ISC-21: AgentLoader.loadAll() parses .md files with YAML frontmatter
- [x] ISC-22: AgentLoader.registerAll() self-registers agents in AgentRegistry
- [x] ISC-23: claude.ts has subDelegate() method with tier-based invocation
- [x] ISC-24: Config has synthesisEnabled, synthesisMinEpisodes, agentDefinitionsEnabled, agentDefinitionsDir
- [x] ISC-25: policy.yaml has synthesis.run and subdelegation rules
- [x] ISC-26: Bridge wires SynthesisLoop, AgentLoader, and all setters
- [x] ISC-27: Dashboard has /api/synthesis route and synthesis panel in HTML
- [x] ISC-28: `bunx tsc --noEmit` passes with zero errors

## Decisions

## Verification

- ISC-1/2: Grep confirms `"synthesis"` in both Episode and MemoryQuery source enums (schemas.ts:207, 233)
- ISC-3: Grep confirms `source: "pipeline"` episode recording after result write (pipeline.ts:439)
- ISC-4: Grep confirms `setMemoryStore()` and `setSynthesisLoop()` setters (pipeline.ts:137, 142)
- ISC-5: Grep confirms `source: "orchestrator"` episode recording in notifyCompletion (orchestrator.ts:601)
- ISC-6: Grep confirms `setMemoryStore()` setter (orchestrator.ts:76)
- ISC-7: Grep confirms bridge wires `pipeline.setMemoryStore(memoryStore)` and `orchestrator.setMemoryStore(memoryStore)`
- ISC-8/9/10: `ls .pai/agents/` shows synthesizer.md, code-reviewer.md, health-checker.md
- ISC-11: `ls prompts/` shows algo-lite.md
- ISC-12: Grep confirms `export class SynthesisLoop` (synthesis.ts:29)
- ISC-13/14/15: Code review of synthesis.ts run() confirms policy check, episode fetch, domain grouping, Claude oneShot, distill()
- ISC-16: Grep confirms `synthesis_state` table creation and `lastSynthesizedId` read/write
- ISC-17: Grep confirms `getStats()` method returning lastRun, totalRuns, totalEntriesDistilled
- ISC-18/19: Grep confirms `getEpisodesSince()` and `getKnowledgeByDomain()` in memory.ts
- ISC-20/21/22: AgentLoader class with loadAll(), registerAll() confirmed in agent-loader.ts
- ISC-23: Grep confirms `subDelegate()` with tier-based switch (1/2/3) in claude.ts
- ISC-24: Grep confirms all 4 config fields in config.ts
- ISC-25: Grep confirms synthesis.run, subdelegation.invoke, subdelegation.unregistered in policy.yaml
- ISC-26: Grep confirms full bridge wiring for SynthesisLoop + AgentLoader
- ISC-27: Grep confirms /api/synthesis route + renderSynthesis + synthesisPanel in dashboard
- ISC-28: `bunx tsc --noEmit` exits 0
