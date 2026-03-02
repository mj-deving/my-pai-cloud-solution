---
task: Research multi-agent context isolation, shared state, and inter-agent communication patterns (2025-2026)
slug: 20260302-000000_multi-agent-context-isolation-research
effort: deep
phase: complete
progress: 42/42
mode: algorithm
started: 2026-03-02T00:00:00Z
updated: 2026-03-02T00:01:00Z
---

## Context

Marius needs a comprehensive technical report on how production multi-agent AI systems handle context isolation, shared state, and inter-agent communication without context leakage. This directly informs PAI's own multi-agent architecture (Isidore Cloud + Gregor pipeline + future agents). The research must cover 2025-2026 production implementations, not theoretical patterns.

### Risks
- Framework documentation may lag actual production usage patterns
- "Production" claims may be aspirational rather than battle-tested
- Rapidly evolving space - patterns from early 2025 may already be superseded
- Some frameworks may have changed architecture significantly between versions

## Criteria

- [x] ISC-1: Context leakage prevention mechanisms documented for 4+ frameworks
- [x] ISC-2: LangGraph agent isolation architecture described with code-level detail
- [x] ISC-3: CrewAI agent scoping and memory isolation documented
- [x] ISC-4: AutoGen/AG2 agent isolation patterns documented
- [x] ISC-5: OpenAI Swarm handoff and context isolation documented
- [x] ISC-6: At least 2 additional frameworks beyond the big 4 covered
- [x] ISC-7: Shared state patterns categorized (when to share, what to isolate)
- [x] ISC-8: Isolated state patterns categorized with decision criteria
- [x] ISC-9: Message passing protocols documented with trade-offs
- [x] ISC-10: Blackboard/shared memory systems documented with trade-offs
- [x] ISC-11: Event-driven communication patterns documented
- [x] ISC-12: Context bloat prevention strategies enumerated (5+ strategies)
- [x] ISC-13: Workspace-scoped memory pattern defined with use cases
- [x] ISC-14: Project-scoped memory pattern defined with use cases
- [x] ISC-15: Agent-scoped memory pattern defined with use cases
- [x] ISC-16: Memory scope hierarchy described (how scopes compose)
- [x] ISC-17: Cross-agent memory building patterns documented (3+ patterns)
- [x] ISC-18: Context deduplication strategies documented
- [x] ISC-19: Read-only view permission model documented
- [x] ISC-20: Write-through cache permission model documented
- [x] ISC-21: Append-only log permission model documented
- [x] ISC-22: At least 2 additional permission models beyond the 3 above
- [x] ISC-23: Real-world production case study from company running multi-agent system
- [x] ISC-24: Second real-world production case study
- [x] ISC-25: Third real-world production case study
- [x] ISC-26: Architecture diagram/description for context isolation pattern
- [x] ISC-27: Architecture diagram/description for shared state pattern
- [x] ISC-28: Architecture diagram/description for inter-agent communication
- [x] ISC-29: Trade-off analysis for isolation vs sharing spectrum
- [x] ISC-30: Performance implications of isolation patterns documented
- [x] ISC-31: Token budget management strategies for multi-agent systems
- [x] ISC-32: Context window partitioning strategies documented
- [x] ISC-33: State synchronization patterns between agents
- [x] ISC-34: Conflict resolution when multiple agents modify shared state
- [x] ISC-35: Agent handoff patterns that preserve relevant context
- [x] ISC-36: Context compression/summarization for cross-agent transfer
- [x] ISC-37: Failure isolation - how agent failures are contained
- [x] ISC-38: Security boundaries between agents documented
- [x] ISC-39: Observable patterns (logging, tracing across agent boundaries)
- [x] ISC-40: Anti-patterns identified (what NOT to do) - at least 5
- [x] ISC-41: Recommendations for PAI-scale systems (2-10 agents)
- [x] ISC-42: Complete report delivered to research history directory

## Decisions

- Used extensive research mode (18 web searches + 10 deep-dive fetches) rather than agent delegation, due to the need for tight synthesis across 9 research vectors
- Built on prior day's research (2026-03-01) rather than starting from scratch
- Focused on production patterns with concrete implementations rather than theoretical frameworks
- Included PAI-specific recommendations throughout rather than as a separate section only

