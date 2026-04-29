# Council Debate: DAI Agent Framework Architecture

**The Question:** "What is the right architecture for evolving DAI's cloud solution into a best-of-all-frameworks agent system with highest independent agency?"

**Grounded in:** 10 frameworks analyzed, 17 research agents, 100+ primary sources, 700K+ tokens synthesized, 31 existing source files in production.

---

## DECISION FORK 1: Agent Framework vs. Targeted Extension

*Should we build an "agent framework" or just extend the existing cloud solution with targeted features?*

---

### The Pragmatist

The codebase has 31 source files handling Telegram, pipeline, orchestration, memory, context, handoff, dashboards, and PRD execution. It works. The research report's own contrarian analysis (Section 13) warns that "8x less memory improved accuracy by 12 points" and that 17x error amplification comes from over-architected multi-agent systems. Every abstraction layer we add is a new failure surface that Marius has to debug at midnight when the VPS bridge goes down.

The honest assessment: DAI's cloud solution already IS an agent framework -- it just doesn't call itself one. It has `MessengerAdapter` (platform abstraction), `TaskOrchestrator` (DAG workflows), `PipelineWatcher` (event-driven dispatch), `BranchManager` (execution isolation), `MemoryStore` (persistence), and `ContextBuilder` (context engineering). What it lacks is not framework architecture -- it lacks three specific features: frozen snapshot injection, project-scoped memory queries, and character-bounded context budgets. Those are each 50-150 lines of code in existing files.

Building "a framework" means rewriting what works to look prettier. Extending the existing system means shipping improvements this week.

**Recommendation:** No framework. Targeted feature additions to `context.ts`, `memory.ts`, and `config.ts`. Ship value, not abstractions.

---

### The Framework Architect

The Pragmatist is right that the current 31 files work -- for two agents (Isidore and Gregor) doing a narrow set of tasks. But "highest independent agency" means the system must be able to spawn, configure, and manage agents that don't exist yet, for tasks that haven't been conceived. That requires abstractions the current code doesn't have.

Consider what happens when Marius wants to add a third agent -- say an email bridge agent, or a research daemon. Right now, adding a new agent means: writing a new adapter, manually wiring it into `bridge.ts`, hand-coding its pipeline integration, manually configuring its context rules. There's no agent definition format. There's no way for an agent to declare its own capabilities, memory scopes, or tool access. Every new agent is a custom engineering project.

What's needed:
1. **Markdown agent definitions** (`.pai/agents/agent-name.md`) -- declarative agent config that specifies identity, capabilities, memory scopes, tool access, and trigger conditions. OpenCode and Hermes both validate this pattern.
2. **Agent registry v2** -- the current `AgentRegistry` tracks heartbeats. It needs to become a capability registry that maps agents to their skills and dispatch rules.
3. **Progressive skill loading** -- DAI has 48 SKILL.md files. Injecting all of them burns tokens. Three-tier disclosure (categories -> list -> full content) is validated by Hermes.
4. **Self-editing memory** -- Letta's core insight: agents that can edit their own context are fundamentally more capable than agents with read-only memory.

This isn't "rewriting what works." The existing code becomes the first implementation of a proper agent contract. `TelegramAdapter` becomes the reference `MessengerAdapter`. The current pipeline flow becomes one dispatch strategy among several.

**Recommendation:** Build the framework -- but do it by extracting abstractions from existing code, not by rewriting from scratch. Agent definitions, capability registry, progressive skills.

---

### The Autonomy Maximalist

Both previous perspectives miss the actual bottleneck. DAI today is a reactive system: Marius sends a Telegram message, Isidore responds. Gregor writes a task file, the pipeline picks it up. Everything starts with a human action or a cron-scheduled action.

"Highest independent agency" means the agent initiates its own work. It notices things. It acts on observations without being asked. The research report identifies this as the gap DAI must close -- and neither memory improvements nor agent definitions address it.

What's actually needed for autonomy:
1. **Event-driven triggers beyond polling** -- Watch file changes, git events, system metrics, incoming emails, calendar events. Not "poll every 5 seconds" but reactive event streams.
2. **Session auto-resume** -- The agent should be able to start a new conversation with itself when it observes something worth acting on. Not wait for someone to `/start` it.
3. **Continuous operation loop** -- A ReAct-style loop that checks for events, decides whether to act, acts, observes results, and loops. The Hermes Agent has a 60-iteration ReAct loop. DAI has zero -- it's strictly request-response.
4. **Goal persistence** -- When the agent decides to pursue a multi-step goal, it needs to persist that goal across sessions and resume it on restart. `HandoffManager` is close but designed for cross-instance transfer, not self-initiated goal tracking.

Memory is polish. Agent definitions are architecture for its own sake. The LOOP is what separates a tool from an agent. Without a continuous operation loop, you can have the best context engineering in the world and you still have a chatbot, not an agent.

**Recommendation:** Build the autonomy loop first. Event triggers, self-initiation, goal persistence, continuous operation. Everything else is secondary.

---

### The Hermes Agent Fan

All three perspectives contain partial truths, but they're arguing past the evidence. Hermes Agent shipped a production personal agent in 5 days that got 1,442 GitHub stars. It has exactly the patterns the research validated. Let me be specific about what Hermes proves:

