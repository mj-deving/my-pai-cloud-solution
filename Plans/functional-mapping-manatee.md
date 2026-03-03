# Cross-Instance E2E Testing Orchestration Plan

## Context

All bridge features (Phases 1-6D) are deployed. The overnight queue infrastructure exists on both sides but has never been tested end-to-end. Gregor's side believes `timeout_minutes` needs a bridge code fix, but **it's already implemented as a flat top-level field** (commit `ea3db06`). The actual blocker is confirming schema alignment, then running progressive tests: smoke → overnight PRDs → cron monitoring.

This plan covers **what Isidore does** (this repo, bridge-side) and provides **the complete prompt for Gregor's Claude instance** (OpenClaw side).

---

## Gregor Review Findings (Incorporated)

Gregor reviewed this plan and confirmed:
1. **Schema mismatch confirmed:** `pai-submit.sh:142-144` nests under `constraints` — needs fix to flat top-level
2. **`to` field discrepancy:** `pai-submit.sh:133` uses `"isidore-cloud"` (hyphen), bridge uses `"isidore_cloud"` (underscore). Bridge doesn't filter on `to`, so not breaking, but should align.
3. **Use scripts, not manual JSON:** Smoke tests should use `pai-submit.sh` after fix, not manual file writes. Ensures proper ID generation, permissions, consistent format.
4. **Plan strengths confirmed:** Sequencing, risk mitigations, read-only PRDs, serialization note, morning verification all approved.

---

## Sequencing

```
Step 1 (Schema clarification) ──┐
                                 ├──► Step 2 (Smoke tests) ──► Step 3 (Overnight PRDs)
Step 4 (Cron re-enable)  ───────┘
```

Steps 1 and 4 are independent and parallel. Step 2 requires Step 1 confirmed. Step 3 requires Step 2 PASS.

---

## Step 1: Fix Schema Mismatch (Gregor-Side Code Fix)

**Finding:** `timeout_minutes` and `max_turns` are flat top-level fields in `PipelineTask` (`src/pipeline.ts:34-35`). The bridge reads them at `pipeline.ts:437-438` and `pipeline.ts:419-420`. NOT nested under `constraints`.

**Gregor review confirmed:** `pai-submit.sh` line 142-144 currently nests these under `constraints`. Since `pai-overnight.sh` calls `pai-submit.sh` (line 391), both interactive and overnight submissions are affected.

**Isidore action:** Nothing. Bridge code is correct.
**Gregor action:**
1. Fix `pai-submit.sh` — move `timeout_minutes` and `max_turns` from `constraints` object to flat top-level fields
2. Deploy fixed script to VPS via `scp`

### `to` Field Clarification

**Answer:** The bridge **does not filter on the `to` field** — it processes any task file in `tasks/` regardless. The field is informational only. However, for consistency with the bridge's own `from: "isidore_cloud"` (underscore, `pipeline.ts:514`), Gregor should use `"to": "isidore_cloud"` (underscore). Current `pai-submit.sh` uses `"isidore-cloud"` (hyphen) — not breaking, but should be updated for consistency.

### Use `pai-submit.sh` for Smoke Tests

**Gregor's recommendation accepted:** After fixing `pai-submit.sh`, smoke tests should go through the script rather than manual JSON writes. This ensures proper task ID generation, file permissions (chmod 660), and consistent field format.

---

## Step 2: Smoke Tests

### Isidore Actions
1. Verify bridge is running: `ssh isidore_cloud 'sudo systemctl status isidore-cloud-bridge'`
2. Tail logs during test: `ssh isidore_cloud 'sudo journalctl -u isidore-cloud-bridge -f --since now'`
3. After results appear, verify in logs:
   - `[pipeline] Processing task smoke-timeout-001` (picked up)
   - `[pipeline] Result written: smoke-timeout-001.json (completed)`
   - `[pipeline] Task smoke-timeout-001 moved to ack/`
   - For second test: confirm `--max-turns 2` appears in spawn args

### Test Payloads (Gregor writes these)

**Smoke A** — `/var/lib/pai-pipeline/tasks/smoke-timeout-001.json`:
```json
{
  "id": "smoke-timeout-001",
  "from": "gregor",
  "to": "isidore_cloud",
  "timestamp": "<current ISO>",
  "type": "request",
  "priority": "normal",
  "mode": "async",
  "prompt": "What is 2 + 2? Reply with just the number.",
  "timeout_minutes": 2,
  "max_turns": 3
}
```

