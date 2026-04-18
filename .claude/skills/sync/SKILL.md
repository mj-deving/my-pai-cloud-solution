---
name: sync
description: "Commit + push to cloud/* branch + open PR. Review is GitHub-native (Copilot / Codex bot / required reviewers) — no local Codex CLI step. USE WHEN user says /sync, sync this, push and review, commit and review, ship changes, save to cloud branch."
user_invocable: true
trigger: /sync
---

# /sync — Commit, Push, PR

Replicates the bridge `/sync` command in a Channels-native flow. Chains git + gh into one linear workflow. Review happens on GitHub (Copilot / Codex bot / human reviewers) — this skill no longer runs local Codex CLI.

## Preconditions

- Repo has a remote named `origin` pointing to GitHub
- `gh` CLI authenticated (`gh auth status`)
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

### 4. Post a status comment (optional, pre-verified evidence)

GitHub handles review. The skill's job is to hand reviewers a clean PR with evidence that local gates already passed:

```bash
PR=$(gh pr list --head <cloud-branch> --state open --json number --jq '.[0].number // empty')
[ -z "$PR" ] && { echo "No open PR"; exit 1; }

BODY=$(cat <<EOF
**Local pre-verification**

- Tests: \`bun test\` — <N pass / 0 fail>
- Type check: \`bun x tsc --noEmit\` — clean
- Bridge code modified: <yes/no>
- Existing tests modified: <yes/no>

Review handled on GitHub (Copilot / Codex bot / reviewers).
EOF
)

gh pr comment "$PR" --body "$BODY"
```

This comment is advisory. Reviewers decide with their usual tooling.

## Verification

Report to user:
- Commit hash and branch
- PR URL
- Link to the "Checks" tab so they can watch CI / GitHub-native review

Confirm PR is visible: `gh pr view <cloud-branch>` should return the PR JSON.

## Edge cases

- **Dirty working tree before commit:** `git status --porcelain` returns non-empty → commit includes everything. User should have cleaned first.
- **No changes to commit:** `git diff --cached --quiet` → skip to step 3 (maybe PR still needs creating).

## What this skill no longer does

Previous versions ran `codex review --base main` locally, parsed `[P0]–[P3]` findings, upserted a "Codex Review:" comment, and optionally ran `codex exec --full-auto` to autofix. All of that is **removed** as of 2026-04-18 — see `docs/decisions/0002-github-native-review-only.md`. If you want a local second opinion before pushing, run the review skill explicitly — but it is NOT gated by `/sync` anymore.

## Source-of-truth

Bridge implementation: `src/telegram.ts:545-691` in this repo. Keep behavioral parity. If bridge changes, update this skill.

## Related skills

- `GitWorkflow` — commit conventions, atomic commits
- `/review` — run a GitHub-native review summary on an existing branch
- `/merge` — merge `cloud/*` PR after review passes
