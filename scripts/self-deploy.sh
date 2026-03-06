#!/bin/bash
# self-deploy.sh — Pull latest code and restart bridge
# Called by /deploy Telegram command. Runs ON the VPS.
#
# Usage:
#   self-deploy.sh          — deploy (fetch + reset --hard origin/main)
#   self-deploy.sh --check  — check for updates and dirty state, don't deploy

set -euo pipefail

REPO_DIR="/home/isidore_cloud/projects/my-pai-cloud-solution"
cd "$REPO_DIR"

CHECK_ONLY="${1:-}"

git fetch origin
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

if [ "$LOCAL" = "$REMOTE" ]; then
    echo "ALREADY_CURRENT"
    exit 0
fi

# Report dirty tracked files
DIRTY=$(git status --porcelain -- . ':!MEMORY/' ':!data/' 2>/dev/null | head -20)
if [ -n "$DIRTY" ]; then
    echo "DIRTY_FILES"
    echo "$DIRTY"
    echo "END_DIRTY"
fi

if [ "$CHECK_ONLY" = "--check" ]; then
    CHANGES=$(git log --oneline "$LOCAL".."$REMOTE")
    echo "PENDING"
    echo "$CHANGES"
    exit 0
fi

git reset --hard origin/main

# Install deps if lockfile changed
if ! git diff --quiet "$LOCAL" "$REMOTE" -- bun.lock 2>/dev/null; then
    bun install --frozen-lockfile 2>/dev/null || bun install
    echo "DEPS_UPDATED"
fi

CHANGES=$(git log --oneline "$LOCAL".."$REMOTE")
echo "UPDATED"
echo "$CHANGES"
