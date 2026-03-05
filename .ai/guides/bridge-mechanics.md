# Isidore Cloud — Bridge Mechanics Reference

> Living reference for all bridge subsystems. Visual-first, extend as new mechanics are added.

---

## Session Continuity

### The Two-Mode System

```
┌─────────────────────────────────────────────────────────┐
│                    TELEGRAM MESSAGE                      │
│                         │                                │
│                    ┌────▼────┐                           │
│                    │ Grammy  │                           │
│                    │  Bot    │                           │
│                    └────┬────┘                           │
│                         │                                │
│              ┌──────────▼──────────┐                     │
│              │    ModeManager      │                     │
│              │  ┌───────┬────────┐ │                     │
│              │  │ 🏠    │ 📁    │ │                     │
│              │  │ work  │ proj  │ │                     │
│              │  │ space │ ect   │ │                     │
│              │  └───┬───┴───┬───┘ │                     │
│              └──────┼───────┼─────┘                     │
│                     │       │                            │
│         ┌───────────┘       └───────────┐                │
│         ▼                               ▼                │
│  ┌──────────────┐              ┌──────────────┐          │
│  │  memory.db   │              │  memory.db   │          │
│  │  (episodes)  │              │  (episodes)  │          │
│  │              │              │  + MEMORY.md  │          │
│  │              │              │  + CLAUDE.md  │          │
│  └──────────────┘              └──────────────┘          │
│   continuity via               continuity via            │
│   ContextBuilder               ContextBuilder            │
│   injection only               + CLI auto-load           │
└─────────────────────────────────────────────────────────┘
```

### Persistence Layers

```
                 ┌─────────────────────────────────────────────────────────┐
                 │                    PERSISTENCE                          │
                 │                                                         │
 ALWAYS ON       │  ┌──────────────────────────────────────────────────┐   │
 (both modes)    │  │  memory.db (SQLite)                              │   │
                 │  │  ├── episodes     — every message, importance 1-9│   │
                 │  │  ├── knowledge    — whiteboards, system state    │   │
                 │  │  ├── FTS5 index   — keyword search               │   │
                 │  │  └── session IDs  — per-project + workspace      │   │
                 │  └──────────────────────────────────────────────────┘   │
                 │                                                         │
 PROJECT MODE    │  ┌─────────────────────┐  ┌─────────────────────────┐   │
 ONLY            │  │  MEMORY.md          │  │  CLAUDE.md              │   │
 (written by     │  │  ┌─ session cont.   │  │  ┌─ architecture       │   │
 /wrapup)        │  │  │  focus, next     │  │  │  config, commands   │   │
                 │  │  │  steps, blockers │  │  │  modules, VPS       │   │
                 │  │  ├─ operational     │  │  │  design decisions   │   │
                 │  │  │  paths, creds    │  │  └─ conventions        │   │
                 │  │  ├─ patterns        │  │     (git-tracked)      │   │
                 │  │  │  learnings       │  └─────────────────────────┘   │
                 │  │  └─ file ownership  │                                │
                 │  │    (auto-memory)    │                                │
                 │  └─────────────────────┘                                │
                 └─────────────────────────────────────────────────────────┘
```

### Content Boundaries (strict — no duplication)

| File | Owns | Written by | Loaded by |
|------|------|-----------|-----------|
| **CLAUDE.md** | Architecture, config, design decisions, build cmds, modules, VPS, conventions | Implementation commits + `/wrapup` hygiene | Claude CLI (auto, from cwd) |
| **MEMORY.md** | Session continuity + operational knowledge + debugging learnings | `/wrapup` synthesis | Claude CLI (auto-memory path) |
| **memory.db** | All episodes, knowledge entries, session IDs, whiteboards | Every message (real-time) | ContextBuilder (injected per-message) |

---

## Message Flow

