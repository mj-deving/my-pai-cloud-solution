# PAI Cloud Agent Framework — Vision, Decision Graph & Phased Roadmap

**Date:** 2026-03-02
**Method:** FirstPrinciples decomposition + 4-perspective Council debate + full codebase inventory
**Synthesis of:** 10 frameworks, 17 research agents, 700K+ tokens, 31 source files (7,687 LOC)

---

## 1. Vision

**PAI evolves from a Telegram bridge with pipeline support into a self-initiating personal agent system — through targeted extension of working code, NOT framework construction.**

The research, first principles analysis, and council debate all converge on one finding: **PAI already IS an agent framework.** It has agent invocation (`ClaudeInvoker`), task decomposition (`TaskOrchestrator`), cross-agent communication (pipeline JSON), agent identity (`AgentRegistry`), memory (`MemoryStore`), session management, and state transfer (`HandoffManager`). Building an abstract framework on top would add ~2000-3000 lines of scaffolding that provides zero direct capability.

**What's actually needed:** 4 targeted additions (~840 new lines + ~140 modified) to close the 5 irreducible gaps for L3-4 autonomy.

### Target Autonomy

| Level | Name | Status | After Plan |
|-------|------|--------|------------|
| L2 | Supervised | CURRENT | Maintained |
| L3 | Conditional Autonomy | GAP | ACHIEVED (Phase A+B) |
| L4 | High Autonomy | GAP | PARTIAL (Phase C+D, evolves over time) |

