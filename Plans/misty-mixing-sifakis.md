# Plan: README Rewrite — Vision-Forward Public Showcase

## Context

The current README.md is 76 lines and outdated. It was written early in the project when this was "deploy Claude CLI to VPS + Telegram bridge." The project has grown into a 40-file, 12K LOC cloud AI agent runtime with memory, context injection, cross-agent pipelines, orchestration, scheduling, and more. The README doesn't reflect any of this.

Marius wants: **public showcase** positioning, **vision-forward** scope. Lead with what this becomes, show what's built, invite others to explore.

## Approach

Rewrite `README.md` as a compelling project showcase. Keep `ARCHITECTURE.md` as the deep reference (don't duplicate it). README is the front door; ARCHITECTURE.md is the guided tour.

## Key Decision: Abstract Naming

README uses generic terms for public audience:
- "PAI Agent" or "cloud agent" — not "Isidore Cloud" (personal identity stays in ARCHITECTURE.md)
- "co-located agent frameworks" — not "Gregor/OpenClaw" (specific integrations stay in ARCHITECTURE.md)
- The cross-agent pipeline is described generically as inter-agent task exchange

## Proposed README Structure

### 1. Title + Tagline
- "PAI Cloud Solution" with a one-liner that captures the vision
- Something like: "Turn Claude Code into an always-on AI agent you can reach from anywhere"

### 2. The Problem (2-3 sentences)
- Claude Code is powerful but local-only
- Close the lid, it's gone. No mobile access. No background tasks.

### 3. The Solution (what this is)
- A cloud runtime that deploys Claude Code to a VPS with 24/7 Telegram access
- Memory, context injection, autonomous scheduling, cross-agent collaboration
- One assistant, always available

### 4. ASCII Architecture Diagram
- Simplified version of the "Big Picture" from ARCHITECTURE.md
- Show: You → Telegram → Bridge → Claude CLI → Memory → Reply

### 5. What's Built (feature list with status indicators)
- Core bridge (Telegram + CLI wrapper + session management)
- Dual-mode system (workspace/project)
- Memory system (SQLite episodic + semantic, FTS5, importance scoring)
- Context injection (topic-based, budget-aware)
- Cross-agent pipeline (inter-agent task exchange with co-located frameworks)
- DAG workflow orchestrator
- Scheduler (daily synthesis, weekly review)
- Dashboard (HTTP + SSE + dark Kanban)
- PR-based git workflow with Codex review
- 41 tests
- Mark which are production-ready vs built-but-not-enabled

### 6. Quick Start
- Prerequisites (VPS, Bun, Claude Code CLI, Telegram bot)
- Point to ARCHITECTURE.md "Deployment Guide" for full steps

### 7. Tech Stack
- Bun + TypeScript, Grammy, SQLite (bun:sqlite), Zod, systemd
- No Docker, no K8s, no cloud functions — just a VPS and systemd

### 8. Where This Is Going (Vision / Roadmap)
- **Full parity**: Cloud agent handles everything the local instance can — including headless browser. Voice is the only local-only capability.
- **Autonomy horizon**: PRD executor, proactive behavior, daily summaries already built — just need enabling and hardening
- **Agent convergence**: Absorb capabilities from co-located agent frameworks (e.g. OpenClaw) via Graduated Extraction — don't adopt their runtime, extract their best features
- **Multi-channel**: Email bridge architecture in place
- **Replicable**: Designed so others can fork and deploy their own cloud AI agent

### 9. Project Structure (compact)
- Key entry points only, not all 40 files
- Point to ARCHITECTURE.md for full reference

### 10. Footer
- Author, links
- "Built with Claude Code and Codex" (both are used — Claude Code as the runtime, Codex for code review)

## Files Modified

- `README.md` — full rewrite

## Verification

- Read the final file to confirm it renders well
- Ensure no claims without basis (everything stated is verifiable from the codebase)
- Check that ARCHITECTURE.md links are correct
