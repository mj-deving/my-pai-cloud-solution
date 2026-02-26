# Session: Knowledge Sync, Formatter Fix, VPS Restructure

**Date:** 2026-02-26 09:01
**Duration:** ~3 hours
**Mode:** full
**Working Directory:** /home/mj/projects/my-pai-cloud-solution

## Summary

Completed Part 2 (Knowledge Sync) of the Isidore Cloud plan: created private pai-knowledge GitHub repo, seeded with 156 files of MEMORY/USER data, configured VPS deploy key + classic PAT for full GitHub access, wrote bidirectional sync script. Fixed critical bridge issues — stale session auto-recovery and overly aggressive compact formatter that was crushing rich responses to one-liners. Restructured VPS directories to mirror local layout.

## Work Done

- Created private `mj-deving/pai-knowledge` GitHub repo (C10)
- Seeded repo with USER/, RELATIONSHIP/, LEARNING/ data (156 files)
- Generated deploy key on VPS, added with write access to pai-knowledge repo
- Configured classic PAT (`ghp_VZYS...`) on VPS via `gh auth login` for full repo access
- Wrote `scripts/sync-knowledge.sh` — bidirectional push/pull via rsync + git (C11)
- Tested sync on both local and VPS successfully (C12)
- Fixed VPS git identity (`Isidore Cloud <isidore-cloud@pai.local>`)
- Wrote comprehensive `ARCHITECTURE.md` (824 lines) — full reference document
- Restructured VPS from `~/my-pai-cloud-solution/` to `~/projects/my-pai-cloud-solution/`
- Updated systemd WorkingDirectory, crontab paths, deploy scripts, isidore-cloud-session CLI
- Fixed `src/format.ts` — replaced destructive >2000 char extraction with targeted Algorithm phase removal
- Fixed `src/claude.ts` — added stale session auto-recovery (detect "No conversation found", clear, retry)
- Deployed all fixes to VPS, restarted bridge service
- Cleaned stale Claude project bindings on VPS

## Decisions Made

| Decision | Rationale | Alternatives Considered |
|----------|-----------|------------------------|
| Use `gh repo clone` (HTTPS) for local pai-knowledge clone | SSH auth failed (`git@github.com: Permission denied`) — GitHub SSH keys not configured locally | Fix SSH keys for GitHub (unnecessary since HTTPS works fine) |
| Classic PAT over fine-grained for VPS | Fine-grained token generation bugged (wouldn't generate in final step) | Fine-grained with Contents/PRs/Issues scope (preferred but broken) |
| Deploy key for pai-knowledge + PAT for general repos | Deploy key is repo-scoped (secure), PAT needed for broader access | Account-level SSH key (less secure) |
| VPS directory structure `~/projects/` | Mirror local WSL2 layout for consistent mental model | Keep flat in home dir (inconsistent with local) |
| Targeted Algorithm phase removal in formatter | Preserve actual content while stripping internal phases | Keep destructive extraction (loses content), no formatting (too verbose) |

## Key Files Modified

| File | Change Type | Description |
|------|-------------|-------------|
| `scripts/sync-knowledge.sh` | created | Bidirectional knowledge sync (push/pull modes) |
| `ARCHITECTURE.md` | created | 824-line comprehensive reference document |
| `src/format.ts` | edited | Replaced destructive extraction with targeted phase removal |
| `src/claude.ts` | edited | Added stale session auto-recovery |
| `systemd/isidore-cloud-bridge.service` | edited | Updated WorkingDirectory to ~/projects/ |
| `scripts/deploy.sh` | edited | Updated PROJECT_DIR and all paths |
| `scripts/auth-health-check.sh` | edited | Updated path in usage comment |
| `CLAUDE.md` | edited | Updated status, paths, next steps |
| `Plans/jiggly-swimming-pnueli.md` | edited | Updated VPS path references |
| `Plans/optimized-cooking-boot.md` | edited | Updated VPS path references |

## Learnings

- `gh repo clone` uses HTTPS by default, bypassing SSH key issues — useful fallback
- Compact formatter was too aggressive — extracting "key content" via voice summary line destroyed rich responses; targeted removal of internal Algorithm phases is the right approach
- VPS git operations need explicit identity (`git config --global user.name/email`) — not inherited from GitHub auth
- Stale session IDs are a recurring issue after service restarts/directory moves — auto-recovery is essential
- Fine-grained GitHub PATs may have generation bugs — classic tokens with `repo` scope are reliable fallback

## Open Items

- [ ] Implement KnowledgeSync hooks (auto push/pull at SessionEnd/SessionStart)
- [ ] Verify formatter fix produces rich Telegram responses (deployed but not yet tested with fresh session)
- [ ] Write VPS CLAUDE.local.md for Cloud self-awareness
- [ ] Email bridge (C6) — blocked on IMAP/SMTP credentials from Marius
- [ ] Optional: VPS account-level SSH key for SSH git (HTTPS+PAT works fine)

## Context for Next Session

Part 2 knowledge sync infrastructure is complete (repo, script, access). The key remaining task is implementing automatic sync hooks (KnowledgeSync.hook.ts for SessionEnd push and SessionStart pull) so sync is hands-free instead of manual `sync-knowledge.sh` invocations. The formatter fix was deployed but should be verified with a fresh Telegram test.
