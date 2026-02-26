# Plan: Isidore Cloud — Naming Separation & Knowledge Sync

## Context

Two problems intertwined:

1. **Naming confusion:** Both local (WSL2) and VPS instances are called "Isidore." When Marius talks to either, or when we discuss deployments, it's unclear which is which. The Telegram bot already shows as "isidore_cloud" but the Linux user, SSH alias, systemd services, and all project code still say "isidore."

2. **Knowledge sync:** Isidore Cloud is currently a "clean slate fresh installation" — it has PAI skills and hooks but no accumulated relationship knowledge, Telos data, or learnings from local Isidore. Marius wants them to effectively be the same person with shared knowledge, able to work on the same repos with minimal context drift.

### Design Principle

**One identity, two runtimes.** Isidore is one assistant. The local instance and cloud instance share personality, knowledge, relationship history, and user preferences. They differ only in environment (paths, active sessions, available hardware). The naming distinguishes the runtime, not the identity.

## Part 1: Naming Rename

### Naming Convention

| Aspect | Local (WSL2) | VPS |
|--------|-------------|-----|
| Identity name | Isidore | Isidore Cloud |
| Display name | ISIDORE | ISIDORE CLOUD |
| Linux user | mj (Marius's own) | `isidore_cloud` |
| SSH alias | N/A (local) | `isidore_cloud` |
| SSH key | N/A | `id_ed25519_isidore_cloud` |
| systemd services | N/A | `isidore-cloud-bridge`, `isidore-cloud-tmux` |
| tmux session | N/A | `isidore_cloud` |
| Config dir on VPS | N/A | `~/.config/isidore_cloud/` |
| Home dir on VPS | N/A | `/home/isidore_cloud/` |

### VPS-Side Changes (SSH commands, executed in sequence)

**Step 1: Stop services and prepare**
```bash
ssh isidore 'sudo systemctl stop isidore-bridge isidore-tmux'
ssh isidore 'sudo systemctl disable isidore-bridge isidore-tmux'
```

**Step 2: Rename Linux user + home directory**
```bash
# Must run as root/openclaw since isidore can't rename itself while logged in
ssh vps 'sudo usermod -l isidore_cloud isidore'
ssh vps 'sudo groupmod -n isidore_cloud isidore'
ssh vps 'sudo usermod -d /home/isidore_cloud -m isidore_cloud'
```

**Step 3: Update sudoers**
```bash
ssh vps 'echo "isidore_cloud ALL=(ALL) NOPASSWD:ALL" | sudo tee /etc/sudoers.d/isidore_cloud'
ssh vps 'sudo rm /etc/sudoers.d/isidore'
```

**Step 4: Update sshd_config AllowUsers**
```bash
ssh vps 'sudo sed -i "s/isidore/isidore_cloud/g" /etc/ssh/sshd_config'
ssh vps 'sudo systemctl restart sshd'
```

**Step 5: Move config directory**
```bash
# After SSH alias is updated (Step 6 below)
ssh isidore_cloud 'mv ~/.config/isidore ~/.config/isidore_cloud'
```

### Local-Side Changes

**Step 6: SSH config** (`~/.ssh/config`)
```diff
-Host isidore
+Host isidore_cloud
     HostName 213.199.32.18
-    User isidore
+    User isidore_cloud
     Port 22
-    IdentityFile ~/.ssh/id_ed25519_isidore
+    IdentityFile ~/.ssh/id_ed25519_isidore_cloud
     IdentitiesOnly yes
```

**Step 7: SSH key rename** (content unchanged, just filenames)
```bash
mv ~/.ssh/id_ed25519_isidore ~/.ssh/id_ed25519_isidore_cloud
mv ~/.ssh/id_ed25519_isidore.pub ~/.ssh/id_ed25519_isidore_cloud.pub
```

### Project File Changes (200+ references)

All files in `/home/mj/projects/my-pai-cloud-solution/`:

**File renames:**
- `systemd/isidore-bridge.service` → `systemd/isidore-cloud-bridge.service`
- `systemd/isidore-tmux.service` → `systemd/isidore-cloud-tmux.service`
- `src/isidore-session.ts` → `src/isidore-cloud-session.ts`

**Content updates (search-replace across all files):**

| Pattern | Replacement | Files affected |
|---------|-------------|----------------|
| `/home/isidore/` | `/home/isidore_cloud/` | All scripts, systemd, bridge.env.example, config |
| `User=isidore` | `User=isidore_cloud` | systemd services |
| `Group=isidore` | `Group=isidore_cloud` | systemd services |
| `VPS_HOST="isidore"` | `VPS_HOST="isidore_cloud"` | scripts/deploy.sh |
| `ssh isidore` / `isidore@` | `ssh isidore_cloud` / `isidore_cloud@` | scripts, docs |
| `tmux.*-s isidore` | `tmux.*-s isidore_cloud` | systemd/isidore-cloud-tmux.service |
| `tmux.*-t isidore` | `tmux.*-t isidore_cloud` | systemd/isidore-cloud-tmux.service |
| `SyslogIdentifier=isidore-bridge` | `SyslogIdentifier=isidore-cloud-bridge` | systemd service |
| `.config/isidore/` | `.config/isidore_cloud/` | scripts, systemd, env |
| `isidore-session` | `isidore-cloud-session` | deploy.sh, source file |
| `id_ed25519_isidore` | `id_ed25519_isidore_cloud` | scripts/deploy-key.sh |
| `isidore-bridge` | `isidore-cloud-bridge` | all systemd references |
| `isidore-tmux` | `isidore-cloud-tmux` | all systemd references |

**Identity update in `config/vps-settings.json`:**
```diff
  "daidentity": {
-   "name": "Isidore",
-   "displayName": "ISIDORE"
+   "name": "Isidore Cloud",
+   "displayName": "ISIDORE CLOUD"
  }
```

**Documentation updates:** CLAUDE.md, README.md, MEMORY.md, Plans/*.md — update all references.

### Deploy Renamed Services

```bash
# After all file renames/edits done locally:
rsync -avz -e "ssh -i ~/.ssh/id_ed25519_isidore_cloud" \
  /home/mj/projects/my-pai-cloud-solution/ \
  isidore_cloud:~/my-pai-cloud-solution/ \
  --exclude='node_modules/' --exclude='.git/' --exclude='*.env'

# Deploy new systemd services
ssh isidore_cloud 'sudo cp ~/my-pai-cloud-solution/systemd/isidore-cloud-bridge.service /etc/systemd/system/ && \
  sudo cp ~/my-pai-cloud-solution/systemd/isidore-cloud-tmux.service /etc/systemd/system/ && \
  sudo rm -f /etc/systemd/system/isidore-bridge.service /etc/systemd/system/isidore-tmux.service && \
  sudo systemctl daemon-reload && \
  sudo systemctl enable --now isidore-cloud-bridge isidore-cloud-tmux'

# Update crontab paths
ssh isidore_cloud '(crontab -l 2>/dev/null | sed "s|/home/isidore/|/home/isidore_cloud/|g") | crontab -'

# Deploy PAI settings
rsync -avz -e "ssh -i ~/.ssh/id_ed25519_isidore_cloud" \
  /home/mj/projects/my-pai-cloud-solution/config/vps-settings.json \
  isidore_cloud:~/.claude/settings.json

# Update bridge.env paths
ssh isidore_cloud 'sed -i "s|/home/isidore/|/home/isidore_cloud/|g" ~/.config/isidore_cloud/bridge.env'
```

---

## Part 2: Knowledge Sync Architecture

### What "The Same Person" Means in Practice

Claude Code is stateless — every session starts fresh, loading context from files. "Knowledge" = files on disk. Syncing knowledge = syncing files.

**The challenge:** Local WSL2 isn't always on. VPS is always on. Neither can reliably reach the other on demand. We need an intermediary that's always available → **GitHub** (a private repo).

### Knowledge Classification

```
~/.claude/
├── skills/PAI/USER/          SHARED ──────── One identity, one user profile
│   ├── ABOUTME.md                            Personality, preferences, context
│   ├── AISTEERINGRULES.md                    Behavioral rules
│   ├── PROJECTS/PROJECTS.md                  Project registry
│   ├── TELOS/                                Life goals, challenges
│   ├── CONTACTS.md                           People knowledge
│   ├── TECHSTACKPREFERENCES.md               Tech preferences
│   └── DEFINITIONS.md                        Terminology
│
├── skills/PAI/               SHARED ──────── Same skill set (already Git-managed)
│   ├── SKILL.md, Components/, Hooks/
│   └── Tools/, Workflows/
│
├── MEMORY/
│   ├── RELATIONSHIP/         SHARED ──────── Same relationship with Marius
│   │   └── 2026-02/*.md                      Daily interaction notes
│   │
│   ├── LEARNING/             SHARED ──────── Same accumulated knowledge
│   │   ├── SYSTEM/                           Infrastructure learnings
│   │   ├── ALGORITHM/                        Task execution learnings
│   │   ├── SIGNALS/ratings.jsonl             User satisfaction data
│   │   └── FAILURES/                         Failure mode documentation
│   │
│   ├── STATE/                LOCAL ONLY ──── Different active sessions
│   ├── VOICE/                LOCAL ONLY ──── Voice hardware is local-only
│   ├── SESSIONS/             LOCAL ONLY ──── Session history per environment
│   └── WORK/                 PARTIAL ─────── Artifacts shared, state local
│
├── settings.json             DIVERGENT ───── Different env paths, hooks subset
├── CLAUDE.local.md           LOCAL ONLY ──── Environment-specific continuity
├── hooks/                    SHARED ──────── Same hook behavior (already Git-managed)
└── projects/                 LOCAL ONLY ──── Different project bindings
```

### Sync Mechanism: Private GitHub Repo + PAI Hooks

**Architecture:**

```
     Local Isidore (WSL2)              Isidore Cloud (VPS)
     ┌──────────────────┐              ┌──────────────────┐
     │ ~/.claude/MEMORY/ │              │ ~/.claude/MEMORY/ │
     │  RELATIONSHIP/    │              │  RELATIONSHIP/    │
     │  LEARNING/        │              │  LEARNING/        │
     │  ...              │              │  ...              │
     └────────┬─────────┘              └────────┬─────────┘
              │                                 │
              │ SessionEnd hook:                │ SessionEnd hook:
              │ copy → commit → push            │ copy → commit → push
              │                                 │
              ▼                                 ▼
     ┌──────────────────┐              ┌──────────────────┐
     │ ~/pai-knowledge/  │              │ ~/pai-knowledge/  │
     │ (Git repo clone)  │◄──── GitHub ────►│ (Git repo clone)  │
     └────────┬─────────┘   (private)  └────────┬─────────┘
              │                                 │
              │ SessionStart hook:              │ SessionStart hook:
              │ pull → copy to MEMORY           │ pull → copy to MEMORY
              ▲                                 ▲
```

**The `pai-knowledge` repo** (`mj-deving/pai-knowledge`, private):
```
pai-knowledge/
├── USER/                    # Mirror of skills/PAI/USER/
│   ├── ABOUTME.md
│   ├── AISTEERINGRULES.md
│   ├── CONTACTS.md
│   ├── PROJECTS/
│   ├── TELOS/
│   └── ...
├── RELATIONSHIP/            # Daily notes (append-only per day)
│   └── 2026-02/
│       ├── 2026-02-25.md
│       └── 2026-02-26.md
├── LEARNING/                # Accumulated learnings (append-only JSONL)
│   ├── SYSTEM/
│   ├── ALGORITHM/
│   ├── SIGNALS/
│   └── FAILURES/
├── WORK-ARTIFACTS/          # Shared PRDs and threads (no ISC state)
│   └── {project-slug}/
│       └── PRD-*.md
└── .sync-meta.json          # Last sync timestamps per instance
```

### Hook-Based Auto-Sync

**New hook: `KnowledgeSync.hook.ts`**

Fires at **SessionEnd** (after RelationshipMemory and WorkCompletionLearning have written):
```
1. cd ~/pai-knowledge
2. git pull --rebase (get other instance's changes)
3. Copy from ~/.claude/MEMORY/{RELATIONSHIP,LEARNING} → repo
4. Copy from ~/.claude/skills/PAI/USER/ → repo/USER/
5. git add -A
6. If changes: git commit -m "sync: {hostname} {timestamp}" && git push
```

Fires at **SessionStart** (via LoadContext or a new KnowledgePull hook):
```
1. cd ~/pai-knowledge
2. git pull
3. Copy from repo/RELATIONSHIP → ~/.claude/MEMORY/RELATIONSHIP/
4. Copy from repo/LEARNING → ~/.claude/MEMORY/LEARNING/
5. Copy from repo/USER → ~/.claude/skills/PAI/USER/
```

**Why this works:**
- **No conflicts:** RELATIONSHIP files are dated (`2026-02-26.md`). If both instances write to the same day, Git auto-merges (both append). LEARNING is JSONL (append-only lines). USER files are edited by one instance at a time.
- **Offline tolerance:** If local is off, VPS pushes to GitHub. When local starts a session, it pulls. No missed data.
- **No manual intervention:** Hooks fire automatically on every session start/end.
- **Auditable:** Full Git history shows what changed, when, from which instance.

### Conflict Handling

| Data type | Conflict scenario | Resolution |
|-----------|------------------|------------|
| RELATIONSHIP daily notes | Both append to same day file | Git auto-merge (both are appends at end of file) |
| LEARNING JSONL | Both append lines | Git auto-merge (different lines appended) |
| USER profile files | Both edit same file | Rare. Git conflict → manual resolve. Mitigate: local is authoritative for USER edits |
| PRD artifacts | Both edit same PRD | Rare. Use Git conflict resolution. |

### What Syncs vs What Doesn't

**Syncs automatically (via hooks + Git):**
- Relationship notes → both instances know about past interactions
- Learning data → mistakes learned on VPS benefit local and vice versa
- User profile → preferences stay consistent
- Work artifacts (PRDs) → both can continue each other's work

**Does NOT sync (by design):**
- Active session context (each has its own conversation)
- CLAUDE.local.md (environment-specific session continuity)
- settings.json (different paths, different hook subsets)
- STATE/ (session pointers, caches)
- VOICE/ (local hardware only)
- Per-project MEMORY.md in `~/.claude/projects/` (path-bound, different on each machine)

**Syncs via separate mechanism (Git repos):**
- Project code → standard GitHub workflow (clone, commit, push, pull)
- Both instances work on the same repos, coordinate via Git

### Practical Sync Latency

| Scenario | Latency |
|----------|---------|
| Chat with local Isidore, then message Cloud via Telegram | Next Cloud session start pulls latest (seconds) |
| Cloud learns something via Telegram, then local session | Next local session start pulls latest (seconds) |
| Both active simultaneously | Changes sync at next session boundary (session end → push, other's session start → pull) |

**Worst case:** If both are in active sessions simultaneously and one finishes before the other pulls, there's a window where knowledge diverges. This is acceptable — the next session boundary resolves it.

### Setup Steps for Sync

1. Create private repo `mj-deving/pai-knowledge` on GitHub
2. Clone on local: `~/pai-knowledge/`
3. Clone on VPS: `/home/isidore_cloud/pai-knowledge/`
4. VPS needs GitHub auth (deploy key or SSH key with repo access)
5. Write `KnowledgeSync.hook.ts` (SessionEnd push)
6. Write `KnowledgePull.hook.ts` or extend `LoadContext.hook.ts` (SessionStart pull)
7. Add hooks to both `settings.json` (local) and `config/vps-settings.json`
8. Initial seed: copy current local MEMORY data into repo, push
9. VPS pulls, populating its MEMORY from the shared repo

### Honest Limitations

- **Live conversation context doesn't sync.** If you're mid-conversation with local Isidore about a complex topic, Cloud Isidore won't have that context until the session ends and syncs. This is fundamental — each instance has its own context window.
- **Simultaneous edits to the same USER file could conflict.** Mitigate: treat local as authoritative for USER/ edits. Cloud should rarely modify user profile.
- **The VPS needs GitHub access.** Either a deploy key (repo-scoped) or the isidore_cloud user's SSH key added to GitHub.
- **Hook failures are silent.** If a sync push/pull fails (network issue), the session still works — it just doesn't sync. Next successful sync catches up.

---

## Execution Order

1. **Stop VPS services** (bridge + tmux)
2. **Rename Linux user** (`isidore` → `isidore_cloud`, move home dir)
3. **Update VPS system config** (sudoers, sshd_config)
4. **Rename local SSH key files** + update `~/.ssh/config`
5. **Rename project files** (systemd services, source file)
6. **Update all project file contents** (200+ path references)
7. **Deploy renamed project** to VPS
8. **Install new systemd services**, remove old ones
9. **Update crontab** paths
10. **Update bridge.env** paths
11. **Run initial knowledge push** (local → cloud)
12. **Start services**, verify everything works

## Critical Files to Modify

**Rename (file-level):**
- `systemd/isidore-bridge.service` → `systemd/isidore-cloud-bridge.service`
- `systemd/isidore-tmux.service` → `systemd/isidore-cloud-tmux.service`
- `src/isidore-session.ts` → `src/isidore-cloud-session.ts`

**Edit (content):**
- `systemd/isidore-cloud-bridge.service` — all paths, user, group, syslog
- `systemd/isidore-cloud-tmux.service` — all paths, user, group, tmux name
- `scripts/deploy.sh` — VPS_HOST, all paths, service names
- `scripts/deploy-key.sh` — key filename, user references
- `scripts/setup-vps.sh` — username, all paths
- `scripts/auth-health-check.sh` — all paths
- `scripts/run-task.sh` — all paths
- `src/isidore-cloud-session.ts` — comments/usage string
- `bridge.env.example` — all paths
- `config/vps-settings.json` — PAI_DIR, daidentity
- `CLAUDE.md` — project structure, references
- `README.md` — all references
- `Plans/jiggly-swimming-pnueli.md` — all references (60+)

**New file:**
- `scripts/sync-knowledge.sh` — bidirectional knowledge sync

**Local (outside project):**
- `~/.ssh/config` — Host, User, IdentityFile
- `~/.ssh/id_ed25519_isidore` → rename to `id_ed25519_isidore_cloud`
- `~/.ssh/id_ed25519_isidore.pub` → rename to `id_ed25519_isidore_cloud.pub`
- MEMORY.md — update all VPS references

## Verification

### Part 1: Naming Rename
1. **SSH works:** `ssh isidore_cloud 'whoami'` returns `isidore_cloud`
2. **sudo works:** `ssh isidore_cloud 'sudo whoami'` returns `root`
3. **Bridge running:** `ssh isidore_cloud 'sudo systemctl status isidore-cloud-bridge'` shows active
4. **tmux running:** `ssh isidore_cloud 'sudo systemctl status isidore-cloud-tmux'` shows active
5. **Telegram works:** Send message to bot, get response
6. **Identity correct:** Cloud response identifies as "Isidore Cloud"
7. **Gregor unaffected:** `ssh vps 'sudo systemctl status openclaw'` shows active
8. **Old user gone:** `ssh vps 'id isidore'` returns "no such user"
9. **Old services gone:** No `isidore-bridge` or `isidore-tmux` in systemctl

### Part 2: Knowledge Sync
10. **Repo exists:** `gh repo view mj-deving/pai-knowledge` shows private repo
11. **Cloned on both:** Local `~/pai-knowledge/.git` and VPS `~/pai-knowledge/.git` exist
12. **VPS GitHub access:** `ssh isidore_cloud 'cd ~/pai-knowledge && git pull'` succeeds
13. **SessionEnd sync:** After a local session, `cd ~/pai-knowledge && git log --oneline -1` shows sync commit
14. **SessionStart pull:** After Cloud session start, RELATIONSHIP files match local
15. **Bidirectional:** Create a note on VPS via Telegram, verify it appears locally after pull
