# Phase 5: Autonomous Bidirectional Collaboration

## Context

Phases 1-4 established a one-directional pipeline: Gregor writes tasks to `/var/lib/pai-pipeline/tasks/`, Isidore Cloud processes them, writes results to `results/`. This works well but is one-way — Isidore Cloud cannot delegate work back to Gregor.

Phase 5 makes the collaboration **bidirectional**: Isidore Cloud can send tasks to Gregor, a task orchestrator can decompose complex work into multi-agent step DAGs, and branch isolation prevents git conflicts. Delegation starts manual-only (via `/delegate` command) — no autonomous delegation until the system is proven.

**Sub-phases:** 5A (reverse pipeline) → 5B (orchestrator) → 5C (branch isolation), built sequentially.

---

## Architecture

```
                         Marius (Telegram)
                              |
                    +---------v----------+
                    |     bridge.ts      |
                    +--+-----+-----+----+
                       |     |     |
            +----------+     |     +-----------+
            v                v                 v
    +-------+------+ +------+------+ +--------+--------+
    | telegram.ts  | | pipeline.ts | | orchestrator.ts  |
    | /delegate    | | (forward,   | | (DAG, state,     |
    | /workflow(s) | |  untouched) | |  assignment)     |
    | /pipeline    | +------+------+ +---+----------+---+
    | /cancel      |        |            |          |
    +-------+------+        v            v          v
            |      /var/lib/pai-pipeline/          |
            |      +-- tasks/      (Gregor→Isidore)|
            |      +-- results/    (Isidore→Gregor)|
            |      +-- ack/                        |
            +----->+-- reverse-tasks/  (Isidore→Gregor) [NEW]
                   +-- reverse-results/(Gregor→Isidore) [NEW]
                   +-- reverse-ack/                     [NEW]
                   +-- workflows/      (orchestrator)   [NEW]
```

---

## Phase 5A: Reverse Pipeline (3-4 days)

### New file: `src/reverse-pipeline.ts`

`ReversePipelineWatcher` class:
- **`delegateToGregor(prompt, project?, priority?)`** — writes a `PipelineTask` JSON to `reverse-tasks/` with `from: "isidore_cloud"`, `to: "gregor"`. Returns task ID. Tracks pending delegations in a `Map<taskId, {workflowId, stepId}>` (serializable metadata, not closures — see crash recovery below).
- **`poll()`** — reads `reverse-results/` every 5s. For each result file: parse, match to pending delegation, invoke orchestrator callback or send Telegram notification to Marius, move result to `reverse-ack/`.
- **`start()` / `stop()`** — polling lifecycle, same pattern as `PipelineWatcher`.
- Uses same `PipelineTask` / `PipelineResult` interfaces from `pipeline.ts` (no new schemas).
- Atomic writes (`.tmp` → `rename`), same as forward pipeline.