1. **The frozen snapshot pattern is not "nice to have" -- it's the foundation.** Every other memory improvement depends on cache stability. Without it, you're paying 4x cost on every invocation and getting worse results because the shifting prefix invalidates the model's attention patterns.

2. **Character-bounded memory forces the agent to curate, which IS self-editing.** The Framework Architect wants a Letta-style memory editor. Hermes achieves the same effect more simply: give the agent a 5K char budget and tools to read/write it. The agent curates because it must. No complex CRUD API needed.

3. **Progressive disclosure is proven at scale.** Hermes loads skill categories (~50 tokens), then skill lists (~3K tokens), then full skills. DAI has 48 skills and growing. This is not optional past ~30 skills.

4. **Injection scanning is the security pattern the Pragmatist ignores.** DAI accepts tasks from Gregor across a shared filesystem. That's a trust boundary. Hermes's regex scanner for invisible Unicode and injection patterns is 100 lines and prevents a class of attacks.

Now, where Hermes falls short and DAI shouldn't follow: no structured workflow engine (DAI's DAG orchestrator is better), no cross-agent collaboration (DAI's pipeline is better), Python (slower than Bun), and no branch isolation. DAI is already ahead on all of these.

The Autonomy Maximalist makes a compelling case for the loop, but Hermes shows that a persistent daemon with cron triggers and reactive processing achieves 80% of that value without building a custom event system. DAI already has `PipelineWatcher` polling every 5 seconds -- extend it, don't replace it.

**Recommendation:** Adopt Hermes's three core patterns (frozen snapshot, bounded memory, injection scanning) immediately. Add progressive skill loading in the next phase. Skip the framework rewrite. Build autonomy features on top of the improved context foundation.

---

### SYNTHESIS: Fork 1

**Decision: Evolutionary extension, not framework rewrite. But with two strategic abstractions.**

The evidence strongly favors the Pragmatist and Hermes Fan on the core question: don't build a framework from scratch. The 31 existing files already implement the key patterns. The research's own "What NOT to Do" list warns against over-engineering, and the contrarian analysis (Section 13) found that simpler systems consistently outperform complex ones in practice.

However, the Framework Architect identifies a real scaling problem: adding new agents today is a custom engineering project. Two targeted abstractions address this without a rewrite:

1. **Markdown agent definitions** -- a `.pai/agents/` directory with declarative agent configs. This is a FILE FORMAT, not a framework. It costs ~200 lines and pays off at agent #3.
2. **Capability-aware agent registry** -- extend the existing `AgentRegistry` SQLite table with a `capabilities` column. Not a rewrite, an ALTER TABLE + 50 lines.

Everything else -- the existing `MessengerAdapter`, `TaskOrchestrator`, `PipelineWatcher`, `BranchManager` -- stays as is.

**Verdict: Extend with targeted features (Pragmatist wins on principle). Add markdown agent definitions and capability registry as the only new abstractions (Framework Architect's minimum viable contribution). No framework rewrite.**

---

## DECISION FORK 2: Memory/Context First vs. Autonomy/Self-Initiation First

*What comes first: memory/context improvements or self-initiation/autonomy infrastructure?*

---

### The Pragmatist

Memory and context first. Not because autonomy doesn't matter, but because every autonomous action the agent takes will be limited by the quality of its context. An agent that self-initiates but has poor memory will make bad decisions autonomously -- which is worse than making no decisions at all.

The numbers are concrete: frozen snapshot injection yields ~75% input cost reduction. That means the agent can run 4x more invocations at the same cost, or the same invocations at 25% cost. For a VPS running 24/7, that's the difference between a sustainable system and one that burns through API credits.

The implementation path is also faster. Frozen snapshots: modify `context.ts`, add `freeze()` method, ~50 lines. Project-scoped queries: add filters to `memory.ts`, ~80 lines. Character-bounded budget: add budget parameter to `ContextBuilder`, ~100 lines. Total: one focused session.

Autonomy infrastructure requires: event system design, trigger definitions, goal persistence schema, continuous loop architecture, error recovery for autonomous actions, cost guardrails for self-initiated invocations. That's weeks of design and implementation, with higher risk of introducing instabilities into a production system.

**Recommendation:** Memory/context first. The ROI is higher, the risk is lower, the implementation is faster, and it makes the eventual autonomy features work better.

---

### The Framework Architect

The Pragmatist's ordering is correct, but for the wrong reason. Memory/context comes first not because of cost savings, but because the agent definition system depends on proper context architecture.

Agent definitions need to specify memory scopes: "this agent can access project/my-pai-cloud but not project/personal-journal." That requires project-scoped memory queries to already exist. Agent definitions need to specify context budgets: "this agent gets 2K tokens of memory, that agent gets 8K." That requires character-bounded context to already exist. Agent definitions need to specify skill access: "this agent has access to research and coding skills, not social media." That requires progressive skill loading to already exist.

The dependency chain is: memory/context improvements -> agent definitions -> autonomy features. You can't meaningfully define autonomous agents without first having the context infrastructure they'll operate on.

**Recommendation:** Memory/context first, but explicitly as the foundation for agent definitions, which are the foundation for autonomy. Three-phase sequential dependency.

---

### The Autonomy Maximalist

I expected this consensus and I'll push back hard. Consider the actual user experience:

**With better memory but no autonomy:** Marius opens Telegram, types a message, Isidore responds with slightly better context. The agent remembers more accurately, costs less per invocation. But Marius still has to initiate every interaction. The agent is still a tool, not an agent.

**With autonomy but worse memory:** Marius wakes up and sees that Isidore noticed a failing CI check at 3am, opened a branch, attempted a fix, and left a Telegram notification. The context might be imperfect, but the agent ACTED independently. It behaved like an agent.

The user experience delta from autonomy is categorically larger than the user experience delta from better memory. Better memory is invisible -- the user doesn't notice the agent remembering correctly, they notice when it forgets. Autonomy is visible -- the user actively benefits from the agent doing things unprompted.

I'll concede the cost argument: if the system costs 4x more per invocation, running an autonomous loop is expensive. So do the frozen snapshot (it's 50 lines!) and THEN build autonomy. But don't do the full memory/context improvement stack (16 priority items from the research report) before touching autonomy.

**Recommendation:** Frozen snapshot first (50 lines, 75% cost reduction), then autonomy loop, then remaining memory improvements in parallel.

---

### The Hermes Agent Fan

The Autonomy Maximalist makes a smart tactical concession. Hermes Agent's architecture validates exactly this ordering: memory injection patterns are foundational (they affect every single invocation), so they go first. But Hermes also shows that "autonomy" doesn't require building a custom event system -- it already exists in simpler forms.

Hermes has cron-based scheduling built in. DAI already has `PipelineWatcher` polling every 5 seconds. The gap between "polling for external tasks" and "polling for self-generated goals" is tiny. You don't need an event system. You need a `goals` table in SQLite and a check in the poll loop: "any goals I should work on?"

Here's the actual ordering Hermes's architecture suggests:
1. Frozen snapshot injection (cache stability for everything downstream)
2. Character-bounded memory (prevent context rot before enabling more invocations)
3. Injection scanning (security before opening up more automated execution)
4. Goal persistence table (SQLite, 30 lines)
5. Self-initiation check in `PipelineWatcher` poll loop (50 lines)

Steps 1-3 are memory/context. Steps 4-5 are minimal autonomy. Total: one focused implementation session. The Autonomy Maximalist doesn't need weeks of event system design -- they need a database table and a conditional check.

**Recommendation:** Memory foundation (frozen snapshot + bounds + scanning) as one atomic unit, then lightweight autonomy (goal table + poll check) immediately after. Not sequential phases -- one combined sprint.

---

### SYNTHESIS: Fork 2

**Decision: Memory foundation first, then lightweight autonomy, as a single sprint -- not separate phases.**

The Hermes Fan resolves the apparent conflict elegantly. The ordering debate assumed that "autonomy" requires heavy event system engineering. It doesn't. The minimum viable autonomy is:

1. A `goals` table in SQLite (goal text, priority, status, created_at, due_at)
2. A check in the existing `PipelineWatcher` poll loop: "any ready goals? If so, create a one-shot task."
3. A `/goal` command in Telegram to add goals manually
4. Self-generated goals from task completion ("now that I finished X, I should do Y")

That's ~150 lines on top of existing infrastructure.

The memory work (frozen snapshot, bounded memory, injection scanning) is the prerequisite because:
- Cost: autonomous loops multiply invocation count; 75% cost reduction makes them viable
- Quality: autonomous decisions on bad context are dangerous
- Security: self-initiated execution crosses trust boundaries more aggressively

**Verdict: Sprint 1 = frozen snapshot + bounded memory + injection scanning (~250 lines). Sprint 2 = goal persistence + self-initiation poll (~150 lines). Both within the same implementation phase, not separated by months. The Autonomy Maximalist's user-experience argument is right -- but the Hermes Fan shows the implementation path is much shorter than the Maximalist assumed.**

---

## DECISION FORK 3: Sniper Agents vs. Generalist vs. Hybrid

*Purpose-built specialist agents vs. the current generalist model vs. a hybrid approach?*

---

### The Pragmatist

The current model is one generalist agent (Isidore) that handles everything via Telegram, plus one-shot pipeline workers for Gregor's tasks. This works because Claude is already a generalist -- it handles coding, writing, research, and conversation without specialized configuration.

Specialist agents sound appealing in theory ("a research agent that's optimized for research!") but in practice they fragment context and multiply operational complexity. You need to route tasks to the right specialist, handle cases where a task spans multiple specialties, manage context sharing between specialists, and debug failures in an N-agent system instead of a 1-agent system.

The research report's finding is stark: "17x error amplification" in multi-agent systems (Section 13). More agents = exponentially more failure modes. The production systems that work best (Manus, Factory.ai) use a single orchestrator with tool specialization, not agent specialization.

The one exception: the pipeline one-shot workers are already "sniper" agents -- they get a focused task, execute it, return a result. That pattern works because they're stateless and isolated. Extending it to stateful specialist agents is a different beast entirely.

**Recommendation:** Keep the generalist model for interactive work. Keep stateless snipers for pipeline tasks. Don't build persistent specialist agents.

---

### The Framework Architect

The Pragmatist conflates "specialist agents" with "permanent specialist agents." The right model is agent definitions that can be instantiated on demand and disposed after use. Not persistent daemons -- templates.

Consider how the Algorithm works today: it can select capabilities (research, first principles, council, etc.) and invoke them as skills. What if those skills could be full agent definitions? "For this task, spawn a research agent with access to web search and the project's memory, scoped to the `research/` namespace." That's not a permanent specialist -- it's a configured one-shot with the right context.

Markdown agent definitions enable this naturally:

```markdown
# research-agent.md
## Identity
Research specialist for DAI projects
## Memory Scope
project/{active-project}/research
## Tools
web-search, file-read, memory-write
## Context Budget
4K tokens
## Max Turns
20
```

The agent is instantiated when needed, runs with its specific context and tool access, writes results to its scoped memory namespace, and terminates. The main agent (Isidore) orchestrates, decides when to spawn specialists, and synthesizes results.

This is the hybrid: a generalist orchestrator that spawns configured specialists on demand. It gets the benefits of specialization (scoped context, focused tools, limited blast radius) without the operational overhead of permanent specialist daemons.

**Recommendation:** Hybrid -- generalist orchestrator (Isidore) with on-demand specialist agent templates defined in markdown. No permanent specialist daemons.

---

### The Autonomy Maximalist

The hybrid model is correct, but the Framework Architect's "on-demand" framing underestimates the autonomy implications. Some agents need to be persistent:

1. **The watcher agent** -- monitors git events, CI, file changes, and Telegram silence. Runs continuously. Its job is to notice things and generate goals for the main agent. This must be persistent.
2. **The maintenance agent** -- runs memory curation, log cleanup, performance monitoring on a schedule. Doesn't need human invocation. Persistent by nature.
3. **The research daemon** -- when Isidore encounters a knowledge gap, it should be able to dispatch a research task and continue other work, picking up results later. This needs a persistent queue, not a synchronous sub-agent.

The real taxonomy isn't "generalist vs. specialist" -- it's:
- **Orchestrator** (Isidore) -- persistent, interactive, generalist
- **Reactive workers** (pipeline) -- stateless, one-shot, task-specific
- **Daemon agents** -- persistent, autonomous, narrow-scope (watchers, maintenance)
- **Configured specialists** -- on-demand, templated, medium-scope (research, analysis)

Each type has different lifecycle, memory, and cost characteristics. The markdown agent definitions should capture this taxonomy.

**Recommendation:** Four-type agent taxonomy. The existing generalist + pipeline workers are types 1 and 2. Add daemon agents (type 3) and configured specialists (type 4) as the framework matures.

---

### The Hermes Agent Fan

Hermes Agent handles this question pragmatically: one primary agent that can delegate to sub-agents (depth-limited to 2). No persistent specialists, no daemon agents. The primary agent decides when to delegate and synthesizes results.

The key insight from Hermes: **delegation is a tool, not an architecture.** The agent has a `delegate_task` tool that spawns a sub-agent with a specific prompt and context subset. The sub-agent runs, returns a result, terminates. This is remarkably similar to DAI's existing pipeline one-shot pattern.

The Autonomy Maximalist's "watcher" and "maintenance" agents are over-engineered. A cron job that checks conditions and writes a task file to the pipeline achieves the same thing as a persistent watcher daemon, with 1/10th the complexity and zero risk of agent identity confusion.

The only part of the Autonomy Maximalist's taxonomy that adds real value is the distinction between synchronous specialists (wait for result) and asynchronous specialists (dispatch and continue). DAI's pipeline is async by nature. The missing pattern is synchronous: "spawn a research sub-agent, wait for the result, incorporate it into my current response." That's closer to Hermes's `delegate_task` than to a new agent type.

**Recommendation:** Delegation-as-a-tool. Primary agent (Isidore) + pipeline workers (existing) + synchronous sub-delegation (new, Hermes-inspired). Persistent daemon agents only if cron + pipeline proves insufficient after real-world testing.

---

### SYNTHESIS: Fork 3

**Decision: Generalist orchestrator + two delegation modes (sync and async). No persistent specialist daemons initially.**

The consensus is a three-tier model:

1. **Isidore (orchestrator)** -- persistent, interactive, full context, generalist. Handles direct Telegram conversation and decides when to delegate.

2. **Async pipeline workers** -- the existing `PipelineWatcher` one-shot pattern. Stateless, isolated, task-specific. Used for Gregor collaboration, background tasks, and self-initiated goals.

3. **Sync sub-delegation** -- NEW. Isidore spawns a focused sub-agent within its own turn, waits for the result, and incorporates it. Scoped context, scoped tools, scoped memory. This is Hermes's `delegate_task` adapted to DAI's architecture. Implementation: a `delegateTask()` function in `claude.ts` that runs a one-shot with specific context parameters.

The Framework Architect's markdown agent definitions serve as templates for tiers 2 and 3 -- defining what context, tools, and memory scope each type of delegated task gets. This is the right level of abstraction: not a framework, but a configuration format.

The Autonomy Maximalist's "daemon agents" are deferred. The Hermes Fan's argument is persuasive: cron + pipeline polling achieves 80% of daemon value with 10% of the complexity. If real-world usage reveals cases where polling is genuinely insufficient, daemon agents can be added later -- the goal persistence system from Fork 2 provides the foundation.

**Verdict: Three tiers (orchestrator, async workers, sync sub-delegation). Markdown agent definitions as templates. No persistent specialist daemons in v1. Daemon agents as a future option if cron+pipeline proves insufficient.**

---

## DECISION FORK 4: How Much of Hermes Agent to Adopt?

*What percentage and which specific patterns from Hermes Agent should we adopt directly?*

---

### The Pragmatist

Exactly three patterns, and nothing else:

1. **Frozen snapshot injection** -- proven, simple, ~75% cost reduction. 50 lines in `context.ts`.
2. **Character-bounded memory** -- prevents context rot. 100 lines in `context.ts`.
3. **Injection scanning** -- security for the pipeline trust boundary. 80 lines, new file or in `schemas.ts`.

Total: ~230 lines. Everything else from Hermes is either (a) something DAI already does better (workflows, cross-agent, branch isolation, TypeScript), (b) not relevant to DAI's use case (RL training, multi-model synthesis), or (c) premature optimization (progressive skill loading -- DAI has 48 skills, not 500).

The temptation to "adopt an architecture" is dangerous. Hermes is Python, 5 days old, built for a different model ecosystem (OpenRouter + OpenAI SDK), and designed for a single-agent use case. DAI is TypeScript, 6+ months mature, built on Claude CLI, and designed for multi-agent collaboration. The patterns transfer. The architecture doesn't.

**Recommendation:** Three patterns, ~230 lines. Nothing architectural.

---

### The Framework Architect

The Pragmatist's three patterns are necessary but insufficient. Hermes reveals two additional patterns that are architectural and worth adopting:

4. **Self-registration tool pattern** -- each tool is self-contained with schema, handler, and registry call co-located. As DAI's tool ecosystem grows (it's already at 30+ utilities), a central switch statement becomes unmaintainable. This is a codebase health investment, not a framework indulgence.

