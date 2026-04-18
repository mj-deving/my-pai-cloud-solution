---
task: Research bridge-to-native PAI migration patterns
slug: 20260418-104310_research-bridge-to-native-patterns
effort: comprehensive
phase: complete
progress: 18/18
mode: interactive
started: 2026-04-18T10:43:10+02:00
updated: 2026-04-18T10:48:00+02:00
---

## Context

User wants deep comprehensive research on existing implementations before retiring the Telegram bridge. Goal: build on proven patterns rather than reinvent. Scope spans 8 distinct research dimensions (A–H in original prompt).

**End-state of the work we'd be informing:** Retire `src/bridge.ts` (Grammy bot) in favor of native Claude Code running in Channels mode + PAI hooks + MCP servers + skills. Standalone pipeline + dashboard already extracted.

### Risks
- **URL hallucination by research agents** — mandatory verification before delivering
- **Shallow agent outputs** — mitigation: topic-specific deep prompts, 9 parallel agents across 3 researcher types (Claude/Gemini/Grok)
- **Synthesis that ignores contradictions** — mitigation: explicitly surface disagreements, contrarian agent included
- **Confirmation bias toward "retire the bridge"** — mitigation: one Grok agent explicitly assigned the devil's advocate case

### Plan
Launched 9 parallel research agents + 2 bird Twitter signals. Mapping to user's 8 questions:

| Agent | Researcher | User Q | Angle |
|-------|-----------|--------|-------|
| 1 | Claude | A+B | Custom-wrapper → native migration patterns |
| 2 | Claude | E | Hook-based LLM agent architectures |
| 3 | Claude | G | Episodic memory backends (SQLite/pgvector/LanceDB) |
| 4 | Gemini | C | Claude Channels plugin ecosystem |
| 5 | Gemini | D | Telegram-bot migration case studies |
| 6 | Gemini | F | Proactive notification patterns |
| 7 | Grok | B | PAI-like systems critical review (contrarian) |
| 8 | Grok | H | Mobile-first agent surfaces 2025-2026 |
| 9 | Grok | overall | Case AGAINST retiring the bridge |

## Criteria

**Research dispatch**
- [x] ISC-1: 9 research agents launched in parallel across 3 researcher types
- [x] ISC-2: Twitter signal queries dispatched (bird CLI, 2 queries)
- [x] ISC-3: Each agent given topic-specific deep prompt under 800 words

**Coverage per user question**
- [x] ISC-4: Q(A) migration patterns — agent 1 returned with Claude Agent SDK, Cline, Zed, Letta cited
- [x] ISC-5: Q(B) OSS PAI-like systems — agent 7 returned contrarian: "bridge is the product"
- [x] ISC-6: Q(C) Channels ecosystem — agent 4 returned with 5 open issues cited
- [x] ISC-7: Q(D) Telegram-bot migrations — agent 5 returned with 8 reference repos
- [x] ISC-8: Q(E) hook-based architectures — agent 2 returned with 5 turn-recording prior art repos
- [x] ISC-9: Q(F) proactive notifications — agent 6 returned with 6 reference repos
- [x] ISC-10: Q(G) persistence layers — agent 3 returned with Letta/Park/Wang citations
- [x] ISC-11: Q(H) mobile-first surfaces — agent 8 returned with Remote Control as only native path

**Synthesis quality**
- [x] ISC-12: 20 critical URLs verified via curl (all 200 OK)
- [x] ISC-13: Synthesis identifies 9 themes across all agents
- [x] ISC-14: Synthesis surfaces 5 explicit contradictions with resolutions
- [x] ISC-15: Reusability matrix written (13 components, fit scores, effort estimates)

**Delivery**
- [x] ISC-16: Report saved to MEMORY/WORK/{slug}/research-report.md
- [x] ISC-17: Verdict: 4-move additive migration; delay Grammy shutdown pending issue #36477
- [x] ISC-18: Follow-ups tied to Phase 5 prerequisites (a–d) + Move 4 decision gate

## Decisions

- **Extensive mode (9 agents), not a custom DeepInvestigation loop** — the 8 sub-questions are already well-decomposed; iterative entity discovery isn't needed. One round of parallel agents + synthesis.
- **Include a dedicated contrarian agent (Grok #9)** — user said "if patterns exist" (open to "they don't"), so the premise itself deserves pushback.
- **Twitter signal is non-blocking** — bird CLI may fail silently; we proceed with research-agent output regardless.
