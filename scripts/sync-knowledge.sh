#!/usr/bin/env bash
# sync-knowledge.sh — Bidirectional knowledge sync between Isidore instances
# Used by PAI hooks (SessionEnd: push, SessionStart: pull)
# Syncs: USER/, RELATIONSHIP/, LEARNING/ via private GitHub repo
#
# Usage:
#   sync-knowledge.sh push   # Copy local MEMORY → repo → git push
#   sync-knowledge.sh pull   # git pull → copy repo → local MEMORY

set -euo pipefail

# --- Configuration ---
CLAUDE_DIR="${CLAUDE_DIR:-${HOME}/.claude}"
REPO_DIR="${HOME}/pai-knowledge"
MEMORY_DIR="${CLAUDE_DIR}/MEMORY"
USER_DIR="${CLAUDE_DIR}/skills/PAI/USER"

# What to sync (source dirs relative to CLAUDE_DIR structure)
SYNC_DIRS=(
  "USER:${USER_DIR}:${REPO_DIR}/USER"
  "RELATIONSHIP:${MEMORY_DIR}/RELATIONSHIP:${REPO_DIR}/RELATIONSHIP"
  "LEARNING:${MEMORY_DIR}/LEARNING:${REPO_DIR}/LEARNING"
)

# --- Helpers ---
log() { echo "[sync-knowledge] $(date '+%H:%M:%S') $*"; }
die() { log "ERROR: $*" >&2; exit 1; }

check_repo() {
  [[ -d "${REPO_DIR}/.git" ]] || die "Repo not found at ${REPO_DIR}. Run: git clone git@github.com:mj-deving/pai-knowledge.git ${REPO_DIR}"
}

update_meta() {
  local action="$1"
  local instance
  instance=$(hostname -s 2>/dev/null || echo "unknown")
  local timestamp
  timestamp=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
  local meta_file="${REPO_DIR}/.sync-meta.json"

  # Simple JSON update — overwrite the relevant field
  if [[ -f "${meta_file}" ]]; then
    local tmp
    tmp=$(mktemp)
    # Use basic sed since jq may not be available everywhere
    if command -v jq &>/dev/null; then
      jq --arg inst "${instance}" --arg ts "${timestamp}" --arg act "${action}" \
        ".lastSync[\$inst] = {\"timestamp\": \$ts, \"action\": \$act}" \
        "${meta_file}" > "${tmp}" && mv "${tmp}" "${meta_file}"
    else
      # Fallback: just write a simple meta
      cat > "${meta_file}" <<EOF
{
  "lastSync": {
    "${instance}": {
      "timestamp": "${timestamp}",
      "action": "${action}"
    }
  }
}
EOF
    fi
  fi
}

# --- Push: local MEMORY → repo → GitHub ---
do_push() {
  log "PUSH: syncing local knowledge to repo..."
  check_repo

  # Pull first to get other instance's changes
  log "Pulling latest from remote..."
  cd "${REPO_DIR}"
  git pull --rebase --quiet 2>/dev/null || {
    log "WARN: pull failed (maybe offline), continuing with local state"
  }

  # Copy each sync dir to repo
  for entry in "${SYNC_DIRS[@]}"; do
    IFS=':' read -r name src dst <<< "${entry}"
    if [[ -d "${src}" ]]; then
      log "  Copying ${name}: ${src} → ${dst}"
      rsync -a --delete --exclude='.gitkeep' "${src}/" "${dst}/"
    else
      log "  SKIP ${name}: source ${src} not found"
    fi
  done

  # Update sync metadata
  update_meta "push"

  # Commit and push if there are changes
  cd "${REPO_DIR}"
  git add -A

  if git diff --cached --quiet; then
    log "No changes to push."
  else
    local instance
    instance=$(hostname -s 2>/dev/null || echo "unknown")
    local timestamp
    timestamp=$(date '+%Y-%m-%d %H:%M')
    git commit -m "sync: ${instance} ${timestamp}" --quiet
    git push --quiet 2>/dev/null || {
      log "WARN: push failed (maybe offline), changes committed locally"
    }
    log "Push complete."
  fi
}

# --- Pull: GitHub → repo → local MEMORY ---
do_pull() {
  log "PULL: syncing repo knowledge to local..."
  check_repo

  # Pull latest
  cd "${REPO_DIR}"
  git pull --quiet 2>/dev/null || {
    log "WARN: pull failed (maybe offline), using cached repo state"
  }

  # Copy each sync dir from repo to local
  for entry in "${SYNC_DIRS[@]}"; do
    IFS=':' read -r name src dst <<< "${entry}"
    if [[ -d "${dst}" ]]; then
      log "  Copying ${name}: ${dst} → ${src}"
      # Ensure target dir exists
      mkdir -p "${src}"
      rsync -a --exclude='.gitkeep' "${dst}/" "${src}/"
    else
      log "  SKIP ${name}: repo dir ${dst} not found"
    fi
  done

  # Update sync metadata
  update_meta "pull"

  log "Pull complete."
}

# --- Main ---
case "${1:-}" in
  push)  do_push ;;
  pull)  do_pull ;;
  *)     echo "Usage: $0 {push|pull}" >&2; exit 1 ;;
esac
