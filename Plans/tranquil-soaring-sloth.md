# Add CLAUDE.md to Cloud Project Wrapup + Hygiene

## Context

Cloud wrapup (`/wrapup` in project mode) currently writes MEMORY.md + CLAUDE.local.md via quickShot synthesis. It does NOT write CLAUDE.md. Since Claude CLI reads all three files from the project cwd on every invocation, CLAUDE.md goes stale when cloud makes architectural changes. The local wrapup skill has a 3-phase hygiene cycle (audit/triage/propose) for CLAUDE.md — cloud should mirror this, with hygiene rules baked into the synthesis prompt instead of interactive approval.

**Goal:** Cloud project wrapup writes all three files, with the same hygiene principles as local wrapup. The prompt enforces clear content boundaries so CLAUDE.md, MEMORY.md, and CLAUDE.local.md don't duplicate each other.

---

## Changes

### 1. `src/telegram.ts` — Add CLAUDE.md synthesis to `writeWrapupFiles()`

Add a third synthesis step after MEMORY.md and CLAUDE.local.md. The prompt must:

1. **Read current CLAUDE.md** from `{projectDir}/CLAUDE.md` (graceful if missing — skip, don't create from scratch)
2. **Full rewrite** (not append) — same pattern as MEMORY.md synthesis
3. **Enforce hygiene rules** in the prompt itself:
   - Remove stale items (completed work, resolved issues, one-time decisions)
   - Remove noise (task-specific details not needed every session)
   - Remove duplication (anything already in MEMORY.md or CLAUDE.local.md)
   - Keep architecture, config, design decisions, module table, commands, VPS details
   - Keep build/run commands
   - Update any descriptions that no longer match current behavior
   - Add new architectural changes from this session (new modules, changed flows, new commands)
4. **Enforce content boundaries** in the prompt:
   - CLAUDE.md owns: architecture, config, design decisions, build commands, module responsibilities, VPS details, conventions
   - MEMORY.md owns: operational knowledge NOT in CLAUDE.md, debugging learnings, credentials/paths not in CLAUDE.md
   - CLAUDE.local.md owns: session state, current focus, next steps, blockers
5. **Target ≤ 150 lines** — same as local
6. **No interactive approval** — hygiene rules are in the prompt, synthesis is conservative

```typescript
// --- Step 6 (cloud): Synthesize CLAUDE.md with hygiene ---
try {
  const claudeMdPath = join(projectDir, "CLAUDE.md");
  let currentClaudeMd = "";
  try {
    currentClaudeMd = await readFile(claudeMdPath, "utf-8");
  } catch {
    // No CLAUDE.md — skip, don't create from scratch
  }

  if (currentClaudeMd) {
    const claudeMdPrompt = `You are performing hygiene on a project's CLAUDE.md file. This file is auto-loaded by Claude Code every session and must stay current, concise, and high-signal.

PROJECT: ${displayName}

CURRENT CLAUDE.md:
${currentClaudeMd.slice(0, 4000)}

RECENT CONVERSATION (what changed this session):
${conversationText.slice(0, 2000)}

HYGIENE RULES — apply all of these:
1. REMOVE stale content: completed work, resolved issues, one-time decisions, outdated descriptions
2. REMOVE noise: task-specific details that don't apply to every session
3. REMOVE duplication: anything that belongs in MEMORY.md (operational knowledge, debugging tips) or CLAUDE.local.md (session state, next steps)
4. UPDATE descriptions that no longer match current behavior (e.g., changed thresholds, new flows)
5. ADD new architectural changes from this session: new modules, changed message flows, new commands, new design decisions
6. KEEP: architecture, config, design decisions, build/run commands, module responsibilities, VPS details, conventions, commands reference
7. Target: ≤ 150 lines total

CONTENT BOUNDARIES — strict separation:
- CLAUDE.md owns: architecture, config, design decisions, build commands, module table, VPS details, conventions
- MEMORY.md owns: operational knowledge NOT in CLAUDE.md, debugging learnings, credentials
- CLAUDE.local.md owns: session state, current focus, next steps, blockers
- NEVER put session state, next steps, or debugging tips in CLAUDE.md

Rewrite the CLAUDE.md completely. Preserve its structure and sections. Output ONLY the markdown, no code fences.`;

    const claudeMdResponse = await claude.quickShot(claudeMdPrompt);
    if (claudeMdResponse.result && !claudeMdResponse.error) {
      await writeFile(claudeMdPath, claudeMdResponse.result.trim() + "\n", "utf-8");
      console.log(`[telegram] Wrapup: wrote CLAUDE.md (${claudeMdPath})`);
    }
  }
} catch (err) {
  console.warn(`[telegram] Wrapup CLAUDE.md hygiene failed: ${err}`);
}
```

**Key design decisions:**
- **Skip if no existing CLAUDE.md** — cloud should never create CLAUDE.md from scratch; it's git-tracked and created locally
- **4000 char budget for CLAUDE.md** — it's ~130 lines, fits comfortably (vs 2000 for conversation text)
- **Conservative by default** — prompt says "preserve structure and sections", only update/remove/add based on evidence
- **Same error handling pattern** — try-catch, warn, don't block

### 2. No other files change

- `claude.ts` — `quickShot()` already works correctly (uses project cwd, one-shot)
- `mode.ts` — no changes needed
- `bridge.ts` — no changes needed
- `schemas.ts` — no changes needed

---

## Summary

| File | Change |
|------|--------|
| `src/telegram.ts` | Add CLAUDE.md synthesis step to `writeWrapupFiles()` — read current → quickShot hygiene → write back |

Single-file change, ~40 lines of code added inside the existing `writeWrapupFiles()` function.

---

## Verification

1. `bunx tsc --noEmit` — type check passes
2. Deploy + restart: `bash scripts/deploy.sh && ssh isidore_cloud 'sudo systemctl restart isidore-cloud-bridge'`
3. Telegram test:
   - `/project my-pai-cloud-solution` → switch to project mode
   - Send a message or two (to have conversation context)
   - `/wrapup` → should write all three files
   - Check VPS: `ssh isidore_cloud 'head -20 ~/projects/my-pai-cloud-solution/CLAUDE.md'` — verify it's been rewritten with hygiene applied
   - Check VPS: `ssh isidore_cloud 'wc -l ~/projects/my-pai-cloud-solution/CLAUDE.md'` — verify ≤ 150 lines
4. Verify CLAUDE.md doesn't contain MEMORY.md content (operational knowledge, debugging tips)
5. Verify MEMORY.md doesn't contain CLAUDE.md content (architecture, config)
