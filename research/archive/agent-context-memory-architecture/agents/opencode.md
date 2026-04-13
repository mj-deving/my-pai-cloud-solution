# OpenCode Architecture Research Report

**Date:** 2026-03-02
**Researcher:** Ava Sterling (ClaudeResearcher)
**Subject:** Anomaly.co OpenCode — Architecture Analysis for Agent Framework Design

---

## 1. Executive Summary

OpenCode (github.com/anomalyco/opencode) is the leading open-source AI coding agent, with 114K+ GitHub stars, 700+ contributors, and 2.5M+ monthly active developers. Built by the SST (Serverless Stack) team at Anomaly.co, it positions itself as the provider-agnostic alternative to Claude Code.

This report analyzes OpenCode's architecture for patterns and design decisions relevant to building a custom agent framework. The key takeaway: OpenCode's client-server separation, Instance Context pattern, and namespace-based module organization represent the most transferable architectural insights. Its context compaction system and permission architecture are the most mature implementations in the open-source agent space.

---

## 2. Technology Stack

| Layer | Technology |
|-------|-----------|
| **Primary Language** | TypeScript (52.5%), MDX (43.3%), CSS (3.1%), Rust (0.6%) |
| **Runtime** | Bun (package manager + bundler), Node.js ecosystem |
| **HTTP Server** | Hono framework (lightweight, fast) |
| **Database** | SQLite via Drizzle ORM |
| **AI SDK** | Vercel AI SDK (streaming interface) |
| **TUI Framework** | @opentui/solid (SolidJS-based terminal UI) |
| **Desktop** | Tauri (Rust wrapper) |
| **Web Frontend** | SolidJS + @solidjs/start + Nitro |
| **MCP** | @modelcontextprotocol/sdk |
| **Monorepo** | Bun workspaces (15+ packages) |

**Strategic Note:** TypeScript + Bun + SQLite is the same stack as PAI. This is not coincidental -- it is the emerging standard for agent infrastructure in 2026. The Hono server choice is notable vs Express/Fastify -- it is significantly lighter and aligns with edge-first deployment patterns.

---

## 3. Core Architecture: Client-Server Separation

OpenCode's defining architectural decision is a **full client-server split**:

```
Terminal UI ─────┐
Desktop App ─────┤
VS Code Ext ─────┼──→ HTTP Server (Hono, port 4096) ──→ Agent Loop
Web App ─────────┤         │                                  │
SDK Clients ─────┘    REST + SSE                         SQLite DB
```

### How It Works:
- The `opencode` binary serves dual purposes: CLI entry point AND HTTP server host
- All frontends communicate through REST endpoints + Server-Sent Events (SSE)
- The server binds to `localhost:4096` by default
- Internal Event Bus (`Bus` namespace) decouples agent loop from client connections
- Events like `Session.Event.Updated`, `MessageV2.Event.PartDelta` flow through the bus to SSE

### Why This Matters for PAI:
PAI currently tightly couples Telegram (Grammy) to the agent loop via `bridge.ts`. OpenCode's pattern suggests a cleaner separation where the agent loop is a standalone server, and Telegram/SSH/Dashboard become thin clients over HTTP+SSE. This would enable:
- Multiple frontends without rewiring the agent
- Session sharing between local and cloud instances via HTTP API
- Easier testing (hit REST endpoints, no Telegram dependency)
- The `MessengerAdapter` interface in PAI is a step toward this, but OpenCode goes further by making HTTP the universal transport

---

## 4. Session & Conversation Management

### Session Storage (SQLite via Drizzle ORM)

Three tables form the persistence layer:

| Table | Purpose |
|-------|---------|
| `SessionTable` | Session metadata, titles, share URLs, revert pointers |
| `MessageTable` | User and assistant message records |
| `PartTable` | Message parts: text, tool calls, files, reasoning, compaction summaries, subtask records |

**Key Design:** Messages are decomposed into typed "Parts" rather than stored as monolithic blobs. This enables:
- Granular streaming (send parts as they arrive)
- Selective filtering (e.g., skip tool call results during compaction)
- Audit trails (compaction creates new parts rather than deleting originals)
- Append-only data model (no destructive updates)

