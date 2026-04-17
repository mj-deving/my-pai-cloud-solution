---
name: sync
description: "Commit + push to cloud/* branch + open PR + run Codex review + optionally autofix + post review to PR. USE WHEN user says /sync, sync this, push and review, commit and review, ship changes, save to cloud branch."
user_invocable: true
trigger: /sync
---

# /sync — Commit, Push, PR, Review

Replicates the bridge `/sync` command in a Channels-native flow. Chains git + gh + codex into one linear workflow.

## Preconditions

- Repo has a remote named `origin` pointing to GitHub
- `gh` CLI authenticated (`gh auth status`)
- `codex` CLI installed and authenticated (`codex --version`)
- Current branch is NOT `main` — user must be on `cloud/<desc>` or will be moved to one

## Workflow

### 1. Verify preconditions

```bash
git -C <project-dir> status --porcelain
git -C <project-dir> branch --show-current
gh auth status
```

If on `main`: create a `cloud/<short-description>` branch from the current HEAD before committing. Never push to `main`.

### 2. Stage, commit, push

```bash
git -C <project-dir> add -A
git -C <project-dir> commit -m "<type>: <what> (imperative)" -m "<why in 1-3 sentences>"
git -C <project-dir> push -u origin <cloud-branch>
```

Use two `-m` flags for subject + body — bash does not interpret `\n` inside `-m "..."`.

Commit-message format: conventional types (`feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `ci`). See `~/.claude/skills/GitWorkflow/SKILL.md` for the full convention.

### 3. Create or reuse PR

```bash
# Check for existing PR
gh pr list --head <cloud-branch> --json number,url --jq '.[0]'

# If none: create
gh pr create \
  --head <cloud-branch> \
  --base main \
  --title "<cloud-branch short name>" \
  --body "Cloud sync from Isidore.\n\nBranch: \`<cloud-branch>\`"
```

Report the PR URL to the user.

### 4. Run Codex review

```bash
codex review --base main
```

Timeout: 120s. Capture stdout. `codex` is expected on `PATH`; on VPS it resolves to `~/.npm-global/bin/codex`.

**Parse findings:** scan for `[P0]`, `[P1]`, `[P2]`, `[P3]` markers. Any match = issues found.

### 5. Post review to PR (upsert)

Idempotent upsert via `gh pr comment --edit-last`. If the last comment by the authenticated user starts with `**Codex Review:**`, edit it; otherwise post a fresh comment:

```bash
# Resolve PR number (safer than passing branch — branch lookup fails if multiple PRs share the head)
PR=$(gh pr list --head <cloud-branch> --state open --json number --jq '.[0].number // empty')
[ -z "$PR" ] && { echo "No open PR for <cloud-branch>"; exit 1; }

# Check if our last comment is already a Codex review (safe on empty: `// empty`)
LAST=$(gh pr view "$PR" --json comments --jq '.comments | last | .body // empty')

BODY=$(printf '**Codex Review:**\n\n%s' "$REVIEW_OUTPUT")
if [ "${LAST#**Codex Review:**}" != "$LAST" ]; then
  gh pr comment "$PR" --edit-last --body "$BODY"
else
  gh pr comment "$PR" --body "$BODY"
fi
```

`--edit-last` (gh ≥ 2.48) edits the authenticated user's most recent comment. Keep review body under ~60KB (GitHub comment limit) — truncate with `head -c 60000` if larger.

### 6. Optional autofix (if P0-P3 findings AND `CODEX_AUTOFIX=1`)

```bash
# Check env
[ "$CODEX_AUTOFIX" = "1" ] || skip

# Apply autofix on the cloud branch
git -C <project-dir> checkout <cloud-branch>
codex exec --full-auto "Apply the following Codex review findings. Be surgical — only fix what's explicitly flagged:\n\n<review-body>"

# If codex changed files: commit + push
git -C <project-dir> add -A
git -C <project-dir> commit -m "fix: apply Codex review findings"
git -C <project-dir> push
```

Run the autofix check only if `codex review` produced at least one `[P0-3]` finding — otherwise skip.

Return to previous branch after.

## Verification

Report to user:
- Commit hash and branch
- PR URL
- Review summary (first 500 chars)
- Autofix note (applied / skipped / no issues)

Confirm PR is visible: `gh pr view <cloud-branch>` should return the PR JSON.

## Edge cases

- **Dirty working tree before commit:** `git status --porcelain` returns non-empty → commit includes everything. User should have cleaned first.
- **No changes to commit:** `git diff --cached --quiet` → skip to step 3 (maybe PR still needs creating).
- **Codex 401/timeout/rate:** report error, do NOT block the PR. The PR is still created; review is advisory.
- **Autofix breaks build:** user must revert manually. We do NOT run tests after autofix — that's for `/review` follow-up.

## Source-of-truth

Bridge implementation: `src/telegram.ts:545-691` in this repo. Keep behavioral parity. If bridge changes, update this skill.

## Related skills

- `GitWorkflow` — commit conventions, atomic commits
- `/review` — run review on an existing branch without sync
- `/merge` — merge `cloud/*` PR after review passes
