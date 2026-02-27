// wrapup.ts — Lightweight auto-commit after each Cloud response
// Only commits tracked files (git add -u), never adds new files
// Non-blocking with timeout to avoid delaying Telegram responses
// Phase 5C: Branch guard prevents committing to main during pipeline tasks

const WRAPUP_TIMEOUT_MS = 10_000;

// Check the current git branch name in a directory
async function getCurrentBranch(projectDir: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: projectDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) return null;
    return stdout.trim();
  } catch {
    return null;
  }
}

// Auto-commit tracked changes in a project directory.
// If expectedBranch is provided (pipeline task), only commits if on that branch.
// Returns true if a commit was made, false otherwise
export async function lightweightWrapup(
  projectDir: string,
  expectedBranch?: string,
): Promise<boolean> {
  try {
    // Phase 5C: Branch guard — refuse to commit if on wrong branch
    if (expectedBranch) {
      const currentBranch = await getCurrentBranch(projectDir);
      if (currentBranch !== expectedBranch) {
        console.warn(
          `[wrapup] Branch guard: expected ${expectedBranch}, on ${currentBranch} — skipping commit`,
        );
        return false;
      }
    }
    // Stage tracked files only — never git add -A
    const addProc = Bun.spawn(["git", "add", "-u"], {
      cwd: projectDir,
      stdout: "pipe",
      stderr: "pipe",
    });

    const addTimeout = setTimeout(() => addProc.kill(), WRAPUP_TIMEOUT_MS);
    await addProc.exited;
    clearTimeout(addTimeout);

    // Check if there are staged changes
    const diffProc = Bun.spawn(["git", "diff", "--cached", "--quiet"], {
      cwd: projectDir,
      stdout: "pipe",
      stderr: "pipe",
    });

    const diffTimeout = setTimeout(() => diffProc.kill(), WRAPUP_TIMEOUT_MS);
    const diffExit = await diffProc.exited;
    clearTimeout(diffTimeout);

    // Exit 0 = no changes, exit 1 = has changes
    if (diffExit === 0) {
      return false;
    }

    // Commit with auto-save message
    const timestamp = new Date().toISOString().slice(0, 16).replace("T", " ");
    const commitProc = Bun.spawn(
      ["git", "commit", "-m", `cloud: auto-save ${timestamp}`, "--quiet"],
      {
        cwd: projectDir,
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    const commitTimeout = setTimeout(() => commitProc.kill(), WRAPUP_TIMEOUT_MS);
    const commitExit = await commitProc.exited;
    clearTimeout(commitTimeout);

    if (commitExit === 0) {
      console.log(`[wrapup] Auto-committed changes in ${projectDir}`);
      return true;
    }

    console.warn(`[wrapup] Commit exited with code ${commitExit}`);
    return false;
  } catch (err) {
    console.warn(`[wrapup] Error during auto-commit: ${err}`);
    return false;
  }
}
