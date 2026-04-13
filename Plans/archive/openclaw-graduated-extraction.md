# Plan: Graduated Extraction — Sonnet API Fast-Path (Phase 1)

## Context

**Goal:** Add a direct Anthropic API fast-path for simple messages. Not every "what time is it?" needs Opus via Claude Code CLI (~31K tokens per invocation). Simple messages can use Sonnet via `fetch()` — cheaper, faster, no CLI spawn overhead.

**Current flow:**
```
Telegram message → auth → claude.send() → Bun.spawn("claude --resume ...") → parse stream-json → reply
```

**Proposed flow:**
```
Telegram message → auth → classifier → [simple] → sendDirect() → Anthropic API (Sonnet) → reply
                                      → [complex] → claude.send() → CLI (Opus) → reply
```

## Architecture

### New file: `src/direct-api.ts`

Lightweight Anthropic API client using `Bun.fetch()`. No SDK dependency — just raw HTTP.

```typescript
interface DirectResponse {
  result: string;
  usage: { input_tokens: number; output_tokens: number };
  model: string;
}

async function sendDirect(
  message: string,
  systemPrompt: string,
  config: DirectApiConfig,
): Promise<DirectResponse>
```

- Uses `ANTHROPIC_API_KEY` env var (required for direct API)
- Model: configurable, default `claude-sonnet-4-6`
- Max tokens: 4096 (short responses for simple queries)
- System prompt: injected context from ContextBuilder (memory, project state)
- No streaming (simple messages don't need progress indicators)

### New file: `src/message-classifier.ts`

Pure function that classifies messages as `"direct"` or `"cli"`.

```typescript
type MessageRoute = "direct" | "cli";

function classifyMessage(text: string, mode: BridgeMode): MessageRoute
```

**Routing rules (ordered by priority):**
1. Commands (`/sync`, `/project`, etc.) → always `cli`
2. Project mode → always `cli` (needs file ops, git, working directory)
3. Developer keywords (git, code, debug, refactor, deploy, fix, test, build, review, merge, branch, commit, push, pull, error, bug, crash, log) → `cli`
4. References to files/paths (`src/`, `.ts`, `.md`, `~/`) → `cli`
5. Long messages (>300 chars) → `cli` (likely complex)
6. Explicit CLI request ("use claude", "full mode") → `cli`
7. Everything else → `direct` (greetings, questions, status, general chat)

### Integration in `src/telegram.ts`

At line ~1839 where `claude.send(message)` is called:

```typescript
const route = classifyMessage(message, modeManager.getCurrentMode());
let response: ClaudeResponse;

if (route === "direct" && config.directApiEnabled) {
  response = await claude.sendDirect(message);
} else {
  response = await claude.send(message, onProgress);
}
```

### Config additions in `src/config.ts`

```
DIRECT_API_ENABLED=0          # Feature flag (default: off)
DIRECT_API_KEY=               # Anthropic API key
DIRECT_API_MODEL=claude-sonnet-4-6
DIRECT_API_MAX_TOKENS=4096
```

### Memory coherence

Both paths record to memory.db:
- Direct API responses: recorded as episodes with `source: "telegram"`, metadata includes `{ route: "direct", model: "sonnet" }`
- CLI responses: unchanged
- ContextBuilder injects recent episodes regardless of which path generated them
- No session ID for direct API calls (stateless) — coherence comes from memory, not session

## Files to Create

| File | Purpose | Lines (est.) |
|------|---------|-------------|
| `src/direct-api.ts` | Anthropic API client via fetch | ~80 |
| `src/message-classifier.ts` | Pure function routing classifier | ~50 |
| `src/__tests__/message-classifier.test.ts` | Tests for classifier | ~100 |
| `src/__tests__/direct-api.test.ts` | Tests for API client (mocked fetch) | ~60 |

## Files to Modify

| File | Change |
|------|--------|
| `src/config.ts` | Add 4 env vars for direct API |
| `src/claude.ts` | Add `sendDirect()` method that delegates to direct-api.ts |
| `src/telegram.ts` | Route through classifier before `claude.send()` |
| `src/config.ts` | Add corresponding Config interface fields |

## Implementation Order

1. `src/message-classifier.ts` + tests (pure function, no deps)
2. `src/direct-api.ts` + tests (fetch mock)
3. `src/config.ts` — add env vars
4. `src/claude.ts` — add `sendDirect()` wrapper
5. `src/telegram.ts` — integrate classifier + direct path
6. Type check + full test suite
7. Test on VPS with `DIRECT_API_ENABLED=0` (no behavior change)
8. Enable with `DIRECT_API_ENABLED=1` + `DIRECT_API_KEY=...`

## What This Gives You

- **~80% cost reduction** on simple messages (Sonnet API vs Opus CLI)
- **~5x faster response time** for simple queries (no CLI spawn, no hooks, no context loading)
- **Zero regression risk** — feature-flagged off by default, CLI path unchanged
- **Memory coherence** — both paths feed the same memory.db, ContextBuilder bridges them
- **Nighttime worker safe** — simple health checks, status queries, acks all go through fast path

## Verification Criteria

- [ ] `classifyMessage("hi")` returns `"direct"`
- [ ] `classifyMessage("refactor the auth module")` returns `"cli"`
- [ ] `classifyMessage("/sync")` returns `"cli"`
- [ ] `classifyMessage("what time is it?")` returns `"direct"`
- [ ] `classifyMessage("fix the bug in pipeline.ts")` returns `"cli"`
- [ ] `classifyMessage("summarize today")` returns `"direct"` (in workspace mode)
- [ ] `sendDirect()` calls Anthropic API with correct headers
- [ ] `sendDirect()` returns structured response with usage
- [ ] `sendDirect()` handles API errors gracefully (rate limit, auth, network)
- [ ] Direct API responses recorded in memory.db with route metadata
- [ ] CLI path unchanged when DIRECT_API_ENABLED=0
- [ ] Type check passes
- [ ] All tests pass (existing 97 + new ~30)
- [ ] Feature flag off: zero behavior change on VPS

## Phases 2-4 (Unchanged)

Phase 2 (Operational Tooling), Phase 3 (Gateway + Plugins), and Phase 4 (Capability Extraction) remain as originally planned. Phase 1 is the foundation that enables the rest.
