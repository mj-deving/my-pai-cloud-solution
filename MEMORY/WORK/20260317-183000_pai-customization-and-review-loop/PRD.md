---
task: PAI-customization workflows plus review-to-memory learning loop
slug: 20260317-183000_pai-customization-and-review-loop
effort: extended
phase: complete
progress: 18/18
mode: interactive
started: 2026-03-17T18:30:00+01:00
updated: 2026-03-17T18:30:00+01:00
---

## Context

Two tasks:
1. Add TestGeneration, PreDeployCheck workflows + ErrorPatterns reference to PAI-customization CodexBridge
2. Implement review-to-memory.db learning loop: after Codex review, parse P0-P3 findings and store as knowledge entries

## Criteria

### PAI-customization: CodexBridge additions
- [ ] ISC-1: TestGeneration.md workflow exists in CodexBridge/Workflows/
- [ ] ISC-2: TestGeneration workflow defines test matrix generation steps
- [ ] ISC-3: TestGeneration workflow references existing test patterns
- [ ] ISC-4: PreDeployCheck.md workflow exists in CodexBridge/Workflows/
- [ ] ISC-5: PreDeployCheck defines type-check, test, review gates
- [ ] ISC-6: ErrorPatterns.md reference exists in CodexBridge/References/
- [ ] ISC-7: ErrorPatterns catalogs common P0-P3 finding types
- [ ] ISC-8: SKILL.md updated to list new workflows and reference
- [ ] ISC-9: install.sh still works after additions

### Review → memory.db learning loop
- [ ] ISC-10: parseReviewFindings() function extracts P0-P3 from Codex output
- [ ] ISC-11: Findings stored as knowledge entries in memory.db
- [ ] ISC-12: Knowledge domain is "codex-review"
- [ ] ISC-13: Knowledge key includes severity and finding summary
- [ ] ISC-14: Source episode IDs link to the review episode
- [ ] ISC-15: Integration point in /sync command after review completes
- [ ] ISC-16: Integration point in /review command after review completes
- [ ] ISC-17: Tests for parseReviewFindings()
- [ ] ISC-18: Type check passes after changes

## Decisions

## Verification
