# Handoff Protocol — Seamless Local↔Cloud Project Continuity

## Context

Marius wants to work on a project locally, leave, continue the same work via Telegram on the VPS (Isidore Cloud), then return locally with zero lost context. Currently the bridge always runs Claude from a fixed working directory with no project awareness, no git sync, and limited knowledge sync (only USER/RELATIONSHIP/LEARNING). This plan makes the bridge project-aware and implements a full handoff protocol.

**Starting scope:** `my-pai-cloud-solution` as the only registered project. Registry is extensible — adding projects later is a config-file edit.

---

## Architecture Overview

```
LOCAL (Isidore)                          VPS (Isidore Cloud)
─────────────────                        ─────────────────────
Session End:                             /project <name>:
  → KnowledgeSync push                    → git pull project
  → git commit + push                     → knowledge sync pull
  → CLAUDE.local.md updated               → read CLAUDE.handoff.md
                                           → set cwd, start session

                                         /done:
                                           → git commit + push
                                           → knowledge sync push
                                           → CLAUDE.local.md → handoff

Session Start:
  → KnowledgeSync pull
  → git pull project
  → read CLAUDE.handoff.md
  → seamless continuity
```

---

## Implementation Plan

### Phase 1: Project Registry + Bridge Project Switching

**Goal:** `/project <name>` command changes which directory Claude runs in.

#### 1a. Create project registry

**New file:** `config/projects.json`

```json
{
  "version": 1,
  "projects": [
    {
      "name": "my-pai-cloud-solution",
      "displayName": "DAI Cloud Solution",
      "git": "git@github.com:mj-deving/my-pai-cloud-solution.git",
      "paths": {
        "local": "/home/mj/projects/my-pai-cloud-solution",
        "vps": "/home/isidore_cloud/projects/my-pai-cloud-solution"
      },
      "autoClone": false,
      "active": true
    }
  ]
}
```

Also sync to `pai-knowledge/HANDOFF/projects.json` so both instances can read it.

#### 1b. Create ProjectManager module

**New file:** `src/projects.ts`

- `ProjectManager` class with:
  - `loadRegistry()` — reads `config/projects.json`
  - `getProject(name)` — lookup by name
  - `getActiveProject()` / `setActiveProject(name)` — reads/writes `~/.claude/handoff-state.json`
  - `getSessionForProject(name)` / `saveSessionForProject(name, id)` — per-project session IDs stored in handoff state
  - `listProjects()` — all active projects

State file format (`~/.claude/handoff-state.json`):
```json
{
  "activeProject": "my-pai-cloud-solution",
  "lastSwitch": "2026-02-26T15:00:00Z",
  "sessions": {
    "my-pai-cloud-solution": "abc-123-session-id"
  }
}
```

#### 1c. Modify `src/config.ts`

Add to `Config` interface:
- `projectRegistryFile: string` (default: `${HOME}/pai-knowledge/HANDOFF/projects.json`)
- `handoffStateFile: string` (default: `${HOME}/.claude/handoff-state.json`)

#### 1d. Modify `src/claude.ts`

Add `cwd` support to `Bun.spawn()`:
- Add `private cwd?: string` to constructor
- Add `setWorkingDirectory(path: string)` method
- Pass `cwd: this.cwd` in both `send()` and `oneShot()` spawn options

**Key change** (line 35):
```typescript
const proc = Bun.spawn(args, {
  stdout: "pipe",
  stderr: "pipe",
  cwd: this.cwd,  // ← ADD THIS
  env: { ...process.env, ANTHROPIC_API_KEY: undefined },
});
```

#### 1e. Modify `src/session.ts`

No structural changes needed. `ProjectManager` will manage per-project session IDs and write the active one to the existing `sessionIdFile` on project switch. `SessionManager` stays as-is.

#### 1f. Modify `src/telegram.ts`

- Accept `ProjectManager` as 4th parameter
- Add `/project <name>` command — switch active project, update cwd, swap session
- Add `/projects` command — list available projects with active marker
- Add `/done` command — commit+push current project, report status
- Add `/handoff` command — alias for `/done` + status summary
- Update `/start` to show new commands
- Update `/status` to show active project

#### 1g. Modify `src/bridge.ts`

- Import and instantiate `ProjectManager`
- On startup: load active project from state, set `claude.setWorkingDirectory()`
- Pass `ProjectManager` to `createTelegramBot()`

---

### Phase 2: Git Sync on Project Switch

**Goal:** Auto `git pull` on project activate, auto `git commit + push` on deactivate/done.

#### 2a. Create git sync script

**New file:** `scripts/project-sync.sh`

Subcommands:
- `pull <dir>` — `git pull --rebase --quiet` with 60s timeout
- `push <dir>` — `git add -u && git commit -m "cloud: auto-save" && git push` with 60s timeout
- `clone <url> <dir>` — `git clone --depth 1` + `bun install` if package.json exists

All operations have timeouts and never fail loudly (exit 0 with warnings).

#### 2b. Add sync methods to `src/projects.ts`

- `syncPull(project)` — spawn `project-sync.sh pull`
- `syncPush(project)` — spawn `project-sync.sh push`
- `ensureCloned(project)` — check dir exists, clone if `autoClone: true`

#### 2c. Enhance `/project` command flow

1. If current project has uncommitted changes → `syncPush(current)`
2. `ensureCloned(target)` if dir missing
3. `syncPull(target)` to get latest
4. Switch session + cwd
5. Report status to Telegram

#### 2d. Implement `/done` command

1. `syncPush(activeProject)` — commit + push
2. Report: "Changes saved. N files committed. Ready for local pickup."

---

### Phase 3: Expanded Knowledge Sync

**Goal:** WORK/, SESSIONS/, and per-project CLAUDE.local.md sync between instances.

