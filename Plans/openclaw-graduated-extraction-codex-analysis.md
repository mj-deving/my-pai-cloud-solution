# Architectural Analysis: OpenClaw + PAI Cloud Integration

> Deep architectural analysis by Remy (Codex Researcher) after studying both codebases in detail: 40 PAI source files (~12,300 LOC), OpenClaw config/docs/pipeline scripts, and all reference documentation.

---

## The Fundamental Tension

Before evaluating architectures, we need to name the core tension precisely, because every approach lives or dies on how it resolves this:

**OpenClaw owns the AI invocation internally.** It calls Anthropic API directly, manages its own tool schemas, context window, memory retrieval, session persistence, and prompt assembly. You configure it via `openclaw.json` and it handles everything inside a single process.

**PAI's entire value comes from wrapping Claude Code CLI externally.** The `claude --resume <session-id> -p "prompt" --output-format stream-json` invocation gives you: filesystem R/W, bash execution, git operations, 16 PAI hooks (SecurityValidator, LoadContext, RatingCapture, etc.), CLAUDE.md context loading, Algorithm mode, tool use with approval flows, and the full Opus-class agentic loop. None of this is available through the Anthropic API directly.

These two approaches are architecturally incompatible at the invocation layer. Every architecture below is fundamentally a strategy for dealing with this incompatibility.

---

## Architecture 1: OpenClaw as Headless Transport (Strip the AI)

**Concept:** Use OpenClaw purely as a message router. Disable its AI inference. Route all messages to PAI's Claude Code CLI instead.

**How it would work:**
```
Telegram -> OpenClaw Gateway (message routing only)
         -> Custom skill/handler intercepts ALL messages
         -> Pipes to: claude --resume <session-id> -p "<message>" --output-format stream-json
         -> Routes response back through OpenClaw's Telegram channel
```

**What you keep from OpenClaw:**
- Telegram integration (per-channel-peer sessions, groups, reactions)
- Gateway infrastructure (health checks, diagnostics)
- Skill loading/gating system (but skills would call Claude CLI, not Sonnet)
- Cron/scheduling
- Device pairing, mDNS, Tailscale support
- Auto-update mechanism

