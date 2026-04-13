# Multi-Agent Context Isolation Research — Summary Reference

**Full report:** `~/.claude/History/research/2026-03/2026-03-02_multi-agent-context-isolation/report.md`
**Date:** 2026-03-02

## Key Takeaways for PAI

1. **Isolation is the default, sharing is the exception** — all production frameworks agree
2. **Centralized orchestration** suppresses 17x error amplification (PAI already does this right)
3. **Three-level memory scoping** (global/project/agent) is the production consensus
4. **Result passing** (PAI's current pipeline pattern) is correct for 2-3 agent systems
5. **Token budget:** 10-15% system, 15-20% tools, 30-40% knowledge, 20-30% history, 10-15% buffer
6. **Context compaction** triggers at 70-75% utilization, targets 3:1 to 5:1 compression
7. **Append-only semantics** for cross-agent state prevents corruption (PAI already does this)
8. **Provenance tracking** on memory fragments prevents hallucination propagation

## Highest-Priority Improvements

1. Add project + source filters to `MemoryStore.search()` (smallest change, biggest impact)
2. Add provenance metadata to memory fragments (source_agent, project, confidence)
3. Implement token budget allocation in ContextBuilder
4. Differentiate pipeline (minimal) vs Telegram (full) context injection

## Frameworks Analyzed

LangGraph, CrewAI, AutoGen/AG2, OpenAI Agents SDK, Letta/MemGPT, Semantic Kernel, Google ADK, MemOS

## Protocols

- Google A2A: Agent-to-agent (HTTPS + JSON-RPC 2.0), 50+ partners, Linux Foundation
- Anthropic MCP: Agent-to-tool (JSON-RPC 2.0), Linux Foundation (AAIF)
