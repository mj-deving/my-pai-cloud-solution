# First Principles Decomposition: Minimum Viable Agent Framework for PAI L3-4

**Date:** 2026-03-02
**Method:** First Principles Decomposition
**Question:** What is the minimum viable custom agent framework needed to evolve PAI from Level 2-3 to Level 3-4 autonomy?

---

## Part 0: Challenging the Premise

**Do we need "a framework" at all?**

The word "framework" implies a new abstraction layer -- a new system that sits between PAI and its existing components, providing structure, conventions, and runtime. Before we build one, we must ask: what does PAI already have that functions as a framework?

**PAI already has a framework. It just isn't named one.**

| Framework Function | PAI Already Has |
|---|---|
| Agent invocation | `ClaudeInvoker` (send, oneShot, quickShot) |
| Task decomposition + DAG execution | `TaskOrchestrator` |
| Cross-agent communication | Pipeline + ReversePipeline (JSON files) |
| Agent identity | Agent Registry (SQLite), persona field |
| Memory (episodic) | `MemoryStore` (SQLite + FTS5) |
| Memory (knowledge) | `MemoryStore.knowledge` table |
| Context injection | `ContextBuilder` |
| Session management | `SessionManager` (per-project sessions) |
| State transfer | `HandoffManager` |
| Quality gates | Rate limiter, resource guard, verifier, Zod schemas |
| Scheduling/triggers | `PipelineWatcher.poll()` (5s interval) |
| Output routing | `MessengerAdapter` (Telegram, future: email) |

**The question is not "what framework should we build?" but "what specific capabilities are missing that prevent L3-4 autonomy, and what is the minimum code to add them?"**

---

## Part 1: Irreducible Requirements for L3-4 Autonomy

### Defining the Levels

| Level | Name | Core Characteristic | Human Role |
|---|---|---|---|
| L2 | Partial Automation | System assists within sessions | Human initiates everything, approves all actions |
| L3 | Conditional Autonomy | System operates within defined boundaries | Human sets boundaries, reviews exceptions |
| L4 | High Autonomy | System handles broad scope independently | Human sets goals, monitors outcomes |

### The Five Irreducible Requirements

Stripping to physics-level truth: what MUST an agent have to operate at L3-4 that it does NOT need at L2?

**R1: SELF-INITIATION** -- The system must be able to start work without a human trigger.

At L2, every action begins with a human message. At L3-4, the system must be able to wake itself up and begin working based on: scheduled tasks, observed conditions (file changes, incoming pipeline tasks, time-based triggers), or its own determination that something needs doing.

**R2: BOUNDARY AWARENESS** -- The system must know what it is and is not authorized to do, without asking each time.

At L2, the human approves each plan. At L3, the system must have a machine-readable policy that says "you may do X, Y, Z autonomously; you must ask before doing A, B, C; you must never do D, E, F." This is the difference between a tool (does what you tell it) and an agent (knows what it should do).

**R3: CONTINUOUS OPERATION** -- The system must survive session boundaries and maintain coherent state across them.

At L2, session = conversation. Session ends, state is lost (or manually carried in CLAUDE.local.md). At L3-4, the system must: persist its work state across restarts, resume interrupted tasks, and maintain a running understanding of "what am I working on" without the human re-explaining.

**R4: OUTCOME EVALUATION** -- The system must be able to assess whether its own work succeeded or failed, and adjust.

At L2, the human evaluates quality. At L3-4, the system needs: built-in verification (already have Verifier), success criteria it can check programmatically, and the ability to retry or escalate on failure. ISC criteria in the Algorithm already do this for interactive sessions -- the gap is doing it for autonomous tasks.

**R5: SYNTHESIS LOOP** -- The system must learn from its operations and improve its own context over time.

At L2, MEMORY.md is manually curated. At L3-4, the system must: distill patterns from completed work, update its own knowledge base, prune stale information, and inject relevant learned patterns into future tasks. This is the difference between a system with memory (stores episodes) and a system that learns (synthesizes knowledge from episodes).

---

## Part 2: What PAI Already Satisfies

### R1: Self-Initiation -- PARTIALLY SATISFIED

**What exists:**
- `PipelineWatcher.poll()` already self-initiates: it polls every 5s, picks up tasks, dispatches them. This IS self-initiation for cross-agent work.
- `TaskOrchestrator.advanceWorkflow()` automatically dispatches next steps when dependencies resolve. This IS autonomous execution.
- `HandoffManager` has an inactivity timer (30min) that auto-writes handoff state.

