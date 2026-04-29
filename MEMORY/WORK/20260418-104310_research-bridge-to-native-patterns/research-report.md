# Bridge-to-Native-DAI Migration: Research Synthesis

**Date:** 2026-04-18
**Method:** 9 parallel research agents (3× Claude, 3× Gemini, 3× Grok) + 2 Twitter/bird queries
**URL verification:** 20 critical URLs verified (all 200 OK) before inclusion
**Scope:** Patterns for retiring a custom Grammy-based Telegram bridge in favor of native Claude Code + Channels + hooks + MCP + skills

---

## Executive Summary

Three findings dominate the evidence:

1. **Your bridge is substrate, not scaffolding.** Independent contrarian analyses (Grok agents 7 and 9) and the migration-patterns survey (Claude agent 1) agree: `ClaudeInvoker`, `ModeManager`, `MessageClassifier`, `HealthMonitor`, `ContextBuilder`, importance-triggered synthesis, auto-wrapup, and cross-user pipeline gateway do not have clean native equivalents. Retiring the bridge means rebuilding ~30% of its functionality as hooks + skills in a less expressive substrate (settings.json + shell scripts).

2. **The turn-recording hook pattern has rich, directly-liftable prior art** — 5 production OSS repos implement exactly what Phase 5 blockers (a) and (b) require. `codenamev/claude_memory` and `disler/claude-code-hooks-multi-agent-observability` are the closest matches.

