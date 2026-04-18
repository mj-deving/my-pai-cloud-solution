---
summary: "ADR-0002: deactivate local Codex CLI review; use GitHub-native review only (Copilot / Codex bot / human)"
read_when: ["ADR", "codex review", "review workflow", "github review", "sync skill", "review skill"]
---

# ADR-0002: GitHub-native review only — deactivate local Codex CLI review

- **Status:** Accepted
- **Date:** 2026-04-18
- **Supersedes:** the two-layer review workflow previously described in `CLAUDE.md`

## Context

`/sync` and `/review` skills (and the bridge commands they mirror) ran `codex review --base main` locally, parsed `[P0]–[P3]` markers, upserted a `**Codex Review:**` comment on the PR, and optionally ran `codex exec --full-auto` for autofix when `CODEX_AUTOFIX=1`.

Observed problems:
1. **Timeouts / silent stalls.** Latest run on PR #6 produced diff echo only — no findings. Prior runs have hit 120s + timeouts without returning output.
2. **Auth fragility.** Codex CLI auth expires silently; failures surface as "timed out" with no diagnostic.
3. **Security-hook friction.** The local `SecurityValidator` hook blocks raw `codex review` invocations, forcing every call through a wrapper script that adds another layer of things that can break.
4. **Duplication.** GitHub Copilot auto-reviews PRs; if a Codex GitHub App is installed, it reviews there too. Running the same analysis locally doubles the work without a proportional quality improvement.
5. **Wrong process shape.** Review belongs next to the PR UI where reviewers comment, not in a CLI transcript that nobody rereads.

## Decision

Deactivate local Codex CLI review as a skill-invoked step. All review is handled on GitHub — Copilot, optional Codex GitHub App, and/or human reviewers.

Concretely:

1. `.claude/skills/sync/SKILL.md` — removed Codex steps 4–6 (review, post, autofix). Kept an optional "post pre-verification comment" step that records `bun test` + `tsc` outcome.
2. `.claude/skills/review/SKILL.md` — repurposed to summarize a `cloud/*` branch (diff + commits + optional test status) and post a GitHub PR comment. No `codex review`, no `[P0]–[P3]` parsing, no `--edit-last` upsert, no autofix.
3. `CLAUDE.md` — "Two-Layer Review Workflow" section replaced with a single GitHub-native workflow.
4. `AGENTS.md` — validation ladder no longer prescribes `review-and-fix.sh`.
5. `scripts/review-cloud.sh` and `scripts/review-and-fix.sh` — **kept in-tree** as manual tools for anyone who wants a local second opinion, but NO skill invokes them.

## Alternatives considered

1. **Keep Codex CLI review but fix the timeouts.** Rejected: timeouts are one symptom; auth fragility + duplication with GitHub remain.
2. **Delete `scripts/review-cloud.sh` + `scripts/review-and-fix.sh` entirely.** Rejected: manual pre-push second opinions are occasionally useful; keeping scripts as opt-in tools costs nothing.
3. **Keep `CODEX_AUTOFIX=1` autofix because it's powerful.** Rejected: autofix without a review gate that fires reliably is a footgun. If autofix comes back, it rides on top of a GitHub-driven review signal.

## Consequences

Positive:
- Skills become simpler and more reliable — fewer external-tool dependencies
- PR reviews land where reviewers already look
- No more silent stalls
- Removes the SecurityValidator wrapper path for routine work

Negative:
- Loss of pre-push Codex review inside skills. If the GitHub Codex App isn't configured on the repo, reviewers get only Copilot + humans — may be weaker coverage for this specific repo.
- Existing PRs that had `**Codex Review:**` comments via `--edit-last` no longer receive updates through skills.

Neutral:
- `scripts/review-cloud.sh` and `scripts/review-and-fix.sh` remain runnable manually. No code was deleted.
- `review-learning.ts` (parses Codex findings from stored comments) still works on historical data.

## Follow-ups

- Verify GitHub Copilot PR reviews are enabled on `mj-deving/my-pai-cloud-solution`
- Optionally install the Codex GitHub App if we want an explicit second reviewer on PRs
- When/if bridge retires fully, re-evaluate whether `review-learning.ts` should be removed or repurposed
