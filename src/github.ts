// github.ts — GitHub PR operations via gh CLI
// Standalone functions, no class. Each returns { ok, output }.

const DEFAULT_TIMEOUT = 30_000;
const LONG_TIMEOUT = 60_000;
const MAX_COMMENT_CHARS = 60_000;
const REVIEW_MARKER = "<!-- codex-review -->";

interface GhResult {
  ok: boolean;
  output: string;
}

interface PRInfo {
  prNumber: number;
  url: string;
}

/** Spawn `gh` CLI with args, return stdout+stderr */
export async function runGh(
  args: string[],
  cwd: string,
  timeout = DEFAULT_TIMEOUT,
): Promise<GhResult> {
  try {
    const proc = Bun.spawn(["gh", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GH_PROMPT_DISABLED: "1" },
    });

    const timer = setTimeout(() => proc.kill(), timeout);
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    clearTimeout(timer);

    return { ok: exitCode === 0, output: (stdout + stderr).trim() };
  } catch (err) {
    return { ok: false, output: `gh error: ${err}` };
  }
}

/** Find open PR for a branch. Returns { prNumber, url } or null. */
export async function findPR(
  branch: string,
  cwd: string,
): Promise<PRInfo | null> {
  const result = await runGh(
    ["pr", "list", "--head", branch, "--state", "open", "--json", "number,url", "--limit", "1"],
    cwd,
  );
  if (!result.ok) return null;

  try {
    const prs = JSON.parse(result.output.trim() || "[]");
    if (prs.length > 0) {
      return { prNumber: prs[0].number, url: prs[0].url };
    }
  } catch {
    // JSON parse failed — no PR
  }
  return null;
}

/** Idempotent: find existing PR or create a new one. */
export async function createOrReusePR(
  branch: string,
  title: string,
  body: string,
  cwd: string,
): Promise<GhResult & { pr?: PRInfo }> {
  // Check for existing PR first
  const existing = await findPR(branch, cwd);
  if (existing) {
    return { ok: true, output: `Existing PR #${existing.prNumber}`, pr: existing };
  }

  // Create new PR
  const result = await runGh(
    ["pr", "create", "--head", branch, "--base", "main", "--title", title, "--body", body],
    cwd,
    LONG_TIMEOUT,
  );

  if (!result.ok) {
    return result;
  }

  // Extract PR URL from output (gh pr create prints the URL)
  const urlMatch = result.output.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/);
  if (urlMatch) {
    const numMatch = urlMatch[0].match(/\/pull\/(\d+)/);
    const prNumber = numMatch?.[1] ? parseInt(numMatch[1], 10) : 0;
    return { ok: true, output: result.output, pr: { prNumber, url: urlMatch[0] } };
  }

  return { ok: true, output: result.output };
}

/** Upsert a review comment on a PR using a marker for idempotency. */
export async function upsertReviewComment(
  branch: string,
  reviewBody: string,
  cwd: string,
): Promise<GhResult> {
  const pr = await findPR(branch, cwd);
  if (!pr) {
    return { ok: false, output: "No open PR found for branch" };
  }

  // Truncate review body if needed
  const truncated = reviewBody.length > MAX_COMMENT_CHARS
    ? reviewBody.slice(0, MAX_COMMENT_CHARS) + "\n\n...(truncated)"
    : reviewBody;

  const commentBody = `${REVIEW_MARKER}\n## Codex Review\n\n${truncated}`;

  // List existing comments to find marker
  const listResult = await runGh(
    ["api", "--paginate", `repos/{owner}/{repo}/issues/${pr.prNumber}/comments`, "--jq", `.[] | select(.body | contains("${REVIEW_MARKER}")) | .id`],
    cwd,
  );

  if (listResult.ok && listResult.output.trim()) {
    // Update existing comment
    const commentId = listResult.output.trim().split("\n")[0];
    const patchResult = await runGh(
      ["api", "--method", "PATCH", `repos/{owner}/{repo}/issues/comments/${commentId}`, "-f", `body=${commentBody}`],
      cwd,
    );
    return { ok: patchResult.ok, output: patchResult.ok ? `Updated review comment on PR #${pr.prNumber}` : patchResult.output };
  }

  // Create new comment
  const createResult = await runGh(
    ["api", "--method", "POST", `repos/{owner}/{repo}/issues/${pr.prNumber}/comments`, "-f", `body=${commentBody}`],
    cwd,
  );
  return { ok: createResult.ok, output: createResult.ok ? `Posted review comment on PR #${pr.prNumber}` : createResult.output };
}

/** Merge PR via gh, then sync local main. */
export async function mergePR(
  branch: string,
  cwd: string,
): Promise<GhResult> {
  const pr = await findPR(branch, cwd);
  if (!pr) {
    return { ok: false, output: "No open PR found for branch" };
  }

  // Merge the PR
  const mergeResult = await runGh(
    ["pr", "merge", String(pr.prNumber), "--merge", "--delete-branch"],
    cwd,
    LONG_TIMEOUT,
  );

  if (!mergeResult.ok) {
    return mergeResult;
  }

  const runGit = async (args: string[]): Promise<GhResult> => {
    try {
      const proc = Bun.spawn(["git", ...args], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;
      return { ok: exitCode === 0, output: (stdout + stderr).trim() };
    } catch (err) {
      return { ok: false, output: `git error: ${err}` };
    }
  };

  // Sync local: checkout main + pull
  const checkoutResult = await runGit(["checkout", "main"]);
  if (!checkoutResult.ok) {
    return { ok: false, output: `PR merged, but local sync failed at \`git checkout main\`: ${checkoutResult.output}` };
  }

  const pullResult = await runGit(["pull", "origin", "main"]);
  if (!pullResult.ok) {
    return { ok: false, output: `PR merged, but local sync failed at \`git pull origin main\`: ${pullResult.output}` };
  }

  // Delete local branch (may already be gone)
  const deleteResult = await runGit(["branch", "-d", branch]);
  if (!deleteResult.ok) {
    return {
      ok: true,
      output: `Merged PR #${pr.prNumber} → main. Local branch cleanup skipped: ${deleteResult.output}`,
    };
  }

  return { ok: true, output: `Merged PR #${pr.prNumber} → main. Branch \`${branch}\` deleted.` };
}
