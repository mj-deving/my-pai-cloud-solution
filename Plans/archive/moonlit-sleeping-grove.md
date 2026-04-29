# Plan: Wire Sub-Delegation + Live Telegram Status

## Context

DAI Cloud has 6+ execution paths that invoke Claude, but two problems:
1. **Sub-delegation is dead code** — `claude.subDelegate()` has zero callers. Agent definitions load but orchestrator always uses `oneShot()`.
2. **No execution visibility** — Marius waits in silence during Claude invocations, pipeline tasks, workflows, and synthesis. No "CLI-like" live view of what's happening.

Marius wants to see **everything** on Telegram: Algorithm phases, tool calls, ISC progress, workflow step dispatch, pipeline task status — not just final results.

**Format:** Hybrid — compact single-line for simple ops, expanded multi-line block for workflows/Algorithm sessions.

---

## Part 1: MessengerAdapter + TelegramAdapter Extension

### `src/messenger-adapter.ts` — Add 3 methods + type

```typescript
export interface StatusMessageHandle { messageId: number; }

// Add to MessengerAdapter interface:
sendStatusMessage(text: string, options?: MessageOptions): Promise<StatusMessageHandle>;
editMessage(messageId: number, text: string, options?: MessageOptions): Promise<void>;
deleteMessage(messageId: number): Promise<void>;
```

Why new `sendStatusMessage` instead of changing `sendDirectMessage`: avoids breaking 6+ existing fire-and-forget callers.

### `src/telegram-adapter.ts` — Implement the 3 methods

- `sendStatusMessage` → `bot.api.sendMessage()` → return `{ messageId: msg.message_id }`
- `editMessage` → `bot.api.editMessageText()` in try/catch (Telegram 400 if text unchanged or message deleted)
- `deleteMessage` → `bot.api.deleteMessage()` in try/catch

Grammy 1.40.0 supports all three (verified in `node_modules/grammy/out/core/api.d.ts`).

---

## Part 2: StatusMessage Helper

### `src/status-message.ts` — New file (~90 lines)

Rate-limited editable Telegram message manager.

- **Lifecycle:** `init(text)` → `update(text)` (repeated) → `finish(text)` or `remove()`
- **Rate limiting:** Default 2.5s between edits (configurable via `STATUS_EDIT_INTERVAL_MS`). Queues latest text if called too soon.
- **Error handling:** All edit/delete failures absorbed (logged in adapter). `disposed` flag prevents updates after finish/remove.
- **Helper:** `formatStatus(title, lines, footer?)` builds compact status strings with done/pending indicators.

---

## Part 3: Interactive Session Streaming (the big one)

This is the most impactful change — live Algorithm phase tracking during interactive Telegram sessions.

### 3a. `src/claude.ts` — Add streaming `send()` with progress callback

**Current:** `send()` uses `--output-format json`, waits for full response, returns it.

**New:** `send()` uses `--output-format stream-json --include-partial-messages`, reads NDJSON line by line, emits progress events via optional callback, accumulates full text, returns it.

Add progress event type:
```typescript
export type ProgressEvent =
  | { type: "phase"; phase: string }          // Algorithm phase detected (OBSERVE, THINK, etc.)
  | { type: "tool_start"; tool: string }      // Tool invocation started
  | { type: "tool_end"; tool: string }        // Tool completed
  | { type: "text_chunk"; text: string }      // Raw text chunk (optional use)
  | { type: "isc_progress"; done: number; total: number } // ISC checkbox progress
```

Change `send()` signature:
```typescript
async send(message: string, onProgress?: (event: ProgressEvent) => void): Promise<ClaudeResponse>
```

**Implementation changes in `send()`:**
1. Switch args from `--output-format json` to `--output-format stream-json --include-partial-messages`
2. Replace `const stdout = await new Response(proc.stdout).text()` with line-by-line NDJSON reader
3. For each NDJSON line, parse and dispatch:
   - `content_block_delta` + `text_delta` → accumulate text + scan for Algorithm phase markers (`━━━ 👁️ OBSERVE ━━━` etc.) and ISC progress (`[x]` checkbox patterns)
   - `content_block_start` + `tool_use` → emit `tool_start` with tool name
   - `content_block_stop` after tool_use → emit `tool_end`
4. After stream ends, extract session_id from the final accumulated messages (stream-json emits a result message at the end)
5. Return `ClaudeResponse` as before (accumulated full text + session_id)

