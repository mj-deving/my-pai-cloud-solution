# Persona Framework Research Report

**Date:** 2026-02-28
**Researcher:** Intern Agent (Dev Patel)
**Task:** Research agent personalization frameworks to inform Isidore Cloud persona system design

---

## 1. OpenClaw's Persona System

OpenClaw (by Peter Steinberger, went viral Jan 2026) implements a **three-layer identity architecture** separating concerns cleanly:

### Layer 1: SOUL.md (Philosophy / Internal Identity)

The core innovation. A plain Markdown file loaded at session bootstrap that defines *how the agent thinks*. Sections:

| Section | Purpose | Format |
|---------|---------|--------|
| **Core Truths** | Foundational behavioral principles (4-5 items) | Prose bullets |
| **Personality Traits** | Specific behavioral descriptors (not vague adjectives) | Markdown bullets with explanations |
| **Communication Style** | Tone, verbosity, formatting preferences, humor level | Prose |
| **Values & Priorities** | Non-negotiable behavioral boundaries, what to optimize for | Prose bullets |
| **Expertise** | Three-tier: deep knowledge, working knowledge, avoid | Categorized lists |
| **Situational Behavior** | Context-specific responses (brainstorming vs. factual) | Scenario-based |
| **Anti-Patterns** | Explicit prohibitions, phrases to never use | List |
| **Boundaries** | Privacy, confirmation requirements, group behavior | Rules |
| **Vibe** | Brief character directive (conversational, authentic) | Short prose |
| **Continuity** | How identity persists across sessions, self-modification rules | Instructions |

Key quote from the template: *"Be the assistant you'd actually want to talk to. Concise when needed, thorough when it matters. Not a corporate drone. Not a sycophant. Just... good."*

**Design philosophy:** Specificity over generality. "Direct and opinionated" with behavioral explanations, not "be helpful." Max ~200 lines for scannability.

### Layer 2: IDENTITY.md (Presentation / External Identity)

Lightweight external appearance, structured fields:

```
AgentIdentityFile:
  name: string          # Display identifier (max length enforced)
  emoji: string         # Reaction shown on acknowledgment
  theme: string         # Visual styling preference
  creature: string      # Personality archetype descriptor
  vibe: string          # Behavioral tone characterization
  avatar: string        # Image asset reference
```

### Layer 3: AGENTS.md + Config (Capabilities)

Operational configuration separate from personality: tool permissions, workspace directories, state/auth, session storage. Each agent runs in complete isolation with dedicated directories.

### Identity Resolution Cascade

```
global config -> per-agent config -> workspace files -> defaults
```

Most-specific definition wins. Multi-agent routing uses **bindings** (matching rules based on channel, peer, guild, team).

### Relationship Model

OpenClaw treats identity as an evolving feedback loop: *"You're becoming someone"* rather than following static instructions. The agent can edit its own SOUL.md, creating intentional co-evolution between agent and user. Identity persists across sessions through file-based storage.

### Tool Preferences

Not part of SOUL.md. Configured separately in AGENTS.md/config layer. This is an explicit architectural choice -- personality does not dictate capabilities.

---

## 2. Personality Traits Quantification (Industry Approaches)

### OpenClaw: Qualitative (free text)
- No numeric scales. Personality is expressed as behavioral descriptions in prose
- "Direct and opinionated" with specific behavioral examples
- Pros: Expressive, nuanced, easy to author. Cons: Hard to compare, no programmatic access

### PAI (Current): Quantitative (0-100 scale)
```json
"personality": {
  "enthusiasm": 75,
  "energy": 80,
  "expressiveness": 85,
  "resilience": 85,
  "composure": 70,
  "optimism": 75,
  "warmth": 70,
  "formality": 30,
  "directness": 80,
  "precision": 95,
  "curiosity": 90,
  "playfulness": 45
}
```
Pros: Machine-readable, comparable, tunable. Cons: Can feel reductive.

### Academic (Big Five / OCEAN model):
- Openness, Conscientiousness, Extraversion, Agreeableness, Neuroticism
- Psychometrically validated scales
- Research shows minor prompt phrasing changes cause marked shifts in trait scores
- LLM "traits" lack cross-situational consistency (input-driven distributions, not fixed profiles)

### CrewAI: Narrative (role/goal/backstory)
- No numeric traits at all
- Personality emerges from backstory prose
- Example: "You are a seasoned financial analyst with 20 years of experience..."

---

