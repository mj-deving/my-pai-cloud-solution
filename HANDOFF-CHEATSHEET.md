# Handoff Protocol Cheatsheet

How Isidore (local) and Isidore Cloud (VPS/Telegram) share work seamlessly.

---

## The Files

| File | What It Is | Who Writes It | Who Reads It | Auto-loaded? |
|------|-----------|---------------|-------------|-------------|
| `CLAUDE.md` | Project instructions (checked in) | You manually | Both instances | Yes (Claude Code built-in) |
| `CLAUDE.local.md` | Session continuity state | Wrapup skill (Step 5) | Same instance | Yes (Claude Code built-in) |
| `CLAUDE.handoff.md` | Other instance's CLAUDE.local.md | Knowledge sync pull | Receiving instance | **No** — needs CLAUDE.md instruction |
| `handoff-state.json` | Active project + per-project sessions | Bridge (ProjectManager) | Bridge on restart | N/A (bridge internal) |
| `pai-knowledge/HANDOFF/projects.json` | Project registry | You manually | Both instances | N/A (ProjectManager reads) |
| `pai-knowledge/HANDOFF/continuity/<project>/CLAUDE.local.md` | Transit copy of CLAUDE.local.md | Knowledge sync push | Knowledge sync pull | N/A (intermediate) |

### The CLAUDE.local.md → CLAUDE.handoff.md Flow

```
Instance A: Wrapup/exit writes CLAUDE.local.md
  ↓
Knowledge sync push: copies CLAUDE.local.md → pai-knowledge/HANDOFF/continuity/<project>/
  ↓
Git push to GitHub
  ↓
Git pull from GitHub
  ↓
Knowledge sync pull: copies from repo → Instance B's CLAUDE.handoff.md
  ↓
Instance B: Claude reads CLAUDE.handoff.md (if CLAUDE.md tells it to)
```

**Key rule:** CLAUDE.local.md is never overwritten by sync. Each instance keeps its own. The other instance's state arrives as CLAUDE.handoff.md.

### Knowledge Directories Synced

| Directory | Contents | Sync Direction |
|-----------|----------|---------------|
| `USER/` | Identity, contacts, personal data | Both ways |
| `RELATIONSHIP/` | Relationship notes | Both ways |
| `LEARNING/` | Session learnings | Both ways |
| `WORK/` | Work tracking state | Both ways |
| `SESSIONS/` | Session documents | Both ways |

---

## Workflow A: Local Work → Hand Off to Cloud

```
LOCAL (Isidore)
───────────────────────────────────────────────────────────────

1. Start session
   $ cd ~/projects/my-pai-cloud-solution
   $ claude                              ← fresh session (most common)
   $ claude --resume                     ← resume prior session (less common)
   → SessionStart hook fires → knowledge sync PULL (automatic)
   → Claude reads: CLAUDE.md + CLAUDE.local.md + CLAUDE.handoff.md (if exists)

2. Work
   Normal conversation. Claude edits files.

3. End session — ANY of these paths:
   a) /wrapup → updates CLAUDE.local.md, fires SessionEnd hooks (including
      knowledge sync PUSH), commits+pushes can be done here manually
   b) /clear → SessionEnd hooks fire (including knowledge sync PUSH)
   c) /exit or Ctrl+C → SessionEnd hooks fire (including knowledge sync PUSH)

   What fires automatically via hooks:
   - CLAUDE.local.md → pai-knowledge repo (via sync-knowledge.sh push)
   - USER/, RELATIONSHIP/, LEARNING/, WORK/, SESSIONS/ → repo

4. Git commit + push your code changes
   $ git add -u && git commit -m "wip" && git push
   (or done as part of /wrapup if you ask for it)

   NOTE: Knowledge sync is already done by step 3's hooks.
   This step is ONLY about code changes.

───────────────────────────────────────────────────────────────
VPS (Isidore Cloud via Telegram)

5. Activate project
   /project my-pai-cloud-solution

   What happens automatically:
   a) Auto-pushes any prior project's uncommitted changes
   b) git pull --rebase (gets your code from step 4)
   c) sync-knowledge.sh pull (gets CLAUDE.local.md → CLAUDE.handoff.md)
   d) Switches cwd so Claude runs IN the project
   e) Restores per-project session ID (or starts fresh)

6. Work via Telegram
   Send messages normally.
   - Claude runs with cwd = project directory
   - After EACH response: auto-commits tracked files (git add -u)
   - NO knowledge sync per message (suppressed via SKIP_KNOWLEDGE_SYNC)

7. Done working on Cloud
   /done                              ← commit + push + knowledge sync
   /handoff                           ← same + detailed status summary

   What happens automatically:
   a) git add -u + commit + push
   b) sync-knowledge.sh push (Cloud's CLAUDE.local.md → repo)
```

