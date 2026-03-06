#!/bin/bash
# self-deploy.sh — Pull latest code and restart bridge
# Called by /deploy Telegram command. Runs ON the VPS.
#
# Simple approach: fetch + reset --hard origin/main.
# VPS has no meaningful local commits on main — everything comes from GitHub.

set -euo pipefail

REPO_DIR="/home/isidore_cloud/projects/my-pai-cloud-solution"
cd "$REPO_DIR"

git fetch origin
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

if [ "$LOCAL" = "$REMOTE" ]; then
    echo "ALREADY_CURRENT"
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
