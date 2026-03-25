# PAI Cloud Architecture Rethink -- Deep Analysis

**Date:** 2026-03-24
**Author:** Nova (Deep Algorithm run)
**Status:** Strategic recommendation

---

## 1. First Principles Decomposition

Before evaluating options, strip away all implementation details. What does PAI Cloud *irreducibly* need?

**Primitive 1: Message Transport** -- Get human text from a mobile device to Claude's context window, and get Claude's response back. That's it. Telegram, web, smoke signals -- the transport is just a pipe.

**Primitive 2: Persistent Agent State** -- Claude needs memory across sessions. Episodic memory, semantic memory, whiteboards, project state. This is what makes PAI "personal" -- without it, it's just Claude.

**Primitive 3: Context Injection** -- Before Claude sees a message, relevant context from memory must be injected. This is the "brain" that makes responses coherent across days/weeks.

**Primitive 4: Tool Access** -- Claude must be able to read/write files, run commands, use git -- the full agentic toolkit. This requires a real filesystem, not a sandbox.

**Primitive 5: Permission Management** -- Someone must approve dangerous operations. Either auto-approve with policy, or relay prompts to the user.

**Primitive 6: Session Lifecycle** -- Context windows fill up. Sessions need graceful rotation with wrapup/synthesis. Auto-wrapup at pressure thresholds.

**Primitive 7: Cross-Agent Communication** -- Pipeline tasks between agents (Gregor/Isidore). Orchestrator for multi-step workflows.

**Key Insight:** Primitives 1, 4, 5, and 6 are now NATIVELY handled by Claude Code itself (Channels for transport, built-in tools, permission relay, session management). The current bridge reimplements all of these. Primitives 2, 3, and 7 are the only genuine value-add.

---

## 2. Current Bridge Module Audit

13,079 lines across 45 source files. Classification:

### DISCARD (replaced by Claude Code native features) -- ~5,800 lines

| Module | Lines | Replaced By |
|--------|-------|-------------|
| `telegram.ts` | 1,974 | Official Telegram Channel plugin |
| `claude.ts` | 977 | Agent SDK or direct CLI with Channels |
| `telegram-adapter.ts` | ~150 | Channel plugin handles all Telegram API |
| `format.ts` | ~200 | Channel reply tool handles formatting |
| `session.ts` | ~150 | Claude Code native session management |
| `statusline.ts` | ~100 | No longer needed (native UI) |
| `status-message.ts` | ~100 | Native session status |
| `auth.ts` | 182 | Channel sender gating |
| `injection-scan.ts` | ~120 | Channel sender allowlist |
| `rate-limiter.ts` | ~150 | Claude Code handles rate limits internally |
| `message-classifier.ts` | ~200 | All messages go through Channels to one session |
| `direct-api.ts` | ~200 | No longer needed if not splitting fast/slow path |
| `dashboard.ts` | 512 | Remote Control provides native web UI |
| `dashboard-html.ts` | 790 | Remote Control provides native web UI |
| `resource-guard.ts` | ~100 | Claude Code manages its own resources |

### KEEP (genuine value-add) -- ~2,400 lines

| Module | Lines | Why Keep |
|--------|-------|----------|
| `memory.ts` | 567 | Episodic + semantic memory, FTS5 -- core differentiator |
| `context.ts` | 269 | Scored context injection -- makes PAI personal |
| `synthesis.ts` | 402 | Importance-triggered synthesis, wrapup generation |
| `config.ts` | 484 | Feature flags, Zod validation (adapt for new arch) |
| `schemas.ts` | 349 | Zod schemas for cross-agent boundaries |
| `mode.ts` | ~200 | Workspace/project mode logic (adapt) |
| `daily-memory.ts` | ~130 | Daily memory file generation |

### MIGRATE (useful but needs restructuring) -- ~3,200 lines

