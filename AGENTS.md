# AGENTS.md — Workflow Contract

Repo: `my-pai-cloud-solution` (Isidore Cloud — PAI cloud assistant on VPS).

This file is the **workflow authority**. Architecture and config live in `CLAUDE.md`.

## Read Order

1. `CLAUDE.md` — architecture, build commands, project-specific conventions
2. `AGENTS.md` (this file) — workflow, Beads lifecycle, PR discipline
3. `bd ready` — what's actionable now
4. `gh pr list --state open` — whose changes are in flight
5. Relevant `.ai/guides/*.md` for the subsystem you're touching
6. Active `Plans/*.md` (2 files — don't read archived plans)

## Authority Model

| Domain | Authority |
|---|---|
| Architecture, build, deploy | `CLAUDE.md` (git-tracked) |
| Workflow, Beads lifecycle, PR rules | `AGENTS.md` (this file) |
| Task state, operational memory | **Beads** (`bd ready`, `bd remember`, `bd memories`) |
| Code truth | `main` branch + merged PRs |
| Session continuity | `bd ready` + Claude auto-memory |

**Beads is the task authority** — not MEMORY.md, not TodoWrite, not markdown TODO lists.
`MEMORY.md` / `CLAUDE.local.md` remain as session-continuity pointers only, never as task queues.

## Branch & PR Discipline

**Never push to `main` directly.** A pre-push hook blocks it.

1. Create a `cloud/<description>` branch for every change
2. Use `/sync` (Telegram) or manual `git push -u origin cloud/<...>` — this opens a GitHub PR; review is GitHub-native (Copilot / Codex GitHub App / reviewers)
3. Address review findings on the PR, re-push
4. `/merge` merges the PR via `gh pr merge`, syncs local `main`, deletes the branch

Direct push to `main` is a workflow violation even on trivial changes.

## Beads Lifecycle

```bash
bd ready                          # what to work on
bd show <id>                      # full issue context
bd update <id> --claim            # atomic claim before implementation
bd note <id> "progress..."        # during execution
bd dep <blocker> --blocks <id>    # real sequencing only
bd remember "fact" --key <name>   # durable operational memory
bd close <id> --reason "..."      # only on real completion / merge / supersession
```

**Rules:**
- Claim before implementation; never parallel-work a claimed bead
- Create follow-up beads when scope expands — don't silently widen existing ones
- Close only after merge, not after commit
- Use `bd remember` for gotchas, constraints, host facts — not markdown

## Validation Ladder

Before `/sync`:

```bash
bun x tsc --noEmit       # type check
bun test                 # 440+ tests
# Optional: `bash scripts/review-and-fix.sh` for a manual Codex CLI second opinion.
# No skill invokes it anymore — see ADR docs/decisions/0002-github-native-review-only.md
```

After `/sync`:
- GitHub-native review (Copilot / optional Codex GitHub App / reviewers) posts on the PR
- Fix findings, push again
- `/merge` when clean

## Deploy Validation

VPS services require restart after deploy:

```bash
ssh isidore_cloud 'sudo systemctl restart isidore-cloud-bridge'
ssh isidore_cloud 'sudo systemctl restart isidore-cloud-pipeline'
ssh isidore_cloud 'sudo systemctl restart isidore-cloud-channels'
ssh isidore_cloud 'sudo journalctl -u <service> -f'
```

Never assert "deployed" without verifying via `systemctl status` or logs.

## Tier

Operating as **T1** (solo hook-enabled Claude, PR-first).
Upgrade triggers for T2: parallel multi-agent work in one worktree, hot-file serialization, `bd gate` async waits. Not yet needed.

## Do Not

- Do not push to `main`
- Do not close beads without real completion
- Do not use `TodoWrite` / `TaskCreate` / markdown TODO for task tracking
- Do not duplicate facts between `CLAUDE.md` and `bd remember`
- Do not add nested `AGENTS.md` unless a subproject truly diverges

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:ca08a54f -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd dolt push
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds

> **Repo override:** `git push` targets the current `cloud/<...>` branch, not `main`. Landing goes through `/merge` (PR-based). See "Branch & PR Discipline" above.
<!-- END BEADS INTEGRATION -->
