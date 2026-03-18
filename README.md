# PAI Cloud Solution

> Turn Claude Code into an always-on AI agent you can reach from anywhere.

---

## The Problem

Claude Code is powerful — but it lives in your terminal. Close the lid and it's gone. You can't message it from your phone on the train. You can't have it running background tasks while you sleep. You can't hand it a project and check back tomorrow.

## What This Is

A cloud runtime that deploys Claude Code to a VPS as a 24/7 AI agent, accessible over Telegram. It wraps the CLI with persistent memory, context injection, autonomous scheduling, and inter-agent collaboration — turning a local dev tool into an always-available assistant.

```
You
│
├── At your desk
│   └── Terminal → claude                    ← local instance
│
├── On your phone / anywhere
│   └── Telegram → Bridge → claude --resume  ← cloud agent (this project)
│       ├── SQLite memory (episodic + semantic)
│       ├── Context injection (scored retrieval)
│       ├── Dual-mode (workspace / project)
│       └── Statusline on every reply
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
| **Direct API fast-path** | Built, not enabled | Sonnet API for simple messages, classifier-based routing (Graduated Extraction Phase 1) |
| **PRD executor** | Built, not enabled | Autonomous PRD detection, parsing, and execution |
| **Email bridge** | Planned | IMAP polling + SMTP response (architecture in place) |

221 tests across 15 test files. Type-checked with `tsc --noEmit`.

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
bun test              # 221 tests across 15 files
npx tsc --noEmit      # type check
bun run src/bridge.ts # run locally
```

## Tech Stack

- **Runtime:** [Bun](https://bun.sh) — runs TypeScript directly, no build step
- **Telegram:** [Grammy](https://grammy.dev) — bot framework with middleware
- **Database:** SQLite via `bun:sqlite` — episodic memory, semantic memory, FTS5, scheduler
- **Validation:** [Zod](https://zod.dev) — all cross-agent JSON boundaries + env config
- **Process management:** systemd — two services (bridge + tmux)
- **Code review:** [Codex CLI](https://github.com/openai/codex) — two-layer review (local pre-commit + GitHub PR bot)

No Docker. No Kubernetes. No cloud functions. Just a VPS and systemd.

## Where This Is Going

**Full parity.** The cloud agent should handle everything the local instance can — including headless browser automation. Voice is the only local-only capability.

**Autonomy.** The PRD executor, scheduler, daily memory, and synthesis loop are already built. The infrastructure for proactive, self-directed behavior exists — it needs enabling and hardening.

**Agent convergence.** Co-located agent frameworks (like [OpenClaw](https://github.com/claw-project/OpenClaw)) run on the same VPS. Rather than adopting their runtime, the strategy is graduated extraction — absorb capabilities, don't merge codebases. Phase 1 (Sonnet fast-path) is implemented. Phase 2 (HealthMonitor, backup scripts) is deployed. Phase 3A (gateway routes on dashboard) is deployed. Phase 3B (plugin architecture) has type foundations.

**Multi-channel.** Email bridge architecture is in place. The goal is a unified inbox — Telegram, email, and future channels all feed one conversation.

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
  ...                # 40 modules total — see ARCHITECTURE.md for full reference
scripts/
  deploy.sh          # Full deployment (rsync + bun install + restart)
  setup-vps.sh       # VPS provisioning (user, deps, coexistence)
  backup.sh          # WAL-safe backup with rotation (memory.db + bridge.env)
systemd/
  isidore-cloud-bridge.service   # Main service
  isidore-cloud-tmux.service     # Persistent tmux session
```

Full file reference with descriptions: [ARCHITECTURE.md](ARCHITECTURE.md#file-reference)

---

**Author:** [mj-deving](https://github.com/mj-deving)

Built with [Claude Code](https://claude.ai/code) and [Codex](https://github.com/openai/codex).