| Module | Lines | Migration Path |
|--------|-------|----------------|
| `pipeline.ts` | 833 | Becomes MCP tool or scheduled task |
| `orchestrator.ts` | 858 | Adapt to Agent SDK multi-agent patterns |
| `reverse-pipeline.ts` | 286 | Simplify with Agent SDK |
| `projects.ts` | 590 | Adapt to Claude Code project/worktree model |
| `bridge.ts` | 673 | Thin orchestrator wiring only |
| `github.ts` | 204 | Keep as MCP tool |
| `scheduler.ts` | 260 | Adapt to Claude Code scheduled tasks |
| `prd-executor.ts` | 226 | Keep as MCP tool |
| `health-monitor.ts` | ~200 | Simplify for new architecture |

### Summary: ~44% of current code can be discarded. ~18% is pure value-add. ~24% needs migration.

---

## 3. Architecture Options -- Deep Analysis

### Option A: Keep Telegram Bridge + Add Channels/Remote Control Underneath

**Description:** Keep the existing Grammy-based Telegram bot but replace `ClaudeInvoker` (CLI spawning) with a persistent Claude Code session that has a custom Channel MCP server. The bridge becomes a thin relay between Grammy and the Channel notification API. Memory/context injection happens via MCP tools that Claude can call.

**Max/Pro Compatible:** Yes -- uses Claude Code CLI with claude.ai auth.
**Headless on VPS:** Yes -- `claude remote-control` in server mode + systemd.
**Mobile UX:** Chat-like (Telegram). No terminal experience.
**Reusable Code:** ~70% -- keeps Telegram layer, memory, context, pipeline.
**Complexity:** 2-3 weeks. Moderate refactor of ClaudeInvoker.
**Key Risks:** Still maintaining 2,000-line Telegram handler. Duplicates what official plugin does. Two layers of message routing (Grammy -> bridge -> Channel -> Claude).

**Verdict:** Incremental improvement but misses the point. Still fighting against the grain by maintaining a custom Telegram implementation when an official one exists.

### Option B: Web Terminal (xterm.js) + Mobile-Friendly Web UI

**Description:** Run Claude Code in a tmux session on VPS. Expose the terminal via a web-based terminal emulator (ttyd, wetty, or custom xterm.js frontend). Access from phone via mobile browser.

**Max/Pro Compatible:** Yes -- interactive Claude Code session.
**Headless on VPS:** Yes -- tmux + ttyd/wetty.
**Mobile UX:** Terminal-like, but mobile keyboards + terminal = terrible UX. Copy-paste issues, tiny text, no autocomplete.
**Reusable Code:** ~20% -- memory.ts, context.ts only. Everything else is replaced.
**Complexity:** 1-2 weeks for basic setup, 4-6 weeks for good mobile UX.
**Key Risks:** Terminal UX on mobile is fundamentally bad. No notifications when away. Authentication/TLS complexity. Raw terminal output, no formatting.

**Verdict:** Terminal-on-mobile sounds good in theory, terrible in practice. The Claude mobile app already provides a better interface than a web terminal.

### Option C: Headless Electron (Maestro)

**Description:** Run an Electron app headlessly on VPS using Xvfb (virtual framebuffer).

**Max/Pro Compatible:** N/A
**Headless on VPS:** Technically possible with Xvfb but fragile.

**CRITICAL FINDING:** "Maestro" under `anthropics/` on GitHub is Netflix's workflow orchestrator (Java/Spring Boot), NOT an Anthropic multi-agent tool. There is no "Anthropic Maestro" Electron app to run headlessly. This option is based on a misconception.

**Headless Electron in general:** You CAN run Electron headlessly (`electron --headless`, or Xvfb). Puppeteer does this routinely. But there's no Electron-based Claude Code app to run this way. Claude Code is a CLI tool, and `claude.ai/code` is a web app -- neither uses Electron.

**Verdict:** Non-starter. The premise is wrong. Discard entirely.

### Option D: Thin Orchestrator Using Claude Channels as Transport

**Description:** Build a custom MCP Channel server that bridges Telegram to Claude Code sessions. The MCP server runs alongside Claude Code on VPS, handles Telegram polling, pushes messages into the session via Channel notifications, and exposes a reply tool for Claude to send messages back. Memory and context injection happen via additional MCP tools.

This is architecturally identical to the official Telegram Channel plugin, but extended with PAI's memory/context/pipeline capabilities as additional MCP tools.