### Non-Goals (Explicit)
- Building a framework for others to build agents (this is personal infrastructure)
- Replacing Claude CLI with raw API (Claude Code's agentic loop IS our loop)
- Vector search infrastructure (FTS5 is sufficient per evidence)
- Persistent specialist daemon agents (cron + pipeline is sufficient)
- Python/Hermes clone (PAI's TS/Bun stack is already ahead)
- LLM summarization for context compression (observation masking is cheaper and better)
- Demos ecosystem integration (future milestone, NOT part of this plan)

### PAI Algorithm as Core Differentiator

The Algorithm stays human-interactive only. But its PRINCIPLES propagate to autonomous execution via a three-tier execution model:

| Tier | Name | When | How |
|------|------|------|-----|
| Tier 1 | Full Algorithm | Human-facing (Telegram) | 7 phases, ISC, PRD, voice |
| Tier 2 | Algorithm Lite | Autonomous complex tasks | 3 phases: CRITERIA→EXECUTE→VERIFY, max 10 turns |
| Tier 3 | One-Shot | Autonomous simple tasks | Single invocation, `--max-turns 1` |

---

## 2. Current State Assessment

### Codebase: 31 files, 7,687 LOC across 8 concerns

| Concern | Files | LOC | Status |
|---------|-------|-----|--------|
| CORE | 3 (bridge, config, session-cli) | 806 | STABLE |
| MESSAGING | 4 (telegram, adapter, interface, format) | 994 | STABLE (telegram.ts needs eventual command decoupling) |
| AGENT_EXECUTION | 2 (claude, session) | 372 | STABLE |
| PIPELINE | 3 (pipeline, orchestrator, reverse) | 1,558 | STABLE, ripe for L3-4 evolution |
| MEMORY | 4 (memory, context, embeddings, handoff) | 675 | WORKING BUT INCOMPLETE |
| QUALITY | 3 (schemas, decision-trace, verifier) | 563 | STABLE |
| INFRASTRUCTURE | 10 (rate-limiter, resource-guard, etc.) | 2,220 | STABLE |
| PRD | 2 (prd-executor, prd-parser) | 299 | WORKING |

### The 5 Irreducible L3-4 Gaps

| # | Gap | Existing Coverage | Missing Piece | Effort |
|---|-----|------------------|---------------|--------|
| R1 | Self-Initiation | PipelineWatcher polls, orchestrator dispatches | No scheduler/cron, no self-determined goals | SMALL (~200 lines) |
| R2 | Boundary Awareness | Auth middleware, feature flags | No machine-readable policy | MEDIUM (~250 lines) |
| R3 | Continuous Operation | Sessions, handoff, workflow recovery | No frozen snapshots, no interactive task persistence | SMALL (~50 lines) |
| R4 | Outcome Evaluation | Verifier, rate limiter, traces | No structured success criteria for autonomous tasks | SMALL (~50 lines) |
| R5 | Synthesis Loop | `MemoryStore.distill()` exists but NEVER CALLED | No periodic synthesis, no pattern detection | MEDIUM (~250 lines) |

---

## 3. Decision Graph

### Fork 1: Framework vs. Extension
**Decision: EXTEND with targeted features.**

Evidence: PAI's 31 files already implement every framework pattern. Building a framework adds ~2000+ lines of scaffolding. The direct approach: 3 new files + modifications = ~840 lines. The contrarian analysis (Section 13 of research) found that simpler systems consistently outperform complex ones. 17x error amplification in over-architected multi-agent systems.

**Two strategic abstractions allowed:** Markdown agent definitions (future, Phase C) and capability-aware agent registry extension (Phase C). Everything else stays as-is.

### Fork 2: Memory First vs. Autonomy First
**Decision: BOTH, in one sprint.**

The Hermes Agent Fan resolved this: memory foundation (frozen snapshot + bounded memory + injection scanning, ~250 lines) then lightweight autonomy (goal table + self-initiation poll, ~150 lines). Not separate phases — one combined sprint.

Why memory first: autonomous loops multiply invocation count; 75% cost reduction from frozen snapshots makes them economically viable. Autonomous decisions on bad context are dangerous.

Why not autonomy-only: the cost argument. Without frozen snapshots, running an autonomous loop burns 4x the API budget.

### Fork 3: Sniper Agents vs. Generalist vs. Hybrid
**Decision: Three-tier delegation model.**

1. **Isidore (orchestrator)** — persistent, interactive, full context, generalist
2. **Async pipeline workers** — existing one-shot pattern, stateless, isolated
3. **Sync sub-delegation** — NEW. Isidore spawns focused sub-agent within its turn, waits for result. Scoped context/tools/memory.

No persistent specialist daemons in v1. Cron + pipeline polling achieves 80% of daemon value with 10% complexity.

### Fork 4: Hermes Adoption Scope
**Decision: ~30% of Hermes patterns.**

| Type | Patterns | Phase |
|------|----------|-------|
| Direct adoption | Frozen snapshot, bounded memory, injection scanning | A |
| Direct adoption | Progressive skill disclosure, self-registration tools | C |
| Concept adoption | Bounded iteration loop, skill self-authoring | C-D |
| Skip | Python stack, OpenRouter, RL training, file-backed memory | N/A |

### Fork 5: Algorithm in Autonomous Agents
**Decision: Three-tier execution protocol.**

Full Algorithm = human-only. Algorithm Lite (criteria→execute→verify, max 10 turns) = autonomous complex tasks. One-shot = autonomous simple tasks. The Algorithm's cognitive scaffolding propagates via system prompt injection, not ceremony.

### Fork 6: Context Architecture
**Decision: Validated dual-mode (all 10 frameworks agree).**

| Mode | When | Context | Memory |
|------|------|---------|--------|
| Workspace | Pipeline/agent-to-agent | Lean (~1,400-2,000 tokens) | No injection or workspace-only |
| Project | Telegram/interactive | Full CLAUDE.md + session | Project-scoped, frozen snapshot |

PAI pipeline already implements Mode A correctly. Mode B needs frozen snapshot + bounded budget + project filtering.

---

## 4. Phased Roadmap

### Phase A: Context Foundation (1 session, ~400 lines changed)

**Entry criteria:** Research complete (done), codebase stable
**Exit criteria:** `CONTEXT_INJECTION_ENABLED=1` deployed on VPS with measurable cost reduction

| # | What | File(s) | Lines | Impact |
|---|------|---------|-------|--------|
| A1 | Frozen snapshot injection | `context.ts` | ~50 mod | ~75% input cost reduction |
| A2 | Character-bounded memory budget | `context.ts` | ~30 mod | Prevents context rot |
| A3 | Project + source filters on search() | `memory.ts` | ~80 mod | Per-project isolation |
| A4 | Injection scanning utility | `injection-scan.ts` (new) | ~80 new | Pipeline security |
| A5 | Config additions | `config.ts` | ~30 mod | Feature flags for above |
| A6 | Enable on VPS | deploy | 0 | Validate in production |

**Preserves:** All 31 existing files functional. Zero regressions. Additive changes only.

### Phase B: Scheduler + Policy (2-3 sessions, ~500 lines changed)

**Entry criteria:** Phase A deployed, context injection working
**Exit criteria:** System self-initiates scheduled tasks, respects policy boundaries

| # | What | File(s) | Lines | Impact |
|---|------|---------|-------|--------|
| B1 | Scheduler | `scheduler.ts` (new) | ~200 new | Self-initiation via SQLite cron |
| B2 | Policy engine | `policy.ts` (new) + `policy.yaml` | ~250 new | Machine-readable boundaries |
| B3 | Wire scheduler into bridge | `bridge.ts` | ~30 mod | Startup registration |
| B4 | Wire policy checks | `pipeline.ts`, `orchestrator.ts` | ~40 mod | Pre-dispatch authorization |
| B5 | Built-in schedules | `bridge.ts` | ~20 mod | Daily synthesis, weekly review |
| B6 | `/schedule` Telegram command | `telegram.ts` | ~40 mod | User schedule management |

**This achieves L3 autonomy:** System self-initiates within boundaries, escalates at edges.

### Phase C: Synthesis + Agent Definitions (2-3 sessions, ~600 lines changed)

**Entry criteria:** Phase B scheduler running, policy engine active
**Exit criteria:** Memory synthesis loop running, agent definitions loadable

| # | What | File(s) | Lines | Impact |
|---|------|---------|-------|--------|
| C1 | Synthesis loop | `synthesis.ts` (new) | ~250 new | Periodic knowledge distillation |
| C2 | Outcome recording | `pipeline.ts`, `orchestrator.ts` | ~50 mod | Success/failure episodes |
| C3 | Markdown agent definition format | `.pai/agents/*.md` | spec | Declarative agent templates |
| C4 | Agent definition loader | `agent-loader.ts` (new) | ~100 new | Parse + instantiate |
| C5 | Sync sub-delegation | `claude.ts` | ~120 mod | Scoped sub-agent invocation |
| C6 | Algorithm Lite prompt template | `prompts/algo-lite.md` | ~40 new | Autonomous reasoning protocol |

### Phase D: Advanced Patterns (Future, as needed)

| # | What | When | Impact |
|---|------|------|--------|
| D1 | Observation masking | Context rot occurs in production | 52% cost reduction, better quality |
| D2 | Whiteboard per project | Running summary needed | Better than raw episode retrieval |
| D3 | Progressive skill disclosure | Skills exceed ~60 count | Token-efficient loading |
| D4 | Skill self-authoring | Algorithm discovers reusable patterns | Self-improving skills |
| D5 | Goal persistence + self-initiation poll | Need autonomous goals beyond scheduler | Chained agency |
| D6 | Cache-friendly prompt ordering | Cost optimization needed | 78-80% savings on cached prefix |

---

## 5. Summary

### What we're building
4 targeted additions (scheduler, policy, synthesis, frozen snapshots) + 2 strategic abstractions (agent definitions, sub-delegation) to evolve PAI from L2 to L3-4 autonomy.

### What we're NOT building
An abstract agent framework, persistent specialist daemons, custom event system, vector search, or anything that duplicates what the 31 existing files already do.

### Total estimated effort
- Phase A: 1 session (~2h)
- Phase B: 2-3 sessions (~6h)
- Phase C: 2-3 sessions (~6h)
- Phase D: Ongoing as needed
- **Total to L3: ~8h across 3-4 sessions**

### The principle
**Add capabilities to the existing system. Don't build a system for building systems.** If patterns emerge that want extraction into a framework later, extract them. Don't speculate.

---

## Verification

1. **Phase A:** Deploy to VPS, compare API costs before/after frozen snapshot injection. Verify context injection doesn't pollute pipeline tasks (Mode A/B separation).
2. **Phase B:** Verify scheduler fires tasks on schedule. Verify policy engine blocks `never` actions and escalates `must_ask` to Telegram. Test boundary between autonomous and human-approved actions.
3. **Phase C:** Verify synthesis loop populates knowledge table from episodes. Verify agent definition loads and sub-delegation returns scoped results. Verify Algorithm Lite produces criteria→execute→verify output.
4. **All phases:** `bunx tsc --noEmit` passes. Deploy via `scripts/deploy.sh`. Live test via Telegram commands.

---

## Supporting Materials

| Document | Location |
|----------|----------|
| FirstPrinciples decomposition | `Plans/snug-cooking-goose-agent-aeb98949d0b937a10.md` |
| Council debate (5 forks, 4 perspectives each) | `Plans/snug-cooking-goose-agent-a165b82ea5fe3720b.md` |
| Research synthesis (10 frameworks, 16 sections) | `research/agent-context-memory-architecture/report.md` |
| Hermes Agent analysis | `research/hermes-agent/report.md` |
| PAI V4 architecture audit | `Pai-Exploration/src/pai-v4-architecture.md` |
| PAI V4 synthesis | `Pai-Exploration/src/v4-exploration-synthesis.md` |
| PAI-Demos analysis | `DEMOS-Work/PAI-Demos-Analysis.md` |
