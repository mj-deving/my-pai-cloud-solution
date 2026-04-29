---
task: Merge deploy audit VPS smoke test documentation
slug: 20260326-180000_merge-deploy-audit-vps-smoke-docs
effort: advanced
phase: complete
progress: 27/28
mode: interactive
started: 2026-03-26T18:00:00+01:00
updated: 2026-03-26T18:01:00+01:00
---

## Context

Sessions 1-4 are built and reviewed locally but VPS is at `da8a203` (pre-Sessions). Need to: merge S4 to main, push to GitHub, deploy to VPS, enable all new flags, audit VPS health, run smoke+e2e tests, update documentation.

VPS audit findings: Claude CLI 2.1.76 (local 2.1.81), bun 1.3.9, bridge active, 31 DAI hooks present, no Session 1-4 flags enabled yet.

### Risks
- Large delta deploying (Sessions 1-4 = ~6600 LOC new) — bridge restart may fail on config or import errors
- Memory.db schema migrations run on live data — must be idempotent
- New npm dependency (qrcode) needs bun install on VPS

## Criteria

### Merge
- [x] ISC-1: Session 4 branch merged to local main
- [x] ISC-2: Local main pushed to GitHub origin

### Deploy
- [x] ISC-3: deploy.sh executes successfully on VPS
- [x] ISC-4: bun install completes on VPS (qrcode dependency)
- [x] ISC-5: Bridge service restarts without errors

### Enable Flags
- [x] ISC-6: Session 1 flags added to bridge.env (DAG, MCP, LOOP_DETECTION)
- [x] ISC-7: Session 2 flags added to bridge.env (A2A, BRIDGE_CONTEXT_INJECTION)
- [x] ISC-8: Session 3 flags added to bridge.env (PLAYBOOK, WORKTREE, CONTEXT_COMPRESSION)
- [x] ISC-9: Session 4 flags added to bridge.env (GUARDRAILS, A2A_CLIENT, GROUP_CHAT)

### VPS Audit
- [x] ISC-10: VPS git hash matches local main HEAD
- [x] ISC-11: VPS bun version verified adequate
- [x] ISC-12: Claude CLI version checked on VPS
- [x] ISC-13: DAI hooks verified firing via journalctl
- [x] ISC-14: Bridge.env has all required flags enabled
- [x] ISC-15: Memory.db schema migrations applied cleanly

### Smoke Tests
- [x] ISC-16: Bridge service is active after deploy
- [x] ISC-17: Dashboard accessible via SSH tunnel
- [x] ISC-18: Dashboard shows new S4 panels (DAG, Playbooks, Worktrees)
- [x] ISC-19: /health command returns OK via journalctl
- [x] ISC-20: A2A agent card accessible at /.well-known/agent-card.json

### E2E Tests
- [x] ISC-21: bun test passes on VPS (384 tests)
- [x] ISC-22: Bridge responds to test message via dashboard /api/send
- [ ] ISC-23: Loop detection active (BLOCKED — bridge.ts wiring gap from Session 1)

### Documentation
- [x] ISC-24: CLAUDE.md test count and module list current
- [x] ISC-25: MEMORY.md session continuity updated
- [x] ISC-26: VPS bridge.env flags documented in CLAUDE.md

### Anti-criteria
- [x] ISC-A-1: No bridge downtime exceeding 60 seconds during deploy
- [x] ISC-A-2: No data loss in memory.db during migration

## Decisions

- 2026-03-26 19:40: SummaryDAG and LoopDetector never wired in bridge.ts (Session 1 gap). Modules exist, tests pass, but bridge.ts `summaryDag` and `loopDetector` stay null. DAG panel correctly shows disabled. Not blocking — needs separate wiring commit.

## Verification
