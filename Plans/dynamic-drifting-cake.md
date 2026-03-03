# Phase C: Synthesis + Agent Definitions — Implementation Plan

**Date:** 2026-03-03
**Scope:** 6 components, ~650 new lines + ~140 modified, 4 new files + 10 modified files
**Sessions:** 2 (possibly 3 for live testing)

---

## Context

Phase 4 (scheduler, policy, injection scan) is complete and deployed. Phase C closes the remaining L3→L4 autonomy gaps: periodic knowledge synthesis from accumulated episodes, and declarative agent definitions for scoped sub-delegation. The scheduler already has a `daily-synthesis` cron but it fires a generic prompt with no MemoryStore access. `MemoryStore.distill()` exists but is never called. No agent definition format or sub-delegation mechanism exists.

**User's design decisions:**
- C1: Dedicated `synthesis.ts` module with direct MemoryStore access
- C3/C4: Full agent defs with self-registration capabilities
- C5: Prompt prefix injection (no temp files)
- C6: Agent def declares execution tier (no heuristics)

---

## Execution Order

```
C2 (outcome recording)  →  no deps, small, prerequisite for C1
C3 (agent def spec)      →  no code deps, content work
C6 (algo lite template)  →  no code deps, content work
C1 (synthesis loop)      →  depends on C2 (needs outcome episodes)
C4 (agent loader)        →  depends on C3 (needs format to parse)
C5 (sub-delegation)      →  depends on C4 + C6
```

**Session 1:** C2 + C3 + C6 + C1 + config + policy
**Session 2:** C4 + C5 + orchestrator wiring + dashboard + CLAUDE.md

---

## C2: Outcome Recording (~50 mod lines)

**Problem:** Only Telegram + PRD episodes exist. Pipeline/orchestrator outcomes are not recorded.

### `src/schemas.ts` (line 207, 233)
- Add `"synthesis"` to Episode source enum and MemoryQuery source enum

### `src/pipeline.ts`
- Add `private memoryStore: MemoryStore | null = null` + `setMemoryStore()` setter
- After result write (line ~383), record episode:
  - `source: "pipeline"`, `role: "system"`, content = task prompt + result summary
  - metadata: `{ taskId, status, from, priority }`
- Add synthesis hook after PRD hook (line ~409): `if (this.synthesisLoop && task.type === "synthesis")` → call `synthesisLoop.run()`
- Add `private synthesisLoop` + `setSynthesisLoop()` setter

### `src/orchestrator.ts`
- Add `private memoryStore: MemoryStore | null = null` + `setMemoryStore()` setter
- In `notifyCompletion()` (line ~571), record workflow outcome episode:
  - `source: "orchestrator"`, `role: "system"`, content = workflow description + step counts
  - metadata: `{ workflowId, status, stepCount }`

### `src/bridge.ts`
- Wire `memoryStore` to pipeline and orchestrator via setters (after existing memory init block)

---

## C3: Agent Definition Format (3 new files)

### Directory: `.pai/agents/`

Markdown + YAML frontmatter. Filename = agent id (kebab-case).

**Frontmatter fields:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | string | required | Display name |
| `description` | string | `""` | One-line description |
| `execution_tier` | 1/2/3 | 3 | 1=full algo, 2=algo-lite, 3=one-shot |
| `memory_scope` | project/global/none | project | Memory query scope |
| `constraints` | string[] | [] | Injected as constraint block |
| `delegation_permissions` | string[] | [] | Allowed policy actions |
| `tool_restrictions` | string[] | [] | Denied policy actions |
| `self_register` | boolean | true | Auto-register in AgentRegistry |

Body (after frontmatter) = system prompt, injected as prefix during sub-delegation.

### Built-in agents:
1. `.pai/agents/synthesizer.md` — tier 2, memory_scope: global, used by synthesis loop
2. `.pai/agents/code-reviewer.md` — tier 2, memory_scope: project, for pipeline code reviews
3. `.pai/agents/health-checker.md` — tier 3, memory_scope: global, for weekly health review

---

## C6: Algorithm Lite Template (1 new file)

### `prompts/algo-lite.md` (~40 lines)

