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
8. [Knowledge Sync](#knowledge-sync)
9. [VPS Infrastructure](#vps-infrastructure)
10. [Security Model](#security-model)
11. [Deployment Guide](#deployment-guide)
12. [File Reference](#file-reference)
13. [Troubleshooting](#troubleshooting)
14. [What's Next](#whats-next)
15. [Replicating This System](#replicating-this-system)

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
- **Coexistence.** The VPS is shared with other services (Gregor/OpenClaw). Each has its own Linux user, its own home directory, its own systemd services. They don't interfere.

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
│   └── Gregor / OpenClaw services — completely separate
│
├── User: isidore_cloud (SSH alias: isidore_cloud)
│   ├── ~/my-pai-cloud-solution/      # Deployed project code
│   │   ├── src/                       # TypeScript bridge + helpers
│   │   ├── scripts/                   # Deployment & maintenance
│   │   └── systemd/                   # Service definitions
│   │
│   ├── ~/pai-knowledge/               # Shared knowledge Git repo (clone)
│   │
│   ├── ~/.claude/                     # Claude Code configuration
│   │   ├── settings.json              # PAI settings (Isidore Cloud identity)
│   │   ├── skills/PAI/               # Full PAI skill set
│   │   ├── hooks/                    # PAI hooks (non-interactive subset)
│   │   ├── MEMORY/                   # Synced knowledge (RELATIONSHIP, LEARNING)
│   │   └── active-session-id         # Current conversation session pointer
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
└── Systemd services:
    ├── isidore-cloud-bridge.service   # Telegram bot (always running)
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
- `/new` — Start a fresh conversation (archives current session)
- `/status` — Show current session info and archived sessions
- `/clear` — Archive current session and start fresh
- `/compact` — Send `/compact` to Claude to compress context
- `/oneshot <msg>` — One-shot query without session (for quick questions)

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

### 3. Email (Planned — Phase 4)

IMAP polling + SMTP response. Not yet implemented — waiting on email server credentials. The architecture is in place:
- `config.ts` already has all email configuration fields
- `bridge.ts` has the placeholder for email polling
- Same pattern: poll → invoke Claude → format → reply

### 4. Cron (Automated Tasks)

One-shot invocations for scheduled work:

```bash
# Every 4 hours: check Claude OAuth health
0 */4 * * * /home/isidore_cloud/my-pai-cloud-solution/scripts/auth-health-check.sh
```

Cron jobs use `claude -p "task"` (no `--resume` — fresh context each time).

---

## The Bridge Service

The bridge is a single Bun process (`src/bridge.ts`) that orchestrates everything:

```
bridge.ts (entry point)
├── loadConfig()        → config.ts    — reads bridge.env, validates, returns typed config
├── SessionManager      → session.ts   — reads/writes ~/.claude/active-session-id
├── ClaudeInvoker       → claude.ts    — spawns claude CLI, handles timeouts, parses JSON
├── createTelegramBot() → telegram.ts  — Grammy bot with auth middleware + handlers
└── compactFormat()     → format.ts    — strips PAI Algorithm formatting for mobile
    chunkMessage()      → format.ts    — splits long responses for Telegram's 4096 limit
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
    → If still >2000 chars, extract voice summary + key content
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
- Code blocks (up to 2 for space)
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

**Fix:** Delete the file (`rm ~/.claude/active-session-id`) — the bridge will create a new session on the next message.

---

## Knowledge Sync

The most important architectural piece: how two instances of the same AI share knowledge.

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
- WorkingDirectory: `~/my-pai-cloud-solution`
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
0 */4 * * * /home/isidore_cloud/my-pai-cloud-solution/scripts/auth-health-check.sh
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
cp ~/my-pai-cloud-solution/bridge.env.example ~/.config/isidore_cloud/bridge.env
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
ssh isidore_cloud 'CLAUDE_DIR=~/.claude bash ~/my-pai-cloud-solution/scripts/sync-knowledge.sh pull'
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
ssh isidore_cloud 'CLAUDE_DIR=~/.claude bash ~/my-pai-cloud-solution/scripts/sync-knowledge.sh pull'
ssh isidore_cloud 'ls ~/.claude/MEMORY/RELATIONSHIP/'  # → dated files

# GitHub access (VPS)
ssh isidore_cloud 'ssh -T git@github.com'  # → "Hi your-username/pai-knowledge!"
```

---

## File Reference

### Source Code (`src/`)

| File | Purpose | Key exports |
|------|---------|-------------|
| `bridge.ts` | Entry point. Loads config, initializes session manager, Claude invoker, and Telegram bot. | `main()` |
| `telegram.ts` | Grammy bot setup. Auth middleware, command handlers, message forwarding. | `createTelegramBot()` |
| `claude.ts` | Claude CLI wrapper. Spawns `claude` with `--resume`, handles timeouts, parses JSON. | `ClaudeInvoker`, `ClaudeResponse` |
| `session.ts` | Reads/writes the shared session ID file. Archives old sessions. | `SessionManager` |
| `format.ts` | Strips PAI Algorithm verbosity for mobile. Chunks messages for Telegram. | `compactFormat()`, `chunkMessage()` |
| `config.ts` | Reads environment variables, validates required ones, returns typed config. | `Config`, `loadConfig()` |
| `isidore-cloud-session.ts` | CLI tool for manual session management (inspect, clear, archive). | CLI script |

### Scripts (`scripts/`)

| Script | Purpose | When to run |
|--------|---------|-------------|
| `setup-vps.sh` | Creates `isidore_cloud` user, installs Bun + Claude CLI, configures SSH. | Once, during initial setup |
| `deploy-key.sh` | Deploys your SSH public key to the VPS `authorized_keys`. | Once, during initial setup |
| `deploy.sh` | Full deployment: rsync code, install deps, restart services. | Every time you update the code |
| `auth-health-check.sh` | Checks Claude OAuth health. Runs via cron every 4 hours. | Automatically via cron |
| `run-task.sh` | Runs a one-shot Claude task. For cron-based automation. | Manually or via cron |
| `sync-knowledge.sh` | Bidirectional knowledge sync via Git. `push` or `pull`. | At session boundaries (manually or via hooks) |

### Systemd (`systemd/`)

| Service | Purpose | Type |
|---------|---------|------|
| `isidore-cloud-bridge.service` | Telegram bridge (always running, auto-restart) | simple |
| `isidore-cloud-tmux.service` | Persistent tmux session for SSH work | forking |

### Config (`config/`)

| File | Purpose |
|------|---------|
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

### Immediate (pending your input)

- **GitHub PAT for VPS** — Gives Isidore Cloud full GitHub access (clone any repo, create PRs, etc.). You generate the PAT, I configure `gh auth` on VPS.
- **Account-level SSH key** — Add the VPS SSH key to your GitHub account for git operations beyond just `pai-knowledge`.

### Planned

- **Email bridge (C6)** — IMAP polling + SMTP response. Architecture is in place, needs your email server credentials.
- **PAI hooks for auto-sync** — `KnowledgeSync.hook.ts` fires at SessionEnd (push) and SessionStart (pull) so sync happens automatically without manual script invocation.
- **VPS CLAUDE.local.md** — Give Isidore Cloud self-awareness about its own infrastructure state.

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

*Last updated: 2026-02-26*
*Author: Marius Jonathan Jauernik + Isidore (PAI)*