```
 TELEGRAM                    BRIDGE                         CLAUDE CLI
 ────────                    ──────                         ──────────

  User msg ──────► Grammy bot
                    │
                    ├─ Auth (user ID check)
                    │
                    ├─ ContextBuilder.build()
                    │   ├─ topic extraction
                    │   ├─ episode retrieval (scored)
                    │   ├─ knowledge lookup
                    │   └─ budget assembly (≤4000 tok)
                    │
                    ├─ Prepend context to message
                    │
                    ▼
              ClaudeInvoker.send()
                    │
                    ├─ claude --resume <id>
                    │   -p "ctx + message"          ──────► CLI starts
                    │   --output-format stream-json         │
                    │                                       ├─ SessionStart hooks fire
                    │                                       │   ├─ LoadContext
                    │                                       │   └─ BuildCLAUDE
                    │                                       │
                    │                                       ├─ CLAUDE.md loaded (cwd)
                    │                                       ├─ MEMORY.md loaded (auto-memory)
                    │                                       │
                    │                                       ├─ UserPromptSubmit hooks
                    │                                       │   ├─ RatingCapture
                    │                                       │   └─ SessionAutoName
                    │                                       │
                    │   ◄── stream: assistant events ───────┤  Claude thinks + tools
                    │   ◄── stream: tool events ────────────┤  PreToolUse hooks fire
                    │   ◄── stream: result event ───────────┤  PostToolUse hooks fire
                    │                                       │
                    │                                       ├─ Stop hooks fire
                    │                                       │   ├─ LastResponseCache
                    │                                       │   ├─ RelationshipMemory
                    │                                       │   └─ DocIntegrity
                    │                                       │
                    │                                       └─ SessionEnd hooks fire
                    │                                           ├─ WorkCompletionLearning
                    │                                           ├─ SessionCleanup
                    │                                           ├─ SynthesisScheduler
                    │                                           └─ UpdateCounts
                    │
                    ├─ Parse response
                    │   ├─ result text
                    │   ├─ usage (accumulated)
                    │   ├─ lastTurnUsage (per-turn)
                    │   ├─ contextWindow
                    │   └─ session ID
                    │
                    ├─ compactFormat() — strip verbosity
                    ├─ chunkMessage() — split at 4000 chars
                    ├─ Append statusline
                    │
  ◄──────── Reply to user
                    │
                    ├─ modeManager.recordMessage()
                    │   ├─ track lastTurnUsage → context %
                    │   └─ increment message count
                    │
                    ├─ memoryStore.record() — episode
                    │
                    ├─ Auto-wrapup check (70% context)
                    │
                    └─ Synthesis flush (importance trigger)
```

---

## Wrapup Flow

```
  /wrapup
     │
     ▼
  ┌──────────────────────────────────────────┐
  │  Step 1: Session Summary (both modes)    │
  │  ├─ Gather last 20 episodes              │
  │  ├─ quickShot → 3-5 bullet summary      │
  │  └─ Store as importance-9 episode        │
  └──────────────┬───────────────────────────┘
                 │
                 ▼
  ┌──────────────────────────────────────────┐
  │  Step 2: Project files (project mode)    │
  │                                          │
  │  ┌─ MEMORY.md synthesis ──────────────┐  │
  │  │  Read current → quickShot rewrite  │  │
  │  │  Rules: rewrite-not-append,        │  │
  │  │  promote-don't-hoard, ≤150 lines   │  │
  │  │  Includes session continuity       │  │
  │  └────────────────────────────────────┘  │
  │                                          │
  │  ┌─ CLAUDE.md hygiene ────────────────┐  │
  │  │  Read current → quickShot rewrite  │  │
  │  │  Remove stale, add new arch,       │  │
  │  │  no session state, ≤150 lines      │  │
  │  │  Skip if no existing CLAUDE.md     │  │
  │  └────────────────────────────────────┘  │
  └──────────────┬───────────────────────────┘
                 │
                 ▼
  ┌──────────────────────────────────────────┐
  │  Step 3: Session Rotation (both modes)   │
  │  ├─ rotateWorkspaceSession()             │
  │  ├─ resetSessionMetrics()                │
  │  └─ newSession()                         │
  └──────────────────────────────────────────┘
```

---

## Context % Tracking

