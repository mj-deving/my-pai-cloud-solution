#!/bin/bash
# codex-review-hook.sh — Run Codex review on recent commits
# Used by git hooks and /sync command. Outputs review text to stdout.
# Usage: bash scripts/codex-review-hook.sh [--commit HEAD | --base <ref>]
#
# Requires: codex CLI installed (~/.npm-global/bin/codex)

set -euo pipefail

CODEX_BIN="${HOME}/.npm-global/bin/codex"

if [ ! -x "$CODEX_BIN" ]; then
    echo "CODEX_NOT_FOUND"
    exit 0  # Non-fatal — review is advisory
fi

MODE="${1:---commit}"
REF="${2:-HEAD}"

case "$MODE" in
    --commit)
        "$CODEX_BIN" review --commit "$REF" 2>/dev/null || echo "CODEX_REVIEW_FAILED"
        ;;
    --base)
        "$CODEX_BIN" review --base "$REF" 2>/dev/null || echo "CODEX_REVIEW_FAILED"
        ;;
    --uncommitted)
        "$CODEX_BIN" review --uncommitted 2>/dev/null || echo "CODEX_REVIEW_FAILED"
        ;;
    *)
        echo "Usage: codex-review-hook.sh [--commit HEAD | --base <ref> | --uncommitted]"
        exit 1
        ;;
esac
