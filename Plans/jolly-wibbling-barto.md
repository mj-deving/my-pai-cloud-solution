# Phase 6A-6D Implementation Plan

## Context

The Nightwire analysis (`NIGHTWIRE-ANALYSIS.md`) identified 4 high-value gaps in our bridge: no resource guard, no rate-limit cooldown, no independent verification, and no lightweight model routing. This plan implements those as 4 additive phases — no rewrites, all feature-flagged, independently deployable.

## Deploy Order

1. **Phase 6A** — Resource Guard + Rate Limiter (prevents VPS OOM + cascade failures)
2. **Phase 6B** — Independent Verifier (trust in pipeline output)
3. **Phase 6C** — `/quick` Command (UX + cost savings)
4. **Phase 6D** — Increase Workers to 8 (throughput, safe with 6A guard)

---

## Phase 6A: Resource Guard + Rate Limiter

### New Files

**`src/resource-guard.ts`** (~30 lines)
- Class `ResourceGuard` with constructor taking `Config`
- `canDispatch(): boolean` — checks `os.freemem()` against threshold
- `getStatus()` — returns `{ freeMb, thresholdMb, ok }` for dashboard
- Uses `import { freemem } from "node:os"`

**`src/rate-limiter.ts`** (~90 lines)
- Class `RateLimiter` with constructor taking `Config`
- `recordFailure()` — timestamps failure, prunes window, triggers cooldown at threshold
- `isPaused(): boolean` — checks cooldown state
- `resume()` — manual resume
- `onEvent(listener)` — subscribe to "paused"/"resumed" events
- `getStatus()` — returns `{ paused, recentFailures, cooldownRemainingMs, threshold }`
- `stop()` — clears auto-resume timer (for shutdown)
- Cooldown: `setTimeout` auto-resume after configurable duration

### Modified Files

**`src/config.ts`** — Add to Config interface + loadConfig():
```
resourceGuardEnabled: boolean          // RESOURCE_GUARD_ENABLED !== "0"
resourceGuardMemoryThresholdMb: number // RESOURCE_GUARD_MEMORY_THRESHOLD_MB (default 512)
rateLimiterEnabled: boolean            // RATE_LIMITER_ENABLED !== "0"
rateLimiterFailureThreshold: number    // RATE_LIMITER_FAILURE_THRESHOLD (default 3)
rateLimiterWindowMs: number            // RATE_LIMITER_WINDOW_MS (default 300000 = 5min)
rateLimiterCooldownMs: number          // RATE_LIMITER_COOLDOWN_MS (default 3600000 = 60min)
```

**`src/claude.ts`** — Rate-limit error detection:
- Add `private rateLimiter?: { recordFailure(): void }` field
- Add `setRateLimiter(rl)` setter
- In `send()` (after line 74 exit check) and `oneShot()` (after line 151 exit check): detect stderr containing "rate_limit", "429", "overloaded", "Too many requests" → call `this.rateLimiter?.recordFailure()`

**`src/pipeline.ts`** — Pre-dispatch guards:
- Add `private resourceGuard` and `private rateLimiter` fields + setters
- In `poll()` at top (line 138): `if (this.rateLimiter?.isPaused()) return;`
- In batch loop (line 184): `if (this.resourceGuard && !this.resourceGuard.canDispatch()) break;`

**`src/orchestrator.ts`** — Dispatch guard:
- Add `private rateLimiter` field + setter
- In `dispatchStep()` at line 354: if `rateLimiter.isPaused()`, revert step to "pending" and return (deferred, retried on resume event)

**`src/bridge.ts`** — Wiring (after branchManager init, before bot creation):
- Import + conditionally init ResourceGuard and RateLimiter
- Wire `claude.setRateLimiter(rateLimiter)`
- Wire `pipeline.setResourceGuard(resourceGuard)` and `pipeline.setRateLimiter(rateLimiter)`
- Wire `orchestrator.setRateLimiter(rateLimiter)`
- Wire `rateLimiter.onEvent()` → Telegram notification on pause/resume
- On resume event: kick `orchestrator.advanceWorkflow()` for all active workflows
- Add `rateLimiter?.stop()` to shutdown handler

**`src/telegram.ts`** — Dashboard update:
- Add `rateLimiter` parameter to `createTelegramBot()` signature (after branchManager)
- In `/pipeline` handler (after orchestrator section, before `ctx.reply`): add rate limiter status section showing paused/active, recent failures, cooldown remaining

### Key Design Decisions
- Rate limiter ONLY in pipeline.poll() and orchestrator.dispatchStep() — NOT in telegram message handler (ISC-A3)
- Resource guard uses `break` not `continue` — defers ALL remaining tasks when low memory
- Verifier failure marks result with error, never silently drops (ISC-A2)
- Loose coupling: claude.ts takes `{ recordFailure(): void }` interface, not concrete class

---

## Phase 6B: Independent Verifier

### New File

**`src/verifier.ts`** (~110 lines)
- Class `Verifier` with constructor taking `Config`
- `verify(taskPrompt, resultText, cwd?): Promise<VerificationResult>`
  - Gets git diff via `git diff HEAD~1 --stat -p` (capped 8KB)
  - Builds verification prompt with task + result + diff
  - Spawns separate `claude -p` one-shot (no session, SKIP_KNOWLEDGE_SYNC=1)
  - Parses "PASS: reason" / "FAIL: reason" verdict
  - On verifier error/timeout: returns `{ passed: true }` (fail-open — never blocks on broken verifier)
  - On clear rejection: returns `{ passed: false, verdict, concerns }`

### Modified Files

**`src/config.ts`** — Add:
```
verifierEnabled: boolean     // VERIFIER_ENABLED !== "0"
verifierTimeoutMs: number    // VERIFIER_TIMEOUT_MS (default 30000)
```