---

## Workflow B: Cloud Work → Pick Up Locally

```
LOCAL (Isidore)
───────────────────────────────────────────────────────────────

8. Pull Cloud's code changes
   $ cd ~/projects/my-pai-cloud-solution
   $ git pull                           ← gets Cloud's auto-commits + /done push

9. Start session
   $ claude                              ← fresh (recommended after handoff)
   → SessionStart hook fires → knowledge sync PULL (automatic)
   → Pulls Cloud's CLAUDE.local.md → your CLAUDE.handoff.md
   → Claude reads: CLAUDE.md + CLAUDE.local.md + CLAUDE.handoff.md
   → Has context from BOTH local AND Cloud work

   NOTE: Step 8 before 9 because git pull needs to happen before
   Claude reads the files. The hook pulls knowledge (CLAUDE.handoff.md),
   but git pull gets the actual code changes.
```

---

## What's Automatic vs Manual

| Action | When | How |
|--------|------|-----|
| Knowledge sync pull | Local session start | SessionStart hook (automatic) |
| Knowledge sync push | Local session end/clear/wrapup | SessionEnd hook (automatic) |
| Knowledge sync pull | Cloud `/project` switch | Bridge calls sync-knowledge.sh (automatic) |
| Knowledge sync push | Cloud `/done` or `/handoff` | Bridge calls sync-knowledge.sh (automatic) |
| Knowledge sync per message | Cloud Telegram messages | **Suppressed** (SKIP_KNOWLEDGE_SYNC) |
| Auto-commit | Cloud after each response | wrapup.ts (automatic, git add -u only) |
| Git push | Cloud | `/done` or `/handoff` only (not per-message) |
| Git pull | Local before session | **Manual** — `git pull` before `claude` |
| Git commit + push | Local after work | **Manual** — part of your exit workflow |

---

## Gap: CLAUDE.handoff.md Not Auto-Loaded

Claude Code auto-loads `CLAUDE.md` and `CLAUDE.local.md` from cwd. It does **NOT** auto-load `CLAUDE.handoff.md`.

**Fix needed:** Add to each project's `CLAUDE.md`:
```markdown
## Cross-Instance Continuity
If `CLAUDE.handoff.md` exists in this directory, read it on session start.
It contains the other instance's (local/Cloud) last session state.
```

**Status:** Added to CLAUDE.md (see "Cross-Instance Continuity" section).

---

## Quick Reference

| Command | What It Does |
|---------|-------------|
| `/project <name>` | Switch project (auto: push old, pull new, knowledge sync) |
| `/projects` | List available projects |
| `/done` | Commit + push + knowledge sync (ready for local pickup) |
| `/handoff` | Same as /done + detailed status |
| `/new` | Fresh Claude session (no project change) |
| `/status` | Show active project + session info |
| `/delegate <prompt>` | Delegate a task to Gregor via reverse pipeline |
| `/workflow create <prompt>` | Create a multi-step DAG workflow |
| `/workflow status [id]` | List all workflows or show one |
| `/workflows` | List all workflows |
| `/cancel <id>` | Cancel an active workflow |
| `/pipeline` | Pipeline dashboard (forward + reverse + workflows) |
| `/branches` | Show active branch isolation locks |
