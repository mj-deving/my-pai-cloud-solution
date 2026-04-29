---
name: wrapup
description: "Session persistence for DAI Cloud — bd sync + handoff + CLAUDE.md/MEMORY.md hygiene before /clear. USE WHEN user says /wrapup, save session, handoff, persist memory, end session, before clear."
user_invocable: true
trigger: /wrapup
---

# /wrapup — DAI Cloud Session Persistence

Project-local wrapper around the global `Wrapup` skill. Adds DAI Cloud specifics: two-file system (CLAUDE.md + MEMORY.md), beads state sync, handoff doc for next session.

## Preconditions

- Global `Wrapup` skill is installed: `test -f "$HOME/.claude/skills/Wrapup/SKILL.md"`. If missing, this skill cannot run — report and stop.
- `bd` CLI is on PATH (`bd --version`).

## Authority model (this project)

| File | Owns | Who writes |
|------|------|-----------|
| `CLAUDE.md` | Architecture, build commands, design decisions | Implementation commits + this wrapup |
| Project-scoped `MEMORY.md` (see note below) | Operational knowledge, session continuity, learnings | Auto-memory + this wrapup |
| `CLAUDE.local.md` | Session continuity (private, local-only) | This wrapup |
| `.beads/` (via `bd`) | Task state, blockers, memories | `bd` CLI |

**MEMORY.md path is env-specific.** Claude Code stores project memory under a URL-encoded project path:
- Local (Marius laptop): `$HOME/.claude/projects/-home-mj-projects-my-pai-cloud-solution/memory/MEMORY.md`
- VPS (Channels session): `$HOME/.claude/projects/-home-isidore_cloud-projects-my-pai-cloud-solution/memory/MEMORY.md`

Resolve at runtime: `find "$HOME/.claude/projects" -maxdepth 2 -name 'MEMORY.md' -path '*my-pai-cloud-solution*' 2>/dev/null | head -1`.

**Rule:** Never duplicate between CLAUDE.md and MEMORY.md. Architecture → CLAUDE.md. Operational/learnings → MEMORY.md or `bd remember`.

## Workflow

### 1. Delegate to global Wrapup skill

The core flow (beads sync + handoff doc + MEMORY.md index) lives in `~/.claude/skills/Wrapup/`. Invoke it:

```
Skill("Wrapup")
```

That skill handles:
- `bd dolt pull` to get latest beads state from the Dolt remote
- `bd ready` / `bd list` snapshot
- Writes `handoff_active.md` with decisions + gotchas from the current session
- Updates global `MEMORY.md` index (lightweight reference table)

### 2. Add DAI Cloud addenda

After the global wrapup runs, do the project-specific parts:

#### a. Update CLAUDE.local.md (private session continuity)

Append a new section at the top:

```markdown
# Session Continuity

**Last wrapup:** <ISO-8601 timestamp>
**Current focus:** <one sentence on what's live and what's next>

## Completed This Session
- <bullet list of concrete completions>

## In Progress
- <what's mid-flight, or "None">

## Next Steps
1. <ordered list>

## Blockers
- <what's stuck, or "None">
```

Move the prior "Last wrapup" section below as historical context.

#### b. Update MEMORY.md (project-scoped)

Resolve the path at runtime (see the preconditions note). Then:
- Update `**Last wrapup:**` timestamp
- Update `### Migration Status` if phase status changed
- Add new bullets to `## Patterns & Learnings` for non-obvious insights this session taught us
- Refresh `## Operational Knowledge` if VPS state, ports, or service names changed

#### c. Update CLAUDE.md (architecture) — only if needed

If this session changed architecture, commands, or conventions, edit CLAUDE.md directly. Do NOT put ephemeral session context here — that belongs in MEMORY.md or CLAUDE.local.md.

### 3. Commit session artifacts

```bash
git -C /home/mj/projects/my-pai-cloud-solution add CLAUDE.md MEMORY.md  # if changed
# CLAUDE.local.md is .gitignored — do not add
git -C /home/mj/projects/my-pai-cloud-solution status --short
```

Only commit and push if the user explicitly wants to sync the project files. Otherwise leave them for the next `/sync`.

## Verification

- `cat CLAUDE.local.md | head -20` shows the new "Last wrapup" stamp
- `bd ready` still shows expected issues
- `git status` shows any intended commits are staged/committed

## Edge cases

- **Channels context:** /wrapup runs inside a Channels session on VPS. The session may lack local-only files. Skip `CLAUDE.local.md` update if running on VPS — that file is local-only by convention.
- **In-progress beads issue:** do NOT close beads issues at wrapup. Use `bd note <id> "..."` to log progress. Close only on real completion (merge, deploy, verify).
- **Context fill ≥70%:** the bridge auto-suggests wrapup at this threshold. Channels has no auto-wrapup — user invokes manually.

## Source-of-truth

Bridge implementation: `src/telegram.ts:1462-1475`. The bridge call to `ClaudeInvoker.quickShot(wrapupSystem, ...)` does the MEMORY.md/CLAUDE.md synthesis. In Channels, that work is delegated to the global Wrapup skill + the manual edits in step 2 above.

## Related skills

- `Wrapup` (global) — core beads + handoff flow, required dependency
- `/sync` — commit + push after wrapup if user wants files persisted remotely
