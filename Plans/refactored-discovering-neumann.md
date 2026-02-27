# Plan: Gregor-Isidore Collaboration Architecture & Escalation Roadmap

## Context

Marius wants clarity on how sessions, files, and GitHub sync work when Gregor and Isidore Cloud collaborate, plus a phased plan to evolve from simple pipeline tests to an autonomous multi-agent system. Two immediate tasks are prioritized: (1) live auto-escalation test and (2) Gregor-side cron frequency increase.

**Key findings from exploration:**
- Gregor already has a complexity classifier that writes pipeline tasks via `pai-submit.sh`
- Gregor's pipeline-check cron (*/30) checks his internal inbox (`~/.openclaw/pipeline/inbox/`), NOT the PAI results directory directly. An inotify watcher (`pai-result-watcher.py`) monitors `/var/lib/pai-pipeline/results/` and writes notifications to that inbox. Result detection is near-instant; the cron frequency only affects how fast Gregor reads/processes those notifications.
- No escalation logic exists on the Isidore side yet — all tasks are treated equally
- Pipeline is one-at-a-time, no parallelism, no sub-agent spawning
- Session management is completely stateless on bridge side (pass-through only)

---

## Part A: How Collaboration Works Today (Clarification)

### Session Management

```
TELEGRAM PATH:                          PIPELINE PATH:
User → Grammy bot                       Gregor writes task.json
  → ClaudeInvoker.send()                  → PipelineWatcher polls every 5s
  → claude --resume <session-id>           → claude [-−resume <session_id>] -p "prompt"
  → saves session to active-session-id     → session_id returned in result JSON
  → per-project sessions in handoff.json   → Gregor includes session_id in next task

ISOLATION: These two paths NEVER share sessions.
  - Telegram: SessionManager reads/writes ~/.claude/active-session-id
  - Pipeline: session_id is pure pass-through in task/result JSON, no files written
  - No conflict possible even if both run simultaneously
```

**Multi-turn pipeline conversations:** Gregor gets `session_id` back in the result JSON. To continue the conversation, Gregor includes that `session_id` in the next task. The bridge passes `--resume <session_id>` to Claude. If the session expired, bridge retries as one-shot with a warning.

**Cross-project session risk:** If Gregor sends session_id from project A in a task targeting project B, Claude resumes the conversation but in project B's directory — context mismatch. Currently no guard against this.

### File Management

```
/var/lib/pai-pipeline/        (mode 2770, group pai, setgid)
├── tasks/                    Gregor writes → Isidore reads
├── results/                  Isidore writes → Gregor reads
└── ack/                      Processed tasks archived here

Flow: Gregor writes task JSON → bridge polls → dispatches to claude -p →
      writes result atomically (.tmp → rename) → moves task to ack/
```

- Results are text-only (`result` string field). No file artifacts.
- Atomic writes prevent partial reads.
- Both `openclaw` and `isidore_cloud` users are in `pai` group — setgid handles permissions.

### GitHub Management

- **Pipeline tasks do NOT auto-commit.** Only Telegram responses trigger `lightweightWrapup()`.
- **Knowledge sync is explicit:** Only on `/project` (pull) and `/done` (push) commands.
- **No conflict today** because pipeline and Telegram typically target different projects.
- **If both modify same repo:** Currently undefined — would need branch isolation (Phase 4).

---

## Part B: Immediate Tasks

### Task 1: Test Auto-Escalation Live

**What:** SSH to VPS, craft a complex multi-step request that Gregor's classifier should escalate, verify the full pipeline flow.

**Steps:**

1. SSH to VPS as openclaw: `ssh vps`
2. Check Gregor's classifier config to understand escalation triggers:
   ```bash
   openclaw cron list    # see what crons exist
   ls /var/lib/pai-pipeline/tasks/    # any pending tasks?
   ls /var/lib/pai-pipeline/results/  # any results?
   ```
3. Craft a multi-step request via Telegram or directly as a pipeline task — the goal is triggering Gregor's complexity classifier to write to `/var/lib/pai-pipeline/tasks/`
4. Watch in real-time:
   ```bash
   # Terminal 1: watch tasks directory
   watch -n 1 'ls -la /var/lib/pai-pipeline/tasks/'

   # Terminal 2: watch bridge logs
   sudo journalctl -u isidore-cloud-bridge -f

   # Terminal 3: watch results
   watch -n 1 'ls -la /var/lib/pai-pipeline/results/'
   ```
5. Verify the result JSON has `status: "completed"` and valid `session_id`
6. Test multi-turn by crafting a follow-up task using that `session_id`

**Use `pai-submit.sh` for all tests** (generates correct schema with `"type": "task"`, proper permissions, all required fields):

