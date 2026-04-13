# Claude Agent SDK: Context Management, Memory, and Multi-Agent Architecture

**Research Report** | Ava Sterling | 2026-03-02
**Scope:** DEEP | **Sources:** Official Anthropic documentation, engineering blog posts, SDK references

---

## 1. Executive Summary

The Claude Agent SDK (formerly Claude Code SDK) takes a fundamentally different approach to context management than competing frameworks (LangGraph, CrewAI, AutoGen, Semantic Kernel). Rather than building elaborate memory abstractions within the SDK itself, Anthropic pushes context management to three distinct layers:

1. **Server-side compaction** -- automatic conversation summarization at the API level
2. **Client-side memory tool** -- file-based persistent memory where Claude controls what to store/retrieve
3. **Subagent context isolation** -- separate context windows per agent, with only condensed results flowing back

The design philosophy is: **context is a finite resource with diminishing returns; find the smallest set of high-signal tokens that maximize the desired outcome.** This is "context engineering" vs traditional prompt engineering.

---

## 2. Conversation Context Across Turns

### 2.1 Session-Based History

The SDK maintains full conversation history (messages, tool uses, results) within a session. Each `query()` call either starts a new session or resumes an existing one.

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

let sessionId: string | undefined;

// First query -- captures session ID from init message
for await (const message of query({
  prompt: "Read the authentication module",
  options: { allowedTools: ["Read", "Glob"] }
})) {
  if (message.type === "system" && message.subtype === "init") {
    sessionId = message.session_id;
  }
}

// Second query -- full context preserved
for await (const message of query({
  prompt: "Now find all places that call it",
  options: { resume: sessionId }
})) {
  if ("result" in message) console.log(message.result);
}
```

**Key design decision:** There is NO automatic cross-session memory. Each new session starts fresh unless explicitly resumed by ID. This is intentional -- it prevents context rot and keeps sessions focused.

### 2.2 Context Awareness (Models Track Their Own Budget)

Claude Sonnet 4.5+ and later models receive explicit token budget information:

```xml
<budget:token_budget>200000</budget:token_budget>
```

After each tool call, the model gets updates:

```xml
<system_warning>Token usage: 35000/200000; 165000 remaining</system_warning>
```

This allows agents to self-regulate -- they know when context is running low and can proactively save state before compaction or session boundaries. This is a novel pattern not found in other agent frameworks.

### 2.3 Extended Thinking Token Handling

Previous thinking blocks are **automatically stripped** from the context window calculation. The API handles this transparently:

```
effective_context = (input_tokens - previous_thinking_tokens) + current_turn_tokens
```

Thinking tokens are billed as output tokens only once during generation. This is architecturally important -- it means agents can reason extensively without consuming context window for future turns. The one exception: thinking blocks **must** be preserved within a tool-use cycle (between a tool_use and its tool_result).

---

## 3. Session Persistence and Resumption

### 3.1 Disk Persistence

By default, sessions persist to `~/.claude/projects/`. This is controlled by:

```typescript
options: {
  persistSession: true,   // default; set false for ephemeral workflows
  resume: "session-xyz",  // resume a specific session by ID
  sessionId: "custom-id", // use a specific UUID instead of auto-generating
}
```

When `persistSession: false`, sessions live only in memory and cannot be resumed later.

### 3.2 Session Forking

A novel capability not found in other frameworks -- you can **branch** a session to explore alternatives without modifying the original:

```typescript
const forked = query({
  prompt: "Redesign this as GraphQL instead",
  options: {
    resume: sessionId,
    forkSession: true  // new session ID, original preserved
  }
});
```

| Behavior | `forkSession: false` (default) | `forkSession: true` |
|----------|-------------------------------|---------------------|
| Session ID | Same as original | New ID generated |
| History | Appends to original | Creates branch from resume point |
| Original | Modified | Preserved unchanged |
| Use Case | Linear continuation | Explore alternatives |

### 3.3 Checkpoint Resumption

Resume from a specific point within a session:

```typescript
options: {
  resume: sessionId,
  resumeSessionAt: messageId  // specific message UUID within the session
}
```

### 3.4 Session Discovery

The `listSessions()` API provides session metadata:

```typescript
import { listSessions } from "@anthropic-ai/claude-agent-sdk";

