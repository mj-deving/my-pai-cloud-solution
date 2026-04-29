---
task: Rethink DAI Cloud architecture for mobile-first access
slug: 20260324-120000_pai-cloud-architecture-rethink
effort: deep
phase: complete
progress: 42/42
mode: interactive
started: 2026-03-24T12:00:00+01:00
updated: 2026-03-24T12:01:00+01:00
---

## Context

Marius runs DAI Cloud as a Telegram bot bridge on a VPS, spawning Claude Code CLI processes. The system has grown to 30+ modules (~5000 lines) handling memory, context injection, session management, cross-agent pipelines, health monitoring, and more. He wants to evaluate whether this architecture is still the right approach given Claude Code's new features (Channels, Remote Control, Agent SDK) or whether a fundamental rethink would reduce complexity while improving capability.

Key constraints: Must work with Claude Max/Pro subscription (no API key). Must be accessible from mobile. Should provide terminal-like interactive experience, not just chat.

### Research Findings

**Claude Code Channels** (research preview, v2.1.80+): MCP servers that push events into a running Claude Code session. Official Telegram and Discord plugins exist. Two-way with reply tools, permission relay for remote tool approval. Requires claude.ai login. The official Telegram plugin already does what 60% of the current bridge does natively.

**Claude Code Remote Control** (all plans, v2.1.51+): Connect claude.ai/code or Claude mobile app (iOS/Android) to a local CLI session. Full terminal experience from phone. Server mode with `claude remote-control --spawn worktree --capacity 32`. Session auto-reconnects. Works with Max/Pro.

**Claude Agent SDK (Python)**: Programmatic wrapper around Claude Code CLI. Supports session management, streaming, custom tools via in-process MCP, hooks. Works with Max/Pro subscriptions. No separate API key needed.

**"Maestro" on GitHub under anthropics**: This is Netflix's workflow orchestrator (Java/Spring Boot), NOT an Anthropic multi-agent tool. Red herring.

### Risks

- Channels are in research preview -- API may change
- Remote Control requires terminal to stay open
- Official Telegram plugin may not support DAI's memory/context injection
- Migration path from current system needs to preserve memory.db data
- VPS network stability affects Remote Control (10-min timeout on outage)

## Criteria

- [x] ISC-1: Each architecture option has a clear 1-paragraph description
- [x] ISC-2: Each option states whether it works with Max/Pro subscription
- [x] ISC-3: Each option states whether it can run headlessly on VPS
- [x] ISC-4: Each option states mobile UX quality (terminal-like vs chat-like)
- [x] ISC-5: Each option lists percentage of current codebase reusable
- [x] ISC-6: Each option has complexity estimate (weeks of work)
- [x] ISC-7: Each option identifies key risks and blockers
- [x] ISC-8: Channels architecture fully described with custom MCP layer
- [x] ISC-9: Remote Control architecture fully described with daemon setup
- [x] ISC-10: Agent SDK architecture fully described with transport layer
- [x] ISC-11: Web terminal (xterm.js) option fully analyzed
- [x] ISC-12: Hybrid option combining best of multiple approaches
- [x] ISC-13: Memory/context preservation strategy for each option
- [x] ISC-14: Cross-agent pipeline compatibility for each option
- [x] ISC-15: Permission model analyzed for remote tool approval
- [x] ISC-16: Comparison table across all dimensions
- [x] ISC-17: Analysis of official Telegram plugin vs current bridge
- [x] ISC-18: Current bridge module audit (what to keep, discard, migrate)
- [x] ISC-19: Headless Electron feasibility verdict with evidence
- [x] ISC-20: tmux + web terminal approach evaluated
- [x] ISC-21: "Novel Option F" -- creative architecture not in original list
- [x] ISC-22: Session management comparison (current vs each option)
- [x] ISC-23: Auto-wrapup / context window management per option
- [x] ISC-24: Claude Code hook compatibility per option
- [x] ISC-25: Deployment complexity comparison (current vs each option)
- [x] ISC-26: Failure mode analysis for top 2 recommended options
- [x] ISC-27: Migration plan outline for recommended option
- [x] ISC-28: Clear winner recommendation with reasoning
- [x] ISC-29: Phase 1 implementation scope defined (MVP)
- [x] ISC-30: Phase 2 implementation scope defined (full capability)
- [x] ISC-31: What the user gains vs loses in recommended option
- [x] ISC-32: Remote Control server mode daemon setup specified
- [x] ISC-33: Channels + Remote Control interaction analyzed
- [x] ISC-34: Background agent / scheduled task integration per option
- [x] ISC-35: Notification routing (when to push vs when to wait)
- [x] ISC-36: Current direct-api.ts / message-classifier.ts relevance assessed
- [x] ISC-37: Agent SDK vs CLI spawning tradeoffs analyzed
- [x] ISC-38: VPS resource usage comparison per option
- [x] ISC-39: Multi-device access story per option
- [x] ISC-40: Offline/reconnection behavior per option
- [x] ISC-41: Security posture comparison per option
- [x] ISC-42: Cost analysis (subscription tier, VPS, bandwidth)

## Decisions

- **Winner: Option E+F2 Hybrid** -- "DAI as MCP Ecosystem with Hybrid Access." Remote Control for interactive, Telegram Channel for notifications, DAI intelligence delivered as MCP servers.
- **Option C (Headless Electron/Maestro) discarded** -- "Maestro" is Netflix's orchestrator, not Anthropic's. No Electron app to run headlessly.
- **Agent SDK (Option F) rejected** -- adds a Python layer for no benefit. Claude Code itself is the better runtime.
- **Key architectural insight:** DAI's value is memory + context + pipeline. Transport and session management should be delegated to Claude Code native features.

## Verification
