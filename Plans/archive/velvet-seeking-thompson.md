# Sync & Persistence Cleanup — Implementation Plan

## Context

Cloud Isidore has three overlapping sync/persistence mechanisms built incrementally for a local-first world. Two are dead weight:
- **HandoffManager** writes JSON snapshots nobody reads (logged and discarded at startup)
- **Knowledge sync** (`sync-knowledge.sh`) copies DAI memory dirs through a GitHub repo intermediary, but Cloud has its own `memory.db` and doesn't use them. Local hooks haven't fired since Feb 28.

**Goal:** Delete these two dead systems, simplify `/sync` to git-push-only, and make `memory.db` the sole persistence layer. Pure deletion — no new logic.

**Decisions (confirmed):**
1. Kill knowledge sync entirely (no more pai-knowledge repo dependency)
2. Memory-based continuity (ContextBuilder + memory.db, not file-based CLAUDE.local.md)
3. Replace CLAUDE.local.md cross-instance copying with memory.db
4. Surgical cleanup scope (~600 lines removed, 0 added)

---

## Step 1 — Delete files

| File | Lines | What it was |
|------|-------|-------------|
| `src/handoff.ts` | ~153 | HandoffManager class — JSON snapshots nobody reads |
| `scripts/sync-knowledge.sh` | ~232 | Knowledge sync via pai-knowledge repo |
| `scripts/cron-knowledge-sync.sh` | ~59 | VPS cron wrapper for knowledge sync |

Also `git rm CLAUDE.handoff.md` (stale artifact from Feb 28).

---

## Step 2 — `src/config.ts`

**EnvSchema** — remove 3 entries:
- L51: `KNOWLEDGE_SYNC_SCRIPT`
- L121-122: `HANDOFF_ENABLED`, `HANDOFF_DIR`
- L48: `PROJECT_REGISTRY_FILE` (no longer needed — registry loads from bundled `config/projects.json`)

**Config interface** — remove 4 fields:
- L181: `projectRegistryFile`
- L184: `knowledgeSyncScript`
- L253-254 area: `handoffEnabled`, `handoffDir`

**loadConfig()** — remove corresponding 4 entries:
- L323-324: `projectRegistryFile`
- L330-332: `knowledgeSyncScript`
- L395-396: `handoffEnabled`, `handoffDir`

---

## Step 3 — `src/projects.ts`

**Remove 3 methods** (L451-493):
- `knowledgeSyncPull()` (L455-457)
- `knowledgeSyncPush()` (L459-461)
- `runKnowledgeSync()` private (L463-493)
- Comment block (L451-453)

**Simplify `loadRegistry()`** (L48-70):
- Remove the primary path that reads `config.projectRegistryFile` (pai-knowledge)
- Load directly from `config/projects.json` (the current fallback), eliminate the two-tier try/catch

**Simplify `saveRegistry()`** (L403-424):
- Remove the pai-knowledge write block (L417-423)
- Keep only the bundled `config/projects.json` write

---

## Step 4 — `src/schemas.ts`

Remove HandoffObject schema + type (L249-269, ~21 lines):
```
// --- V2-C: Handoff ---
export const HandoffObjectSchema = z.object({ ... });
export type HandoffObject = z.infer<typeof HandoffObjectSchema>;
```

---

## Step 5 — `src/bridge.ts`

- Remove import L24: `import { HandoffManager } from "./handoff"`
- Remove HandoffManager init block (L174-185): variable declaration, readIncoming, console.log
- Remove `handoffManager` from TelegramAdapter constructor call (L265)
- Remove `handoffManager` from Dashboard constructor call (L458)
- Remove shutdown handoff write (L496-498)

---

## Step 6 — `src/telegram.ts`

- Remove import L17: `import type { HandoffManager } from "./handoff"`
- Remove parameter L33: `handoffManager?: HandoffManager | null`

**`/sync` handler** (L244-284):
- Remove L257: knowledge sync push call
- Remove L259-263: handoff write block
- Remove L271: `Knowledge:` status line
- Remove L272: `Handoff:` status line
- Update command comment L244 to: `/sync — Commit + push + status`

**`/project` handler** (L140-174):
- Remove L149-150: knowledge sync pull call
- Remove L171: `Knowledge:` status line in reply
- Renumber step comments (5→4, 6→5)

---

## Step 7 — `src/telegram-adapter.ts`

- Remove import L24: `import type { HandoffManager } from "./handoff"`
- Remove constructor param L42: `handoffManager?: HandoffManager | null`
- Remove pass-through arg L55: `handoffManager`

---

## Step 8 — `src/dashboard.ts`

- Remove import L16: `import type { HandoffManager } from "./handoff"`
- Remove constructor param L55: `private handoffManager: HandoffManager | null = null`
- Remove `/api/handoff` route L97
- Remove `getHandoffData()` method (L308-313)

---

## Step 9 — `src/dashboard-html.ts`

Remove the handoff panel from the dashboard UI:
- CSS classes `.handoff-field`, `.handoff-label`, `.handoff-value`, `.handoff-warn` (L332-336)
- "Last Handoff" section HTML (L427-429)
- `renderHandoff()` function (L668-690)
- `/api/handoff` fetch call (L817)

---

## Step 10 — Documentation updates

**CLAUDE.md:**
- Module table: remove `handoff.ts` row
- Replace "Cross-Instance Continuity" section: `memory.db` via ContextBuilder, not file-based
- Update `/sync` description in architecture section

**MEMORY.md:**
- Remove/update stale entries about knowledge sync, three sync systems, HandoffManager

---

## Optional cleanup (low priority, can be separate commit)

- `SKIP_KNOWLEDGE_SYNC: "1"` appears in `claude.ts` (5 places), `verifier.ts` (1), `pipeline.ts` (1) — harmless but dead. Can remove in follow-up.
- `handoff-state.json` name is confusing now (it's really `project-state.json`). Can rename later.

---

## VPS post-deploy steps

```bash
# Remove knowledge sync cron
ssh isidore_cloud 'crontab -l | grep -v cron-knowledge-sync | crontab -'

# Clean up handoff directory (if any files exist)
ssh isidore_cloud 'rm -rf ~/.claude/handoff/'

# Restart bridge
ssh isidore_cloud 'sudo systemctl restart isidore-cloud-bridge'

# Verify clean startup
ssh isidore_cloud 'sudo journalctl -u isidore-cloud-bridge --since "1 min ago" | head -30'
```

---

## Verification

1. **Type check:** `~/.bun/bin/bunx tsc --noEmit` — zero errors
2. **No dangling references:** `grep -rn 'HandoffManager\|knowledgeSyncPush\|knowledgeSyncPull\|HandoffObjectSchema\|HANDOFF_ENABLED\|KNOWLEDGE_SYNC' src/` — zero results
3. **Build:** `bun build src/bridge.ts --no-bundle` — succeeds
4. **Deploy + test:** `bash scripts/deploy.sh`, then:
   - `/sync` on Telegram → shows Git status only, no Knowledge/Handoff lines
   - `/project my-pai-cloud-solution` → shows Git pull status only
   - Dashboard loads without errors (handoff panel gone)
5. **VPS cron clean:** `ssh isidore_cloud 'crontab -l'` — no knowledge-sync entry
