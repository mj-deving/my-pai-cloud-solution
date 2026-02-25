# PAI Cloud Solution

Deploy Isidore (PAI assistant) to a VPS for 24/7 mobile access via Telegram, email, and SSH.

## Architecture

All channels share one conversation via a session ID file:

- **SSH** — Interactive `claude` in tmux (deep work)
- **Telegram** — `claude --resume` programmatic bridge (mobile)
- **Email** — `claude --resume` programmatic bridge (async)
- **Cron** — One-shot `claude -p` (scheduled automation)

## Project Structure

```
src/
  bridge.ts          # Main entry: Telegram + email polling
  telegram.ts        # Telegram bot (Grammy)
  claude.ts          # Claude CLI --resume wrapper
  session.ts         # Shared session ID management
  format.ts          # Compact mobile-friendly formatter
  config.ts          # Environment configuration
  isidore-session.ts # CLI session management tool
scripts/
  setup-vps.sh       # Phase 1: VPS user, deps, coexistence check
  deploy-key.sh      # Deploy SSH key to isidore user
  deploy.sh          # Full deployment (code, PAI, services)
  auth-health-check.sh  # Cron: OAuth token monitoring
  run-task.sh        # Cron: one-shot task runner
systemd/
  isidore-bridge.service  # Telegram + email bridge service
  isidore-tmux.service    # Persistent tmux session
```

## Setup

1. Run `setup-vps.sh` via SSH to create user, install deps
2. Run `deploy-key.sh` locally to set up SSH key
3. Authenticate Claude: `ssh -L 7160:localhost:7160 isidore` then `claude /login`
4. Run `deploy.sh` to sync code, PAI, and services
5. Configure `bridge.env` with Telegram bot token
6. Enable services: `sudo systemctl enable --now isidore-bridge isidore-tmux`

## Requirements

- Bun runtime
- Claude Code CLI (Max 5x subscription)
- Telegram bot token (via @BotFather)

---

**Author:** Marius Jonathan Jauernik