**What's missing:**
- No cron/schedule layer. The bridge runs continuously but cannot say "at 9am, run the daily synthesis." There's no `ScheduledTask` concept.
- No event triggers beyond poll-based file watching. Cannot say "when this git repo gets a PR, do X."
- No self-determined initiation. The system cannot look at its knowledge and decide "I should proactively do X."

**Gap size: SMALL.** Add a scheduler (cron-like task table in SQLite) and a "proactive check" hook to the existing poll loop. 1 new file, ~150 lines.

### R2: Boundary Awareness -- NOT SATISFIED

**What exists:**
- Telegram auth middleware (checks user ID) -- binary access control, not boundary-aware.
- Pipeline per-project lock prevents cross-project contamination -- infrastructure boundary, not policy boundary.
- The Algorithm's ISC criteria are quality boundaries for interactive work.
- Feature flags in config.ts gate capabilities (PIPELINE_DEDUP_ENABLED, etc.) -- static, not per-task.

**What's missing:**
- No machine-readable policy file. Nothing says "for project X, you may commit directly; for project Y, you must create PRs."
- No action-level authorization. The system doesn't distinguish "safe to do autonomously" vs "requires approval."
- No escalation rules. When should the system ask the human vs proceed vs abort?

**Gap size: MEDIUM.** This needs a policy definition (YAML/JSON) plus a policy check function called before autonomous actions. 1-2 new files, ~200-300 lines. But the DESIGN is the hard part, not the code.

### R3: Continuous Operation -- PARTIALLY SATISFIED

**What exists:**
- `SessionManager` persists session IDs to file. Sessions survive bridge restarts.
- `HandoffManager` writes/reads structured state for cross-instance transfer.
- `TaskOrchestrator.loadWorkflows()` recovers active workflows from disk on restart.
- `ProjectManager` persists per-project session mapping in `handoff-state.json`.
- Pipeline uses atomic writes (.tmp -> rename) for crash safety.
- Agent Registry has heartbeat for liveness detection.

**What's missing:**
- No "work queue" for the interactive agent. Pipeline has a task queue, but Telegram-initiated work vanishes if the session dies mid-work. There's no "I was working on X, let me resume" for Telegram-originating tasks.
- No task state machine for interactive work. The orchestrator has one for pipeline workflows, but direct Telegram requests are fire-and-forget.
- ContextBuilder doesn't freeze snapshots -- it re-queries every invocation, which means context drifts and cache busts (the Hermes Agent pattern that saves ~75% cost).

**Gap size: SMALL.** The orchestrator's persistence model already works. Extend it: (a) add frozen snapshot to ContextBuilder (~30 lines), (b) optionally route complex Telegram requests through the orchestrator for persistence.

### R4: Outcome Evaluation -- MOSTLY SATISFIED

**What exists:**
- `Verifier` (Phase 6B) does independent result verification via separate Claude one-shot.
- `RateLimiter` tracks failure rates and applies cooldown.
- `TraceCollector` records decision traces for audit.
- Pipeline `dispatch()` checks exit codes and handles stale sessions.
- Orchestrator retries failed steps once before marking failed.

**What's missing:**
- No structured success criteria for autonomous tasks. The Algorithm's ISC works for interactive work, but pipeline tasks get dispatched with a prompt and no machine-checkable success criteria.
- No outcome recording. Tasks complete/fail but the system doesn't record "this type of task tends to fail because of X" in memory.

**Gap size: SMALL.** Add an optional `success_criteria` field to pipeline task schema + teach the verifier to check against it. Record outcomes in MemoryStore. ~50-100 lines of changes across existing files.

### R5: Synthesis Loop -- NOT SATISFIED

**What exists:**
- `MemoryStore.record()` stores episodes.
- `MemoryStore.distill()` exists but is NEVER CALLED. The knowledge distillation pathway exists in code but has no caller.
- `ContextBuilder.buildContext()` retrieves from memory but doesn't synthesize.
- The Algorithm's LEARN phase captures learnings in PRD files but they're never programmatically fed back.

