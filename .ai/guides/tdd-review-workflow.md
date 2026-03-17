# TDD & Review Agent Workflow — Cloud Solution

> Roadmap for catching bugs early through test-driven development and automated review workflows.

## 1. Development Pipeline (Gate System)

Every code change passes through 5 gates before reaching production:

```
WRITE CODE → Gate 1 → Gate 2 → Gate 3 → Gate 4 → Gate 5 → VPS
             type     test     review    PR       deploy
```

### Gate 1: Type Check (instant, blocking)
```bash
bunx tsc --noEmit
```
- Runs on every save (IDE) and pre-commit
- Catches type errors, missing imports, interface mismatches
- Zero tolerance — must pass to proceed

### Gate 2: Test Suite (fast, blocking)
```bash
bun test
```
- Runs pre-commit and on every push
- Must pass to proceed to review
- Target: <10s total runtime

### Gate 3: Codex Review (automated, advisory → blocking for P0)
```bash
codex review --base HEAD
```
- Runs pre-commit (local Codex CLI)
- **P0 findings: BLOCK** — security vulnerabilities, data loss risks
- **P1 findings: WARN** — bugs, logic errors. Fix before PR.
- **P2-P3 findings: LOG** — style, minor improvements. Fix if easy.
- Auto-fix option: `CODEX_AUTOFIX=1` in bridge.env triggers `codex exec --full-auto` on P0-P1

### Gate 4: PR Review (GitHub, blocking)
- Push to `cloud/<description>` branch → PR auto-created by `/sync`
- GitHub Codex bot posts review comment
- Second pair of eyes — catches cross-file issues local review missed
- Must be clean (or findings acknowledged) before merge

### Gate 5: Pre-Deploy Verification
```bash
# On VPS after git pull:
bun install          # deps
bunx tsc --noEmit    # types
bun test             # tests
# Only then:
sudo systemctl restart isidore-cloud-bridge
# Verify:
sudo journalctl -u isidore-cloud-bridge -f  # watch for startup errors
# Send test message on Telegram
```

## 2. Test Strategy by Module Type

### Tier 1: Pure Functions (test now, high value)
Already extracted and testable. Pattern: export function, test in `src/__tests__/`.

| Module | Testable Functions | Status |
|--------|-------------------|--------|
| `format.ts` | `chunkMessage`, `escMd`, `compactFormat` | ✅ 25 tests |
| `claude.ts` | `detectClaudeError`, `extractToolDetail` | ✅ 16 tests |
| `config.ts` | `loadConfig` (with env override) | ❌ Not tested |
| `statusline.ts` | `buildStatusLine` | ❌ Not tested |
| `prd-parser.ts` | `parsePRD` | ❌ Not tested |
| `injection-scan.ts` | `scanForInjection` | ❌ Not tested |
| `schemas.ts` | Zod schema validation | ❌ Not tested |
| `rate-limiter.ts` | `RateLimiter` class | ❌ Not tested |

**Priority:** config.ts (validates all env vars), schemas.ts (validates all cross-agent JSON), statusline.ts, prd-parser.ts.

### Tier 2: Stateful with SQLite (test with in-memory DB)
These need a `:memory:` SQLite DB. Pattern: construct class with test DB, exercise methods.

| Module | Class | Key Methods to Test |
|--------|-------|-------------------|
| `memory.ts` | `MemoryStore` | `record`, `search`, `getRecent`, `recordSemantic`, `searchSemantic` |
| `context.ts` | `ContextBuilder` | `build` (scored retrieval), `injectContext` |
| `session.ts` | `SessionManager` | `current`, `clear`, `rotate` |

**Pattern:**
```typescript
import { Database } from "bun:sqlite";
const db = new Database(":memory:");
// Run schema CREATE TABLE statements
const store = new MemoryStore(config, db);
// Test methods
```

### Tier 3: External Dependencies (mock or integration test)
These interact with external systems (Telegram API, Claude CLI, GitHub CLI, filesystem).

| Module | External Dep | Test Approach |
|--------|-------------|---------------|
| `telegram.ts` | Grammy/Telegram API | Mock `ctx.reply`, test handler logic |
| `claude.ts` | Claude CLI (Bun.spawn) | Mock spawn, test stream parsing |
| `github.ts` | `gh` CLI | Mock `runGh`, test PR logic |
| `pipeline.ts` | Filesystem (tasks/) | Use temp dir, test file operations |
| `daily-memory.ts` | Filesystem + git | Use temp dir |

**Pattern:** Extract pure logic into helper functions (Tier 1), mock only the I/O boundary.

### Tier 4: Integration Tests (run on VPS only)
Full end-to-end with real Telegram, Claude, filesystem.

- Send message via bot API → verify response received
- Pipeline task write → verify result file created
- `/sync` command → verify branch + PR created