**`src/pipeline.ts`** — Post-dispatch verification:
- Add `private verifier` field + setter
- In `processTask()` after line 235 (`const result = await this.dispatch(task)`), before branch inclusion:
  - If verifier enabled and result.status === "completed": call `verifier.verify()`
  - If verification fails: set `result.status = "error"`, `result.error = "Verification failed: ..."`, add concerns to warnings
  - Result is still written to results/ (never silently dropped)

**`src/orchestrator.ts`** — Step verification:
- Add `private verifier` field + setter
- In `completeStep()` at line 418 (after idempotency check, before setting status):
  - If verifier enabled: call `verifier.verify()` with step.prompt and result
  - If fails: call `this.failStep()` instead of completing (leverages existing retry logic)

**`src/reverse-pipeline.ts`** — Gregor result verification:
- Add `private verifier` field + setter
- In `poll()` before `this.onResult()` callback: verify completed results
  - If fails: set `result.status = "error"`, add verdict to result.error

**`src/bridge.ts`** — Wiring:
- Import + conditionally init Verifier
- Wire into pipeline, orchestrator, reverse-pipeline via setters

---

## Phase 6C: `/quick` Command

### Modified Files

**`src/config.ts`** — Add:
```
quickModel: string    // QUICK_MODEL (default "haiku")
```

**`src/claude.ts`** — Add `quickShot()` method (after `oneShot()`):
- Same as oneShot but adds `--model` flag with configurable model alias
- Includes rate-limit detection
- No session persistence

**`src/telegram.ts`** — Add `/quick` command:
- Insert after `/oneshot` handler (~line 352)
- Handler: parse `ctx.match`, call `claude.quickShot()`, format + chunk response
- Add to `/start` help text

---

## Phase 6D: Increase Workers

### Modified Files

**VPS bridge.env** — Change `PIPELINE_MAX_CONCURRENT=3` to `PIPELINE_MAX_CONCURRENT=8`

No code changes needed — config.ts already parses arbitrary values. Safe with Phase 6A resource guard in place (defers tasks when memory low).

---

## File Change Summary

| File | Phases | Change |
|------|--------|--------|
| **NEW** `src/resource-guard.ts` | 6A | ~30 lines |
| **NEW** `src/rate-limiter.ts` | 6A | ~90 lines |
| **NEW** `src/verifier.ts` | 6B | ~110 lines |
| `src/config.ts` | 6A,6B,6C | +9 Config fields, +9 loadConfig entries |
| `src/claude.ts` | 6A,6C | +rateLimiter setter, +error detection, +quickShot() |
| `src/pipeline.ts` | 6A,6B | +resource/rate guards, +verification hook |
| `src/orchestrator.ts` | 6A,6B | +rate guard in dispatch, +verification in complete |
| `src/reverse-pipeline.ts` | 6B | +verification before result routing |
| `src/bridge.ts` | 6A,6B | +imports, +init, +wiring, +shutdown |
| `src/telegram.ts` | 6A,6C | +rateLimiter param, +dashboard section, +/quick |

Untouched: session.ts, projects.ts, format.ts, wrapup.ts, branch-manager.ts

## Env Vars (All New)

| Variable | Default | Phase |
|----------|---------|-------|
| `RESOURCE_GUARD_ENABLED` | `"1"` | 6A |
| `RESOURCE_GUARD_MEMORY_THRESHOLD_MB` | `512` | 6A |
| `RATE_LIMITER_ENABLED` | `"1"` | 6A |
| `RATE_LIMITER_FAILURE_THRESHOLD` | `3` | 6A |
| `RATE_LIMITER_WINDOW_MS` | `300000` | 6A |
| `RATE_LIMITER_COOLDOWN_MS` | `3600000` | 6A |
| `VERIFIER_ENABLED` | `"1"` | 6B |
| `VERIFIER_TIMEOUT_MS` | `30000` | 6B |
| `QUICK_MODEL` | `"haiku"` | 6C |

## Verification

### Phase 6A
1. Deploy → startup log shows "Resource guard enabled" + "Rate limiter enabled"
2. Interactive Telegram message still works (not blocked by rate limiter)
3. `/pipeline` dashboard shows rate limiter status section
4. Set `RESOURCE_GUARD_MEMORY_THRESHOLD_MB=999999` → pipeline tasks deferred
5. Set `RATE_LIMITER_FAILURE_THRESHOLD=1` + trigger failure → "Rate limiter activated" notification, automated dispatch pauses, interactive messages unaffected

### Phase 6B
1. Pipeline task → two Claude invocations in logs (dispatch + verification)
2. Result file includes verification outcome
3. `VERIFIER_ENABLED=0` → single invocation only
4. Workflow steps verified before completeStep()
5. Gregor results verified before routing

### Phase 6C
1. `/quick What is 2+2?` → fast response from lightweight model
2. `/quick` without args → usage message
3. `/start` help includes new command

### Phase 6D
1. Set `PIPELINE_MAX_CONCURRENT=8` in bridge.env
2. Restart → log shows "max concurrent: 8"
3. Multiple simultaneous tasks dispatch in parallel

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Verifier doubles API cost per task | Feature-flagged, can disable per-environment |
| `os.freemem()` underreports on Linux (cached pages) | 512MB threshold is conservative; can switch to `/proc/meminfo` MemAvailable if needed |
| Rate limiter window edge cases | Safety net, not precision instrument — acceptable |
| `claude --model haiku` flag availability | **Verify on VPS first** (`ssh isidore_cloud 'claude --model haiku -p "test"'`) before implementing 6C. If unavailable, defer 6C. |