**What you lose:**
- All of OpenClaw's built-in AI capabilities (it becomes a dumb pipe)
- 180+ bundled skills (they are written to use OpenClaw's native tools, not Claude Code CLI)
- OpenClaw's memory system (local embeddings, vector search, hybrid retrieval)
- OpenClaw's context pruning and compaction
- The cost advantage of Sonnet for routine tasks

**Critical problems:**
1. OpenClaw skills use `exec`, `read`, `write` as native tools. You cannot redirect these to Claude Code CLI without rewriting every skill.
2. OpenClaw's gateway API (`openclaw agent --message`) returns structured payloads with metadata. Claude CLI returns different structured output. The impedance mismatch is deep.
3. You lose the Sonnet cost advantage entirely. Every "what time is it" becomes an Opus CLI invocation.

**Verdict:** This is the worst option. You gut OpenClaw's strengths while inheriting its complexity. You would be maintaining a framework you do not use for its intended purpose.

---

## Architecture 2: Claude Code CLI as an OpenClaw Exec Tool

**Concept:** OpenClaw's Sonnet handles routine messages. For complex tasks, Sonnet decides to call `claude` as a shell tool, delegating to Opus/Claude Code CLI.

**How it would work:**
```
Telegram -> OpenClaw (Sonnet handles message)
         -> Sonnet determines: "This needs deep work"
         -> exec tool: claude --resume <session-id> -p "<task>" --output-format json
         -> Sonnet receives result, formats response
         -> Response sent to Telegram
```

**What you keep from OpenClaw:**
- Everything. OpenClaw runs normally.

**What you keep from PAI:**
- Claude Code CLI capabilities (file R/W, bash, git, hooks, CLAUDE.md)
- Session persistence via --resume

**What you lose from PAI:**
- Streaming progress updates (OpenClaw exec returns when done, no intermediate feedback)
- Custom memory injection (PAI's ContextBuilder prepends memory context; OpenClaw has its own)
- 40+ Telegram commands (/sync, /review, /merge, /project, /workspace, etc.)
- ModeManager (workspace/project dual-mode)
- DAG orchestrator
- Synthesis loop
- Dashboard
- Policy engine
- Rate limiting / resource guards
- All the custom operational tooling

**Critical problems:**
1. **Double AI invocation.** Sonnet receives the message, reasons about it, decides to call Claude CLI, which then does its own reasoning with Opus. You pay for both. This is the "wrapper tax."
2. **Session confusion.** OpenClaw has its own session model (`per-channel-peer`). Claude CLI has `--resume`. They do not share state. Sonnet does not know what Claude Code discussed last time.
3. **Who controls the filesystem?** OpenClaw exec runs in `openclaw` user's context. Claude Code CLI runs in `isidore_cloud` user's context (or does it? If called via exec, it runs as `openclaw`). The Linux user isolation that protects the pipeline breaks down.
4. **Capability regression.** PAI's bridge has 40+ commands that directly interact with Claude CLI output (parsing stream-json events, detecting Algorithm phases, ISC progress, tool use tracking). None of this exists in OpenClaw.

**This is essentially what the current pipeline already does**, but with more overhead. The filesystem pipeline achieves the same "Gregor decides, Isidore executes" pattern without the double-invocation cost and without breaking user isolation.

**Verdict:** Marginal improvement over current pipeline. The double-invocation tax and session confusion make this a poor choice for the primary interaction path. It could work for occasional "heavy lift" tasks, but that is exactly what the pipeline already does.

---

## Architecture 3: Pattern Adoption (Not Framework Adoption)

**Concept:** Instead of putting PAI inside OpenClaw or vice versa, PAI's bridge adopts architectural patterns from OpenClaw without using the framework itself.

**Specific patterns to adopt:**

### 3A. Skill System
OpenClaw's skill system is elegant: SKILL.md files with YAML frontmatter, gating via metadata (OS, bins, env), and the critical insight that "skills educate, tools execute." PAI already has `AgentLoader` and `.pai/agents/*.md` definitions, but they are simpler.

**Adoption path:** Evolve PAI's AgentLoader into a full skill system:
- SKILL.md format with frontmatter (already similar to agent definitions)
- Skill gating: `requires.bins`, `requires.env`, platform filters
- User-invocable flag mapping to Telegram commands
- Skill-scoped context (only load relevant skills per message)

**Effort:** Medium. PAI's agent-loader.ts is 150 lines. A full skill system would be ~400 lines.

### 3B. Gateway Pattern
OpenClaw runs a local gateway on port 18789 for CLI and programmatic access. PAI's bridge only accepts Telegram messages.

**Adoption path:** Add a localhost HTTP API to PAI's bridge:
```typescript
// In bridge.ts, alongside the Telegram adapter:
const api = Bun.serve({
  port: 18790,
  hostname: "127.0.0.1",
  routes: {
    "/send": { POST: handleSend },
    "/status": { GET: handleStatus },
    "/session": { GET: handleSession },
    "/health": { GET: handleHealth },
  }
});
```

**Benefit:** Enables programmatic access without Telegram. Other agents, scripts, and cron jobs can invoke Isidore directly. The pipeline could use HTTP instead of filesystem polling.

**Effort:** Low. Bun.serve is trivial. The handlers already exist in telegram.ts, just need to be extracted into route handlers.

### 3C. Plugin Architecture
OpenClaw uses a plugin system with slots (memory, telegram, etc.). PAI wires everything in bridge.ts with feature flags.

**Adoption path:** Formalize PAI's feature-flagged subsystems as plugins with a common interface:
```typescript
interface Plugin {
  name: string;
  init(config: Config, deps: PluginDeps): Promise<void>;
  start?(): Promise<void>;
  stop?(): void;
  close?(): void;
}
```

**Benefit:** The 20+ feature-flagged subsystems in bridge.ts become self-contained. New capabilities are added by writing a plugin, not editing bridge.ts (which is 597 lines of wiring code).

**Effort:** Medium-high. Refactoring 20 subsystems is significant but incremental.

### 3D. Config Schema
OpenClaw's `openclaw.json` is a single, well-structured config file. PAI uses env vars validated by Zod in config.ts.

**Adoption path:** Keep Zod validation but add a JSON config file as an alternative to env vars. Bridge.env is hard to read with 30+ vars. A structured JSON file with nesting is more maintainable.

**Effort:** Low. Config.ts already has the schema; writing a JSON loader is trivial.

### 3E. Session Persistence Pattern
OpenClaw's `per-channel-peer` session model is interesting. PAI shares one session across all interactions.

**Adoption path:** PAI already has this capability (ProjectManager manages per-project sessions, ModeManager manages workspace vs project). The pattern is already adopted, just not as cleanly abstracted.

**Verdict:** This is the highest-value, lowest-risk approach. You get architectural improvements without framework lock-in, without double invocation, and without losing any PAI capabilities. But it is evolutionary, not revolutionary.

---

## Architecture 4: Cooperative Specialization (Best of Both Worlds)

**Concept:** OpenClaw and PAI coexist as specialized agents with clearly delineated responsibilities and a unified Telegram identity.

**How it would work:**

```
                          +-----------------+
                          |  UNIFIED BOT    |
                          |  (One Telegram  |
                          |   bot token)    |
                          +--------+--------+
                                   |
                          +--------v--------+
                          |  ROUTER LAYER   |
                          |  (Thin TypeScript|
                          |   service)      |
                          +--------+--------+
                                   |
                    +--------------+--------------+
                    |                             |
           +--------v--------+          +--------v--------+
           |  GREGOR          |          |  ISIDORE CLOUD  |
           |  (OpenClaw)      |          |  (PAI Bridge)   |
           |                  |          |                  |
           |  Fast, cheap     |          |  Deep, agentic   |
           |  Sonnet 4.6      |          |  Opus via CLI    |
           |  180 skills      |          |  File ops, git   |
           |  Routine tasks   |          |  PAI hooks       |
           |  Quick answers   |          |  Algorithm mode  |
           |  Web search      |          |  PR workflow     |
           |  Cron/scheduling  |          |  Memory/context  |
           +---------+--------+          +--------+--------+
                     |                            |
                     +------- Pipeline -----------+
                     (filesystem, already works)
```

**The Router Layer decides who handles what:**
```typescript
// router.ts - Thin classification layer
async function route(message: string, context: RouterContext): Promise<"gregor" | "isidore"> {
  // Explicit commands always go to Isidore
  if (message.startsWith("/sync") || message.startsWith("/project") ||
      message.startsWith("/review") || message.startsWith("/merge") ||
      message.startsWith("/workspace") || message.startsWith("/wrapup")) {
    return "isidore";
  }

  // Developer workflow keywords
  if (/\b(git|commit|push|pull|deploy|refactor|debug|code|implement|build)\b/i.test(message)) {
    return "isidore";
  }

  // Long messages suggesting complex work
  if (message.length > 500) return "isidore";

  // Everything else: Gregor (fast, cheap)
  return "gregor";
}
```

**What this preserves:**
- Both systems run unmodified
- Each handles what it is best at
- Single Telegram identity (one bot token, one conversation)
- Pipeline already handles cross-agent communication
- Cost optimization: routine messages hit Sonnet (~$0.003/msg), complex work hits Opus CLI (~$0.15/msg)

**What is new:**
- Router layer (thin service, ~200 lines)
- Shared Telegram bot token (router owns the bot, forwards to appropriate backend)
- Response formatting standardization (both systems format to common output before Telegram delivery)

**Critical problems:**
1. **Session continuity across agents.** If Gregor answers 5 messages, then Isidore handles 1, Isidore does not know what Gregor discussed. The router must maintain a shared conversation transcript.
2. **Router accuracy.** Misrouting a complex task to Gregor means a bad answer. Misrouting a simple task to Isidore means wasted cost. The classification must be reliable.
3. **Three services to maintain.** Router + Gregor + Isidore. More moving parts.
4. **Identity confusion.** If both agents have different personality tones, the user notices inconsistency.

**Partial mitigation:** The router could use a simple heuristic (commands, keywords, message length) rather than AI-based classification. This avoids triple invocation. And both agents can share a personality layer through system prompts/CLAUDE.md.

**Verdict:** Architecturally clean but operationally complex. The shared transcript problem is the biggest obstacle. This works best if the two agents handle clearly distinct domains (developer workflow vs. general assistant) with minimal cross-domain context needed.

---

## Architecture 5: Unified Agent with Model Switching

**Concept:** ONE bot, ONE codebase, that dynamically switches between Sonnet (fast/cheap) and Opus-via-Claude-Code (deep/agentic) based on task complexity.

**How it would work:**

```
Telegram -> PAI Bridge (SINGLE service)
         -> Complexity Classifier (heuristic or Haiku one-shot)
         -> IF simple:
              -> Anthropic API direct (Sonnet 4.6)
              -> Fast response, no CLI overhead
         -> IF complex:
              -> claude --resume <session-id> -p "prompt" --output-format stream-json
              -> Full Claude Code capabilities
         -> Response -> Telegram
```

**The key insight:** PAI already has `quickShot()` which calls Claude CLI with `--model haiku`. This could be extended to call the Anthropic API directly for simple tasks, bypassing CLI overhead entirely.

```typescript
// In claude.ts - New method
async sendDirect(message: string): Promise<ClaudeResponse> {
  // Call Anthropic API directly with Sonnet
  // No CLI spawn, no hooks, no file access
  // Just fast text completion
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6-20250514",
    max_tokens: 4096,
    system: this.systemPrompt,
    messages: [{ role: "user", content: message }],
  });
  return {
    sessionId: "",
    result: response.content[0].text,
    usage: response.usage,
  };
}
```

**What you get:**
- Single service, single codebase (PAI bridge)
- Cost optimization: simple messages use Sonnet API (~$0.003/msg)
- Complex tasks get full Claude Code CLI capabilities
- All PAI features preserved (memory, context, commands, pipeline, dashboard)
- No framework dependency on OpenClaw

**What you lose:**
- OpenClaw's 180 bundled skills (you would need to reimplement the useful ones)
- OpenClaw's operational tooling (health checks, auto-update, backup scripts)
- OpenClaw's memory system (but PAI has its own, arguably better-tuned for this use case)
- OpenClaw's battle-tested Telegram integration (Grammy vs OpenClaw's built-in)

**Critical problems:**
1. **Session coherence.** Direct API calls do not share session state with Claude CLI `--resume`. If Sonnet answers 5 messages, then a complex task triggers Claude CLI, the CLI session does not include those 5 messages. You need a shared conversation history.
2. **Two invocation paths = two behavior surfaces.** Sonnet via API and Opus via CLI have different capabilities. Users will notice when "the bot" can suddenly read files or "the bot" cannot read files depending on which path was taken.
3. **Classifier accuracy.** Same as Architecture 4.

**Solving the session coherence problem:**
```typescript
// Maintain a shared transcript in memory.db
// When switching from direct API to CLI:
// 1. Retrieve recent conversation from memory
// 2. Prepend as context to CLI prompt
// 3. CLI response is recorded back to memory

async sendWithRouting(message: string): Promise<ClaudeResponse> {
  const complexity = await this.classify(message);

  if (complexity === "simple") {
    // Direct API - fast, cheap
    const history = await this.memoryStore.getRecentConversation(10);
    const result = await this.sendDirect(message, history);
    await this.memoryStore.record({ role: "user", content: message });
    await this.memoryStore.record({ role: "assistant", content: result.result });
    return result;
  } else {
    // Claude CLI - deep, agentic
    // Context builder already injects memory, so CLI gets conversation history
    return this.send(message);
  }
}
```

**Verdict:** This is the most elegant solution architecturally. It keeps PAI as the single system while adding the cost optimization that OpenClaw provides. The session coherence problem is solvable through memory injection (which PAI already does). The main risk is classifier accuracy, but even a simple heuristic (message length, keywords, explicit commands) would capture 80% of the value.

---

## Architecture 6: The "Sidecar" Pattern (From Infrastructure Engineering)

**Concept:** Borrowed from Kubernetes sidecar containers and service mesh proxies. OpenClaw runs as a "sidecar" to PAI -- a co-located service that provides specific capabilities without owning the primary interaction flow.

**How it would work:**

```
Telegram -> PAI Bridge (PRIMARY - owns the conversation)
         -> For specific capabilities:
              -> HTTP call to OpenClaw gateway (127.0.0.1:18789)
              -> "Use your web search skill to find X"
              -> "Use your cron system to schedule Y"
              -> "Query your memory for Z"
         -> PAI integrates OpenClaw's response into its own
         -> Response -> Telegram
```

**What this means concretely:**
- PAI bridge is the Telegram bot (as it is now)
- OpenClaw gateway runs in the background (as it does now)
- PAI calls `openclaw agent --message "<query>" --json` for specific tasks
- This is exactly what the reverse pipeline does, but via HTTP instead of filesystem

**Why this is different from Architecture 2:**
- PAI decides what to delegate, not OpenClaw
- No "double AI for the same task" -- PAI only calls OpenClaw for things OpenClaw is better at
- The primary AI invocation is always Claude Code CLI

**Use cases for the sidecar:**
1. **Web search:** OpenClaw has `web.search` and `web.fetch` skills. PAI could call these instead of building its own.
2. **Cron management:** OpenClaw's cron system is mature. PAI's Scheduler works but is simpler.
3. **Skill execution:** The 180 bundled skills that do NOT need file access could be invoked via sidecar.
4. **Cost-efficient triage:** Quick questions routed through sidecar (Sonnet) instead of Claude CLI (Opus).

**What you keep:**
- PAI as primary system (all 40+ commands, all capabilities)
- OpenClaw as utility service (cheap AI, web search, cron, skills)
- Both systems run independently (failure isolation)
- Pipeline still works for heavy cross-agent tasks

**Critical problems:**
1. **OpenClaw is heavyweight for a sidecar.** It runs a full Node.js process with gateway, memory, embeddings. That is a lot of RAM and CPU for an occasional web search.
2. **Most OpenClaw skills need file access.** Skills like code review, file management, etc., run in OpenClaw's user context. They cannot access PAI's files.
3. **Two memory systems.** OpenClaw remembers its conversations. PAI remembers its conversations. Neither knows what the other learned.

**Verdict:** Intellectually appealing but over-engineered. If you just need web search, add it to PAI directly. If you just need cheap AI for triage, Architecture 5's direct API call is simpler. The sidecar pattern is best when the sidecar provides capabilities the primary cannot achieve alone -- and there are few things OpenClaw does that PAI genuinely cannot.

---

## Architecture 7: The One I Think You Are Missing -- "Graduated Extraction"

**Concept:** Rather than choosing between OpenClaw and PAI, systematically extract the valuable COMPONENTS from OpenClaw and integrate them into PAI as standalone modules. Not the framework. Not the patterns. The actual functionality.

**What OpenClaw has that PAI does not:**

| Capability | OpenClaw | PAI Equivalent | Gap |
|-----------|----------|----------------|-----|
| 180 bundled skills | Full skill system | AgentLoader (basic) | Large |
| Local embeddings | embeddinggemma-300m | EmbeddingProvider (Ollama-dependent) | Medium |
| Context pruning | cache-ttl with keepLastAssistants | None (CLI manages context) | N/A (CLI handles) |
| Prompt caching | cacheRetention: "long" | None (CLI manages caching) | N/A (CLI handles) |
| Web search/fetch | Built-in tools | WebSearch/WebFetch via CLI tools | Minimal |
| Health monitoring | Built-in gateway endpoint | Dashboard (localhost:3456) | Minimal |
| Auto-update | Cron-based npm update | Manual deploy.sh | Medium |
| Device pairing | Telegram pairing flow | Auth by user ID | Minimal |
| Group chat support | Full group policy | Single-user only | Large if needed |
| Streaming | blockStreamingDefault | Stream-json parsing | Different approach |
| Voice/STT | Research done, not implemented | Not implemented | Neither has it |

**The extraction process:**
1. **Phase 1: Cheap AI path.** Add Anthropic SDK to PAI for direct Sonnet calls. Classifier routes simple messages to Sonnet API, complex to Claude CLI. (Architecture 5's core idea.)
2. **Phase 2: Skill system.** Evolve AgentLoader into a SKILL.md-based system with gating. Port the 10-20 most useful OpenClaw skills (web search, summarization, translation, etc.) to work with either invocation path.
3. **Phase 3: Local embeddings.** Replace Ollama dependency with embeddinggemma-300m (or a Bun-native embedding model). Improves PAI's memory retrieval without external service.
4. **Phase 4: Operational tooling.** Port health-check.sh, auto-update patterns, backup scripts into PAI's codebase (or keep them as standalone scripts).
5. **Phase 5: Group support.** If needed, add Grammy group chat support with per-group session management.

**What this achieves:**
- PAI remains one codebase, one service, one mental model
- OpenClaw gets deprecated over time as capabilities are absorbed
- No framework dependency
- No double invocation
- No impedance mismatch
- Cost optimization through Sonnet fast-path
- Skill ecosystem through extracted patterns

**What you lose:**
- OpenClaw community updates (but you use bundled-only, so this is minimal)
- The "it just works" nature of a maintained framework

**Verdict:** This is my actual recommendation. It is the most work upfront but results in the simplest, most maintainable system long-term. PAI already has 90% of the infrastructure; the remaining 10% (cheap AI path, skill system, local embeddings) are discrete, implementable features.

---

## Recommendation Summary

| Architecture | Complexity | Cost | Capability Retention | Maintainability | Recommendation |
|---|---|---|---|---|---|
| 1. OpenClaw Headless | High | N/A | Low | Low | **Avoid** |
| 2. CLI as Exec Tool | Low | High (double invocation) | Medium | Medium | **Already exists as pipeline** |
| 3. Pattern Adoption | Medium | Same as today | Full PAI | High | **Good incremental path** |
| 4. Cooperative Specialization | High | Optimized | Full both | Medium | **Over-engineered** |
| 5. Unified with Model Switching | Medium | Optimized | Full PAI | High | **Strong choice** |
| 6. Sidecar | Medium | Same + overhead | Full PAI + some OpenClaw | Medium | **Over-engineered** |
| 7. Graduated Extraction | High upfront, Low ongoing | Optimized | Full + OpenClaw best parts | Highest | **Best long-term** |

### My Recommendation: Architecture 7 (Graduated Extraction), starting with Architecture 5 (Model Switching)

**Phase 1 (immediate, 1-2 days):** Add direct Anthropic API calls for simple messages. This is Architecture 5's core -- add `sendDirect()` to claude.ts, add a heuristic classifier, route simple messages to Sonnet API. Immediate cost savings.

**Phase 2 (1 week):** Pattern adoption from Architecture 3. Gateway HTTP API (Bun.serve, trivial), plugin formalization, config file alternative to env vars.

**Phase 3 (2 weeks):** Skill system extraction. SKILL.md format, gating, port top 10 useful OpenClaw skills to PAI's invocation model.

**Phase 4 (ongoing):** Gradually extract remaining value from OpenClaw. Local embeddings, operational tooling, group support if needed.

At each phase, evaluate whether OpenClaw (Gregor) is still providing value that PAI cannot. When the answer is "no," deprecate it. The pipeline continues to work throughout as a fallback for any capability not yet extracted.

---

## Creative Patterns from Other Projects

### Home Assistant's Integration Pattern
Home Assistant does not bundle integrations into its core. It defines an integration API (`manifest.json`, `__init__.py`, `config_flow.py`) and integrations are self-contained packages. PAI could adopt this for its subsystems -- each feature flag becomes a self-registering plugin with its own manifest.

### LangChain's Tool Abstraction
LangChain separates the "tool definition" (schema) from the "tool implementation" (code). This allows the same tool to be exposed to different LLM backends. PAI could define tools abstractly and route them to either Sonnet API or Claude CLI based on complexity.

### Ollama's Model Routing
Ollama runs multiple models and routes requests based on model name. The key insight: the routing layer is stateless. PAI's model switching should similarly be stateless -- classify the message, route to the appropriate backend, collect the response. No shared state between backends.

### VS Code's Extension Host
VS Code runs extensions in a separate process (Extension Host) to prevent crashes from affecting the editor. If PAI ever needs to run OpenClaw skills, running them in a subprocess (like VS Code extensions) prevents OpenClaw bugs from crashing the bridge.

### Envoy Proxy's Filter Chain
Envoy processes requests through a chain of filters (auth, rate limit, routing, etc.). PAI's bridge.ts is essentially a hand-wired filter chain. Formalizing it (Plugin interface with `onMessage`, `onResponse` hooks) would make it extensible without editing bridge.ts.

---

## The Bottom Line

Marius asked: "Can I adapt OpenClaw's architecture in most parts but keep PAI's improvements/adaptations/configurations?"

The answer is: **Yes, but do not adopt the framework -- adopt the patterns and extract the capabilities.** OpenClaw is a monolithic framework that owns the AI invocation. PAI is a custom system that wraps Claude Code CLI. These are fundamentally different approaches. Trying to merge them creates impedance mismatches at every layer.

Instead:
1. Add a cheap AI fast-path to PAI (Sonnet API for simple messages)
2. Adopt OpenClaw's best patterns (skill system, gateway, plugin architecture)
3. Extract the capabilities you actually use from OpenClaw into PAI modules
4. Deprecate OpenClaw when PAI has absorbed its useful functionality

This gives you one codebase, one mental model, full control, and the cost optimization that motivated the question in the first place.