These are slow and require real credentials. Run manually or via `/test` command on Telegram.

## 3. Pure-Function Extraction Pattern

The key principle: **push logic out of handlers into pure functions.**

Before (untestable):
```typescript
bot.command("status", async (ctx) => {
  const mode = modeManager.currentMode();
  const session = await sessions.current();
  const episodes = await memory.count();
  const uptime = process.uptime();
  const msg = `Mode: ${mode}\nSession: ${session}\nEpisodes: ${episodes}\nUptime: ${Math.floor(uptime/3600)}h`;
  await ctx.reply(msg);
});
```

After (testable):
```typescript
// Pure function — easily testable
export function formatStatus(mode: string, session: string | null, episodes: number, uptimeSeconds: number): string {
  return `Mode: ${mode}\nSession: ${session ?? "none"}\nEpisodes: ${episodes}\nUptime: ${Math.floor(uptimeSeconds/3600)}h`;
}

// Handler just wires things together
bot.command("status", async (ctx) => {
  const msg = formatStatus(
    modeManager.currentMode(),
    await sessions.current(),
    await memory.count(),
    process.uptime()
  );
  await ctx.reply(msg);
});
```

## 4. Review-to-Fix Feedback Loop

```
Code change
  → codex review --base HEAD
    → Parse output for [P0]-[P3] markers
      → P0-P1: auto-fix via codex exec --full-auto
        → Re-run review to verify fix
          → If clean: commit
          → If not: show to developer
      → P2-P3: log to memory.db as semantic entry
        → Developer fixes at leisure
        → Pattern accumulation triggers learning
```

### Automated Review Script (add to scripts/)
```bash
#!/bin/bash
# scripts/review-and-fix.sh — Run review, auto-fix P0-P1, re-verify
set -euo pipefail

echo "=== Gate 1: Type Check ==="
bunx tsc --noEmit || { echo "BLOCKED: Type errors"; exit 1; }

echo "=== Gate 2: Tests ==="
bun test || { echo "BLOCKED: Test failures"; exit 1; }

echo "=== Gate 3: Codex Review ==="
REVIEW=$(codex review --base HEAD 2>&1) || true
echo "$REVIEW"

# Check for P0/P1
if echo "$REVIEW" | grep -q '\[P[01]\]'; then
  echo "Found P0/P1 findings. Auto-fixing..."
  codex exec --full-auto "Fix these review findings: $REVIEW"

  # Re-verify
  bunx tsc --noEmit || { echo "Auto-fix introduced type errors!"; exit 1; }
  bun test || { echo "Auto-fix broke tests!"; exit 1; }

  echo "Auto-fix applied. Review again to verify..."
  codex review --base HEAD
fi

echo "=== All gates passed ==="
```

## 5. Test File Conventions

```
src/
  __tests__/
    format.test.ts          # Tests for format.ts
    claude.test.ts          # Tests for claude.ts
    config.test.ts          # Tests for config.ts  (TODO)
    statusline.test.ts      # Tests for statusline.ts  (TODO)
    schemas.test.ts         # Tests for schemas.ts  (TODO)
    memory.test.ts          # Tests for memory.ts  (TODO)
    rate-limiter.test.ts    # Tests for rate-limiter.ts  (TODO)
    prd-parser.test.ts      # Tests for prd-parser.ts  (TODO)
    injection-scan.test.ts  # Tests for injection-scan.ts  (TODO)
```

- One test file per source module
- Test file name: `<module>.test.ts`
- Use `describe` blocks per exported function/class
- Use `test` (not `it`) for individual cases
- No mocking framework — use Bun's built-in `mock()`

## 6. CI Runner Design

**Local (every commit):**
```bash
bunx tsc --noEmit && bun test
```

**Pre-push hook (already installed on VPS):**
- Blocks direct pushes to `main`
- Forces `cloud/*` branch workflow

**GitHub Actions (future):**
```yaml
# .github/workflows/test.yml
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: bunx tsc --noEmit
      - run: bun test
```

**VPS post-deploy:**
```bash
bun install && bunx tsc --noEmit && bun test
```

## 7. Immediate Action Items (Priority Order)

1. **Deploy current fixes** — bot.catch + safeReply already written and merged to main
2. **Add config.ts tests** — validates env vars, highest risk of silent bugs
3. **Add schemas.ts tests** — validates all cross-agent JSON boundaries
4. **Add memory.ts tests** — in-memory SQLite, tests episode recording and search
5. **Create `scripts/review-and-fix.sh`** — automates the 3-gate pre-commit flow
6. **Add pre-commit hook** — runs type check + tests automatically
7. **Add GitHub Actions** — CI for cloud/* branches and PRs
8. **Extract pure functions from telegram.ts** — scoreUserMessage (already done), formatStatus, buildHelpText
