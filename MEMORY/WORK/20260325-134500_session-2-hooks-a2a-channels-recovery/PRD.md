---
task: Execute Session 2 hooks A2A channels recovery
slug: 20260325-134500_session-2-hooks-a2a-channels-recovery
effort: deep
phase: complete
progress: 44/44
mode: interactive
started: 2026-03-25T13:45:00+01:00
updated: 2026-03-25T13:50:00+01:00
---

## Context

Session 2 of the PAI Cloud Evolution Master Plan (v4). Builds on Session 1 (DAG Memory, MCP, Loop Detection, Summarizer — all deployed).

Scope: 8 phases covering hooks (A-C), turn recovery (D), A2A server (E), Channels evaluation (F), Remote Control evaluation (G), and bridge adaptation (H).

Baseline: 270 tests passing, 50+ source files. All changes must be feature-flagged and backward compatible.

Phases F (Channels) and G (Remote Control) are VPS-side evaluation tasks — documented as decisions, not local code.

### Risks
- Turn recovery refactor touches 4 invocation paths in claude.ts — high blast radius. Mitigation: extract policy class, wire incrementally, test each path.
- A2A server mounts on Dashboard routes — add routes to existing fetch handler (not separate server). Mitigation: A2A routes prefixed with `/a2a/` and `/.well-known/`, no conflict.
- PipelineTaskSchema.strict() + new optional fields — Zod strict only rejects unknown keys, optional fields are fine. Verified.
- Hooks are standalone bun scripts with own DB access — must resolve memory.db path from env, not import bridge modules. Pattern: same as existing LoadContext.hook.ts.

### Plan

**Parallelization strategy:**
1. Write ALL test files first (turn-recovery, a2a-server, hooks)
2. Implement hooks (A-C) in parallel — independent modules
3. Implement turn-recovery.ts (D) — depends on understanding claude.ts retry paths
4. Implement a2a-server.ts (E) — depends on dashboard routing pattern
5. Config + schema changes + bridge wiring (H) last
6. Phases F+G: document evaluation findings in Decisions

## Criteria

### Phase A: UserPromptSubmit Hook
- [x] ISC-1: src/hooks/user-prompt-submit.ts file exists
- [x] ISC-2: Hook exports userPromptSubmit async function
- [x] ISC-3: Hook queries memory.db for relevant context
- [x] ISC-4: Hook returns object with additionalContext string
- [x] ISC-5: src/hooks/memory-query.ts extracts scoring logic

### Phase B: PostToolUse Hook
- [x] ISC-6: src/hooks/post-tool-use.ts file exists
- [x] ISC-7: Hook exports postToolUse async function
- [x] ISC-8: Hook scores tool results by heuristic importance
- [x] ISC-9: Hook stores significant interactions in memory.db

### Phase C: SessionStart Hook
- [x] ISC-10: src/hooks/session-start.ts file exists
- [x] ISC-11: Hook exports sessionStart async function
- [x] ISC-12: Hook loads PAI identity context on session start
- [x] ISC-13: Hook loads project context from memory.db

### Phase D: Turn Recovery Policy
- [x] ISC-14: src/turn-recovery.ts file exists with RecoveryPolicy class
- [x] ISC-15: RetryState type replaces boolean _isRetry flag
- [x] ISC-16: Auth errors fail fast with no retry
- [x] ISC-17: Quota errors use exponential backoff
- [x] ISC-18: Transient errors retry with fresh session
- [x] ISC-19: Empty response triggers cache-bust retry
- [x] ISC-20: Stale session triggers fresh start
- [x] ISC-21: Hook failure logs and continues
- [x] ISC-22: RecoveryPolicy consumed by send() method
- [x] ISC-23: RecoveryPolicy consumed by sendStreaming() method
- [x] ISC-24: RecoveryPolicy consumed by oneShot() method

