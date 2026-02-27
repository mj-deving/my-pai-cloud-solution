# Nightwire Architecture Analysis

> **Date:** 2026-02-27
> **Repo:** [hackingdave/nightwire](https://github.com/hackingdave/nightwire)
> **Purpose:** Strategic analysis of Nightwire for lessons applicable to our Isidore Cloud bridge
> **Authors:** Gregor (Gregor-side explore) + Isidore (deep analysis)

Nightwire is Daniel's Signal-based coding bot — same philosophy as our system (Telegram-based), but Python + Signal instead of our Bun/TypeScript + Telegram stack.

---

## Gregor's Analysis (Explore)

### What They Have That We Could Learn From

#### 1. Worker-Verifier Separation (Strongest Insight)

Every task gets executed by one Claude context, then independently verified by a separate Claude context that only sees the git diff + acceptance criteria. Fail-closed: any security concern or logic error blocks completion. Auto-fix retries up to 2x before escalating.

**Our gap:** Our reverse-handler just runs `openclaw agent` and trusts the output. No independent verification. When we implement overnight workflows, bad code could merge unchecked.

#### 2. Quality Gates with Test Baseline Snapshots

Before each task: snapshot test state. After: compare. `new_failures = current - baseline`. Pre-existing failures don't block; only NEW regressions do.

**Our gap:** We have no test baseline tracking. When Gregor or Isidore produces code, there's no automated regression check before results flow back.

#### 3. Resource Guard (Pre-flight Checks)

Before spawning workers: check memory >90% or <512MB free -> defer task. Prevents VPS resource exhaustion during overnight parallel execution.

**Our gap:** Our bridge spawns `claude -p` workers without checking VPS resources. With overnight orchestrated workflows running parallel steps, we could exhaust 24GB RAM.

#### 4. Rate Limit Cooldown (Global, not per-request)

3 failures in 5 minutes -> global cooldown for 60 minutes. One notification, auto-resume. Not per-request retry — global pause.

**Our gap:** Our bridge has per-request error handling but no global cooldown. If Claude Max hits its cap mid-workflow, each step would fail independently rather than pausing cleanly.

#### 5. PRD -> Story -> Task Hierarchy with Dependency DAG

Three-level decomposition with cycle detection. Tasks have explicit dependencies checked before dispatch.

**Our status:** Our bridge orchestrator already does DAG decomposition (workflows with steps). Similar pattern — we're close here.

#### 6. Stale Task Recovery

Tasks stuck IN_PROGRESS >60 minutes auto-requeue or auto-fail on restart.

**Our status:** Our `pai-workflow-monitor.sh` (Phase 5 item 6) covers this — 1h stale detection with alerting. Similar approach.

#### 7. Git Checkpoint per Task

Auto-commit before execution, auto-commit after. Each task isolated in its own commit. Enables rollback.

**Our gap:** Bridge does branch isolation (Phase 5 bridge side) but Gregor's reverse-handler doesn't checkpoint before executing `openclaw agent`.

### What We Have That They Don't

- **Bidirectional delegation** (Gregor <-> Isidore) — Nightwire is single-agent
- **Filesystem pipeline with inotify** — they use SQLite polling at 30s intervals
- **Dual-model architecture** (cheap Sonnet for routine, expensive Opus for complex) — they only use Claude
- **Separate Linux users with group permissions** — they run single-process

### Gregor's Priority Recommendations

| Priority | Insight | Effort | Impact |
|----------|---------|--------|--------|
| **HIGH** | Add resource guard to bridge before spawning workers | Small (~30 lines) | Prevents VPS OOM during overnight |
| **HIGH** | Add global rate-limit cooldown to bridge | Medium | Prevents cascade failures at Max cap |
| **MEDIUM** | Independent verification for reverse-task results | Medium | Catches bad code from Gregor |
| **MEDIUM** | Test baseline snapshots in quality gates | Medium | Regression detection for code tasks |
| **LOW** | Git checkpoint in reverse-handler before agent exec | Small | Enables rollback on failed tasks |

---

## Isidore's Analysis (Deep Dive)

### Nightwire Architecture Map

```
+---------------------------------------------------------+
|  NIGHTWIRE (Python 3.9+ / systemd)                      |
|                                                          |
|  Signal CLI API  -->  bot.py  -->  claude_runner.py      |
|  (Docker)        <--  (commands,   (spawns claude CLI,   |
|                       routing)     timeouts)             |
|                                                          |
|  autonomous/              memory/                        |
|  - manager.py             - manager.py                   |
|  - executor.py            - embeddings.py                |
|  - loop.py                - context_builder.py           |
|  - verifier.py            - database.py (SQLite)         |
|  - quality_gates.py       - haiku_summarizer.py          |
|  - learnings.py                                          |
|                                                          |
|  project_manager   security        plugin_loader         |
|  prd_builder       rate_limit      skill_registry        |
|  sandbox           resource_guard  updater               |
+---------------------------------------------------------+
```

### Feature-by-Feature Comparison

| Capability | Nightwire | Our Bridge (Isidore Cloud) | Gap |
|---|---|---|---|
| **Messaging platform** | Signal (E2E encrypted, Docker) | Telegram (Grammy) | Different choice, both valid |
| **AI invocation** | `claude_runner.py` — spawns Claude CLI | `ClaudeInvoker` — spawns Claude CLI | Equivalent |
| **Session management** | Per-project sessions | Per-project sessions (`ProjectManager`) | Equivalent |
| **Multi-project support** | `/projects`, `/select`, `projects.yaml` | `/project`, `config/projects.json` | Equivalent |
| **Cross-user pipeline** | Not present | PipelineWatcher + ReversePipeline (Gregor collab) | **We're ahead** |
| **DAG orchestrator** | PRD -> Stories -> Tasks (3-level) | TaskOrchestrator (DAG decomposition) | Both have it, different approaches |
| **Parallel execution** | Up to 10 concurrent workers | `PIPELINE_MAX_CONCURRENT=3` | They're ahead (10 vs 3) |
| **Independent verification** | Separate Claude context verifies each task | Not present | **Major gap** |
| **Quality gates** | Test baselines, regression detection, auto-fix | Not present | **Major gap** |
| **Memory system** | SQLite + vector embeddings, semantic `/recall` | Session files + MEMORY.md + handoff-state.json | **Major gap** |
| **Rate limit handling** | Cooldown system — pauses all ops, auto-resumes | Not present | **Gap** |
| **Security hardening** | Phone allowlist, rate limiting, path validation, resource guard, sandbox | Telegram user ID check only | **Gap** |
| **Plugin architecture** | Plugin loader + skill registry | Not present | Gap |
| **Auto-update** | Built-in `/update` command | Manual `deploy.sh` | Gap |
| **Branch isolation** | Git checkpoints before tasks | `BranchManager` — per-task branches | **We're ahead** |
| **Lightweight assistant** | `/nightwire` — optional OpenAI/Grok for quick answers | Not present | Gap |
| **Learnings capture** | `/learnings` — persists insights from tasks | MEMORY.md + wrapup.ts | Roughly equivalent |
| **Formatting** | Direct Signal output | `compactFormat()` + `chunkMessage()` + `escMd()` | **We're ahead** |
| **Crash recovery** | Stale task recovery on restart | Serializable PendingDelegation + dir scan | Both have it |

### Architectural Lessons & Adoption Paths

#### Lesson 1: Independent Verification — ADOPT

Every autonomous task gets reviewed by a *separate* Claude context. Fail-closed — rejections block merge.

**Adoption path:** Add a `verifier.ts` module. After each pipeline/orchestrator task completes, spawn a second `claude -p` with "review this diff for bugs, security issues, and logic errors" + the git diff. Block result write until verification passes. 2 retry attempts before marking failed.

#### Lesson 2: Vector-Embedded Memory — ADAPT (Future/V2)

SQLite + sentence-transformer embeddings enable semantic `/recall` across all conversations.

**Adoption path:** V2-tier feature. Requires: (a) embedding model (could use Bun + `@xenova/transformers`), (b) SQLite via `bun:sqlite`, (c) index conversations at wrapup time, (d) inject relevant context into Claude prompts.

#### Lesson 3: Rate Limit Cooldown System — ADOPT

Detects Claude subscription caps, pauses ALL operations, notifies users, auto-resumes.

**Adoption path:** Add a `rate-limiter.ts` module. Track Claude CLI exit codes/errors. On 3 failures in 5 min -> pause pipeline + orchestrator, notify via Telegram, auto-resume after configurable cooldown.

#### Lesson 4: Resource Guard — ADOPT

Pre-flight resource checks before spawning workers.

**Adoption path:** Add resource check in pipeline dispatch. Check available memory before spawning Claude CLI. Defer task if resources insufficient. ~30 lines.

#### Lesson 5: Quality Gates with Test Baselines — ADOPT (when tests exist)

Snapshot test results before task, re-run after, diff. New failures = regression = block.

**Adoption path:** When projects have test suites, capture baseline before dispatch, run after completion, diff results.

#### Lesson 6: Plugin Architecture — SKIP

Adds complexity we don't need at current scale (~8 modules).

#### Lesson 7: Lightweight Quick-Response Assistant — ADAPT

Route simple questions to a cheap model instead of burning Claude context.

**Adoption path:** Add `/quick` command routing to Haiku or similar lightweight model.

#### Lesson 8: Sandbox Execution — SKIP

We already have branch isolation (Phase 5C) which provides similar safety via git.

### Where We're Already Better

1. **Cross-user collaboration.** Nightwire is single-user. Our Gregor pipeline + reverse pipeline enables genuine multi-agent cross-user collaboration.
2. **Branch isolation.** Our `BranchManager` creates per-task branches with lock files and atomic state. Nightwire uses simpler git checkpoints.
3. **DAG dependencies.** Our orchestrator handles arbitrary dependency graphs with cycle detection. Nightwire's PRD->Story->Task is a tree — no cross-story dependencies.
4. **Output formatting.** `compactFormat()` + `chunkMessage()` + `escMd()` handles Telegram's quirks properly.
5. **Bun/TypeScript stack.** Single-language with Claude Code's native ecosystem.
6. **Session sharing.** SSH/tmux + Telegram session sharing via `active-session-id` enables multi-channel access.
7. **Dual-model architecture.** Cheap Sonnet for routine, expensive Opus for complex. They only use Claude.
8. **Filesystem pipeline.** inotify-based vs their 30s SQLite polling.

---

## Evolution Scope Assessment

### Scope A: Incremental Future Steps (RECOMMENDED)

Cherry-pick highest-value patterns. No rewrite. No new framework.

**Effort:** 2-4 sessions per feature. ~2 weeks total.
**Risk:** Low. Additive changes. Existing system untouched.

### Scope B: V2 Rewrite

Rebuild with Nightwire-inspired architecture (vector memory, plugin system, 3-level PRD hierarchy).

**Effort:** 4-8 weeks.
**Risk:** High. Would lose deployment stability for uncertain gains.
**Verdict:** Not justified yet. Revisit when we hit scaling walls.

### Scope C: Full Overhaul (Fork Nightwire)

Fork Nightwire, port our features on top.

**Verdict:** Hard no. Python/Signal language+platform switch loses our strongest features (cross-user pipeline, branch isolation) for things we can adopt incrementally.

---

## Unified Priority Recommendations (Both Analyses Combined)

| # | Feature | Value | Effort | Phase |
|---|---------|-------|--------|-------|
| **1** | Resource guard (pre-flight memory check) | High — prevents VPS OOM | Small (~30 lines) | Phase 6A |
| **2** | Rate limit cooldown (global pause/resume) | High — prevents cascade failures | Medium (1-2 sessions) | Phase 6A |
| **3** | Independent verification (separate Claude context) | Very High — trust in pipeline output | Medium (2 sessions) | Phase 6B |
| **4** | `/quick` lightweight model routing | Medium — UX + cost savings | Small (1 session) | Phase 6C |
| **5** | Increase parallel workers (3 -> 8) | Medium — throughput | Tiny (config + test) | Phase 6C |
| **6** | Quality gates (test baselines) | High — regression prevention | Medium (2 sessions) | Phase 7 |
| **7** | Git checkpoint in Gregor reverse-handler | Medium — enables rollback | Small | Phase 7 |
| **8** | Vector-embedded memory (SQLite + embeddings) | Very High — context quality | Large (4-6 sessions) | V2 |
| **9** | Plugin architecture | Low — extensibility | Large | V2+ |

---

## Per-Module Impact Map (Bridge Side)

| Module | Change | Impact |
|---|---|---|
| **bridge.ts** | Wire in rate-limit cooldown; add `/quick` routing | Low |
| **telegram.ts** | New `/quick` command handler; cooldown status command | Low |
| **claude.ts** | Report rate-limit signals to cooldown module | Low |
| **pipeline.ts** | Resource guard pre-check; post-dispatch verification; cooldown pause | Medium |
| **orchestrator.ts** | Verification before `completeStep()` | Medium |
| **reverse-pipeline.ts** | Verification of Gregor results before routing | Low |
| **branch-manager.ts** | No change needed | None |
| **config.ts** | New config fields: cooldown duration, verification toggle | Low |
| **format.ts** | No change needed | None |
| **wrapup.ts** | No change needed | None |
| **session.ts** | No change now (V2: replace with SQLite-backed sessions) | None / High (V2) |
| **NEW: verifier.ts** | Spawn verification Claude, parse verdicts | New file |
| **NEW: rate-limiter.ts** | Track failures, manage cooldown state | New file |
| **NEW: resource-guard.ts** | Pre-flight VPS resource checks | New file |
