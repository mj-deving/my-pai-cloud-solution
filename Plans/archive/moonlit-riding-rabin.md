# Self-Deploy: `/deploy` Command for Cloud Isidore

## Context

Cloud Isidore can't update itself — deploys require Marius to run `deploy.sh` from local or SSH in manually. OpenClaw solves this with a self-update script + systemd restart. We want the same: a `/deploy` Telegram command that pulls the latest code and restarts the bridge.

The bridge already has `Restart=always` in systemd (5s delay, max 5 per 60s). The shutdown handler saves a session summary before exiting. So the pattern is: pull code, verify it compiles, reply "deploying", then `systemctl restart` which kills the process — systemd brings it back on the new code.

## Changes

### 1. New script: `scripts/self-deploy.sh` (~35 lines)

```
#!/bin/bash
# self-deploy.sh — Pull latest code and restart bridge
# Called by /deploy Telegram command. Runs ON the VPS.

set -euo pipefail

REPO_DIR="/home/isidore_cloud/projects/my-pai-cloud-solution"
cd "$REPO_DIR"

# Step 1: Pull latest
git fetch origin
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

if [ "$LOCAL" = "$REMOTE" ]; then
    echo "ALREADY_CURRENT"
    exit 0
fi

git pull --rebase --quiet

# Step 2: Install deps if lockfile changed
if ! git diff --quiet "$LOCAL" "$REMOTE" -- bun.lock 2>/dev/null; then
    bun install --frozen-lockfile 2>/dev/null || bun install
    echo "DEPS_UPDATED"
fi

# Step 3: Syntax check — abort if new code won't parse
if ! bun build src/bridge.ts --no-bundle --outdir /tmp/isidore-build-check > /dev/null 2>&1; then
    echo "BUILD_FAILED"
    git reset --hard "$LOCAL"  # rollback
    exit 1
fi

# Step 4: Show what changed
CHANGES=$(git log --oneline "$LOCAL".."$REMOTE")
echo "UPDATED"
echo "$CHANGES"
```

**The script does NOT restart** — it only pulls, validates, and reports. The Telegram handler does the restart separately so it can reply first.

### 2. Telegram command: `/deploy` in `src/telegram.ts` (~40 lines)

Follows existing patterns (typing loop, Bun.spawn, markdown reply):

```
/deploy flow:
1. Start typing loop
2. Run self-deploy.sh via Bun.spawn (60s timeout)
3. Parse output: ALREADY_CURRENT | BUILD_FAILED | UPDATED
4. Reply with result + commit list
5. If UPDATED: reply "Restarting in 3s...", then spawn `sudo systemctl restart isidore-cloud-bridge`
6. Bridge dies (SIGTERM), systemd restarts on new code
```

Register after `/merge` command, before the catch-all message handler (following Grammy handler order rule).

### 3. Sudoers entry (one-time VPS setup)

The bridge runs as `isidore_cloud` user but `systemctl restart` needs sudo. Add a passwordless sudoers rule:

```
# /etc/sudoers.d/isidore-cloud-deploy
isidore_cloud ALL=(ALL) NOPASSWD: /bin/systemctl restart isidore-cloud-bridge
```

This is scoped to exactly one command — no broad sudo access.

### 4. No feature flag needed

This is a simple command, always available. No env var gating. Auth is already handled by the single-user middleware (telegram.ts:154-165).

## Files to modify

| File | Action | Lines |
|------|--------|-------|
| `scripts/self-deploy.sh` | **New** | ~35 lines |
| `src/telegram.ts` | **Edit** — add `/deploy` command | ~40 lines, after `/merge` handler |
| `scripts/deploy.sh` | **Edit** — add sudoers setup step | ~5 lines |

## What we DON'T do

- **No health check cron** — systemd `Restart=always` + `StartLimitBurst=5` handles crash loops. The build check before restart prevents most bad deploys. Add health check later if needed.
- **No rollback command** — `git reset --hard` in the script handles build failures. For runtime failures, SSH in. Keep it simple.
- **No auto-deploy on push** — `/deploy` is manual and intentional. Marius triggers it.

## Verification

1. Deploy current code to VPS first (so self-deploy.sh exists there)
2. Push a small change to main from local
3. Send `/deploy` on Telegram
4. Expect: "Pulling... Updated. Restarting in 3s..." then bridge goes offline briefly, comes back
5. Send any message — verify bridge responds on new code
6. Test `/deploy` when already current — expect "Already up to date"
7. Test build failure: push broken syntax, `/deploy` — expect rollback message, bridge stays on old code
