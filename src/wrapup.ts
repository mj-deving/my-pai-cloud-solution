// wrapup.ts — Lightweight auto-commit after each Cloud response
// Only commits tracked files (git add -u), never adds new files
// Non-blocking with timeout to avoid delaying Telegram responses

const WRAPUP_TIMEOUT_MS = 10_000;

// Auto-commit tracked changes in a project directory
// Returns true if a commit was made, false otherwise
export async function lightweightWrapup(projectDir: string): Promise<boolean> {
  try {
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
