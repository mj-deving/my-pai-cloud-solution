# Plan: `/newproject` — Telegram-driven project creation

## Context

Currently, adding a new project requires manually editing `config/projects.json`, creating the GitHub repo, setting up directories, etc. Marius wants a single Telegram command — `/newproject myproject` — that auto-creates everything on the Cloud side. Local setup happens later via a simple `git clone` when he needs it.

The VPS already has `gh` authenticated with `repo` scope (classic PAT), so GitHub repo creation works out of the box.

## Design Decisions (confirmed with Marius)

- **Command:** `/newproject myproject` (separate command, not a subcommand of `/project`)
- **Auto-switch:** Yes — immediately switch to the new project after creation
- **Scaffold:** Minimal CLAUDE.md only
- **Local path:** `null` — Cloud-only until Marius clones locally
- **Display name:** Auto-derived from slug (`my-cool-project` → `My Cool Project`)

## What `/newproject` does (step by step)

1. **Validate name** — kebab-case, no spaces, no duplicates in registry
2. **Create GitHub repo** — `gh repo create mj-deving/<name> --private --clone` on VPS
3. **Scaffold** — Write minimal `CLAUDE.md` with project name, conventions section, handoff instruction
4. **Initial commit** — Commit + push the scaffold
5. **Register** — Add entry to `config/projects.json` (bundled) AND `pai-knowledge/HANDOFF/projects.json` (registry source)
6. **Auto-switch** — Call `setActiveProject()` to switch + create fresh session + update cwd
7. **Reply** — Confirm with project details and "to clone locally: `git clone ...`"

## Files to modify

### `src/telegram.ts` — Add `/newproject` command handler
- New `bot.command("newproject", ...)` handler
- Parse name from `ctx.match`, validate format
- Call new `projects.createProject(name)` method
- Auto-switch via `projects.setActiveProject()`
- Update `/start` help text to include `/newproject`

### `src/projects.ts` — Add `createProject()` method to ProjectManager
- New `async createProject(name: string)` method:
  - Validate name (kebab-case regex, no duplicates)
  - Derive displayName, git URL, VPS path
  - Shell out to `gh repo create mj-deving/<name> --private` on VPS
  - Clone into `/home/isidore_cloud/projects/<name>/`
  - Write scaffold `CLAUDE.md`
  - Initial git commit + push
  - Add to in-memory registry + save both registry files to disk
  - Return the new `ProjectEntry`
- New `async saveRegistry()` private method to persist registry changes

### `config/projects.json` — No manual edit needed
- `createProject()` adds entries programmatically and saves to disk

## Scaffold: CLAUDE.md template

```markdown
# CLAUDE.md — {name}

## What This Is

{displayName}

**Owner:** Marius
**GitHub:** [mj-deving/{name}](https://github.com/mj-deving/{name})
**Created:** {date}

## Tech Stack

<!-- Fill in as the project evolves -->

## Conventions

- Commit messages: clear "why", prefixed by area when helpful
- Every session should end with a commit capturing the work done
- Code comments: thorough — document interfaces and logic
- File naming: kebab-case

## Cross-Instance Continuity

If `CLAUDE.handoff.md` exists in this directory, read it on session start.
It contains the other instance's (local/Cloud) last session state.

## Current State

**Status:** New project, just created
**Last session:** {date}
```

## Error handling

- Name already exists in registry → reject with message
- Name has invalid characters → reject with format guidance
- `gh repo create` fails → report error, don't register
- Clone fails → report error, clean up partial state
- Registry save fails → report but project exists on GitHub (recoverable)

## Verification

1. Send `/newproject test-project` via Telegram
2. Verify GitHub repo `mj-deving/test-project` exists (private)
3. Verify VPS directory `/home/isidore_cloud/projects/test-project/` exists with CLAUDE.md
4. Verify `config/projects.json` has the new entry
5. Verify bot auto-switched to the new project (`/status` shows it active)
6. Verify `/projects` lists the new project
7. Cleanup: delete test repo with `gh repo delete mj-deving/test-project --yes`