const sessions = await listSessions({ dir: "/path/to/project", limit: 10 });
// Returns: sessionId, summary, lastModified, fileSize, customTitle, gitBranch, cwd
```

### 3.5 Transcript Cleanup

Subagent transcripts persist independently (separate files from main session). Cleanup is automatic based on `cleanupPeriodDays` (default: 30 days). Main conversation compaction does not affect subagent transcripts.

---

## 4. Context Window Management (Compaction & Editing)

### 4.1 Server-Side Compaction (The Primary Strategy)

Compaction is Anthropic's recommended approach for long-running conversations. It is a **server-side API feature** (beta, `compact-2026-01-12`), not something the SDK itself implements.

How it works:

1. Input tokens exceed configured trigger threshold (default: 150K tokens, minimum: 50K)
2. Claude generates a summary of the conversation
3. A `compaction` block is inserted at the start of the response
4. All content blocks before the compaction block are ignored in subsequent requests

```typescript
const response = await client.beta.messages.create({
  betas: ["compact-2026-01-12"],
  model: "claude-opus-4-6",
  max_tokens: 4096,
  messages,
  context_management: {
    edits: [{
      type: "compact_20260112",
      trigger: { type: "input_tokens", value: 150000 },
      pause_after_compaction: false,
      instructions: null  // custom summarization prompt (replaces default)
    }]
  }
});
```

**Default summarization prompt:**
```
You have written a partial transcript for the initial task above.
Please write a summary of the transcript. The purpose of this summary
is to provide continuity so you can continue to make progress towards
solving the task in a future context, where the raw history above may
not be accessible and will be replaced with this summary. Write down
anything that would be helpful, including the state, next steps,
learnings etc. You must wrap your summary in a <summary></summary> block.
```

### 4.2 Pause-After-Compaction Pattern

A sophisticated pattern for preserving recent messages through compaction:

```typescript
if (response.stop_reason === "compaction") {
  const compactionBlock = response.content[0];
  const preservedMessages = messages.slice(-2); // keep last user+assistant turn

  messages = [
    { role: "assistant", content: [compactionBlock] },
    ...preservedMessages
  ];

  // Continue with compacted context + preserved recent messages
  response = await client.beta.messages.create({ ... });
}
```

### 4.3 Total Token Budget Enforcement

Combine compaction with a counter to enforce cumulative token limits:

```typescript
const TRIGGER_THRESHOLD = 100_000;
const TOTAL_TOKEN_BUDGET = 3_000_000;
let nCompactions = 0;

// On each compaction event:
nCompactions++;
if (nCompactions * TRIGGER_THRESHOLD >= TOTAL_TOKEN_BUDGET) {
  // Force the agent to wrap up
  messages.push({
    role: "user",
    content: "Please wrap up your current work and summarize the final state."
  });
}
```

### 4.4 Context Editing (Fine-Grained)

For more surgical control than compaction, the API offers context editing strategies:

- **Tool result clearing** (`clear_tool_uses_20250919`) -- clears old tool results while keeping N most recent
- **Thinking block clearing** -- manages extended thinking blocks

```typescript
context_management: {
  edits: [{
    type: "clear_tool_uses_20250919",
    trigger: { type: "input_tokens", value: 100000 },
    keep: { type: "tool_uses", value: 3 },
    exclude_tools: ["memory"]  // never clear memory tool results
  }]
}
```

### 4.5 1M Token Context Window

Available in beta for Opus 4.6, Sonnet 4.6, Sonnet 4.5, and Sonnet 4 via the `context-1m-2025-08-07` beta header. Premium pricing (2x input, 1.5x output) for requests exceeding 200K tokens.

---

## 5. Memory and Knowledge Base Abstractions

### 5.1 The Memory Tool (Client-Side, File-Based)

This is Anthropic's built-in solution for persistent cross-session memory. It is a **client-side tool** -- Claude makes tool calls, and your application handles the filesystem operations.

```typescript
// Enable via tools array
tools: [{ type: "memory_20250818", name: "memory" }]
```

Memory tool operations:
- `view` -- list directory contents or read file contents (with line range support)
- `create` -- create new file
- `str_replace` -- replace text in file
- `insert` -- insert text at line
- `delete` -- delete file/directory
- `rename` -- rename/move file

**Automatic behavior:** When enabled, Claude is instructed to **always check the memory directory before starting any task**. The injected system prompt says:

```
IMPORTANT: ALWAYS VIEW YOUR MEMORY DIRECTORY BEFORE DOING ANYTHING ELSE.
MEMORY PROTOCOL:
1. Use the `view` command of your `memory` tool to check for earlier progress.
2. ... (work on the task) ...
   - As you make progress, record status / progress / thoughts etc in your memory.