**Max/Pro Compatible:** Yes -- Channels require claude.ai login, not API key.
**Headless on VPS:** Yes -- `claude --channels server:pai-telegram` in a systemd-managed tmux or via Remote Control server mode.
**Mobile UX:** Chat-like (Telegram). Same as current.
**Reusable Code:** ~40% -- memory.ts, context.ts, synthesis.ts, schemas.ts become MCP tools. Everything else is rewritten as a single MCP server.
**Complexity:** 3-4 weeks.
**Key Risks:** Channels in research preview. Custom MCP server needs `--dangerously-load-development-channels` flag (until approved). No native terminal experience.

**Memory/Context Injection Strategy:** Instead of injecting context into the CLI prompt string, expose it as MCP tools: `memory_recall(query)`, `context_inject(topic)`, `memory_store(episode)`. Claude calls these proactively. Alternatively, use CLAUDE.md and hooks for automatic injection.

**Verdict:** Clean architecture that aligns with Anthropic's direction. But still limited to chat-like Telegram UX. Good for notifications and quick tasks.

### Option E: Hybrid -- Remote Control + Telegram Channel

**Description:** Two complementary access paths to the SAME Claude Code session:

1. **Remote Control** (primary): `claude remote-control --name "PAI Cloud"` runs on VPS. User connects via Claude mobile app or claude.ai/code for full interactive experience. Terminal-like, supports all tools, permission prompts via native UI.

2. **Telegram Channel** (secondary): Official or custom Channel plugin for push notifications, quick questions, and async interaction when not actively at a session. Claude can proactively notify via Telegram when tasks complete or attention is needed.

Both connect to the same long-running Claude Code process on VPS. Memory and context injection via CLAUDE.md, hooks, and MCP tools.

**Max/Pro Compatible:** Yes -- both Remote Control and Channels require claude.ai auth.
**Headless on VPS:** Yes -- `claude remote-control` is designed for this. Server mode supports `--capacity 32` and `--spawn worktree`.
**Mobile UX:** **Best of both worlds.** Claude mobile app for interactive work (terminal-quality). Telegram for notifications and quick queries.
**Reusable Code:** ~35% -- memory.ts, context.ts, synthesis.ts, pipeline logic become MCP tools or hooks.
**Complexity:** 4-6 weeks for full implementation.
**Key Risks:** Remote Control requires persistent network (10-min timeout). Two access surfaces to manage. Channels in research preview.

**Session Management:** Remote Control handles this natively. Server mode auto-spawns sessions. `--spawn worktree` gives git isolation per session.

**Permission Model:** Remote Control relays permission prompts to Claude mobile app natively. Telegram Channel can also relay via `claude/channel/permission` capability. User approves from whichever device they're on.

**Cross-Agent Pipeline:** Pipeline becomes MCP tools that Claude can call. Or use Agent SDK to spawn sub-agents for pipeline tasks. Orchestrator logic moves into agent definitions.

**Verdict:** This is the clear winner. It leverages everything Anthropic has built, adds PAI's unique value (memory, context), and provides the best mobile experience possible.

### Option F: Agent SDK Daemon with Custom Transport Layer

**Description:** Use the Claude Agent SDK (Python) to build a persistent daemon that maintains conversation state. The SDK wraps the CLI but provides programmatic control over sessions, tools, hooks, and streaming. Custom transport layer handles Telegram, web UI, or any other client.

**Max/Pro Compatible:** Yes -- SDK uses Claude Code CLI auth.
**Headless on VPS:** Yes -- Python daemon with systemd.
**Mobile UX:** Depends on client. Could build a nice progressive web app.
**Reusable Code:** ~30% -- memory logic ports to Python or stays as MCP server.
**Complexity:** 6-10 weeks. Rewrite in Python. Build custom web client.
**Key Risks:** Rewrite from TypeScript to Python. SDK is new, may have gaps. Building custom web UI is significant work. Reinvents what Remote Control + Channels already provide.

**Verdict:** Most flexible but most effort. Why build what Anthropic already built? Only justified if Remote Control or Channels have fundamental limitations that prevent the use case.

### Option F2 (Novel): "PAI as MCP Server Ecosystem"

**Description:** Instead of a monolithic bridge, decompose PAI into a set of MCP servers that Claude Code loads natively:

1. **pai-memory** MCP server: Exposes `memory_store`, `memory_recall`, `memory_search`, `whiteboard_read`, `whiteboard_write` tools. Backed by SQLite.
2. **pai-context** MCP server: Hooks into session start to inject relevant context. Exposes `context_suggest` tool.
3. **pai-pipeline** MCP server: Exposes `delegate_task`, `check_pipeline`, `submit_result` tools for cross-agent work.
4. **pai-notify** MCP server (Channel): Bridges Telegram for notifications. Uses official plugin pattern.

Claude Code loads these via `.mcp.json`. No bridge at all. Claude Code IS the runtime. Remote Control provides mobile access. Telegram Channel provides notifications.

**Max/Pro Compatible:** Yes.
**Headless on VPS:** Yes.
**Mobile UX:** Same as Option E (Remote Control + Telegram).
**Reusable Code:** ~60% -- memory.ts and context.ts port almost directly to MCP server wrappers. Pipeline logic becomes MCP tools.
**Complexity:** 3-4 weeks. Small, focused MCP servers.
**Key Risks:** MCP server ecosystem management. Multiple processes to monitor.

**Verdict:** Elegant, modular, future-proof. Can be combined with Option E's hybrid access model. This might be the true winner when combined.

---

## 4. Comparison Matrix

| Dimension | A: Bridge+ | B: Web Term | C: Electron | D: Channels | E: Hybrid | F: SDK | F2: MCP Eco |
|-----------|-----------|-------------|-------------|-------------|-----------|--------|-------------|
| Max/Pro | Yes | Yes | N/A | Yes | Yes | Yes | Yes |
| Headless VPS | Yes | Yes | No | Yes | Yes | Yes | Yes |
| Mobile UX | Chat | Bad | N/A | Chat | **Best** | Custom | **Best** |
| Reuse % | 70% | 20% | 0% | 40% | 35% | 30% | **60%** |
| Weeks | 2-3 | 4-6 | N/A | 3-4 | 4-6 | 6-10 | **3-4** |
| Terminal feel | No | Yes (bad) | N/A | No | **Yes** | Maybe | **Yes** |
| Notifications | Yes | No | N/A | Yes | **Yes** | Custom | **Yes** |
| Future-proof | Low | Low | N/A | Med | **High** | Med | **High** |
| Permission relay | Custom | Manual | N/A | Yes | **Native** | Custom | **Native** |
| Multi-device | No | Yes | N/A | No | **Yes** | Custom | **Yes** |
| Session mgmt | Custom | Manual | N/A | Custom | **Native** | SDK | **Native** |
| Anthropic alignment | Low | None | N/A | High | **High** | Med | **Highest** |

---

## 5. Official Telegram Plugin vs Current Bridge

| Capability | Official Plugin | Current Bridge |
|------------|----------------|----------------|
| Message routing | Native MCP Channel | Custom Grammy + CLI spawn |
| Sender auth | Pairing + allowlist | Telegram user ID check |
| Reply formatting | MCP reply tool | Custom format.ts + chunkMessage |
| Permission relay | Native `claude/channel/permission` | Not supported |
| Photo handling | Auto-download to inbox | Not implemented |
| Message editing | `edit_message` tool | Not implemented |
| Reactions | `react` tool | Not implemented |
| Session management | Tied to Claude Code session | Custom SessionManager |
| Memory/context | None (gap!) | Full MemoryStore + ContextBuilder |
| Pipeline | None (gap!) | Full cross-agent pipeline |
| Mode management | None (gap!) | Workspace/Project modes |
| Auto-wrapup | None (gap!) | Context pressure detection |
| Formatting | Basic text | compactFormat + statusline |

**Key insight:** The official plugin handles the transport perfectly but has ZERO application-layer intelligence. PAI's value is entirely in the gaps. This means the right architecture adds PAI's intelligence ON TOP OF the official transport, not instead of it.

---

## 6. Recommended Architecture: Option E + F2 Hybrid

**"PAI as MCP Ecosystem with Hybrid Access"**

### Architecture