```bash
# Test A: Simple one-shot
pai-submit.sh "Read src/pipeline.ts and summarize the dispatch function in 3 bullets." \
  --project my-pai-cloud-solution --priority normal

# Test B: Priority ordering (stop bridge, submit 3 with different priorities, restart)
sudo systemctl stop isidore-cloud-bridge
pai-submit.sh "Say HIGH" --priority high
pai-submit.sh "Say NORMAL" --priority normal
pai-submit.sh "Say LOW" --priority low
sudo systemctl start isidore-cloud-bridge
# Verify log shows high→normal→low processing order

# Test C: Stale session recovery
# Hand-craft ONE task with fake session_id to test recovery:
cat > /var/lib/pai-pipeline/tasks/test-stale.json << 'EOF'
{
  "id": "test-stale",
  "from": "gregor",
  "to": "isidore-cloud",
  "timestamp": "2026-02-27T10:10:00Z",
  "type": "task",
  "priority": "normal",
  "mode": "async",
  "project": "my-pai-cloud-solution",
  "session_id": "00000000-0000-0000-0000-000000000000",
  "prompt": "Respond with OK",
  "context": {},
  "constraints": { "max_turns": 1, "timeout_minutes": 5 }
}
EOF
# Verify: result has status "completed" + warning about invalid session

# Test D: Multi-turn follow-up
# Take session_id from Test A result, submit via:
pai-submit.sh "Based on your previous analysis, what would you improve?" \
  --project my-pai-cloud-solution --session-id <session_id_from_test_A>
```

### Task 2: Increase Gregor-Side Pipeline-Check Cron Frequency

**What:** Change the pipeline-check cron (ID `30195d7a`) from */30 to */10. This cron checks Gregor's internal inbox (`~/.openclaw/pipeline/inbox/`), where `pai-result-watcher.py` (inotify) deposits notifications when results appear. Result detection itself is near-instant — the cron frequency only affects how fast Gregor processes those notifications.

**Steps:**
```bash
ssh vps                        # as openclaw user
openclaw cron list             # verify cron 30195d7a exists, confirm interval
openclaw cron update 30195d7a --interval "*/10"   # or via crontab -e
openclaw cron list             # verify change took effect
```

**Recommendation:** */10 — reduces notification processing latency from 30min worst-case to 10min, minimal additional load since the cron only reads local inbox files.

---

## Part C: Phased Escalation Roadmap

### Phase 1: Validate & Harden Current Pipeline (Now — 0.5 day)

**No code changes.** Pure operational testing.

- Run the live tests from Task 1 above
- Adjust Gregor cron (Task 2)
- Document any issues found
- Verify: one-shot, multi-turn, priority ordering, stale session recovery

### Phase 2: Session Safety & Structured Results (1-2 days)

**Goal:** Guard against cross-project session contamination. Add structured result support for machine-parseable output.

**Changes to `src/pipeline.ts`:**

1. **Session-project affinity guard** (high value — prevents real bugs):
   ```typescript
   // In-memory map: session_id → project name
   private sessionProjectMap = new Map<string, string>();
   // Before --resume: if session belongs to different project, warn + one-shot
   ```

2. **Structured result support** (enables Gregor to parse results programmatically):
   ```typescript
   interface PipelineResult {
     // ...existing...
     structured?: {
       summary: string;
       artifacts?: Array<{ path: string; type: string; description: string }>;
       follow_up_needed?: boolean;
       suggested_next_prompt?: string;
     };
   }
   ```

3. **Create artifacts directory on VPS:**
   ```bash
   sudo mkdir -p /var/lib/pai-pipeline/artifacts
   sudo chgrp pai /var/lib/pai-pipeline/artifacts
   sudo chmod 2770 /var/lib/pai-pipeline/artifacts
   ```

**Deferred:** Task chaining (`chain_from`) — useful but not yet needed. Multi-turn `session_id` already provides conversation continuity. Chaining adds value only when Gregor needs to compose pipeline workflows programmatically. Revisit when Phase 4 parallelism creates actual chaining demand.

**Testing:** Submit task with mismatched session_id/project, verify warning + one-shot fallback. Submit task requesting structured output, verify `structured` field in result.

### Phase 3: Escalation Context Awareness (1-2 days)

**Goal:** Isidore Cloud understands WHY a task was escalated — what Gregor tried, why it failed, what domain expertise is needed.

**Changes to `src/pipeline.ts`:**

1. **Escalation metadata in task schema:**
   ```typescript
   interface PipelineTask {
     // ...existing...
     escalation?: {
       reason: string;                    // why Gregor escalated
       criteria: string[];                // which classifier triggers fired
       gregor_partial_result?: string;    // what Gregor accomplished before escalating
     };
   }
   ```
   When present, prepend escalation context to Claude's prompt so it understands the escalation chain rather than starting from scratch.

2. **Escalation acknowledgment in results:**
   ```typescript
   interface PipelineResult {
     // ...existing...
     escalation_handled?: boolean;
     recommendations_for_sender?: string;  // advice for Gregor on similar future tasks
   }
   ```

**Dropped:** Priority inference from prompt keywords — low value since `pai-submit.sh` already accepts `--priority` and Gregor's classifier sets it explicitly.

**Testing:** Submit task with `escalation` metadata, verify Claude's response references Gregor's partial result and escalation reason.