**Phase detection regex:** `━━━.*?(OBSERVE|THINK|PLAN|BUILD|EXECUTE|VERIFY|LEARN).*━━━`
**ISC detection regex:** Count `- \[x\]` and `- \[ \]` in accumulated text.

**If `onProgress` is not provided:** Behavior is identical to current (just uses stream-json internally instead of json, no performance impact).

### 3b. `src/telegram.ts` — Wire live status to message handler

In the `message:text` handler (around line 698), before calling `claude.send()`:

1. Create StatusMessage: `status.init("Processing...")`
2. Pass `onProgress` callback to `claude.send()`:
   ```typescript
   const response = await claude.send(text, (event) => {
     switch (event.type) {
       case "phase":
         status.update(`━━━ ${event.phase} ━━━`);
         break;
       case "tool_start":
         status.update(`━━━ ${currentPhase} ━━━ [${event.tool}]...`);
         break;
       case "tool_end":
         status.update(`━━━ ${currentPhase} ━━━`);
         break;
       case "isc_progress":
         status.update(`━━━ ${currentPhase} ━━━ ISC ${event.done}/${event.total}`);
         break;
     }
   });
   ```
3. After response: `status.remove()` (delete status message), then send formatted result as usual

**What Marius sees on Telegram during an Algorithm session:**
```
⚙️ Processing...
→ ━━━ OBSERVE ━━━
→ ━━━ OBSERVE ━━━ [Read]...
→ ━━━ THINK ━━━
→ ━━━ BUILD ━━━ [Edit]...
→ ━━━ EXECUTE ━━━ ISC 3/8
→ ━━━ VERIFY ━━━ [Bash]...
→ (deleted, replaced by full formatted response)
```

One live-updating message that shows current phase + active tool + ISC progress. Deleted when done, replaced by the actual result.

### 3c. `oneShot()` — Same streaming (optional, lower priority)

Apply the same pattern to `oneShot()` with an optional `onProgress` callback. This enables live status for pipeline, orchestrator, synthesis. Lower priority because those already get status from their surrounding lifecycle (Part 4 below).

---

## Part 4: Background Operation Status (hybrid format)

Each subsystem gets `setMessenger()` setter. If null, status updates skip silently.

### 4a. Pipeline (`src/pipeline.ts`)

Add `setMessenger()`. In `processTask()`:
- Init: `"⚙️ Pipeline {id} [{type}] {priority}"`
- Progress: `"...branch: {branch}"` → `"...dispatching"` → `"...verifying"`
- Finish: `"✓ Pipeline {id}: {status} ({elapsed}s)"` or `"✗ Pipeline {id}: failed"`

**Compact format** — single line, edited in place.

### 4b. Orchestrator (`src/orchestrator.ts`)

Add `setMessenger()` + `Map<string, StatusMessage>` per workflow. **Expanded format:**
```
Workflow abc123 (2/5 steps)
[✓] step-001 (isidore) Setup
[✓] step-002 (gregor) Check deps
[⚙] step-003 (code-reviewer) Review    ← shows sub-delegation
[ ] step-004 Deploy
```

Updated at: `createWorkflow`, `dispatchStep`, `completeStep`, `failStep`, `notifyCompletion`.

### 4c. Synthesis (`src/synthesis.ts`)

Add `setMessenger()`. Compact format:
- Init: `"⚙️ Synthesis: {N} episodes across {M} domains"`
- Per domain: `"...processing {domain} ({i}/{total})"`
- Finish: summary

### 4d. PRD Executor (`src/prd-executor.ts`)

Already has `messenger`. Add StatusMessage tracking:
- `"PRD: parsing..."` → `"PRD: {title} ({N} steps)"` → `"PRD step {i}/{N}"` → finish

### 4e. Reverse Pipeline (`src/reverse-pipeline.ts`)

Add `setMessenger()` + Map by taskId. Compact:
- `"→ Gregor: {prompt_preview}"` → `"← Gregor: {status}"`

---

## Part 5: Wire Sub-Delegation

### 5a. Expand `agentLoader` type (`src/orchestrator.ts:44`)

Add `getAgent(id)` to the type:
```typescript
private agentLoader: {
  getAllAgents(): Array<{ id: string; name: string; description: string }>;
  getAgent(id: string): import("./agent-loader").AgentDefinition | undefined;
} | null = null;
```

