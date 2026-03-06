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

  # Refuse to pull if there are uncommitted changes — warn instead of risking stash conflicts
  if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
    local changed
    changed=$(git diff --stat 2>/dev/null | tail -1)
    log "SKIP: uncommitted changes in ${dir} (${changed}). Pull skipped to protect local work."
    echo "DIRTY: uncommitted changes — pull skipped. Use /sync to commit first, then /pull."
    return 1
  fi

  run_with_timeout git pull --rebase --quiet || {
    log "WARN: pull failed, continuing with local state"
  }

  log "Pull complete"
}

do_force_pull() {
  local dir="$1"
  [[ -d "${dir}/.git" ]] || { log "ERROR: not a git repo: ${dir}"; exit 1; }

  log "Force pulling in ${dir} — discarding local changes..."
  cd "${dir}"

  # Checkout main, fetch, and hard reset
  git checkout main --quiet 2>/dev/null || true
  run_with_timeout git fetch origin || {
    log "ERROR: fetch failed"
    exit 1
  }
  git reset --hard origin/main
  # Clean up stale cloud/* branches
  git branch | grep 'cloud/' | xargs -r git branch -D 2>/dev/null || true

  log "Force pull complete — now at $(git rev-parse --short HEAD)"
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
  timestamp=$(date '+%Y%m%d-%H%M')
  local project_name
  project_name=$(basename "${dir}")

  # If a pre-push hook blocks main, auto-create a cloud/* branch
  local branch
  branch=$(git branch --show-current 2>/dev/null || echo "main")
  if [[ "${branch}" == "main" ]] && grep -q "Direct push to main is blocked" "${dir}/.git/hooks/pre-push" 2>/dev/null; then
    branch="cloud/${project_name}-${timestamp}"
    git checkout -b "${branch}" --quiet 2>/dev/null || {
      log "WARN: failed to create branch ${branch}"
      return 0
    }
    log "Created branch ${branch}"
  fi

  run_with_timeout git commit -m "cloud: ${project_name} changes (${timestamp})" --quiet || {
    log "WARN: commit failed"
    return 0
  }

  run_with_timeout git push -u origin "${branch}" --quiet || {
    log "WARN: push failed (maybe offline), changes committed locally"
    return 0
  }

  # Return to main after pushing to a cloud/* branch
  if [[ "${branch}" == cloud/* ]]; then
    git checkout main --quiet 2>/dev/null
    echo "BRANCH: ${branch}"
  fi

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
  force-pull)
    [[ -n "${2:-}" ]] || { echo "Usage: $0 force-pull <dir>" >&2; exit 1; }
    do_force_pull "$2"
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