### Phase 4: Parallel Execution & Sub-Agents (3-5 days)

**Goal:** Multiple tasks concurrently. Claude can use sub-agents within pipeline tasks.

**Changes to `src/pipeline.ts`:**

1. **Concurrency pool replacing single `processing` flag:**
   ```typescript
   private activeCount = 0;
   private maxConcurrent: number; // from PIPELINE_MAX_CONCURRENT env var

   // poll() launches min(maxConcurrent - activeCount, pending) tasks via Promise.allSettled
   ```

2. **Git worktree isolation for concurrent same-project tasks:**
   ```typescript
   // Create /tmp/pai-worktree-<task-id> via git worktree add
   // Each concurrent task gets its own working copy
   // Cleanup after task completes
   ```

3. **Pipeline auto-commit** — add `lightweightWrapup()` after pipeline tasks that modify code

**Changes to `src/config.ts`:**
   ```typescript
   pipelineMaxConcurrent: number; // NEW, default 1 (backwards compatible)
   ```

**VPS env:** Add `PIPELINE_MAX_CONCURRENT=3` to `bridge.env`

**Sub-agent spawning:** No code change needed — Claude Code already has the `Task` tool. Complex pipeline prompts can instruct Claude to decompose and use sub-agents. The `config/vps-settings.json` already permits it.

**Testing:** Submit 5 tasks with `MAX_CONCURRENT=3`, verify 3 process simultaneously. Submit 2 tasks for same project, verify worktree paths differ in logs.

### Phase 5: Autonomous Bidirectional Collaboration (2-3 weeks)

**Goal:** Isidore Cloud can delegate BACK to Gregor. Shared planning. Self-organizing work.

**New files:**

1. **`src/reverse-pipeline.ts`** — Isidore writes tasks for Gregor:
   ```
   /var/lib/pai-pipeline/reverse-tasks/    (Isidore writes, Gregor reads)
   /var/lib/pai-pipeline/reverse-results/  (Gregor writes, Isidore reads)
   ```

2. **`src/task-orchestrator.ts`** — Decomposes complex tasks into multi-step plans with step dependencies, assigns steps to either agent, tracks progress.

3. **`/var/lib/pai-pipeline/shared-docs/`** — PRDs, design docs, plans visible to both agents.

**Changes to existing files:**
- `src/bridge.ts` — Wire orchestrator + reverse pipeline into startup
- `src/telegram.ts` — Add `/pipeline` command for Marius to see agent activity
- `src/wrapup.ts` — Branch-aware commits (`isidore/<feature>` branches to prevent main conflicts)

**Git strategy for Phase 5:**
- Isidore works on `isidore/<feature>` branches
- Gregor works on `gregor/<feature>` branches
- Neither pushes to `main` directly
- PRs for review, Marius approves

**VPS setup:**
```bash
sudo mkdir -p /var/lib/pai-pipeline/{reverse-tasks,reverse-results,shared-docs}
sudo chgrp pai /var/lib/pai-pipeline/{reverse-tasks,reverse-results,shared-docs}
sudo chmod 2770 /var/lib/pai-pipeline/{reverse-tasks,reverse-results,shared-docs}
```

---

## File Change Map

| Phase | Modified | Created | VPS Changes |
|-------|----------|---------|-------------|
| 1 | None | None | Cron adjust, manual test tasks |
| 2 | `src/pipeline.ts` | None | `mkdir artifacts/` |
| 3 | `src/pipeline.ts` | None | None |
| 4 | `src/pipeline.ts`, `src/config.ts` | None | `PIPELINE_MAX_CONCURRENT` env |
| 5 (2-3 wks) | `src/bridge.ts`, `src/telegram.ts`, `src/wrapup.ts` | `src/reverse-pipeline.ts`, `src/task-orchestrator.ts` | Reverse + shared-docs dirs |

## Timeline Summary

| Phase | Duration | Dependency |
|-------|----------|------------|
| 1 | 0.5 day | None |
| 2 | 1-2 days | Phase 1 validated |
| 3 | 1-2 days | Phase 2 deployed |
| 4 | 3-5 days | Phase 3 deployed |
| 5 | 2-3 weeks | Phase 4 deployed |

Total: ~4-6 weeks to full autonomous collaboration.

## Verification

- **Phase 1:** Manual SSH + `pai-submit.sh` tests + read logs + read results
- **Phase 2:** Session-project guard fires on mismatch, structured results parseable
- **Phase 3:** Escalation context reaches Claude, response references Gregor's partial work
- **Phase 4:** Concurrent tasks in logs, worktree paths, sub-agent output
- **Phase 5:** Reverse tasks appear, orchestrator sequences steps, `/pipeline` shows status

## Implementation Order for Today

1. **SSH to VPS** → run Phase 1 live tests via `pai-submit.sh` (Task 1)
2. **Adjust Gregor cron** → */10 frequency for pipeline-check `30195d7a` (Task 2)
3. Document findings, then decide whether to start Phase 2
