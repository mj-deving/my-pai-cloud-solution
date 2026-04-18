---
name: group_chat
description: "Run a multi-agent discussion with N agents in parallel + moderator synthesis. USE WHEN user says /group_chat, group chat, multi-agent debate, agent panel, multiple perspectives, run agents in parallel."
user_invocable: true
trigger: /group_chat
---

# /group_chat — Multi-Agent Discussion with Moderator

Dispatches a question to N custom-named agents in parallel, then synthesizes their responses via a moderator. Equivalent to bridge `/group_chat`, but implemented with `Task` tool dispatch instead of the bridge's `GroupChatEngine`.

## Usage

```
/group_chat agent1 agent2 [agent3 ...] "question in quotes"
```

Defaults if no agents given: `analyst` + `researcher`.

## Preconditions

- Running inside a Claude Code session that has the `Task` tool (all sessions do)
- No external deps — this skill is self-contained

## Workflow

### 1. Parse input

Regex: `^(.*?)\s*"(.+)"$`

- Group 1 (before the quoted string) → whitespace-split into agent names, strip leading `@`
- Group 2 → the question

If no quoted question: treat whole input as the question and use default agents.

If no agent names: default to `analyst researcher`.

### 2. Dispatch N agents in parallel

Send ONE message containing N `Task` tool calls (parallel execution). Each agent gets the same question + its own persona prompt:

```
Task(
  description: "<agent> perspective on question",
  subagent_type: "general-purpose",
  prompt: "You are <agent>. Answer concisely from your <agent> perspective.
Be terse — 200 words max. Focus on what only your lens sees.

Question: <question>

Respond with your analysis. Do not moderate or synthesize — that's a separate step."
)
```

Run all N in parallel — the algorithm spec explicitly requires parallel tool use when tasks are independent.

### 3. Collect responses

Each `Task` returns a structured summary. Pair each with the agent name:

```
{agent: "analyst", response: "..."}
{agent: "researcher", response: "..."}
...
```

Mark any failed (error returned) with an ❌ in the report; keep the others.

### 4. Moderator synthesis

Dispatch ONE final `Task` call with a moderator prompt:

```
Task(
  description: "Moderator synthesis of group chat",
  subagent_type: "general-purpose",
  prompt: "You are a moderator. Synthesize the following agent responses into a single answer for the user. Highlight where agents agreed, where they disagreed, and what the most actionable takeaway is. 400 words max.

Question: <question>

Responses:
<for each: 'AGENT_NAME: response_text'>

Write the synthesis in markdown, with a **Consensus**, **Divergence**, and **Recommendation** section."
)
```

### 5. Report to user

Format:

```
**Group Chat Results**

✅ **<agent1>:** <first 300 chars of response>

✅ **<agent2>:** <first 300 chars>

❌ **<agent3>:** <error message, if any>

**Synthesis:** <first 1000 chars of moderator output>
```

## Verification

- All N+1 Task tool calls returned (N agents + 1 moderator)
- Synthesis references at least one agent by name
- No agent response is empty (empty → mark ❌ and note in synthesis)

## Edge cases

- **One agent requested:** skip the moderator step — just return that agent's answer.
- **Agent name collision with persona:** agents run with just the name string — no persistent identity across sessions. Two runs with `analyst` don't share memory.
- **Very long question:** agents may truncate. Summarize the question to ≤500 chars before dispatch.
- **All agents error:** report the errors, skip synthesis, tell user to try again.

## Source-of-truth

Bridge implementation: `src/telegram.ts:1747-1809` + `src/group-chat.ts` (`GroupChatEngine`). The bridge version records each response in memory.db with channel isolation (P1-3 fix). This Channels-native skill does NOT record to memory — Channels has its own hook-based memory recording that fires on every message.

## Related skills

- `Agents` — compose custom agents from traits + voice + specialization. Use for richer personas.
- `Thinking` (Council mode) — similar pattern, uses skill-defined agents instead of ad-hoc names