**Smoke B** (after A passes) — `/var/lib/pai-pipeline/tasks/smoke-maxturns-001.json`:
```json
{
  "id": "smoke-maxturns-001",
  "from": "gregor",
  "to": "isidore_cloud",
  "timestamp": "<current ISO>",
  "type": "request",
  "priority": "normal",
  "mode": "async",
  "prompt": "List all files in /var/lib/pai-pipeline/ and describe each subdirectory's purpose.",
  "timeout_minutes": 5,
  "max_turns": 2
}
```

### Pass Criteria
- Both `results/smoke-*.json` exist within 60s
- Both have `"status": "completed"`
- Both source files in `ack/`
- No errors in bridge logs

---

## Step 3: Overnight PRD Run (After Smoke Tests Pass)

### Isidore Pre-flight
1. Verify bridge healthy: `sudo systemctl status isidore-cloud-bridge`
2. Check no rate limiter cooldown active (bridge logs or `/pipeline` Telegram command)
3. Check free memory above 512MB threshold
4. Check no stale branch locks: `/branches` via Telegram
5. Verify Gregor's `pai-reverse-handler.sh` is active (PRD 3 may delegate back)

### PRD Payloads (Gregor submits sequentially, 10s apart)

**PRD 1** — `overnight-prd-001.json` (doc review, read-only, 30min timeout):
```json
{
  "id": "overnight-prd-001",
  "from": "gregor",
  "to": "isidore_cloud",
  "timestamp": "<current ISO>",
  "type": "request",
  "priority": "normal",
  "mode": "async",
  "project": "my-pai-cloud-solution",
  "prompt": "Review ARCHITECTURE.md for accuracy. Check that all module descriptions match the actual source code. List any discrepancies you find, with specific line references. Do not modify any files.",
  "timeout_minutes": 30,
  "max_turns": 15
}
```

**PRD 2** — `overnight-prd-002.json` (error analysis, read-only, 30min timeout):
```json
{
  "id": "overnight-prd-002",
  "from": "gregor",
  "to": "isidore_cloud",
  "timestamp": "<current ISO + 5min>",
  "type": "request",
  "priority": "normal",
  "mode": "async",
  "project": "my-pai-cloud-solution",
  "prompt": "Analyze the error handling patterns across all source files in src/. For each module, identify: (1) what errors are caught, (2) what errors could propagate uncaught, (3) whether the fail-open vs fail-closed strategy is consistent. Write a summary report.",
  "timeout_minutes": 30,
  "max_turns": 20
}
```

**PRD 3** — `overnight-prd-003.json` (orchestrated workflow, 15min timeout):
```json
{
  "id": "overnight-prd-003",
  "from": "gregor",
  "to": "isidore_cloud",
  "timestamp": "<current ISO + 10min>",
  "type": "orchestrate",
  "priority": "low",
  "mode": "async",
  "project": "my-pai-cloud-solution",
  "prompt": "Run bunx tsc --noEmit on the my-pai-cloud-solution project. If there are type errors, list them. Then verify the pipeline task and result JSON schemas are consistent between the ARCHITECTURE.md documentation and the actual TypeScript interfaces in pipeline.ts.",
  "timeout_minutes": 15,
  "max_turns": 10
}
```

### Result Expectations

| PRD | Result File | Type |
|-----|------------|------|
| 1 | `results/overnight-prd-001.json` | Direct pipeline result |
| 2 | `results/overnight-prd-002.json` | Direct pipeline result |
| 3 | `results/overnight-prd-003.json` | Initial dispatch result |
| 3 | `results/workflow-overnight-prd-003.json` | Workflow completion result (steps, timing) |

**Note:** PRD 3 (`type: "orchestrate"`) produces TWO result files. The initial dispatch runs Claude once (writes `overnight-prd-003.json`), then the orchestrator hook fires asynchronously and decomposes into a DAG workflow. When that workflow completes, it writes `workflow-overnight-prd-003.json`.

### Serialization Note
All 3 PRDs target `project: "my-pai-cloud-solution"`. The per-project lock in `pipeline.ts:85` (the `activeProjects` set) ensures only one runs at a time despite `PIPELINE_MAX_CONCURRENT=8`. Total runtime is additive — expect up to ~75 minutes for all three.