```
  Claude CLI response (stream-json)
     │
     ├─ type: "assistant" events (per API call in agentic loop)
     │   └─ message.usage = { input_tokens, cache_*, output_tokens }
     │       │
     │       └─► lastTurnUsage  ◄── LAST one wins (= current context fill)
     │
     ├─ type: "result" event (final, accumulated across all turns)
     │   └─ usage = { input_tokens, cache_*, output_tokens }
     │       │
     │       └─► usage  ◄── total consumed (for /status display)
     │
     └─ modelUsage → contextWindow (e.g., 200000)

  Context % = min(99, round(
    (lastTurnUsage.input + cache_creation + cache_read) / contextWindow × 100
  ))

  Why lastTurnUsage:
  ┌──────────────────────────────────────────────────────────────┐
  │  Turn 1: input=100k ──► ctx = 100k/200k = 50%              │
  │  Turn 2 (tool result added): input=130k ──► ctx = 65%      │
  │  Turn 3 (another tool): input=150k ──► ctx = 75%           │
  │                                                              │
  │  result.usage.input = 100k+130k+150k = 380k ──► 190% WRONG │
  │  lastTurnUsage.input = 150k ──► 75% CORRECT                │
  └──────────────────────────────────────────────────────────────┘
```

---

## PAI Hooks (VPS — Cloud Profile)

### Enabled (16 hooks)

```
  SESSION LIFECYCLE:
  ─────────────────

  SessionStart ──┬── LoadContext          inject steering rules, projects, learnings
                 └── BuildCLAUDE          rebuild global CLAUDE.md from template

  UserPromptSubmit ┬── RatingCapture      explicit + implicit sentiment → learnings
                   └── SessionAutoName    4-word session title (deterministic + inference)

  PreToolUse ──┬── SecurityValidator ×4   Bash/Edit/Write/Read security patterns
               └── SkillGuard             block false-positive skill invocations

  PostToolUse ─┬── PRDSync ×2            Write/Edit PRD.md → sync to work.json

  Stop ──┬── LastResponseCache            cache response for RatingCapture
         ├── RelationshipMemory           extract preferences/frustrations
         └── DocIntegrity                 check PAI file integrity (self-gating)

  SessionEnd ──┬── WorkCompletionLearning capture work metadata as learnings
               ├── SessionCleanup         clean work state + session-names
               ├── SynthesisScheduler     trigger weekly synthesis (background)
               ├── UpdateCounts           refresh stats + API usage
               └── IntegrityCheck         background system checks
```

### Disabled (7 hooks — headless incompatible)

```
  REMOVED FROM VPS settings.json:

  ✗ KittyEnvPersist      SessionStart       requires Kitty terminal
  ✗ SetQuestionTab       PreToolUse         requires Kitty terminal
  ✗ QuestionAnswered     PostToolUse        requires Kitty terminal
  ✗ UpdateTabTitle       UserPromptSubmit   requires Kitty + voice server
  ✗ ResponseTabReset     Stop               requires Kitty terminal
  ✗ VoiceCompletion      Stop               requires voice server (localhost:8888)
  ✗ AgentExecutionGuard  PreToolUse         noisy warnings for legitimate agent use
```

---

## Statusline

```
  Format:
  ══ PAI ════════════════════════════════
  📁 project-name · HH:MM
  msg N · ctx XX% · NNep

  ┌────────────────────────────────────────────┐
  │  📁 / 🏠     mode indicator (project/home) │
  │  HH:MM       VPS local time                │
  │  msg N       message count this session     │
  │  ctx XX%     context window fill (per-turn) │
  │  NNep        episode count in memory.db     │
  └────────────────────────────────────────────┘
```

---

## Project Switching

```
  /project <name>
       │
       ├─ ProjectManager.getProject(name)  ◄── case-insensitive, partial match
       │   └─ searches config/projects.json
       │
       ├─ Save current project's session ID
       │
       ├─ Set new active project
       │   ├─ Restore saved session ID (or fresh)
       │   └─ Save state to memory.db
       │
       ├─ Resolve project path
       │   ├─ Check paths.vps (explicit)
       │   ├─ autoDetectPath ~/projects/<name>/ (convention)
       │   └─ autoClone if configured (git clone via HTTPS)
       │
       ├─ Update ClaudeInvoker cwd
       │
       └─ ModeManager.switchToProject(name)

  /workspace (/home)
       │
       ├─ Clear active project
       ├─ Restore workspace session ID
       ├─ Reset cwd to default
       └─ ModeManager.switchToWorkspace()
```