ASSUME INTERRUPTION: Your context window might be reset at any moment, so you risk
losing any progress that is not recorded in your memory directory.
```

### 5.2 Memory + Context Editing Synergy

When context editing clears old tool results, Claude is warned first and proactively saves important information to memory files. Then after clearing, Claude retrieves stored information on demand. This creates an "infinite context" illusion.

### 5.3 Memory + Compaction Synergy

Memory persists information across compaction boundaries. Compaction keeps active context manageable; memory ensures nothing critical is lost in the summary.

### 5.4 Multi-Session Software Development Pattern

The documented pattern for long-running projects:

1. **Initializer session** -- sets up memory artifacts:
   - Progress log (completed work, next steps)
   - Feature checklist (scope, pass/fail status per feature)
   - Init script reference
2. **Subsequent sessions** -- each starts by reading memory artifacts, recovers full state in seconds
3. **End-of-session update** -- updates progress log before ending

### 5.5 What the SDK Does NOT Have

Critically, the Claude Agent SDK does **not** have:
- Built-in vector stores or embedding-based retrieval
- Automatic episodic memory recording
- Semantic search over past interactions
- Knowledge graph or structured knowledge bases
- MemGPT-style self-editing memory blocks (though the memory tool pattern approaches this)
- Cross-session automatic learning

All memory is explicit, file-based, and agent-controlled. This is a deliberate design choice -- it keeps the SDK minimal and the memory patterns transparent and debuggable.

---

## 6. Multi-Agent Communication and Context Isolation

### 6.1 Subagent Architecture

Subagents are defined programmatically or via filesystem (`.claude/agents/` markdown files):

```typescript
agents: {
  "code-reviewer": {
    description: "Expert code reviewer for quality and security reviews.",
    prompt: "Analyze code quality and suggest improvements.",
    tools: ["Read", "Glob", "Grep"],      // restricted tool access
    model: "sonnet",                        // model override
    maxTurns: 10,                           // turn limit
    skills: ["security-review"],            // preloaded skills
    mcpServers: ["github"],                 // MCP server access
    criticalSystemReminder_EXPERIMENTAL: "" // experimental reminder
  }
}
```

### 6.2 Context Isolation Model

Each subagent maintains a **completely separate context window**. This is the primary mechanism for context management in multi-agent scenarios:

- Subagents explore dozens of files without cluttering the main conversation
- Only relevant findings flow back to the parent (typically 1,000-2,000 tokens)
- Subagent transcripts persist in separate files from the main session
- Main conversation compaction does not affect subagent transcripts

**Novel pattern:** Subagents act as **context compression engines**. They process large amounts of information in their own windows and return condensed summaries. This is how the system handles information that exceeds a single context window.

### 6.3 Subagent Invocation via Task Tool

Subagents are invoked through the `Task` tool. Detection pattern:

```typescript
for await (const message of query({ ... })) {
  // Detect subagent invocation
  for (const block of msg.message?.content ?? []) {
    if (block.type === "tool_use" && block.name === "Task") {
      console.log(`Subagent: ${block.input.subagent_type}`);
    }
  }
  // Track which messages come from subagents
  if (msg.parent_tool_use_id) {
    console.log("Inside subagent execution");
  }
}
```

### 6.4 Subagent Resumption

Subagents can be resumed by capturing their agent ID and resuming the parent session:

```typescript
// First query -- capture agent ID from Task tool result
const match = content.match(/agentId:\s*([a-f0-9-]+)/);

