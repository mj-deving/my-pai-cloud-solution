#!/usr/bin/env bash
# project-sync.sh — Git sync operations for project handoff
# Used by ProjectManager to sync project repos on switch/done
#
# Usage:
#   project-sync.sh pull <dir>    # git pull --rebase in project dir
#   project-sync.sh push <dir>    # git add -u, commit, push
#   project-sync.sh clone <url> <dir>  # shallow clone + bun install

set -euo pipefail

TIMEOUT_SECS=60

log() { echo "[project-sync] $(date '+%H:%M:%S') $*"; }

# Run a command with timeout
run_with_timeout() {
  timeout "${TIMEOUT_SECS}" "$@" 2>&1 || {
    local exit_code=$?
    if [[ $exit_code -eq 124 ]]; then
      log "WARN: command timed out after ${TIMEOUT_SECS}s"
    fi
    return $exit_code
  }
}

do_pull() {
  local dir="$1"
  [[ -d "${dir}/.git" ]] || { log "ERROR: not a git repo: ${dir}"; exit 1; }

  log "Pulling latest in ${dir}..."
  cd "${dir}"

  # Stash any uncommitted changes to avoid rebase conflicts
  local stashed=false
  if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
    git stash --quiet 2>/dev/null && stashed=true
    log "Stashed local changes"
  fi

  run_with_timeout git pull --rebase --quiet || {
    log "WARN: pull failed, continuing with local state"
  }

  # Restore stashed changes
  if $stashed; then
    git stash pop --quiet 2>/dev/null || {
      log "WARN: stash pop had conflicts, changes in stash"
    }
  fi

  log "Pull complete"
}

do_push() {
  local dir="$1"
  [[ -d "${dir}/.git" ]] || { log "ERROR: not a git repo: ${dir}"; exit 1; }

  log "Pushing changes from ${dir}..."
  cd "${dir}"

  # Only add tracked files — never git add -A
  git add -u

  if git diff --cached --quiet; then
    log "No changes to commit"
    return 0
  fi

  local timestamp
  timestamp=$(date '+%Y-%m-%d %H:%M')
  local instance
  instance=$(hostname -s 2>/dev/null || echo "unknown")

  run_with_timeout git commit -m "cloud: auto-save (${instance} ${timestamp})" --quiet || {
    log "WARN: commit failed"
    return 0
  }

  run_with_timeout git push -u origin main --quiet || {
    log "WARN: push failed (maybe offline), changes committed locally"
    return 0
  }

  log "Push complete"
}

do_clone() {
  local url="$1"
  local dir="$2"

  if [[ -d "${dir}" ]]; then
    log "Directory already exists: ${dir}"
    return 0
  fi

  log "Cloning ${url} → ${dir}..."
  mkdir -p "$(dirname "${dir}")"
  run_with_timeout git clone --depth 1 "${url}" "${dir}" || {
    log "ERROR: clone failed"
    exit 1
  }

  # Install dependencies if package.json exists
  if [[ -f "${dir}/package.json" ]]; then
    log "Installing dependencies..."
    cd "${dir}"
    if command -v bun &>/dev/null; then
      run_with_timeout bun install || log "WARN: bun install failed"
    elif command -v npm &>/dev/null; then
      run_with_timeout npm install || log "WARN: npm install failed"
    fi
  fi

  log "Clone complete"
}

# --- Main ---
case "${1:-}" in
  pull)
    [[ -n "${2:-}" ]] || { echo "Usage: $0 pull <dir>" >&2; exit 1; }
    do_pull "$2"
    ;;
  push)
    [[ -n "${2:-}" ]] || { echo "Usage: $0 push <dir>" >&2; exit 1; }
    do_push "$2"
    ;;
  clone)
    [[ -n "${2:-}" && -n "${3:-}" ]] || { echo "Usage: $0 clone <url> <dir>" >&2; exit 1; }
    do_clone "$2" "$3"
    ;;
  *)
    echo "Usage: $0 {pull|push|clone} [args...]" >&2
    exit 1
    ;;
esac
