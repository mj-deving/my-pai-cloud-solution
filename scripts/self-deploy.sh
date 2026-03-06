#!/bin/bash
# self-deploy.sh — Pull latest code and restart bridge
# Called by /deploy Telegram command. Runs ON the VPS.

set -euo pipefail

REPO_DIR="/home/isidore_cloud/projects/my-pai-cloud-solution"
cd "$REPO_DIR"

# Step 0: Ensure we're on main — refuse to deploy if on a branch with uncommitted work
CURRENT_BRANCH=$(git branch --show-current)
if [ "$CURRENT_BRANCH" != "main" ]; then
    echo "WRONG_BRANCH $CURRENT_BRANCH"
    exit 1
fi

# Step 1: Pull latest
git fetch origin
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

if [ "$LOCAL" = "$REMOTE" ]; then
    echo "ALREADY_CURRENT"
    exit 0
fi

# Stash any dirty tracked files (deploy.sh rsync can leave dirty state)
STASHED=""
if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
    git stash --quiet
    STASHED="1"
fi

git pull --rebase --quiet

# Pop stash if we stashed (best-effort — conflicts mean stash stays saved)
if [ -n "$STASHED" ]; then
    git stash pop --quiet 2>/dev/null || true
fi

# Step 2: Install deps if lockfile changed (with rollback on failure)
DEPS_UPDATED=""
if ! git diff --quiet "$LOCAL" "$REMOTE" -- bun.lock 2>/dev/null; then
    if ! (bun install --frozen-lockfile 2>/dev/null || bun install); then
        echo "BUILD_FAILED"
        git reset --hard "$LOCAL"
        exit 1
    fi
    DEPS_UPDATED="1"
fi

# Step 3: Syntax check — abort if new code won't parse
if ! bun build src/bridge.ts --no-bundle --outdir /tmp/isidore-build-check > /dev/null 2>&1; then
    echo "BUILD_FAILED"
    git reset --hard "$LOCAL"  # rollback
    exit 1
fi

# Step 4: Show what changed — UPDATED must be the first line
CHANGES=$(git log --oneline "$LOCAL".."$REMOTE")
echo "UPDATED"
if [ -n "$DEPS_UPDATED" ]; then
    echo "DEPS_UPDATED"
fi
echo "$CHANGES"