### Morning Verification (Isidore)
```bash
# Check results exist
ssh isidore_cloud 'ls -la /var/lib/pai-pipeline/results/overnight-prd-*.json /var/lib/pai-pipeline/results/workflow-overnight-prd-*.json'

# Check tasks acked
ssh isidore_cloud 'ls -la /var/lib/pai-pipeline/ack/overnight-prd-*.json'

# Check bridge logs for errors
ssh isidore_cloud 'sudo journalctl -u isidore-cloud-bridge --since "03:00" --until "06:00" --no-pager | grep -E "error|warn|cooldown|blocked"'

# Read result summaries
ssh isidore_cloud 'cat /var/lib/pai-pipeline/results/overnight-prd-001.json | jq .status'
ssh isidore_cloud 'cat /var/lib/pai-pipeline/results/overnight-prd-002.json | jq .status'
ssh isidore_cloud 'cat /var/lib/pai-pipeline/results/workflow-overnight-prd-003.json | jq .status'
```

---

## Step 4: Re-enable Pipeline-Check Cron

**Isidore action:** None — this is Gregor-side infrastructure.
**Gregor action:** Check `crontab -l`, find pipeline-check entry (ID `30195d7a`), re-enable if disabled, set `*/5` for overnight test, revert to `*/15` steady-state after.

---

## Risk Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Rate limiter trips during overnight | 60min cooldown blocks dispatch | Safe read-only prompts; sequential submission; 10s gaps |
| Verifier false-rejects valid results | Result marked error despite success | Consider `VERIFIER_ENABLED=0` for first run |
| Stale branch lock blocks checkout | Task fails to start | Check `/branches` before run; bridge cleans on restart |
| PRD 3 delegates to Gregor via reverse-pipeline | Gregor must pick up and respond | Verify `pai-reverse-handler.sh` active before run |
| Per-project lock serializes all 3 PRDs | ~75min total instead of ~30min parallel | Expected behavior; acceptable for first test |

---

## The Gregor Prompt

*Self-contained prompt to give to Gregor's Claude instance. Covers all 4 steps from his perspective.*

---

