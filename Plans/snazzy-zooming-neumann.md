# Plan: PR-Based Cloud Git Workflow

## Context

Cloud Isidore's git workflow (`/sync`, `/review`, `/merge`) currently uses raw git operations with no GitHub PRs. Codex review runs redundantly in 3 places (auto in `/sync`, again in `/review`, and via local `review-cloud.sh`). There's no reviewable artifact on GitHub. This plan adds proper PR lifecycle: push → PR → review-as-PR-comment → merge-PR.

## New File: `src/github.ts`

Standalone functions (no class), each returns `{ ok: boolean; output: string }`. Reuses `Bun.spawn` pattern from `src/projects.ts:462-484`.

| Function | Purpose |
|----------|---------|
| `runGh(args, cwd, timeout)` | Spawn `gh` CLI, return stdout+stderr |
| `findPR(branch, cwd)` | Find open PR for branch → `{ prNumber, url }` or null |
| `createOrReusePR(branch, title, body, cwd)` | Idempotent: check existing PR first, create only if none |
| `upsertReviewComment(branch, reviewBody, cwd)` | Find `<!-- codex-review -->` marker comment → PATCH or create |
| `mergePR(branch, cwd)` | `gh pr merge --merge --delete-branch` + checkout main + pull + delete local branch |

Key details:
- Comment upsert uses `gh api` to list comments, find marker, PATCH existing or create new
- Truncate review body to 60K chars (GitHub limit 65536)
- `gh` auto-detects repo from cwd's `.git/config` — no hardcoded org/repo needed
- 30s default timeout, 60s for PR create/merge

## Changes to `src/telegram.ts`

### `/sync` (line 440)
- **Keep:** commit + push via `project-sync.sh`
- **Add:** `createOrReusePR()` after successful push → include PR URL in reply
- **Change:** Codex review now posts to PR via `upsertReviewComment()` instead of only Telegram
- **Fallback:** If PR creation fails, show old-style `/review` + `/merge` hints

### `/review` (line 554)
- **Keep:** branch listing (no arg), branch validation, fetch+verify, diff stats, commit log
- **Keep:** Codex checkout (Codex CLI needs local branch) — checkout, review, return to main
- **Add:** `upsertReviewComment()` to post review as PR comment
- **Add:** Show PR URL in output if PR exists
- **Fallback:** If no PR, show review inline in Telegram (current behavior)

### `/merge` (line 656)
- **Replace:** raw `git merge` + `git push` + `git push --delete` + `git branch -d`
- **With:** `mergePR()` which does `gh pr merge --merge --delete-branch` + local sync
- **Add:** Friendly "No open PR" message if no PR exists

### Help texts (line 215)
Update `sync`, `review`, `merge` entries to mention PR creation/posting.

### Import
Add `import { createOrReusePR, upsertReviewComment, mergePR, findPR } from "./github";`

## What Gets Removed

- `/sync`: inline Codex review block (lines ~480-524) replaced with PR-posting version
- `/merge`: raw git merge/push/delete (lines ~673-712) replaced with `mergePR()`
- `/review`: no major removals, additions only (PR comment posting)
- `scripts/review-cloud.sh`: untouched, becomes optional local convenience

## Implementation Order

1. Create `src/github.ts` (zero dependencies on existing code)
2. Update `/merge` handler (simplest, easiest to test)
3. Update `/sync` handler (add PR create, change Codex to post to PR)
4. Update `/review` handler (add PR comment posting)
5. Update help texts
6. Update CLAUDE.md Git Workflow section
7. Type check + commit + push

## Verification

1. `npx tsc --noEmit` — type check
2. Deploy to VPS, test on Telegram:
   - `/sync` → verify PR created on GitHub, Codex review posted as comment
   - `/review cloud/<branch>` → verify review updated (not duplicated) on PR
   - `/merge cloud/<branch>` → verify PR merged on GitHub, branch cleaned up
3. Edge cases: `/merge` with no PR, `/sync` twice (idempotent), expired gh auth
