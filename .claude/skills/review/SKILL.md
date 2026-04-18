---
name: review
description: "Summarize a cloud/* branch for GitHub-native review (Copilot / Codex bot / reviewers). Lists branches, diff stats, and posts a pre-verification comment on the PR. Does NOT run local Codex CLI. USE WHEN user says /review, review this branch, code review, check branch."
user_invocable: true
trigger: /review
---

# /review — GitHub-native review summary for a cloud/* branch

Fetches a `cloud/*` branch, captures diff + commit summary, and posts a pre-verification comment on the PR so GitHub-side reviewers (Copilot, Codex bot, human) have context. **This skill no longer runs `codex review` locally** — see `docs/decisions/0002-github-native-review-only.md`.

## Usage modes

- `/review` (no args) → list available `cloud/*` branches and stop
- `/review cloud/my-branch` → summarize that branch + post PR comment

## Preconditions

- `gh` CLI authenticated (`gh auth status`)
- `bun` available for optional local test verification
- Project dir passed via cwd — must be a git repo with an `origin` remote

## Workflow

### 0. List branches (if no argument)

```bash
git -C <project-dir> fetch origin --prune
git -C <project-dir> branch -r --list 'origin/cloud/*'
```

Format each as `• cloud/<name>` and suggest `/review cloud/<name>` usage. Stop.

### 1. Validate branch name

Must start with `cloud/`. Refuse anything else.

### 2. Fetch + verify branch exists

```bash
git -C <project-dir> fetch origin
git -C <project-dir> rev-parse origin/<branch>
```

If `rev-parse` fails → report and stop.

### 3. Capture diff + commit summary

```bash
git -C <project-dir> diff --stat main...origin/<branch>
git -C <project-dir> log --oneline main..origin/<branch>
```

### 4. (Optional) Local test check

If the branch is checked out or cleanly checkout-able, run:

```bash
bun test 2>&1 | tail -5
bun x tsc --noEmit 2>&1 | tail -3
```

Report pass/fail count. Skip silently if checkout is not clean — don't disturb user state.

### 5. Resolve PR + post comment

```bash
PR=$(gh pr list --head <branch> --state open --json number --jq '.[0].number // empty')
[ -z "$PR" ] && { echo "No open PR for <branch> — skipping comment"; exit 0; }

BODY=$(cat <<EOF
**Branch summary for review**

<commit log + diff stat + optional test/tsc status>

Review is handled on GitHub — waiting on Copilot / Codex bot / reviewer feedback.
EOF
)

gh pr comment "$PR" --body "$BODY"
```

Post a fresh comment each time (no `--edit-last`). Reviewers can see history.

### 6. Report to user

- PR URL (if found)
- Commit log
- Diff stat
- Test/tsc status (if collected)
- Link to the "Files changed" and "Checks" tabs

## Verification

- `gh pr view <branch>` shows the new summary comment
- No local branch switching side-effects remain

## Edge cases

- **No PR exists:** still return the diff/commit summary locally; skip the comment.
- **Dirty working tree:** skip the optional test step; do not try to check out.

## What this skill no longer does

As of 2026-04-18, `/review` no longer:
- Runs `codex review --base main`
- Parses `[P0]–[P3]` markers
- Runs `codex exec --full-auto` for autofix
- Upserts a `**Codex Review:**` comment via `--edit-last`

Rationale: GitHub-native review (Copilot on PRs + optional Codex GitHub App) covers the same ground without the CLI's timeouts and auth gymnastics. See ADR 0002.

## Related skills

- `/sync` — commit + push + PR (primary entry point)
- `/merge` — merge PR after review passes on GitHub