3-phase protocol: CRITERIA → EXECUTE → VERIFY. Injected as prompt prefix for tier 2 agents.
- Phase 1: State goal, 2-4 success criteria, scope boundary
- Phase 2: Execute work, note obstacles
- Phase 3: Check each criterion PASS/FAIL, final verdict

---

## C1: Synthesis Loop (~250 new lines)

### New file: `src/synthesis.ts`

**Class:** `SynthesisLoop`

**Constructor deps:** `Config`, `MemoryStore`, `ClaudeInvoker`
**Optional deps (setters):** `PolicyEngine`, `notifyCallback`

**Key method: `run(): Promise<SynthesisResult>`**
1. Policy check (`memory.distill`) — return early if denied
2. Fetch episodes since `lastSynthesizedId` via new `memoryStore.getEpisodesSince()`
3. Group by domain: `"pipeline"`, `"workflows"`, `"conversations"`
4. Skip domains with < `SYNTHESIS_MIN_EPISODES` (default: 3) new episodes
5. Per domain: build synthesis prompt with existing knowledge + new episodes
6. Claude `oneShot()` → parse JSON array of `{key, content, confidence}` entries
7. Write each entry via `memoryStore.distill(domain, key, content, episodeIds, confidence)`
8. Update `lastSynthesizedId` in `synthesis_state` SQLite table (in memory DB)
9. Record a `source: "synthesis"` episode summarizing what was distilled
10. Return `SynthesisResult` with stats

**State persistence:** `synthesis_state` table (key TEXT PRIMARY KEY, value TEXT) in memory DB. Stores `lastSynthesizedId` and `lastRunTimestamp`.

**Stats method: `getStats(): SynthesisStats`** — for dashboard (lastRun, totalRuns, totalEntriesDistilled)

### `src/memory.ts` additions (after line 268)
- `getEpisodesSince(sinceId: number, limit = 100): Episode[]` — SELECT WHERE id > ? ORDER BY id ASC
- `getKnowledgeByDomain(domain: string): Array<{key, content, confidence}>` — for dedup

### Scheduler integration
- Change `daily-synthesis` template in `bridge.ts` from `type: "task"` to `type: "synthesis"`
- Pipeline routes `type: "synthesis"` to `synthesisLoop.run()` (same pattern as orchestrate/prd hooks)

---

## C4: Agent Loader (~100 new lines)

### New file: `src/agent-loader.ts`

**Type:** `AgentDefinition` — id, name, description, executionTier, memoryScope, constraints, delegationPermissions, toolRestrictions, selfRegister, systemPrompt

**Class:** `AgentLoader`

**Constructor:** `agentsDir` path (from config)

**Methods:**
- `loadAll(): Promise<AgentDefinition[]>` — read dir, parse all .md files, cache
- `load(id: string): Promise<AgentDefinition | null>` — single file
- `getAgent(id): AgentDefinition | undefined` — from cache
- `getAllAgents(): AgentDefinition[]` — all cached
- `registerAll(registry: AgentRegistry)` — self-register where `selfRegister: true`

**Parsing:** Split on `---` markers, parse YAML frontmatter via `yaml` package (already installed), body = system prompt. Warn + skip malformed files.

### `src/orchestrator.ts` changes (line ~708)
- Add `private agentLoader` + `setAgentLoader()` setter
- In `buildDecompositionPrompt()`: if agentLoader is set, replace hardcoded agent list with dynamically loaded agent descriptions

---

## C5: Sync Sub-delegation (~80 new lines)

### `src/claude.ts` — new method after `quickShot()` (line 291)

```typescript
async subDelegate(
  agent: { id, name, executionTier, memoryScope, constraints, systemPrompt },
  task: string,
  options?: { project?, cwd?, algoLiteTemplate? }
): Promise<ClaudeResponse>
```

**Prompt composition:**
1. Algo Lite template (tier 2 only, from `prompts/algo-lite.md`)
2. Agent system prompt (from definition body)
3. Constraints block
4. Memory context (if scope allows, via `contextBuilder`)
5. Task prompt

**Invocation:**
- Tier 3 → `quickShot(composedPrompt)` (fast, haiku)
- Tier 2 → `Bun.spawn` with `--max-turns 10` (full model, algo-lite)
- Tier 1 → `oneShot(composedPrompt)` (full model, no turn limit)

