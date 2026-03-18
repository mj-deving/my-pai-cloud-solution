#!/usr/bin/env bash
# PAI Cloud Bridge — Backup Script
# Backs up memory.db and bridge.env with 7-day rotation.
#
# Cron: 0 3 * * * /home/isidore_cloud/projects/my-pai-cloud-solution/scripts/backup.sh
#
# Usage: bash scripts/backup.sh
# After deploy: chmod +x scripts/backup.sh

set -euo pipefail

# Restrictive permissions for all created files (memory.db contains conversation history)
umask 0077

BACKUP_DIR="$HOME/backups"
TIMESTAMP=$(date +%Y%m%d-%H%M)
MEMORY_DB="$HOME/projects/my-pai-cloud-solution/data/memory.db"
BRIDGE_ENV="$HOME/.config/isidore_cloud/bridge.env"
KEEP=7

# --- Create backup directory ---
mkdir -p "$BACKUP_DIR"
chmod 0700 "$BACKUP_DIR"

# --- Backup memory.db ---
if [ -f "$MEMORY_DB" ]; then
  # WAL checkpoint: flush write-ahead log into main DB for consistent copy
  bun -e "import{Database}from'bun:sqlite';new Database('$MEMORY_DB').exec('PRAGMA wal_checkpoint(TRUNCATE)');" 2>/dev/null || true

  cp "$MEMORY_DB" "$BACKUP_DIR/memory-${TIMESTAMP}.db"
  echo "[backup] memory.db → memory-${TIMESTAMP}.db"
else
  echo "[backup] SKIP memory.db — file not found: $MEMORY_DB"
fi

# --- Backup bridge.env ---
if [ -f "$BRIDGE_ENV" ]; then
  cp "$BRIDGE_ENV" "$BACKUP_DIR/bridge-env-${TIMESTAMP}"
  chmod 0600 "$BACKUP_DIR/bridge-env-${TIMESTAMP}"
  echo "[backup] bridge.env → bridge-env-${TIMESTAMP} (mode 0600)"
else
  echo "[backup] SKIP bridge.env — file not found: $BRIDGE_ENV"
fi

# --- Rotate: keep last N backups of each type ---
rotate() {
  local pattern="$1"
  local count
  count=$(ls -1t "$BACKUP_DIR"/$pattern 2>/dev/null | wc -l)
  if [ "$count" -gt "$KEEP" ]; then
    ls -1t "$BACKUP_DIR"/$pattern | tail -n +"$((KEEP + 1))" | while read -r old; do
      rm -f "$old"
      echo "[backup] rotated out: $(basename "$old")"
    done
  fi
}

rotate "memory-*.db"
rotate "bridge-env-*"

echo "[backup] done — $(ls -1 "$BACKUP_DIR" 2>/dev/null | wc -l) files in $BACKUP_DIR"
exit 0
