---
task: Execute Session 4 integration deploy A2A guardrails
slug: 20260326-170000_session-4-integration-a2a-guardrails-deploy
effort: comprehensive
phase: execute
progress: 64/67
mode: interactive
started: 2026-03-26T17:00:00+01:00
updated: 2026-03-26T17:02:00+01:00
---

## Context

Session 4 of the PAI Cloud Evolution Master Plan v4. Gates on Sessions 1-3 (all complete, 8 commits on main). Scope: Dashboard enhancements, Guardrails middleware, A2A Client, Retrieval Isolation, Group Chat, Integration Testing, Documentation.

User explicitly wants Fabric `create_git_diff_commit` for commit messages, Fabric `review_code` on commits, and Codex CLI delegation for review. VPS deployment deferred to separate step.

### Risks
- Schema migrations (user_id, channel on episodes) must be idempotent — existing data preserved
- GroupChatEngine + Retrieval Isolation are coupled — C2 must land before D
- Dashboard HTML changes are large — keep self-contained, degrade gracefully
- Guardrails wiring touches 3 existing files (claude.ts, pipeline.ts, playbook.ts) — surgical changes only

### Plan
1. **Phase A (Dashboard):** QR generator, 3 new API routes, 3 HTML panels, graceful degradation
2. **Phase B (Guardrails):** Allowlist/Denylist providers, check() gate, wire at 3 dispatch points
3. **Phase C (A2A Client):** discover() + send(), wire into BridgeContext
4. **Phase C2 (Retrieval Isolation):** user_id/channel columns, channelScope filtering
5. **Phase D (Group Chat):** GroupChatEngine, moderator synthesis, /group-chat command
6. **Phase E (Integration):** Config flags, BridgeContext, bridge.ts wiring, schemas, tests
7. **Phase G (Docs):** CLAUDE.md + ARCHITECTURE.md updates
8. **Commit workflow:** Fabric create_git_diff_commit → Fabric review_code → Codex review

Parallel agents: Phases A, B, C can run simultaneously (independent). C2→D sequential.

## Criteria

### Phase A: Dashboard Enhancements
- [x] ISC-1: src/qr-generator.ts exports generateQR function
- [x] ISC-2: generateQR returns valid data URL string
- [x] ISC-3: Dashboard /api/qr route returns QR code data
- [x] ISC-4: Dashboard /api/dag route returns DAG memory tree data
- [x] ISC-5: Dashboard /api/playbooks route returns playbook statuses
- [x] ISC-6: Dashboard /api/worktrees route returns worktree pool status
- [x] ISC-7: Dashboard HTML includes DAG visualization panel
- [x] ISC-8: Dashboard HTML includes playbook status panel
- [x] ISC-9: Dashboard HTML includes worktree pool status panel
- [x] ISC-10: DAG panel shows disabled state when DAG_ENABLED=0
- [x] ISC-11: Playbook panel shows disabled state when PLAYBOOK_ENABLED=0
- [x] ISC-12: Worktree panel shows disabled state when WORKTREE_ENABLED=0

### Phase B: Guardrails Middleware
- [x] ISC-13: src/guardrails.ts exports Guardrails class
- [x] ISC-14: AllowlistProvider whitelists specific operations per context
- [x] ISC-15: DenylistProvider blocks specific operations
- [x] ISC-16: Guardrails.check() returns allow or deny decision
- [x] ISC-17: GUARDRAILS_ENABLED feature flag exists in config.ts
- [x] ISC-18: Guardrails wired at ClaudeInvoker.oneShot dispatch
- [x] ISC-19: Guardrails wired at PipelineWatcher.dispatch
- [x] ISC-20: Guardrails wired at PlaybookRunner.executeStep
- [x] ISC-21: guardrails.test.ts exists with all tests passing

### Phase C: A2A Client
- [x] ISC-22: src/a2a-client.ts exports A2AClient class
- [x] ISC-23: A2AClient.discover() fetches agent card from URL
- [x] ISC-24: A2AClient.send() posts message to remote agent
- [x] ISC-25: A2AClient handles connection errors gracefully
- [x] ISC-26: A2A_CLIENT_ENABLED feature flag exists in config.ts
- [x] ISC-27: a2a-client.test.ts exists with all tests passing

### Phase C2: Retrieval Isolation
- [x] ISC-28: Episodes table has user_id TEXT column via idempotent migration
- [x] ISC-29: Episodes table has channel TEXT column via idempotent migration
- [x] ISC-30: MemoryStore.record() accepts user_id and channel parameters
- [x] ISC-31: MemoryStore.query() filters by channelScope parameter
- [x] ISC-32: ContextBuilder.buildContext() accepts channelScope parameter
- [x] ISC-33: Default channelScope is 1:1 preserving backward compatibility
- [x] ISC-34: retrieval-isolation.test.ts exists with all tests passing

### Phase D: Group Chat
- [x] ISC-35: src/group-chat.ts exports GroupChatEngine class
- [x] ISC-36: GroupChatEngine dispatches question to N agents in parallel
- [x] ISC-37: GroupChatEngine collects responses and builds moderator prompt
- [x] ISC-38: Moderator synthesis produces final answer
- [x] ISC-39: Group episodes recorded with channel=group and user_id
- [x] ISC-40: GROUP_CHAT_ENABLED feature flag exists in config.ts
- [x] ISC-41: GROUP_CHAT_MAX_AGENTS config exists in config.ts
- [x] ISC-42: /group-chat command registered in telegram.ts
- [x] ISC-43: group-chat.test.ts exists with all tests passing

### Phase E: Integration + Config Wiring
- [x] ISC-44: Config interface has guardrailsEnabled field
- [x] ISC-45: Config interface has a2aClientEnabled field
- [x] ISC-46: Config interface has groupChatEnabled field
- [x] ISC-47: Config interface has groupChatMaxAgents field
- [x] ISC-48: BridgeContext has guardrails field in types.ts
- [x] ISC-49: BridgeContext has a2aClient field in types.ts
- [x] ISC-50: BridgeContext has groupChat field in types.ts
- [x] ISC-51: bridge.ts wires Guardrails when GUARDRAILS_ENABLED=1
- [x] ISC-52: bridge.ts wires A2AClient when A2A_CLIENT_ENABLED=1
- [x] ISC-53: bridge.ts wires GroupChatEngine when GROUP_CHAT_ENABLED=1
- [x] ISC-54: EpisodeSchema source enum includes group value
- [x] ISC-55: Episode type has optional user_id field in schemas.ts
- [x] ISC-56: Episode type has optional channel field in schemas.ts

### Phase E2: Testing
- [x] ISC-57: npx tsc --noEmit passes with zero errors
- [x] ISC-58: All existing 347 tests still pass
- [x] ISC-59: All new Session 4 tests pass
- [x] ISC-60: Integration test file covers cross-subsystem flows

### Phase G: Documentation
- [x] ISC-61: CLAUDE.md updated with Session 4 module list
- [x] ISC-62: CLAUDE.md updated with Session 4 feature flags
- [x] ISC-63: CLAUDE.md test count updated to new total

### Commit Workflow
- [ ] ISC-64: Phase commits use Fabric create_git_diff_commit pattern
- [ ] ISC-65: Fabric review_code run on phase commits
- [ ] ISC-66: Codex CLI review delegation on final diff

### Anti-criteria
- [x] ISC-A-1: No existing tests broken by Session 4 changes

## Decisions

## Verification
