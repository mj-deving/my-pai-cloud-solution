# CLAUDE.md — my-pai-cloud-solution

## What This Is

PAI cloud infrastructure solution — deploys Isidore Cloud to a VPS for 24/7 access.

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

## Cross-Instance Continuity

If `CLAUDE.handoff.md` exists in this directory, read it on session start.
It contains the other instance's (local/Cloud) last session state.

## Session Workflow

1. Read this file on session start for project context
2. If `CLAUDE.handoff.md` exists, read it for cross-instance context
3. Do the work
4. Commit with a descriptive message at session end
5. Push to GitHub

## Project Structure

<!-- Update this as the project evolves -->

```
.
├── CLAUDE.md              # Project context
├── README.md              # Public docs
├── Plans/                 # PRD and architecture
├── config/
│   └── projects.json      # Project registry (handoff)
├── src/
│   ├── bridge.ts          # Main: Telegram + email polling
│   ├── telegram.ts        # Telegram bot (Grammy)
│   ├── claude.ts          # Claude CLI --resume wrapper
│   ├── session.ts         # Shared session ID management
│   ├── projects.ts        # Project registry + handoff state
│   ├── wrapup.ts          # Lightweight auto-commit after responses
│   ├── format.ts          # Compact mobile formatter
│   ├── config.ts          # Environment config
│   └── isidore-cloud-session.ts # CLI session helper
├── scripts/
│   ├── setup-vps.sh       # Phase 1 VPS setup
│   ├── deploy-key.sh      # SSH key deployment
│   ├── deploy.sh          # Full deployment
│   ├── auth-health-check.sh  # Cron: OAuth monitoring
│   ├── run-task.sh        # Cron: task runner
│   ├── sync-knowledge.sh  # Bidirectional knowledge sync
│   └── project-sync.sh    # Git sync for project handoff
├── systemd/
│   ├── isidore-cloud-bridge.service  # Bridge service
│   └── isidore-cloud-tmux.service    # Persistent tmux
└── bridge.env.example     # Environment template
```

## VPS Details

- **IP:** 213.199.32.18
- **SSH alias:** `isidore_cloud` (isidore_cloud user), `vps` (openclaw user)
- **SSH key:** `~/.ssh/id_ed25519_isidore_cloud`
- **Linux user:** `isidore_cloud`
- **Home dir:** `/home/isidore_cloud/`
- **Project dir:** `/home/isidore_cloud/projects/my-pai-cloud-solution/`
- **Config:** `/home/isidore_cloud/.config/isidore_cloud/bridge.env`
- **Claude binary:** `/home/isidore_cloud/.npm-global/bin/claude`

## Current State

<!-- Update this section at the end of each session -->

**Status:** Handoff protocol deployed and tested end-to-end on VPS. Null path support for Cloud-only projects added.
**Last session:** 2026-02-26
**Completed:** VPS user, SSH, Claude CLI, Bun, PAI skills, tmux, cron, bridge, knowledge sync, GitHub PAT, ARCHITECTURE.md, handoff protocol, VPS deploy + testing
**Next steps:** Commit fixes, redeploy, VPS CLAUDE.local.md, email bridge (C6)
