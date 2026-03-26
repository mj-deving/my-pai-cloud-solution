# PAI Cloud Solution

> Turn Claude Code into an always-on AI agent you can reach from anywhere.

---

## The Problem

Claude Code is powerful — but it lives in your terminal. Close the lid and it's gone. You can't message it from your phone on the train. You can't have it running background tasks while you sleep. You can't hand it a project and check back tomorrow.

## What This Is

A cloud runtime that deploys Claude Code to a VPS as a 24/7 AI agent, accessible over Telegram, Claude Channels, and Remote Control. Persistent memory, context injection, autonomous scheduling, and inter-agent collaboration — turning a local dev tool into an always-available assistant.

**Architecture direction:** Migrating from a custom Telegram bridge (6600 LOC) to Claude Channels as the primary access surface — Channels provides native interactive sessions with permission relay and efficient hook invocation.

```
You
│
├── At your desk
│   └── Terminal → claude                    ← local instance
│
├── On your phone / anywhere
│   ├── Telegram → Bridge → claude --resume  ← bridge (current primary)
│   ├── Telegram → Channels plugin           ← Claude Channels (future primary)
│   │   └── Native interactive session with permission relay
│   └── Claude app → Remote Control          ← direct CLI from mobile
│       └── claude remote-control --spawn worktree
│
├── Scheduled tasks
│   └── Scheduler → claude -p "task"         ← one-shot, no session
│       ├── Daily synthesis
│       ├── Daily memory summary
│       └── Weekly health review
│
└── Inter-agent collaboration
    └── Shared pipeline (/var/lib/pai-pipeline/)
        ├── Forward tasks (other agents → cloud agent)
        ├── Reverse delegation (cloud agent → other agents)
        └── DAG workflows (multi-step, mixed assignees)
```

## What's Built

| Feature | Status | Description |
|---------|--------|-------------|
| **Telegram bridge** | Production | Grammy bot → Claude CLI wrapper with session management, auth, 30+ commands |
| **Dual-mode system** | Production | Workspace mode (autonomous, auto-session) and project mode (focused git-repo work) |
| **Memory system** | Production | SQLite episodic + semantic memory, FTS5 full-text search, importance scoring |
| **Context injection** | Production | Topic-based retrieval, budget-aware allocation, importance masking |
| **Compact formatter** | Production | Mobile-friendly output with Markdown escaping, chunked for Telegram's 4096-char limit |
| **Error resilience** | Production | `bot.catch` global handler, `safeReply` with parse-error fallback, streaming error capture |
| **Inter-agent pipeline** | Production | Cross-user task queue with Zod validation, concurrent dispatch, atomic writes |
| **DAG orchestrator** | Production | Workflow decomposition, parallel execution, completion routing |
| **Scheduler** | Production | SQLite-backed cron — daily synthesis, weekly review, custom tasks |
| **PR-based git workflow** | Production | Auto-branch, PR creation, Codex review (local + GitHub), merge via Telegram |
| **Dashboard** | Production | HTTP API + SSE + dark-themed Kanban board |
| **Policy engine** | Production | YAML-based action authorization |
| **Injection scanning** | Production | 18-pattern regex detection, blocking mode on gateway (403 on high risk) |
| **Synthesis loop** | Production | Periodic knowledge distillation, per-domain synthesis, whiteboard generation |
| **Agent definitions** | Production | Declarative agent specs with tier-based sub-delegation |
| **Daily memory** | Production | Cron-scheduled episode summary → markdown → git |
| **Health monitor** | Production | Periodic subsystem checks, Telegram delivery tracking, sliding-window rate detection |
| **HTTP gateway** | Production | REST API on dashboard (/api/send, /api/session, /api/status) with bearer auth and injection blocking |
| **Backup scripts** | Production | WAL-safe memory.db + bridge.env backup with 7-day rotation, cron-scheduled |
| **BridgeContext** | Production | Typed subsystem bag replacing positional constructor args, Plugin interface (type-only) |
| **DAG memory** | Production | Hierarchical summarization over episodes, fresh-tail protection |
| **Loop detection** | Production | Per-session tool-call hashing, 3-phase escalation (warn→instruct→hard stop) |
| **A2A server** | Production | JSON-RPC 2.0 agent discovery and message exchange |
| **A2A client** | Production | Outbound agent communication with Zod-validated responses |
| **Guardrails** | Production | Pre-execution authorization gate (allowlist/denylist at dispatch points) |
| **Group chat** | Production | Multi-agent parallel dispatch with moderator synthesis |
| **Playbook runner** | Production | Markdown checklist execution with GAN evaluator pattern |
| **Worktree pool** | Production | Git worktree isolation for parallel agent work |
| **Context compression** | Production | Three-pass compression with DAG integration |
| **Direct API fast-path** | Production | Sonnet API for simple messages, classifier-based routing |
| **PRD executor** | Production | Autonomous PRD detection, parsing, and execution |
| **Claude Channels** | In progress | Telegram plugin installed, pending bot token |
| **Remote Control** | In progress | Server mode service created, pending workspace trust |
| **Email bridge** | Planned | IMAP polling + SMTP response (architecture in place) |

