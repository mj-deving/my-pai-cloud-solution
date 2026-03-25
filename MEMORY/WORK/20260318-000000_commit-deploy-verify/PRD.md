---
task: Commit, deploy to VPS, set env vars, verify live
slug: 20260318-000000_commit-deploy-verify
effort: standard
phase: complete
progress: 10/12
mode: interactive
started: 2026-03-18T00:00:00+01:00
updated: 2026-03-18T00:00:00+01:00
---

## Context

All Graduated Extraction code is implemented and tested locally (221 tests, 0 failures). Need to: commit to cloud/ branch, deploy to VPS, set env vars (DASHBOARD_TOKEN, HEALTH_MONITOR_ENABLED, DIRECT_API_*), verify live.

## Criteria

### Commit & PR
- [x] ISC-1: All changes committed to cloud/graduated-extraction-p2p3 (c61f059)
- [x] ISC-2: PR #5 created and merged on GitHub
- [x] ISC-3: 221 tests pass, types clean

### VPS Env Vars
- [x] ISC-4: DASHBOARD_TOKEN=ae65f13a... set in bridge.env
- [x] ISC-5: HEALTH_MONITOR_ENABLED=1 set in bridge.env
- [ ] ISC-6: DIRECT_API_KEY — needs Marius's Anthropic API key
- [x] ISC-7: DIRECT_API_ENABLED=1 set in bridge.env

### Deploy & Verify
- [x] ISC-8: Code pulled to VPS, 221 tests pass on VPS
- [x] ISC-9: Bridge restarted, running, no errors in journalctl
- [x] ISC-10: Health monitor started (poll: 60000ms), /api/health-monitor returns ok
- [ ] ISC-11: Direct API needs DIRECT_API_KEY to test (falls back to CLI for now)
- [x] ISC-12: backup.sh runs, creates files with 0600/0700 permissions

## Decisions
## Verification