// Second query -- resume same session, reference agent
for await (const message of query({
  prompt: `Resume agent ${agentId} and continue analysis`,
  options: { resume: sessionId, allowedTools: ["Read", "Grep", "Task"] }
})) { ... }
```

### 6.5 Limitations

- **Subagents cannot spawn sub-subagents** (no nested Task tool)
- **Synchronous execution currently** -- the lead agent waits for each batch of subagents to complete before proceeding (acknowledged limitation)
- **No shared memory between subagents** -- each operates in complete isolation
- **No direct subagent-to-subagent communication** -- all coordination goes through the parent

### 6.6 Multi-Agent Research System Pattern (Anthropic's Internal)

Anthropic's own multi-agent research system uses:

- **Lead agent** (Opus) coordinates strategy and spawns subagents
- **Subagents** (Sonnet) execute parallel research tasks
- **3-5 subagents** run in parallel per batch
- **Subagents use 3+ tools in parallel** within their own execution
- Lead agent stores research plan in Memory to survive compaction
- 90% time reduction vs sequential execution
- 15x more tokens than single-agent chat (cost tradeoff)
- 90.2% performance improvement over single-agent Opus on research evaluations

---

## 7. Settings and Configuration Hierarchy

### 7.1 Setting Sources (Three-Tier)

```typescript
type SettingSource = "user" | "project" | "local";

// Precedence (highest to lowest):
// 1. local  (.claude/settings.local.json) -- gitignored
// 2. project (.claude/settings.json) -- version controlled
// 3. user   (~/.claude/settings.json) -- global

