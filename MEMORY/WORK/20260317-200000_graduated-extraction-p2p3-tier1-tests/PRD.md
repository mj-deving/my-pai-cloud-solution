---
task: Plan Graduated Extraction Phases 2-3 plus Tier 1 tests
slug: 20260317-200000_graduated-extraction-p2p3-tier1-tests
effort: deep
phase: complete
progress: 16/44
mode: interactive
started: 2026-03-17T20:00:00+01:00
updated: 2026-03-17T20:15:00+01:00
---

## Context

Graduated Extraction is PAI Cloud's strategy for absorbing OpenClaw's best capabilities without adopting the framework. Phase 1 (Sonnet fast-path via direct API) is complete and feature-flagged but **not yet activated on VPS**. This PRD plans Phases 2-3 and Tier 1 test coverage.

**Execution order (revised after Red Team):**
1. **Tier 1 Tests FIRST** — foundation before new code (TDD)
2. **Phase 1 Activation** — validate the fast-path before building on it
3. **Phase 2: Operational Tooling** — health monitor, diagnostics, backup scripts
4. **Phase 3A: Gateway Routes** — merged into existing dashboard (NOT a separate HTTP server)
5. **Phase 3B: Plugin Architecture** — BridgeContext bag only; full Plugin interface deferred until earned

### Council Decision: Plugin Architecture
Council (Architect, Engineer, Researcher, Security) unanimously chose **Option D: Evolutionary formalization** over DI containers, event buses, or flat registries. Key decisions:
1. BridgeContext typed bag replaces 12 positional constructor args
2. Plugin interface with init/start/stop lifecycle — define type now, implement incrementally
3. ~~forPlugin() scoped secrets~~ **DEFERRED** (Red Team: YAGNI for single developer)
4. No topological sort at 30 modules — explicit wiring is the dependency graph

### Science Analysis: Health Monitoring
Hypothesis testing on 4 health signals:
- **Telegram delivery rate:** strongest signal (low noise, user-facing)
- **Episode growth rate:** good compound signal
- **CLI latency:** too noisy for alerting — diagnostic only
- **Pipeline throughput:** conditional (only when tasks exist)
Design: 3 active signals + uptime, exposed via existing dashboard `/health` endpoint.

### Red Team Findings (incorporated)
1. **Phase 1 must be activated first** — building on unvalidated foundation is premature
2. **Gateway merged into dashboard** — no second HTTP server (Intern: dashboard already exists on :3456)
3. **scoped secrets dropped** — YAGNI for trusted single-developer codebase
4. **Tier 1 tests before new code** — HealthMonitor depends on statusline; test foundations first
5. **BridgeContext is flag-day migration** — TelegramAdapter 12 args can't be incrementally changed; plan for it
6. **DASHBOARD_TOKEN must be mandatory** when DASHBOARD_ENABLED=1 (security gap found)
7. **Injection scan blocking mode** — gateway /send must block on "high" risk, not just log
8. **Backup directory permissions** — memory.db contains conversation history; 0700 ownership required

### Risks
- BridgeContext migration touches TelegramAdapter constructor — largest single refactor
- Health monitor could add overhead to hot path (mitigated: sampling, not per-message)
- PRD parser tests need mock ClaudeInvoker (but extractJson is testable in isolation)
- Dashboard token enforcement could break existing deployments (mitigated: migration docs)

## Criteria

### Step 0: Tier 1 Tests — statusline.ts (6 criteria)

- [x] ISC-1: Test contextBar renders correct fill/empty ratio for 0%
- [x] ISC-2: Test contextBar renders correct fill/empty ratio for 50%
- [x] ISC-3: Test contextBar renders correct fill/empty ratio for 100%
- [x] ISC-4: Test formatStatusline workspace mode includes house icon and "workspace"
- [x] ISC-5: Test formatStatusline project mode includes folder icon and project name
- [x] ISC-6: Test formatStatusline includes CTX bar, msg count, episode count

### Step 0: Tier 1 Tests — injection-scan.ts (6 criteria)

- [x] ISC-7: Test scanForInjection returns "none" for clean input
- [x] ISC-8: Test scanForInjection detects "high" risk system override patterns
- [x] ISC-9: Test scanForInjection detects "medium" risk role switching patterns
- [x] ISC-10: Test scanForInjection detects "low" risk prompt leaking patterns
- [x] ISC-11: Test scanForInjection returns highest risk level from multiple matches
- [x] ISC-12: Test scanForInjection returns all matched pattern labels in array

### Step 0: Tier 1 Tests — prd-parser.ts (4 criteria)

- [x] ISC-13: Test extractJson extracts JSON from markdown code blocks
- [x] ISC-14: Test extractJson extracts raw JSON objects from text
- [x] ISC-15: Test extractJson returns null for text with no JSON
- [x] ISC-16: Test PRDParser.parse returns error for invalid JSON schema

