# Claude Channels + Maestro + DAI Cloud Evolution

**Date:** 2026-03-24
**Status:** Research complete, phased plan approved

## Summary

Deep research into Claude Channels, Maestro (RunMaestro/Maestro), and architectural options for DAI Cloud evolution. Red Team stress-tested the "burn the bridge" recommendation and found it would lose 10+ critical features. Conclusion: evolutionary enhancement, not revolutionary replacement.

## Key Findings

### Claude Channels
- MCP servers that push events into running Claude Code sessions
- Official Telegram plugin exists (`plugin:telegram@claude-plugins-official`)
- Works ONLY with subscription auth (no API key) — aligns with our constraint
- Permission relay: approve/deny tool use from chat (`yes <id>` / `no <id>`)
- **Research preview** — protocol may change, no stability guarantees
- Custom channels need `--dangerously-load-development-channels`
- Session-scoped: events lost when Claude process stops

### Claude Remote Control
- `claude remote-control` is real, works headlessly on VPS
- Flags: `--spawn worktree`, `--capacity N`, `--name "..."`
- Terminal-like experience from Claude mobile app or claude.ai/code
- Works with subscription auth
- Limitation: no crash recovery, 10-min network timeout kills session

### UserPromptSubmit Hook (game-changer)
- Fires BEFORE Claude processes a message
- Returns `additionalContext` injected automatically
- Functionally identical to ContextBuilder — deterministic, pre-message
- Works in bridge AND native Claude Code sessions

### Maestro Adoptable Features
| Feature | Effort | Value | Recommendation |
|---|---|---|---|
| Auto Run Playbooks | 30-40% | High | ADOPT |
| Git Worktree Pool | 50-60% | High | ADOPT |
| QR Code Dashboard | 2 hours | High UX | ADOPT |
| Context Compression | 40-50% | Medium | ADOPT selectively |
| Group Chat Moderator | 60-70% | Medium-High | ADOPT cautiously |
| Dual PTY | 100-150% | Low | DEFER |
| Provider Abstraction | 70-80% | Low | DEFER |

## Architecture Decision

**KEEP bridge + ENHANCE with MCP servers + ADD Remote Control as supplementary access**

### Why NOT "Burn the Bridge"
Bridge is a 30-module platform (13K lines). Channels handles ~20% of what it does. Would lose: statusline, compactFormat, /commands, dual-mode, Sonnet fast-path, dashboard, health monitor, auto-wrapup, crash recovery, pipeline.

### Phased Plan
1. **MCP Server Extraction** (2 weeks) — pai-memory + pai-context servers
2. **Hooks Migration** (1 week) — UserPromptSubmit replaces prompt injection
3. **Remote Control** (1 week) — supplementary interactive access
4. **Maestro Features** (3-4 weeks) — playbooks, worktrees, QR, compression

## Core Insight
DAI's value is the intelligence layer (memory, context, synthesis), not the transport layer. Extract intelligence into MCP servers = portable across bridge, native CLI, Remote Control.

## References
- Channels docs: code.claude.com/docs/en/channels-reference
- Remote Control: code.claude.com/docs/en/remote-control
- Hooks: code.claude.com/docs/en/hooks
- Maestro: github.com/RunMaestro/Maestro
- Full analysis: MEMORY/WORK/20260324-180500_channels-maestro-pai-cloud-evolution/
- Architecture deep-dive: MEMORY/WORK/20260324-120000_pai-cloud-architecture-rethink/ANALYSIS.md