5. **Progressive skill disclosure** -- DAI has 48 skills today and they're growing. The three-tier pattern (categories ~50 tokens -> list ~3K tokens -> full content) prevents the token budget from being consumed by skill definitions that aren't relevant to the current task. This becomes critical at ~60-80 skills.

Both of these are patterns that apply regardless of whether you adopt Hermes's overall architecture. They're techniques for managing growing complexity in any agent system.

What I explicitly agree NOT to adopt: Hermes's monolithic `run_agent.py` (1,800 lines in one file), its Python stack, its OpenRouter abstraction, its basic context compression (DAI should do better), and its lack of structured workflows.

**Recommendation:** Five patterns total. The Pragmatist's three plus self-registration and progressive disclosure. The architecture stays DAI's own.

---

### The Autonomy Maximalist

I want to adopt one more thing the others are ignoring: **Hermes's ReAct loop structure.**

Hermes has a 60-iteration execution loop: think -> act -> observe -> think -> act -> observe. This is the continuous operation loop I argued for in Fork 2. DAI currently has zero loop structure -- it's purely request-response.

You don't need to copy Hermes's implementation. But the CONCEPT of a bounded iteration loop that can make multiple decisions before returning to the user is essential for autonomy. When Isidore is working on a multi-step goal, it shouldn't need a new Telegram message between each step. It should loop: assess progress, decide next action, execute, observe result, repeat.