```
                    ┌──────────────────────────────┐
                    │   Claude Code (VPS)           │
                    │   claude remote-control       │
                    │   --name "PAI Cloud"          │
                    │   --channels telegram         │
                    │                               │
                    │   Loaded MCP Servers:          │
                    │   ├── pai-memory (.mcp.json)  │
                    │   ├── pai-context (.mcp.json) │
                    │   ├── pai-pipeline (.mcp.json)│
                    │   └── telegram (Channel)      │
                    │                               │
                    │   CLAUDE.md + Hooks:           │
                    │   ├── Memory injection hook    │
                    │   ├── Auto-wrapup hook         │
                    │   └── Synthesis hook           │
                    └──────────┬───────────┬────────┘
                               │           │
                    ┌──────────┘           └──────────┐
                    │                                  │
           ┌────────▼────────┐              ┌──────────▼──────────┐
           │ Remote Control  │              │ Telegram Channel    │
           │                 │              │                     │
           │ claude.ai/code  │              │ Push notifications  │
           │ Claude iOS app  │              │ Quick questions     │
           │ Claude Android  │              │ Permission relay    │
           │                 │              │ Async updates       │
           │ INTERACTIVE     │              │ REACTIVE            │
           └─────────────────┘              └─────────────────────┘
```

### What Gets Built

**Phase 1 (MVP, 2 weeks):**
1. `pai-memory` MCP server -- wraps existing MemoryStore SQLite operations as MCP tools
2. `pai-context` MCP server -- wraps ContextBuilder as MCP tool + system prompt injection via CLAUDE.md
3. VPS setup: `claude remote-control` in systemd, with Telegram Channel plugin installed
4. `.mcp.json` configuration loading all PAI MCP servers
5. Basic CLAUDE.md with PAI identity, memory instructions, auto-wrapup guidance

**Phase 2 (Full capability, 2-3 more weeks):**
6. `pai-pipeline` MCP server -- cross-agent task delegation and result routing
7. PostToolUse hook for automatic memory storage on important interactions
8. PreToolUse hook for context injection on message receipt
9. Scheduled task for daily memory consolidation
10. Health monitoring via MCP tool (simplified from current HealthMonitor)
11. Synthesis loop triggered by importance scoring

### What You Gain

- **Terminal-like experience on mobile** via Claude iOS/Android app and claude.ai/code (this is the big one)
- **Native permission relay** -- approve tool use from your phone
- **50-60% code reduction** -- from 13,000 lines to ~5,000 lines of focused MCP servers
- **Zero custom transport code** -- Anthropic maintains Telegram/Discord/Remote Control
- **Future features for free** -- as Claude Code adds capabilities, PAI gets them automatically
- **Multi-device access** -- phone, tablet, laptop, all to same session
- **Worktree isolation** for parallel agent work -- `--spawn worktree`
- **Agent teams** for complex tasks -- native Claude Code feature
- **No more CLI process spawning/parsing** -- the biggest maintenance burden eliminated
- **Session reconnection** -- Remote Control auto-reconnects after network drops

### What You Lose

- **Telegram-native UX polish** -- statusline, compactFormat, custom /commands. The Claude mobile app has its own UX.
- **Dual-mode (Workspace/Project)** -- replaced by Claude Code's native project context and worktrees
- **Dashboard** -- replaced by Remote Control's native web UI
- **Message classification (Sonnet fast-path)** -- all messages go through one session. Could add back as hook-based routing.
- **Custom formatting** -- Claude Code formats its own output
- **Precise context % tracking** -- Claude Code manages context window internally

### Deployment

```bash
# VPS systemd service: /etc/systemd/system/pai-cloud.service
[Service]
ExecStart=/home/isidore_cloud/.npm-global/bin/claude remote-control \
  --name "PAI Cloud" \
  --channels plugin:telegram@claude-plugins-official \
  --spawn same-dir \
  --capacity 4 \
  --mcp-config /home/isidore_cloud/.config/PAI/mcp-servers.json \
  --dangerously-skip-permissions
WorkingDirectory=/home/isidore_cloud/workspace
Restart=always
RestartSec=5
User=isidore_cloud
Environment=HOME=/home/isidore_cloud
```

