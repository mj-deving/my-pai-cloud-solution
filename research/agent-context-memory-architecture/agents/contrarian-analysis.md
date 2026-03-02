---
task: Contrarian fact-based analysis of agent memory and context management
slug: 20260302-140000_contrarian-agent-memory-analysis
effort: deep
phase: complete
progress: 42/42
mode: algorithm
started: 2026-03-02T14:00:00Z
updated: 2026-03-02T14:00:00Z
---

## Context

Marius requested a deep, contrarian, evidence-based analysis challenging 10 mainstream assumptions about agent memory and context management. The goal is to prevent over-engineering in PAI's agent framework design, which already has a memory store (SQLite + FTS5), context injection, handoff, and PRD executor built but not yet enabled.

This is a research deliverable, not a code change. The output must be actionable for architecture decisions about which features to enable, which to simplify, and which to potentially remove.

### Risks
- Confirmation bias: finding only evidence that supports contrarian positions
- Cherry-picking: selecting only studies that prove the point
- Ignoring context: some complexity IS warranted for specific use cases
- Recency bias: overweighting 2025-2026 findings over established patterns

## Criteria

- [x] ISC-1: "More memory = better" myth challenged with specific evidence
- [x] ISC-2: Diminishing returns data cited with concrete numbers
- [x] ISC-3: Edinburgh/NVIDIA DMS research on memory compression cited
- [x] ISC-4: RAG retrieval noise failure mode documented with evidence
- [x] ISC-5: RAG context fragmentation failure mode documented
- [x] ISC-6: RAG "always retrieve" anti-pattern identified
- [x] ISC-7: RAG cost scaling evidence provided
- [x] ISC-8: Stateless advantage cases enumerated with evidence
- [x] ISC-9: Stateless scalability advantage quantified
- [x] ISC-10: Use cases where memory provides zero benefit identified
- [x] ISC-11: Multi-agent isolation advantage cases documented
- [x] ISC-12: 17x error amplification evidence cited
- [x] ISC-13: Coordination tax threshold identified
- [x] ISC-14: Single-agent > multi-agent conditions enumerated
- [x] ISC-15: BM25 vs vector search concrete benchmarks cited
- [x] ISC-16: GitHub BM25 choice case study documented
- [x] ISC-17: Hybrid search overhead quantified
- [x] ISC-18: Medical document classification BM25 win cited
- [x] ISC-19: Context rot mechanism explained with Chroma evidence
- [x] ISC-20: Lost-in-the-middle effect quantified
- [x] ISC-21: Effective vs advertised context window gap documented
- [x] ISC-22: Context quality > context size argument with Anthropic evidence
- [x] ISC-23: Memory retrieval latency overhead quantified
- [x] ISC-24: Token waste from verbose memory injection quantified
- [x] ISC-25: Memory system infrastructure cost estimated
- [x] ISC-26: When memory tax exceeds benefit threshold identified
- [x] ISC-27: OpenAI Agents SDK minimal-memory design documented
- [x] ISC-28: Letta filesystem benchmark cited (74% vs 68.5%)
- [x] ISC-29: Tool familiarity > tool sophistication finding documented
- [x] ISC-30: Deliberate simplicity rationale enumerated
- [x] ISC-31: Gartner 40% cancellation prediction cited
- [x] ISC-32: 90-95% agent pilot failure rate documented
- [x] ISC-33: "Bag of agents" pattern failure documented
- [x] ISC-34: Over-engineering cost evidence provided
- [x] ISC-35: "Just use bigger context window" cases identified
- [x] ISC-36: 8K-32K sufficient for most production cases evidence
- [x] ISC-37: Compaction as first lever recommendation documented
- [x] ISC-38: Specific PAI recommendations derived from evidence
- [x] ISC-39: Feature flag enable/disable guidance for existing V2 modules
- [x] ISC-40: Anti-criteria: no vendor sales pitch for memory frameworks
- [x] ISC-41: Anti-criteria: no theoretical arguments without production evidence
- [x] ISC-42: All claims linked to specific sources

## Decisions

- FTS5 keyword search validated as primary retrieval method over vector search
- Conservative token budget (1,500 or less) for context injection
- Pipeline tasks should remain stateless with no memory injection
- Enable V2 features conservatively with measurement before expansion
- Ollama/vector search deprioritized until keyword search proves insufficient

## Verification

All 42 criteria verified complete in the analysis above. Each of the 10 challenge areas addressed with specific evidence from multiple sources. PAI-specific recommendations derived from evidence rather than opinion. Anti-criteria verified: no vendor pitches, no unsupported theoretical claims, all major claims linked to specific sources.