---

## Config Additions (`src/config.ts`)

| Env Var | Type | Default | Config Field |
|---------|------|---------|-------------|
| `SYNTHESIS_ENABLED` | envBool | false | `synthesisEnabled` |
| `SYNTHESIS_MIN_EPISODES` | optionalInt(1,100,3) | 3 | `synthesisMinEpisodes` |
| `AGENT_DEFINITIONS_ENABLED` | envBool | false | `agentDefinitionsEnabled` |
| `AGENT_DEFINITIONS_DIR` | string | `$HOME/.../pai-cloud-solution/.pai/agents` | `agentDefinitionsDir` |

---

## Policy Additions (`policy.yaml`)

```yaml
  - action: synthesis.run
    disposition: allow
    description: "Allow autonomous synthesis loop execution"

  - action: subdelegation.invoke
    disposition: allow
    description: "Allow sub-delegation to registered agents"

  - action: subdelegation.unregistered
    disposition: deny
    description: "Deny sub-delegation to unregistered agents"
```

---

## Bridge Wiring (`src/bridge.ts`)

After scheduler init block:
1. Create `AgentLoader` if `agentDefinitionsEnabled` → `loadAll()` → `registerAll(agentRegistry)`
2. Create `SynthesisLoop` if `synthesisEnabled && memoryStore` → wire policyEngine, notifyCallback
3. Wire `memoryStore` to pipeline + orchestrator
4. Wire `synthesisLoop` to pipeline (for type:"synthesis" hook)
5. Wire `agentLoader` to orchestrator (for dynamic decomposition)
6. Update `daily-synthesis` schedule template: `type: "synthesis"`
7. Add `synthesisLoop` to Dashboard constructor

---

## Dashboard Updates

### `src/dashboard.ts`
- Add `synthesisLoop` as constructor param (after `prdExecutor`)
- Add `/api/synthesis` route → `{ enabled, lastRun, totalRuns, totalEntriesDistilled }`
- Add to SSE snapshot

### `src/dashboard-html.ts`
- Add Synthesis panel in a new split-row (Total Runs, Entries Distilled, Last Run)
- Add `renderSynthesis()` JS function + SSE listener + initial fetch

---

## CLAUDE.md Updates

- Add `synthesis.ts` and `agent-loader.ts` to Module Responsibilities table
- Add Synthesis Loop and Agent Definitions architecture sections
- Add design decision entries for synthesis, agent defs, sub-delegation, algo lite

---

## Verification

1. **Type check:** `bunx tsc --noEmit` after each component
2. **C2:** Submit pipeline task → verify episode in `sqlite3 data/memory.db "SELECT * FROM episodes WHERE source='pipeline'"`
3. **C1:** `/schedule run daily-synthesis` in Telegram → verify knowledge entries in DB + notification
4. **C4:** Check bridge startup logs for `Agent definitions loaded (N agents)`
5. **C5:** Orchestrator step using subDelegate → verify scoped response
6. **Dashboard:** `curl http://localhost:3456/api/synthesis` → verify stats
7. **Deploy:** `bash scripts/deploy.sh` → live test via Telegram

---

## File Summary

| Action | File | Lines |
|--------|------|-------|
| NEW | `src/synthesis.ts` | ~250 |
| NEW | `src/agent-loader.ts` | ~100 |
| NEW | `.pai/agents/{synthesizer,code-reviewer,health-checker}.md` | ~40 each |
| NEW | `prompts/algo-lite.md` | ~40 |
| MOD | `src/schemas.ts` | ~2 |
| MOD | `src/memory.ts` | ~20 |
| MOD | `src/pipeline.ts` | ~30 |
| MOD | `src/orchestrator.ts` | ~35 |
| MOD | `src/claude.ts` | ~80 |
| MOD | `src/config.ts` | ~20 |
| MOD | `src/bridge.ts` | ~40 |
| MOD | `src/dashboard.ts` | ~20 |
| MOD | `src/dashboard-html.ts` | ~30 |
| MOD | `policy.yaml` | ~10 |
| MOD | `CLAUDE.md` | ~30 |