384 tests across 30 test files. Type-checked with `tsc --noEmit`.

## Quick Start

### Prerequisites

- A VPS (Ubuntu/Debian, 2GB RAM is enough)
- [Bun](https://bun.sh) runtime
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) with a Max subscription
- A Telegram bot token (free, via [@BotFather](https://t.me/BotFather))

### Setup

```bash
git clone https://github.com/mj-deving/my-pai-cloud-solution.git
cd my-pai-cloud-solution
bun install
```

Configure `bridge.env` with your Telegram bot token and allowed user ID, then:

```bash
bun run src/bridge.ts
```

For full VPS deployment (systemd services, SSH setup, PAI hooks), see the [Deployment Guide](ARCHITECTURE.md#deployment-guide) in ARCHITECTURE.md.

### Development

```bash
bun test              # 384 tests across 30 files
npx tsc --noEmit      # type check
bun run src/bridge.ts # run locally
```

## Tech Stack

- **Runtime:** [Bun](https://bun.sh) — runs TypeScript directly, no build step
- **Telegram:** [Grammy](https://grammy.dev) — bot framework with middleware
- **Database:** SQLite via `bun:sqlite` — episodic memory, semantic memory, FTS5, scheduler
- **Validation:** [Zod](https://zod.dev) — all cross-agent JSON boundaries + env config
- **Process management:** systemd — bridge + channels + remote control + tmux
- **Code review:** [Codex CLI](https://github.com/openai/codex) — two-layer review (local pre-commit + GitHub PR bot)

No Docker. No Kubernetes. No cloud functions. Just a VPS and systemd.

## Where This Is Going

**Full parity.** The cloud agent should handle everything the local instance can — including headless browser automation. Voice is the only local-only capability.

**Autonomy.** The PRD executor, scheduler, daily memory, and synthesis loop are already built. The infrastructure for proactive, self-directed behavior exists — it needs enabling and hardening.

**Agent convergence.** Co-located agent frameworks (like [OpenClaw](https://github.com/claw-project/OpenClaw)) run on the same VPS. Rather than adopting their runtime, the strategy is graduated extraction — absorb capabilities, don't merge codebases. Phase 1 (Sonnet fast-path) is implemented. Phase 2 (HealthMonitor, backup scripts) is deployed. Phase 3A (gateway routes on dashboard) is deployed. Phase 3B (plugin architecture) has type foundations.

**Channels-first.** Migrating from the custom bridge to Claude Channels as the primary Telegram access surface. Channels provides native interactive sessions, permission relay, and efficient hook invocation — eliminating 6600 lines of middleware. Remote Control adds mobile CLI access via the Claude app. See `Plans/phase-fg-channels-remote-control.md`.

**Replicable.** This is designed so anyone can fork it and deploy their own cloud AI agent. See [Replicating This System](ARCHITECTURE.md#replicating-this-system) in ARCHITECTURE.md.

## Project Structure

```
src/
  bridge.ts          # Entry point — wires Telegram + pipeline + orchestrator
  telegram.ts        # Grammy bot: auth, 30+ commands, statusline, error handling
  claude.ts          # Claude CLI wrapper: --resume, stream-json, importance scoring
  memory.ts          # SQLite episodic + semantic memory, FTS5, whiteboards
  context.ts         # Scored retrieval, topic tracking, budget injection
  pipeline.ts        # Inter-agent task queue, Zod validation, concurrent dispatch
  orchestrator.ts    # DAG workflow decomposition + execution
  mode.ts            # Dual-mode manager (workspace/project)
  config.ts          # Zod-validated env vars, feature flags
  health-monitor.ts  # Periodic health checks, Telegram delivery tracking
  types.ts           # BridgeContext bag + Plugin interface
  format.ts          # Mobile formatter, Markdown escaping, chunking
  github.ts          # PR operations via gh CLI
  guardrails.ts      # Pre-execution authorization (allowlist/denylist)
  a2a-client.ts      # Outbound A2A protocol client
  group-chat.ts      # Multi-agent group chat with moderator synthesis
  ...                # 45+ modules total — see ARCHITECTURE.md for full reference
scripts/
  deploy.sh          # Full deployment (rsync + bun install + restart)
  setup-vps.sh       # VPS provisioning (user, deps, coexistence)
  backup.sh          # WAL-safe backup with rotation (memory.db + bridge.env)
systemd/
  isidore-cloud-bridge.service     # Telegram bridge (current primary)
  isidore-cloud-remote.service     # Remote Control server mode
  isidore-cloud-channels.service   # Claude Channels Telegram plugin
  isidore-cloud-tmux.service       # Persistent tmux session
```

Full file reference with descriptions: [ARCHITECTURE.md](ARCHITECTURE.md#file-reference)

---

**Author:** [mj-deving](https://github.com/mj-deving)

Built with [Claude Code](https://claude.ai/code) and [Codex](https://github.com/openai/codex).
