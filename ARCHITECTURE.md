# PAI Cloud Solution — Architecture & Reference Guide

> **One identity, two runtimes.** Deploy your AI assistant to a VPS so it's always reachable — from your desk, your phone, or anywhere in the world.

---

## Table of Contents

1. [Current State](#current-state-2026-04-02)
2. [The Vision](#the-vision)
3. [How It Works — The Big Picture](#how-it-works--the-big-picture)
4. [Naming Convention](#naming-convention)
5. [System Architecture](#system-architecture)
6. [Communication Channels](#communication-channels)
7. [The Bridge Service](#the-bridge-service)
8. [Dual-Mode System](#dual-mode-system)
9. [Memory & Context](#memory--context)
10. [Session Management](#session-management)
11. [Project Management](#project-management)
12. [Cross-User Pipeline (Gregor↔Isidore Cloud)](#cross-user-pipeline-gregorisidore-cloud)
13. [Autonomous Systems](#autonomous-systems)
14. [VPS Infrastructure](#vps-infrastructure)
15. [Security Model](#security-model)
16. [Deployment Guide](#deployment-guide)
17. [File Reference](#file-reference)
18. [Troubleshooting](#troubleshooting)
19. [What's Next](#whats-next)
20. [Replicating This System](#replicating-this-system)

---

## Current State (2026-04-18)

**All 5 VPS services active.** `isidore-cloud-bridge`, `isidore-cloud-channels`, `isidore-cloud-pipeline`, `isidore-cloud-dashboard`, and `isidore-cloud-remote` all up. Bridge remains PRIMARY surface; Channels and Remote Control are supplementary.

**Channels live.** `@isidore_channel_bot` responds via Telegram using Claude Channels plugin (`--channels plugin:telegram@claude-plugins-official`). Claude Code runs interactively in tmux with `access.json` pre-configured (allowlist). MCP servers (`pai-memory`, `pai-context`) auto-load via `.mcp.json`.

**Standalone services.** `standalone/pipeline-watcher.ts` handles cross-agent task dispatch. `isidore-cloud-dashboard` serves the monitoring UI. `isidore-cloud-remote` enables mobile-app control.

**Bridge pipeline disabled.** `PIPELINE_ENABLED=0` in `bridge.env`. Bridge still owns Telegram bot (`@IsidoreCloudBot`), the scheduler, `ModeManager`, `HealthMonitor`, `MessageClassifier`, the gateway, and guardrails — its remaining unique value.

**Migration progress.** Phases 1 (MCP), 2 (commands→skills, 6 skills live), 3 (pipeline), 4 (dashboard), 6 (Remote Control) all COMPLETE. Phase 5 (bridge retirement) REFRESHED as a 4-move additive migration — see [`docs/roadmap.md`](docs/roadmap.md) and [`docs/decisions/0001-retire-bridge-additively.md`](docs/decisions/0001-retire-bridge-additively.md).

**Phase 5 status (2026-04-18):** Move 1 (Stop hook) code complete with 17 tests. Move 2 (`notify.sh` + systemd templates) scaffolding landed. Move 3 (Haiku scorer) pure logic landed with 11 tests. Move 4 (Grammy shutdown) GATED on Anthropic resolving [claude-code#36477](https://github.com/anthropics/claude-code/issues/36477).

---

## The Vision

Claude Code is powerful but local — it lives in your terminal, on your machine. When you close the lid, it's gone. You can't message it from your phone on the train. You can't have it running a background task while you sleep.

**PAI Cloud Solution solves this** by deploying a second instance of your AI assistant (same personality, same knowledge, same skills) to a VPS that runs 24/7. You talk to it over Telegram from your phone, or SSH in for deep work. The cloud instance has its own SQLite-backed memory, context injection, and autonomous capabilities.

The result: **one assistant, always available, everywhere.**

### Design Principles

- **One identity, two runtimes.** Isidore is one person. "Isidore" runs locally, "Isidore Cloud" runs on the VPS. They share personality, knowledge, and relationship history. They differ only in environment.
- **Channel-agnostic conversations.** Whether you SSH in, send a Telegram message, or send an email — it's the same conversation, same session, same context.
- **Memory-first persistence.** SQLite-backed episodic + semantic memory (`memory.db`) is the sole persistence layer. No file-based handoff — episodes, knowledge, project state, session summaries, and whiteboards all live in memory.db.
- **Dual-mode operation.** Workspace mode (default) for autonomous work with auto-session management. Project mode for focused git-repo work with manual session control.
- **Minimal infrastructure.** A single small VPS, a Telegram bot token, and a Git repo. No Kubernetes, no Docker, no cloud functions. Just systemd, Bun, and shell scripts.
- **Coexistence and collaboration.** The VPS is shared with Gregor/OpenClaw. Each has its own Linux user and systemd services. They don't interfere — and when they need to collaborate, a shared file-based pipeline (`/var/lib/pai-pipeline/`) enables cross-user task exchange.

---

## How It Works — The Big Picture

```
You (Marius)
│
├── At your desk (WSL2)
│   └── Terminal → claude          ← "Isidore" (local)
│       └── Full interactive session, all tools, voice, browser
│
├── On your phone / away from home
│   └── Telegram → @IsidoreCloudBot
│       └── Bridge service → claude --resume  ← "Isidore Cloud" (VPS)
│           ├── Memory context injection (memory.db → prompt prefix)
│           ├── Statusline on every reply (mode/time/context%)
│           └── Auto-wrapup on context pressure (workspace mode)
│
├── On your phone (Claude app)
│   └── Claude app → Remote Control
│       └── claude remote-control --spawn worktree  ← Direct CLI access
│           └── PAI hooks fire on all sessions (same as local)
│
├── Via Channels bot (Isidore Direct)
│   └── Telegram → Claude Channels plugin
│       └── claude --channels plugin:telegram  ← Interactive session
│           └── Native Claude session with hooks + MCP
│
├── Via email (planned)
│   └── IMAP poll → claude --resume
│       └── Response via SMTP
│
├── Automated tasks (scheduler)
│   └── Pipeline task → claude -p "task"    ← One-shot, no session
│       ├── Daily synthesis (02:00 UTC)
│       ├── Daily memory summary (22:55 UTC)
│       └── Weekly health review (Sunday 03:00 UTC)
│
└── Cross-agent collaboration
    └── Gregor ↔ Isidore Cloud via /var/lib/pai-pipeline/
        ├── Forward pipeline (Gregor → Isidore)
        ├── Reverse pipeline (Isidore → Gregor via /delegate)
        └── DAG workflows (multi-step, mixed assignees)
```

**The bridge service** handles Telegram communication via `@IsidoreCloudBot`: a Bun/TypeScript process that runs 24/7, listens on Telegram (long polling), authenticates you, forwards your messages to Claude Code CLI, formats the response for mobile, and sends it back. Pipeline processing has been extracted to a standalone daemon (`isidore-cloud-pipeline`). **Architecture direction:** migrating to Claude Channels as the primary access surface — Channels (`@isidore_channel_bot`) is now live and provides native interactive sessions. See `Plans/phase-fg-channels-remote-control.md`.

**Session continuity** works via two mechanisms: (1) Claude Code's `--resume` flag with session IDs stored in `~/.claude/active-session-id`, and (2) session summaries stored in `memory.db` that are injected as context when sessions rotate. The bridge generates session summaries on `/clear`, `/wrapup`, and shutdown.

---

## Naming Convention

The naming distinguishes the *runtime*, not the *identity*:

| Aspect | Local (WSL2) | VPS |
|--------|-------------|-----|
| **Identity** | Isidore | Isidore Cloud |
| **Display name** | ISIDORE | ISIDORE CLOUD |
| **Linux user** | `mj` (your own) | `isidore_cloud` |
| **SSH alias** | N/A (local) | `isidore_cloud` |
| **SSH key** | N/A | `~/.ssh/id_ed25519_isidore_cloud` |
| **systemd services** | N/A | `isidore-cloud-bridge`, `isidore-cloud-remote`, `isidore-cloud-channels`, `isidore-cloud-tmux` |
| **tmux session** | N/A | `isidore_cloud` |
| **Config directory** | N/A | `~/.config/isidore_cloud/` |
| **Home directory** | `/home/mj/` | `/home/isidore_cloud/` |
| **Claude settings identity** | `"name": "Isidore"` | `"name": "Isidore Cloud"` |

---

## System Architecture

### VPS Layout

```
VPS: 213.199.32.18 (Ubuntu 24.04, Contabo)
├── User: openclaw (SSH alias: vps)
│   ├── Gregor / OpenClaw services
│   └── ~/scripts/                     # Pipeline sender scripts (pai-submit.sh, etc.)
│
├── User: isidore_cloud (SSH alias: isidore_cloud)
│   ├── ~/projects/my-pai-cloud-solution/      # Deployed project code
│   │   ├── src/                       # TypeScript bridge + helpers
│   │   ├── standalone/                # Standalone daemons (pipeline-watcher.ts)
│   │   ├── scripts/                   # Deployment & maintenance
│   │   ├── config/                    # Project registry (projects.json)
│   │   └── systemd/                   # Service definitions
│   │
│   ├── ~/projects/*/                  # Other project repos (managed by /newproject)
│   │
│   ├── ~/workspace/                   # Workspace mode home directory (git-tracked)
│   │   └── memory/                    # Daily memory files (YYYY-MM-DD.md)
│   │
│   ├── ~/.claude/                     # Claude Code configuration
│   │   ├── settings.json              # PAI settings (Isidore Cloud identity)
│   │   ├── skills/PAI/               # Full PAI skill set
│   │   ├── hooks/                    # PAI hooks (non-interactive subset)
│   │   ├── active-session-id         # Current conversation session pointer
│   │   └── memory.db                 # SQLite memory store (episodes, knowledge, state)
│   │
│   ├── ~/.config/isidore_cloud/
│   │   └── bridge.env                # Secrets (Telegram token, paths)
│   │
│   ├── ~/.bun/bin/bun                # Bun runtime
│   ├── ~/.npm-global/bin/claude      # Claude Code CLI
│   └── ~/.ssh/
│       ├── authorized_keys           # Your SSH public key
│       ├── id_ed25519_github         # Deploy key for pai-knowledge repo
│       └── config                    # GitHub SSH configuration
│
├── Shared: /var/lib/pai-pipeline/     # Cross-user task queue (group: pai, mode: 2770)
│   ├── tasks/                         # Incoming task files (written by Gregor)
│   ├── results/                       # Result files (written by Isidore Cloud)
│   ├── ack/                           # Processed tasks (moved after completion)
│   ├── reverse-tasks/                 # Delegation files (Isidore → Gregor)
│   ├── reverse-results/               # Delegation results (Gregor → Isidore)
│   ├── reverse-ack/                   # Processed reverse tasks
│   ├── workflows/                     # Persisted orchestrator DAG workflows
│   └── branch-locks.json             # Active branch isolation locks
│
└── Systemd services:
    ├── isidore-cloud-bridge.service    # Telegram bot + dashboard + scheduler (pipeline disabled)
    ├── isidore-cloud-pipeline.service  # Standalone pipeline watcher daemon (ACTIVE)
    ├── isidore-cloud-channels.service  # Claude Channels Telegram plugin (ACTIVE — @isidore_channel_bot)
    ├── isidore-cloud-remote.service    # Remote Control server mode (pending trust)
    └── isidore-cloud-tmux.service      # Persistent tmux (for SSH sessions + Channels)
```

### Local Layout

```
Local: WSL2 (your machine)
├── ~/projects/my-pai-cloud-solution/  # Source code (this repo)
├── ~/.ssh/
│   ├── id_ed25519_isidore_cloud      # SSH key for VPS access
│   └── config                        # SSH alias: isidore_cloud → VPS
└── ~/.claude/                         # Claude Code (local Isidore)
    └── skills/PAI/                    # Full PAI skill set
```

---

## Communication Channels

### 1. Telegram (Primary Mobile Channel)

The Telegram bot (`@IsidoreCloudBot`) is the main way to talk to Isidore Cloud from your phone.

**How it works:**
1. You send a message in Telegram
2. Grammy bot receives it via long polling (no webhook needed)
3. Middleware checks your Telegram user ID against the allow list
4. Your message is forwarded to `claude --resume <session-id> -p "your message" --output-format json`
5. Claude's response is parsed, run through the compact formatter (strips PAI Algorithm verbosity), chunked to fit Telegram's 4096-char limit, and sent back

**Bot commands:**

| Command | Description |
|---------|-------------|
| `/start` | Welcome message, current mode, available commands |
| `/status` | Mode, session metrics (msg count, tokens, context %), memory stats |
| `/workspace` or `/home` | Switch to workspace mode (auto-pushes current project) |
| `/project <name>` | Switch to project mode (auto-push current, pull target, restore session) |
| `/wrapup` | Manual workspace session wrapup (generates summary, rotates session) |
| `/keep` | Cancel pending auto-wrapup, extend threshold by 50% |
| `/sync` | Git commit + push current project |
| `/pull` | Git pull current project |
| `/clear` | Generate session summary + archive session + start fresh |
| `/compact` | Send `/compact` to Claude to compress context |
| `/new` | Start fresh conversation (archives current session) |
| `/oneshot <msg>` | One-shot query without session (for quick questions) |
| `/quick <msg>` | Quick query using Haiku model (fast, cheap) |
| `/delegate <prompt>` | Delegate a task to Gregor via reverse pipeline |
| `/workflow create <prompt>` | Create a DAG workflow (auto-decomposes into steps) |
| `/workflows` | List all workflows with status |
| `/cancel <id>` | Cancel an active workflow |
| `/pipeline` | Pipeline status (forward + reverse + workflows) |
| `/branches` | Show active branch isolation locks |
| `/schedule` | Scheduler status (cron jobs) |
| `/newproject <name>` | Create new project (GitHub repo + VPS dir + scaffold + registry) |
| `/deleteproject <name>` | Remove a project from the registry |

**Authentication:** Only one Telegram user ID is allowed (configured in `bridge.env`). All other users get "Unauthorized. This bot is private."

### 2. SSH + tmux (Deep Work Channel)

For extended interactive sessions — coding, debugging, multi-step work:

```bash
ssh isidore_cloud              # Connect to VPS
tmux attach -t isidore_cloud   # Attach to persistent tmux session
claude                         # Start or resume Claude Code interactively
```

The tmux session persists across SSH disconnections. When you SSH in later, your Claude session is still there.

**Session sharing:** Both tmux (interactive) and Telegram (programmatic) read/write the same session ID file. If you start a conversation in Telegram and then SSH in, `claude --resume` picks up the same conversation.

### 3. Claude Channels (Isidore Direct — Live)

Claude Channels Telegram plugin provides native interactive sessions without the bridge intermediary. **This is now the primary interactive access surface.**

**How it works:**
1. You message `@isidore_channel_bot` in Telegram
2. Claude Channels plugin receives the message natively
3. Claude runs an interactive session in tmux (`claude --channels plugin:telegram@claude-plugins-official`)
4. `access.json` pre-configured with allowlist — only authorized users can interact
5. MCP servers (`pai-memory-server`, `pai-context-server`) auto-load via `.mcp.json`
6. PAI hooks fire on session start and tool use
7. Responses sent directly — no bridge formatting, no compact stripping

**Advantages over bridge:** Native Claude session (not one-shot CLI), permission relay, efficient hook invocation (SessionStart once, not per-message), no stream-json parsing overhead, MCP tools available natively.

### 4. Remote Control (Pending)

Claude Remote Control enables direct CLI access from the Claude mobile app.

**How it works:**
1. You open the Claude app on your phone
2. Remote Control connects to `claude remote-control --spawn worktree` on VPS
3. Full interactive session with worktree isolation
4. PAI hooks fire on all sessions (same as local)

**Status:** Service file created (`isidore-cloud-remote.service`). Blocked on trust establishment. See `Plans/phase-fg-channels-remote-control.md`.

### 5. Email (Planned — C6)

IMAP polling + SMTP response. Not yet implemented — waiting on email server credentials from Marius. The architecture is in place:
- `config.ts` already has all email configuration fields
- `bridge.ts` has the placeholder for email polling
- Same pattern: poll → invoke Claude → format → reply

### 6. Cron (Automated Tasks)

One-shot invocations for scheduled work:

```bash
# Every 4 hours: check Claude OAuth health
0 */4 * * * /home/isidore_cloud/projects/my-pai-cloud-solution/scripts/auth-health-check.sh
```

Cron jobs use `claude -p "task"` (no `--resume` — fresh context each time).

---

## The Bridge Service

The bridge is a single Bun process (`src/bridge.ts`) that orchestrates everything:

```
bridge.ts (entry point)
├── loadConfig()            → config.ts           — reads bridge.env, validates, returns typed config
├── SessionManager          → session.ts          — session IDs + workspace session via memory.db
├── ClaudeInvoker           → claude.ts           — spawns CLI, timeouts, stream-json, importance scoring
├── ProjectManager          → projects.ts         — project registry, state in memory.db, git sync
├── ModeManager             → mode.ts             — dual-mode state, session metrics, auto-wrapup
├── TelegramAdapter         → telegram-adapter.ts — wraps Grammy bot behind MessengerAdapter interface
│   └── createTelegramBot() → telegram.ts         — auth middleware, all commands, statusline
├── MemoryStore             → memory.ts           — SQLite episodic + semantic memory, FTS5, whiteboards
├── EmbeddingProvider       → embeddings.ts       — Ollama embeddings or keyword fallback
├── ContextBuilder          → context.ts          — scored retrieval, topic tracking, budget injection
├── PipelineWatcher         → pipeline.ts         — cross-user task queue (Gregor → Isidore)
├── ReversePipelineWatcher  → reverse-pipeline.ts — delegation queue (Isidore → Gregor)
├── TaskOrchestrator        → orchestrator.ts     — DAG workflow decomposition + execution
├── BranchManager           → branch-manager.ts   — task-specific branch isolation + locks
├── SynthesisLoop           → synthesis.ts        — knowledge distillation + project whiteboards
├── Scheduler               → scheduler.ts        — SQLite cron scheduler (synthesis, memory, health)
├── PolicyEngine            → policy.ts           — YAML-based action authorization
├── DailyMemoryWriter       → daily-memory.ts     — workspace daily episode summary to markdown
├── Dashboard               → dashboard.ts        — HTTP API + SSE real-time updates
├── ResourceGuard           → resource-guard.ts   — memory-gated dispatch
├── RateLimiter             → rate-limiter.ts     — failure-rate circuit breaker
├── Verifier                → verifier.ts         — result verification via Claude one-shot
├── AgentLoader             → agent-loader.ts     — .pai/agents/*.md definitions
├── AgentRegistry           → agent-registry.ts   — SQLite agent tracking + heartbeat
├── IdempotencyStore        → idempotency.ts      — duplicate task detection
├── formatStatusline()      → statusline.ts       — two-line status block for Telegram
├── compactFormat()         → format.ts           — strips PAI Algorithm formatting for mobile
├── chunkMessage()          → format.ts           — splits long responses for Telegram's 4096 limit
└── escMd()                 → format.ts           — escapes Markdown in notifications
```

### Message Flow (Telegram)

```
User message
  → Grammy middleware: check user ID
  → Send "typing" indicator
  → ContextBuilder.buildContext(message, project)
    → Query memory.db (scored retrieval: FTS5 + recency + importance)
    → Get session summary for recovery context
    → Get project whiteboard (or cross-project whiteboards in workspace mode)
    → Format within char budget (whiteboard 20%, knowledge 20%, episodes 30%, summary 30%)
    → Freeze as snapshot (topic-based invalidation, 5min TTL fallback)
  → ClaudeInvoker.send(message, contextPrefix)
    → Read session ID from file
    → Spawn: claude [--resume <id>] -p "[context]\nmessage" --output-format stream-json
    → Parse NDJSON stream events, extract text + usage
    → Save real session ID from Claude's response
    → Record episode in memory.db (with importance scoring via haiku)
  → compactFormat(response)
    → Strip Algorithm headers, ISC gates, voice curls, time checks
  → chunkMessage(formatted, 4000)
    → Split at paragraph → line → space → hard break boundaries
    → Add [1/N] part indicators
  → Append statusline to last chunk (mode/time/msg count/context%/episodes)
  → Send chunks back to Telegram
  → ModeManager.recordMessage(usage)
  → Auto-wrapup check (workspace mode only):
    → 80% threshold: warn user, set pending wrapup
    → 100% threshold: generate summary, rotate session, reset metrics
  → Importance-triggered synthesis (workspace mode only):
    → If unsynthesized importance sum > threshold → trigger SynthesisLoop
```

### Compact Formatter

Claude Code with PAI runs the full Algorithm for every response — phase headers, ISC criteria, capability audits, voice curls. On a phone screen, that's overwhelming. The formatter strips it down:

**Removed:**
- `♻︎ Entering the PAI ALGORITHM...` headers
- `━━━ PHASE ━━━ N/7` separators
- Voice curl commands
- ISC Quality Gate blocks
- Capability audit blocks
- TaskList/TaskCreate/TaskUpdate invocations
- Time check lines

**Preserved:**
- The actual answer/content
- Code blocks (all preserved)
- Voice summary line (`🗣️ Isidore Cloud: ...`)

---

## Dual-Mode System

The bridge operates in two distinct modes, managed by `ModeManager` (`mode.ts`):

### Workspace Mode (Default)

The agent's "home" — where it lives between projects. Active when no project is selected.

- **Auto-session management:** ModeManager tracks cumulative tokens and message count. When context pressure reaches 80%, warns the user. At 100%, automatically generates a session summary, rotates the session, and resets metrics.
- **Importance-triggered synthesis:** After each message, checks if unsynthesized episode importance sum exceeds threshold (default 50). If so, triggers `SynthesisLoop` to distill knowledge.
- **Daily memory:** Cron-scheduled summary of day's episodes → markdown file + memory.db episode.
- **Workspace session:** Stored in memory.db (domain="system", key="workspace_session"), separate from project sessions.

### Project Mode

Focused work on a specific git-tracked repo. Invoked via `/project <name>`.

- **Manual session management:** Sessions keyed by project name, stored in memory.db sessions map.
- **Git-aware:** `/sync` commits + pushes, `/pull` pulls latest.
- **Context scoping:** ContextBuilder filters episodes by project, injects project-specific whiteboard.

### Statusline

Every Telegram reply ends with a statusline code block:

```
══ PAI ══════════════════════════
🏠 workspace · 14:30
msg 5/30 · ctx 42% · 21ep
```

- Line 1: Mode icon (🏠 workspace / 📁 project name) + time
- Line 2: Message count + context pressure % + episode count

### Auto-Wrapup Flow

```
Message N in workspace mode:
  → ModeManager.recordMessage(usage)
  → ModeManager.shouldAutoWrapup(config)
  → At 80%: "Context at X%, auto-freshening in ~N messages. /keep to stay."
  → At 100%: performWorkspaceWrapup()
    → Generate session summary via quickShot (haiku)
    → Record as importance-9 episode (source: "session_summary")
    → Rotate workspace session (archive old, clear from memory.db)
    → Reset ModeManager metrics
    → Next message starts with context injection from summary
  → /keep: extends threshold by 50%, clears pending warning
```

---

## Memory & Context

### Memory Store (`memory.ts`)

SQLite-backed episodic + semantic memory. The sole persistence layer for the bridge.

```
memory.db
├── episodes            # Episodic memory (every message, pipeline result, etc.)
│   ├── id, timestamp, source, project, session_id, role
│   ├── content, summary (haiku-generated)
│   ├── importance (1-10, haiku-scored)
│   ├── access_count, last_accessed
│   └── FTS5 index (content + summary)
│
├── knowledge           # Semantic memory (distilled facts, state, whiteboards)
│   ├── domain/key namespacing
│   ├── Synthesis knowledge: domain=topic, key=entity
│   ├── System state: domain="system", key="activeProject"|"sessions"|"workspace_session"
│   └── Whiteboards: domain="whiteboard", key=project
│
├── synthesis_state     # SynthesisLoop tracking (last_episode_id, run count)
│
└── Optional: sqlite-vec vectors for semantic search (falls back to FTS5 keyword)
```

**Episode sources:** `telegram`, `pipeline`, `orchestrator`, `handoff`, `prd`, `synthesis`, `session_summary`, `daily_memory`

**Importance scoring:** Every episode gets scored 1-10 at record time via `ClaudeInvoker.rateAndSummarize()` (haiku one-shot). High-importance episodes get full content in context injection; lower-importance get summary-only.

### Context Injection (`context.ts`)

`ContextBuilder` queries memory before each Claude invocation and prepends relevant context:

```
Budget allocation (default 8000 chars):
├── 20% — Project whiteboard (or cross-project whiteboards in workspace mode)
├── 20% — Relevant knowledge entries
├── 30% — Recent relevant episodes (importance-masked)
└── 30% — Session summary (recovery context from previous conversation)
```

**Retrieval:** `scoredQuery()` combines FTS5 text relevance + recency decay + importance weighting + access frequency into a composite score.

**Caching:** Topic-based snapshot invalidation. Extracts keywords from each message, computes Jaccard similarity with rolling topic. Topic shift → invalidate snapshot → fresh query. Time-based fallback TTL of 5 minutes.

**Mode-aware:** In project mode, injects single project whiteboard. In workspace mode, injects up to 3 recent project whiteboards.

### Synthesis Loop (`synthesis.ts`)

Periodic knowledge distillation from accumulated episodes:

- Groups episodes by source domain
- Calls Claude one-shot per domain to extract reusable knowledge
- Writes entries via `MemoryStore.distill()`
- Generates per-project whiteboards (running summary of what's happening in each project)
- Triggered by scheduler (daily at 02:00 UTC) or importance threshold (workspace mode)

---

## Session Management

Sessions are the mechanism for conversation continuity. Claude Code identifies conversations by session ID — passing `--resume <session-id>` continues where you left off.

### How Session IDs Work

```
1. First message (no session ID file):
   claude -p "hello" --output-format stream-json
   → Claude creates a new session
   → Response includes session_id: "abc-123..."
   → Bridge saves "abc-123..." to ~/.claude/active-session-id

2. Subsequent messages:
   claude --resume abc-123... -p "continue" --output-format stream-json
   → Claude resumes the conversation
   → Same context, same history

3. /clear or /wrapup command:
   → Generate session summary (haiku quickShot)
   → Record summary as importance-9 episode in memory.db
   → Archive session ID to ~/.claude/archived-sessions/
   → Clear active-session-id
   → Next message starts fresh with context injection from summary
```

### Session Types

| Type | Storage | Lifecycle |
|------|---------|-----------|
| **Project session** | memory.db knowledge (domain="system", key="sessions") | Per-project, persists across mode switches |
| **Workspace session** | memory.db knowledge (domain="system", key="workspace_session") | Auto-rotated on context pressure |
| **Active session file** | `~/.claude/active-session-id` | Points to current CLI session |

### Stale Session Recovery

If the session ID file points to a session that no longer exists, the bridge detects this automatically, clears the stale session, and retries without `--resume`. No manual intervention needed.

---

## Project Management

A **project registry** (`config/projects.json`) tracks all projects with their paths, git URLs, and active status. Project state (active project, per-project sessions) is persisted in `memory.db` — no file-based handoff.

### Project Switching (`/project <name>`)

```
/project openclaw-bot
  → Auto-push current project (git commit + push to cloud/* branch)
  → ModeManager.switchToProject("openclaw-bot")
  → Look up in registry (case-insensitive partial match)
  → Ensure target is cloned (auto-clone if needed)
  → Pull latest code (skipped if uncommitted changes — warns instead)
  → Save current session ID, restore target's session ID (from memory.db)
  → Set Claude working directory to target's path
  → Reply with status + statusline
```

### Git Workflow (Cloud → Review → Merge)

Cloud Isidore never pushes to `main` directly. A VPS-side pre-push hook rejects it.

```
Cloud makes changes (workspace or project mode)
  → /sync (or auto-push on project switch)
    → project-sync.sh detects pre-push hook
    → Creates cloud/<project>-<timestamp> branch
    → Commits + pushes branch
    → Returns to main
    → Telegram reply shows branch + /review + /merge commands

Marius reviews (from phone or desktop):
  → /review cloud/<branch>    — Codex CLI reviews diff on VPS
  → /merge cloud/<branch>     — merges to main, pushes, deletes branch
  OR
  → scripts/review-cloud.sh   — Codex review from local machine

Recovery:
  → /pull                     — normal pull (skips if dirty)
  → /pull --force             — git reset --hard origin/main
```

### Project Creation (`/newproject <name>`)

```
/newproject my-new-project
  → Validate name (lowercase kebab-case)
  → gh repo create mj-deving/my-new-project --private
  → git clone into /home/isidore_cloud/projects/my-new-project/
  → Write scaffold CLAUDE.md
  → git add -A && commit && push
  → Add to registry and save
  → Auto-switch to the new project
```

**New projects start as cloud-only** (`paths.local: null`). Clone from GitHub to work locally.

---

## Cross-User Pipeline (Gregor↔Isidore Cloud)

A file-based task queue that lets Gregor (OpenClaw bot, running as the `openclaw` user) send work requests to Isidore Cloud and receive results — without direct process communication.

### The Problem

Two AI assistants on the same VPS need to collaborate. Gregor handles Discord automation for OpenClaw. Sometimes Gregor encounters problems that need Isidore Cloud's capabilities (broader knowledge, PAI skills, different perspective). But they run as different Linux users with different Claude sessions.

### The Solution: Three-Layer Architecture

```
Layer 1: Shared filesystem infrastructure
Layer 2: Isidore Cloud bridge watcher (receiver)
Layer 3: Gregor sender scripts (submitter)
```

### Layer 1 — Shared Infrastructure

A `pai` Linux group with a setgid directory structure:

```
/var/lib/pai-pipeline/          # Root — mode 2770, group pai
├── tasks/                      # Gregor writes task files here
├── results/                    # Isidore Cloud writes result files here
└── ack/                        # Processed tasks moved here
```

**Key properties:**
- Both `openclaw` and `isidore_cloud` users are members of the `pai` group
- Setgid bit (2770) ensures new files inherit the `pai` group regardless of creator
- Cross-user read/write works via group permissions
- No sudo, no su, no privilege escalation needed

### Layer 2 — Pipeline Watcher (Standalone Daemon)

**`standalone/pipeline-watcher.ts`** — A standalone daemon running as `isidore-cloud-pipeline` systemd service. Replaces the bridge-coupled `PipelineWatcher` (~855 lines) with a ~100-line focused daemon.

```
isidore-cloud-pipeline service startup
  → validateSetup() — verify TASKS_DIR, RESULTS_DIR, ACK_DIR, claude binary exist (ENOENT = fatal)
  → Poll /var/lib/pai-pipeline/tasks/ every 5 seconds (reentrancy-guarded)
  → For each .json file found:
      1. Read and parse all JSON task files
      2. Validate via Zod (PipelineTaskSchema)
      3. Sort by priority (high > normal > low), tie-break by timestamp
      4. Run injection scan on prompt
      5. For each task in priority order (respecting concurrency cap):
         a. Resolve working directory (project → dir, with fallback)
         b. Dispatch to claude -p (one-shot)
         c. Write result atomically (.tmp → rename) to results/
         d. Move task file from tasks/ to ack/
```

**What the standalone daemon keeps:** Poll loop, Zod validation, priority sorting, one-shot dispatch, atomic result writes, ack, concurrency cap, injection scan, configurable timeout with SIGKILL escalation.

**What it drops** (bridge-only concerns): Orchestrator integration, branch manager, resource guard, rate limiter, verifier, idempotency store, policy engine, memory recording, synthesis/daily-memory hooks, Telegram status updates.

**Design decisions:**
- **One-shot only** — Pipeline tasks always get fresh Claude context. No `--resume` support (simplification from bridge version).
- **Priority-sorted processing** — Tasks with `priority: "high"` are processed before `"normal"` (default), which are processed before `"low"`. Within the same priority level, earlier timestamps win. Priority ordering applies within a single poll batch — a running task is never interrupted.
- **Atomic result writes** — Results are written to a `.tmp` file first, then renamed. Gregor never reads a partial result.
- **ENOENT fatal handling** — Missing pipeline directories or claude binary cause immediate exit (not silent retry).
- **SIGKILL timeout escalation** — SIGTERM first, then SIGKILL after grace period if process doesn't exit.
- **Reentrancy guard** — `polling` flag prevents overlapping poll cycles when tasks take longer than the poll interval.
- **Malformed JSON handling** — If a task file can't be parsed, it's skipped and retried on the next poll cycle.
- **cwd fallback** — If a task's `project` field points to a non-existent directory, the watcher falls back to `$HOME` and includes a warning in the result.

> **Note:** The bridge's `PipelineWatcher` (`src/pipeline.ts`) still exists in the codebase but is disabled on VPS (`PIPELINE_ENABLED=0` in `bridge.env`). The standalone daemon is the active pipeline processor.

### Layer 3 — Sender Scripts (Gregor Side)

Three shell scripts deployed at `~/scripts/` on the `openclaw` user:

| Script | Purpose |
|--------|---------|
| `pai-submit.sh` | Write task files with full schema, JSON escaping, all options |
| `pai-result.sh` | Read results — list, specific ID, `--latest`, `--wait` (polling), `--ack` |
| `pai-status.sh` | Pipeline dashboard — human-readable + `--json` for programmatic access |

### Task Schema

Written by Gregor (Layer 3) to `/var/lib/pai-pipeline/tasks/<id>.json`:

```json
{
  "id": "20260226-183000-a1b2c3d4",
  "from": "gregor",
  "to": "isidore_cloud",
  "timestamp": "2026-02-26T18:30:00Z",
  "type": "request",
  "priority": "normal",
  "mode": "async",
  "project": "openclaw-bot",
  "prompt": "Review backup.sh for edge cases in the rotation logic",
  "context": { "file": "scripts/backup.sh", "line_range": "45-80" },
  "constraints": { "max_response_length": 500 },
  "session_id": null,
  "timeout_minutes": 120,
  "max_turns": 50
}
```

**Required fields:** `id`, `prompt`
**Optional fields:** `from`, `to`, `timestamp`, `type`, `priority`, `mode`, `project`, `context`, `constraints`, `session_id`, `timeout_minutes`, `max_turns`

- `session_id` — Resume a prior pipeline conversation. Use the `session_id` returned in a previous result to continue the same Claude context. If omitted or null, a fresh one-shot conversation is started.
- `timeout_minutes` — Per-task timeout in minutes. Overrides the global 5-minute default (`maxClaudeTimeoutMs`). Essential for long-running tasks like overnight PRD execution (typically 30-120 min).
- `max_turns` — Maximum agentic turns for this task. Passed as `--max-turns N` to the Claude CLI. Controls how many tool-use rounds Claude gets before stopping.

### Result Schema

Written by Isidore Cloud (Layer 2) to `/var/lib/pai-pipeline/results/<task-id>.json`:

```json
{
  "id": "f0b9be97-b123-48c0-a88a-5c5c69ee110e",
  "taskId": "20260226-183000-a1b2c3d4",
  "from": "isidore_cloud",
  "to": "gregor",
  "timestamp": "2026-02-26T18:30:15.788Z",
  "status": "completed",
  "result": "The rotation logic has two edge cases...",
  "usage": { "input_tokens": 450, "output_tokens": 120 },
  "warnings": [],
  "session_id": "abc-123-session-id-for-follow-ups"
}
```

**Fields:**
- `taskId` — Links back to the original task's `id`
- `status` — `"completed"` or `"error"`
- `result` — Claude's response text (present when completed)
- `error` — Error message (present when status is `"error"`)
- `warnings` — Array of non-fatal warnings (e.g., cwd fallback, stale session)
- `usage` — Token usage from Claude's response
- `session_id` — Claude's session ID; provide in follow-up tasks to resume the conversation

### Flow Diagram

```
Gregor (openclaw user)                    Isidore Cloud (isidore_cloud user)
┌────────────────────┐                    ┌─────────────────────────────┐
│ pai-submit.sh      │                    │ standalone/pipeline-watcher │
│   writes JSON ─────┼──► tasks/task.json │ (isidore-cloud-pipeline)   │
│                    │                    │   polls every 5s            │
│                    │                    │   Zod validate + inject scan│
│                    │                    │   ▼                         │
│                    │                    │   claude -p "prompt"        │
│                    │                    │   ▼                         │
│ pai-result.sh      │                    │   writes result (.tmp→rename)│
│   reads JSON ◄─────┼─── results/id.json │   moves to ack/            │
│                    │                    │                             │
│ pai-status.sh      │                    │                             │
│   reads all dirs   │                    │                             │
└────────────────────┘                    └─────────────────────────────┘
```

### Configuration

Pipeline settings in `config.ts`:

| Env Variable | Default | Purpose |
|-------------|---------|---------|
| `PIPELINE_ENABLED` | `"1"` (enabled) | Set to `"0"` to disable the **bridge** watcher (currently `0` on VPS — standalone daemon handles pipeline) |
| `PIPELINE_DIR` | `/var/lib/pai-pipeline` | Root directory for the pipeline |
| `PIPELINE_POLL_INTERVAL_MS` | `5000` | Milliseconds between poll cycles |
| `PIPELINE_MAX_CONCURRENT` | `1` | Maximum tasks executing simultaneously |
| `REVERSE_PIPELINE_ENABLED` | `"1"` (enabled) | Enable Isidore→Gregor delegation |
| `ORCHESTRATOR_ENABLED` | `"1"` (enabled) | Enable DAG workflow orchestrator |
| `ORCHESTRATOR_WORKFLOW_TIMEOUT_MS` | `1800000` (30min) | Workflow-level timeout |
| `ORCHESTRATOR_MAX_DELEGATION_DEPTH` | `3` | Maximum decomposition re-decomposition depth |
| `BRANCH_ISOLATION_ENABLED` | `"1"` (enabled) | Enable task-specific branch isolation |
| `BRANCH_ISOLATION_STALE_LOCK_MAX_MS` | `3600000` (1hr) | Max age before stale lock cleanup |
| `RESOURCE_GUARD_ENABLED` | `"1"` (enabled) | Enable memory-gated dispatch |
| `RESOURCE_GUARD_MEMORY_THRESHOLD_MB` | `512` | Minimum free MB before dispatch blocked |
| `RATE_LIMITER_ENABLED` | `"1"` (enabled) | Enable failure-rate circuit breaker |
| `RATE_LIMITER_FAILURE_THRESHOLD` | `3` | Failures before cooldown triggers |
| `RATE_LIMITER_WINDOW_MS` | `300000` (5min) | Sliding window for failure counting |
| `RATE_LIMITER_COOLDOWN_MS` | `3600000` (60min) | Cooldown period after threshold breached |
| `VERIFIER_ENABLED` | `"1"` (enabled) | Enable result verification via Claude one-shot |
| `VERIFIER_TIMEOUT_MS` | `30000` (30s) | Timeout for verifier invocation |
| `QUICK_MODEL` | `"haiku"` | Model used for `/quick` command |

### Error Handling

| Scenario | Behavior |
|----------|----------|
| Malformed JSON in task file | Skipped with warning log, retried next cycle |
| Missing `id` or `prompt` | Skipped with warning log |
| Claude invocation fails | Result written with `status: "error"` and error message |
| Project directory doesn't exist | Falls back to `$HOME`, warning in result |
| Result file write fails | Logged, task not moved to ack (retried next cycle) |
| Stale session ID in task | Retries without `--resume`, warning in result |
| Pipeline directory missing | Poll logs warning, no crash |

### Concurrency Pool (Bridge — Disabled on VPS)

The bridge pipeline supports concurrent task execution up to `PIPELINE_MAX_CONCURRENT` (default 1, set to 8 on VPS). The standalone daemon uses a simpler concurrency cap (`PIPELINE_MAX_CONCURRENT`, default 1).

- **`activeCount`** — Number of tasks currently executing
- **`inFlight`** set — Filenames being processed (prevents double-dispatch)
- **`activeProjects`** set — Projects with running tasks (prevents concurrent writes to same repo)
- **Session-project affinity** — In-memory Map prevents cross-project session contamination

Tasks exceeding the concurrency limit wait until a slot opens. Per-project locking ensures only one task writes to a given project directory at a time.

### Reverse Pipeline (Phase 5A — Isidore → Gregor Delegation)

The reverse direction: Isidore Cloud delegates tasks to Gregor via `/delegate` or orchestrator workflow steps.

```
Isidore Cloud                              Gregor (openclaw user)
┌───────────────────────┐                  ┌───────────────────────┐
│ /delegate "prompt"    │                  │                       │
│   or orchestrator     │                  │                       │
│   step (gregor)       │                  │   Picks up task       │
│   ▼                   │                  │   Executes            │
│ Write JSON ───────────┼──► reverse-tasks │   ▼                   │
│                       │                  │   Writes result       │
│ ReversePipelineWatcher│                  │                       │
│   polls reverse-results◄─── reverse-results                     │
│   routes result:      │                  │                       │
│   - workflow → orch.  │                  │                       │
│   - standalone → TG   │                  │                       │
└───────────────────────┘                  └───────────────────────┘
```

**Key design:**
- `PendingDelegation` is fully serializable (no closures) — crash recovery via `loadPending()` directory scan
- On restart, in-flight delegations are recovered and re-watched
- Results for workflow steps route to `orchestrator.completeStep()`/`failStep()` instead of Telegram

### Task Orchestrator (Phase 5B — DAG Workflows)

Complex tasks can be decomposed into multi-step workflows with dependency ordering:

```
/workflow create "Add headers to all source files"
  ▼
Claude one-shot decomposes into steps:
  step-001 (isidore) Read files to understand       [depends: none]
  step-002 (isidore) Add headers to batch 1         [depends: step-001]
  step-003 (isidore) Add headers to batch 2         [depends: step-001]
  step-004 (gregor)  Verify + type check            [depends: step-002, step-003]
  ▼
Orchestrator dispatches ready steps:
  - step-001 dispatched immediately
  - step-002 + step-003 dispatched in parallel (after step-001 completes)
  - step-004 delegated to Gregor via reverse pipeline (after 002+003)
```

**Architecture:**
- **Decomposition** — Claude one-shot with structured prompt produces `{steps, dependsOn}` DAG
- **Validation** — Cycle detection (Kahn's algorithm/BFS), referential integrity check, min/max step limits
- **Dispatch** — `advanceWorkflow()` is idempotent; marks `in_progress` before spawning
- **Persistence** — Workflows serialized to `workflows/*.json` for crash recovery
- **Mixed assignees** — `isidore` steps run via local `claude oneShot`, `gregor` steps delegate via reverse pipeline
- **Timeouts** — Configurable per-workflow timeout (default 30min), depth cap (default 3)
- **Notifications** — Telegram messages for workflow creation, completion, failure, timeout
- **Workflow-completion results** — When a workflow finishes (completed, failed, or timed out), a summary result is written atomically to `results/workflow-<originTaskId>.json`. Includes step-level statuses, result snippets, errors, and total duration. This lets Gregor (or any result consumer) see the outcome of orchestrated workflows without Telegram access.

**Commands:** `/workflow create`, `/workflow status`, `/workflow <id>`, `/workflows`, `/cancel <id>`

### Branch Isolation (Phase 5C)

Pipeline and orchestrator tasks run on isolated git branches to prevent contamination of `main`:

```
Task arrives → BranchManager.checkout(projectDir, taskId)
  → git checkout -b pipeline/<taskId-prefix>
  → Lock recorded in branch-locks.json (atomic write)
  → Task executes on branch
  → BranchManager.release(projectDir, taskId)
  → git checkout main
  → Lock removed
```

**Design decisions:**
- **Branch naming:** `pipeline/<first-8-chars-of-taskId>` for readability
- **Lock persistence:** `branch-locks.json` in pipeline dir, atomic writes via `.tmp` + `rename`
- **Lock key:** `{projectDir}:{branch}` for multi-project support
- **Crash recovery:** Existing branches are reused (not error), stale locks cleaned on startup
- **Orchestrator integration:** Isidore workflow steps also use branch isolation (`pipeline/<wfId>-<stepId>`)
- **`/branches` command:** Shows active locks with source, project, task ID, and age

---

## Autonomous Systems

### Scheduler (`scheduler.ts`)

SQLite-backed cron scheduler for self-initiated tasks. 5-field cron parser with ranges, steps, lists. Emits task JSON to pipeline `tasks/` directory. Feature-flagged `SCHEDULER_ENABLED`.

| Schedule | Cron | Purpose |
|----------|------|---------|
| `daily-synthesis` | `0 2 * * *` | Knowledge distillation from accumulated episodes |
| `daily-memory` | `55 22 * * *` | Daily workspace episode summary to markdown |
| `weekly-review` | `0 3 * * 0` | System health review (memory, pipeline, disk) |

Managed via `/schedule` Telegram command. Custom schedules can be added programmatically.

### Daily Memory Writer (`daily-memory.ts`)

Generates a daily summary of workspace episodes:

```
Cron trigger (22:55 UTC) → pipeline task (type: "daily-memory")
  → DailyMemoryWriter.writeDailyMemory()
  → Filter episodes by importance ≥ 3
  → Summarize via quickShot (haiku)
  → Write ~/workspace/memory/YYYY-MM-DD.md
  → Record episode in memory.db (source: "daily_memory", importance: 8)
  → Git commit in workspace repo (if WORKSPACE_GIT_ENABLED)
```

### Policy Engine (`policy.ts`)

YAML-based action authorization. Rules with allow/deny/must_ask dispositions. Default: deny. `must_ask` triggers Telegram notification. Checked before pipeline dispatch and orchestrator step dispatch. Feature-flagged `POLICY_ENABLED`.

### Agent Definitions (`agent-loader.ts`)

Declarative `.pai/agents/*.md` files with YAML frontmatter + markdown system prompt. Agents have execution tiers (1=full, 2=algo-lite, 3=quickShot), memory scope, constraints, and delegation permissions. Self-register in `AgentRegistry`. Feature-flagged `AGENT_DEFINITIONS_ENABLED`.

### Dashboard (`dashboard.ts`)

Bun.serve HTTP server on localhost:3456 with REST API (8 endpoints) + SSE real-time updates. Dark Kanban board showing pipeline status, workflows, agent health, memory stats, and decision traces. Access via SSH tunnel. Feature-flagged `DASHBOARD_ENABLED`.

### Reliability Layer

| Component | Purpose | Feature flag |
|-----------|---------|-------------|
| `ResourceGuard` | Blocks dispatch when `os.freemem()` < threshold | `RESOURCE_GUARD_ENABLED` |
| `RateLimiter` | Sliding-window failure tracking with cooldown | `RATE_LIMITER_ENABLED` |
| `Verifier` | Result verification via separate Claude one-shot | `VERIFIER_ENABLED` |
| `IdempotencyStore` | SHA256-based duplicate task detection | `PIPELINE_DEDUP_ENABLED` |
| `InjectionScan` | Regex prompt injection detection (18 patterns, log-only) | `INJECTION_SCAN_ENABLED` |

---

## VPS Infrastructure

### Server Details

| Property | Value |
|----------|-------|
| Provider | Contabo |
| IP | 213.199.32.18 |
| OS | Ubuntu 24.04 |
| Shared with | Gregor/OpenClaw (user: `openclaw`) |

### SSH Access

From your local machine:

```bash
# As isidore_cloud (for Isidore Cloud work)
ssh isidore_cloud

# As openclaw (for Gregor/system admin)
ssh vps
```

SSH config (`~/.ssh/config`):
```
Host isidore_cloud
    HostName 213.199.32.18
    User isidore_cloud
    Port 22
    IdentityFile ~/.ssh/id_ed25519_isidore_cloud
    IdentitiesOnly yes
```

### Systemd Services

**isidore-cloud-bridge.service** — The Telegram bridge:
- Runs as: `isidore_cloud:isidore_cloud`
- WorkingDirectory: `~/projects/my-pai-cloud-solution`
- Command: `bun run src/bridge.ts`
- EnvironmentFile: `~/.config/isidore_cloud/bridge.env`
- Restart: always (on failure)
- Note: `PIPELINE_ENABLED=0` — pipeline processing handled by standalone daemon

**isidore-cloud-pipeline.service** — Standalone pipeline watcher:
- Runs as: `isidore_cloud:isidore_cloud`
- WorkingDirectory: `~/projects/my-pai-cloud-solution`
- Command: `bun run standalone/pipeline-watcher.ts`
- Restart: always (on failure)

**isidore-cloud-channels.service** — Claude Channels Telegram plugin:
- Runs as: `isidore_cloud:isidore_cloud`
- Command: `claude --channels plugin:telegram@claude-plugins-official`
- Bot: `@isidore_channel_bot`
- MCP servers auto-load via `.mcp.json`

**isidore-cloud-tmux.service** — Persistent tmux:
- Runs as: `isidore_cloud:isidore_cloud`
- Creates tmux session `isidore_cloud` on boot
- Forking type (tmux detaches)

```bash
# Check status
ssh isidore_cloud 'sudo systemctl status isidore-cloud-bridge'
ssh isidore_cloud 'sudo systemctl status isidore-cloud-tmux'

# Restart bridge
ssh isidore_cloud 'sudo systemctl restart isidore-cloud-bridge'

# View bridge logs
ssh isidore_cloud 'sudo journalctl -u isidore-cloud-bridge -f'
```

### Cron Jobs

```
0 */4 * * * /home/isidore_cloud/projects/my-pai-cloud-solution/scripts/auth-health-check.sh
```

Checks Claude OAuth token health every 4 hours. If auth fails, logs to `~/.claude/auth-health.log`.

### Installed Software

| Software | Path | Version |
|----------|------|---------|
| Bun | `~/.bun/bin/bun` | Latest |
| Claude Code CLI | `~/.npm-global/bin/claude` | Latest |
| Git | System | 2.x |
| tmux | System | 3.x |

---

## Security Model

### Authentication Layers

1. **SSH key authentication** — Only your specific ed25519 key can access the `isidore_cloud` user
2. **sshd AllowUsers** — Only `dev`, `openclaw`, and `isidore_cloud` can SSH in at all
3. **Telegram user ID validation** — Only your Telegram account (ID: configured in bridge.env) can interact with the bot. All others get rejected.
4. **Claude OAuth** — No API key on the VPS. Uses Claude Code's built-in OAuth subscription auth. Tokens refresh automatically.
5. **GitHub deploy key** — Read/write access scoped to `pai-knowledge` repo only (not your whole GitHub account)

### Secret Storage

| Secret | Location | Protected by |
|--------|----------|-------------|
| Telegram bot token | `~/.config/isidore_cloud/bridge.env` | File permissions (600), separate from code |
| Claude OAuth tokens | `~/.claude/` (managed by Claude CLI) | File permissions, OAuth flow |
| SSH private key (local) | `~/.ssh/id_ed25519_isidore_cloud` | File permissions (600) |
| GitHub deploy key (VPS) | `~/.ssh/id_ed25519_github` | File permissions (600) |

### Runtime Security

- **DASHBOARD_TOKEN** — Mandatory when dashboard is enabled. Rejects unauthenticated requests.
- **Gateway injection scan** — `/api/send` runs `scanForInjection()` on input; blocks high-risk messages (HTTP 403).
- **Concurrency cap** — Max 2 simultaneous sends through the gateway, 8KB body limit.
- **BridgeContext immutability** — Frozen via `Object.freeze` after construction; subsystem references cannot be swapped at runtime.
- **Backup permissions** — `backup.sh` sets umask 0077; backup files are owner-read-only.

### What's NOT in the Repo

- No API keys, tokens, or secrets in any committed file
- `bridge.env` is in `.gitignore` — only `bridge.env.example` is committed
- SSH keys are never committed

---

## Deployment Guide

### Prerequisites

- A VPS with Ubuntu 24.04 (or similar)
- A Telegram bot token (create via @BotFather)
- Your Telegram user ID (get from @userinfobot)
- A Claude Code subscription (Max 5x recommended for 24/7 use)
- An SSH key pair for VPS access

### Step-by-Step

#### 1. Create VPS User

```bash
# SSH as root/admin user
ssh root@your-vps-ip

# Create user with home directory
sudo useradd -m -s /bin/bash isidore_cloud
echo "isidore_cloud ALL=(ALL) NOPASSWD:ALL" | sudo tee /etc/sudoers.d/isidore_cloud

# Add to SSH AllowUsers (edit /etc/ssh/sshd_config)
# AllowUsers ... isidore_cloud
sudo systemctl restart ssh
```

Or run the provided script: `scripts/setup-vps.sh`

#### 2. Deploy SSH Key

```bash
# Generate key locally
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_isidore_cloud -C "isidore_cloud"

# Copy to VPS
ssh-copy-id -i ~/.ssh/id_ed25519_isidore_cloud isidore_cloud@your-vps-ip

# Add SSH config alias (see SSH Access section above)
```

Or run: `scripts/deploy-key.sh`

#### 3. Install Runtime Dependencies on VPS

```bash
ssh isidore_cloud

# Install Bun
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc

# Install Claude Code CLI
mkdir -p ~/.npm-global
npm config set prefix ~/.npm-global
npm install -g @anthropic-ai/claude-code
export PATH="$HOME/.npm-global/bin:$PATH"

# Authenticate Claude (needs port forwarding for OAuth)
# From local: ssh -L 7160:localhost:7160 isidore_cloud
# On VPS: claude /login
```

#### 4. Deploy Project Code

```bash
# From local machine
scripts/deploy.sh
```

This rsyncs the project, installs npm deps, copies systemd services, and (re)starts them.

#### 5. Configure Environment

```bash
ssh isidore_cloud
mkdir -p ~/.config/isidore_cloud
cp ~/projects/my-pai-cloud-solution/bridge.env.example ~/.config/isidore_cloud/bridge.env
nano ~/.config/isidore_cloud/bridge.env
# Set TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOWED_USER_ID
```

#### 6. Start Services

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now isidore-cloud-bridge isidore-cloud-tmux
```

#### 7. Configure GitHub Access (VPS)

```bash
# Authenticate GitHub via PAT (for HTTPS git operations)
ssh isidore_cloud 'gh auth login'

# Set git identity on VPS
ssh isidore_cloud 'git config --global user.name "Isidore Cloud" && git config --global user.email "isidore-cloud@pai.local"'
```

#### 8. Verify Everything

```bash
# SSH works
ssh isidore_cloud 'whoami'          # → isidore_cloud
ssh isidore_cloud 'sudo whoami'     # → root

# Services running
ssh isidore_cloud 'sudo systemctl status isidore-cloud-bridge'  # → active
ssh isidore_cloud 'sudo systemctl status isidore-cloud-tmux'    # → active

# Telegram works
# → Send a message to your bot, expect a response with statusline

# Memory works
ssh isidore_cloud 'bun -e "const db = new (require(\"bun:sqlite\").default)(process.env.HOME + \"/.claude/memory.db\"); console.log(db.query(\"SELECT COUNT(*) as c FROM episodes\").get())"'

# GitHub access (VPS)
ssh isidore_cloud 'gh auth status'
```

---

## File Reference

### Source Code (`src/`)

| File | Purpose | Key exports |
|------|---------|-------------|
| `bridge.ts` | Entry point. Loads config, initializes all components, wires callbacks, starts services. | `main()` |
| `telegram.ts` | Grammy bot: auth middleware, all `/command` handlers, message forwarding, statusline, auto-wrapup. | `createTelegramBot()` |
| `telegram-adapter.ts` | Wraps Grammy bot behind platform-agnostic `MessengerAdapter` interface. | `TelegramAdapter` |
| `messenger-adapter.ts` | Platform-agnostic messaging contract (send, edit, delete, typing). | `MessengerAdapter` |
| `claude.ts` | Claude CLI wrapper. Spawns with `--resume`, stream-json parsing, importance scoring, quickShot. | `ClaudeInvoker`, `ClaudeResponse` |
| `session.ts` | Session IDs (file-based) + workspace session management via memory.db. | `SessionManager` |
| `projects.ts` | Project registry, state in memory.db, git sync, project creation. | `ProjectManager`, `ProjectEntry` |
| `mode.ts` | Dual-mode state (workspace/project), session metrics, auto-wrapup detection, /keep. | `ModeManager`, `BridgeMode` |
| `statusline.ts` | Two-line status block appended to every Telegram reply. | `formatStatusline()` |
| `memory.ts` | SQLite episodic + semantic memory, FTS5, whiteboards, importance scoring, system state. | `MemoryStore` |
| `embeddings.ts` | Ollama embedding client + keyword-only fallback. | `EmbeddingProvider` |
| `context.ts` | Scored retrieval, topic tracking, budget-based injection, importance masking. | `ContextBuilder` |
| `synthesis.ts` | Periodic knowledge distillation from episodes + project whiteboards. | `SynthesisLoop` |
| `daily-memory.ts` | Cron-scheduled daily episode summary to markdown + memory.db + git. | `DailyMemoryWriter` |
| `scheduler.ts` | SQLite-backed cron scheduler. 5-field cron parser, emits to pipeline. | `Scheduler` |
| `policy.ts` | YAML-based action authorization (allow/deny/must_ask). | `PolicyEngine` |
| `pipeline.ts` | Cross-user task queue watcher (bridge-coupled, **disabled on VPS** — see standalone). | `PipelineWatcher` |
| `reverse-pipeline.ts` | Isidore→Gregor delegation. Writes tasks, polls results, crash recovery. | `ReversePipelineWatcher` |
| `orchestrator.ts` | DAG workflow decomposition via Claude, step dispatch, persistence. | `TaskOrchestrator` |
| `branch-manager.ts` | Task-specific branch creation, locking, release, stale cleanup. | `BranchManager` |
| `schemas.ts` | Zod schemas for all external data types + `safeParse`/`strictParse` helpers. | All schema types |
| `agent-loader.ts` | Parses `.pai/agents/*.md` YAML+markdown definitions, registers in AgentRegistry. | `AgentLoader` |
| `agent-registry.ts` | SQLite agent tracking with heartbeat + stale detection. | `AgentRegistry` |
| `agent-message.ts` | AgentMessage envelope type + mapping functions for inter-agent transport. | `AgentMessage` |
| `decision-trace.ts` | Structured decision logging at pipeline/orchestrator decision points. | `TraceCollector` |
| `idempotency.ts` | SQLite-backed duplicate task detection (sha256 op_id). | `IdempotencyStore` |
| `injection-scan.ts` | Regex-based prompt injection detection (18 patterns, log-only). | `scanForInjection()` |
| `prd-executor.ts` | Autonomous PRD detection, parsing, execution, progress reporting. | `PRDExecutor` |
| `prd-parser.ts` | Claude one-shot extraction of structured PRD from freeform text. | `PRDParser` |
| `dashboard.ts` | Bun.serve HTTP server, REST API (8 endpoints), SSE real-time updates. | `Dashboard` |
| `dashboard-html.ts` | Self-contained HTML/CSS/JS dark-themed dashboard page. | `getDashboardHtml()` |
| `status-message.ts` | Rate-limited editable Telegram message manager. | `StatusMessage` |
| `resource-guard.ts` | Memory-gated dispatch. Checks `os.freemem()` before allowing tasks. | `ResourceGuard` |
| `rate-limiter.ts` | Sliding-window failure tracking with cooldown period. | `RateLimiter` |
| `verifier.ts` | Result verification via separate Claude one-shot. Fail-open. | `Verifier` |
| `github.ts` | GitHub PR operations via `gh` CLI: create/find PRs, upsert review comments, merge PRs. | `runGh()`, `findPR()`, `createOrReusePR()`, `upsertReviewComment()`, `mergePR()` |
| `format.ts` | Strips PAI Algorithm verbosity, chunks for Telegram, escapes Markdown. | `compactFormat()`, `chunkMessage()`, `escMd()` |
| `health-monitor.ts` | Periodic subsystem checks (memory, rateLimiter, resourceGuard), sliding-window Telegram delivery tracking, cached snapshots. | `HealthMonitor` |
| `config.ts` | Zod-validated env vars with range checks, feature flags, WORKSPACE_* config. | `Config`, `loadConfig()` |
| `types.ts` | `BridgeContext` interface (typed subsystem bag, replaces positional args) + `Plugin` interface (type-only, for future use). | `BridgeContext`, `Plugin` |
| `guardrails.ts` | Pre-execution authorization gate for sensitive operations. | `Guardrails` |
| `a2a-client.ts` | A2A protocol outbound client for agent-to-agent communication. | `A2AClient` |
| `group-chat.ts` | Multi-agent group chat engine for coordinated conversations. | `GroupChat` |
| `qr-generator.ts` | QR code generator for sharing links and data. | `QRGenerator` |

### Standalone Daemons (`standalone/`)

| File | Purpose | Key exports |
|------|---------|-------------|
| `pipeline-watcher.ts` | Standalone pipeline watcher daemon. Polls tasks/, Zod validates, dispatches to Claude CLI, atomic writes results, ack. Runs as `isidore-cloud-pipeline` systemd service. | N/A (entry point) |

### Scripts (`scripts/`)

| Script | Purpose | When to run |
|--------|---------|-------------|
| `setup-vps.sh` | Creates `isidore_cloud` user, installs Bun + Claude CLI, configures SSH. | Once, during initial setup |
| `deploy-key.sh` | Deploys your SSH public key to the VPS `authorized_keys`. | Once, during initial setup |
| `deploy.sh` | Full deployment: rsync code + git fetch/reset + bun install. Excludes `CLAUDE.local.md`. | Every time you update the code |
| `auth-health-check.sh` | Checks Claude OAuth health. Runs via cron every 4 hours. | Automatically via cron |
| `backup.sh` | WAL-safe backup of memory.db + bridge.env with 7-day rotation, 0077 umask. | Automatically via cron |
| `run-task.sh` | Runs a one-shot Claude task. For cron-based automation. | Manually or via cron |
| `project-sync.sh` | Git operations: `pull` (skips if dirty), `push` (auto-branches to `cloud/*`), `force-pull` (reset to origin/main), `clone`. | Called by ProjectManager (not directly) |
| `review-cloud.sh` | Review a `cloud/*` branch using Codex CLI. Lists branches if no arg. | Manually from local machine |
| `install-vps-hook.sh` | Installs pre-push hook on VPS to block direct pushes to main. | Once, during setup |

### Systemd (`systemd/`)

| Service | Purpose | Type |
|---------|---------|------|
| `isidore-cloud-bridge.service` | Telegram bridge — bot, dashboard, scheduler (pipeline disabled) | simple |
| `isidore-cloud-pipeline.service` | Standalone pipeline watcher daemon (active) | simple |
| `isidore-cloud-channels.service` | Claude Channels Telegram plugin (active — `@isidore_channel_bot`) | simple |
| `isidore-cloud-remote.service` | Remote Control server mode (pending trust) | simple |
| `isidore-cloud-tmux.service` | Persistent tmux session for SSH + Channels | forking |

### Config (`config/`)

| File | Purpose |
|------|---------|
| `projects.json` | Project registry — all projects, paths, git URLs (bundled copy) |
| `vps-settings.json` | Claude Code settings for VPS (identity, PAI config, hook subset) |

---

## Troubleshooting

### "No conversation found with session ID"

The session ID file points to an expired/deleted session.

```bash
ssh isidore_cloud 'rm ~/.claude/active-session-id'
# Next Telegram message creates a fresh session
```

### Bridge not responding

```bash
# Check if service is running
ssh isidore_cloud 'sudo systemctl status isidore-cloud-bridge'

# Check logs
ssh isidore_cloud 'sudo journalctl -u isidore-cloud-bridge --since "10 min ago"'

# Restart
ssh isidore_cloud 'sudo systemctl restart isidore-cloud-bridge'
```

### Claude auth expired

```bash
# Check auth health
ssh isidore_cloud 'cat ~/.claude/auth-health.log'

# Re-authenticate (needs port forwarding)
# From local: ssh -L 7160:localhost:7160 isidore_cloud
# On VPS: claude /login
```

### Memory database issues

```bash
# Check episode count
ssh isidore_cloud 'bun -e "const db = new (require(\"bun:sqlite\").default)(process.env.HOME + \"/.claude/memory.db\"); console.log(db.query(\"SELECT COUNT(*) as c FROM episodes\").get())"'

# Check system state
ssh isidore_cloud 'bun -e "const db = new (require(\"bun:sqlite\").default)(process.env.HOME + \"/.claude/memory.db\"); console.log(db.query(\"SELECT domain, key FROM knowledge WHERE domain=\\\"system\\\"\").all())"'
```

### Cron not running

```bash
# Check crontab
ssh isidore_cloud 'crontab -l'

# Must source bridge.env or use full paths — cron has minimal PATH
# Scripts should use absolute paths or source the env file
```

---

## What's Next

### Completed

- **Core bridge** — Telegram bot + Claude CLI wrapper + session management + project registry
- **Cross-user pipeline** — Gregor↔Isidore Cloud task queue, reverse delegation, DAG workflows
- **Branch isolation** — Pipeline/orchestrator tasks on isolated git branches with lock persistence
- **Reliability layer** — Resource guard, rate limiter, verifier, idempotency, quick model
- **Memory system** — SQLite episodic + semantic memory, FTS5, importance scoring, scored retrieval
- **Context injection** — Topic-based invalidation, budget-based allocation, importance masking
- **Observation masking + whiteboards** — Importance-based content filtering, per-project running summaries
- **Persistence redesign** — memory.db as sole persistence, session summaries, state migration
- **Synthesis loop** — Periodic knowledge distillation, per-domain Claude synthesis, whiteboard generation
- **Agent definitions** — Declarative .pai/agents/*.md with tier-based sub-delegation
- **Scheduler** — SQLite-backed cron (daily synthesis, weekly review)
- **Policy engine** — YAML-based action authorization
- **Dashboard** — HTTP API + SSE + dark Kanban board
- **Injection scanning** — 18-pattern regex detection (log-only v1)
- **PRD executor** — Autonomous PRD detection, parsing, execution (code complete, not enabled)
- **Dual-mode system** — Workspace/project modes, statusline, auto-wrapup, /workspace + /wrapup + /keep
- **Daily memory** — Cron-scheduled workspace episode summary to markdown + git
- **Importance-triggered synthesis** — Workspace mode auto-flush when importance sum exceeds threshold
- **Graduated Extraction Phase 1** — Sonnet fast-path via direct API (message-classifier + direct-api, feature-flagged)
- **Graduated Extraction Phase 2** — HealthMonitor (subsystem checks, delivery tracking), backup.sh (WAL-safe, 7-day rotation)
- **Graduated Extraction Phase 3A** — Gateway routes on dashboard (/api/send, /api/health)
- **Graduated Extraction Phase 3B** — Type foundations: BridgeContext (typed subsystem bag), Plugin interface (type-only)
- **Evolution Sessions 1-4** — DAG memory, A2A server, loop detection, turn recovery, summarizer, context compressor, worktree pool, playbook runner, guardrails, A2A client, group chat, QR generator — all deployed to main
- **Channels live** — `@isidore_channel_bot` responding via Claude Channels plugin with MCP servers and hooks
- **Standalone pipeline watcher** — `standalone/pipeline-watcher.ts` extracted from bridge, running as `isidore-cloud-pipeline` systemd service
- **Migration Phase 1** — MCP tools (pai-memory, pai-context) available natively via `.mcp.json`
- **Migration Phase 3** — Pipeline processing extracted to standalone daemon, bridge pipeline disabled

### In Progress

- **Architecture pivot — bridge → Channels migration.** Phase 1 (MCP tools) and Phase 3 (pipeline watcher extraction) complete. Channels live as `@isidore_channel_bot`. Standalone pipeline watcher running as `isidore-cloud-pipeline`. Remaining: Phase 2 (commands→skills), Phase 4 (dashboard extraction), Phase 5 (bridge retirement), Phase 6 (remote control).
- **Remote Control** — Service file created (`isidore-cloud-remote.service`). Blocked on trust establishment.

### Planned

- **Phase 2: Bridge commands → PAI skills migration** — Convert Telegram commands to portable PAI skills usable across all access surfaces (Channels, Remote Control, SSH)
- **Phase 4: Dashboard extraction** — Extract dashboard as standalone HTTP service, independent of bridge
- **Phase 5: Bridge retirement** — Once all functionality confirmed via Channels + standalone services
- **Phase 6: Remote Control activation** — Requires interactive trust acceptance
- **Email bridge** — IMAP polling + SMTP response (architecture in place, needs credentials)
- **Enable PRD executor** — Set PRD_EXECUTOR_ENABLED=1 on VPS after testing

### Vision

- **Full parity** — Isidore Cloud should be able to do everything local Isidore can (minus voice/browser), including working on repos, running tests, deploying code.
- **Proactive behavior** — Daily summaries, project monitoring, automated maintenance (scheduler + daily memory now enable this).
- **Multi-channel unified inbox** — Telegram, Channels, Remote Control, email — all access surfaces reaching the same identity with shared memory.

---

## Replicating This System

Want to build this for your own AI assistant? Here's what you need:

### Minimum Requirements

1. **A VPS** — Any Ubuntu/Debian server. 2GB RAM is enough. Contabo, Hetzner, DigitalOcean all work.
2. **Claude Code CLI** — `npm install -g @anthropic-ai/claude-code`. Needs a Max subscription for 24/7 use.
3. **Bun** — `curl -fsSL https://bun.sh/install | bash`. The runtime for the bridge.
4. **A Telegram bot** — Free, create via @BotFather in Telegram.
5. **A GitHub account** — For the knowledge sync repo (free private repos).

### Steps to Replicate

1. Fork or clone this repo
2. Follow the [Deployment Guide](#deployment-guide) above
3. Customize:
   - Change identity in `config/vps-settings.json`
   - Update `bridge.env.example` with your paths
   - Modify `format.ts` if your AI uses different output formatting
   - Adjust `config.ts` for your environment variables

### What's Transferable

- The bridge architecture (Grammy bot → CLI wrapper → session management) works with any Claude Code setup
- The memory system (SQLite + FTS5 + context injection) works for any long-running AI agent
- The systemd service definitions work on any Linux server
- The compact formatter is specific to PAI Algorithm output — replace with your own formatting needs

### What's Specific to This Setup

- PAI skills and hooks (the full Algorithm system)
- The naming convention (Isidore / Isidore Cloud)
- Coexistence with Gregor/OpenClaw on the same VPS
- The specific Telegram user ID authentication

---

*Last updated: 2026-04-02 (Channels live, standalone pipeline watcher, migration phases 1+3 complete, 384 tests across 30 files)*
*Author: mj-deving + Isidore (PAI)*
