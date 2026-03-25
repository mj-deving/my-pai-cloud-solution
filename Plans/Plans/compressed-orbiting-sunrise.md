# Plan: Document Memory Architecture + Establish Knowledge Base Convention

## Context

Marius asked me to document the PAI vs OpenClaw memory architecture comparison somewhere referenceable, and establish a convention that all significant explanations, analyses, and workflow descriptions get written to a knowledge base automatically — without him having to ask each time.

## What to Do

### 1. Write the memory comparison doc

**File:** `.ai/guides/memory-architecture-comparison.md`

Synthesize the detailed memory architecture comparison (PAI Cloud vs OpenClaw) into a reference document. Covers: schema, write path, read path, scoring, injection, distillation, pruning, embeddings, unique features of each.

### 2. Establish the knowledge base convention

**Update:** Project MEMORY.md — add convention under `## Conventions`

Rule: Any time a significant technical explanation, architecture comparison, workflow description, or design analysis is presented to Marius, it gets written to `.ai/guides/` as a reference document. No asking — just do it.

**Update:** CLAUDE.md — add `.ai/guides/` as the knowledge base location in the project docs section, so future sessions know about it.

### 3. Naming convention for guides

Use descriptive kebab-case names that describe the content:
- `memory-architecture-comparison.md`
- `bridge-mechanics.md` (already exists)
- `design-decisions.md` (already exists)

## Files to Create/Modify

- **Create:** `.ai/guides/memory-architecture-comparison.md`
- **Edit:** `~/.claude/projects/.../memory/MEMORY.md` — add convention
- **Edit:** `CLAUDE.md` — reference `.ai/guides/` as knowledge base

## Verification

- [ ] Memory comparison doc exists and is comprehensive
- [ ] Convention saved in MEMORY.md
- [ ] CLAUDE.md references the knowledge base
