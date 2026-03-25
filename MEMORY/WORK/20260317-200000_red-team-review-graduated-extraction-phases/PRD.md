---
task: Red team review of graduated extraction phases
slug: 20260317-200000_red-team-review-graduated-extraction-phases
effort: standard
phase: complete
progress: 8/8
mode: interactive
started: 2026-03-17T20:00:00+01:00
updated: 2026-03-17T20:01:00+01:00
---

## Context

Marius requested a red team exercise: 4 naive-but-devastating questions challenging the Graduated Extraction roadmap. Phase 1 (Sonnet fast-path) is implemented in `direct-api.ts` and `message-classifier.ts` with 7+16 tests, but remains feature-flagged off on VPS (`DIRECT_API_ENABLED=0`, no `DIRECT_API_KEY`). The questions probe whether Phases 2-3 are premature, whether the HTTP gateway duplicates the dashboard, whether scoped secrets are overengineered, and whether test coverage is sufficient.

### Risks
- Defensive posture instead of honest assessment
- Losing nuance by compressing to 150-200 words

## Criteria

- [x] ISC-1: Question 1 answered with honest assessment of Phase 1 activation priority
- [x] ISC-2: Question 1 cites specific evidence from codebase state
- [x] ISC-3: Question 2 answered with concrete dashboard vs gateway comparison
- [x] ISC-4: Question 2 addresses route consolidation feasibility
- [x] ISC-5: Question 3 answered with honest scoped-secrets necessity assessment
- [x] ISC-6: Question 3 considers future-proofing vs YAGNI tradeoff
- [x] ISC-7: Question 4 answered with quantitative test coverage analysis
- [x] ISC-8: Question 4 identifies specific untested paths or gaps

## Decisions

Answering purely from codebase evidence, not aspirational plans.

## Verification