**What's missing:**
- No periodic synthesis. Nothing runs "every N hours, look at recent episodes and distill knowledge."
- No pattern detection. The system doesn't notice "pipeline tasks for project X fail 40% of the time" or "this type of prompt produces poor results."
- No self-editing memory. MemGPT's core innovation -- the agent editing its own memory blocks -- doesn't exist. `MemoryStore.distill()` is the API, but no process calls it.
- No pruning/curation. Old knowledge entries never expire, episodes are pruned only by count, not by relevance.

**Gap size: MEDIUM.** Need a `SynthesisLoop` that runs periodically, queries recent episodes, calls Claude to distill patterns, writes to knowledge table, and prunes stale entries. 1 new file, ~200-300 lines. The MemoryStore API already supports this -- it's purely an orchestration gap.

---

## Part 3: The Minimum New Code

### Challenging Each Addition

For each gap, I ask: "Can this be solved by modifying existing code rather than writing new code?"

#### 1. Scheduler (R1: Self-Initiation)

**Could modify existing:** Add a cron check inside `PipelineWatcher.poll()`.
**Should be separate:** No. The pipeline poll loop is already complex. Adding schedule logic there violates single responsibility and makes the poll cycle slower.

**Minimum implementation:**
- `scheduler.ts` -- New file. SQLite table `scheduled_tasks` with fields: `id, cron_expression, task_type, task_config, last_run, next_run, enabled`. On bridge startup, loads schedule. Runs a setInterval (60s) that checks `next_run <= now`. When a task fires, it either: (a) writes a pipeline task JSON (reuses existing pipeline), or (b) calls `claude.oneShot()` directly, or (c) calls a registered callback.
- Modify `bridge.ts` -- Wire scheduler, register built-in schedules (daily synthesis, weekly review).
- Modify `config.ts` -- Add `SCHEDULER_ENABLED` flag.

**Lines: ~150-200 new, ~30 modified.**

#### 2. Policy Engine (R2: Boundary Awareness)

**Could modify existing:** Hardcode policies in individual modules.
**Should be separate:** YES. Policies must be inspectable, editable, and auditable. Scattering them across 31 files makes the system opaque -- the opposite of what L3-4 requires.

**Minimum implementation:**
- `policy.ts` -- New file. Loads a `policy.yaml` (or `.json`) that defines:
  ```yaml
  boundaries:
    - scope: "project/my-pai-cloud-solution"
      may: [commit, create-branch, run-tests, edit-src]
      must_ask: [push-to-main, delete-branch, deploy]
      never: [force-push, delete-files-outside-src]
    - scope: "pipeline/*"
      may: [dispatch, verify, ack]
      must_ask: [escalate-to-human]
      never: [modify-pipeline-infra]
  escalation:
    default: "notify-telegram"
    conditions:
      - when: "action_not_in_may"
        do: "ask-human"
      - when: "error_count > 3"
        do: "pause-and-notify"
  ```
  Exports: `canDo(scope, action): "allow" | "ask" | "deny"`, `getEscalationRule(condition): Action`.
- Modify `bridge.ts` -- Load policy, inject into orchestrator and pipeline.
- Modify `orchestrator.ts` -- Check policy before dispatching steps.
- Modify `pipeline.ts` -- Check policy before dispatch.

**Lines: ~200-250 new, ~40 modified.** But the hardest part is DESIGNING the policy schema, not coding the engine.

#### 3. Frozen Snapshot Memory (R3: Continuous Operation)

**Could modify existing:** YES. This is a change to `ContextBuilder`, not a new file.

**Minimum implementation:**
- Modify `context.ts` -- Add `private frozenContext: string | null = null` and `private frozenSessionId: string | null = null`. In `buildContext()`: if `frozenContext` exists and session ID hasn't changed, return frozen. Otherwise query, freeze, return. Add `freeze()` and `thaw()` methods. Add `setSessionId()` to track session changes.
- Modify `claude.ts` -- Call `contextBuilder.setSessionId()` when session changes.

**Lines: ~30-50 modified in existing files. Zero new files.**

#### 4. Synthesis Loop (R5: Synthesis Loop)

**Could modify existing:** Could add to HandoffManager's inactivity timer.
**Should be separate:** YES. Synthesis is a distinct concern from handoff. Coupling them means synthesis only runs on inactivity, not on schedule.

**Minimum implementation:**
- `synthesis.ts` -- New file. Periodically (every 6h or configurable):
  1. Query recent episodes from MemoryStore (last N hours)
  2. Group by project/source
  3. For each group with enough episodes: call `claude.quickShot()` with a distillation prompt
  4. Parse Claude's response into knowledge entries
  5. Call `MemoryStore.distill()` to store
  6. Prune knowledge entries older than N days with low access count
  7. Record the synthesis itself as an episode (meta-learning)