```
# Cross-Instance E2E Testing: Gregor's Instructions

You are working as the `openclaw` user on VPS 213.199.32.18. These are 4 sequential tasks for E2E testing of the Isidore Cloud pipeline.

## CRITICAL: Fix pai-submit.sh Schema (Do First)

You confirmed `pai-submit.sh` line 142-144 nests `timeout_minutes` and `max_turns` under `constraints`. The bridge expects them as FLAT top-level fields.

FIX REQUIRED in pai-submit.sh:
1. Move `timeout_minutes` and `max_turns` OUT of the `constraints` object to flat top-level fields
2. Change `"to": "isidore-cloud"` (line 133) to `"to": "isidore_cloud"` (underscore, matches bridge's own naming)
3. Since pai-overnight.sh calls pai-submit.sh (line 391), this fix covers both interactive and overnight paths
4. Deploy fixed script to VPS: scp pai-submit.sh openclaw@213.199.32.18:~/bin/

After fixing, verify by running: `pai-submit.sh --dry-run` (if supported) or by inspecting the generated JSON.

## Task 1: Smoke Test A (basic timeout) — USE pai-submit.sh

Use your fixed pai-submit.sh to submit (not manual JSON). The task should produce:

{
  "id": "smoke-timeout-001",
  "from": "gregor",
  "to": "isidore_cloud",
  "timestamp": "USE_CURRENT_ISO_TIME",
  "type": "request",
  "priority": "normal",
  "mode": "async",
  "prompt": "What is 2 + 2? Reply with just the number.",
  "timeout_minutes": 2,
  "max_turns": 3
}

Wait 60 seconds. Check:
- A result file exists in /var/lib/pai-pipeline/results/ matching the task filename
- Its "status" is "completed"
- The task file is in /var/lib/pai-pipeline/ack/

## Task 2: Smoke Test B (max-turns, run ONLY after Task 1 passes)

Use pai-submit.sh again. The task should produce:

{
  "id": "smoke-maxturns-001",
  "from": "gregor",
  "to": "isidore_cloud",
  "timestamp": "USE_CURRENT_ISO_TIME",
  "type": "request",
  "priority": "normal",
  "mode": "async",
  "prompt": "List all files in /var/lib/pai-pipeline/ and describe each subdirectory's purpose.",
  "timeout_minutes": 5,
  "max_turns": 2
}

Wait 120 seconds. Same verification as Task 1.

## Task 3: Overnight PRDs (run ONLY after both smoke tests PASS)

Submit these 3 files sequentially with 10-second gaps between each:

### PRD 1: overnight-prd-001.json
{
  "id": "overnight-prd-001",
  "from": "gregor",
  "to": "isidore_cloud",
  "timestamp": "USE_CURRENT_ISO_TIME",
  "type": "request",
  "priority": "normal",
  "mode": "async",
  "project": "my-pai-cloud-solution",
  "prompt": "Review ARCHITECTURE.md for accuracy. Check that all module descriptions match the actual source code. List any discrepancies you find, with specific line references. Do not modify any files.",
  "timeout_minutes": 30,
  "max_turns": 15
}

### PRD 2: overnight-prd-002.json
{
  "id": "overnight-prd-002",
  "from": "gregor",
  "to": "isidore_cloud",
  "timestamp": "USE_CURRENT_ISO_TIME",
  "type": "request",
  "priority": "normal",
  "mode": "async",
  "project": "my-pai-cloud-solution",
  "prompt": "Analyze the error handling patterns across all source files in src/. For each module, identify: (1) what errors are caught, (2) what errors could propagate uncaught, (3) whether the fail-open vs fail-closed strategy is consistent. Write a summary report.",
  "timeout_minutes": 30,
  "max_turns": 20
}

### PRD 3: overnight-prd-003.json (ORCHESTRATED — generates workflow)
{
  "id": "overnight-prd-003",
  "from": "gregor",
  "to": "isidore_cloud",
  "timestamp": "USE_CURRENT_ISO_TIME",
  "type": "orchestrate",
  "priority": "low",
  "mode": "async",
  "project": "my-pai-cloud-solution",
  "prompt": "Run bunx tsc --noEmit on the my-pai-cloud-solution project. If there are type errors, list them. Then verify the pipeline task and result JSON schemas are consistent between the ARCHITECTURE.md documentation and the actual TypeScript interfaces in pipeline.ts.",
  "timeout_minutes": 15,
  "max_turns": 10
}

NOTE: PRD 3 uses "type": "orchestrate" — Isidore's bridge will decompose it into a DAG workflow. It may delegate steps BACK TO YOU via /var/lib/pai-pipeline/reverse-tasks/. Make sure your pai-reverse-handler.sh is active.

Result files will appear at:
- results/overnight-prd-001.json
- results/overnight-prd-002.json
- results/overnight-prd-003.json (initial dispatch result)
- results/workflow-overnight-prd-003.json (workflow completion with step summaries)

All 3 PRDs target the same project so they run sequentially (per-project lock). Expect ~75 minutes total.

### Morning Verification
ls -la /var/lib/pai-pipeline/results/overnight-prd-*.json
ls -la /var/lib/pai-pipeline/results/workflow-overnight-prd-*.json
ls -la /var/lib/pai-pipeline/ack/overnight-prd-*.json

For each result file, check "status" is "completed".

## Task 4: Re-enable Pipeline-Check Cron

1. Run: crontab -l
2. Find the pipeline-check entry (ID 30195d7a or similar)
3. If disabled, re-enable it
4. Set to */5 for the overnight test period
5. Make sure the script sources bridge.env or uses full paths (cron has minimal PATH)
6. After overnight test succeeds, change to */15 for steady state

## Execution Order
1. Schema check (immediate)
2. Cron re-enable (parallel with schema check)
3. Smoke Test A (after schema confirmed)
4. Smoke Test B (after Smoke A passes)
5. Overnight PRDs (after both smoke tests pass)

Report results of each step before proceeding to the next.
```

---

## Verification (Full E2E)

After all steps complete, the system is validated when:
- [ ] Both smoke test results show `"status": "completed"`
- [ ] All 3 overnight PRD results exist with `"status": "completed"`
- [ ] Workflow completion result exists for PRD 3 with step summaries
- [ ] Bridge logs show no errors, no rate limiter pauses, no resource guard blocks
- [ ] Pipeline-check cron is active at `*/5` (test) or `*/15` (steady state)
- [ ] All task files moved to `ack/`

## Critical Files Reference

| File | Role |
|------|------|
| `src/pipeline.ts:34-35` | `timeout_minutes` and `max_turns` field definitions |
| `src/pipeline.ts:419-420` | `--max-turns` CLI arg construction |
| `src/pipeline.ts:436-440` | Per-task timeout override logic |
| `src/pipeline.ts:300-304` | Orchestrator hook for `type: "orchestrate"` |
| `src/orchestrator.ts:618` | Workflow result filename: `workflow-{originTaskId}.json` |
| `src/config.ts:144-165` | Phase 6 feature flag defaults |
| `src/reverse-pipeline.ts` | Isidore→Gregor delegation (PRD 3 may use this) |