### Session Operations

| Command | Purpose |
|---------|---------|
| `/compact` | Manual compaction trigger |
| `/fork` | Create new session from a point in history |
| `/undo` | Revert last user message |
| `/share` | Generate share URL |
| `/export` | Export transcript |
| `--continue` | Resume most recent session |
| `--session <id>` | Resume specific session |

**PAI Comparison:** PAI uses a single session ID file (`~/.claude/active-session-id`) with `--resume`. OpenCode's SQLite-backed session management with fork/undo/share is significantly more sophisticated. The `/fork` pattern is especially interesting -- it enables branching conversations, which PAI lacks entirely.

---

## 5. Context Window Management & Compaction

This is OpenCode's most architecturally interesting subsystem.

### The Compaction Pipeline

```
Agent Loop Iteration
  → Load messages via MessageV2.filterCompacted()
  → Count tokens against model limit
  → If overflow detected (75% threshold):
      → SessionCompaction.process()
      → LLM summarizes earlier conversation
      → Creates CompactionPart (preserves originals)
      → Agent loop re-enters with reduced context
  → Continue normal execution
```

### Design Decisions:

1. **75% auto-compaction threshold** -- Hardcoded trigger point. Configurable override requested by community (Issue #11314)

2. **LLM-based summarization** -- Uses the active model to create summaries, not heuristic truncation. Summary explicitly includes a "Rules & Constraints" section preserving:
   - Active user directives
   - Permission-sensitive rules
   - Project-specific instructions

3. **Append-only compaction** -- Original messages are never deleted. `CompactionPart` rows are created alongside them. `filterCompacted()` returns only the active view. This enables:
   - Full audit trail
   - Potential compaction reversal
   - Session forking from pre-compaction states

4. **Sliding window proposal** (Issue #4659) -- Community proposes moving beyond simple compaction to a sliding window where:
   - Compaction marker moves forward through history
   - "Inception" system permanently preserves critical messages
   - Chess-clock auto-pruning and heuristic pruning
   - This is not yet implemented but represents the direction

5. **RLM (Recursive Language Model) proposal** (Issue #11829) -- MIT research-based approach treating context as an external environment the model queries programmatically. Production-ready in 2026 according to the proposal.

### PAI Comparison:
PAI currently relies on Claude Code's built-in context management (`--resume` sessions). The MemoryStore (Phase 3 V2-A) provides episodic+semantic memory via FTS5, but lacks:
- Automatic compaction with rule preservation
- Append-only part-based message storage
- Fork/branch capability for conversations
- Configurable compaction thresholds

The "Rules & Constraints" preservation pattern is immediately applicable -- when PAI's ContextBuilder prepends memory context, it should tag injected rules as "must survive compaction."

---

## 6. Agent System & Orchestration

### Built-in Agents

| Agent | Mode | Role |
|-------|------|------|
| **Build** | Primary | Full-access development, all tools enabled |
| **Plan** | Primary | Read-only analysis, permission prompts before modifications |
| **General** | Subagent | Multi-step tasks, full tool access (except todo) |
| **Explore** | Subagent | Read-only codebase navigation |
| **Compaction** | Hidden/System | Handles summarization |
| **Title** | Hidden/System | Generates session titles |
| **Summary** | Hidden/System | Creates session summaries |

### Agent Configuration

Agents are defined as either JSON in `opencode.json` or Markdown files in `.opencode/agents/`:

```yaml
---
description: Agent purpose
mode: subagent
model: anthropic/claude-sonnet-4-20250514
temperature: 0.1
tools: {write: false, edit: false}
steps: 20
---
System prompt content here.
```

**Key Properties:**
- `mode`: primary | subagent | all
- `model`: Override per-agent model selection
- `tools`: Enable/disable specific tools with wildcards
- `permissions`: Per-tool approval rules (`ask` / `allow` / `deny`)
- `steps`: Maximum agentic iterations before text-only fallback
- `task`: Controls subagent delegation permissions
- `temperature`, `top_p`: Model parameters per agent

### Subagent Delegation (TaskTool)

The `TaskTool` enables primary agents to spawn subagents:

```
Primary Agent (Build)
  → Calls TaskTool with prompt
  → Spawns subagent session (e.g., General)
  → Subagent executes independently
  → Returns result to primary agent
```

**Recent Evolution (PR #7756):**
- Subagent-to-subagent delegation (hierarchical)
- Configurable call budgets and depth limits (prevents infinite loops)
- Persistent or stateless subagent sessions
- Hierarchical session navigation (TUI tree traversal)

**Current Limitation:** Subtasks execute sequentially even when multiple TaskTool calls appear in one response (Issue #14195). Parallel subagent execution is a known gap.

### PAI Comparison:
PAI's orchestrator uses DAG-based workflow decomposition with parallel step dispatch and cross-agent delegation (Isidore/Gregor). OpenCode's approach is simpler (parent-child spawning via TaskTool) but its agent configuration format (Markdown frontmatter + system prompt) is more elegant than PAI's code-based agent definitions. The step limit (`steps` property) is a pattern PAI could adopt for resource control.

---

## 7. Tool System Architecture

### Tool Interface

All tools implement `Tool.Info`:
```typescript
{
  description: string
  parameters: ZodSchema  // Zod parameter validation
  execute: (args, context) => Promise<Result>
}
```

### Tool Resolution Order (Priority)

1. Built-in tools (Bash, Edit, Read, Write, Glob, Grep, List, WebFetch, Task, TodoWrite, ApplyPatch)
2. Custom tools from `.opencode/tools/`
3. Plugin-contributed tools
4. MCP server tools
5. LSP experimental tools (feature-flagged)

### Permission Layer

Every tool execution routes through `PermissionNext.ask()`:
- Per-tool permission rules: `ask`, `allow`, `deny`
- Glob-pattern matching for commands (e.g., `"git status *": "allow"`)
- Session-level and agent-level permission scoping
- Events published: `PermissionAsked`, `PermissionGranted`

### MCP Integration

MCP servers configured in `opencode.json`:
- **Local:** stdio-based processes spawned by OpenCode
- **Remote:** HTTP/SSE endpoints
- OAuth 2.0 with dynamic client registration
- Automatic tool discovery + `ToolListChangedNotification` for dynamic updates
- Persistent connections with auto-reconnect

**Known Issue (Issue #9350):** MCP tool definitions loaded at session startup burn ~51K tokens (46.9% of context window) with 4 servers. Lazy loading proposed.

### PAI Comparison:
PAI's tool system is implicit (Claude CLI's built-in tools). OpenCode's explicit tool registry with Zod schemas, permission fences, and MCP integration represents a more extensible architecture. The glob-pattern permission matching (e.g., `"git *": "allow"`) is a particularly elegant pattern for granular access control. The MCP token bloat issue (51K tokens for 4 servers) is a cautionary tale for PAI if MCP integration is planned.

---

## 8. Instance Context Pattern

This is OpenCode's most novel architectural contribution.

### How It Works

```
HTTP Request → Middleware
  → Instance.provide({ directory, fn })
    → WorkspaceContext.provide()
      → Lazy-initialized, memoized per-request:
          - Config resolution
          - ToolRegistry compilation
          - Plugin loading
          - Provider instances
          - LSP clients
```

Every HTTP request is scoped to an "Instance" that provides:
- `Instance.directory`: Project root
- `Instance.worktree`: File tree abstraction
- `Instance.project`: Project metadata

**Key Property:** Lazy initialization via `Instance.state(async () => {...})` memoizes expensive setup (config loading, tool compilation, LSP spawning) per-request, preventing redundant work while maintaining per-project isolation.

### Why This Matters:
This pattern prevents cross-project contamination while enabling parallel request handling. Each request operates in its own workspace context without sharing state with other projects. This is the architectural equivalent of PAI's `ProjectManager` but implemented at a much more fundamental level -- it is baked into the HTTP middleware rather than being an application-level concern.

---

## 9. Configuration System

OpenCode's config system merges eight precedence levels:

1. Remote `.well-known/opencode` (enterprise)
2. Global `~/.config/opencode/opencode.json`
3. Custom `OPENCODE_CONFIG` path
4. Project-level `opencode.json`
5. `.opencode/opencode.json` directory overrides
6. Inline `OPENCODE_CONFIG_CONTENT` env var
7. Enterprise-managed `/etc/opencode`

**Array Concatenation:** Array fields (plugins, instructions) concatenate rather than replace across levels. This means project-level instructions ADD to global instructions rather than overriding them.

**Dynamic Resources:** `.opencode/` subdirectories can contain:
- Agents (Markdown files)
- Modes (configuration variants)
- Commands (slash commands)
- Plugins (TypeScript/JavaScript modules)

**PAI Comparison:** PAI uses `loadConfig()` with Zod-validated env vars. OpenCode's hierarchical merging with array concatenation is significantly more sophisticated. The `.opencode/` directory convention (project-local agents, commands, plugins) is a pattern worth adopting -- it would allow per-project agent customization without modifying the core codebase.

---

## 10. Provider Abstraction

### Bundled Providers (BUNDLED_PROVIDERS Map)

Anthropic, OpenAI, Azure, Google, Amazon Bedrock, Mistral, Groq, OpenRouter, GitLab, GitHub Copilot.

### ProviderTransform Pipeline

Before each LLM call, messages pass through stateless transformation:
1. Provider-specific normalization
2. Prompt caching headers (Anthropic cache_control, Bedrock cache points)
3. Unsupported modality stripping
4. SDK-compatible option key remapping

This is a "clean room" pattern -- the agent loop speaks a universal message format, and provider-specific quirks are handled entirely in the transform layer.

### Custom Loaders

Per-provider credential detection:
- Environment variables
- Auth storage
- Config files
- Region prefixing (AWS, Azure multi-region)
- Custom request headers

**PAI Comparison:** PAI delegates to Claude CLI which handles provider abstraction. If PAI ever needs multi-provider support, OpenCode's ProviderTransform pipeline is the reference implementation. The stateless transform pattern (normalize before sending, never mutate originals) is architecturally clean.

---

## 11. Namespace Organization Pattern

OpenCode uses TypeScript namespaces as module boundaries:

```typescript
// Every subsystem is a namespace with named exports
export namespace Session {
  export function create(...) { }
  export function get(...) { }
  export namespace Event {
    export const Updated = "session.updated"
  }
}

export namespace MessageV2 {
  export function filterCompacted(...) { }
  export function stream(...) { }
}
```

This enables:
- Cohesive module boundaries without class overhead
- Nested namespaces for sub-concerns (e.g., `Session.Event`)
- Clear public API surface per subsystem
- IDE-friendly autocomplete and navigation

**PAI Comparison:** PAI uses class-based modules (`ClaudeInvoker`, `PipelineWatcher`, etc.). OpenCode's namespace pattern is lighter-weight and avoids the `this` binding issues that plague class-based patterns. For a framework-level architecture, namespaces provide better composability.

---

## 12. Strategic Analysis: Second-Order Effects

### 12.1 The Client-Server Split Creates Network Effects

OpenCode's HTTP server architecture means any tool that speaks HTTP can become a frontend. This creates a platform dynamic: third-party IDEs (Zed integration already exists), custom dashboards, CI/CD pipeline integrations, Slack bots -- all become thin clients. PAI's Telegram bridge is architecturally equivalent to one of these thin clients, but PAI lacks the universal HTTP layer that enables others.

### 12.2 MCP Token Bloat is a Systemic Risk

At 51K tokens for 4 MCP servers (46.9% of context window), every MCP integration actively degrades agent performance. This means there is an inherent tension between tool extensibility and context efficiency. OpenCode's community is actively working on lazy loading (Issue #9350), but this is an unsolved problem in the agent ecosystem. PAI should avoid eager MCP tool loading if it adopts MCP.

### 12.3 Sequential Subtask Execution is a Fundamental Constraint

OpenCode's `tasks.pop()` → `await` → `continue` pattern means even when the LLM generates multiple parallel TaskTool calls, they execute sequentially (Issue #14195). This is the same constraint PAI's orchestrator addresses with parallel step dispatch. OpenCode's community recognizes this gap but hasn't solved it -- PAI's DAG-based parallel dispatch is architecturally ahead here.

### 12.4 Compaction Rule Preservation Creates "Immune Memory"

By preserving rules and constraints through compaction, OpenCode creates what could be called "immune memory" -- context that survives all compression events. This is analogous to how the immune system maintains memory of past threats. PAI's ContextBuilder should adopt this pattern: tag injected context as "compaction-immune" to ensure critical rules and project state survive context window pressure.

### 12.5 The Markdown Agent Definition Pattern Lowers the Bar

Defining agents as Markdown files with YAML frontmatter (description, model, tools, permissions, system prompt) makes agent creation accessible to non-developers. This is a significant UX advantage over code-based agent definitions. If PAI adopts this pattern, it enables "prompt engineering as agent engineering" -- users can create specialized agents by writing Markdown rather than TypeScript.

---

## 13. Patterns Worth Adopting for PAI

### Immediately Applicable

| Pattern | OpenCode Implementation | PAI Application |
|---------|------------------------|-----------------|
| **Part-based message storage** | `PartTable` with typed parts | Extend MemoryStore to store message parts, not blobs |
| **Compaction with rule preservation** | "Rules & Constraints" section survives compaction | Tag context injections as compaction-immune |
| **Session forking** | `/fork` creates new session from history point | Add fork capability to session management |
| **Agent-as-Markdown** | `.opencode/agents/*.md` with frontmatter | Per-project agent definitions in `.pai/agents/` |
| **Step limits** | `steps` property caps agentic iterations | Add iteration caps to pipeline tasks |
| **Glob-pattern permissions** | `"git status *": "allow"` | Granular tool permission rules |

### Medium-Term

| Pattern | OpenCode Implementation | PAI Application |
|---------|------------------------|-----------------|
| **HTTP server as universal transport** | Hono on port 4096, REST+SSE | Move agent loop behind HTTP, make Telegram a thin client |
| **Instance Context middleware** | Per-request workspace scoping | Replace ProjectManager with middleware-level scoping |
| **Event Bus decoupling** | Typed pub/sub between agent loop and clients | Decouple pipeline events from direct Telegram calls |
| **Namespace organization** | TypeScript namespaces as module boundaries | Consider namespace pattern for new modules |

### Research / Long-Term

| Pattern | OpenCode Status | PAI Relevance |
|---------|----------------|---------------|
| **Sliding window compaction** | Proposed (Issue #4659), not implemented | Alternative to current compaction approach |
| **RLM context-as-environment** | Proposed (Issue #11829), MIT research | Radical rethink of context management |
| **MCP lazy loading** | Proposed (Issue #9350), not implemented | Critical if PAI adopts MCP |
| **Subagent-to-subagent delegation** | PR #7756 with budgets and depth limits | Extend orchestrator for hierarchical delegation |

---

## 14. Architectural Comparison Matrix

| Dimension | OpenCode | Claude Code | PAI (Current) |
|-----------|----------|-------------|----------------|
| **Architecture** | Client-server (HTTP+SSE) | Monolithic CLI | Bridge + Pipeline |
| **Session Storage** | SQLite (Drizzle ORM) | Internal/opaque | Session ID file + MemoryStore (SQLite) |
| **Context Management** | Auto-compaction at 75%, rule preservation | Internal | ContextBuilder + FTS5 memory |
| **Agent Model** | Named configs (Markdown/JSON) | Single agent | Code-based (ClaudeInvoker) |
| **Subagents** | TaskTool spawning, hierarchical | Subagent tool | Orchestrator DAG + reverse pipeline |
| **Parallel Execution** | Sequential (known limitation) | Limited | Parallel step dispatch (ahead) |
| **Provider Support** | 75+ via BUNDLED_PROVIDERS | Anthropic only | Anthropic via CLI |
| **Tool System** | Explicit registry + Zod + permissions | Built-in | Implicit (CLI tools) |
| **MCP** | Full integration with OAuth | Supported | Not yet |
| **Plugin System** | TypeScript/JS plugins, npm packages | Hooks | Not yet |
| **Frontends** | TUI, Desktop, Web, IDE, SDK | CLI, IDE | Telegram, SSH, Dashboard |
| **Open Source** | MIT license | Proprietary (CLI source available) | Private |

---

## 15. Key Takeaways

1. **Client-server separation is the winning pattern.** Every major coding agent is converging on HTTP+SSE as the transport layer between agent logic and user interfaces. PAI should plan for this.

2. **SQLite + Drizzle ORM is the storage standard.** OpenCode, Claude Code, and PAI all use SQLite. Drizzle ORM provides type-safe schema management that PAI's raw `bun:sqlite` lacks.

3. **Context compaction with rule preservation is table stakes.** Long-running sessions require automated summarization that preserves critical constraints. This is the most immediately actionable pattern for PAI.

4. **Part-based message storage enables everything.** Typed message parts (text, tool calls, files, compaction summaries) unlock streaming, selective filtering, forking, and audit trails. PAI's current blob-based memory storage should evolve toward this.

5. **Markdown agent definitions democratize agent creation.** YAML frontmatter + system prompt in a Markdown file is the most accessible way to define agents. This is immediately adoptable.

6. **PAI's parallel execution is architecturally ahead.** OpenCode's sequential subtask execution is a known limitation. PAI's DAG-based orchestrator with parallel step dispatch is genuinely more sophisticated.

7. **MCP integration is a double-edged sword.** The 51K token overhead for 4 MCP servers is a cautionary tale. Lazy loading and selective tool injection must be solved before MCP becomes practical.

---

## Sources

- [OpenCode GitHub Repository](https://github.com/anomalyco/opencode)
- [OpenCode Official Documentation](https://opencode.ai/docs/)
- [OpenCode Agent Documentation](https://opencode.ai/docs/agents/)
- [DeepWiki: OpenCode Architecture](https://deepwiki.com/anomalyco/opencode)
- [DeepWiki: Session Management](https://deepwiki.com/anomalyco/opencode/3.1-session-management)
- [DeepWiki: Context Management and Compaction](https://deepwiki.com/anomalyco/opencode/3.8-context-management-and-compaction)
- [DeepWiki: Permission System](https://deepwiki.com/anomalyco/opencode/6.2-permission-system)
- [DeepWiki: MCP Architecture](https://deepwiki.com/anomalyco/opencode/13.1-mcp-architecture)
- [DeepWiki: Built-in Tools](https://deepwiki.com/anomalyco/opencode/12.1-built-in-tools)
- [Issue #4659: Sliding Window Context Management](https://github.com/anomalyco/opencode/issues/4659)
- [Issue #11829: RLM Context Management](https://github.com/anomalyco/opencode/issues/11829)
- [Issue #9350: MCP Tool Search - Lazy Loading](https://github.com/anomalyco/opencode/issues/9350)
- [Issue #8140: Configurable Context Limit](https://github.com/anomalyco/opencode/issues/8140)
- [Issue #15298: Automatic Context Compaction](https://github.com/anomalyco/opencode/issues/15298)
- [Issue #14195: Parallel Task Execution](https://github.com/anomalyco/opencode/issues/14195)
- [PR #7756: Subagent-to-Subagent Delegation](https://github.com/anomalyco/opencode/pull/7756)
- [OpenCode vs Claude Code vs Cursor Comparison (NxCode)](https://www.nxcode.io/resources/news/opencode-vs-claude-code-vs-cursor-2026)
- [Claude Code vs OpenCode (Infralovers)](https://www.infralovers.com/blog/2026-01-29-claude-code-vs-opencode/)
- [AI Coding Agent 2026 Comparison (Morph)](https://www.morphllm.com/ai-coding-agent)
