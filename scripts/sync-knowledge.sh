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
  "WORK:${MEMORY_DIR}/WORK:${REPO_DIR}/WORK"
  "SESSIONS:${MEMORY_DIR}/SESSIONS:${REPO_DIR}/SESSIONS"
)

# Project registry for continuity file sync
HANDOFF_DIR="${REPO_DIR}/HANDOFF"
CONTINUITY_DIR="${HANDOFF_DIR}/continuity"
# Read project paths from registry (projects.json)
PROJECTS_JSON="${HANDOFF_DIR}/projects.json"

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

# --- Continuity file sync ---
# On push: copy each project's CLAUDE.local.md → repo HANDOFF/continuity/<project>/
# On pull: copy from repo → <project>/CLAUDE.handoff.md (never overwrite CLAUDE.local.md)
sync_continuity_push() {
  if [[ ! -f "${PROJECTS_JSON}" ]]; then
    log "  SKIP continuity: no projects.json at ${PROJECTS_JSON}"
    return
  fi

  # Parse project paths using jq if available, fallback to grep
  local instance_key="vps"
  local home_dir="${HOME}"
  if [[ "${home_dir}" != *"isidore_cloud"* ]]; then
    instance_key="local"
  fi

  if command -v jq &>/dev/null; then
    local projects
    projects=$(jq -r ".projects[] | select(.active==true) | .name + \":\" + .paths.${instance_key}" "${PROJECTS_JSON}")
  else
    log "  WARN: jq not available, skipping continuity sync"
    return
  fi

  while IFS=':' read -r name path; do
    [[ -z "${name}" || -z "${path}" ]] && continue
    local src="${path}/CLAUDE.local.md"
    local dst="${CONTINUITY_DIR}/${name}/CLAUDE.local.md"
    if [[ -f "${src}" ]]; then
      mkdir -p "$(dirname "${dst}")"
      cp "${src}" "${dst}"
      log "  Continuity push: ${name}/CLAUDE.local.md"
    fi
  done <<< "${projects}"
}

sync_continuity_pull() {
  if [[ ! -f "${PROJECTS_JSON}" ]]; then
    log "  SKIP continuity: no projects.json at ${PROJECTS_JSON}"
    return
  fi

  local instance_key="vps"
  local home_dir="${HOME}"
  if [[ "${home_dir}" != *"isidore_cloud"* ]]; then
    instance_key="local"
  fi

  if command -v jq &>/dev/null; then
    local projects
    projects=$(jq -r ".projects[] | select(.active==true) | .name + \":\" + .paths.${instance_key}" "${PROJECTS_JSON}")
  else
    log "  WARN: jq not available, skipping continuity sync"
    return
  fi

  while IFS=':' read -r name path; do
    [[ -z "${name}" || -z "${path}" ]] && continue
    local src="${CONTINUITY_DIR}/${name}/CLAUDE.local.md"
    # Write to CLAUDE.handoff.md — never overwrite CLAUDE.local.md
    local dst="${path}/CLAUDE.handoff.md"
    if [[ -f "${src}" ]]; then
      mkdir -p "$(dirname "${dst}")"
      cp "${src}" "${dst}"
      log "  Continuity pull: ${name}/CLAUDE.handoff.md"
    fi
  done <<< "${projects}"
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

  # Sync continuity files (CLAUDE.local.md → repo)
  sync_continuity_push

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

  # Sync continuity files (repo → CLAUDE.handoff.md)
  sync_continuity_pull

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
