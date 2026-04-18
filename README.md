# PAI Cloud Solution

> Turn Claude Code into an always-on AI agent you can reach from anywhere.

---

## The Problem

Claude Code is powerful — but it lives in your terminal. Close the lid and it's gone. You can't message it from your phone on the train. You can't have it running background tasks while you sleep. You can't hand it a project and check back tomorrow.

## What This Is

A cloud runtime that deploys Claude Code to a VPS as a 24/7 AI agent, accessible over Telegram, Claude Channels, and Remote Control. Persistent memory, context injection, autonomous scheduling, and inter-agent collaboration — turning a local dev tool into an always-available assistant.

**Architecture:** Migrating from a custom Telegram bridge to Claude Channels as the primary access surface. Channels provides native interactive sessions with permission relay and efficient hook invocation — eliminating the need for 6600 lines of custom middleware.

**Migration plan (2026-04-18):** Retirement is a 4-move additive migration, NOT a big-bang switchover. See [`docs/roadmap.md`](docs/roadmap.md) for per-move status and [`docs/decisions/0001-retire-bridge-additively.md`](docs/decisions/0001-retire-bridge-additively.md) for the decision rationale. Grammy shutdown (Move 4) is GATED on Anthropic resolving [claude-code#36477](https://github.com/anthropics/claude-code/issues/36477).

```
You
│
├── At your desk
│   └── Terminal → claude                           ← local instance
│
├── On your phone / anywhere
│   ├── Telegram → Channels plugin (@isidore_channel_bot)  ← LIVE (primary)
│   │   └── Native interactive session, MCP tools, PAI hooks
│   ├── Telegram → Bridge → claude --resume         ← bridge (legacy, active)
│   └── Claude app → Remote Control                 ← direct CLI from mobile
│
├── Scheduled tasks
│   └── Standalone pipeline watcher → claude -p     ← one-shot dispatch
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

## Migration Status

The project is transitioning from a monolithic bridge to standalone services:

| Phase | Description | Status |
|-------|-------------|--------|
| **1. MCP Memory Tools** | `.mcp.json` auto-loads pai-memory (8 tools) + pai-context (2 tools) | ✅ Complete |
| **2. Commands → Skills** | Map 28 bridge commands to skills/CLAUDE.md (6 new skills) | Ready |
| **3. Pipeline Watcher** | Standalone daemon replacing bridge's PipelineWatcher (855→320 lines) | ✅ Deployed |
| **4. Dashboard Extract** | Standalone Bun.serve with 22 routes, A2A, SSE (~600 lines) | ✅ Built |
| **5. Retire Bridge** | Decommission bridge.ts after parallel run | Blocked on #2 |
| **6. Remote Control** | Enable `claude remote-control` via tmux service | Ready |

## What's Built

### Access Surfaces
- **Claude Channels** — @isidore_channel_bot live on Telegram, full PAI stack (hooks, MCP, skills)
- **Telegram bridge** — Grammy bot with 30+ commands, session management, dual-mode (workspace/project)
- **Dashboard** — HTTP API + SSE on port 3456, bearer auth, injection scanning
- **A2A server** — JSON-RPC 2.0 agent discovery and message exchange

### Standalone Services (extracted from bridge)
- **Pipeline watcher** — Poll tasks/, validate (Zod), dispatch (claude -p), atomic write results/, ack. Injection scan, ENOENT fatal handling, SIGKILL timeout escalation
- **Dashboard** — 22 routes, read-only SQLite, claude-runner with guardrails, timing-safe auth, symlink guard

### Core Systems
- **Memory** — SQLite episodic + semantic memory, FTS5 search, importance scoring, DAG summarization
- **Context injection** — Topic-based retrieval, budget-aware allocation
- **Scheduler** — SQLite-backed cron (daily synthesis, weekly review, custom tasks)
- **Pipeline** — Cross-agent task queue with priority sorting, concurrent dispatch
- **Guardrails** — Pre-execution authorization, injection scanning (18 patterns)

412 tests across 32 files. Type-checked with `tsc --noEmit`.

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

For full VPS deployment (systemd services, SSH setup, PAI hooks), see [ARCHITECTURE.md](ARCHITECTURE.md).

### Development

```bash
bun test              # 412 tests across 32 files
npx tsc --noEmit      # type check
bun run src/bridge.ts # run bridge locally
```

## Tech Stack

- **Runtime:** [Bun](https://bun.sh) — runs TypeScript directly, no build step
- **Telegram:** [Grammy](https://grammy.dev) (bridge) + Channels plugin (native)
- **Database:** SQLite via `bun:sqlite` — episodic memory, FTS5, scheduler
- **Validation:** [Zod](https://zod.dev) — all cross-agent JSON boundaries + env config
- **Process management:** systemd + tmux — bridge, channels, pipeline, dashboard
- **Code review:** Fabric patterns + [Codex CLI](https://github.com/openai/codex) — dual review workflow

No Docker. No Kubernetes. No cloud functions. Just a VPS and systemd.

## Project Structure

```
src/                   # Bridge source (6600 LOC, being decomposed)
  bridge.ts            # Entry point — wires Telegram + pipeline + orchestrator
  telegram.ts          # Grammy bot: auth, 30+ commands, statusline
  claude.ts            # Claude CLI wrapper: --resume, stream-json
  memory.ts            # SQLite episodic + semantic memory, FTS5
  pipeline.ts          # Inter-agent task queue (bridge-coupled, disabled on VPS)
  mcp/                 # MCP servers: pai-memory (8 tools), pai-context (2 tools)
  hooks/               # Claude Code hooks for VPS
  __tests__/           # 412 tests across 32 files

standalone/            # Extracted services (bridge-independent)
  pipeline-watcher.ts  # Poll → validate → dispatch → ack (~320 lines)
  dashboard/           # Bun.serve HTTP server, A2A, SSE (~600 lines)

scripts/               # Deploy, start, backup scripts
systemd/               # Service files (bridge, channels, pipeline, dashboard)
config/                # Project registry
Plans/                 # Active migration plans (2 files)
Plans/archive/         # Completed/superseded plans (34 files)
research/archive/      # External project analysis reports
.ai/guides/            # Technical reference docs
.sessions/             # Session documentation (wrapup artifacts)
.mcp.json              # MCP server auto-discovery config
```

Full file reference: [ARCHITECTURE.md](ARCHITECTURE.md)

## Where This Is Going

**Channels-first.** The custom bridge is scaffolding. Claude Channels + hooks + MCP + CLAUDE.md is the target architecture. Each bridge capability maps to a native Claude Code feature.

**Autonomy.** PRD executor, scheduler, daily memory, and synthesis loop are built. The infrastructure for proactive, self-directed behavior exists.

**Replicable.** Designed so anyone can fork and deploy their own cloud AI agent.

---

**Author:** [mj-deving](https://github.com/mj-deving)

Built with [Claude Code](https://claude.ai/code).