Claude CLI's `--max-turns` flag already provides this for pipeline tasks. But interactive Telegram sessions are single-turn. The missing piece is a loop wrapper for interactive mode that allows multi-step execution within a single user request.

This isn't adopting Hermes's code. It's adopting the concept of bounded autonomous execution, which Hermes validates as workable in a production personal agent.

**Recommendation:** Six patterns. The Framework Architect's five plus the bounded iteration loop concept (not Hermes's implementation).

---

### The Hermes Agent Fan

I'll be honest about what to adopt and what to skip, because the point isn't to copy Hermes -- it's to learn from it.

**Adopt directly (proven, transferable, high ROI):**
1. Frozen snapshot injection -- the single highest-impact pattern
2. Character-bounded curated memory -- forces the quality behavior
3. Injection scanning -- security for cross-user boundaries
4. Progressive skill disclosure -- necessary at DAI's current scale
5. Self-registration tool pattern -- codebase health for growing tooling

**Adopt the concept, build DAI's own implementation:**
6. Bounded iteration loop -- the ReAct concept, not the code. DAI should implement this differently because Claude CLI already provides multi-turn via `--resume`.
7. Skill self-authoring -- the IDEA that agents can create new skills from successful patterns. DAI's Algorithm PRD system could evolve to extract reusable patterns.