- Modify `bridge.ts` -- Wire synthesis loop, connect to scheduler.
- Modify `config.ts` -- Add `SYNTHESIS_ENABLED`, `SYNTHESIS_INTERVAL_HOURS`.

**Lines: ~200-250 new, ~20 modified.**

#### 5. Work Queue for Interactive Tasks (R3 supplement)

**Could modify existing:** YES. Route complex Telegram requests through existing orchestrator.
**Should be separate:** No need for a new module.

**Minimum implementation:**
- Modify `telegram.ts` -- For messages that match complexity heuristics (long messages, PRD-like, multi-step), create a workflow via orchestrator instead of direct `claude.send()`. This already exists as `PRDExecutor` detection -- extend the pattern.
- This is a wiring change, not a new module.

**Lines: ~30-50 modified.**

---

## Part 4: Framework Features -- Genuinely Needed vs Nice-to-Have

### From MemGPT/Letta

| Feature | Verdict | Reasoning |
|---|---|---|
| Self-editing memory blocks | **GENUINELY NEEDED** (R5) | Core of synthesis loop. But: don't need MemGPT's "LLM as OS" architecture. Just need `distill()` to be called by the synthesis loop. Already have the API. |
| Recursive summarization of FIFO queue | **NICE-TO-HAVE** | Claude's server-side compaction handles this. We use `--resume` which delegates to Anthropic. |
| Sleep-time compute | **NICE-TO-HAVE** (future) | Maps to synthesis loop running during idle. We get 80% of the value from periodic synthesis without the complexity of a background daemon. |
| Memory pressure warnings | **NOT NEEDED** | We use Claude CLI, not raw API. Context management is Claude Code's problem. |
| Context Repositories (MemFS) | **NOT NEEDED** | Over-engineered for our scale. SQLite + FTS5 is sufficient. |

### From LangGraph

| Feature | Verdict | Reasoning |
|---|---|---|
| Namespace hierarchy for memory | **GENUINELY NEEDED** (R5) | Already partially implemented: MemoryStore has `project` and `source` fields. Need to formalize into namespace patterns and add filtering to search. ~20 lines. |
| Thread-level checkpointing | **NICE-TO-HAVE** | We use Claude's built-in session persistence. Time-travel/fork is Claude Code's feature (`--resume` from specific checkpoint). |
| Cross-thread Store | **ALREADY HAVE** | MemoryStore.knowledge table IS the cross-thread store. |
| Isolated subgraph state | **NOT NEEDED** | Pipeline tasks already run in isolated one-shot contexts. |

### From CrewAI

| Feature | Verdict | Reasoning |
|---|---|---|
| Hierarchical scope model | **NICE-TO-HAVE** | LangGraph namespaces accomplish the same thing more cleanly. |
| LLM-driven memory categorization | **NOT NEEDED** | Over-engineered. Source-tagging at write time (telegram/pipeline/workflow) is simpler and cheaper. |
| Composite scoring (semantic + recency + importance) | **NICE-TO-HAVE** | FTS5 BM25 + temporal decay covers 80%. Adding importance scoring is a future optimization. |

### From AutoGen/AG2

| Feature | Verdict | Reasoning |
|---|---|---|
| Context Variables (invisible structured state) | **GENUINELY NEEDED** (R2, R3) | Pipeline task metadata (project, priority, session_id) already works this way -- structured JSON that travels between agents but isn't injected into LLM prompts. Formalize this pattern for interactive tasks too. |
| Per-agent Model Context strategies | **NOT NEEDED** | We have one invocation model (Claude CLI). Context strategy is frozen-snapshot + memory injection. |
| HeadAndTailChatCompletionContext | **NOT NEEDED** | Claude's `--resume` handles conversation windowing internally. |

### From Hermes Agent

| Feature | Verdict | Reasoning |
|---|---|---|
| Frozen snapshot injection | **GENUINELY NEEDED** (R3) | Priority 1 from research. ~75% cost reduction. 30 lines of code. |
| Character-bounded curated memory | **GENUINELY NEEDED** (R5) | 5K char budget forces curation, prevents context rot. 10 lines in ContextBuilder. |
| Markdown agent definitions | **NICE-TO-HAVE** (future) | PAI already has 48 skill files as `.md`. Agent definitions would be a natural extension. But NOT needed for L3-4 -- the two current agents (Isidore, Gregor) are hardcoded in orchestrator and that's fine for now. |
| Progressive disclosure skills | **NICE-TO-HAVE** | Only matters when skill count causes context rot. With 48 skills, Claude Code manages this via its own skill loading. |

