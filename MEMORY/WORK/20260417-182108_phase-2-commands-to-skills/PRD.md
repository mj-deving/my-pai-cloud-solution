---
task: Execute Phase 2 commands to skills migration
slug: 20260417-182108_phase-2-commands-to-skills
effort: advanced
phase: complete
progress: 44/44
mode: interactive
started: 2026-04-17T18:21:08+02:00
updated: 2026-04-17T19:05:00+02:00
---

## Context

Phase 2 of the Channels Migration (see `~/.claude/diagrams/channels-migration-plan.html`, beads `my-pai-cloud-solution-8tn`). Map 28 bridge Telegram commands to Claude Code skills or CLAUDE.md entries so Channels (VPS-native Claude Code session) becomes functionally equivalent to the bridge. Phase 2 unblocks Phase 5 (bridge retirement).

**Scope (confirmed with user):** Full Phase 2 (2A + 2B + 2C). Skills in project `.claude/skills/` (git-tracked, rsync-deployed).

**Migration mechanism per bridge command:**
- **Drop (7):** `/start /help /verbose /oneshot /quick /keep /reauth` — not applicable in Channels, no skill needed
- **Document in CLAUDE.md (7):** `/workspace /project /status /clear /merge /projects /deleteproject` — map to Channels-native equivalents
- **New skills (6):** `/sync /wrapup /deploy /review /newproject /group_chat`
- **Deferred to Phase 3/MCP (4):** `/delegate /workflow /pipeline /schedule` — out of Phase 2 scope

