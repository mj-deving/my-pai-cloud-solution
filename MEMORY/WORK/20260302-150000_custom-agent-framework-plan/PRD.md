---
task: Plan custom agent framework — vision, decision graph, phased roadmap
slug: 20260302-150000_custom-agent-framework-plan
effort: deep
phase: plan
progress: 0/48
mode: algorithm
started: 2026-03-02T15:00:00+01:00
updated: 2026-03-02T15:00:00+01:00
---

## Context

Marius wants to plan the custom agent framework for DAI Cloud Solution. All research is done (10 frameworks, 16-section synthesis report, ~700K tokens synthesized). Now it's time to establish:

1. **Vision of Goals** — what the framework is meant to achieve
2. **Decision Graph** — well-reasoned map of paths for adopting different features from frameworks
3. **Current State Assessment** — where we stand (31 src files, 6 phases built)
4. **Phased Roadmap** — what to do, in what order, avoiding over-engineering
5. **DAI Algorithm Integration** — how the Algorithm remains the core differentiator

The framework should be personal-first (Marius's solution), designed to evolve into battle-tested infrastructure. It extends local DAI into cloud with highest independent agency (L3→L4). It is NOT a rewrite — it builds on the existing 31-file cloud solution.

Key constraints:
- No over-engineering — evolve, don't big-bang
- DAI Algorithm is the core differentiator (not just another ReAct loop)
- Leverage existing infrastructure (memory, context, handoff, pipeline, orchestrator)
- Best-of-all synthesis from 10 researched frameworks
- Demos ecosystem compatibility as future milestone (not immediate)

### Risks

1. **Over-planning risk** — Roadmap must be actionable, not theoretical. Phase 1 must be completable in 1-2 sessions.
2. **Algorithm overhead for autonomous tasks** — 7-phase Algorithm is human-interactive; autonomous agents need lightweight mode.
3. **Complexity without value** — Agent framework layer could break working Telegram+pipeline if not careful.
4. **Unstaged changes** — 2026-02-28 src/ changes need commit-or-discard decision before Phase 1 begins.
5. **No test suite** — All verification is deploy-and-test. Multi-phase work needs at minimum smoke tests.
6. **API cost governance** — Autonomous operation without spending limits is dangerous.

## Criteria

### Vision & Goals (Foundation)
- [ ] ISC-1: Framework vision statement defines target autonomy level (L3→L4)
- [ ] ISC-2: Framework vision explicitly positions DAI Algorithm as core differentiator vs ReAct loops
- [ ] ISC-3: Three distinct operating modes defined (workspace/project/autonomous)
- [ ] ISC-4: Success metrics defined for each autonomy level transition
- [ ] ISC-5: Non-goals explicitly listed (what the framework will NOT do)

### Current State Assessment
- [ ] ISC-6: Inventory of all 31 existing src files mapped to framework concerns
- [ ] ISC-7: Existing capabilities rated against target framework requirements
- [ ] ISC-8: Gap analysis identifies missing components per autonomy level
- [ ] ISC-9: Technical debt in existing codebase catalogued with severity
- [ ] ISC-10: Existing memory/context/handoff infrastructure mapped to research recommendations

### Decision Graph — Context & Memory
- [ ] ISC-11: Frozen snapshot injection path documented with trade-offs
- [ ] ISC-12: Character-bounded memory path documented with trade-offs
- [ ] ISC-13: Project-scoped search filters path documented with trade-offs
- [ ] ISC-14: Observation masking vs LLM summarization decision resolved with evidence
- [ ] ISC-15: Cache-friendly prompt structure path documented
- [ ] ISC-16: FTS5-primary vs hybrid retrieval decision resolved with evidence

### Decision Graph — Agent Architecture
- [ ] ISC-17: Single generalist vs sniper agents decision mapped with evidence
- [ ] ISC-18: Agent definition format chosen (markdown vs code vs config)
- [ ] ISC-19: Agent-to-agent communication pattern chosen (direct vs hub-and-spoke vs blackboard)
- [ ] ISC-20: Pipeline task routing evolution path documented
- [ ] ISC-21: Session management model chosen (shared vs per-project vs per-agent)
- [ ] ISC-22: Concurrency model documented (pool vs queue vs DAG)

### Decision Graph — Autonomy & Self-Initiation
- [ ] ISC-23: Event-driven trigger architecture chosen (webhook vs cron vs pub-sub)
- [ ] ISC-24: Session auto-resume mechanism designed
- [ ] ISC-25: Escalation boundaries defined (when agent must ask human)
- [ ] ISC-26: Self-initiation scope limits defined (what agent can start autonomously)
- [ ] ISC-27: Continuous operation model chosen (daemon vs triggered vs hybrid)

### Decision Graph — Integration & Evolution
- [ ] ISC-28: Local DAI ↔ Cloud DAI integration boundaries defined
- [ ] ISC-29: DAI Algorithm hook points identified for agent framework
- [ ] ISC-30: Demos ecosystem integration path documented (phased)
- [ ] ISC-31: Skill system integration path documented
- [ ] ISC-32: Hook system integration path documented

### Phased Roadmap — Phase 1 (Foundation)
- [ ] ISC-33: Phase 1 scope defined with entry/exit criteria
- [ ] ISC-34: Phase 1 file-level implementation targets identified
- [ ] ISC-35: Phase 1 estimated effort quantified
- [ ] ISC-36: Phase 1 preserves all existing functionality (no regressions)

### Phased Roadmap — Phase 2 (Context Engineering)
- [ ] ISC-37: Phase 2 scope defined with entry/exit criteria
- [ ] ISC-38: Phase 2 builds only on Phase 1 outputs (no forward dependencies)
- [ ] ISC-39: Phase 2 file-level implementation targets identified
- [ ] ISC-40: Phase 2 estimated effort quantified

### Phased Roadmap — Phase 3 (Agent Framework)
- [ ] ISC-41: Phase 3 scope defined with entry/exit criteria
- [ ] ISC-42: Phase 3 agent definition format specified
- [ ] ISC-43: Phase 3 file-level implementation targets identified
- [ ] ISC-44: Phase 3 estimated effort quantified

### Phased Roadmap — Phase 4 (Autonomous Operation)
- [ ] ISC-45: Phase 4 scope defined with entry/exit criteria
- [ ] ISC-46: Phase 4 self-initiation triggers specified
- [ ] ISC-47: Phase 4 file-level implementation targets identified
- [ ] ISC-48: Phase 4 maps to L4 autonomy from DAI-Demos-Analysis

### Anti-Criteria
- [ ] ISC-A1: Plan does NOT propose rewriting existing working modules
- [ ] ISC-A2: Plan does NOT require all phases before any value is delivered
- [ ] ISC-A3: Plan does NOT copy any single framework wholesale
- [ ] ISC-A4: Plan does NOT introduce external runtime dependencies (stays Bun + SQLite)
- [ ] ISC-A5: Plan does NOT exceed reasonable scope for a personal project

## Decisions

(To be filled during BUILD/EXECUTE)

## Verification

(To be filled during VERIFY)