## 3. Voice/Communication Style Approaches

### OpenClaw
- Defined in SOUL.md Communication Style section
- Prose-based: tone (formal/casual), verbosity (brief/detailed), humor level, technical depth, formatting preferences
- No TTS integration in core -- community extensions handle voice

### PAI (Current)
- ElevenLabs voice integration with prosody settings per agent:
  ```yaml
  voice:
    stability: 0.35
    similarity_boost: 0.68
    style: 0.40
    speed: 1.10
    use_speaker_boost: true
    volume: 0.7
  ```
- Voice-to-trait mapping system in Traits.yaml (trait combinations -> voice selection)
- Separate voice IDs per agent with per-agent prosody tuning
- This is significantly more advanced than any other framework surveyed

### CrewAI
- No voice support. Communication style implied by backstory/role text
- `verbose` flag controls output detail level

### OpenAI Agents SDK
- Instructions/system prompt as personality mechanism
- No separate persona object -- personality lives in the prompt
- Personality profiles: Professional, Efficient, Fact-based, Exploratory

---

## 4. Relationship Model Approaches

### OpenClaw
- Agent-user relationship is emergent and evolving
- Agent can modify its own SOUL.md (self-evolution)
- USER.md stores user context (preferences, expertise level, history)
- Continuity section in SOUL.md defines persistence behavior

### PAI (Current)
- DAIDENTITY.md defines explicit relationship model:
  ```
  Relationship Model: Mentor / Guide
  - Challenge assumptions constructively
  - Explain the *why* behind recommendations
  - Point out learning opportunities
  - Encourage junior/student mindset while building confidence
  ```
- RelationshipMemory.hook.ts fires on session end (captures relationship evolution)
- Principal/DA terminology explicitly models the human-AI relationship

### CrewAI
- No user relationship model -- agents relate to each other via delegation
- `allow_delegation` flag enables inter-agent handoff

### AutoGen
- ConversableAgent base class -- relationship modeled as conversation participants
- UserProxyAgent represents human in the loop
- No personality/relationship configuration beyond system messages

---

## 5. Tool Preferences

### OpenClaw
- Separate from identity (AGENTS.md / config layer)
- Per-agent tool restrictions and permissions
- Workspace isolation per agent

### PAI (Current)
- Per-agent permissions in frontmatter:
  ```yaml
  permissions:
    allow:
      - "Bash"
      - "Read(*)"
      - "WebSearch"
  ```
- ComposeAgent infers tool preferences from trait-based composition
- Built-in agents (Engineer, Algorithm, etc.) have role-specific permissions

### CrewAI
- `tools` list per agent (List[BaseTool])
- `allow_code_execution` and `code_execution_mode` flags
- Tool assignment is explicit, not personality-driven

---

## 6. Other Notable Frameworks

### A. CrewAI (Role-Based Orchestration)

**Schema:**
```yaml
agent_name:
  role: >
    Specialized Role Title
  goal: >
    Primary objective statement
  backstory: >
    Multi-line contextual background
```

**25 configurable parameters** including role, goal, backstory (required), plus LLM config, execution limits, behavioral flags, templates.

**Strengths:** Simple, intuitive "hire a team" metaphor. Variable substitution at runtime.
**Weaknesses:** No quantitative personality traits. No voice. No relationship model.

### B. AutoGen (Microsoft, Conversational Collaboration)

**Approach:** Agent classes with system message as persona. AssistantAgent, UserProxyAgent, GroupChatManager.

**Strengths:** Flexible conversational patterns, human-in-loop native.
**Weaknesses:** No dedicated persona system. Personality = system prompt. No structured identity.

### C. OpenAI Agents SDK

**Schema:** `Agent(name, instructions, tools, model)` -- minimalist.

**Personality profiles documented:** Professional, Efficient, Fact-based, Exploratory.

**Best practice from docs:** "Start with a minimal, well-scoped personality aligned to the target workload, validate it through evals, and evolve it deliberately."

**Strengths:** Simple, production-focused. Clear separation: personality = how agent responds, not what it does.
**Weaknesses:** No structured persona object. No voice. No relationship model.

### D. SOUL Framework (Academic/Community)

**Four dimensions:**
1. **S**tyle -- tone, vocabulary, sentence structure, formatting
2. **O**bjectives -- primary goals, secondary goals, anti-goals
3. **U**nderstanding -- user context, expertise level, interaction patterns
4. **L**imits -- refusal boundaries, confidence thresholds, escalation triggers

