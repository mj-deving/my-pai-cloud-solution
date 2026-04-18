---
summary: "Operator runbook: enable the Haiku importance rescorer systemd timer (Move 3)"
read_when: ["importance scorer", "haiku rescore", "move 3", "memory.db rescoring", "runbook"]
---

# Runbook — Haiku importance rescorer

Move 3 of bridge retirement (beads `my-pai-cloud-solution-9xj`).

The Move 1 Stop hook writes a heuristic importance score on every turn. This runbook enables Haiku-based rescoring so memory retrieval reflects real turn value, not just tool-use signal.

## What it does

- `scripts/rescore-episodes.ts` queries episodes whose `metadata.scorer_version` is missing or does not equal `SCORER_PROMPT_VERSION`
- Calls `HaikuScorer` (direct Anthropic API call, no SDK) to get a 1-10 integer
- Updates `importance` and stamps `metadata.scorer_version = "v1.0.0"` so the episode is skipped on subsequent runs
- systemd timer fires every 15 minutes, processing up to 50 episodes per run

## Prerequisites

- `ANTHROPIC_API_KEY` set in `/home/isidore_cloud/.config/isidore_cloud/bridge.env`
- `bun` available at `/home/isidore_cloud/.bun/bin/bun`
- Move 1 Stop hook already writing episodes with heuristic scores (confirmed on main)

## Step 1 — Add the API key

```bash
ssh isidore_cloud 'grep ANTHROPIC_API_KEY ~/.config/isidore_cloud/bridge.env'
# If missing:
ssh isidore_cloud 'echo "ANTHROPIC_API_KEY=sk-ant-..." >> ~/.config/isidore_cloud/bridge.env'
ssh isidore_cloud 'chmod 600 ~/.config/isidore_cloud/bridge.env'
```

## Step 2 — Dry-run first

Before enabling the timer, verify the CLI finds un-versioned episodes and prints what it would rescore:

```bash
ssh isidore_cloud 'cd projects/my-pai-cloud-solution && bun run scripts/rescore-episodes.ts --dry-run --limit 10'
```

Expected output: a handful of `[rescore] DRY episode <id>` lines and a summary.

## Security note — env files

`bridge.env` holds secrets (API key, Telegram token). Keep it `chmod 600`, owned by `isidore_cloud`. Do NOT copy secrets into `/etc/isidore-cloud/notify/*.env` — those files are read by the notify service template and live under `/etc` with more permissive defaults. Only non-secret values (prompts, shell commands) belong there.

## Step 3 — Install systemd units

```bash
cd projects/my-pai-cloud-solution
sudo cp deploy/systemd/isidore-cloud-rescorer.service.example \
  /etc/systemd/system/isidore-cloud-rescorer.service
sudo cp deploy/systemd/isidore-cloud-rescorer.timer.example \
  /etc/systemd/system/isidore-cloud-rescorer.timer
sudo systemctl daemon-reload
sudo systemctl enable --now isidore-cloud-rescorer.timer
```

## Step 4 — Verify

```bash
systemctl list-timers isidore-cloud-rescorer.timer
sudo journalctl -u isidore-cloud-rescorer.service --since '1 hour ago'
```

Expected: log lines of the form `[rescore] episode <id> → <score>` followed by a `[rescore] done: seen=N updated=M ...` summary per run.

## Step 5 — Sanity-check scoring distribution

After a few hours, inspect the distribution to make sure Haiku isn't pegging everything at 5:

```bash
ssh isidore_cloud 'bun -e "
  const { Database } = require(\"bun:sqlite\");
  const db = new Database(\"/home/isidore_cloud/.claude/data/memory.db\", { readonly: true });
  const rows = db.query(\"SELECT importance, COUNT(*) AS n FROM episodes WHERE json_extract(metadata, \x27\$.scorer_version\x27) = \x27v1.0.0\x27 GROUP BY importance ORDER BY importance\").all();
  console.log(rows);
"'
```

## Rollback

```bash
sudo systemctl disable --now isidore-cloud-rescorer.timer
sudo rm /etc/systemd/system/isidore-cloud-rescorer.{service,timer}
sudo systemctl daemon-reload
```

The heuristic `importance` values written by the Stop hook remain intact; only the Haiku-sourced re-scores are frozen at their last update.

## Prompt version bumps

If you edit `SYSTEM_PROMPT` in `src/hooks/importance-scorer.ts`, also bump `SCORER_PROMPT_VERSION` (e.g. `v1.0.0` → `v1.1.0`). On the next timer tick every episode becomes eligible for rescoring again.