**Study but defer:**
8. Mixture-of-Agents query (interesting but DAI's research skill already does ad-hoc multi-model)
9. Sandbox terminal backends (valuable when running untrusted code, not urgent)
10. ACK detection (useful but low priority -- Claude Code handles this internally)

**Skip entirely:**
- Python architecture (DAI is TS/Bun, faster, better typed)
- OpenAI SDK abstraction (DAI talks to Claude CLI)
- RL training pipeline (different use case)
- File-backed memory (SQLite + FTS5 already better)
- Monolithic gateway (DAI's MessengerAdapter is cleaner)

**Recommendation:** 5 direct adoptions, 2 concept adoptions, 3 deferred, 5 skipped. That's roughly 30% of Hermes's surface area, focused on the patterns that are language-agnostic and architecture-agnostic.

---

### SYNTHESIS: Fork 4

**Decision: 5 direct pattern adoptions + 2 concept adoptions. ~30% of Hermes's patterns.**

The council converges on a clear adoption boundary:

**Direct adoptions (implement in DAI's TypeScript):**
1. Frozen snapshot injection -- `context.ts` modification, ~50 lines
2. Character-bounded curated memory -- `context.ts` modification, ~100 lines
3. Injection scanning -- new utility or addition to `schemas.ts`, ~80 lines
4. Progressive skill disclosure -- new skill loader utility, ~200 lines
5. Self-registration tool pattern -- refactor pattern for growing tools, ~150 lines

**Concept adoptions (DAI's own design, inspired by Hermes):**
6. Bounded iteration loop -- adapt for Claude CLI `--resume` + `--max-turns`
7. Skill self-authoring seed -- extract reusable patterns from successful Algorithm PRD runs

**Explicitly not adopted:** Python stack, OpenRouter abstraction, monolithic gateway, file-backed memory, RL training, basic context compression (DAI should do better with observation masking).

**Verdict: Selective adoption of validated patterns, not architectural copying. DAI keeps its TypeScript/Bun foundation, Claude CLI integration, and multi-agent pipeline architecture -- all areas where it's already ahead of Hermes. It borrows Hermes's memory discipline and extensibility patterns where Hermes is ahead.**

---

## DECISION FORK 5: The DAI Algorithm's Role in Autonomous Agents

*Should autonomous agents use the Algorithm, or is it human-mode only?*

---

### The Pragmatist

The Algorithm is a 320-line structured execution protocol with 7 phases, ISC criteria, voice announcements, PRD management, and mandatory output formats. It's designed for a human watching the output in real-time, providing feedback at each phase, and verifying the result matches expectations.

Autonomous agents have no human watching. Voice announcements go to nobody. The PRD format's value is in communicating progress to Marius -- an autonomous agent's progress doesn't need a human-readable dashboard (the existing `dashboard.ts` serves that role).

More critically, the Algorithm's overhead is expensive. Each Algorithm run involves: creating a PRD directory, writing YAML frontmatter, decomposing into ISC criteria, running premortem analysis, invoking skills, and performing verification. For a self-initiated background task like "check if the CI pipeline is green," that's massive overhead for a binary check.

The Algorithm exists to ensure quality on tasks that justify the investment. Autonomous background tasks are often lightweight checks, maintenance operations, or information gathering that should be fast and cheap.

**Recommendation:** Algorithm is human-interactive mode only. Autonomous agents use lightweight one-shot execution (existing pipeline pattern). The Algorithm's ISC and verification principles can inform autonomous agents' self-checks, but the full 7-phase ceremony is reserved for human-facing work.

---

### The Framework Architect

The Pragmatist is correct that the full Algorithm is too heavy for autonomous tasks. But dismissing it entirely throws away its most valuable contribution: structured verification.

The Algorithm's core insight is ISC -- Ideal State Criteria. Before executing, define what "done" looks like in atomic, verifiable terms. After executing, verify each criterion. This discipline is MORE important for autonomous agents than for human-supervised ones, because there's no human to catch errors.

The right answer is a tiered execution protocol:

**Tier 1: Algorithm Full (human-interactive)**
- 7 phases, ISC, PRD, voice, output formatting
- For: Telegram conversations, complex tasks where Marius is engaged

**Tier 2: Algorithm Lite (autonomous complex)**
- 3 phases: PLAN (define criteria), EXECUTE, VERIFY
- ISC criteria without PRD ceremony
- No voice, no formatted output
- Results written to pipeline result JSON
- For: Self-initiated multi-step goals, scheduled complex tasks

**Tier 3: One-Shot (autonomous simple)**
- Single invocation, no phases
- Success/failure determination from output
- For: Checks, maintenance, simple queries

The agent's autonomy layer decides which tier based on task complexity. The goal persistence system from Fork 2 could include a `complexity` field that maps to execution tier.

**Recommendation:** Three-tier execution protocol. Full Algorithm for human work, Algorithm Lite (ISC without ceremony) for complex autonomous tasks, one-shot for simple tasks.

---

### The Autonomy Maximalist

The Framework Architect's three tiers are the right structure, but there's a deeper question: can an autonomous agent USE the Algorithm to plan its own work? Not execute it as ceremony -- but internalize its principles as a decision-making framework?

Consider an agent that notices a pattern of failing deployments. With no Algorithm: it tries a fix, maybe it works, maybe it doesn't. With Algorithm principles internalized: it defines what "fixed" means (ISC), identifies riskiest assumptions (THINK), plans the fix (PLAN), executes, and verifies. Not as a formatted output -- as internal reasoning structure.

This is the difference between an agent that acts and an agent that THINKS before acting. The Algorithm's value isn't in its output format -- it's in its cognitive scaffolding. An autonomous agent that defines success criteria before acting and verifies them after is fundamentally more reliable than one that doesn't.

My recommendation: extract the Algorithm's cognitive patterns into an "autonomous reasoning protocol" that's much lighter than the full ceremony but preserves the core discipline:

1. Define success criteria (3-5 atomic criteria, not a full ISC decomposition)
2. Identify the riskiest assumption
3. Execute
4. Verify each criterion
5. Record outcome (success/failure + what was learned)

This takes ~30 seconds of model time, not 5+ minutes of Algorithm ceremony. But it prevents the "act first, think never" failure mode that plagues autonomous agents.

**Recommendation:** Extract Algorithm's cognitive scaffolding into a lightweight autonomous reasoning protocol. Full Algorithm stays human-mode. But autonomous agents should THINK like the Algorithm even if they don't FORMAT like it.

---

### The Hermes Agent Fan

Hermes Agent's approach is relevant here. Hermes has no formal execution protocol -- it runs a ReAct loop where the model decides what to do at each step. But it does have an implicit quality mechanism: ACK detection. When the model produces a planning acknowledgment instead of actually acting, the system auto-continues.

This reveals the real risk of autonomous execution: not "the agent doesn't plan enough" but "the agent plans endlessly without acting." The Autonomy Maximalist's lightweight reasoning protocol is good, but it needs a complementary mechanism: action forcing.

Hermes's answer is simple: if the model says "I'll look into that" instead of calling a tool, force another iteration. The equivalent for DAI: if an autonomous agent spends more than 2 turns reasoning without executing a tool call, force an action or abort.

The three-tier model is correct. I'd add one constraint:

- **Tier 2 (Algorithm Lite) must have a turn budget.** Max 10 turns for planning + execution + verification. This prevents autonomous agents from running up API costs through unbounded reasoning.
- **Tier 3 (one-shot) is already turn-limited** via `--max-turns 1`.

The Algorithm's full 7-phase protocol with PRD, voice, and formatted output is absolutely human-mode only. But its PRINCIPLES (define criteria, check assumptions, verify) should be encoded as lightweight prompts injected into Tier 2 autonomous tasks.

**Recommendation:** Three tiers confirmed. Tier 2 gets Algorithm principles as a system prompt addition (not the full protocol). Turn budgets on all autonomous execution. ACK/stall detection to prevent reasoning loops.

---

### SYNTHESIS: Fork 5

**Decision: Three-tier execution protocol. Full Algorithm is human-mode only. Algorithm principles (not ceremony) propagate to autonomous execution.**

The council agrees on a clean separation:

**Tier 1: Full Algorithm** (human-interactive only)
- 7 phases, ISC decomposition, PRD management, voice announcements, formatted output
- Triggered by: Telegram conversation, interactive sessions
- Budget: determined by effort level (2-120 minutes)

**Tier 2: Algorithm Lite** (autonomous complex tasks)
- 3 phases: CRITERIA (3-5 atomic success criteria) -> EXECUTE -> VERIFY
- No PRD, no voice, no formatted output
- Algorithm principles injected via system prompt prefix:
  - "Define 3-5 success criteria before acting"
  - "Identify your riskiest assumption"
  - "Verify each criterion after execution"
  - "Record what you learned"
- Turn budget: max 10 turns
- Stall detection: 2 consecutive reasoning-only turns -> force action or abort
- Results: written to pipeline result JSON with `verification` field

**Tier 3: One-Shot** (autonomous simple tasks)
- Single Claude invocation, `--max-turns 1`
- Success/failure determined from output
- For: checks, maintenance, simple queries, information gathering

The goal persistence system from Fork 2 includes a `complexity` field (`simple | moderate | complex`) that maps to execution tier. The agent decides complexity at goal creation time; it can be overridden.

**Verdict: The Algorithm's CEREMONY is human-only. The Algorithm's PRINCIPLES are universal. Autonomous agents think like the Algorithm but don't format like it. Turn budgets and stall detection prevent unbounded autonomous execution.**

---

# FINAL ARCHITECTURE RECOMMENDATION

## The Overall Vision

DAI evolves from a Telegram bridge with pipeline support into a **self-initiating personal agent system** -- but through EXTENSION of working code, not through framework construction. The research synthesis, grounded in 10 frameworks and 100+ sources, points to an architecture that is deceptively simple because it builds on what already exists.

## The Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                    DAI Agent System v5                               │
│                                                                     │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │              ISIDORE (Primary Orchestrator)                    │ │
│  │  - Persistent, interactive, full context                      │ │
│  │  - Full Algorithm for human-facing work                       │ │
│  │  - Decides when to delegate, which tier to use                │ │
│  │  - Self-initiation via goal persistence                       │ │
│  └────────┬──────────────┬───────────────────┬───────────────────┘ │
│           │              │                   │                     │
│     ┌─────▼─────┐  ┌────▼──────┐  ┌────────▼────────┐            │
│     │ Telegram  │  │  Pipeline  │  │  Sync Sub-      │            │
│     │ Adapter   │  │  Workers   │  │  Delegation     │            │
│     │ (Tier 1)  │  │  (Tier 3)  │  │  (Tier 2/3)    │            │
│     └───────────┘  └───────────┘  └─────────────────┘            │
│                                                                     │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │              CONTEXT ENGINE (Enhanced)                         │ │
│  │                                                                │ │
│  │  Frozen Snapshot Memory ──┐                                   │ │
│  │  Character-Bounded Budget ─┤─→ Cache-Stable Prefix            │ │
│  │  Project-Scoped Queries ──┘                                   │ │
│  │                                                                │ │
│  │  Injection Scanning ──→ Pipeline Trust Boundary                │ │
│  │  Progressive Skills ──→ Token-Efficient Skill Loading          │ │
│  │  Observation Masking ──→ History Compression                   │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │              AUTONOMY LAYER (New)                              │ │
│  │                                                                │ │
│  │  Goal Persistence (SQLite) ──→ Self-initiated tasks           │ │
│  │  Poll Check in PipelineWatcher ──→ Goal dispatch              │ │
│  │  /goal Command ──→ Manual goal creation                       │ │
│  │  Task Completion → Goal Generation ──→ Chained agency         │ │
│  │  Three-Tier Execution ──→ Right-sized processing              │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │              AGENT DEFINITIONS (.pai/agents/)                  │ │
│  │                                                                │ │
│  │  Markdown templates for delegated tasks                       │ │
│  │  Identity, memory scope, tool access, context budget          │ │
│  │  Complexity classification → execution tier mapping           │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │              EXISTING INFRASTRUCTURE (Unchanged)               │ │
│  │                                                                │ │
│  │  TaskOrchestrator ─ BranchManager ─ HandoffManager            │ │
│  │  RateLimiter ─ ResourceGuard ─ Verifier ─ Dashboard           │ │
│  │  PRDExecutor ─ SessionManager ─ ProjectManager                │ │
│  └────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

## Implementation Phases

### Phase A: Context Foundation (Sprint 1, ~1 session)
**Estimated lines changed:** ~400

1. Frozen snapshot injection in `context.ts` (~50 lines)
2. Character-bounded memory budget in `context.ts` (~100 lines)
3. Project + source filters on `MemoryStore.search()` in `memory.ts` (~80 lines)
4. Injection scanning utility (~80 lines, new file or in `schemas.ts`)
5. Enable `CONTEXT_INJECTION_ENABLED=1` on VPS with conservative budget
6. Config additions in `config.ts` (~30 lines)

### Phase B: Lightweight Autonomy (Sprint 2, ~1 session)
**Estimated lines changed:** ~300

1. Goal persistence table in existing SQLite DB (~30 lines in `memory.ts` or new `goals.ts`)
2. Goal dispatch check in `PipelineWatcher` poll loop (~50 lines in `pipeline.ts`)
3. `/goal` Telegram command (~40 lines in `telegram.ts`)
4. Goal generation from task completion (~60 lines in `orchestrator.ts`)
5. Three-tier execution router (~80 lines, new `execution-tier.ts`)
6. Algorithm Lite system prompt template (~40 lines)

### Phase C: Agent Definitions + Sub-Delegation (Sprint 3, ~1-2 sessions)
**Estimated lines changed:** ~500

1. Markdown agent definition format spec
2. Agent definition loader (~100 lines)
3. Sync sub-delegation function in `claude.ts` (~120 lines)
4. Capability-aware agent registry extension (~50 lines in `agent-registry.ts`)
5. Progressive skill disclosure loader (~200 lines)
6. Self-registration tool pattern refactor (~distributed across tool files)

### Phase D: Advanced Patterns (Future, as needed)
- Observation masking for history compression
- Whiteboard / running summary per project
- Skill self-authoring from successful patterns
- Cache-friendly prompt ordering
- Session forking capability
- Artifact management service

## Key Principles

1. **Extend, don't rewrite.** Every existing module stays. New features are additive.
2. **Prove value at each phase.** Each sprint delivers measurable improvement independently.
3. **Right-size execution.** Not everything needs the Algorithm. Three tiers match effort to task.
4. **Memory discipline beats memory volume.** 5K curated characters > 50K uncurated context.
5. **Autonomy from simple mechanisms.** A SQLite table + a poll check > a custom event framework.
6. **Security at trust boundaries.** Injection scanning where external data enters the system.
7. **Cost-conscious agency.** Frozen snapshots make autonomous loops economically viable.

## What This System Can Do That Current DAI Cannot

- Wake up and work on goals without human initiation
- Spawn focused sub-agents with scoped context for complex subtasks
- Remember project context efficiently without burning API budget
- Defend against prompt injection in cross-user pipeline
- Scale to new agent types via markdown definitions instead of custom code
- Right-size its execution protocol based on task complexity
- Curate its own memory to prevent context rot

## What We Explicitly Chose NOT To Build

- A custom event/trigger framework (cron + polling is sufficient)
- Persistent specialist daemon agents (too complex, insufficient ROI)
- A framework for other people to build agents (this is a personal system)
- Vector search infrastructure (FTS5 is sufficient per evidence)
- A Python-based Hermes Agent clone (DAI's TS/Bun stack is better for this use case)
- LLM-based summarization for context compression (observation masking is cheaper and better)

---

**Bottom line:** The highest-agency architecture is not the most complex one. It's the one that gives the agent the right context (frozen + bounded + scoped), the ability to initiate its own work (goals + poll dispatch), the ability to delegate effectively (sync sub-delegation + agent definitions), and the discipline to verify its own output (Algorithm Lite). All built on 31 source files that already work.