Same change for `setAgentLoader()` at line 81.

### 5b. Add `resolveAgent()` method to `TaskOrchestrator`

Checks step description for agent ID/name matches from loaded definitions. Keyword fallbacks for known agents (code-reviewer, health-checker, synthesizer). Returns `undefined` → falls through to `oneShot()`.

### 5c. Modify `dispatchStep()` (`src/orchestrator.ts:438`)

```typescript
// Current:
const response = await this.claude.oneShot(step.prompt);

// New:
const agent = this.resolveAgent(step);
const response = agent
  ? await this.claude.subDelegate(agent, step.prompt, { project: step.project, cwd: projectDir || undefined })
  : await this.claude.oneShot(step.prompt);
```

Status message shows agent name + tier when sub-delegating.

### 5d. Update decomposition prompt (`src/orchestrator.ts:749`)

Add after agent list:
```
To use a sub-agent, include its ID in the step description.
Example: "Code review (code-reviewer): Review pipeline changes"
```

### 5e. Fallback

No match → `oneShot()` (current behavior). Agent definitions disabled → graceful degradation. Zero regression risk.

---

## Part 6: Bridge Wiring (`src/bridge.ts`)

After messenger creation (~line 268):
```typescript
pipeline?.setMessenger(messenger);
orchestrator?.setMessenger(messenger);
synthesisLoop?.setMessenger(messenger);
reversePipeline?.setMessenger(messenger);
```
PRD executor already receives messenger in constructor.

---

## Part 7: Config (`src/config.ts`)

```
STATUS_EDIT_INTERVAL_MS  (default: 2500, range: 1000-10000)
```

---

## File Change Summary

| File | Change | Est. lines |
|------|--------|-----------|
| `src/messenger-adapter.ts` | 3 methods + StatusMessageHandle type | +15 |
| `src/telegram-adapter.ts` | Implement 3 methods | +30 |
| `src/status-message.ts` | **New** — StatusMessage + formatStatus | ~90 |
| `src/config.ts` | STATUS_EDIT_INTERVAL_MS | +6 |
| `src/claude.ts` | **Streaming send()** — NDJSON reader, ProgressEvent, phase/tool/ISC detection | +100 |
| `src/telegram.ts` | Wire onProgress callback in message handler | +25 |
| `src/pipeline.ts` | setMessenger + status in processTask | +30 |
| `src/orchestrator.ts` | setMessenger, resolveAgent, dispatchStep wiring, decomp prompt | +65 |
| `src/synthesis.ts` | setMessenger + status in run() | +20 |
| `src/prd-executor.ts` | StatusMessage tracking | +20 |
| `src/reverse-pipeline.ts` | setMessenger + status in delegate/poll | +20 |
| `src/bridge.ts` | Wire messenger to subsystems | +5 |
| `CLAUDE.md` | Module table update | +2 |
| **Total** | | **~430 lines** |

## Implementation Order

1. **Foundation:** messenger-adapter.ts + telegram-adapter.ts + status-message.ts + config.ts
2. **Core streaming:** claude.ts (streaming send with ProgressEvent) + telegram.ts (wire onProgress)
3. **Background ops:** pipeline.ts + orchestrator.ts + synthesis.ts + prd-executor.ts + reverse-pipeline.ts (parallel — all independent)
4. **Sub-delegation:** orchestrator.ts (resolveAgent + dispatchStep wiring)
5. **Bridge wiring:** bridge.ts
6. **Docs:** CLAUDE.md module table

Steps 3 and 4 can be done in parallel. Step 5 depends on 3+4.

## Verification

1. `bunx tsc --noEmit` passes
2. Deploy to VPS, restart service
3. **Interactive streaming:** Send Algorithm-triggering message via Telegram → verify live phase transitions + tool calls appear on status message → verify status deleted and result sent
4. **Pipeline status:** Submit pipeline task from Gregor → verify compact status on Telegram
5. **Orchestrator + sub-delegation:** `/workflow create "review bridge code"` → verify expanded step grid + "code-reviewer" sub-delegation in logs
6. **Synthesis status:** Trigger synthesis → verify domain progress on Telegram
7. **Error resilience:** Delete status message mid-operation → verify bridge doesn't crash
8. **Fallback:** Workflow step without agent match → verify `oneShot()` used (check logs)