// Default: NO settings loaded (isolation for SDK applications)
options: { settingSources: ["project"] }  // only team-shared settings
```

### 7.2 CLAUDE.md as Persistent Context

The SDK honors `CLAUDE.md` files as project-level context when `settingSources: ["project"]` and `systemPrompt: { type: "preset", preset: "claude_code" }` are set. This functions as a form of "instructions memory" -- persistent context that survives across sessions.

### 7.3 Skills as Context Modules

Subagents can reference skills that inject specialized knowledge:

```typescript
agents: {
  "reviewer": {
    description: "Code reviewer",
    prompt: "Review code for quality",
    skills: ["security-review", "performance-audit"]  // preloaded context modules
  }
}
```

---

## 8. Novel Patterns (Not Found in Other Frameworks)

### 8.1 Session Forking for Exploration

No other major framework offers the ability to branch a conversation into parallel exploration paths while preserving the original. This enables A/B testing of approaches from the same context state.

### 8.2 Server-Side Compaction as API Feature

Other frameworks (LangGraph, CrewAI) require client-side summarization logic. Anthropic pushes this to the API layer, making it transparent and requiring zero client-side implementation.

### 8.3 Context Awareness (Models Know Their Budget)

Claude models receive explicit token budget updates after each tool call. No other framework gives the model runtime awareness of its own resource constraints.

### 8.4 Pause-After-Compaction

The ability to pause after compaction, inject preserved messages, then continue gives developers fine-grained control over what survives summarization -- a pattern unique to this API.

### 8.5 Memory Tool as Agent-Controlled Persistence

Unlike MemGPT/Letta (which uses structured memory blocks edited by the agent) or LangGraph (which uses namespace hierarchies), Claude's memory tool uses a simple filesystem metaphor. The agent literally creates, reads, and edits text files. This is remarkably transparent and debuggable.

### 8.6 Subagent Transcript Persistence Independence

Subagent transcripts survive parent conversation compaction. They are stored in separate files and can be resumed independently. This means long-running agent systems don't lose sub-investigation context when the main conversation compacts.

### 8.7 "Assume Interruption" Philosophy

The memory tool's injected prompt tells agents to "assume interruption" -- that context could reset at any moment. This defensive posture drives proactive state persistence, rather than assuming context will always be available. This is a design philosophy, not just a feature.

---

## 9. Comparison with PAI's Current Architecture

| Dimension | Claude Agent SDK | PAI (Current) |
|-----------|-----------------|---------------|
| Session persistence | Disk-based, resume by ID, fork sessions | File-based session ID, per-project sessions |
| Context management | Server-side compaction (API-level) | Not yet implemented (Phase 3 planned) |
| Memory | Client-side memory tool (file-based) | SQLite MemoryStore with FTS5 + optional sqlite-vec |
| Multi-agent coordination | Subagent isolation via Task tool | Pipeline + reverse pipeline + orchestrator DAG |
| Context injection | CLAUDE.md + skills + memory tool retrieval | ContextBuilder queries MemoryStore, prepends to prompt |
| Cross-instance state | Session forking, checkpoint resumption | HandoffManager JSON files |
| Long-term knowledge | Memory files + CLAUDE.md | FTS5 semantic search + episodic episodes |

### 9.1 Strategic Implications for PAI

1. **Compaction integration:** PAI should integrate with the compaction API rather than building its own summarization. The `pause_after_compaction` pattern could preserve PAI's context injection prefix.

2. **Memory tool adoption:** Consider migrating MemoryStore's retrieval interface to the memory tool protocol. This would make PAI's memory accessible to the Agent SDK natively.

3. **Subagent context isolation:** PAI's pipeline already provides process-level isolation (separate `claude -p` invocations). The Agent SDK's subagent model is lighter-weight (same process, separate context windows).

4. **Session forking for PRD execution:** The SDK's fork capability could enable PRD executors to explore multiple implementation approaches from the same starting point.

5. **Context awareness exploitation:** If PAI uses the Agent SDK, models would self-regulate context usage -- potentially reducing the need for manual token budget enforcement.

---

## 10. Sources

### Official Documentation
- [Agent SDK Overview](https://platform.claude.com/docs/en/agent-sdk/overview) -- Anthropic
- [Session Management](https://platform.claude.com/docs/en/agent-sdk/sessions) -- Anthropic
- [Subagents in the SDK](https://platform.claude.com/docs/en/agent-sdk/subagents) -- Anthropic
- [Context Windows](https://platform.claude.com/docs/en/build-with-claude/context-windows) -- Anthropic
- [Compaction](https://platform.claude.com/docs/en/build-with-claude/compaction) -- Anthropic
- [Memory Tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool) -- Anthropic
- [Agent SDK TypeScript Reference](https://platform.claude.com/docs/en/agent-sdk/typescript) -- Anthropic

### Engineering Blog Posts
- [Building Agents with the Claude Agent SDK](https://claude.com/blog/building-agents-with-the-claude-agent-sdk) -- Anthropic Engineering
- [How We Built Our Multi-Agent Research System](https://www.anthropic.com/engineering/multi-agent-research-system) -- Anthropic Engineering
- [Effective Harnesses for Long-Running Agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) -- Anthropic Engineering
- [Effective Context Engineering for AI Agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) -- Anthropic Engineering

### GitHub Repositories
- [claude-agent-sdk-typescript](https://github.com/anthropics/claude-agent-sdk-typescript) -- Official TypeScript SDK
- [claude-agent-sdk-python](https://github.com/anthropics/claude-agent-sdk-python) -- Official Python SDK
- [claude-agent-sdk-demos](https://github.com/anthropics/claude-agent-sdk-demos) -- Example applications

### Third-Party Analysis
- [Memory and Context Management](https://github.com/bgauryy/open-docs/blob/main/docs/claude-agent-sdk/memory-and-context.md) -- Community docs
- [Claude Agent SDK at Promptfoo](https://www.promptfoo.dev/docs/providers/claude-agent-sdk/) -- Integration reference
- [VentureBeat: Multi-Session Claude SDK](https://venturebeat.com/ai/anthropic-says-it-solved-the-long-running-ai-agent-problem-with-a-new-multi) -- Industry analysis
- [Context Studios AI Glossary](https://www.contextstudios.ai/glossary/anthropic-agent-sdk) -- Overview