```json
// /home/isidore_cloud/.config/PAI/mcp-servers.json
{
  "mcpServers": {
    "pai-memory": {
      "command": "bun",
      "args": ["/home/isidore_cloud/projects/pai-mcp/src/memory-server.ts"]
    },
    "pai-context": {
      "command": "bun",
      "args": ["/home/isidore_cloud/projects/pai-mcp/src/context-server.ts"]
    },
    "pai-pipeline": {
      "command": "bun",
      "args": ["/home/isidore_cloud/projects/pai-mcp/src/pipeline-server.ts"]
    }
  }
}
```

### Failure Mode Analysis

**Failure 1: Remote Control daemon dies**
- Mitigation: systemd `Restart=always RestartSec=5`. Health check via cron `curl` to claude.ai session status. Telegram notification on restart.
- Impact: 5-15 second interruption. Session state preserved (Remote Control reconnects).

**Failure 2: Network outage > 10 minutes**
- Mitigation: Remote Control exits, systemd restarts. Session ID preserved for `--resume`. Telegram still works independently.
- Impact: New session created. Previous context lost unless wrapup was triggered. Mitigate with aggressive auto-wrapup and persistent CLAUDE.md.

**Failure 3: MCP server crashes**
- Mitigation: Claude Code logs MCP errors. Memory MCP server is stateless (SQLite handles persistence). Restart of Claude Code session restarts all MCP servers.
- Impact: Temporary loss of memory/context tools. Claude still functions, just without PAI intelligence.

**Failure 4: Channels API breaks in preview**
- Mitigation: Telegram Channel is an independent concern. Memory, context, and pipeline still work via MCP. Fall back to Remote Control only.
- Impact: Loss of Telegram notifications. Interactive access via Remote Control unaffected.

### Migration Plan

**Week 1: Foundation**
1. Create `pai-mcp/` project (new repo or subdirectory)
2. Port `MemoryStore` to `memory-server.ts` MCP server (567 lines -> ~300 lines)
3. Port `ContextBuilder` to `context-server.ts` MCP server (269 lines -> ~200 lines)
4. Write `.mcp.json` configuration
5. Test locally: `claude --mcp-config ./mcp.json` with memory tools

**Week 2: VPS Deployment**
6. Install Telegram Channel plugin on VPS
7. Set up `claude remote-control` with systemd
8. Configure CLAUDE.md with PAI identity and memory instructions
9. Pair Telegram account
10. Test: send message from phone via Telegram, approve permission from Claude app
11. Test: connect via claude.ai/code and do interactive work

**Week 3: Pipeline + Intelligence**
12. Port pipeline logic to `pipeline-server.ts` MCP server
13. Add PostToolUse hook for importance scoring
14. Add scheduled task for daily memory consolidation
15. Port synthesis logic to hook or MCP tool

**Week 4: Polish + Cutover**
16. Verify all critical workflows work
17. Run old and new systems in parallel for 3 days
18. Migrate memory.db to new location
19. Decommission old bridge
20. Update CLAUDE.md and documentation

### Security Posture

| Aspect | Current Bridge | New Architecture |
|--------|---------------|-----------------|
| Auth | Custom Telegram user ID check | Native Channel pairing + allowlist |
| Transport | Grammy long-polling | MCP stdio (local only) + TLS (Remote Control) |
| Injection | Custom injection-scan.ts | Channel sender gating (never reaches Claude) |
| Permissions | Auto-approve everything | Native permission relay or `--dangerously-skip-permissions` with policy |
| Dashboard | Custom auth token | Remote Control via Anthropic OAuth |
| File access | Claude CLI has full access | Same, but with native permission model |

### VPS Resource Usage

| Metric | Current Bridge | New Architecture |
|--------|---------------|-----------------|
| Processes | 1 (bridge) + N (Claude CLI spawns) | 1 (Claude Code) + 3 (MCP servers) |
| Memory | ~200MB bridge + ~500MB per CLI | ~500MB Claude Code + ~50MB per MCP |
| CPU | Spikes on CLI spawn | Steady (persistent session) |
| Disk I/O | SQLite + CLI startup | SQLite only |
| Startup time | ~31K tokens per invocation | One-time session start, then persistent |

### Cost Analysis

