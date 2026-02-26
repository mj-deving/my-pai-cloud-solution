# Pipeline Maturity: Multi-Turn Sessions + Priority Queuing

## Context

The cross-user pipeline (Gregor writes tasks, Isidore Cloud processes them) works but is basic: every task gets a fresh Claude context (no conversation continuity), and tasks are processed in arbitrary filesystem order (no priority). This plan adds two features:

1. **Multi-turn sessions** — Gregor can submit follow-up tasks that resume a prior Claude conversation
2. **Priority sorting** — High-priority tasks jump ahead of normal/low in the queue

Both features touch **one file** (`src/pipeline.ts`) with minimal, backwards-compatible changes. No new files, no new config, no new dependencies.

**Repo:** `/home/mj/projects/my-pai-cloud-solution/` (local), deployed to VPS via `scripts/deploy.sh`.

---

## Clarifications (from review)

**Session ID extraction — already solved.** `dispatch()` (line 207) already passes `--output-format json`. Line 231 already does `JSON.parse(stdout)`. Claude's JSON response includes `session_id`. We just need `parsed.session_id` — no new flags needed.

**Field naming — `session_id` (snake_case).** Gregor's `pai-submit.sh` already writes `session_id` and Claude CLI returns `session_id`. The TypeScript interface will use `session_id` to match the JSON interchange format.

**Sender side already done.** `pai-submit.sh` already has `--session` flag. The bridge just needs to honor the field and pass it through.

**Poll-cycle atomicity note.** Priority ordering applies within a poll batch, not across batches. If task 1 takes 5 minutes and a high-priority task arrives mid-processing, it waits until the next poll cycle. Fine for current volume — noted in docs.

---

## Changes

### File: `src/pipeline.ts` (the only code file that changes)

#### 1. Add `session_id` to interfaces

**`PipelineTask`** — add optional `session_id?: string` field. When present, dispatch uses `--resume` to continue a prior conversation.

**`PipelineResult`** — add optional `session_id?: string` field. Always populated on success (from Claude's JSON response) so Gregor can use it in follow-ups.

#### 2. Add priority constant (after interfaces, ~line 43)

```typescript
const PRIORITY_ORDER: Record<string, number> = { high: 3, normal: 2, low: 1 };
```

#### 3. Refactor `poll()` (lines 81-98) — read-then-sort-then-process

Current: reads filenames, iterates calling `processTaskFile()` which reads/parses each individually.

New:
- Read ALL task files, parse JSON, validate `id` + `prompt`
- Sort by priority (high > normal > low), tie-break by timestamp then filename
- Process in sorted order via `processTask(filename, task)`

#### 4. Rename `processTaskFile()` → `processTask(filename, task)` (lines 101-154)

Reading/parsing/validation moves into `poll()`. This method simplifies to: dispatch → write result → move to ack. Log line gains `[priority]` tag.

#### 5. Modify `dispatch()` (lines 193-247) — add `--resume` support

- If `task.session_id` exists, insert `--resume`, `task.session_id` before `-p` in args (same pattern as `claude.ts:42-46`)
- After `JSON.parse(stdout)` at line 231: extract `parsed.session_id` and pass to `buildResult()`
- **Stale session recovery:** If exit code !== 0 AND `task.session_id` AND stderr contains `"No conversation found with session ID"` → retry once without `--resume`, push warning to `warnings[]` (same pattern as `claude.ts:76-79`)
- For JSON parse failure fallback (line 240-242): no `session_id` available, omit it

#### 6. Modify `buildResult()` (lines 249-269) — accept `session_id`

Add `session_id?: string` parameter. Spread into result: `...(session_id && { session_id })`.

### File: `ARCHITECTURE.md`

- Update task schema example with `session_id` field
- Update result schema example with `session_id` field
- Update design decisions: "one-shot by default, multi-turn optional"
- Add priority sorting documentation + poll-cycle atomicity note
- Add stale session handling to error table

### No changes to: `config.ts`, `bridge.ts`, `session.ts`, `telegram.ts`

---

## Key Design Decisions

**Pure pass-through sessions (no state on our side).** Gregor provides `session_id` from a previous result → we pass it as `--resume` → Claude CLI manages session persistence. No session files, no in-memory maps, no state on bridge side. Service restarts don't affect anything.

**Stale session = graceful fallback.** If `--resume` fails (session expired/doesn't exist), retry once without it. Warning in result so Gregor knows context was reset.

**Priority sort, not preemption.** Tasks sorted at start of each poll cycle. Running task is never interrupted. Priority applies within a batch, not across batches.

**Full backwards compatibility.** Missing `session_id` = one-shot. Missing `priority` = "normal". No migration needed.

---

## Verification

No test suite — verify by deploying and testing on VPS.

1. **Type check:** `bunx tsc --noEmit`
2. **Deploy:** `bash scripts/deploy.sh && ssh isidore_cloud 'sudo systemctl restart isidore-cloud-bridge'`
3. **Priority test:** Stop bridge, write 3 tasks (high/normal/low) to tasks/, start bridge, verify log shows high first
4. **One-shot baseline:** Submit task without `session_id` → verify result contains `session_id`
5. **Multi-turn:** Use that `session_id` in a follow-up task → verify `--resume` in logs + context continuity
6. **Stale session:** Submit task with `session_id: "fake-id"` → verify warning in result, task still completes
7. **Backwards compat:** Submit old-format task (no `session_id`, no `priority`) → verify normal processing
