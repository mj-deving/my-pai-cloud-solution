# CLAUDE.md — my-pai-cloud-solution

## What This Is

PAI cloud infrastructure solution

**Owner:** Marius
**GitHub:** [mj-deving/my-pai-cloud-solution](https://github.com/mj-deving/my-pai-cloud-solution)
**Created:** 2026-02-25

## Tech Stack

- **Runtime:** Bun + TypeScript
- **Bot Framework:** Grammy (Telegram)
- **Deployment:** VPS (Ubuntu 24.04, shared with Gregor/OpenClaw)

## Conventions

- Commit messages: clear "why", prefixed by area when helpful
- Every session should end with a commit capturing the work done
- Code comments: thorough — document interfaces and logic
- File naming: kebab-case

## Session Workflow

1. Read this file on session start for project context
2. Do the work
3. Commit with a descriptive message at session end
4. Push to GitHub

## Project Structure

<!-- Update this as the project evolves -->

```
.
├── CLAUDE.md              # Project context
├── README.md              # Public docs
├── Plans/                 # PRD and architecture
├── src/
│   ├── bridge.ts          # Main: Telegram + email polling
│   ├── telegram.ts        # Telegram bot (Grammy)
│   ├── claude.ts          # Claude CLI --resume wrapper
│   ├── session.ts         # Shared session ID management
│   ├── format.ts          # Compact mobile formatter
│   ├── config.ts          # Environment config
│   └── isidore-session.ts # CLI session helper
├── scripts/
│   ├── setup-vps.sh       # Phase 1 VPS setup
│   ├── deploy-key.sh      # SSH key deployment
│   ├── deploy.sh          # Full deployment
│   ├── auth-health-check.sh  # Cron: OAuth monitoring
│   └── run-task.sh        # Cron: task runner
├── systemd/
│   ├── isidore-bridge.service  # Bridge service
│   └── isidore-tmux.service    # Persistent tmux
└── bridge.env.example     # Environment template
```

## Current State

<!-- Update this section at the end of each session -->

**Status:** Phase 1-2 deployed on VPS, awaiting OAuth auth
**Last session:** 2026-02-25
**Completed:** VPS user, SSH key, Claude CLI, Bun, PAI skills, tmux, cron, bridge code
**Blocked on:** OAuth authentication (requires local browser via SSH tunnel)
**Next steps:** Authenticate Claude, create Telegram bot, configure bridge.env, start bridge service
