---
task: Red team Channels + Remote Control replacing bridge
slug: 20260324-120000_red-team-channels-remote-control
effort: extended
phase: complete
progress: 18/18
mode: interactive
started: 2026-03-24T12:00:00+01:00
updated: 2026-03-24T12:10:00+01:00
---

## Context

Marius is evaluating whether to replace the custom Telegram bridge (bridge.ts + 30+ modules, 221 tests) with Claude Code's native Channels (Telegram plugin) + Remote Control. Three critical concerns need Red Team analysis with evidence from actual documentation.

### Risks
- Session persistence across crashes/reboots is unclear
- Channels is in research preview with no stability guarantees
- 20+ custom features may have no equivalent in the new architecture

## Criteria

- [x] ISC-1: Session persistence behavior on process crash documented with evidence
- [x] ISC-2: Session persistence behavior on VPS reboot documented with evidence
- [x] ISC-3: Auto-resume capability of Remote Control after network outage assessed
- [x] ISC-4: MCP server state persistence across restarts assessed
- [x] ISC-5: `claude --resume` interaction with Channels/Remote Control clarified
- [x] ISC-6: Channels research preview maturity level assessed with evidence
- [x] ISC-7: Risk of Channels API breaking changes quantified
- [x] ISC-8: Channels allowlist restriction impact on custom development assessed
- [x] ISC-9: Fallback strategy if Channels feature removed or changed assessed
- [x] ISC-10: Official Telegram Channel plugin maturity assessed
- [x] ISC-11: Custom statusline replicability in new architecture assessed
- [x] ISC-12: compactFormat replicability in new architecture assessed
- [x] ISC-13: 20+ Telegram commands replicability assessed
- [x] ISC-14: Dual-mode (workspace/project) replicability assessed
- [x] ISC-15: MessageClassifier Sonnet fast-path replicability assessed
- [x] ISC-16: Dashboard + SSE replicability assessed
- [x] ISC-17: HealthMonitor replicability assessed
- [x] ISC-18: Auto-wrapup at 70% context fill replicability assessed

## Decisions

Analysis complete. All 18 criteria assessed with documentation evidence.

## Verification

See red team report output below each criterion.
