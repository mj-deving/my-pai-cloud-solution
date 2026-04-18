---
summary: "Operator runbook: migrate bridge Scheduler schedules to systemd timers + notify.sh"
read_when: ["scheduler migration", "systemd timers", "notify.sh", "move 2", "runbook", "cron"]
---

# Runbook — Scheduler → systemd timers

Move 2 of bridge retirement (beads `my-pai-cloud-solution-679`).

The bridge's `src/scheduler.ts` keeps a SQLite table of cron-like jobs and emits pipeline task JSON on tick. After Move 2 completes, systemd timers run `scripts/notify.sh` directly (for notification-style jobs) or invoke `claude -p "<prompt>"` (for agent-task jobs).

## Prerequisites

- `scripts/notify.sh` exists and is executable (Move 2, already landed)
- `deploy/systemd/isidore-cloud-notify@.service.example` + `.timer.example` copied to the VPS (`/etc/systemd/system/`, stripped of `.example`)
- `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` present in `/home/isidore_cloud/.config/isidore_cloud/bridge.env`
- `sudo` access on the VPS

## Step 1 — Inventory current schedules

On the VPS:

```bash
ssh isidore_cloud 'bun -e "
  const { Database } = require(\"bun:sqlite\");
  const db = new Database(process.env.HOME + \"/.config/isidore_cloud/scheduler.db\", { readonly: true });
  const rows = db.query(\"SELECT name, cron_expr, enabled, task_template FROM schedules\").all();
  console.log(JSON.stringify(rows, null, 2));
"'
```

Export the list to `docs/runbooks/schedules-inventory-2026-04-18.json` so the audit is reproducible.

## Step 2 — Classify each schedule

For each schedule, decide which target it maps to:

| Task shape | systemd target | Env file contents |
|------------|---------------|-------------------|
| "Send me a message containing X" | `isidore-cloud-notify@<slug>` | `NOTIFY_CMD='echo "X"'` |
| "Run a shell command, send output" | `isidore-cloud-notify@<slug>` | `NOTIFY_CMD='<shell pipeline>'` |
| "Run a Claude prompt, send result" | `isidore-cloud-notify@<slug>` | `NOTIFY_CMD='claude -p "<prompt>" --output-format text'` |
| Multi-step pipeline task | Keep writing to `pipeline/tasks/` — separate timer, not `notify@` | — |

## Step 3 — Convert a cron expression to OnCalendar

systemd accepts richer schedules than cron. Common translations:

| Cron | OnCalendar |
|------|-----------|
| `0 8 * * *` | `*-*-* 08:00:00` |
| `0 */4 * * *` | `*-*-* 00/4:00:00` |
| `0 9 * * 1` | `Mon *-*-* 09:00:00` |
| `30 * * * *` | `*-*-* *:30:00` |

Validate with: `systemd-analyze calendar '*-*-* 08:00:00'`.

## Step 4 — Install a single schedule (per slug)

Ready-to-install artifacts for the three live bridge schedules are checked in under `deploy/systemd/notify/`:

| Slug | Env file | Timer drop-in | Original cron |
|------|----------|---------------|---------------|
| `daily-synthesis` | `daily-synthesis.env.example` | `daily-synthesis.conf.example` | `0 2 * * *` |
| `weekly-review` | `weekly-review.env.example` | `weekly-review.conf.example` | `0 3 * * 0` |
| `daily-memory` | `daily-memory.env.example` | `daily-memory.conf.example` | `55 22 * * *` |

Install (per slug, `SLUG` picked from the table above):

```bash
SLUG=daily-synthesis  # or weekly-review, daily-memory

# 1. Env file (NOTIFY_CMD)
sudo mkdir -p /etc/isidore-cloud/notify
sudo cp deploy/systemd/notify/${SLUG}.env.example \
  /etc/isidore-cloud/notify/${SLUG}.env

# 2. Timer drop-in (OnCalendar override)
sudo mkdir -p /etc/systemd/system/isidore-cloud-notify@${SLUG}.timer.d
sudo cp deploy/systemd/notify/${SLUG}.conf.example \
  /etc/systemd/system/isidore-cloud-notify@${SLUG}.timer.d/override.conf

# 3. Enable + start
sudo systemctl daemon-reload
sudo systemctl enable --now isidore-cloud-notify@${SLUG}.timer

# 4. Verify
systemctl list-timers isidore-cloud-notify@${SLUG}.timer
sudo journalctl -u isidore-cloud-notify@${SLUG}.service -n 20
```

**One-off slug (not in the table above):** follow the same pattern with a custom env file and drop-in, or omit the drop-in to accept the default `08:00` timer schedule.

### Note on claude CLI under systemd

The three built-in schedules run `claude -p "<prompt>" --output-format text`. This requires the Claude CLI to be authenticated as the `isidore_cloud` user. Validate before enabling:

```bash
sudo -u isidore_cloud claude auth status
# If not logged in:
sudo -u isidore_cloud -i claude auth login
```

## Step 5 — Parity check before retiring the bridge Scheduler

Run BOTH the bridge Scheduler and the systemd timers for ≥ 48 hours. Compare delivered notifications:

```bash
# Bridge-emitted episodes (source tagged 'telegram' + scheduled markers in metadata)
bun -e "
  const { Database } = require('bun:sqlite');
  const db = new Database('data/memory.db', { readonly: true });
  const bridgeJobs = db.query(\"SELECT timestamp, content FROM episodes WHERE metadata LIKE '%scheduled%' ORDER BY timestamp DESC LIMIT 20\").all();
  console.log(bridgeJobs);
"

# systemd-timer journal
sudo journalctl -u 'isidore-cloud-notify@*.service' --since '48 hours ago' | grep 'Deactivated successfully'
```

If every scheduled window produced exactly one notification from each source, parity is confirmed.

## Step 6 — Disable the bridge Scheduler

```bash
ssh isidore_cloud 'grep SCHEDULER_ENABLED ~/.config/isidore_cloud/bridge.env'
# If set to 1, flip it:
ssh isidore_cloud 'sed -i "s/^SCHEDULER_ENABLED=1/SCHEDULER_ENABLED=0/" ~/.config/isidore_cloud/bridge.env'
ssh isidore_cloud 'sudo systemctl restart isidore-cloud-bridge'
```

At this point the bridge is down one responsibility. Move 4 (Grammy shutdown) still pending.

## Rollback

Each step is independently reversible:

- Step 4 rollback: `sudo systemctl disable --now isidore-cloud-notify@<slug>.timer`
- Step 6 rollback: flip `SCHEDULER_ENABLED` back to `1` and restart the bridge

There is no destructive action in this runbook — scheduler DB is untouched, bridge code is untouched.