### Step 1: Phase 1 Activation (4 criteria)

- [ ] ISC-17: DIRECT_API_KEY added to VPS bridge.env
- [ ] ISC-18: DIRECT_API_ENABLED=1 set in VPS bridge.env
- [ ] ISC-19: Bridge restarted and verified direct API handles simple messages
- [ ] ISC-20: Fallback to CLI confirmed working when direct API fails

### Step 2: Phase 2 — Health Monitor (10 criteria)

- [ ] ISC-21: HealthMonitor class tracks Telegram delivery success/failure ring buffer
- [ ] ISC-22: HealthMonitor tracks last episode ID delta from memory.db
- [ ] ISC-23: HealthMonitor tracks last message timestamp and process uptime
- [ ] ISC-24: HealthMonitor exposes isHealthy() returning status + signal details
- [ ] ISC-25: /health Telegram command returns formatted health status message
- [ ] ISC-26: /diag Telegram command returns diagnostics (uptime, memory RSS, disk free)
- [ ] ISC-27: GET /health route added to existing dashboard returns JSON status
- [ ] ISC-28: HEALTH_MONITOR_ENABLED feature flag gates initialization in bridge.ts
- [ ] ISC-29: HealthMonitor has dedicated test file with >=8 unit tests
- [ ] ISC-30: DASHBOARD_TOKEN mandatory when DASHBOARD_ENABLED=1 (config validation)

### Step 2: Phase 2 — Backup Scripts (4 criteria)

- [ ] ISC-31: Backup script copies memory.db to timestamped file in isidore_cloud-owned dir
- [ ] ISC-32: Backup script copies bridge.env to timestamped file with 0600 permissions
- [ ] ISC-33: Backup script rotates old backups keeping last 7
- [ ] ISC-34: Backup directory has 0700 permissions (no pai-group read access)

### Step 3: Phase 3A — Gateway Routes on Dashboard (6 criteria)

- [ ] ISC-35: POST /api/send route on dashboard accepts message, invokes Claude, returns JSON
- [ ] ISC-36: GET /api/status route on dashboard returns mode, uptime, msg count, context %
- [ ] ISC-37: GET /api/session route on dashboard returns session ID and stats
- [ ] ISC-38: All /api/* routes require bearer token (DASHBOARD_TOKEN)
- [ ] ISC-39: POST /api/send runs injection scan and blocks "high" risk prompts with 403
- [ ] ISC-40: Gateway routes have dedicated test file with >=6 tests

### Step 4: Phase 3B — BridgeContext (4 criteria)

- [ ] ISC-41: BridgeContext type defined with all subsystem fields as typed optional properties
- [ ] ISC-42: TelegramAdapter refactored to accept BridgeContext instead of 12 positional args
- [ ] ISC-43: All existing 147+ tests pass after BridgeContext migration
- [ ] ISC-44: Plugin interface type defined (name, init, start, stop) for future use

## Decisions

### D1: Gateway merged into dashboard (Red Team)
Two HTTP servers on one VPS is unnecessary complexity. The dashboard already binds to :3456 with Bun.serve. Gateway routes are added as /api/* paths on the same server.

### D2: scoped secrets deferred (Red Team)
forPlugin() and secretScopes dropped from Phase 3B. Single developer, all code trusted. Will revisit if/when multi-author plugins or untrusted agent definitions become real.

### D3: Plugin interface type-only (Red Team)
Define the Plugin type now (zero cost), but do NOT migrate subsystems to implement it yet. BridgeContext bag is the high-value change. Full plugin migration is earned when complexity demands it.

### D4: Execution order revised (Red Team)
Tests first → Phase 1 activation → Phase 2 → Phase 3A → Phase 3B. Building on unvalidated Phase 1 is premature. Testing existing code before building new code is TDD.

### D5: Injection scan blocking mode for gateway (Security Red Team)
The /api/send route must run injection-scan and return 403 for "high" risk prompts. Log-only is insufficient when bypassing Telegram auth.

## Verification

### Planning deliverables
- Implementation plan at `Plans/tranquil-churning-porcupine.md` — 5 steps, actionable
- PRD with 44 atomic ISC criteria, revised by Red Team findings
- Council debate (4 agents, 3 rounds) → Option D consensus on plugin architecture
- Science hypothesis testing → 3 health signals validated
- Red Team (4 agents) → 8 findings incorporated into plan

### Code deliverables
- `src/__tests__/statusline.test.ts` — 12 tests, all passing
- `src/__tests__/injection-scan.test.ts` — 22 tests, all passing (expanded after /simplify review)
- `src/__tests__/prd-parser.test.ts` — 10 tests, all passing (expanded after /simplify review)
- Total: 195 tests across 13 files, 0 failures, 337 assertions
- `npx tsc --noEmit` — clean
- `/simplify` review: 3 agents reviewed, findings fixed (6 untested patterns added, test renamed, 2 edge cases added)