**Priority skill:** `/sync` — replicates bridge behavior: git add → commit → push cloud/* → create PR via gh → codex review → parse P0-P3 → optional autofix → upsert review comment.

### Risks
- **Bridge regression:** Modifying bridge code during Phase 2 breaks primary surface. Mitigation: skills-only additions, no bridge edits.
- **Skill drift from bridge:** `/sync` skill behavior may diverge from bridge `/sync` command. Mitigation: read bridge implementation as source of truth, document equivalence.
- **VPS vs local execution:** Skills must work in both Channels (VPS) and local Claude Code. Mitigation: use portable commands (`gh`, `codex`, `bun`) available in both environments.
- **Existing Wrapup skill:** Global `~/.claude/skills/Wrapup/` already exists. Risk of duplication. Mitigation: project `/wrapup` is a thin wrapper that invokes global + adds project-specific handoff.
- **Skill discovery:** Claude Code auto-loads `.claude/skills/` per-project — verify each SKILL.md has proper frontmatter.

### Plan

**Decomposition by sub-phase:**

1. **2A Drop (no code):** Add migration-notes section to CLAUDE.md documenting which bridge commands have no Channels equivalent (and why).
2. **2B Document (CLAUDE.md):** Extend migration-notes with 7 commands mapped to Channels equivalents.
3. **2C Skills (6 new files):** Write `SKILL.md` for each in `.claude/skills/<name>/`. Use `/sync` as priority pattern — others follow same template.
4. **Verify:** Type-check, run tests (no regressions), `bd close` issue.

**Technical approach:**
- Read each bridge command implementation in `src/telegram.ts` as the behavioral spec
- Convert each to Claude Code skill format (frontmatter YAML + markdown instructions + Bash/Edit tool invocations)
- Skills are NOT TypeScript — they're `.md` files that instruct Claude what to do
- Git-track skills so they deploy to VPS via existing `scripts/deploy.sh` rsync

**Parallel work:** The 6 skills are independent — I'll write them sequentially for consistency (shared template), not in parallel agents.

## Criteria

**2A — Drop 7 bridge-only commands (documented in CLAUDE.md)**
- [x] ISC-1: CLAUDE.md has "## Phase 2 Migration Notes" section
- [x] ISC-2: CLAUDE.md documents /start as dropped (Channels has native greeting)
- [x] ISC-3: CLAUDE.md documents /help as dropped (Claude Code lists skills natively)
- [x] ISC-4: CLAUDE.md documents /verbose as dropped (bridge-only formatting)
- [x] ISC-5: CLAUDE.md documents /oneshot as dropped (Claude `-p` flag native)
- [x] ISC-6: CLAUDE.md documents /quick as dropped (model selection via CLI)
- [x] ISC-7: CLAUDE.md documents /keep as dropped (no auto-wrapup in Channels)
- [x] ISC-8: CLAUDE.md documents /reauth as dropped (Channels uses OAuth directly)

**2B — Document 7 commands mapped to Channels equivalents**
- [x] ISC-9: CLAUDE.md documents /workspace mapped to default Claude session
- [x] ISC-10: CLAUDE.md documents /project mapped to cd into project dir
- [x] ISC-11: CLAUDE.md documents /status mapped to session + git status
- [x] ISC-12: CLAUDE.md documents /clear mapped to Claude `/clear` native
- [x] ISC-13: CLAUDE.md documents /merge mapped to new /merge skill or gh CLI
- [x] ISC-14: CLAUDE.md documents /projects mapped to ls ~/projects
- [x] ISC-15: CLAUDE.md documents /deleteproject mapped to rm + registry edit

**2C — /sync skill (priority, 6 criteria)**
- [x] ISC-16: `.claude/skills/sync/SKILL.md` exists with valid frontmatter
- [x] ISC-17: /sync skill documents git add + commit + push to cloud/* branch
- [x] ISC-18: /sync skill documents PR creation via `gh pr create`
- [x] ISC-19: /sync skill documents `codex review --base main` invocation
- [x] ISC-20: /sync skill documents P0-P3 parsing and autofix decision
- [x] ISC-21: /sync skill documents upsertReviewComment via `gh pr comment`

**2C — /wrapup skill**
- [x] ISC-22: `.claude/skills/wrapup/SKILL.md` exists with valid frontmatter
- [x] ISC-23: /wrapup skill references global Wrapup skill for core flow
- [x] ISC-24: /wrapup skill documents CLAUDE.md + MEMORY.md two-file update

**2C — /deploy skill**
- [x] ISC-25: `.claude/skills/deploy/SKILL.md` exists with valid frontmatter
- [x] ISC-26: /deploy skill documents `bash scripts/deploy.sh` invocation
- [x] ISC-27: /deploy skill documents `systemctl restart isidore-cloud-bridge`
- [x] ISC-28: /deploy skill documents journalctl health verification

**2C — /review skill**
- [x] ISC-29: `.claude/skills/review/SKILL.md` exists with valid frontmatter
- [x] ISC-30: /review skill documents `codex review --base main` invocation
- [x] ISC-31: /review skill documents P0-P3 finding parsing
- [x] ISC-32: /review skill documents PR comment upsert pattern

**2C — /newproject skill**
- [x] ISC-33: `.claude/skills/newproject/SKILL.md` exists with valid frontmatter
- [x] ISC-34: /newproject skill documents project registry JSON update
- [x] ISC-35: /newproject skill documents git clone + directory setup

**2C — /group_chat skill**
- [x] ISC-36: `.claude/skills/group_chat/SKILL.md` exists with valid frontmatter
- [x] ISC-37: /group_chat skill documents parallel Task dispatch to N agents
- [x] ISC-38: /group_chat skill documents moderator synthesis step

**Verification**
- [x] ISC-39: All 6 skill frontmatter blocks parse as valid YAML
- [x] ISC-40: Bridge test suite (412 tests) still passes unchanged
- [x] ISC-41: `bunx tsc --noEmit` passes with zero new errors
- [x] ISC-42: `bd close my-pai-cloud-solution-8tn` succeeds (Phase 5 unblocked)

**Anti-criteria**
- [x] ISC-A1: No bridge commands deleted from `src/telegram.ts`
- [x] ISC-A2: No existing bridge tests modified or removed

## Decisions

- **Skills lowercase, global skills PascalCase** — Convention: project-scoped skills in `.claude/skills/` use lowercase (matches bridge command names: `sync`, `wrapup`). Global skills in `~/.claude/skills/` stay PascalCase (`Wrapup`, `GitWorkflow`). Distinct namespaces, no collision.
- **Upsert via `gh pr comment --edit-last`** — Chose this over `gh api PATCH` because it doesn't need owner/repo resolution and handles both create + edit in one command. Requires `gh ≥ 2.48`.
- **No bridge code changes** — Phase 2 is additive only. Bridge `/sync`, `/review`, etc. remain primary until Phase 5. Skills are the Channels-native equivalent, not a replacement.
- **Scaffold over heredoc** — /newproject writes CLAUDE.md locally then `scp`s to VPS. Avoids the nested-heredoc shell-quoting trap that broke the first draft.

## Verification

- `npx tsc --noEmit` → 0 errors (bridge source untouched)
- `bun test` → 412 pass / 0 fail (baseline preserved)
- `.claude/skills/*/SKILL.md` → 6 files, all frontmatter parses as valid YAML with `name/description/trigger` keys
- `git diff --stat src/` → empty (no bridge code changed; anti-criteria ISC-A1, ISC-A2 pass)
- `CLAUDE.md` → +55 lines for "## Phase 2 Migration Notes" section with 3 mapping tables (Dropped 7 / Mapped 7 / New skills 6) + deferred table
- Simplify review: 4 P0 shell bugs found and fixed (`\n` in `git commit -m`, empty-array `last.id`, `gh api PATCH` without owner/repo, fragile SSH heredoc). P1s addressed: PR-number resolution, env-specific MEMORY.md path, atomic jq registry write, dropped wrong `/fast` and `Skill("Pai")` references in CLAUDE.md.
