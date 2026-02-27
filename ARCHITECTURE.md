# PAI Cloud Solution — Architecture & Reference Guide

> **One identity, two runtimes.** Deploy your AI assistant to a VPS so it's always reachable — from your desk, your phone, or anywhere in the world.

---

## Table of Contents

1. [The Vision](#the-vision)
2. [How It Works — The Big Picture](#how-it-works--the-big-picture)
3. [Naming Convention](#naming-convention)
4. [System Architecture](#system-architecture)
5. [Communication Channels](#communication-channels)
6. [The Bridge Service](#the-bridge-service)
7. [Session Management](#session-management)
8. [Project Handoff Protocol](#project-handoff-protocol)
9. [Cross-User Pipeline (Gregor↔Isidore Cloud)](#cross-user-pipeline-gregorisidore-cloud)
10. [Knowledge Sync](#knowledge-sync)
11. [VPS Infrastructure](#vps-infrastructure)
12. [Security Model](#security-model)
13. [Deployment Guide](#deployment-guide)
14. [File Reference](#file-reference)
15. [Troubleshooting](#troubleshooting)
16. [What's Next](#whats-next)
17. [Replicating This System](#replicating-this-system)

---

## The Vision

Claude Code is powerful but local — it lives in your terminal, on your machine. When you close the lid, it's gone. You can't message it from your phone on the train. You can't have it running a background task while you sleep.

**PAI Cloud Solution solves this** by deploying a second instance of your AI assistant (same personality, same knowledge, same skills) to a VPS that runs 24/7. You talk to it over Telegram from your phone, or SSH in for deep work. Both instances — local and cloud — share the same knowledge base through automatic Git-based sync.

The result: **one assistant, always available, everywhere.**

### Design Principles

- **One identity, two runtimes.** Isidore is one person. "Isidore" runs locally, "Isidore Cloud" runs on the VPS. They share personality, knowledge, and relationship history. They differ only in environment.
- **Channel-agnostic conversations.** Whether you SSH in, send a Telegram message, or send an email — it's the same conversation, same session, same context.
- **Knowledge convergence.** What one instance learns, the other inherits. Relationship notes, learnings from mistakes, user preferences — all synced automatically.
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
│           └── Same PAI skills, same knowledge, text-only
│
├── Via email (planned)
│   └── IMAP poll → claude --resume
│       └── Response via SMTP
│
└── Automated tasks
    └── Cron → claude -p "task"    ← One-shot, no session
```

**The bridge service** is the heart: a Bun/TypeScript process that runs 24/7, listens on Telegram (long polling), authenticates you, forwards your messages to Claude Code CLI, formats the response for mobile, and sends it back.

**Session continuity** works because both SSH (interactive tmux) and Telegram (programmatic bridge) share one session ID file (`~/.claude/active-session-id`). Claude Code's `--resume` flag picks up where you left off.

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
| **systemd services** | N/A | `isidore-cloud-bridge`, `isidore-cloud-tmux` |
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
│   │   ├── scripts/                   # Deployment & maintenance
│   │   ├── config/                    # Project registry (projects.json)
│   │   └── systemd/                   # Service definitions
│   │
│   ├── ~/projects/*/                  # Other project repos (managed by /newproject)
│   │
│   ├── ~/pai-knowledge/               # Shared knowledge Git repo (clone)
│   │
│   ├── ~/.claude/                     # Claude Code configuration
│   │   ├── settings.json              # PAI settings (Isidore Cloud identity)
│   │   ├── skills/PAI/               # Full PAI skill set
│   │   ├── hooks/                    # PAI hooks (non-interactive subset)
│   │   ├── MEMORY/                   # Synced knowledge (RELATIONSHIP, LEARNING)
│   │   ├── active-session-id         # Current conversation session pointer
│   │   └── handoff-state.json        # Per-project session mapping
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
    ├── isidore-cloud-bridge.service   # Telegram bot + pipeline + orchestrator (always running)
    └── isidore-cloud-tmux.service     # Persistent tmux (for SSH sessions)
```

### Local Layout

```
Local: WSL2 (your machine)
├── ~/projects/my-pai-cloud-solution/  # Source code (this repo)
├── ~/pai-knowledge/                   # Shared knowledge Git repo (clone)
├── ~/.ssh/
│   ├── id_ed25519_isidore_cloud      # SSH key for VPS access
│   └── config                        # SSH alias: isidore_cloud → VPS
└── ~/.claude/                         # Claude Code (local Isidore)
    ├── MEMORY/                        # Synced from/to pai-knowledge
    └── skills/PAI/USER/               # Synced from/to pai-knowledge
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
- `/start` — Welcome message and available commands
- `/project <name>` — Switch active project (auto-push current, pull target, restore session)
- `/projects` — List all registered projects with active marker and session info
- `/newproject <name>` — Create a new project (GitHub repo + VPS dir + scaffold + registry)
- `/done` — Commit + push current project + knowledge sync
- `/handoff` — Done + detailed status summary for local pickup
- `/new` — Start a fresh conversation (archives current session)
- `/status` — Show current session info and archived sessions
- `/clear` — Archive current session and start fresh
- `/compact` — Send `/compact` to Claude to compress context
- `/oneshot <msg>` — One-shot query without session (for quick questions)
- `/quick <msg>` — Quick query using Haiku model (fast, cheap)
- `/deleteproject <name>` — Remove a project from the registry
- `/delegate <prompt>` — Delegate a task to Gregor via reverse pipeline
- `/workflow create <prompt>` — Create a DAG workflow (auto-decomposes into steps)
- `/workflow status [id]` — List all workflows or show specific workflow details
- `/workflow <id>` — Show details for a specific workflow
- `/workflows` — List all workflows with status
- `/cancel <id>` — Cancel an active workflow
- `/pipeline` — Dashboard: forward + reverse pipeline + workflow status
- `/branches` — Show active branch isolation locks

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

### 3. Email (Planned — C6)

IMAP polling + SMTP response. Not yet implemented — waiting on email server credentials from Marius. The architecture is in place:
- `config.ts` already has all email configuration fields
- `bridge.ts` has the placeholder for email polling
- Same pattern: poll → invoke Claude → format → reply

### 4. Cron (Automated Tasks)

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
├── SessionManager          → session.ts          — reads/writes ~/.claude/active-session-id
├── ClaudeInvoker           → claude.ts           — spawns claude CLI, handles timeouts, parses JSON
├── ProjectManager          → projects.ts         — project registry, handoff state, git sync
├── createTelegramBot()     → telegram.ts         — Grammy bot with auth middleware + handlers
├── PipelineWatcher         → pipeline.ts         — cross-user task queue (Gregor → Isidore)
├── ReversePipelineWatcher  → reverse-pipeline.ts — delegation queue (Isidore → Gregor)
├── TaskOrchestrator        → orchestrator.ts     — DAG workflow decomposition + execution
├── BranchManager           → branch-manager.ts   — task-specific branch isolation + locks
├── compactFormat()         → format.ts           — strips PAI Algorithm formatting for mobile
├── chunkMessage()          → format.ts           — splits long responses for Telegram's 4096 limit
└── escMd()                 → format.ts           — escapes Markdown in notifications
```

### Message Flow (Telegram)

```
User message
  → Grammy middleware: check user ID
  → Send "typing" indicator
  → ClaudeInvoker.send(message)
    → Read session ID from file
    → Spawn: claude [--resume <id>] -p "message" --output-format json
    → Wait (up to 5 min timeout)
    → Parse JSON response
    → Save real session ID from Claude's response
  → compactFormat(response)
    → Strip Algorithm headers, ISC gates, voice curls, time checks
    → No truncation — chunkMessage() handles splitting
  → chunkMessage(formatted, 4000)
    → Split at paragraph → line → space → hard break boundaries
    → Add [1/N] part indicators
  → Send chunks back to Telegram
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

## Session Management

Sessions are the mechanism for conversation continuity. Claude Code identifies conversations by session ID — passing `--resume <session-id>` continues where you left off.

### How Session IDs Work

```
1. First message (no session ID file):
   claude -p "hello" --output-format json
   → Claude creates a new session
   → Response includes session_id: "abc-123..."
   → Bridge saves "abc-123..." to ~/.claude/active-session-id

2. Subsequent messages:
   claude --resume abc-123... -p "continue" --output-format json
   → Claude resumes the conversation
   → Same context, same history

3. /new or /clear command:
   → Archives current session ID to ~/.claude/archived-sessions/
   → Clears active-session-id
   → Next message starts fresh (back to step 1)
```

### Session ID File

- **Path:** `/home/isidore_cloud/.claude/active-session-id`
- **Content:** A single line containing the UUID-format session ID
- **Shared by:** Telegram bridge, SSH/tmux sessions, cron (read-only)
- **Archives:** `~/.claude/archived-sessions/{timestamp}_{id}.session`

### Gotcha: Stale Session IDs

If the session ID file points to a session that no longer exists (e.g., after a service restart or Claude Code update), you'll get:

```
Error: No conversation found with session ID: abc-123...
```

**Auto-recovery:** The bridge detects this automatically (`claude.ts:93-97`), clears the stale session, and retries. No manual intervention needed. **Manual fallback:** Delete the file (`rm ~/.claude/active-session-id`) if auto-recovery fails.

---

## Project Handoff Protocol

The handoff protocol enables seamless project switching between local Isidore and Isidore Cloud. Each project maintains its own session, working directory, and git state.

### The Problem

Working on multiple projects across two instances (local + VPS) without a protocol means:
- Losing conversation context when switching projects
- Forgetting to commit/push before switching
- No way to know what the other instance was working on

### The Solution

A **project registry** (`config/projects.json`) tracks all projects. A **handoff state file** (`~/.claude/handoff-state.json`) maps each project to its own Claude session ID. The bridge coordinates switching.

### Project Registry

```json
{
  "version": 1,
  "projects": [
    {
      "name": "my-pai-cloud-solution",
      "displayName": "My PAI Cloud Solution",
      "git": "https://github.com/mj-deving/my-pai-cloud-solution.git",
      "paths": {
        "local": "/home/mj/projects/my-pai-cloud-solution",
        "vps": "/home/isidore_cloud/projects/my-pai-cloud-solution"
      },
      "autoClone": true,
      "active": true
    }
  ]
}
```

**Key fields:**
- `paths.local` / `paths.vps` — Where the project lives on each machine. Can be `null` for cloud-only or local-only projects.
- `autoClone` — If `true`, the bridge will `git clone` the project on first access if the directory doesn't exist.
- `active` — Soft-delete flag. Inactive projects are hidden from `/projects`.

**Two copies exist:**
1. `config/projects.json` — Bundled with the bridge code (deployed via rsync)
2. `pai-knowledge/HANDOFF/projects.json` — In the knowledge sync repo (survives across instances)

### Handoff State

```json
{
  "activeProject": "my-pai-cloud-solution",
  "lastSwitch": "2026-02-26T15:30:00.000Z",
  "sessions": {
    "my-pai-cloud-solution": "abc-123-session-id",
    "openclaw-bot": "def-456-session-id"
  }
}
```

Each project gets its own Claude session. When you switch projects:
1. Current project's session ID is saved
2. Target project's session ID is restored (or a new session is started)
3. Claude's working directory is updated
4. The bridge automatically pushes the current project and pulls the target

### Project Switching Flow (`/project <name>`)

```
/project openclaw-bot
  → Auto-push current project (git add -u && commit && push)
  → Look up "openclaw-bot" in registry (case-insensitive partial match)
  → Ensure target is cloned on this machine (auto-clone if needed)
  → Pull latest code (git pull)
  → Pull latest knowledge (sync-knowledge.sh pull)
  → Save current session ID, restore target's session ID
  → Set Claude working directory to target's path
  → Reply with status
```

### Project Creation (`/newproject <name>`)

Creates everything from scratch via a single Telegram command:

```
/newproject my-new-project
  → Validate name (lowercase kebab-case)
  → Check for duplicates in registry
  → gh repo create mj-deving/my-new-project --private
  → git clone into /home/isidore_cloud/projects/my-new-project/
  → Write scaffold CLAUDE.md (conventions, handoff instructions)
  → git add -A && commit && push
  → Add to registry (both copies) and save
  → Auto-switch to the new project
  → Reply with details + "git clone ..." instruction for local pickup
```

**New projects start as cloud-only** (`paths.local: null`). When you want to work on it locally, just `git clone` from GitHub and update the registry with the local path.

### Cross-Instance Handoff (`/handoff`)

A combination of `/done` + a status summary:

```
/handoff
  → Git commit + push current project
  → Knowledge sync push
  → Reply with:
    - Git status (pushed / nothing to push)
    - Knowledge sync status
    - Current session ID
    - Path on this machine
    - "To pick up locally: cd /path && git pull"
```

### CLAUDE.handoff.md

When knowledge sync pulls, it can write a `CLAUDE.handoff.md` file in the project directory. This file contains the other instance's last session state — what it was working on, what decisions were made, what's pending.

**Important:** `CLAUDE.handoff.md` never overwrites `CLAUDE.local.md`. Each instance maintains its own local context. The handoff file is *additional* context.

Each project's `CLAUDE.md` contains the instruction: "If `CLAUDE.handoff.md` exists, read it on session start."

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

### Layer 2 — Pipeline Watcher (Isidore Cloud Side)

`src/pipeline.ts` — A `PipelineWatcher` class integrated into the bridge service:

```
Bridge startup
  → PipelineWatcher.start()
  → Poll /var/lib/pai-pipeline/tasks/ every 5 seconds
  → For each .json file found:
      1. Read and parse all JSON task files
      2. Validate required fields (id, prompt)
      3. Sort by priority (high > normal > low), tie-break by timestamp
      4. For each task in priority order:
         a. Resolve working directory (project → dir, with fallback)
         b. Dispatch to claude -p (one-shot, or --resume if session_id provided)
         c. Write result atomically (.tmp → rename) to results/
         d. Move task file from tasks/ to ack/
```

**Design decisions:**
- **One-shot by default, multi-turn optional** — Pipeline tasks default to fresh Claude context (one-shot). If a task includes a `session_id` from a previous result, Claude resumes that conversation via `--resume`. Stale session IDs are handled gracefully — the watcher retries without `--resume` and includes a warning in the result.
- **Priority-sorted processing** — Tasks with `priority: "high"` are processed before `"normal"` (default), which are processed before `"low"`. Within the same priority level, earlier timestamps win. Priority ordering applies within a single poll batch — a running task is never interrupted.
- **Atomic result writes** — Results are written to a `.tmp` file first, then renamed. Gregor never reads a partial result.
- **Malformed JSON handling** — If a task file can't be parsed (e.g., still being written), it's skipped and retried on the next poll cycle. No crash, no data loss.
- **Non-blocking** — A concurrency pool (`activeCount`/`inFlight`/`activeProjects`) manages parallel dispatch. The pipeline never blocks Telegram message handling.
- **cwd fallback** — If a task's `project` field points to a non-existent directory, the watcher falls back to `$HOME` and includes a warning in the result. Tasks still get processed.

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
┌────────────────────┐                    ┌────────────────────┐
│ pai-submit.sh      │                    │ PipelineWatcher    │
│   writes JSON ─────┼──► tasks/task.json │   polls every 5s   │
│                    │                    │   reads task.json   │
│                    │                    │   ▼                 │
│                    │                    │   claude -p "prompt" │
│                    │                    │   ▼                 │
│ pai-result.sh      │                    │   writes result     │
│   reads JSON ◄─────┼─── results/id.json │   moves to ack/    │
│                    │                    │                    │
│ pai-status.sh      │                    │                    │
│   reads all dirs   │                    │                    │
└────────────────────┘                    └────────────────────┘
```

### Configuration

Pipeline settings in `config.ts`:

| Env Variable | Default | Purpose |
|-------------|---------|---------|
| `PIPELINE_ENABLED` | `"1"` (enabled) | Set to `"0"` to disable the watcher |
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

### Concurrency Pool (Phase 4)

The pipeline supports concurrent task execution up to `PIPELINE_MAX_CONCURRENT` (default 1, set to 8 on VPS):

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
- **Wrapup guard:** `lightweightWrapup()` accepts optional `expectedBranch` — refuses to commit if on wrong branch
- **Crash recovery:** Existing branches are reused (not error), stale locks cleaned on startup
- **Orchestrator integration:** Isidore workflow steps also use branch isolation (`pipeline/<wfId>-<stepId>`)
- **`/branches` command:** Shows active locks with source, project, task ID, and age

---

### The Problem

Claude Code is stateless. Every session starts from scratch, loading context from files on disk. "Knowledge" is just files. Two instances on two machines = two separate file systems = divergent knowledge.

### The Solution

A private GitHub repo (`mj-deving/pai-knowledge`) acts as the intermediary. Both instances push/pull knowledge to/from this repo.

```
     Local Isidore (WSL2)              Isidore Cloud (VPS)
     ┌──────────────────┐              ┌──────────────────┐
     │ ~/.claude/MEMORY/ │              │ ~/.claude/MEMORY/ │
     │ ~/.claude/skills/ │              │ ~/.claude/skills/ │
     └────────┬─────────┘              └────────┬─────────┘
              │                                 │
              │ sync-knowledge.sh push          │ sync-knowledge.sh push
              │ (copy → commit → push)          │ (copy → commit → push)
              │                                 │
              ▼                                 ▼
     ┌──────────────────┐              ┌──────────────────┐
     │ ~/pai-knowledge/  │◄── GitHub ──►│ ~/pai-knowledge/  │
     │   (local clone)   │  (private)   │   (VPS clone)    │
     └────────┬─────────┘              └────────┬─────────┘
              │                                 │
              │ sync-knowledge.sh pull          │ sync-knowledge.sh pull
              │ (pull → copy to MEMORY)         │ (pull → copy to MEMORY)
              ▲                                 ▲
```

### What Syncs

| Data | Direction | Why |
|------|-----------|-----|
| `USER/` (ABOUTME, contacts, preferences, Telos) | Bidirectional | Same person, same profile |
| `RELATIONSHIP/` (daily interaction notes) | Bidirectional | Same relationship with you |
| `LEARNING/` (algorithm learnings, failures, signals) | Bidirectional | Mistakes on one instance benefit the other |

### What Does NOT Sync (by design)

| Data | Why |
|------|-----|
| Active session context | Each instance has its own conversation |
| `CLAUDE.local.md` | Environment-specific session continuity |
| `settings.json` | Different paths, different hook subsets, different identity name |
| `STATE/` | Session pointers, caches — environment-local |
| `VOICE/` | Local hardware only (no speakers on VPS) |
| Per-project `MEMORY.md` | Path-bound, different on each machine |

### Repo Structure

```
pai-knowledge/            (github.com/mj-deving/pai-knowledge, private)
├── USER/                 # Mirror of ~/.claude/skills/PAI/USER/
│   ├── ABOUTME.md
│   ├── CONTACTS.md
│   ├── PROJECTS/
│   ├── TELOS/
│   └── ...
├── RELATIONSHIP/         # Daily notes (append-only per day)
│   └── 2026-02/
│       ├── 2026-02-25.md
│       └── 2026-02-26.md
├── LEARNING/             # Accumulated learnings
│   ├── ALGORITHM/        # Algorithm execution learnings
│   ├── SYSTEM/           # Infrastructure learnings
│   ├── SIGNALS/          # User satisfaction data (ratings JSONL)
│   └── FAILURES/         # Failure mode documentation
├── WORK-ARTIFACTS/       # Shared PRDs and threads
└── .sync-meta.json       # Last sync timestamps per instance
```

### Sync Script

`scripts/sync-knowledge.sh` handles both directions:

```bash
# Push local knowledge to repo (run at session end)
sync-knowledge.sh push
# 1. cd ~/pai-knowledge && git pull --rebase
# 2. rsync USER/, RELATIONSHIP/, LEARNING/ from ~/.claude/ to repo
# 3. git add -A && git commit && git push

# Pull repo knowledge to local (run at session start)
sync-knowledge.sh pull
# 1. cd ~/pai-knowledge && git pull
# 2. rsync USER/, RELATIONSHIP/, LEARNING/ from repo to ~/.claude/
```

### Conflict Handling

| Data | Conflict scenario | Resolution |
|------|------------------|------------|
| RELATIONSHIP daily notes | Both append to same day | Git auto-merge (appends at different positions) |
| LEARNING JSONL | Both append lines | Git auto-merge (different lines) |
| USER profile files | Both edit same file | Rare. Local is authoritative. Git conflict → manual resolve |

### Sync Latency

- Session end on one instance → push → session start on other instance → pull = **seconds**
- Both active simultaneously → diverge until next session boundary = **acceptable**

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

#### 7. Set Up Knowledge Sync

```bash
# Create private repo
gh repo create your-username/pai-knowledge --private

# Clone locally
gh repo clone your-username/pai-knowledge ~/pai-knowledge

# Generate deploy key on VPS
ssh isidore_cloud 'ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_github -N ""'

# Add deploy key to repo (with write access)
gh repo deploy-key add --repo your-username/pai-knowledge --title "vps" -w <(ssh isidore_cloud 'cat ~/.ssh/id_ed25519_github.pub')

# Configure VPS SSH for GitHub
ssh isidore_cloud 'cat > ~/.ssh/config << EOF
Host github.com
    HostName github.com
    User git
    IdentityFile ~/.ssh/id_ed25519_github
    IdentitiesOnly yes
EOF'

# Set git identity on VPS
ssh isidore_cloud 'git config --global user.name "Isidore Cloud" && git config --global user.email "isidore-cloud@pai.local"'

# Clone on VPS
ssh isidore_cloud 'git clone git@github.com:your-username/pai-knowledge.git ~/pai-knowledge'

# Initial seed (from local)
scripts/sync-knowledge.sh push

# Pull on VPS
ssh isidore_cloud 'CLAUDE_DIR=~/.claude bash ~/projects/my-pai-cloud-solution/scripts/sync-knowledge.sh pull'
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
# → Send a message to your bot, expect a response

# Knowledge sync works
ssh isidore_cloud 'CLAUDE_DIR=~/.claude bash ~/projects/my-pai-cloud-solution/scripts/sync-knowledge.sh pull'
ssh isidore_cloud 'ls ~/.claude/MEMORY/RELATIONSHIP/'  # → dated files

# GitHub access (VPS)
ssh isidore_cloud 'ssh -T git@github.com'  # → "Hi your-username/pai-knowledge!"
```

---

## File Reference

### Source Code (`src/`)

| File | Purpose | Key exports |
|------|---------|-------------|
| `bridge.ts` | Entry point. Loads config, initializes all components, wires callbacks, starts services. | `main()` |
| `telegram.ts` | Grammy bot setup. Auth middleware, command handlers, message forwarding. | `createTelegramBot()` |
| `claude.ts` | Claude CLI wrapper. Spawns `claude` with `--resume`, handles timeouts, parses JSON. | `ClaudeInvoker`, `ClaudeResponse` |
| `session.ts` | Reads/writes the shared session ID file. Archives old sessions. | `SessionManager` |
| `projects.ts` | Project registry, handoff state, git sync, project creation. | `ProjectManager`, `ProjectEntry` |
| `pipeline.ts` | Cross-user task queue watcher with concurrency pool and branch isolation. | `PipelineWatcher`, `PipelineTask`, `PipelineResult` |
| `reverse-pipeline.ts` | Isidore→Gregor delegation. Writes tasks, polls results, crash recovery. | `ReversePipelineWatcher`, `PendingDelegation` |
| `orchestrator.ts` | DAG workflow decomposition via Claude, step dispatch, persistence. | `TaskOrchestrator`, `Workflow`, `WorkflowStep` |
| `branch-manager.ts` | Task-specific branch creation, locking, release, stale cleanup. | `BranchManager`, `BranchLock` |
| `wrapup.ts` | Auto-commit tracked changes with branch guard (refuses wrong branch). | `lightweightWrapup()` |
| `format.ts` | Strips PAI Algorithm verbosity, chunks for Telegram, escapes Markdown. | `compactFormat()`, `chunkMessage()`, `escMd()` |
| `config.ts` | Reads environment variables, validates required ones, returns typed config. | `Config`, `loadConfig()` |
| `resource-guard.ts` | Memory-gated dispatch. Checks `os.freemem()` before allowing tasks. | `ResourceGuard` |
| `rate-limiter.ts` | Sliding-window failure tracking with cooldown period. | `RateLimiter` |
| `verifier.ts` | Result verification via separate Claude one-shot. Fail-open. | `Verifier` |
| `isidore-cloud-session.ts` | CLI tool for manual session management (inspect, clear, archive). | CLI script |
| `isidore-session.ts` | CLI helper (alternate usage string variant of session tool). | CLI script |

### Scripts (`scripts/`)

| Script | Purpose | When to run |
|--------|---------|-------------|
| `setup-vps.sh` | Creates `isidore_cloud` user, installs Bun + Claude CLI, configures SSH. | Once, during initial setup |
| `deploy-key.sh` | Deploys your SSH public key to the VPS `authorized_keys`. | Once, during initial setup |
| `deploy.sh` | Full deployment: rsync code, install deps, restart services. Excludes `CLAUDE.local.md`. | Every time you update the code |
| `auth-health-check.sh` | Checks Claude OAuth health. Runs via cron every 4 hours. | Automatically via cron |
| `run-task.sh` | Runs a one-shot Claude task. For cron-based automation. | Manually or via cron |
| `sync-knowledge.sh` | Bidirectional knowledge sync via Git. `push` or `pull`. | At session boundaries or via /done, /project commands |
| `project-sync.sh` | Git operations for project handoff: `pull`, `push`, `clone`. | Called by ProjectManager (not directly) |

### Systemd (`systemd/`)

| Service | Purpose | Type |
|---------|---------|------|
| `isidore-cloud-bridge.service` | Telegram bridge (always running, auto-restart) | simple |
| `isidore-cloud-tmux.service` | Persistent tmux session for SSH work | forking |

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

### Knowledge sync fails

```bash
# Check SSH to GitHub works
ssh isidore_cloud 'ssh -T git@github.com'

# Check repo state
ssh isidore_cloud 'cd ~/pai-knowledge && git status'

# If dirty state from failed sync:
ssh isidore_cloud 'cd ~/pai-knowledge && git stash && git pull'
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

- **GitHub PAT for VPS** — Classic PAT with `repo` scope, authenticated via `gh auth`.
- **VPS CLAUDE.local.md** — Isidore Cloud has self-awareness about its infrastructure.
- **Handoff protocol** — Full project registry, per-project sessions, `/project`, `/done`, `/handoff` commands.
- **`/newproject` command** — Telegram-driven project creation (GitHub repo + VPS dir + scaffold + registry).
- **Cross-user pipeline (Phase 3)** — Gregor↔Isidore Cloud task queue with shared dirs, watcher, sender scripts.
- **Session-project affinity + structured results (Phase 2)** — Per-project session isolation, priority sorting.
- **Parallel pipeline execution (Phase 4)** — Concurrency pool with per-project locking, `PIPELINE_MAX_CONCURRENT`.
- **Reverse pipeline (Phase 5A)** — Isidore→Gregor delegation via `/delegate` command. Crash recovery via directory scan.
- **Task orchestrator (Phase 5B)** — DAG workflow decomposition, parallel step dispatch, mixed isidore/gregor assignees. Persists to disk.
- **Branch isolation (Phase 5C)** — Pipeline/orchestrator tasks run on `pipeline/<taskId>` branches. Lock persistence, wrapup branch guard, `/branches` command.
- **UX fixes** — `/workflow status` subcommand, `escMd()` Markdown escaping in all notifications.
- **Resource guard, rate limiter, verifier, quick model (Phase 6A-6D)** — Memory-gated dispatch, failure-rate circuit breaker, result verification, `/quick` Haiku shortcut.
- **Per-task timeout + max-turns** — Pipeline tasks can specify `timeout_minutes` (overrides 5min default) and `max_turns` (passed to CLI). Enables long-running overnight PRD execution.
- **Workflow-completion results** — Orchestrator writes `results/workflow-<taskId>.json` when workflows finish (success, failure, or timeout) so Gregor can consume outcomes programmatically.
- **Gregor reverse handler fix** — `pai-reverse-handler.sh` now uses `--local` flag for `openclaw agent` routing.
- **Gregor overnight queue system** — `pai-overnight.sh` + `pai-overnight-local.sh` for PRD-driven overnight batch processing with sequential queue, cron-based advancement, and morning reports.

### Planned

- **E2E multi-step orchestrate test** — Test workflow with both isidore and gregor-assigned steps now that reverse handler is fixed.
- **E2E overnight queue test** — Smoke test with trivial PRDs to validate the full overnight flow.
- **Email bridge (C6)** — IMAP polling + SMTP response. Architecture is in place, needs email server credentials from Marius.

### Vision

- **Full parity** — Isidore Cloud should be able to do everything local Isidore can (minus voice/browser), including working on repos, running tests, deploying code.
- **Proactive behavior** — Cron-triggered tasks: daily summaries, project monitoring, automated maintenance.
- **Multi-channel unified inbox** — Telegram, email, and future channels (Signal, Matrix?) all feed into one conversation.

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
- The knowledge sync pattern (Git repo as intermediary) works for any multi-instance AI
- The systemd service definitions work on any Linux server
- The compact formatter is specific to PAI Algorithm output — replace with your own formatting needs

### What's Specific to This Setup

- PAI skills and hooks (the full Algorithm system)
- The naming convention (Isidore / Isidore Cloud)
- Coexistence with Gregor/OpenClaw on the same VPS
- The specific Telegram user ID authentication

---

*Last updated: 2026-02-27 (Phases 4-6D + per-task timeout, workflow-completion results, overnight queue support)*
*Author: mj-deving + Isidore (PAI)*
