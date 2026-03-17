#!/bin/bash
# review-and-fix.sh — 3-gate pre-commit verification
# Gate 1: Type check (blocking)
# Gate 2: Test suite (blocking)
# Gate 3: Codex review (advisory, auto-fix P0-P1)
set -euo pipefail

echo "════ Gate 1: Type Check ════"
npx tsc --noEmit || { echo "BLOCKED: Type errors. Fix before committing."; exit 1; }
echo "  ✓ Type check passed"

echo ""
echo "════ Gate 2: Test Suite ════"
bun test || { echo "BLOCKED: Test failures. Fix before committing."; exit 1; }
echo "  ✓ Tests passed"

echo ""
echo "════ Gate 3: Codex Review ════"
if ! command -v codex &>/dev/null; then
  echo "  ⚠ Codex CLI not found — skipping review gate"
  echo ""
  echo "════ Gates 1-2 passed. Ready to commit. ════"
  exit 0
fi

REVIEW=$(codex review --base HEAD 2>&1) || true
echo "$REVIEW"

# Check for P0/P1 findings
if echo "$REVIEW" | grep -q '\[P[01]\]'; then
  echo ""
  echo "  ⚠ Found P0/P1 findings."

  if [ "${CODEX_AUTOFIX:-0}" = "1" ]; then
    echo "  Auto-fixing..."
    codex exec --full-auto "Fix these review findings: $REVIEW" || true

    # Re-verify after auto-fix
    echo ""
    echo "════ Re-verify after auto-fix ════"
    npx tsc --noEmit || { echo "BLOCKED: Auto-fix introduced type errors!"; exit 1; }
    bun test || { echo "BLOCKED: Auto-fix broke tests!"; exit 1; }
    echo "  ✓ Auto-fix verified"
  else
    echo "  Set CODEX_AUTOFIX=1 to auto-fix, or fix manually."
    echo "  Review findings above before committing."
  fi
elif echo "$REVIEW" | grep -q '\[P[23]\]'; then
  echo ""
  echo "  ℹ P2/P3 findings (non-blocking). Review at your leisure."
else
  echo "  ✓ No significant findings"
fi

echo ""
echo "════ All gates passed. Ready to commit. ════"
