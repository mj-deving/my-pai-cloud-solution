---
name: review
description: "Run Codex review on a cloud/* branch (or list available branches), parse P0-P3 findings, post to PR. USE WHEN user says /review, review this branch, run codex on branch, code review, check branch."
user_invocable: true
trigger: /review
---

# /review — Codex Review on cloud/* Branch

Fetches a `cloud/*` branch, runs `codex review --base main`, parses priority findings, posts comment to the PR. Equivalent to bridge `/review`.

## Usage modes

- `/review` (no args) → list available `cloud/*` branches and stop
- `/review cloud/my-branch` → review that branch

## Preconditions

- `codex` CLI authenticated (`codex auth status`)
- `gh` CLI authenticated
- Project dir passed via cwd — must be a git repo with an `origin` remote

## Workflow

### 0. List branches (if no argument)

```bash
git -C <project-dir> fetch origin --prune
git -C <project-dir> branch -r --list 'origin/cloud/*'
```

Format each as `• cloud/<name>` and suggest `/review cloud/<name>` usage. Stop.

### 1. Validate branch name

Must start with `cloud/`. Refuse anything else — main is off-limits, feature branches without the prefix don't get reviewed.

### 2. Fetch + verify the branch exists

```bash
git -C <project-dir> fetch origin
git -C <project-dir> rev-parse origin/<branch>
```

If `rev-parse` fails → branch doesn't exist on origin; report and stop.

### 3. Capture diff summary (for the user)

```bash
git -C <project-dir> diff --stat main...origin/<branch>
git -C <project-dir> log --oneline main..origin/<branch>
```

Hold both for the final report.

### 4. Checkout branch for review

```bash
git -C <project-dir> checkout <branch> || \
  git -C <project-dir> checkout -b <branch> origin/<branch>
```

If dirty working tree blocks checkout, report and stop (`git status --porcelain` is non-empty).

### 5. Run Codex review

```bash
codex review --base main
```

Timeout: 120s. Capture full stdout as `reviewBody`. `codex` is expected on `PATH`; on VPS this resolves to `~/.npm-global/bin/codex`.

**Parse P0-P3:** `grep -E '\[P[0-3]\]' | wc -l` gives the findings count. Any match = issues.

### 6. Autofix (if CODEX_AUTOFIX=1 and findings present)

```bash
[ "$CODEX_AUTOFIX" = "1" ] && [ "$hasIssues" = "true" ] || skip

codex exec --full-auto "Apply Codex review findings surgically — only fix what's flagged:\n\n<reviewBody>"

# If changes: commit and push (single -m is fine here — no body)
git add -A
git commit -m "fix: apply Codex review findings"
git push origin <branch>
```

### 7. Return to main

```bash
git -C <project-dir> checkout main
```

Always do this — even on error — to avoid leaving the repo in a random branch.

### 8. Post review to PR (upsert comment)

Idempotent upsert via `gh pr comment --edit-last` (same pattern as `/sync`):

```bash
# Resolve PR number (branch-based lookup fails if multiple PRs share the head)
PR=$(gh pr list --head <branch> --state open --json number --jq '.[0].number // empty')
[ -z "$PR" ] && { echo "No open PR for <branch> — skipping PR comment"; exit 0; }

# If the last comment is our Codex review, edit it; otherwise post a fresh one
LAST=$(gh pr view "$PR" --json comments --jq '.comments | last | .body // empty')
BODY=$(printf '**Codex Review:**\n\n%s' "$reviewBody" | head -c 60000)

if [ "${LAST#**Codex Review:**}" != "$LAST" ]; then
  gh pr comment "$PR" --edit-last --body "$BODY"
else
  gh pr comment "$PR" --body "$BODY"
fi
```

`--edit-last` edits the authenticated user's most recent comment on the PR. Requires `gh ≥ 2.48`.

### 9. Report to user

Build a message:
- PR URL (if found)
- Commit log
- Diff stat
- Review body (last 3000 chars; full version lives in the PR comment)
- Autofix outcome, if applied
- `To merge: /merge <branch>`

## Verification

- `gh pr view <branch>` shows the review comment with `Codex Review:` prefix
- If autofix ran, `git log origin/<branch>` shows the `fix: apply Codex review findings` commit
- Current branch after run = `main`

## Edge cases

- **Codex auth expired:** stdout contains `401` / `Unauthorized` → tell user: `codex auth` on VPS.
- **Codex timeout:** report timed-out, don't block. Review is advisory.
- **Rate limit:** stdout contains `429` / `rate` → report and stop.
- **No PR exists:** still run and return findings; skip the comment upsert.
- **Bridge already ran this for /sync:** that's fine — upsert is idempotent; it'll edit the same comment.

## Source-of-truth

Bridge implementation: `src/telegram.ts:720-870`. Behavioral parity required until bridge retirement.

## Related skills

- `/sync` — commit + review in one step (prefer this for current-branch work)
- `/merge` — merge PR after review passes
