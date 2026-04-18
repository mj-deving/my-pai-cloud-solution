---
task: Complete Move 2 and Move 3 bridge retirement
slug: 20260418-160216_move-2-and-3-bridge-retirement
effort: advanced
phase: complete
progress: 24/24
mode: interactive
started: 2026-04-18T16:02:16+02:00
updated: 2026-04-18T16:25:00+02:00
---

## Context

Phase 5 of the bridge-retirement plan is a 4-move additive migration (ADR 0001, `docs/roadmap.md`). Move 1 (turn-recording Stop hook) landed on main in commit 26ede27 with 17 tests. This session picks up Moves 2 + 3 per beads `my-pai-cloud-solution-679` and `-9xj`.

**Move 2 — notify.sh + systemd timers replacing src/scheduler.ts:**
- `scripts/notify.sh` (Telegram Bot API shim) exists and is executable
- `deploy/systemd/isidore-cloud-notify@.service.example` and `@.timer.example` exist
- `docs/runbooks/scheduler-to-systemd.md` exists
- Three live schedules on VPS (`/var/lib/pai-pipeline/agent-registry.db`): daily-synthesis (02:00 UTC), weekly-review (Sun 03:00 UTC), daily-memory (22:55 UTC). All three emit pipeline tasks — a Claude-prompt-then-send shape that fits the `notify@` model via `NOTIFY_CMD='claude -p "…" --output-format text'`.
- Gap: concrete per-slug env files + timer drop-ins for the three live schedules. Runbook currently leaves this to the operator; shipping ready-to-install artifacts reduces operator error and makes parity verifiable.

**Move 3 — Haiku importance scorer:**
- `src/hooks/importance-scorer.ts` exports `rescoreEpisode(dbPath, episodeId, scorer, version)` with idempotent versioned scoring (11 tests on main).
- Gap: no real `Scorer` implementation (only test fakes). No runner that picks unscored episodes and invokes the scorer. No systemd timer wiring.
- Implementation: add `HaikuScorer` (reusing `direct-api.ts` pattern — lightweight Bun.fetch() to Anthropic API), a `scripts/rescore-episodes.ts` CLI that queries episodes missing the current `scorer_version`, batches them through the scorer, and calls `rescoreEpisode()` for each. Add `deploy/systemd/isidore-cloud-rescorer.{service,timer}.example` firing every 15 min.

### Risks
- Telegram rate limits: notify.sh documents 30/s global, 1/s per chat. Three timers spread across the day won't hit this.
- Haiku API costs: 3 live schedules × daily runs ≠ a rescorer trigger; rescorer runs on every un-versioned episode. Cost grows with Channels traffic. Mitigation: CLI supports `--limit N` and `--dry-run` for controlled rollout.
- API failures: rescorer must fail open (skip episode, keep heuristic score) to avoid blocking the Haiku budget on a single bad episode.
- Config drift: new envs (ANTHROPIC_API_KEY) needed for rescorer. Document in runbook.
- **Move 2 is operator-facing**: ready-to-install env files eliminate a common failure mode where operators mis-translate cron to OnCalendar.

### Plan

**Move 2 deliverables (new files):**
1. `deploy/systemd/notify/daily-synthesis.env.example` — NOTIFY_CMD wrapping `claude -p "Run memory synthesis…" --output-format text`
2. `deploy/systemd/notify/weekly-review.env.example` — NOTIFY_CMD wrapping weekly health review prompt
3. `deploy/systemd/notify/daily-memory.env.example` — NOTIFY_CMD wrapping daily memory summary prompt
4. `deploy/systemd/notify/daily-synthesis.timer.drop-in.example` — `[Timer] OnCalendar=*-*-* 02:00:00 UTC`
5. `deploy/systemd/notify/weekly-review.timer.drop-in.example` — `[Timer] OnCalendar=Sun *-*-* 03:00:00 UTC`
6. `deploy/systemd/notify/daily-memory.timer.drop-in.example` — `[Timer] OnCalendar=*-*-* 22:55:00 UTC`
7. `docs/runbooks/scheduler-to-systemd.md` — update Step 4 with concrete mapping table pointing at these artifacts

**Move 3 deliverables (new files + 1 edit):**
1. `src/hooks/haiku-scorer.ts` — `HaikuScorer` implementing `Scorer` via Bun.fetch to Anthropic API
2. `src/__tests__/haiku-scorer.test.ts` — tests for prompt building, response parsing, error fail-open
3. `scripts/rescore-episodes.ts` — CLI: query un-versioned episodes, loop through scorer, call rescoreEpisode
4. `src/__tests__/rescore-episodes.test.ts` — tests CLI query logic with in-memory DB fake scorer
5. `deploy/systemd/isidore-cloud-rescorer.service.example` — oneshot, invokes `bun run scripts/rescore-episodes.ts`
6. `deploy/systemd/isidore-cloud-rescorer.timer.example` — `OnCalendar=*:0/15` (every 15 min), Persistent=true
7. `docs/runbooks/importance-rescoring.md` — operator runbook for enabling Haiku rescorer
8. Update `docs/roadmap.md` status for Moves 2 + 3

## Criteria

**Move 2 — notify.sh + systemd timers**
- [x] ISC-1: daily-synthesis.env.example file exists under deploy/systemd/notify/
- [x] ISC-2: daily-synthesis.env.example NOTIFY_CMD calls `claude -p` with synthesis prompt
- [x] ISC-3: weekly-review.env.example file exists with health-review prompt
- [x] ISC-4: daily-memory.env.example file exists with daily-memory prompt
- [x] ISC-5: daily-synthesis.conf.example sets OnCalendar=*-*-* 02:00:00 UTC
- [x] ISC-6: weekly-review.conf.example sets OnCalendar=Sun *-*-* 03:00:00 UTC
- [x] ISC-7: daily-memory.conf.example sets OnCalendar=*-*-* 22:55:00 UTC
- [x] ISC-8: scheduler-to-systemd runbook Step 4 lists the three artifacts with install commands