### From Semantic Kernel

| Feature | Verdict | Reasoning |
|---|---|---|
| Whiteboard pattern (running summary) | **GENUINELY NEEDED** (R3, R5) | Per-project running summary of decisions/state. But: this IS the knowledge table with namespace `whiteboard/{project}`. We just need the synthesis loop to populate it. |
| AIContextProvider interface | **NOT NEEDED** | Over-abstraction. `ContextBuilder.buildContext()` already serves this purpose. |

### From Claude Agent SDK

| Feature | Verdict | Reasoning |
|---|---|---|
| Compaction-immune rules | **GENUINELY NEEDED** | Critical rules that survive Claude's server-side compaction. But: this is a CLAUDE.md convention, not a code change. Rules already in CLAUDE.md persist because Claude Code re-reads it. |
| "Assume interruption" philosophy | **ALREADY HAVE** | HandoffManager auto-writes on shutdown and inactivity. |
| Subagents as context compression | **ALREADY HAVE** | Pipeline one-shot tasks are exactly this pattern. |

---

## Part 5: The Verdict

### You Do NOT Need a Framework

You need **4 targeted additions** to existing code:

| # | Addition | New Files | Modified Files | Lines | Satisfies |
|---|---|---|---|---|---|
| 1 | **Scheduler** | `scheduler.ts` | bridge.ts, config.ts | ~200 new, ~30 mod | R1 |
| 2 | **Policy Engine** | `policy.ts`, `policy.yaml` | bridge.ts, pipeline.ts, orchestrator.ts | ~250 new, ~40 mod | R2 |
| 3 | **Frozen Snapshot + Bounded Memory** | (none) | context.ts, claude.ts | ~50 mod | R3 |
| 4 | **Synthesis Loop** | `synthesis.ts` | bridge.ts, config.ts | ~250 new, ~20 mod | R5 |

**Total: 3 new TypeScript files + 1 policy config file. ~700 new lines, ~140 modified lines.**

R4 (Outcome Evaluation) is already mostly satisfied. The incremental improvement (structured success criteria + outcome recording) is ~50 lines across existing files and can be done alongside the synthesis loop.

### What This Gets You

With these 4 additions, PAI Cloud can:

1. **Self-initiate** -- Run scheduled tasks (daily synthesis, weekly reviews, overnight queues) via the scheduler. The pipeline already handles execution.

2. **Operate within boundaries** -- Check policy before autonomous actions. Escalate to Telegram when encountering `must_ask` actions. Never do `never` actions.

3. **Maintain continuous state** -- Frozen memory snapshots survive session boundaries. Synthesis loop maintains a running whiteboard of "what's happening in each project." Orchestrator already persists workflows across restarts.

4. **Learn from operations** -- Synthesis loop distills episodes into knowledge. Knowledge gets injected via ContextBuilder on future invocations. Bad patterns get flagged. Good patterns get reinforced.

5. **Evaluate outcomes** -- Verifier already checks results. Synthesis loop adds aggregate pattern recognition ("this type of task fails often").

### What This Does NOT Get You (and Why That's Fine)

- **Full L4 autonomy** -- That requires economic agency (managing budgets, making spend decisions), which is a separate concern from the agent framework.
- **Self-modifying agent definitions** -- The system can't create new specialized agents on the fly. But with 2 agents (Isidore + Gregor) and a DAG orchestrator, it can decompose and distribute any task. Adding more agents is a future optimization, not a requirement.
- **Real-time event triggers** -- The scheduler handles time-based triggers. Webhook/event triggers (e.g., "new PR filed") would need a webhook receiver. That's a separate feature, not a framework concern.
- **Multi-LLM orchestration** -- PAI uses Claude. Using different models for different tasks is a future optimization. The `quickShot()` method already supports model selection.

---

## Part 6: Implementation Order

### Phase A: Foundation (enables everything else)

**1. Frozen Snapshot Memory** (context.ts, claude.ts)
- Smallest change, highest immediate impact
- ~75% input token cost reduction from cache stability
- Prerequisite for making context injection production-safe
- 30-50 lines of modifications, zero new files
- Can be deployed and tested in 1 session