3. **Claude Channels is NOT a "safe retirement target" yet.** Multiple Anthropic-tracked issues (#36477 "channels stops after first reply", #47153 "dispatch fails with --print", #38098 "auto-loads in every session") are open. Channels is research preview; plugin is v0.0.4; Anthropic reserves the right to change the protocol. Running Channels alongside the bridge is low-risk; *replacing* the bridge with Channels today is high-risk.

**Net recommendation:** Execute Phase 5 as an ADDITIVE hook migration first — extract turn recording, importance scoring, and notifications OUT of the bridge into hooks that Channels can also use. KEEP the bridge running as a second surface until the Channels bugs are resolved or a hybrid pattern proves out. Your 2-3 week shadow-run was correct; don't shorten it.

---

## Findings by Theme

### Theme 1 — Turn-Recording Hook: 5 Production Reference Implementations

| Repo | Pattern | Fit for Isidore Cloud |
|------|---------|----------------------|
| [codenamev/claude_memory](https://github.com/codenamev/claude_memory) | Hook + MCP + SQLite long-term memory | **Closest match.** Mirror the schema; skip MCP layer (you already have pai-memory-server). |
| [thedotmack/claude-mem](https://github.com/thedotmack/claude-mem) | Stop hook → SQLite FTS + Chroma vectors (dual store) | Study for importance scoring; dual-store is more than you need. |
| [mann1x/claude-hooks](https://github.com/mann1x/claude-hooks) | Cosine-similarity dedup threshold before insert | v2 refinement — dedup before committing to DB. |
| [severity1/claude-code-auto-memory](https://github.com/severity1/claude-code-auto-memory) | Stop hook spawns isolated memory-updater subagent | Relevant if Haiku scoring grows to a separate process. |
| [disler/claude-code-hooks-multi-agent-observability](https://github.com/disler/claude-code-hooks-multi-agent-observability) | Hook POSTs JSON to local HTTP server → SQLite + WebSocket broadcast | **Decoupling pattern** — avoid blocking Stop on DB contention. Matches your future dashboard architecture. |

**Applied pattern for your Phase 5 prerequisite (a) + (b):**
- **Move 1 (low-risk):** Stop hook invokes a tiny Bun script that opens `memory.db` directly, writes the turn. Heuristic importance score inline. Mirror `codenamev/claude_memory` schema. Keep existing `ClaudeInvoker.recordTurn()` running in parallel for one shadow-run week.
- **Move 2 (after validation):** Replace inline heuristic with a separate hook or post-insert queue processor that calls Haiku for scoring. Follow the `disler` HTTP decoupling pattern — hook POSTs to local writer, writer handles DB + score.
- **Move 3 (bridge retirement):** Remove `recordTurn()` from `ClaudeInvoker`. At this point the bridge's only unique logic is command routing and statusline — which can fall to skills + drop-on-retire.

### Theme 2 — Hooks Are a Control Plane, Not Just Observability

**Origin lineage:** LangChain `BaseCallbackHandler` (2022) → OpenAI Agents SDK `RunHooks` (2024) → Claude Code hooks (2025).

**The Claude Code innovation wasn't the event taxonomy — LangChain had `on_tool_start`/`on_tool_end` already. The innovation was making hooks out-of-process, exit-code-driven, and stderr-as-feedback.** Exit 2 blocks the turn; stderr routes into the model. That turns hooks into a policy mechanism, not just telemetry.

**Production invariants hooks typically enforce (from the [95-hook loadout analysis](https://blakecrosley.com/blog/claude-code-hooks)):**
1. Turn recording → SQLite
2. Importance scoring → Haiku
3. Permission gates (PreToolUse → deny dangerous Bash)
4. Injection scanning (UserPromptSubmit classifier)
5. Context injection (SessionStart → prepend memory)
6. Telemetry (POST to observability)
7. Auto-format / test (PostToolUse on Edit)
8. Secret redaction (PreToolUse on Bash)

Isidore already does 1, 2, 4, 6 in the bridge. Hook migration is moving these OUT of the bridge process into Claude Code's hook bus — which Channels sessions also fire.

**Pitfalls confirmed across sources:**
- **Stop-hook infinite loop** — Stop hook that triggers more model output re-fires Stop. Mitigation: flockfile / reentrancy flag (same pattern as your `polling` flag in `pipeline.ts`).
- **Context poisoning** — UserPromptSubmit/SessionStart stdout injects into context. Treat hook output as untrusted.
- **DB lock contention** — synchronous SQLite writes in Stop block turn completion. WAL + short txns OR decouple via HTTP (the disler pattern).
- **Silent hook failures** — missing `chmod +x` (already in your CLAUDE.md critical rules).
- **Anthropic Agent SDK v0.1.0** changed settings-source defaults: filesystem config no longer auto-loads unless opted-in. Projects relying on `.claude/` broke silently.

Source: [Effective harnesses for long-running agents](https://anthropic.com/engineering/effective-harnesses-for-long-running-agents) (Anthropic Engineering).

### Theme 3 — Channels State (April 2026): Research Preview With Open Bugs

**Official status** (per [Channels docs](https://code.claude.com/docs/en/channels)):
- Research preview, launched 2026-03-20 with Claude Code v2.1.80
- `--channels` flag and protocol contract "may change based on feedback"
- Requires claude.ai Pro/Max login; API keys unsupported
- Team/Enterprise off by default; admin enables via `channelsEnabled`

**Open GitHub issues that directly affect retirement planning:**

| Issue | Title | Status | Impact |
|-------|-------|--------|--------|
| [#36477](https://github.com/anthropics/claude-code/issues/36477) | Channels STOPS after first reply — REPL returns to prompt, ignores notifications | OPEN, no workaround | **Blocks bridge retirement** — silent message drops |
| [#47153](https://github.com/anthropics/claude-code/issues/47153) | `--channels` dispatch fails with `--print`, 124K+ error log lines | OPEN | Affects any `claude -p` in hybrid setups |
| [#38098](https://github.com/anthropics/claude-code/issues/38098) | Plugin auto-loads in EVERY `claude -c` session without `--channels` | OPEN | Multiple sessions fight for the same bot token |
| [#30447](https://github.com/anthropics/claude-code/issues/30447) | No `--headless`/`--daemon` flag for Remote Control | OPEN, stale | Forces tmux workaround |
| [#6227](https://github.com/anthropics/claude-code/issues/6227) | Permission mode not exposed to hooks/statusline | OPEN | Blocks statusline parity |

**Capabilities Channels has** (inbound-to-session):
- Reply, react, edit_message tools via MCP plugin
- Permission relay (v2.1.81+): forwards tool approvals to channel
- Access control: `/telegram:access pair <code>` + allowlist policy
- Multi-plugin: Telegram, Discord, iMessage, fakechat (not Slack yet — that's a different MCP for Cowork)

**Capabilities Channels does NOT have:**
- Message history/search API (Telegram Bot API limitation)
- Injection scanning (you must keep your own UserPromptSubmit hook)
- Agent-initiated outbound messaging (see Theme 5)
- Voice messages
- Multi-user broadcast as first-class
- Statusline (mode/ctx%/msg count) equivalent

### Theme 4 — Memory Architecture: SQLite+FTS5+DAG is Validated

**Ecosystem convergence (2026):**
- **Letta**: SQLite+ChromaDB for dev; Postgres+pgvector for Docker prod — bifurcated by deliberate design
- **DeerFlow (ByteDance)**: ChromaDB default; SQLite for single-process checkpointing
- **DeepAgents (LangChain)**: Filesystem-first, no vector DB
- **2026 SQLite+FTS5 movement**: AIngram, Engram, agentmem, memweave, ZeroClaw — deliberately NO vector DB

**Academic grounding for your DAG summary table:**
- [Letta sleep-time compute paper (arXiv:2504.13171)](https://arxiv.org/abs/2504.13171) — background agents rewrite memory blocks async, 5× compute reduction at equal accuracy, 18% accuracy gain
- Wang et al. 2023 "Recursively Summarizing Enables Long-Term Dialogue Memory" (arXiv:2308.15022)
- MemTree (arXiv:2410.14052), TaciTree (arXiv:2503.07018) — explicit tree/DAG memory

**Importance scoring with Haiku is validated:**
- Park et al. 2023 "Generative Agents" (Stanford) — canonical 1-10 importance score
- A-Mem (arXiv:2502.12110) — benchmarks Claude Haiku for agentic memory scoring

**Operational risk you already handle correctly:** WAL checkpoint in `scripts/backup.sh`. Do NOT let anyone replace this with `cp memory.db` — guaranteed corruption.

**Strategic caveat:** Version the importance-score prompt (`scorer_version` column per episode). A prompt change 6 months in will silently re-weight retrieval.

### Theme 5 — Proactive Notifications: Cron→Bot API Wins

**Three architectural camps:**

1. **External-driver (most common, simplest):** cron/systemd timer → one-shot Claude → Telegram Bot API. Your bridge already does this; a standalone script can replace it.
2. **Event-bus daemon:** long-running daemon subscribes to webhooks/DB changes → dispatches to channel adapters. `RichardAtCT/claude-code-telegram` documents this pattern explicitly.
3. **Agent-native push via Channels:** Channels is *inbound-to-session*. External systems push events IN; Claude replies OUT via reply tool. **Channels does NOT give an agent a "wake from idle and message me" primitive.**

**No framework has true self-wake. "Agent decides to message me" always decomposes to "something external triggers the agent on a schedule, then agent chooses content/recipient."** MemGPT/Letta heartbeats enable multi-step autonomy *inside* an invocation — not session initiation.

**Reference repos:**
- [openclaw/openclaw](https://github.com/openclaw/openclaw) — heartbeat + cron + 13 platforms
- [PleasePrompto/ductor](https://github.com/PleasePrompto/ductor) — multi-CLI + Docker sandbox + persistent scheduler state
- [nousresearch/hermes-agent](https://github.com/nousresearch/hermes-agent) — cron-first, multi-platform
- [RichardAtCT/claude-code-telegram](https://github.com/RichardAtCT/claude-code-telegram) — explicit event bus + `NOTIFICATION_CHAT_IDS`
- [avivsinai/telclaude](https://github.com/avivsinai/telclaude) — tiered permissions + cron via inline buttons

**Applied pattern for your Phase 5 prerequisite (c):**
- **Simplest:** `scripts/notify.sh` wrapping `curl` to Telegram Bot API. systemd timers invoke it. Token from same env file as Channels bot.
- **Rate limits to respect:** 30 msg/sec global, 1 msg/sec per chat, 20 msg/min per group.
- **Idempotency:** persist "pending" state with ID, atomic write-then-rename (your existing pipeline pattern).

### Theme 6 — Telegram-Bot Migration: No Clean Public Commit Diffs

**Honest gap:** despite extensive search, no public OSS repo documents a clean commit-level "bridge retired, native adopted" diff. MacStories, shareuhack, and Hindsight describe architectural deltas in prose; no one has version-controlled the migration.

**This means Isidore's Phase 5 would itself be a novel reference implementation.** That's an opportunity (publishable, reusable) but also a signal that the transition is harder than blog posts suggest.

**Consistent "drop" list across OSS and your own notes:**
- Custom `/help`, `/start`, `/verbose`, `/oneshot`, `/quick`, `/keep`, `/reauth` (Phase 2 already did this)
- Custom auth middleware → plugin `/telegram:access`
- Custom session resume → CLI `--resume`
- `compactFormat` / statusline append → plugin sends raw output

**Consistent "keep as daemon" list:**
- Pipeline workers (✅ already `isidore-cloud-pipeline`)
- Cron/scheduler (Phase 5 blocker — convert to systemd timers)
- Health monitor
- Dashboard gateway (✅ already `isidore-cloud-dashboard`)
- Backup cron (✅)

**Consistent "lost feature" list:**
- Statusline (mode/ctx%/msg count) — LOST, no plugin equivalent (see issue #6227)
- Importance scoring of replies — LOST unless you hook it
- `compactFormat` of Algorithm verbosity — LOST; plugin sends raw
- Permission prompts on mobile — MacStories documents "no way to grant it in Telegram"; either `--dangerously-skip-permissions` or stay at desktop

### Theme 7 — Mobile-First Surfaces: Remote Control Is the Only Real Native Path

**Landscape verdict (Grok agent 8):**
- **Only Anthropic Remote Control** ([docs](https://code.claude.com/docs/en/remote-control)) offers a first-class mobile-to-VPS-agent experience. Launched Feb 24, 2026, Pro/Max preview.
- Everything else (OpenClaw, Hermes, MoltBot, Claude Channels) uses messaging apps as transport. That's scaffolding masquerading as mobile.
- **Telegram dominates "because alternatives are worse, not because it's good."** Signal requires self-hosted signal-cli bridges; WhatsApp Business API is paid/gated; iMessage needs a Mac always-on.

**Contrarian security flag:** Telegram bot chats are NOT end-to-end encrypted. Telegram servers see plaintext. Bot tokens grant full bot control. If your threat model includes "Telegram corp / subpoena / leaked .env", **Telegram is measurably worse than Remote Control**.

**Observed survival pattern:** Most "24/7 VPS agent" setups get configured, used for a week, abandoned. Surfaces that survive have zero daily friction: Telegram chat, or Remote Control. PWAs lose to whatever's already on the home screen.

**Your Isidore Cloud already has all three:** bridge (Grammy + Telegram), Channels (Telegram plugin), Remote Control (active since 2026-04-17). You're in the top quartile of surface coverage.

### Theme 8 — The Contrarian Case (Two Independent Agents Converged Here)

Both Grok 7 (DAI-like systems) and Grok 9 (against retirement) independently converged:

> **"Your bridge is the product. Channels is a cheaper transport."**

Capabilities Channels + hooks + MCP + skills **CAN replace:**
- Command surface (via skills) ✅ Phase 2 done
- Tool exposure (via MCP) ✅ already done
- Memory queries (via pai-memory-server) ✅ already done
- One-shot invocations (via CLI `-p`)
- Simple routing

Capabilities they **CANNOT cleanly replace:**
- Stateful mode machine (ModeManager workspace/project duality)
- Context-fill tracking via `lastTurnUsage`
- Importance-triggered synthesis flush
- Cross-user atomic pipelines (this is already standalone daemon — safe)
- Multi-agent group chat with moderator synthesis
- Guardrails with allowlist/denylist + context filtering
- Gateway with injection scanning + timing-safe auth

**Survivor pattern for persistent Claude agents (from adoption-signal analysis):**
1. Single owner who's also on-call
2. Narrow scope (one surface, one memory store)
3. Willingness to rewrite every ~6 months as CLI evolves

Your repo has 1 and 3. Channels + Remote Control EXPANDS scope (more surfaces) — which per the pattern is actually a risk, not a win.

### Theme 9 — Twitter Signal: Community Is Adopting the Pattern You're Retiring Toward

From the Twitter/bird signal (9 recent tweets analyzed):
- **@remytrichard** (2026-04-04): "TruClaw. Think OpenClaw, but built on three official Anthropic pieces: Claude Code CLI, Channels, and a bot token. Nothing else. No unofficial API access. No account risk." — **exactly your target architecture**
- **@0xWuki** (2026-03-29): "openclaw is dead, anthropic just dropped channels" — polemic but matches the direction
- **@WilliamPenrose_** (2026-04-09): posted the exact setup recipe (BotFather → /plugin install → /telegram:configure → --channels → /telegram:access pair) — same recipe Isidore Cloud already followed
- **Chinese tweet** (2026-03-25): documents real pain — "sessions lose memory on long runs, stability still being tuned (still preview)"

**Signal read:** The OSS community is converging on "retire custom bot, go native Channels" right now — but practitioners are hitting the same bugs your research surfaced.

---

## Reusability Matrix

| Component you need | Existing implementation | Fit | Adaptation effort |
|---|---|---|---|
| Turn-recording hook (Stop → SQLite) | [codenamev/claude_memory](https://github.com/codenamev/claude_memory) | ⭐⭐⭐⭐⭐ | Low: mirror schema, strip MCP layer, ~1 day |
| Hook→DB decoupling (HTTP) | [disler/claude-code-hooks-multi-agent-observability](https://github.com/disler/claude-code-hooks-multi-agent-observability) | ⭐⭐⭐⭐ | Medium: add writer daemon, ~2 days |
| Importance scoring (Haiku) | A-Mem paper (arXiv:2502.12110) + [thedotmack/claude-mem](https://github.com/thedotmack/claude-mem) | ⭐⭐⭐⭐ | Medium: prompt + versioning, ~1-2 days |
| Proactive notifications (cron → Telegram) | [openclaw/openclaw](https://github.com/openclaw/openclaw), [PleasePrompto/ductor](https://github.com/PleasePrompto/ductor) | ⭐⭐⭐⭐⭐ | Trivial: `scripts/notify.sh` + systemd timer, ~2 hrs |
| Scheduler → systemd timers | Standard Linux, ductor patterns | ⭐⭐⭐⭐⭐ | Low: inventory current jobs, write unit files, ~4 hrs |
| Turn-memory schema | Letta memory blocks + [codenamev/claude_memory](https://github.com/codenamev/claude_memory) | ⭐⭐⭐⭐ | You already have FTS5 — keep |
| DAG summarization | Already implemented; validated by [arXiv:2504.13171](https://arxiv.org/abs/2504.13171) | ✅ Already done | None |
| Injection scanning | Already implemented; NO plugin equivalent | ✅ Keep; wrap in UserPromptSubmit hook | Low: 1 day |
| Statusline (mode/ctx%/msg) | NONE — blocked by [#6227](https://github.com/anthropics/claude-code/issues/6227) | ❌ No path | Accept loss OR keep bridge for this |
| ModeManager (workspace/project) | NONE — bridge-specific pattern | ❌ No path | Build as skill state file, ~3 days |
| MessageClassifier (Sonnet/Opus routing) | None public; your own pattern | ❌ No path | Keep in bridge OR discard the feature |
| HealthMonitor `/health` `/diag` | None public; cron + `scripts/verify-access-surfaces.sh` can replace | ⭐⭐⭐ | Medium: lose Telegram UX for status checks |
| Guardrails (allow/deny regex) | None public for plugins | ❌ No path | Keep bridge OR rebuild as PreToolUse hook |

**Scoring key:** ⭐⭐⭐⭐⭐ = lift directly • ⭐⭐⭐⭐ = lift with small adaptation • ⭐⭐⭐ = partial fit • ❌ = no reusable pattern, build fresh

---

## Contradictions & Conflicts

1. **"Retire the bridge" vs "the bridge is the product"** — Twitter signal and TruClaw pattern say retire; contrarian analysis and issue tracker say not yet. Resolution: execute the hook migration (a,b,c,d) additively; delay actual Grammy shutdown until Channels issue #36477 is resolved.

2. **"Channels is stable enough"** vs **Issue #36477 open with no workaround** — the docs are public but the product has silent-drop bugs. Resolution: the Channels + bridge parallel run isn't optional — it's the bug-reproduction gate.

3. **"SQLite+FTS5 is production grade"** vs **"Use pgvector for real scale"** — Letta ships both; the 2026 indie movement picks SQLite+FTS5+sqlite-vec. Resolution: stay on SQLite; plan migration path at 1M+ episodes (you're years away).

4. **"Hooks are the new control plane"** vs **"Hooks have silent failure modes"** (chmod +x, ordering bugs, context poisoning) — resolved by treating hooks as untrusted output and reentrancy-guarded.

5. **"Telegram is de facto"** vs **"Telegram is a privacy downgrade"** — resolved by acknowledging Telegram's dominance is friction-driven, not security-driven. Keep it because users accept it, not because it's best.

---

## Verdict & Recommendation

**Do NOT execute Phase 5 as "retire bridge, switch to Channels" in one pass.**

**Execute it as a 4-move additive migration:**

1. **Move 1 — Turn-recording hook** (~1–2 days): Stop hook + tiny Bun writer; mirror `codenamev/claude_memory` schema. Runs alongside `ClaudeInvoker.recordTurn()` in shadow mode; compare DBs daily.

2. **Move 2 — Notification shim + scheduler migration** (~1 day): `scripts/notify.sh` + systemd timer units replacing `src/scheduler.ts`. Independent of bridge; deploy and test standalone.

3. **Move 3 — Importance scoring hook** (~2 days): post-insert queue processor using Haiku; version the scorer prompt. Decouple via HTTP (disler pattern) if DB contention shows up.

4. **Move 4 — Grammy shutdown decision gate:** Only after Moves 1–3 are stable AND Channels issue #36477 shows movement (fix merged OR workaround documented). At that point disable `TELEGRAM_BOT_TOKEN` in bridge.env, keep process for 2 weeks as fallback, then `systemctl disable --now isidore-cloud-bridge`.

**Features explicitly accepted as lost:**
- Statusline (mode/ctx%/msg count) — wait for [#6227](https://github.com/anthropics/claude-code/issues/6227)
- `compactFormat` of Algorithm verbosity — not worth rebuilding
- MessageClassifier (Sonnet/Opus routing) — use skills to pick model explicitly

**Features explicitly preserved via hook migration (not lost):**
- Turn recording (Move 1)
- Importance scoring (Move 3)
- Injection scanning (keep as UserPromptSubmit hook — already possible)
- Proactive notifications (Move 2)

**Follow-up experiments worth running BEFORE Move 4:**
- Reproduce issue #36477 on your VPS Channels instance; subscribe to thread
- Instrument message-drop rate during shadow run (MacStories saw "5 sent, 3 received")
- Measure per-turn latency: bridge `claude -p` vs Channels session reply

---

## Sources (all URLs verified 200 OK, 2026-04-18)

### Hook / memory prior art
- https://github.com/codenamev/claude_memory
- https://github.com/thedotmack/claude-mem
- https://github.com/mann1x/claude-hooks
- https://github.com/severity1/claude-code-auto-memory
- https://github.com/disler/claude-code-hooks-multi-agent-observability

### Channels ecosystem
- https://code.claude.com/docs/en/channels
- https://code.claude.com/docs/en/remote-control
- https://github.com/anthropics/claude-plugins-official
- https://github.com/anthropics/claude-code/issues/36477
- https://github.com/anthropics/claude-code/issues/30447

### Telegram-bot reference repos
- https://github.com/RichardAtCT/claude-code-telegram
- https://github.com/PleasePrompto/ductor
- https://github.com/nousresearch/hermes-agent
- https://github.com/avivsinai/telclaude
- https://github.com/openclaw/openclaw

### Memory architecture papers/repos
- https://arxiv.org/abs/2504.13171 (Letta sleep-time compute)
- https://github.com/letta-ai/letta
- https://github.com/langchain-ai/deepagents
- https://github.com/bytedance/deer-flow

### Anthropic engineering
- https://anthropic.com/engineering/effective-harnesses-for-long-running-agents