| Item | Current | New |
|------|---------|-----|
| Claude Max subscription | $100/month | $100/month (same) |
| VPS (OVH) | ~$10/month | ~$10/month (same) |
| API key (direct-api.ts) | Not yet active | Eliminated entirely |
| Token usage | ~31K per invocation (cache misses) | Persistent session = heavy caching |
| Bandwidth | Minimal | Minimal (+ Remote Control heartbeat) |

---

## 7. Agent SDK vs CLI Spawning Tradeoffs

| Dimension | CLI Spawning (current) | Agent SDK | Channels + Remote Control |
|-----------|----------------------|-----------|--------------------------|
| Session persistence | `--resume` (fragile) | `ClaudeSDKClient` (managed) | Native (persistent session) |
| Output parsing | Custom JSON stream parser | SDK handles it | Not needed (native UI) |
| Error handling | Custom stderr parsing | SDK exceptions | Native |
| Tool access | Full | Full | Full |
| Streaming | Custom implementation | Built-in async iterator | Native |
| Memory overhead | New process per message | Single Python process | Single Claude Code process |
| Startup latency | ~2-5s per invocation | Amortized | Zero (persistent) |
| Maintenance burden | High (parsing, error handling) | Medium (SDK updates) | **Low** (Anthropic maintains) |
| Subscription compat | Yes | Yes | Yes |

**Verdict:** Agent SDK is better than CLI spawning but worse than "just use Claude Code natively with MCP servers." The SDK exists for embedding Claude in other applications. PAI's use case is better served by running Claude Code itself and extending it via MCP.

---

## 8. Offline/Reconnection Behavior

| Scenario | Current Bridge | Recommended Architecture |
|----------|---------------|-------------------------|
| VPS network blip (< 10 min) | CLI process may hang | Remote Control auto-reconnects |
| VPS network outage (> 10 min) | CLI process timeout | Remote Control exits, systemd restarts |
| Phone goes offline | Telegram queues messages | Telegram queues, Claude app reconnects |
| VPS reboot | systemd restarts bridge | systemd restarts `claude remote-control` |
| Claude Code crash | Bridge spawns new CLI | systemd restarts, session lost (CLAUDE.md persists) |

---

## 9. Notification Routing Strategy

In the hybrid model, the Telegram Channel becomes the notification/async channel:

**Push via Telegram when:**
- A pipeline task completes
- A scheduled task finishes
- An error needs attention
- Context pressure approaching threshold (wrapup suggestion)
- A long-running operation completes

**Wait for interactive session when:**
- User initiates a conversation
- Complex multi-step work
- File editing / code review
- Anything requiring tool approval

This maps naturally to the Channel's one-way (notification) and two-way (reply) capabilities.

---

## 10. What About Claude Code Hooks?

Hooks are the secret weapon that makes this architecture work. Instead of wrapping Claude in a bridge, you inject behavior INTO Claude's loop:

**PreToolUse Hook:** Before any tool call, inject relevant context from memory. "Before Claude reads a file, check if there's relevant memory about this project."

**PostToolUse Hook:** After tool calls, score importance and store memories. "After Claude finishes a task, score its importance and store if significant."

**Notification Hook (Channel):** When a Telegram message arrives, it already has context from the `pai-context` MCP server in the system prompt.

**CLAUDE.md:** The persistent system prompt. Contains PAI identity, memory instructions, project context, behavioral guidelines. This replaces context injection -- it's always there.

Hooks + CLAUDE.md + MCP servers = PAI's intelligence layer, running inside Claude Code instead of wrapping it.

---

## 11. Multi-Device Access Story

**Current:** Only Telegram. One device at a time (phone).

**Recommended:**
- **Phone (Claude app):** Full interactive session via Remote Control. Permission prompts appear natively.
- **Phone (Telegram):** Quick questions, notifications, async tasks.
- **Tablet (claude.ai/code):** Full web interface to same session.
- **Laptop (terminal):** Direct `claude` CLI to same VPS session via SSH, or claude.ai/code.
- **All devices simultaneously:** Remote Control supports this. Messages sync across all connected surfaces.

This is a massive UX upgrade from current single-device Telegram-only access.