**2. Character-Bounded Memory Budget** (context.ts)
- 10 lines: add `maxChars` config, truncate in `buildContext()`
- Prevents context rot, makes memory injection safe to enable
- Deploy with conservative 3K char limit

### Phase B: Autonomy (the actual L3 capabilities)

**3. Scheduler** (scheduler.ts, bridge.ts, config.ts)
- SQLite table, setInterval check, dispatch to pipeline or oneShot
- Start with 2 built-in schedules: daily synthesis trigger, weekly review trigger
- Support user-defined schedules via Telegram commands (`/schedule add ...`)
- ~200 lines new

**4. Policy Engine** (policy.ts, policy.yaml, bridge.ts, pipeline.ts, orchestrator.ts)
- The design matters more than the code
- Start with project-level boundaries (may/must_ask/never actions)
- Wire `canDo()` check before orchestrator dispatch and pipeline execution
- Escalation defaults to Telegram notification
- ~250 lines new

### Phase C: Learning (upgrades L3 toward L4)

**5. Synthesis Loop** (synthesis.ts, bridge.ts, config.ts)
- Connect to scheduler (Phase B) for periodic execution
- Uses existing `MemoryStore.distill()` API
- Uses `claude.quickShot()` for lightweight distillation
- Populates per-project whiteboard entries in knowledge table
- ~250 lines new

**6. Outcome Recording** (pipeline.ts, orchestrator.ts, memory.ts)
- Record task outcomes (success/failure + metadata) as episodes
- Tag with `source: "outcome"` for synthesis loop to find
- ~50 lines modified across existing files

### Timeline Estimate

| Phase | Effort | Dependencies |
|---|---|---|
| A (Frozen + Bounded) | 1 session (~2h) | None |
| B (Scheduler + Policy) | 2-3 sessions (~6h) | A (for safe context injection) |
| C (Synthesis + Outcomes) | 2 sessions (~4h) | B (scheduler for triggers) |

**Total: ~5-6 sessions, ~12 hours of work.**

---

## Part 7: The Anti-Framework Argument (Why This Approach Wins)

### What "framework" projects typically build:
1. Abstract base classes for agents
2. Plugin registration systems
3. Configuration DSLs
4. Message bus / event systems
5. Generic lifecycle managers
6. Abstract memory interfaces

### Why each is wrong for PAI:

1. **Abstract agent base classes** -- PAI has 2 agents. Isidore is "Claude CLI with a session." Gregor is "Claude CLI without a session." An abstract `Agent` class adds a layer between the system and the actual work with zero benefit until agent count exceeds ~5.

2. **Plugin registration** -- PAI already has 48 skills loaded by Claude Code's own skill system. Adding another registration system creates a meta-problem: which registration system should skill X use?

3. **Configuration DSLs** -- `config.ts` with Zod validation already handles 60+ config values. A new DSL would be a second config system.

4. **Message bus / event systems** -- The pipeline (JSON files in `/var/lib/pai-pipeline/`) IS the message bus. It's simple, debuggable (ls + cat), crash-safe (atomic writes), and works across users (setgid). Replacing it with an in-process event bus would lose the cross-user capability.

5. **Generic lifecycle managers** -- `bridge.ts` already does graceful startup + shutdown with proper ordering. It's 400 lines and perfectly readable. An abstract lifecycle framework would add complexity for zero benefit.

6. **Abstract memory interfaces** -- `MemoryStore` with `record()`, `query()`, and `distill()` is already the interface. It's concrete, tested, and uses SQLite directly. Abstracting it "in case we switch to Postgres" optimizes for a scenario that may never happen.

### The principle:

**Add capabilities to the existing system. Don't build a system for building systems.**

PAI's architecture is already agent-framework-shaped. It just needs 4 specific capability gaps filled. Filling them directly (scheduler.ts, policy.ts, synthesis.ts, + modifications to context.ts) is faster, more testable, and more maintainable than building a generic framework that those 4 capabilities would then be built on top of.

The total cost of the direct approach: ~700 new lines + ~140 modified lines = ~840 lines of code.

The total cost of building a framework first: ~2000-3000 lines of framework + ~800 lines of capabilities built on the framework = ~3000+ lines, half of which add zero direct value.

**Build the capabilities. If patterns emerge that want extraction into a framework later, extract them. Don't speculate.**
