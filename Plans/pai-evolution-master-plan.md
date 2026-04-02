# PAI Cloud Evolution — Master Adoption Plan v4

**Date:** 2026-03-25 (v4: Anthropic harness design insights applied)
**Scope:** Lossless-Claw DAG Memory + Claude Channels + Maestro Features + A2A Protocol + Safety Patterns
**Sessions:** 4 mega-sessions (50% of 1M context each)
**Approach:** TDD, feature-flagged, backward compatible, **minimum viable scaffolding** (Anthropic principle: strip what's not load-bearing)
**Sources:** Maestro, Lossless-Claw, Claude Channels, DeerFlow (ByteDance), Letta Code, DeepAgents (LangChain), A2A Protocol (Linux Foundation), **Anthropic Engineering: Harness Design for Long-Running Apps (2026-03)**
**Reviewed by:** Codex (GPT-5.4) — 0 P0, 4 P1 (all addressed), 4 P2 (all addressed), 3 P3 (all addressed)

## Design Principles (from Anthropic harness research)

1. **Find the simplest solution possible, only increase complexity when needed.** Every harness component encodes an assumption about what the model can't do. Stress-test those assumptions.
2. **Context resets > compaction.** Clean slate + structured handoff beats in-place summarization for coherence. DAG memory enables this natively.
3. **Separate evaluator from generator.** Self-evaluation is unreliable. Dedicated QA agent with Playwright MCP catches what generators miss.
4. **Sprint contracts before execution.** Agents agree on "what done looks like" before writing code.
5. **Strip scaffolding as models improve.** Opus 4.6 runs 2+ hours without needing sprint decomposition or context resets. Re-evaluate what's load-bearing with each model upgrade.

## Session Overview

| Session | Focus | New Files | New Tests | New LOC |
|---------|-------|-----------|-----------|---------|
| **S1** | DAG Memory + MCP Servers + Safety | 13 | ~48 | ~2,150 |
| **S2** | Hooks + A2A Server + Channels + Remote Control | 10 | ~34 | ~1,400 |
| **S3** | Maestro: Playbooks (with evaluator) + Worktrees (with contracts) + Compression | 7 | ~55 | ~1,650 |
| **S4** | Integration + Retrieval Isolation + A2A Client + Group Chat + Deploy | 10 | ~26 | ~1,400 |
| **Total** | | 40 | ~163 | ~6,600 |

## Dependency Graph (v4: Codex ordering + Anthropic simplification)

```
S1 (DAG Memory + MCP + Safety)
  │
  ├──→ S2 (Hooks + A2A Server + Channels)
  │      S2 depends on S1: A2A mounts on Dashboard routes
  │
  ├──→ S3 (Maestro: Playbooks + Evaluator + Worktrees + Contracts)
  │      S3 soft-depends on S1: DAG for compression
  │
  └──→ S4 (Integration + Retrieval Isolation + A2A Client + Deploy)
         S4 gates on S1 + S2 + S3
```

**Ordering:** S1 first (foundation). S2 and S3 in parallel. S4 last.

**v4 simplification (Anthropic principle):** Deferred HTTP server extraction — A2A requires `DASHBOARD_ENABLED=1` as a declared dependency (simpler than extracting a shared HttpServer module that may not be load-bearing). If this becomes a real limitation, extract in S4. Migration runner deferred similarly — versioned migrations add complexity for a problem we don't yet have (3 idempotent ALTERs work fine). Add migration runner when the 4th schema change lands and the pattern breaks.

## Protocol Stack (Target Architecture)

```
┌──────────────────────────────────────────┐
│           PAI Cloud (Isidore)            │
├──────────────────────────────────────────┤
│  MCP Servers (agent-to-tools)            │
│  ├── pai-memory (memory.db access)       │
│  └── pai-context (scored retrieval)      │
├──────────────────────────────────────────┤
│  A2A Server (agent-to-agent)             │
│  ├── /.well-known/agent-card.json        │
│  ├── /a2a/message/send (sync)            │
│  └── /a2a/message/stream (SSE)           │
│  Mounted on existing Dashboard Bun.serve │
├──────────────────────────────────────────┤
│  Access Surfaces (user-to-agent)         │
│  ├── Telegram Bridge (primary)           │
│  ├── Telegram Channels (live, suppl.)    │
│  ├── Remote Control (pending)            │
│  └── Dashboard (monitoring)              │
└──────────────────────────────────────────┘
```

---

## Session 1: DAG Memory + MCP Servers + Safety

### Phase A: DAG Schema + Pure Data Layer
- **Tests first:** `src/__tests__/summary-dag.test.ts` (13 tests)
- **Implement:** `src/summary-dag.ts` (~250 lines)
  - `summaries` table (id, parent_id, depth, content, source_episode_ids, token_count, metadata)
  - SummaryDAG class: create, query, expand, fresh-tail protection
  - Fresh tail: last 20 episodes always raw (configurable)
  - `confidence REAL DEFAULT 1.0` column on episodes (from DeerFlow pattern)
  - FTS5 `AFTER UPDATE` trigger for summary column changes
  - Schema changes use existing idempotent ALTER TABLE pattern (migration runner deferred per Anthropic "simplest solution" principle — add when pattern breaks, not before)

### Phase B: Summarization Engine
- **Tests first:** `src/__tests__/summarizer.test.ts` (14 tests, +2 for two-phase)
- **Implement:** `src/summarizer.ts` (~250 lines)
  - Three-tier fallback: Normal LLM → Aggressive LLM → Deterministic extraction
  - Uses direct API if key available, else `claude -p` oneShot
  - Deterministic tier: first sentence + importance-weighted selection (no LLM needed)
  - **NEW: Two-phase summarization** (from DeepAgents): truncate oversized tool-call args before running full LLM compaction. Saves tokens.

### Phase C: MCP Servers
- **Tests first:** `src/__tests__/mcp-memory.test.ts` (9 tests) + `src/__tests__/mcp-context.test.ts` (4 tests)
- **Implement:**
  - `src/mcp/pai-memory-server.ts` (~300 lines) — 8 tools: store, recall, search, summarize, expand, whiteboard R/W, stats
  - `src/mcp/pai-context-server.ts` (~120 lines) — 2 tools: suggest, inject
  - `src/mcp/shared.ts` (~60 lines) — DB path resolution, config construction

### Phase D: Loop Detection Middleware (from DeerFlow) — expanded per Codex P2-1
- **Tests first:** `src/__tests__/loop-detection.test.ts` (7 tests — +2 for proc-cancel and session cleanup)
- **Implement:** `src/loop-detection.ts` (~100 lines, expanded from 60)
  - Hash tool calls (name + sorted args) per session
  - **3-phase safety:** warn at 3 identical calls → instruct "stop calling tools" at 4 → hard stop at 5
  - **Hard stop implementation (Codex P2-1):** on phase 3, call `proc.kill()` on the spawned Claude process via `ClaudeInvoker.cancel()` method. Not just middleware — actual process termination.
  - Add `cancel()` method to ClaudeInvoker: kills active `Bun.spawn` child process + clears session state
  - Thread-safe with LRU eviction for old sessions
  - Wired into ClaudeInvoker's `sendStreaming()` event loop (tool_use events are visible there)
  - **Prevents:** infinite token burn (financial DoS on single VPS)

### Phase E: Integration + Config
- Modify: `config.ts` (+35), `types.ts` (+6), `schemas.ts` (+20), `bridge.ts` (+30), `synthesis.ts` (+20)
- Feature flags: `DAG_ENABLED`, `MCP_MEMORY_ENABLED`, `MCP_CONTEXT_ENABLED`, `LOOP_DETECTION_ENABLED`
- DAG summarization hooks into existing synthesis cadence
- **Deferred (Anthropic principle):** HTTP server extraction — A2A declares `DASHBOARD_ENABLED=1` as dependency. Extract shared HttpServer only if this becomes a real limitation in S4.

### Parallelization
```
[P] Write ALL test files simultaneously (Phases A+B+C+D)
[S] Implement summary-dag.ts → summarizer.ts (dependency)
[P] pai-memory-server.ts || pai-context-server.ts || loop-detection.ts (independent)
[S] Integration (Phase E) last
```

### Deliverable
- Working DAG summarization with hierarchical depth + confidence scoring
- Two-phase summarization (truncate args, then compact)
- Loop detection middleware with proc-cancel hard stop
- Two standalone MCP servers registrable in Claude Code
- ~48 new tests, ~269 total passing
- Backward compatible with existing memory.db (idempotent ALTER TABLE)
- **Deferred to backlog:** migration runner, HTTP server extraction (add when needed, not before)

---

## Session 2: Hooks + Channels + Remote Control + A2A Server

### Phase A: UserPromptSubmit Hook
- **Tests first:** Hook behavior tests
- **Implement:** `src/hooks/user-prompt-submit.ts`
  - Queries memory.db on every message (same ContextBuilder logic)
  - Returns `additionalContext` — deterministic, pre-message injection
  - `src/hooks/memory-query.ts` — shared module extracting scoring logic from ContextBuilder
  - Config: `BRIDGE_CONTEXT_INJECTION=hooks|legacy` (toggle between old/new)

### Phase B: PostToolUse Hook
- **Implement:** `src/hooks/post-tool-use.ts`
  - Heuristic importance scoring on tool results
  - Auto-stores significant interactions in memory.db

### Phase C: SessionStart Hook
- **Implement:** `src/hooks/session-start.ts`
  - Loads PAI identity, project context, baseline memory on session start

### Phase D: Turn Recovery Policy (from Letta Code) — expanded per Codex P2-3
- **Tests first:** `src/__tests__/turn-recovery.test.ts` (10 tests — covers send, sendStreaming, oneShot, hook-failure)
- **Implement:** `src/turn-recovery.ts` (~180 lines, expanded from 120)
  - Extract retry logic from ALL invocation paths in `claude.ts`: `send()`, `sendStreaming()`, `oneShot()`, AND hook-failure rescue path (Codex P2-3)
  - **Unified `RecoveryPolicy` class** consumed by all invocation methods — not just `send()`
  - Error taxonomy: auth (fail fast) → quota (backoff) → transient (retry) → empty response (cache-bust) → stale session (fresh start) → hook failure (log + continue)
  - **Preserve existing `_isRetry` guard** — refactored from boolean to `RetryState { attempt: number, lastError: string, strategy: string }`
  - Configurable per error category
  - **Why (Codex P2-3):** Failure handling is split across 4 code paths in claude.ts (L195, L368, L713). Extracting from only `send()` would leave 3 paths with hardcoded logic.

### Phase E: A2A Agent Server (from A2A Protocol + DeerFlow/DeepAgents research)
- **Tests first:** `src/__tests__/a2a-server.test.ts` (8 tests)
- **Implement:** `src/a2a-server.ts` (~300 lines)
  - Mount on Dashboard's `Bun.serve` under `/a2a/*` routes
  - **Declared dependency:** `A2A_ENABLED` requires `DASHBOARD_ENABLED=1` (Codex P1-2 — simple solution per Anthropic principle; extract shared HttpServer later if this constrains)
  - `GET /.well-known/agent-card.json` — Isidore's capabilities + metadata. **Excluded from dashboard auth** (A2A spec requires public discovery)
  - `POST /a2a/message/send` — receive task, invoke via ClaudeInvoker, return result. **Requires `DASHBOARD_TOKEN` auth.**
  - `POST /a2a/message/stream` — SSE streaming variant. **Requires auth.**
  - **ACP-shaped pipeline envelopes:** Add optional `sender`, `recipient`, `intent`, `correlation_id` fields to `PipelineTaskSchema` (backward compatible — Gregor's existing tasks still validate)
  - Feature flag: `A2A_ENABLED` (requires `DASHBOARD_ENABLED=1`)
  - Uses `a2a-node-sdk` npm package for TypeScript types. Bun-compatible (pure TypeScript)

### Phase F: Channels Exploration — COMPLETE (2026-03-26)
- [x] Installed `telegram@claude-plugins-official` v0.0.4 on VPS
- [x] Deployed as tmux-based systemd service (`isidore-cloud-channels`) with `--channels` flag
- [x] Separate Telegram bot, coexists with bridge
- [x] MCP tools (pai-memory, pai-context) working via `.mcp.json`
- [x] All 14 PAI hooks verified firing
- [x] Access control via `access.json` allowlist

### Phase G: Remote Control Setup — PENDING
- `claude remote-control --name "PAI Cloud"` as systemd service
- Systemd service file created (`isidore-cloud-remote`), disabled
- **Blocker:** Requires interactive acceptance of workspace trust prompt (cannot be automated)
- Coexists with bridge (separate service)
- Test from Claude mobile app

### Phase H: Bridge Adaptation
- `BRIDGE_CONTEXT_INJECTION` env var guards old vs new path
- Bridge continues working exactly as before
- Native Claude Code sessions gain memory context through hooks

### Deliverable
- Hooks replacing prompt injection (portable across bridge + native CLI)
- Turn recovery policy (formalized retry per error category)
- A2A agent server (Isidore exposed as A2A-compatible agent)
- Channels deployed and live (tmux-based systemd service, MCP + hooks verified)
- Remote Control pending (systemd service created, blocked on interactive trust acceptance)
- ~32 new tests, ~298 total passing

---

## Session 3: Maestro Features

### Phase A: Markdown Playbooks with Evaluator (independent) — Anthropic GAN pattern
- **Tests first:** `src/__tests__/playbook.test.ts` (~20 tests, +3 for evaluator)
- **Implement:** `src/playbook.ts` (~350 lines, expanded for evaluator)
  - PlaybookRunner: parse markdown checkboxes, execute via oneShot
  - **Evaluator step (Anthropic insight):** After each task completes, a SEPARATE oneShot evaluator grades the result against the task description. Generator never self-evaluates. Failed steps get specific feedback and retry (up to 2 retries).
  - Evaluator prompt: "You are a QA agent. Grade this result against the task. Be skeptical — identify real issues, don't approve mediocre work."
  - Config: project, timeout, on_failure (stop|continue|ask), evaluator_enabled (default: true)
  - Clarification-first (from DeerFlow): on ambiguous steps, ask before acting
  - Telegram: `/playbook <name>`, `/playbooks`
  - Results recorded in memory.db (source="playbook")
  - Feature flag: `PLAYBOOK_ENABLED`

### Phase B: Git Worktree Agent Pool with Sprint Contracts (independent) — Anthropic contract pattern
- **Tests first:** `src/__tests__/worktree-pool.test.ts` (~18 tests, +1 for contracts)
- **Implement:** `src/worktree-pool.ts` (~400 lines, expanded for contracts)
  - WorktreePool: acquire(projectDir, taskId) → slot, release(slotId, {merge?, createPR?})
  - **Sprint contracts (Anthropic insight):** Before each worktree agent starts execution, it produces a contract: what it will deliver and how to verify. Orchestrator validates contract against the workflow step spec before green-lighting. If contract is rejected, agent revises before executing.
  - Orchestrator integration: parallel steps get worktree isolation
  - Shares PIPELINE_MAX_CONCURRENT budget (not a separate pool)
  - Cleanup: stale worktree detection and removal
  - Feature flag: `WORKTREE_ENABLED`, `WORKTREE_MAX_SLOTS`

### Phase C: Context Compression (independent)
- **Tests first:** `src/__tests__/context-compressor.test.ts` (~17 tests)
- **Implement:** `src/context-compressor.ts` (~350 lines)
  - Three-pass: episode consolidation → knowledge extraction → importance pruning
  - Chunked parallel processing (max 3 concurrent oneShot calls)
  - Multi-pass if target not met (up to 3 passes, 10% reduction each)
  - Trigger: 80% context fill (configurable)
  - Uses DAG memory from S1 for storage (graceful fallback if DAG not enabled)
  - Feature flag: `CONTEXT_COMPRESSION_ENABLED`

### Parallelization
```
[P] ALL THREE phases can run simultaneously (fully independent)
[S] Integration wiring last (config, bridge.ts, telegram.ts)
```

### Deliverable
- Three independent features, all feature-flagged
- Playbooks with **separate evaluator agent** (Anthropic GAN pattern) — generator never self-evaluates
- Worktrees with **sprint contracts** (Anthropic pattern) — agents agree on "done" before executing
- Clarification-first workflow in playbooks
- ~55 new tests, ~358 total passing
- Playbooks provide declarative automation with QA feedback loop
- Worktrees enable true parallel development with verified contracts
- Compression extends effective memory horizon

---

## Session 4: Integration + Dashboard + A2A Client + Group Chat + Deploy

### Phase A: Dashboard Enhancements
- QR code generation (`src/qr-generator.ts`) for mobile access
- Memory DAG visualization panel (tree view by depth)
- Playbook status panel (name, last run, current step)
- Worktree pool status panel (total/active/idle)
- All panels degrade gracefully when backing subsystem is null

### Phase B: Guardrails Middleware (from DeerFlow) — scoped per Codex P1-1
- **Implement:** `src/guardrails.ts` (~120 lines, expanded)
  - Pre-execution authorization gate for **bridge-owned operations only** (Codex P1-1 fix)
  - **Scope clarification (Codex P1-1):** Claude-native tool use (Bash, Read, Write, etc.) has no universal interception point — tools execute inside Claude's process. Guardrails apply to bridge-dispatched actions: pipeline tasks, oneShot invocations, playbook steps, worktree operations, A2A outbound calls.
  - AllowlistProvider: whitelist specific operations for specific contexts
  - DenylistProvider: block specific operations (e.g., destructive git commands during playbook execution)
  - Wired at: `ClaudeInvoker.oneShot()`, `PipelineWatcher.dispatch()`, `PlaybookRunner.executeStep()`, `A2AClient.send()`
  - **NOT wired at:** Claude's internal tool execution (no broker/proxy boundary exists — Codex P1-1)
  - Complements existing injection scan (which is content-level, not operation-level)
  - Feature flag: `GUARDRAILS_ENABLED`

### Phase C: A2A Client (Isidore calls other agents)
- **Implement:** `src/a2a-client.ts` (~150 lines)
  - Discover agents via `/.well-known/agent-card.json`
  - `POST /a2a/message/send` to invoke external agents
  - Wire into orchestrator for cross-agent workflow delegation
  - Future: replace reverse pipeline with A2A (Gregor as peer agent)
  - Feature flag: `A2A_CLIENT_ENABLED`

### Phase C2: Retrieval Isolation (Codex P1-3 fix) — MUST come before Group Chat
- **Tests first:** `src/__tests__/retrieval-isolation.test.ts` (4 tests)
- **Implement:** Modify `src/memory.ts` (~40 lines) + `src/context.ts` (~20 lines)
  - Add `user_id` and `channel` filtering to `MemoryStore.query()` and `MemoryStore.getEpisodes()`
  - Add `channelScope` parameter to `ContextBuilder.buildContext()`: `"all" | "1:1" | "group:<id>"`
  - Default scope: `"1:1"` (backward compatible — existing behavior unchanged)
  - Group chat episodes tagged with `channel="group"` + `user_id` are ONLY retrieved when `channelScope` matches
  - **Why (Codex P1-3):** Without retrieval isolation, group traffic pollutes 1:1 context injection. Adding user_id/channel columns without query-level filtering creates a data leak.

### Phase D: Group Chat / Moderator Pattern (depends on Phase C2)
- Moderator agent definition (`.pai/agents/moderator.md`)
- `src/group-chat.ts` (~200 lines) — GroupChatEngine
  - Dispatch question to N agents in parallel
  - Collect responses, build moderator prompt
  - Moderator synthesizes final answer
  - Record in memory.db with `channel="group"`, `user_id` per participant
  - Context injection uses `channelScope="group:<chat_id>"` (Codex P1-3)
- Telegram: `/group-chat @agent1 @agent2 "question"`
- Feature flag: `GROUP_CHAT_ENABLED`, `GROUP_CHAT_MAX_AGENTS`

### Phase E: Integration Testing
- 22 tests across 6 files covering cross-subsystem flows
- Full flow: Telegram → Bridge → Memory → Context → Response
- Playbook execution, worktree dispatch, DAG integrity
- MCP server integration, Channels coexistence
- A2A server/client round-trip, loop detection trigger

### Phase F: VPS Deployment
- Deploy via `scripts/deploy.sh`
- Update bridge.env (conservative rollout: one flag at a time)
- Configure MCP servers in `.mcp.json`
- Remote Control systemd service
- Verify hooks firing via journalctl
- 10-checkpoint smoke test (added: A2A agent card, loop detection)

### Phase G: Documentation
- CLAUDE.md architecture updates
- ARCHITECTURE.md flow diagrams
- New guides: `mcp-server-architecture.md`, `a2a-protocol-integration.md`, `group-chat-patterns.md`

### Deliverable
- All systems integrated and deployed on VPS
- Dashboard shows all new panels with real data
- Guardrails middleware for pre-tool-call authorization
- A2A client for cross-agent communication
- Group chat works on Telegram
- Remote Control running as supplementary access
- ~371 total tests passing
- Full documentation updated

---

## Feature Flags Summary

| Flag | Default | Session | Controls | Origin |
|------|---------|---------|----------|--------|
| `DAG_ENABLED` | false | S1 | DAG summarization layer | Lossless-Claw |
| `DAG_FRESH_TAIL_SIZE` | 20 | S1 | Episodes protected from summarization | Lossless-Claw |
| `MCP_MEMORY_ENABLED` | false | S1 | pai-memory MCP server | Channels research |
| `MCP_CONTEXT_ENABLED` | false | S1 | pai-context MCP server | Channels research |
| `LOOP_DETECTION_ENABLED` | true | S1 | Loop detection middleware (safety) | DeerFlow |
| `BRIDGE_CONTEXT_INJECTION` | legacy | S2 | hooks vs legacy context injection | Claude Code hooks |
| `REMOTE_CONTROL_ENABLED` | false | S2 | Remote Control daemon | Claude Code |
| `A2A_ENABLED` | false | S2 | A2A agent server | A2A Protocol (LF) |
| `PLAYBOOK_ENABLED` | false | S3 | Playbook engine | Maestro |
| `WORKTREE_ENABLED` | false | S3 | Git worktree pool | Maestro |
| `WORKTREE_MAX_SLOTS` | 3 | S3 | Max concurrent worktrees | Maestro |
| `CONTEXT_COMPRESSION_ENABLED` | false | S3 | Context compression | Maestro + Lossless-Claw |
| `GROUP_CHAT_ENABLED` | false | S4 | Group chat moderator | Maestro |
| `GUARDRAILS_ENABLED` | false | S4 | Pre-tool-call authorization | DeerFlow |
| `A2A_CLIENT_ENABLED` | false | S4 | A2A outbound client | A2A Protocol (LF) |

**Note:** `LOOP_DETECTION_ENABLED` defaults to **true** — it's a safety control, not a feature.

## Schema Changes

All additive (no column renames, no drops):
- S1: New `summaries` table + indexes, `confidence REAL DEFAULT 1.0` on episodes, FTS5 UPDATE trigger
- S2: Optional `sender`, `recipient`, `intent`, `correlation_id` fields on PipelineTaskSchema
- S3: New `compressed_episodes` table, `compressed_into` column on episodes, new `playbooks` table
- S4: `user_id` and `channel` columns on episodes (for group chat)

## Conflict Verification (expanded per Codex P3-1)

**Original 8 conflicts (all clear):**
1. A2A port vs Dashboard → shared HttpServer, independent flags (P1-2 fixed)
2. Loop detection vs RateLimiter → different layers (conversation cycles vs API 429s)
3. ACP envelopes on PipelineTask → optional fields, `.strict()` still validates existing tasks
4. Confidence vs Importance → orthogonal dimensions (reliability vs significance)
5. Turn recovery vs existing retry → unified RecoveryPolicy class (P2-3 fixed)
6. Guardrails vs injection scan → different layers, guardrails scoped to bridge-owned ops (P1-1 fixed)
7. ACP envelopes vs Gregor → wrap format, auto-detect envelope vs bare task
8. Two-phase summarization vs synthesis → add FTS5 UPDATE trigger

**Additional conflicts identified by Codex P3-1 (all resolved):**
9. Retrieval isolation vs existing queries → `channelScope` parameter with "1:1" default (P1-3 fixed)
10. Migration version skew (partial deploy) → transactional migration runner with rollback (P1-4 fixed)
11. Dashboard/A2A auth topology → `/.well-known` is public, `/a2a/*` requires token (P1-2 fixed)
12. Bun compatibility for `a2a-node-sdk` → verified pure TypeScript, no native bindings (P3-3 fixed)
13. SSE/proxy behavior on VPS → nginx already proxies Dashboard; A2A SSE uses same path. Test `Transfer-Encoding: chunked` in smoke test

## Observability Matrix (Codex P3-2)

Metrics to track after deployment — implemented via HealthMonitor extensions in S4:

| Metric | Source | Alert Threshold |
|--------|--------|----------------|
| Summarizer fallback tier hits | `summarizer.ts` | >50% deterministic = quality issue |
| Loop detection activations | `loop-detection.ts` | Any phase-3 hard stop = investigate |
| Hook failures (UserPromptSubmit) | `hooks/*.ts` | >5% failure rate = broken context |
| A2A request latency | `a2a-server.ts` | p95 > 30s = investigate |
| A2A error rate | `a2a-server.ts` | >10% = connectivity/auth issue |
| Worktree cleanup failures | `worktree-pool.ts` | Any stale worktree > 1h = disk risk |
| Feature flag combination coverage | `config.ts` | Test: all-off, all-on, each individually |
| Migration version vs expected | `migration.ts` | Mismatch = partial deploy |
| Memory confidence decay rate | `memory.ts` | >20% GC per day = threshold too aggressive |

## MCP/A2A Deployment Details (Codex P3-3)

### MCP Server Process Supervision
- MCP servers are **child processes of Claude Code** (spawned via `.mcp.json` config)
- Claude Code manages lifecycle — no separate systemd service needed
- If Claude Code restarts, MCP servers restart automatically
- Process ownership: `isidore_cloud` user, same as bridge
- Bun binary: `/usr/local/bin/bun` (symlinked, already verified on VPS)

### A2A Server Process Supervision
- A2A runs **inside the bridge process** (route provider on shared HttpServer)
- No separate process — lifecycle tied to bridge systemd service
- SSE streaming uses Bun's native `ReadableStream` — no additional proxy config needed

### Bun Compatibility Verification
| Package | Bun Compatible | Verified |
|---------|---------------|----------|
| `@modelcontextprotocol/sdk` | Yes (pure TS) | Needs test in S1 |
| `a2a-node-sdk` | Yes (pure TS) | Needs test in S2 |
| `qrcode` | Yes (pure JS) | Needs test in S4 |

### VPS Nginx Considerations
- Current nginx config proxies port 3456 (dashboard)
- A2A routes on same port — no nginx changes needed
- SSE endpoints (`/a2a/message/stream`): verify `proxy_buffering off` in nginx config
- `/.well-known/agent-card.json`: verify nginx doesn't intercept `.well-known` paths

## Load-Bearing Review (Anthropic principle: strip what's not needed)

Components to stress-test during implementation. If they're not load-bearing, remove them:

| Component | Assumption It Encodes | How to Test | If Not Load-Bearing |
|---|---|---|---|
| Auto-wrapup at 70% | Claude loses coherence near context limits | Run Opus 4.6 to 85-90% fill, compare output quality | Raise threshold to 85%, make suggestion-only |
| `compactFormat()` | Claude outputs too much Algorithm verbosity | Test with better system prompt instructions | Remove formatter, rely on prompt |
| MessageClassifier (Sonnet fast-path) | Simple messages don't need Opus | Compare latency/quality of Opus on simple queries | Remove classifier, route everything to Opus |
| Context injection via hooks | Claude won't proactively call MCP memory tools | Test with CLAUDE.md instruction "always call memory_recall" | Remove hooks, rely on MCP tools + CLAUDE.md |
| Three-tier summarization | LLM summarization fails often enough to need fallback | Track fallback tier hit rates | If >95% normal succeeds, simplify to two tiers |
| Sprint contracts | Agents produce wrong output without pre-agreement | Run worktree tasks with and without contracts, compare | Remove contract step, save one roundtrip |

**Scheduled review:** After S1 completes and Opus 4.6 is the primary model, run a 2-hour stress test of the existing bridge without auto-wrapup, compactFormat, and MessageClassifier. Measure quality degradation. Strip what doesn't degrade.

## Risk Mitigation (expanded per Codex findings)

| Risk | Mitigation | Codex Finding |
|------|-----------|---------------|
| MCP protocol changes | Pin SDK version, minimal surface (10 tools) | — |
| A2A spec evolution | Use `a2a-node-sdk`, thin adapter (~300 lines) | P3-3 |
| Channels removed from preview | Bridge stays primary — supplementary only | — |
| LLM summarization quality | Deterministic fallback always available | — |
| Worktree disk pressure | ResourceGuard monitors; worktrees share .git | — |
| Session budget overrun | 50% of 1M = 500K tokens; **LOC plausible but integration/ops underestimated** (Codex P2-4). Mitigation: allocate extra buffer in S4 for ops surprises | P2-4 |
| Turn recovery replacing guards | Unified RecoveryPolicy across all 4 invocation paths | P2-3 |
| Schema migration on live DB | Versioned migration runner with transactions + rollback | P1-4 |
| Guardrails scope overreach | Explicitly scoped to bridge-owned ops, not Claude-native tools | P1-1 |
| A2A depending on Dashboard | Shared HttpServer, independent feature flags | P1-2 |
| Group chat memory pollution | Retrieval isolation via channelScope parameter | P1-3 |
| Partial deploy version skew | Migration runner checks version before proceeding | P1-4 |
| Bun SDK compatibility | All new npm packages verified pure TypeScript | P3-3 |

## Codex Review Resolution (v3→v4)

**Reviewer:** Codex GPT-5.4, 79,327 tokens used
**Date:** 2026-03-25

| ID | Severity | Finding | Resolution | Where |
|---|---|---|---|---|
| P1-1 | P1 | Guardrails has no universal tool boundary | Scoped to bridge-owned ops only. Explicit in plan. | S4 Phase B |
| P1-2 | P1 | A2A depends on Dashboard enabled | Extracted HttpServer from Dashboard. Independent flags. | S1 Phase D2 |
| P1-3 | P1 | Group chat memory leaks across channels | Added retrieval isolation with channelScope param. | S4 Phase C2 |
| P1-4 | P1 | Migration story too thin for live DB | Added schema migration runner with versioning + rollback. | S1 Phase A0 |
| P2-1 | P2 | Loop detection under-scoped (no proc-cancel) | Added `ClaudeInvoker.cancel()` + proc kill on hard stop. | S1 Phase D |
| P2-2 | P2 | Dependency graph too optimistic | S1 now prerequisite to S2/S3, not peer. Stricter ordering. | Dependency Graph |
| P2-3 | P2 | Turn recovery only covers send() | Unified RecoveryPolicy across all 4 invocation paths. | S2 Phase D |
| P2-4 | P2 | Scope sizing optimistic (ops underestimated) | Acknowledged. Buffer in S4 for ops surprises. | Risk Mitigation |
| P3-1 | P3 | 8 conflict checks missed additional conflicts | Added 5 more conflict checks (#9-#13). | Conflict Verification |
| P3-2 | P3 | No observability matrix | Added 9-metric observability matrix with thresholds. | Observability Matrix |
| P3-3 | P3 | MCP/A2A deploy details underspecified | Added process supervision, Bun compat table, nginx notes. | Deployment Details |

**All 11 findings addressed in v3. v4 applied Anthropic "simplest solution" principle:**
- P1-2: Simplified from HTTP extraction → declared dependency (`A2A_ENABLED` requires `DASHBOARD_ENABLED=1`)
- P1-4: Deferred migration runner → keep idempotent ALTERs until pattern breaks
- Added: evaluator agent in playbooks (Anthropic GAN), sprint contracts in worktrees (Anthropic)
- Added: load-bearing review checklist to strip scaffolding post-implementation

## Origin Tracking

| Pattern | Source Framework | Extraction Type | Session |
|---------|-----------------|-----------------|---------|
| DAG Summarization | Lossless-Claw | Concept rewrite | S1 |
| Fresh-tail protection | Lossless-Claw | Concept rewrite | S1 |
| Three-tier fallback | Lossless-Claw | Pattern adapt | S1 |
| Two-phase summarization | DeepAgents (LangChain) | Pattern adapt | S1 |
| Memory confidence scoring | DeerFlow (ByteDance) | Column + logic | S1 |
| Loop detection middleware | DeerFlow (ByteDance) | Pattern rewrite (50 lines) | S1 |
| MCP Memory/Context Servers | Claude Channels research | New build | S1 |
| UserPromptSubmit hook | Claude Code hooks | Native feature | S2 |
| Turn recovery policy | Letta Code | Pattern adapt | S2 |
| A2A agent server | A2A Protocol (Linux Foundation) | SDK + glue | S2 |
| Permission relay | Claude Channels | Native feature | S2 |
| Remote Control | Claude Code | Native feature | S2 |
| Markdown Playbooks | Maestro Auto Run | Concept rewrite | S3 |
| Clarification-first | DeerFlow (ByteDance) | Prompt pattern | S3 |
| Worktree Agent Pool | Maestro Worktrees | Concept rewrite | S3 |
| Context Compression | Maestro + Lossless-Claw | Hybrid adapt | S3 |
| Guardrails middleware | DeerFlow (ByteDance) | Pattern adapt | S4 |
| A2A client | A2A Protocol (Linux Foundation) | SDK + glue | S4 |
| Group Chat Moderator | Maestro Group Chat | Concept rewrite | S4 |
| QR Code Access | Maestro Remote | Pattern adapt | S4 |
| Playbook evaluator agent | Anthropic Harness (GAN pattern) | Pattern adapt | S3 |
| Sprint contracts | Anthropic Harness | Pattern adapt | S3 |
| Load-bearing review | Anthropic Harness ("strip scaffolding") | Process | Post-S1 |
| Simplest solution principle | Anthropic Harness | Design principle | All |