**Crash recovery (fix #4):** The `pendingDelegations` Map stores serializable metadata (`{workflowId, stepId}`), not closures. On bridge restart, `loadPending()` re-scans `reverse-tasks/` for files not yet in `reverse-ack/` — these are in-flight delegations. For each, reconstruct the pending entry from the task JSON's `workflow_id` and `step_id` fields. Notify Marius of any recovered in-flight delegations via Telegram.

### Modified files

**`src/config.ts`** — add:
```typescript
reversePipelineEnabled: boolean;         // REVERSE_PIPELINE_ENABLED, default "1"
reversePipelinePollIntervalMs: number;   // REVERSE_PIPELINE_POLL_INTERVAL_MS, default 5000
```

**`src/bridge.ts`** — wire `ReversePipelineWatcher`:
- Init after config load (alongside `PipelineWatcher`)
- Start/stop in parallel with existing pipeline
- Pass to `createTelegramBot()` for `/delegate` command access

**`src/telegram.ts`** — add `/delegate <prompt>` command:
- Calls `reversePipeline.delegateToGregor(prompt, activeProject)`
- Replies with task ID and "pending" status
- When result arrives (callback), sends result to Marius via Telegram

### VPS setup
```bash
sudo mkdir -p /var/lib/pai-pipeline/{reverse-tasks,reverse-results,reverse-ack}
sudo chgrp pai /var/lib/pai-pipeline/{reverse-tasks,reverse-results,reverse-ack}
sudo chmod 2770 /var/lib/pai-pipeline/{reverse-tasks,reverse-results,reverse-ack}
```

### Gregor-side changes (minimal)
Gregor needs a watcher for `reverse-tasks/` and a script to write results to `reverse-results/`. Mirror his existing `pai-result-watcher.py` + `pai-submit.sh` pattern. This is Gregor-side work — we provide the JSON schema, he implements the consumer.

**Latency fix (#1):** Gregor's current `pipeline-check` cron runs */30 — far too slow for real-time `/delegate` use. Gregor's side must add an inotify watcher on `reverse-tasks/` (mirroring the existing `pai-result-watcher.py` pattern on `results/`). This gives near-instant pickup. The */30 cron remains as a fallback sweep but is not the primary mechanism.

### Verification
1. Use `/delegate "echo test"` → verify JSON file appears in `reverse-tasks/`
2. Manually write result JSON to `reverse-results/` → verify bridge picks it up, notifies Marius
3. Malformed JSON in `reverse-results/` → verify graceful skip (no crash)
4. Bridge restart → verify no state loss (pending delegations re-scanned from directory)

---

## Phase 5B: Task Orchestrator (5-7 days)

**Depends on:** 5A complete.

### New file: `src/orchestrator.ts`

#### Key types

```typescript
interface WorkflowStep {
  id: string;                           // "step-001"
  description: string;                  // Human-readable
  prompt: string;                       // Agent prompt
  assignee: "isidore" | "gregor";
  status: "pending" | "blocked" | "in_progress" | "completed" | "failed";
  dependsOn: string[];                  // Step IDs (DAG edges)
  project?: string;
  result?: string;
  error?: string;
  taskId?: string;                      // Reverse-pipeline task ID (for gregor steps)
  startedAt?: string;
  completedAt?: string;
  retryCount: number;                   // Default 0, max 1
}

interface Workflow {
  id: string;                           // UUID
  originTaskId: string;                 // Pipeline task that spawned this
  originFrom: string;                   // Who submitted the original
  description: string;
  status: "active" | "completed" | "failed" | "cancelled";
  steps: WorkflowStep[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  delegationDepth: number;              // Loop guard (max 3)
}
```

#### `TaskOrchestrator` class

- **`loadWorkflows()`** — reads all `workflows/*.json` on bridge startup, rebuilds in-memory map
- **`saveWorkflow(wf)`** — atomic write to `workflows/<id>.json`
- **`createWorkflow(originTask, steps[])`** — validates decomposition (fix #2), creates workflow, persists, starts advancing
- **`validateDecomposition(steps[])`** **(fix #2)** — called before workflow creation:
  - Cycle detection (topological sort — if sort fails, DAG has a cycle → reject)
  - Assignee whitelist (`"isidore" | "gregor"` only)
  - At least 1 step required
  - All `dependsOn` IDs must reference existing step IDs
  - No self-dependencies
  - Returns `{valid: boolean, errors: string[]}`
- **`advanceWorkflow(id)`** — finds steps with all dependencies met → dispatches them:
  - Isidore steps → `dispatch()` via Claude CLI (reuse `ClaudeInvoker.oneShot()`)
  - Gregor steps → `reversePipeline.delegateToGregor()` with callback to `completeStep()`
  - **Idempotency guard (fix #3):** Only dispatches steps with `status: "pending"` whose dependencies are all `"completed"`. Transitions step to `"in_progress"` + `saveWorkflow()` **before** dispatching. Concurrent `advanceWorkflow()` calls on the same workflow see the step as `"in_progress"` and skip it. This makes double-dispatch impossible without needing a mutex.
- **`completeStep(workflowId, stepId, result)`** — marks step completed, calls `advanceWorkflow()` to unblock dependents
- **`failStep(workflowId, stepId, error)`** — marks failed, retries if under limit, else fails workflow. **Notifies Marius via Telegram on workflow failure (fix #5).**
- **`getActiveWorkflows()` / `getWorkflow(id)` / `getWorkflowSummary(wf)`** — for Telegram UI
- **`cancelWorkflow(id)`** — marks cancelled, stops pending steps

#### Workflow lifecycle

```
Marius sends /workflow create "Review pipeline and improve error handling"
  OR pipeline task arrives with type: "orchestrate"
    → Orchestrator uses Claude one-shot to decompose into steps + dependencies
    → Workflow created, persisted to workflows/
    → advanceWorkflow() dispatches steps with no dependencies
    → As steps complete, dependent steps unblock
    → When all steps done → workflow status = "completed"
    → Final summary sent to Marius via Telegram
```

#### Delegation loop guard
- `delegationDepth` tracks chain depth from root (max 3)
- If a step's result triggers sub-decomposition, depth increments
- At max depth, complete with partial results instead of spawning more work

#### Workflow timeout
- `ORCHESTRATOR_WORKFLOW_TIMEOUT_MS` (default 30 min)
- Checked on each `advanceWorkflow()` call
- Expired workflows fail gracefully with partial results
- **Telegram notification on timeout (fix #5):** Sends Marius a message with workflow ID, description, which steps completed, and which timed out

#### Decomposition prompt template (fix #6)

The one-shot Claude call to decompose tasks uses a structured prompt:

```
You are a task orchestrator. Decompose this task into discrete steps.

AVAILABLE AGENTS:
- isidore: Complex analysis, code review, architecture, debugging, documentation, DAI skills
- gregor: Discord/OpenClaw ops, simple file operations, status checks, log analysis, cron, monitoring

RULES:
- Each step must have: id (step-NNN), description, prompt, assignee, dependsOn[]
- dependsOn references other step IDs (empty array if no dependencies)
- assignee must be exactly "isidore" or "gregor"
- Maximum 10 steps per workflow
- No circular dependencies

Return ONLY a JSON array of steps. No explanation.

TASK: {task.prompt}
PROJECT: {task.project || "none"}
```

Output validated by `validateDecomposition()` before workflow creation.

### Modified files

**`src/config.ts`** — add:
```typescript
orchestratorEnabled: boolean;                // ORCHESTRATOR_ENABLED, default "1"
orchestratorMaxDelegationDepth: number;      // ORCHESTRATOR_MAX_DELEGATION_DEPTH, default 3
orchestratorWorkflowTimeoutMs: number;       // ORCHESTRATOR_WORKFLOW_TIMEOUT_MS, default 1800000
```

**`src/bridge.ts`** — wire `TaskOrchestrator`:
- Init after config, pass `ClaudeInvoker` + `ReversePipelineWatcher`
- Call `loadWorkflows()` on startup
- Pass to `createTelegramBot()`

**`src/pipeline.ts`** — orchestrator hook in `processTask()` (~15 lines):
- After writing result (line 206), if task has `type: "orchestrate"` and orchestrator is enabled:
  ```typescript
  if (this.orchestrator && task.type === "orchestrate") {
    await this.orchestrator.handleOrchestrationTask(task, result);
  }
  ```
- Forward pipeline behavior unchanged for all other task types.

**`src/telegram.ts`** — add commands:

| Command | Purpose |
|---------|---------|
| `/workflow create <prompt>` | Create workflow — orchestrator decomposes via Claude |
| `/workflows` | List active workflows with step counts |
| `/workflow <id>` | Detailed step-by-step status |
| `/cancel <id>` | Cancel active workflow |
| `/pipeline` | Dashboard: forward + reverse pipeline + workflow status |

### Verification
1. `/workflow create "Analyze pipeline.ts and suggest 2 improvements"` → verify workflow JSON in `workflows/`, steps created
2. Watch steps execute in order (dependency-respecting)
3. Step assigned to Gregor → verify task in `reverse-tasks/`, result flows back
4. `/workflows` → shows accurate real-time status
5. `/cancel <id>` → workflow stops, remaining steps skipped
6. Kill + restart bridge → `/workflows` shows same state (persistence)
7. Set `ORCHESTRATOR_WORKFLOW_TIMEOUT_MS=30000` → verify timeout fires
8. `type: "orchestrate"` task via forward pipeline → verify orchestrator picks it up

---

## Phase 5C: Branch Isolation (3-4 days)

**Depends on:** 5B complete.

### New file: `src/branch-manager.ts`

```typescript
interface BranchLock {
  branch: string;
  agent: "isidore" | "gregor";
  workflowId: string;
  stepId: string;
  createdAt: string;
}

class BranchManager {
  // Persistent lock state at BRANCH_LOCKS_FILE
  createBranch(projectDir, agent, feature, workflowId, stepId): Promise<{branch, ok, error?}>
  releaseBranch(branch): Promise<void>
  isLocked(branch): BranchLock | null
  branchName(agent, feature): string  // → "isidore/<feature>" or "gregor/<feature>"
  commitAndPush(projectDir, branch, message): Promise<{ok, output}>
  loadLocks(): Promise<void>
  saveLocks(): Promise<void>
}
```

**Key rules:**
- Branch naming: `<agent>/<kebab-case-feature>`
- Refuses to commit to `main` or `master`
- One agent per branch at a time (lock)
- Locks persist across restarts (`/var/lib/pai-pipeline/branch-locks.json` — shared location so both agents can see locks, fix #7)
- **Scope (fix #9):** BranchManager is instantiated once globally but `createBranch()` takes `projectDir` as parameter — locks are keyed by `{projectDir}:{branch}` to support multi-project workflows. Each lock records its project directory.

### Modified files

**`src/config.ts`** — add:
```typescript
branchIsolationEnabled: boolean;     // BRANCH_ISOLATION_ENABLED, default "0" (off until tested)
branchLocksFile: string;             // BRANCH_LOCKS_FILE, default /var/lib/pai-pipeline/branch-locks.json
```

**`src/bridge.ts`** — wire `BranchManager`, pass to orchestrator

**`src/orchestrator.ts`** — before dispatching code-modifying steps:
- Call `branchManager.createBranch()` for the step
- Pass branch name to Claude dispatch (in prompt or env)
- Release lock on step completion

**`src/wrapup.ts`** — when `BRANCH_ISOLATION_ENABLED=1`:
- Check current branch before committing
- If on `main`, skip commit and log warning (~10 lines)

### Verification
1. Orchestrated workflow with code changes → verify `isidore/<feature>` branch created
2. Two steps targeting same branch → verify lock prevents concurrent access
3. `main` protection → verify `lightweightWrapup()` refuses on main when enabled
4. Bridge restart → branch locks survive
5. Workflow completion → lock released

---

## Summary of all file changes

| File | Change | Sub-phase |
|------|--------|-----------|
| `src/reverse-pipeline.ts` | **NEW** — ReversePipelineWatcher class | 5A |
| `src/orchestrator.ts` | **NEW** — TaskOrchestrator class | 5B |
| `src/branch-manager.ts` | **NEW** — BranchManager class | 5C |
| `src/config.ts` | Add 8 env vars with defaults | 5A-5C |
| `src/bridge.ts` | Wire 3 new modules into startup/shutdown | 5A-5C |
| `src/telegram.ts` | Add 5 commands: /delegate, /workflow, /workflows, /cancel, /pipeline | 5A-5B |
| `src/pipeline.ts` | ~15-line orchestrator hook in processTask() | 5B |
| `src/wrapup.ts` | ~10-line branch guard | 5C |

## Key design decisions

1. **Manual delegation only** — `/delegate` command, no autonomous delegation until proven
2. **Same JSON schemas** — reverse pipeline reuses `PipelineTask`/`PipelineResult`, just swaps `from`/`to`
3. **Orchestrator uses Claude to decompose** — one-shot call to plan workflow steps, not hardcoded rules
4. **File-based persistence** — workflows as JSON files in `workflows/`, same atomic write pattern
5. **Delegation depth cap at 3** — prevents infinite loops
6. **Branch isolation off by default** — `BRANCH_ISOLATION_ENABLED=0` until manually tested and enabled
7. **Forward pipeline untouched** — only addition is a 15-line optional hook after result write
8. **Crash-recoverable state** — pending delegations use serializable metadata (not closures); on restart, re-scan directories to reconstruct in-flight state
9. **Decomposition validation** — cycle detection, assignee whitelist, step ID referential integrity before any workflow executes
10. **Idempotent advancement** — `advanceWorkflow()` transitions steps to `in_progress` before dispatch, preventing double-dispatch from concurrent completions
11. **Failure visibility** — Telegram notifications on workflow failure and timeout, not just success

### Future consideration (nice-to-have #8)
The reverse pipeline uses 5s polling, matching the forward pipeline. Both could benefit from inotify-based watching (like Gregor's `pai-result-watcher.py`) for sub-second latency. This is a performance optimization — polling works correctly, inotify would be faster. Defer to post-Phase 5 if latency becomes an issue.

## Timeline

| Sub-phase | Duration | Dependency |
|-----------|----------|------------|
| 5A: Reverse pipeline | 3-4 days | None |
| 5B: Orchestrator | 5-7 days | 5A |
| 5C: Branch isolation | 3-4 days | 5B |
| **Total** | **11-15 days** | Sequential |

## End-to-end integration test

After all three sub-phases deployed:
- [ ] Forward pipeline unchanged (Gregor → Isidore simple tasks work)
- [ ] `/delegate` sends task to Gregor, result flows back to Marius
- [ ] `/workflow create` decomposes, assigns steps, tracks to completion
- [ ] Gregor steps go through reverse pipeline, results feed back to orchestrator
- [ ] Delegation depth limit prevents infinite loops
- [ ] Workflow timeout fires correctly + Marius gets Telegram notification (fix #5)
- [ ] Workflow failure sends Telegram notification to Marius (fix #5)
- [ ] All Telegram commands show accurate status
- [ ] Bridge restart preserves all state (workflows, pending delegations, branch locks)
- [ ] Pending delegations recovered on restart — Marius notified of in-flight ones (fix #4)
- [ ] Circular dependency in decomposition → rejected with error (fix #2)
- [ ] Concurrent step completions don't cause double-dispatch (fix #3)
- [ ] Branch isolation creates feature branches, prevents main commits
- [ ] Branch locks keyed by project:branch — multi-project safe (fix #9)
- [ ] Branch locks stored at `/var/lib/pai-pipeline/branch-locks.json` — visible to both users (fix #7)
- [ ] `bunx tsc --noEmit` passes
