# PAI Cloud Solution

Deploy Isidore Cloud (PAI assistant) to a VPS for 24/7 mobile access via Telegram, email, and SSH.

## Architecture

All channels share one conversation via a session ID file:

- **SSH** — Interactive `claude` in tmux (deep work)
- **Telegram** — `claude --resume` programmatic bridge (mobile)
- **Email** — `claude --resume` programmatic bridge (async)
- **Cron** — One-shot `claude -p` (scheduled automation)

## Naming Convention

| Aspect | Local (WSL2) | VPS |
|--------|-------------|-----|
| Identity | Isidore | Isidore Cloud |
| Linux user | mj | `isidore_cloud` |
| SSH alias | N/A | `isidore_cloud` |

## Project Structure

```
src/
  bridge.ts                # Main entry: wires Telegram + pipeline + orchestrator
  telegram.ts              # Telegram bot (Grammy) — auth, commands, message forwarding
  claude.ts                # Claude CLI --resume wrapper with timeout handling
  session.ts               # Shared session ID management
  projects.ts              # Project registry, handoff state, git sync
  pipeline.ts              # Cross-user task queue (Gregor → Isidore) with concurrency pool, per-task timeout
  reverse-pipeline.ts      # Reverse delegation (Isidore → Gregor)
  orchestrator.ts          # DAG-based workflow decomposition, execution, completion results
  branch-manager.ts        # Task-specific branch isolation with lock persistence
  resource-guard.ts        # Memory-gated dispatch (Phase 6A)
  rate-limiter.ts          # Failure-rate circuit breaker (Phase 6A)
  verifier.ts              # Result verification via separate Claude one-shot (Phase 6B)
  format.ts                # Compact mobile-friendly formatter + Markdown escaping
  wrapup.ts                # Auto-commit tracked changes with branch guard
  config.ts                # Environment configuration
  isidore-cloud-session.ts # CLI session management tool
scripts/
  setup-vps.sh             # Phase 1: VPS user, deps, coexistence check
  deploy-key.sh            # Deploy SSH key to isidore_cloud user
  deploy.sh                # Full deployment (code, PAI, services)
  auth-health-check.sh     # Cron: OAuth token monitoring
  run-task.sh              # Cron: one-shot task runner
  sync-knowledge.sh        # Bidirectional knowledge sync (local <-> VPS)
systemd/
  isidore-cloud-bridge.service  # Telegram + pipeline + orchestrator service
  isidore-cloud-tmux.service    # Persistent tmux session
```

## Setup

1. Run `setup-vps.sh` via SSH to create user, install deps
2. Run `deploy-key.sh` locally to set up SSH key
3. Authenticate Claude: `ssh -L 7160:localhost:7160 isidore_cloud` then `claude /login`
4. Run `deploy.sh` to sync code, PAI, and services
5. Configure `bridge.env` with Telegram bot token
6. Enable services: `sudo systemctl enable --now isidore-cloud-bridge isidore-cloud-tmux`

## Knowledge Sync

Local Isidore and Isidore Cloud share knowledge via a private GitHub repo (`mj-deving/pai-knowledge`). Relationship notes, learnings, and user profile sync automatically at session boundaries.

## Requirements

- Bun runtime
- Claude Code CLI
- Telegram bot token (via @BotFather)

---

**Author:** mj-deving
