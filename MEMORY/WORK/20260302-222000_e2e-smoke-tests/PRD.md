---
task: Run cross-instance E2E pipeline smoke tests
slug: 20260302-222000_e2e-smoke-tests
effort: standard
phase: complete
progress: 7/8
mode: algorithm
started: 2026-03-02T22:20:00+01:00
updated: 2026-03-02T22:20:00+01:00
---

## Context

Run the two smoke tests from `Plans/functional-mapping-manatee.md` Step 2. Bridge is running on VPS (active 1h+). We submit task JSON files directly as isidore_cloud user via SSH — no need for Gregor's pai-submit.sh. Pipeline polls tasks/ every 5s.

Smoke A: basic "2+2" with timeout_minutes=2, max_turns=3
Smoke B: file listing with timeout_minutes=5, max_turns=2

## Criteria

- [x] ISC-1: Bridge service is active before test submission
- [x] ISC-2: Smoke A task JSON written to /var/lib/pai-pipeline/tasks/
- [x] ISC-3: Smoke A result file exists in results/ with status "completed"
- [x] ISC-4: Smoke A task file moved to ack/
- [x] ISC-5: Smoke B task JSON written to /var/lib/pai-pipeline/tasks/
- [ ] ISC-6: Smoke B result file exists in results/ with status "completed" — PARTIAL: status "error" due to max_turns=2 too restrictive, but pipeline mechanics all worked (pickup, dispatch, result write, verifier, ack). max_turns parameter IS being passed through correctly.
- [x] ISC-7: Smoke B task file moved to ack/
- [x] ISC-8: Bridge logs show no errors during both tests — only expected verifier rejection

## Decisions

## Verification