## Verification

- ISC-1: Section 2 documents 6 leakage prevention mechanisms across LangGraph, CrewAI, AutoGen, OpenAI, Letta, and emerging cryptographic approaches
- ISC-2: Section 3.1 includes LangGraph code patterns for isolated vs shared state, namespace isolation, checkpointer modes
- ISC-3: Section 3.2 covers CrewAI MemoryScope, MemorySlice, crew-level vs agent-level isolation
- ISC-4: Section 3.3 covers AutoGen context types, AG2 context variables, memory protocol
- ISC-5: Section 3.4 covers OpenAI Agents SDK handoffs, system prompt swap, guardrails, sandboxing
- ISC-6: Letta (Section 3.5), Semantic Kernel (Section 3.6), Google ADK (Section 3.7), MemOS (Section 7.6) = 4 additional frameworks
- ISC-7: Section 6 + Section 7 categorize shared patterns with decision criteria
- ISC-8: Section 2 categorizes 6 isolation patterns with trade-offs for each
- ISC-9: Section 4.4 documents message passing with trade-offs
- ISC-10: Section 4.5 documents blackboard/shared memory with trade-offs
- ISC-11: Section 4.6 documents event-driven patterns with trade-offs
- ISC-12: Section 5 enumerates 6 strategies (scoping, compaction, budget partitioning, artifact externalization, role translation, budget-aware scaling)
- ISC-13: Section 6 defines global scope with use cases
- ISC-14: Section 6 defines project scope with use cases
- ISC-15: Section 6 defines agent scope with use cases
- ISC-16: Section 6.4 describes scope composition with inheritance and override
- ISC-17: Section 7 documents 6 patterns (result passing, shared KB, memory manager, git-based, pub/sub, memory federation)
- ISC-18: Covered in compaction strategies (Section 5) and memory management agent pattern (Section 7.3)
- ISC-19: Section 8.1 documents read-only views
- ISC-20: Section 8.2 documents write-through cache
- ISC-21: Section 8.3 documents append-only log
- ISC-22: Section 8 documents 4 additional models: provenance-tracked RBAC, hybrid RBAC+ABAC, capability-based, dynamic access graphs
- ISC-23: Wells Fargo (Section 11.1)
- ISC-24: Stripe (Section 11.2)
- ISC-25: AtlantiCare (Section 11.3) + Anthropic (Section 11.4)
- ISC-26: Section 13.1 ASCII architecture diagram for context isolation
- ISC-27: Section 13.2 ASCII architecture diagram for shared state
- ISC-28: Section 13.3 ASCII architecture diagram for inter-agent communication
- ISC-29: Every section includes explicit trade-offs; Section 14.6 specifically addresses the isolation-sharing spectrum for PAI's scale
- ISC-30: Section 12.8 (context rot performance data), Section 5 (token economics), Section 11.5 (industry statistics)
- ISC-31: Section 5.4 documents the production consensus token budget allocation
- ISC-32: Section 5 + Section 13.4 document partitioning with concrete allocation percentages
- ISC-33: Section 9 documents 6 synchronization patterns
- ISC-34: Section 9 covers LWW, CRDTs, git merge, optimistic concurrency, centralized orchestrator
- ISC-35: Section 3.4 (OpenAI SDK handoffs), Section 3.7 (Google ADK role translation), Section 5.6
- ISC-36: Section 5.3 (compaction targets), Section 5.5 (role translation), Section 5.2 (explicit scoping)
- ISC-37: Section 10 documents process isolation, circuit breakers, failure containment patterns
- ISC-38: Section 10.4 (state separation), Section 10.5 (communication security), Section 10.1 (blast radius)
- ISC-39: Section 8.3 (append-only audit trail), Section 10.2 (process monitoring), covered in FINOS framework
- ISC-40: Section 12 documents 10 anti-patterns (bag of agents, context pollution, monoculture, conformity bias, specification ambiguity, unstructured communication, missing verification, context rot, resource ownership violation, silent cascading failures)
- ISC-41: Section 14 provides 10 PAI-specific recommendations
- ISC-42: Report at ~/.claude/History/research/2026-03/2026-03-02_multi-agent-context-isolation/report.md + summary at Plans/multi-agent-context-isolation-research.md