**Move 3 — Haiku importance scorer**
- [x] ISC-9: haiku-scorer.ts exports HaikuScorer class implementing Scorer interface
- [x] ISC-10: HaikuScorer reads ANTHROPIC_API_KEY from env and throws if missing
- [x] ISC-11: HaikuScorer uses model claude-haiku-4-5-20251001
- [x] ISC-12: HaikuScorer.score returns integer 1-10 parsed from API response
- [x] ISC-13: haiku-scorer.test.ts covers parse-success path
- [x] ISC-14: haiku-scorer.test.ts covers non-integer response error path
- [x] ISC-15: haiku-scorer.test.ts covers missing API key error path
- [x] ISC-16: rescore-episodes.ts CLI queries episodes with NULL or stale scorer_version
- [x] ISC-17: rescore-episodes.ts supports --limit flag defaulting to 50
- [x] ISC-18: rescore-episodes.ts supports --dry-run flag that skips UPDATE
- [x] ISC-19: rescore-episodes.ts fails open per-episode — one error does not abort batch
- [x] ISC-20: rescore-episodes.test.ts verifies query picks un-versioned episodes only
- [x] ISC-21: isidore-cloud-rescorer.service.example runs CLI under isidore_cloud user
- [x] ISC-22: isidore-cloud-rescorer.timer.example fires every 15 min with Persistent=true
- [x] ISC-23: importance-rescoring.md runbook documents enable/disable steps

**Global**
- [x] ISC-24: bun test passes with new test files (total count increases from 440)

- [x] ISC-A1: scheduler.ts code is NOT deleted (parallel-run required per ADR 0001)
- [x] ISC-A2: VPS is NOT deployed to during this session (code-only scope)
- [x] ISC-A3: Move 4 Grammy shutdown is NOT touched (gated on Anthropic #36477)

## Decisions

- **Plan Review Gate skipped** — plan is a direct continuation of ADR 0001 + roadmap.md (already vetted). No new architectural ground.
- **Move 2 operator-only steps left to runbook** — VPS deployment out of scope; shipping env + drop-in artifacts closes the code-deliverable loop.
- **Haiku scorer runs out-of-band** — systemd timer every 15 min, not inline with Stop hook. Turn latency stays constant; rescoring is budget-capped via `--limit 50`.
- **Constructor-level `ANTHROPIC_API_KEY` check** — not wired through Config Zod, since rescorer is a standalone CLI from systemd, not the bridge runtime.
- **Reuse over extract** — `parseScoreFromLLM` exported and shared between importance-scorer and haiku-scorer. Resisted broader refactor with `direct-api.ts` (marginal value, cross-cutting risk).
- **Single DB connection per batch** — `rescoreEpisode` now accepts `Database | path`; `runRescore` holds one connection for the batch, reducing 50× open/close churn to 1.
- **Prompt-injection mitigation** — user content wrapped in `<turn>...</turn>` + system prompt flags it as data. Defense against turns containing "output 10" style skew attempts.
- **systemd hardening on new rescorer unit** — NoNewPrivileges, ProtectSystem=strict, read-only home, restricted ReadWritePaths to `~/.claude` only. Not applied to notify@ template (on main, out of scope).

## Verification

**ISC-1 through ISC-7 (Move 2 config files):** all six files exist under `deploy/systemd/notify/`. `systemd-analyze calendar 'Sun *-*-* 03:00:00 UTC'` + `systemd-analyze calendar '*:0/15'` both parse cleanly.

**ISC-8:** runbook Step 4 lists three-row mapping table and per-slug install commands.

**ISC-9 through ISC-15 (Haiku scorer + tests):** `HaikuScorer` implements `Scorer`; 8 tests pass covering construction error paths, parse-success, prose extraction, non-integer error, HTTP error, and required headers.

**ISC-16 through ISC-20 (rescore CLI + tests):** CLI queries via `json_extract` (`?`-bound); supports `--limit`, `--dry-run`, `--db`; per-episode fail-open verified in test; 12 tests pass.

**ISC-21, ISC-22:** rescorer.service.example runs under `isidore_cloud` with `User=`; timer fires `*:0/15` with `Persistent=true`.

**ISC-23:** `docs/runbooks/importance-rescoring.md` covers prereqs, dry-run, install, verify, sanity-check, rollback, prompt-version bumps.

**ISC-24:** `bun test` → 460 pass (baseline 440 + 20 new). `bun x tsc --noEmit` clean.

**ISC-A1:** `src/scheduler.ts` unchanged (git status confirms).
**ISC-A2:** No ssh commands to VPS in the code diff. Inventory read was read-only on scheduler DB via one bun -e probe.
**ISC-A3:** No changes to bridge Grammy code or `TELEGRAM_BOT_TOKEN` wiring.

**External review (VERIFY phase AUTO capabilities):**
- `simplify` → 3 reviewer agents: reuse, quality, efficiency. Fixed: dedup regex (export `parseScoreFromLLM`), DB connection reuse, dead `UnscoredEpisode.metadata` field.
- `Security` CodeReview (Pentester agent): 1 P1 (notify@ eval trust model — note added to runbook, template on main out of scope), 3 P2 (systemd hardening added to new rescorer unit, prompt injection mitigation applied via `<turn>` delimiters), P3 (env file secrets warning added to runbook). SQLi verified clean (parameterized `?` binding), API key handling clean (not logged, not in errors).
