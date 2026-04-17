---
name: deploy
description: "Self-deploy latest main to VPS and restart the bridge. USE WHEN user says /deploy, ship to VPS, push to prod, restart bridge, deploy updates."
user_invocable: true
trigger: /deploy
---

# /deploy — Self-Deploy to VPS

Deploys the latest `origin/main` to the VPS project dir and restarts `isidore-cloud-bridge`. Equivalent to the bridge `/deploy` command, but invokable from any Claude session.

## Preconditions

- SSH access to `isidore_cloud` alias
- `origin/main` is the head you want to deploy (run `/sync` first if uncommitted)
- Passwordless sudo for `systemctl restart isidore-cloud-bridge` is configured (see `/etc/sudoers.d/isidore-cloud-deploy`)

## Workflow

### 1. Check for updates

```bash
ssh isidore_cloud 'bash /home/isidore_cloud/projects/my-pai-cloud-solution/scripts/self-deploy.sh --check'
```

Output one of:
- `ALREADY_CURRENT` → nothing to do; report and stop.
- `DIRTY_FILES\n<files>\nEND_DIRTY\nPENDING\n<commits>` → VPS has uncommitted files or ahead commits that would be overwritten. Ask user to either `/sync` first or re-run `/deploy force`.

### 2. Run the deploy (unless `--check` said current)

If the user passes `force`, or the check returned no dirty files:

```bash
ssh isidore_cloud 'bash /home/isidore_cloud/projects/my-pai-cloud-solution/scripts/self-deploy.sh'
```

Timeout: 60s. Capture stdout + stderr.

Parse stdout:
- `UPDATED\n<commits>\n[DEPS_UPDATED]` → success. Report commits to user. If `DEPS_UPDATED` present, note that `bun install` ran.
- non-zero exit → deploy failed; report stderr (first 500 chars).

### 3. Restart the bridge (if deploy succeeded)

The `self-deploy.sh` script does NOT restart — that's our job so the caller can surface the deploy summary before the bridge process is killed.

```bash
ssh isidore_cloud 'sudo systemctl restart isidore-cloud-bridge'
```

When invoked from the bridge itself (bridge `/deploy` command), the bridge detaches the restart so its final Telegram reply can flush. From a Channels session that's not driving the bridge, no detachment is needed.

### 4. Verify health

After restart, tail journal briefly to confirm clean startup:

```bash
ssh isidore_cloud 'sudo journalctl -u isidore-cloud-bridge -n 20 --no-pager' | tail -20
```

Look for:
- Bridge boot banner (e.g. "Isidore Cloud Bridge started")
- No `error`, `ECONNREFUSED`, or unhandled-rejection lines
- Service `active (running)` in: `ssh isidore_cloud 'sudo systemctl is-active isidore-cloud-bridge'`

## Verification

Report to user:
- Commits deployed (list from UPDATED block)
- Whether dependencies updated (DEPS_UPDATED flag)
- Service state (`active` / `failed`)
- First error from journal if any

## Edge cases

- **VPS unreachable:** ssh times out → report and stop. No partial state.
- **sudo fails on restart:** check `/etc/sudoers.d/isidore-cloud-deploy` was installed by `scripts/deploy.sh` step 8b.
- **self-deploy.sh missing on VPS:** run `bash scripts/deploy.sh` locally first to sync scripts.
- **Concurrent deploys:** the script uses git fetch + reset — if two run concurrently, last-write wins. Avoid by serializing user requests.

## Source-of-truth

- Bridge implementation: `src/telegram.ts:910-1008`
- Deploy script: `scripts/self-deploy.sh` on VPS (installed by `scripts/deploy.sh`)
- Sudoers setup: `scripts/deploy.sh:119`

## Related skills

- `/sync` — push changes before deploying
- `/review` — review branch before merging and deploying
