#!/bin/bash
# cron-knowledge-sync.sh — Periodic bidirectional knowledge sync (VPS cron)
#
# Pulls latest from local Isidore (via GitHub), then pushes VPS state back.
# Designed for cron: sources env, logs output, never fails loudly.
#
# Crontab (Europe/Berlin, every 2h 10am-10pm):
#   0 10,12,14,16,18,20,22 * * * /home/isidore_cloud/projects/my-pai-cloud-solution/scripts/cron-knowledge-sync.sh
#
# Note: VPS may run UTC. Set TZ in crontab or use:
#   TZ=Europe/Berlin
#   0 10,12,14,16,18,20,22 * * * /home/isidore_cloud/projects/my-pai-cloud-solution/scripts/cron-knowledge-sync.sh

set -euo pipefail

# Source environment for PATH (git, bun, ssh keys)
ENV_FILE="/home/isidore_cloud/.config/isidore_cloud/bridge.env"
if [ -f "$ENV_FILE" ]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

# Ensure git and ssh are available
export HOME="${HOME:-/home/isidore_cloud}"
export PATH="${HOME}/.bun/bin:${HOME}/.npm-global/bin:/usr/local/bin:/usr/bin:/bin:${PATH}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SYNC_SCRIPT="${SCRIPT_DIR}/sync-knowledge.sh"
LOG_DIR="${HOME}/.claude/cron-logs"

mkdir -p "$LOG_DIR"
LOG_FILE="${LOG_DIR}/$(date -u '+%Y%m%d-%H%M%S')_knowledge-sync.log"

log() { echo "$(date '+%H:%M:%S') $*" >> "$LOG_FILE"; }

log "=== Knowledge sync started ==="

# Pull first: get latest from local Isidore
log "Running pull..."
if bash "$SYNC_SCRIPT" pull >> "$LOG_FILE" 2>&1; then
  log "Pull completed."
else
  log "Pull failed (continuing to push)."
fi

# Push: share VPS state back
log "Running push..."
if bash "$SYNC_SCRIPT" push >> "$LOG_FILE" 2>&1; then
  log "Push completed."
else
  log "Push failed."
fi

log "=== Knowledge sync finished ==="

# Clean up old logs (keep 7 days)
find "$LOG_DIR" -name '*_knowledge-sync.log' -mtime +7 -delete 2>/dev/null || true