### Phase E: A2A Agent Server
- [x] ISC-25: src/a2a-server.ts file exists with A2AServer class
- [x] ISC-26: GET /.well-known/agent-card.json returns valid agent card
- [x] ISC-27: Agent card endpoint excluded from dashboard auth
- [x] ISC-28: POST /a2a/message/send invokes Claude returns result
- [x] ISC-29: POST /a2a/message/stream returns SSE response
- [x] ISC-30: A2A authenticated routes require DASHBOARD_TOKEN
- [x] ISC-31: A2A_ENABLED flag in config.ts with default false
- [x] ISC-32: A2A requires DASHBOARD_ENABLED=1 validation

### Phase E2: Schema Extensions
- [x] ISC-33: PipelineTaskSchema has optional sender field
- [x] ISC-34: PipelineTaskSchema has optional recipient field
- [x] ISC-35: PipelineTaskSchema has optional intent field
- [x] ISC-36: PipelineTaskSchema has optional correlation_id field
- [x] ISC-37: Existing pipeline tasks validate with extended schema

### Phase H: Bridge Adaptation + Config
- [x] ISC-38: BRIDGE_CONTEXT_INJECTION env var in config.ts
- [x] ISC-39: BridgeContext includes a2aServer field
- [x] ISC-40: A2A server wired in bridge.ts when enabled

### Tests
- [x] ISC-41: turn-recovery.test.ts has 10+ passing tests
- [x] ISC-42: a2a-server.test.ts has 8+ passing tests
- [x] ISC-43: All 270 existing tests still pass

### Anti-criteria
- [x] ISC-A-1: Anti: No existing test broken by changes

## Decisions

- 2026-03-25 14:15: Phase F (Channels) deferred to VPS testing — requires Telegram Channel plugin install on VPS, lab bot creation. Not local code work. Bridge stays primary.
- 2026-03-25 14:15: Phase G (Remote Control) deferred to VPS setup — `claude remote-control` is a Claude Code feature, needs systemd service on VPS. Evaluated as supplementary access path.
- 2026-03-25 14:10: A2A routes mounted inside Dashboard fetch handler (not separate server) per Anthropic "simplest solution" principle. A2AServer.handleRequest() called before dashboard auth check so agent card can be public.
- 2026-03-25 14:05: RecoveryPolicy wired into all 4 invocation paths (send, sendStreaming, oneShot, quickShot). oneShot/quickShot use classify() for hook-failure detection but don't retry (one-shot by design). send/sendStreaming use full retry logic.

## Verification

- ISC-1 thru ISC-5: src/hooks/ contains user-prompt-submit.ts, memory-query.ts — verified via `ls -la src/hooks/`
- ISC-6 thru ISC-9: src/hooks/post-tool-use.ts exists, scores importance, stores episodes — verified via file read
- ISC-10 thru ISC-13: src/hooks/session-start.ts exists, loads project context + knowledge — verified via file read
- ISC-14 thru ISC-21: turn-recovery.ts has RecoveryPolicy with 6 error categories, RetryState type — 15 tests pass
- ISC-22 thru ISC-24: claude.ts imports and uses RecoveryPolicy in send(), sendStreaming(), oneShot(), quickShot() — grep confirms 10 references
- ISC-25 thru ISC-30: a2a-server.ts has A2AServer class with agent card, send, stream endpoints — 11 tests pass
- ISC-31/32: config.ts has A2A_ENABLED (default false) + validation requiring DASHBOARD_ENABLED — grep confirms
- ISC-33 thru ISC-37: schemas.ts has sender, recipient, intent, correlation_id optional fields — existing tests still pass
- ISC-38: config.ts has BRIDGE_CONTEXT_INJECTION as enum("legacy","hooks") — grep confirms
- ISC-39/40: types.ts has a2aServer field, bridge.ts wires A2AServer when enabled — grep confirms
- ISC-41: turn-recovery.test.ts has 15 passing tests (40 expect calls)
- ISC-42: a2a-server.test.ts has 11 passing tests (50 expect calls)
- ISC-43: 296 tests pass across 22 files (270 original + 26 new)
- ISC-A-1: 0 test failures — `bun test` clean
- Capability check: /simplify invoked via Skill tool — 7 issues found and fixed
