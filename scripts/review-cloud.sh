#!/bin/bash
# review-cloud.sh — Review a Cloud Isidore branch using Codex CLI
# Usage: bash scripts/review-cloud.sh [branch-name]
#
# If no branch given, lists all cloud/* branches.
# Fetches latest, checks out branch, runs `codex review --base main`.

set -euo pipefail

CODEX="/home/mj/.npm-global/bin/codex"
REPO_DIR="/home/mj/projects/my-pai-cloud-solution"

cd "$REPO_DIR"

# If no argument, list cloud branches
if [ $# -eq 0 ]; then
    git fetch origin --prune 2>/dev/null
    echo "Available cloud/* branches:"
    git branch -r --list 'origin/cloud/*' | sed 's|origin/||' || echo "  (none)"
    echo ""
    echo "Usage: bash scripts/review-cloud.sh cloud/<branch-name>"
    exit 0
fi

BRANCH="$1"
REMOTE_BRANCH="origin/$BRANCH"

echo "=== Reviewing $BRANCH ==="

# Fetch latest
echo "Fetching..."
git fetch origin 2>/dev/null

# Verify branch exists
if ! git rev-parse "$REMOTE_BRANCH" >/dev/null 2>&1; then
    echo "ERROR: Branch $REMOTE_BRANCH not found."
    echo ""
    echo "Available cloud/* branches:"
    git branch -r --list 'origin/cloud/*' | sed 's|origin/||' || echo "  (none)"
    exit 1
fi

# Show commit log
echo ""
echo "=== Commits on $BRANCH (not on main) ==="
git log --oneline main.."$REMOTE_BRANCH"

# Stats summary
echo ""
echo "=== Diff stats ==="
git diff --stat main..."$REMOTE_BRANCH"

# Checkout the branch locally for Codex to analyze
ORIGINAL_BRANCH=$(git branch --show-current)
echo ""
echo "Checking out $BRANCH for review..."
git checkout "$BRANCH" 2>/dev/null || git checkout -b "$BRANCH" "$REMOTE_BRANCH" 2>/dev/null

echo ""
echo "=== Running Codex review ==="

# Note: codex review --base and [PROMPT] are mutually exclusive (codex v0.110+).
# Built-in review logic is sufficient — it flags bugs, security, and quality issues.
"$CODEX" review --base main

echo ""
echo "=== Review complete ==="

# Return to original branch
git checkout "$ORIGINAL_BRANCH" 2>/dev/null

echo ""
echo "To merge:  git merge $REMOTE_BRANCH && git push"
echo "To reject: tell Cloud what to fix"