#### 3a. Expand `scripts/sync-knowledge.sh`

Add to `SYNC_DIRS` array:
```bash
"WORK:${MEMORY_DIR}/WORK:${REPO_DIR}/WORK"
"SESSIONS:${MEMORY_DIR}/SESSIONS:${REPO_DIR}/SESSIONS"
```

#### 3b. Add CLAUDE.local.md continuity sync

New function in `sync-knowledge.sh`: `sync_continuity_files()`
- On **push:** Copy each project's `CLAUDE.local.md` to `pai-knowledge/HANDOFF/continuity/<project>/CLAUDE.local.md`
- On **pull:** Copy from repo to `<project>/CLAUDE.handoff.md` (NOT overwriting CLAUDE.local.md)

Key design: `CLAUDE.handoff.md` is a read-only copy of the other instance's state. Each instance keeps its own `CLAUDE.local.md` untouched. Claude reads both on session start.

#### 3c. Create directory structure in pai-knowledge

```
pai-knowledge/
  HANDOFF/
    projects.json
    continuity/
      my-pai-cloud-solution/
        CLAUDE.local.md
```

#### 3d. Add CLAUDE.handoff.md to .gitignore

In each project, `.gitignore` should include `CLAUDE.handoff.md`.

---

### Phase 4: Cloud-Side Lightweight Wrapup

**Goal:** After Cloud finishes work, auto-commit and prepare state for local pickup.

#### 4a. Create wrapup module

**New file:** `src/wrapup.ts`

`lightweightWrapup(project)`:
- `git add -u` in project dir (tracked files only, never `git add -A`)
- `git commit` if changes exist
- Non-blocking, 10s timeout

#### 4b. Post-response hook in telegram.ts

After the default message handler sends the response:
- If active project exists, call `lightweightWrapup()`
- Auto-commit only, no push (push happens on `/done` or `/project` switch)

This ensures intermediate work is committed even without explicit `/done`.

---

## Files Summary

| File | Action | Phase |
|------|--------|-------|
| `config/projects.json` | Create | 1 |
| `src/projects.ts` | Create | 1 |
| `src/config.ts` | Modify — add 2 config fields | 1 |
| `src/claude.ts` | Modify — add `cwd` to Bun.spawn | 1 |
| `src/telegram.ts` | Modify — add commands, accept ProjectManager | 1+2 |
| `src/bridge.ts` | Modify — init ProjectManager, wire up | 1 |
| `bridge.env.example` | Modify — document new env vars | 1 |
| `scripts/project-sync.sh` | Create | 2 |
| `src/projects.ts` | Extend — add sync methods | 2 |
| `scripts/sync-knowledge.sh` | Modify — expand SYNC_DIRS + continuity | 3 |
| `src/wrapup.ts` | Create | 4 |
| `src/telegram.ts` | Extend — post-response wrapup | 4 |

**Existing code to reuse:**
- `src/session.ts` — unchanged, ProjectManager writes to its session file
- `src/format.ts` — unchanged
- `scripts/sync-knowledge.sh` — extended, not rewritten
- `~/.claude/hooks/KnowledgeSync.hook.ts` — already built, handles local push/pull

---

## Key Design Decisions

1. **Per-project sessions:** Each project gets its own session ID stored in `handoff-state.json`. On switch, the active session ID is written to the shared `active-session-id` file so `SessionManager` works unchanged.

2. **CLAUDE.handoff.md (not overwrite):** Pull writes to `CLAUDE.handoff.md`, not `CLAUDE.local.md`. Each instance keeps its own local state. Claude reads both.

3. **`git add -u` only:** Auto-commits never use `git add -A`. Only tracked files. Prevents accidental commit of .env, build artifacts, or untracked garbage.

4. **Project registry in repo:** Lives at `config/projects.json` (in the bridge project) AND synced to `pai-knowledge/HANDOFF/projects.json`. The bridge reads from the synced location so both instances see the same registry.

5. **Push only on explicit action:** Auto-commit happens after each response (Phase 4), but `git push` only happens on `/done`, `/project` switch, or explicit `/push`. This avoids excessive network I/O during conversations.

---

## Edge Cases

- **Git conflict on pull:** `--rebase` used. If fails, warn via Telegram, leave working tree as-is. Marius can SSH in to resolve.
- **Stale session:** Already handled by `claude.ts` line 58-62 (auto-retry fresh).
- **Bridge restart:** State persists in `handoff-state.json`. On startup, restore active project + cwd.
- **Project dir missing:** If `autoClone: true`, clone it. If `false`, report error.
- **Disk space:** `autoClone` is opt-in per project. Shallow clone (`--depth 1`) by default.

---

## Verification

After implementation, test the full handoff cycle:

1. **Project switching:** Send `/projects` via Telegram → see list. Send `/project my-pai-cloud-solution` → confirm cwd change.
2. **Git pull on switch:** Make a local commit+push, then `/project` on VPS → verify the commit appears.
3. **Work on VPS:** Send a message that causes Claude to edit a file → verify file changed in project dir.
4. **Auto-commit:** After response, check `git log` on VPS → verify auto-commit exists.
5. **Done/push:** Send `/done` → verify git push succeeds, changes visible on GitHub.
6. **Local pickup:** Start local session → verify `git pull` gets VPS changes, `CLAUDE.handoff.md` has VPS context.
7. **Knowledge sync:** Verify WORK/ and SESSIONS/ appear in `pai-knowledge` repo after push.
8. **Continuity file:** Verify `CLAUDE.local.md` appears in `pai-knowledge/HANDOFF/continuity/my-pai-cloud-solution/`.

Deploy via `scripts/deploy.sh` (already handles rsync + systemd restart).
