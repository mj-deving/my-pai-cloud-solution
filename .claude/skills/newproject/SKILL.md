---
name: newproject
description: "Create a new PAI Cloud project: GitHub repo + VPS dir + scaffold + registry entry + auto-switch. USE WHEN user says /newproject, create project, new project, scaffold project, init project."
user_invocable: true
trigger: /newproject
---

# /newproject — Scaffold a New PAI Cloud Project

Creates a new project end-to-end: private GitHub repo, VPS directory, initial commit, registry entry, and switches the active session to it. Equivalent to bridge `/newproject <name>`.

## Usage

```
/newproject <kebab-case-name>
```

Name validation:
- lowercase kebab-case only: `^[a-z0-9]+(-[a-z0-9]+)*$`
- no leading/trailing dashes
- must not clash with an existing project in the registry

Reject anything else with a usage example.

## Preconditions

- `gh` CLI authenticated with a classic PAT that can create repos in `mj-deving`
- SSH access to `isidore_cloud`
- Project registry at `~/.config/isidore_cloud/projects.json` (or equivalent JSON file on VPS) is readable/writable

## Workflow

### 1. Read the registry

The bridge stores the registry as JSON. The canonical path is defined by `ProjectManager` in `src/projects.ts` — read that file to get the current location rather than hardcoding. As of writing, it lives at `~/.config/isidore_cloud/projects.json` on VPS.

```bash
REGISTRY=~/.config/isidore_cloud/projects.json
cat "$REGISTRY" 2>/dev/null || echo '{"projects": {}, "active": null}'
```

Abort if `projects[<name>]` already exists (`jq -e ".projects[\"<name>\"]"` returns exit 0).

### 2. Create the GitHub repo

```bash
gh repo create mj-deving/<name> \
  --private \
  --description "PAI Cloud project: <name>" \
  --gitignore Node
```

### 3. Clone on VPS + scaffold

Build the scaffold locally, then transfer — avoids nested heredocs over SSH.

```bash
# 1. Build CLAUDE.md locally in a temp file
SCAFFOLD=$(mktemp)
printf '# %s\n\nPAI Cloud project.\n\n## Build\n\n    bun install\n' "<name>" > "$SCAFFOLD"

# 2. Clone the empty repo on VPS
ssh isidore_cloud "cd /home/isidore_cloud/projects && git clone https://github.com/mj-deving/<name>.git"

# 3. Copy scaffold up
scp "$SCAFFOLD" "isidore_cloud:/home/isidore_cloud/projects/<name>/CLAUDE.md"
rm "$SCAFFOLD"

# 4. Commit + push on VPS
ssh isidore_cloud "cd /home/isidore_cloud/projects/<name> && git add -A && git commit -m 'chore: initial scaffold' && git push -u origin main"
```

Adjust scaffold to match the project type the user described (or keep minimal and let the user flesh it out).

### 4. Write the registry entry

Build the updated registry with `jq`, write atomically (tmp + rename):

```bash
NOW=$(date -Iseconds)
jq --arg name "<name>" \
   --arg display "<Human Name>" \
   --arg vps "/home/isidore_cloud/projects/<name>" \
   --arg gh "mj-deving/<name>" \
   --arg now "$NOW" \
   '.projects[$name] = {
      name: $name,
      displayName: $display,
      paths: { local: null, vps: $vps },
      github: $gh,
      createdAt: $now
    } | .active = $name' \
   "$REGISTRY" > "$REGISTRY.tmp" && mv "$REGISTRY.tmp" "$REGISTRY"
```

The `mv` is atomic on the same filesystem, so partial writes can't corrupt the registry.

### 5. Switch active project

Step 4's `jq` expression already sets `.active = "<name>"`. Tell the user the new project dir so they can `cd` into it in their next session. In Channels this means the next Claude session started from that cwd will auto-load the project's `.claude/` + `.mcp.json`.

### 6. Confirm to user

```
Project created: <name>
GitHub: mj-deving/<name> (private)
VPS:    /home/isidore_cloud/projects/<name>
Status: active + fresh session

To clone locally:
  git clone https://github.com/mj-deving/<name>.git ~/projects/<name>
```

## Verification

- `gh repo view mj-deving/<name>` returns the repo
- `ssh isidore_cloud 'ls -la /home/isidore_cloud/projects/<name>'` shows a `.git` + `CLAUDE.md`
- Registry has the new entry: `jq ".projects[\"<name>\"]" ~/.config/isidore_cloud/projects.json`
- Registry `active` points at the new project

## Edge cases

- **Repo name already taken on GitHub:** `gh repo create` fails with 422 → report, stop, don't touch registry.
- **VPS clone fails (network / auth):** rollback by deleting the repo: `gh repo delete mj-deving/<name> --yes`. Do NOT leave orphan state.
- **Registry file corrupt:** refuse to write; ask user to repair manually. Never blow away existing projects.
- **Dashes in name:** `<name>` is used in paths + URLs; keep it identical everywhere.

## Source-of-truth

Bridge implementation: `src/telegram.ts:477-512`. The heavy lifting happens in `projects.createProject(name)` — check that function's current definition (`src/projects.ts` or similar) for the authoritative scaffold + registry details.

## Related skills

- `/project` — switch to an existing project (documented in CLAUDE.md)
- `/projects` — list all projects (documented in CLAUDE.md)
- `/deleteproject` — remove an entry from the registry (documented in CLAUDE.md)