**Strengths:** Clean conceptual model. Anti-goals are powerful.
**Weaknesses:** Theoretical framework, not production implementation.

### E. Psychometric Approach (Research Papers)

- Big Five personality mapping to LLM behavior
- Personality Prompting (P2) framework: persona instruction + keyword elaboration + model self-portrait
- Research finding: personality traits in LLMs manifest as "input-driven distributions rather than fixed profiles"
- Implication: Quantitative scales need reinforcement mechanisms (not just initial prompting)

---

## 7. Design Recommendations for PAI Persona Framework

### What PAI Already Does Well (Keep)

1. **Quantitative personality traits (0-100)** -- unique among frameworks, enables programmatic tuning
2. **Voice integration with prosody settings** -- far ahead of all competitors
3. **Trait-to-voice mapping** -- sophisticated voice selection based on personality
4. **ComposeAgent dynamic composition** -- most flexible agent creation system found
5. **Per-agent permissions** -- clean capability separation
6. **Explicit relationship model** -- only PAI and OpenClaw model this

### What to Add (From OpenClaw and Others)

1. **SOUL.md-style philosophy layer** -- behavioral values, anti-patterns, situational behavior
2. **Anti-goals / Anti-patterns section** -- explicit "never do this" behaviors (from SOUL + CrewAI)
3. **Situational behavior rules** -- context-specific persona shifts
4. **Self-evolution capability** -- agent can propose edits to its own persona (from OpenClaw)
5. **Identity resolution cascade** -- layered config precedence (global -> agent -> project -> defaults)

### Proposed Schema: `PersonaFramework v1.0`

```yaml
# ~/.claude/agents/{agent-name}.md frontmatter
---
# === IDENTITY (Presentation Layer) ===
name: "Isidore"
displayName: "ISIDORE"
title: "The Mentor"                    # Character archetype
color: "#3B82F6"
avatar: null                           # Optional image path
emoji: null                            # Reaction emoji (OpenClaw-style)

# === VOICE (TTS Layer) ===
voice:
  voiceId: "21m00Tcm4TlvDq8ikWAM"
  stability: 0.35
  similarity_boost: 0.80
  style: 0.90
  speed: 1.10
  use_speaker_boost: true
  volume: 0.85

# === PERSONALITY (Quantitative Layer - PAI original) ===
personality:
  # Core temperament (0-100 scales)
  enthusiasm: 75
  energy: 80
  expressiveness: 85
  resilience: 85
  composure: 70
  optimism: 75
  warmth: 70
  formality: 30
  directness: 80
  precision: 95
  curiosity: 90
  playfulness: 45

# === SOUL (Philosophy Layer - inspired by OpenClaw) ===
soul:
  # Core values (non-negotiable behavioral boundaries)
  values:
    - "Precision is care -- sloppy work disrespects the problem"
    - "Teach the why, not just the what"
    - "Challenge assumptions constructively"
    - "Genuine helpfulness over performative assistance"

  # Communication style (qualitative, complements quantitative traits)
  communication:
    tone: "Professional but warm, not corporate"
    verbosity: "Thorough when it matters, concise when it doesn't"
    humor: "Occasional dry wit, never forced"
    technical_depth: "Adapts to user's level, defaults high"

  # Anti-patterns (explicit prohibitions)
  anti_patterns:
    - "Never hedge with 'on the other hand' when you have a clear opinion"
    - "Never use corporate buzzwords (synergy, leverage, circle back)"
    - "Never be sycophantic or overly agreeable"
    - "Never skip the 'why' behind a recommendation"

  # Situational behavior (context-specific rules)
  situations:
    debugging: "Patient, methodical, ask before assuming"
    brainstorming: "Energetic, build on ideas, defer judgment"
    code_review: "Direct, specific, cite evidence"
    teaching: "Socratic questions before answers"

  # Catchphrases / verbal tics (character flavor)
  catchphrases:
    startup: "Gelobt sei Jesus Christus! Isidore here, ready to go"
    phrases:
      - "Let me think about this..."
      - "Here's what I'm seeing..."

# === RELATIONSHIP (Agent-User Model) ===
relationship:
  model: "mentor"                       # mentor | peer | assistant | coach | collaborator
  principal:
    name: "Marius"
    expertise_level: "advanced"         # beginner | intermediate | advanced | expert
    preferences:
      - "Explain architectural decisions"
      - "Point out learning opportunities"
      - "Be direct about tradeoffs"
  evolution:
    self_modify: false                  # Can agent propose edits to its own persona?
    track_rapport: true                 # Track relationship quality over time?

# === EXPERTISE (Domain Knowledge - from OpenClaw) ===
expertise:
  deep:
    - "TypeScript/Bun ecosystem"
    - "System architecture"
    - "CLI-first design"
  working:
    - "DevOps/deployment"
    - "Security patterns"
  avoid:
    - "Medical advice"
    - "Legal counsel"

# === CAPABILITIES (Tool Preferences) ===
permissions:
  allow:
    - "Bash"
    - "Read(*)"
    - "Write(*)"
    - "Edit(*)"
    - "WebSearch"
  preferred_tools:                      # Tools this persona gravitates toward
    - "Grep for investigation"
    - "Plan mode for complex tasks"
  tool_style: "CLI-first, browser for validation"

# === BACKSTORY (Narrative Layer - from CrewAI) ===
backstory: |
  Isidore is named after Saint Isidore of Seville, patron saint of the internet
  and computer scientists. A mentor and guide who teaches toward mastery, Isidore
  combines deep technical precision with genuine warmth. Years of pair-programming
  with Marius have built mutual understanding of project conventions, architectural
  preferences, and communication style.

# === META ===
model: opus
created: "2026-02-28"
version: "1.0"
source: "manual"                        # manual | ComposeAgent | evolution
traits: []                              # For ComposeAgent-composed agents
---
```

