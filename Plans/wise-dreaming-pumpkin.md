# Auto-Recovery for Claude CLI Errors

## Context

When Claude CLI crashes with no output (exit code + empty stderr/stdout), the Telegram user gets a dead-end error message with no automatic recovery. The specific case: "push the readme into this chat" → "Claude crashed with no output." The user had to manually retry.

The bridge already handles stale sessions (auto-retry with fresh session) and rate limits (auto-cooldown). This extends that pattern to cover crashes, hook failures, timeouts, and generic non-zero exits.

## Approach

Add retry logic **inside `ClaudeInvoker`** (`src/claude.ts`) so ALL callers benefit — Telegram handler, pipeline, orchestrator. Classify errors as recoverable vs non-recoverable. Retry once with a fresh session for recoverable errors. Feed failures into the existing rate limiter for auto-pause on repeated crashes.

## Changes

### 1. `src/claude.ts` — Error classification + retry

**Add error classifiers** (after line 42):

```typescript
const AUTH_ERROR_PATTERNS = ["authentication_failed", "OAuth token", "authentication_error"];

function isAuthError(text: string): boolean {
  return AUTH_ERROR_PATTERNS.some((p) => text.includes(p));
}

function isRecoverableError(errorDetail: string): boolean {
  if (isAuthError(errorDetail)) return false;
  if (isRateLimitError(errorDetail)) return false;
  if (errorDetail.includes("No conversation found with session ID")) return false;
  return true;
}
```

**Add `retried` field to `ClaudeResponse`** (line 27):
```typescript
retried?: boolean;
```

**Modify `sendStreaming()`** — add `isRetry = false` param (line 202). After the stale-session check (line 297-301), before the error return (line 309-313):

```typescript
// Auto-retry recoverable errors once with fresh session
if (!isRetry && isRecoverableError(errorDetail)) {
  console.warn(`[claude] Recoverable error (exit ${exitCode}), retrying fresh: ${errorDetail.slice(0, 100)}`);
  this.rateLimiter?.recordFailure();
  await this.sessions.newSession();
  onProgress({ type: "phase", phase: "RETRY" });
  const retryResult = await this.sendStreaming(prompt, null, onProgress, true);
  retryResult.retried = true;
  return retryResult;
}
```

Same pattern in the `catch` block (line 329-335).

**Modify `send()` non-streaming path** — add `_isRetry = false` param. After stale-session check (line 147-151), before error return (line 152-156):

```typescript
if (!_isRetry && isRecoverableError(stderr)) {
  console.warn(`[claude] Recoverable error (exit ${exitCode}), retrying fresh`);
  this.rateLimiter?.recordFailure();
  await this.sessions.newSession();
  const retryResult = await this.send(message, undefined, true);
  retryResult.retried = true;
  return retryResult;
}
```

### 2. `src/telegram.ts` — Show retry recovery note (optional, minimal)

After `response.error` check in the main message handler (~line 1252), if `response.retried` is true, prepend a brief note:

```typescript
const retryNote = response.retried ? "↻ Recovered after retry\n\n" : "";
```

Prepend to formatted output.

### 3. No other files change

- `session.ts` — `newSession()` already works, called by retry
- `rate-limiter.ts` — `recordFailure()` already works, called by retry
- `config.ts` — no new config needed (retry count is hardcoded to 1)
- `friendlyError()` — unchanged, only reached if retry also fails

## Error Classification Summary

| Error Type | Recoverable? | Action |
|---|---|---|
| Crash with no output | Yes | Retry fresh session |
| Non-zero exit + stderr | Yes | Retry fresh session |
| Timeout kill | Yes | Retry fresh session |
| Spawn exception | Yes | Retry fresh session |
| Auth expired | No | Show /reauth message |
| Rate limited (429) | No | Show wait message |
| Stale session | Handled separately | Already auto-retries |

## Verification

1. Deploy to VPS
2. Type check: `npx tsc --noEmit`
3. Send a message on Telegram — should work normally
4. Check journalctl for `[claude] Recoverable error` lines on any failures
5. If a retry happens, Telegram shows "↻ Recovered after retry" prefix