### Architecture: Three Files, Three Concerns

Following OpenClaw's separation pattern but adapted for PAI:

| File | Scope | Owns | Editable By |
|------|-------|------|-------------|
| `agents/{name}.md` | Full persona definition (frontmatter + body) | Identity, voice, personality, soul, relationship, backstory | User + ComposeAgent |
| `settings.json` `daidentity` | System-wide defaults for primary DA | Default voice, color, startup catchphrase | User (wizard) |
| `MEMORY/LEARNING/relationship-*.jsonl` | Evolving relationship state | Rapport history, preference discoveries | Hooks (automatic) |

### Resolution Cascade (most specific wins)

```
Agent frontmatter -> settings.json daidentity -> PAI defaults
```

### Key Design Principles

1. **Quantitative + Qualitative**: Keep numeric personality scales (unique to PAI, programmable) AND add prose-based soul/values (from OpenClaw, more expressive)
2. **Separation of concerns**: Identity (what it looks like) vs. Soul (how it thinks) vs. Capabilities (what it can do)
3. **Anti-patterns are first class**: Every persona should define what it will NOT do
4. **Relationship is explicit**: Not just "assistant" -- the agent-user dynamic is a configurable dimension
5. **Voice is integrated**: No other framework has TTS persona integration at this level
6. **Composability**: ComposeAgent already enables dynamic persona creation from traits; extend it to populate the full schema
7. **Evolution-ready**: Track relationship quality over time; optionally allow self-modification proposals

---

## Sources

- [OpenClaw SOUL.md Documentation](https://learnopenclaw.com/core-concepts/soul-md)
- [OpenClaw Identity Architecture (MMNTM)](https://www.mmntm.net/articles/openclaw-identity-architecture)
- [OpenClaw SOUL.md Template](https://docs.openclaw.ai/reference/templates/SOUL)
- [OpenClaw Programmable Soul System](https://openclawsoul.org/)
- [CrewAI Agent Concepts](https://docs.crewai.com/en/concepts/agents)
- [Designing AI Agent Personalities (DEV Community)](https://dev.to/techfind777/designing-ai-agent-personalities-a-practical-framework-n6n)
- [OpenAI Agents SDK](https://openai.github.io/openai-agents-python/)
- [OpenAI Prompt Personalities](https://developers.openai.com/cookbook/examples/gpt-5/prompt_personalities/)
- [Deterministic AI Agent Personality Expression (arXiv)](https://arxiv.org/html/2503.17085v1)
- [Designing AI-Agents with Personalities: A Psychometric Approach (arXiv)](https://arxiv.org/html/2410.19238v3)
- [AI Agent Framework Comparison (DataCamp)](https://www.datacamp.com/tutorial/crewai-vs-langgraph-vs-autogen)
- [AI Agent Frameworks Practical Guide (GetMaxim)](https://www.getmaxim.ai/articles/top-5-ai-agent-frameworks-in-2025-a-practical-guide-for-ai-builders/)
