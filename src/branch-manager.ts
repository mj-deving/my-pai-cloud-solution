// branch-manager.ts — Branch isolation for pipeline tasks (Phase 5C)
// Creates task-specific branches so pipeline work doesn't touch main.
// Tracks active branches in a lock file for crash recovery.
// Keyed by {projectDir}:{branch} for multi-project support.

import { readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { BranchLockMapSchema, strictParse, type BranchLock, type BranchLockMap } from "./schemas";

// Re-export for backward compatibility
export type { BranchLock };

export class BranchManager {
  private lockFilePath: string;
  private locks = new Map<string, BranchLock>();

  constructor(pipelineDir: string) {
    this.lockFilePath = join(pipelineDir, "branch-locks.json");
  }

  // --- Lock persistence (atomic write) ---

  private async loadLocks(): Promise<void> {
    try {
      const raw = await readFile(this.lockFilePath, "utf-8");
      const parsed = strictParse(BranchLockMapSchema, raw, "branch-manager/locks") as BranchLockMap;
      this.locks = new Map(Object.entries(parsed));
    } catch {
      // File doesn't exist or is corrupt — start fresh
      this.locks = new Map();
    }
  }

  private async saveLocks(): Promise<void> {
    const obj: Record<string, BranchLock> = {};
    for (const [key, lock] of this.locks) {
      obj[key] = lock;
    }
    const tmpPath = `${this.lockFilePath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(obj, null, 2) + "\n", "utf-8");
    await rename(tmpPath, this.lockFilePath);
  }

  private lockKey(projectDir: string, branch: string): string {
    return `${projectDir}:${branch}`;
  }

  // --- Branch operations ---

  // Create a task-specific branch and check it out.
  // Returns the branch name, or null if branch isolation should be skipped.
  async checkout(
    projectDir: string,
    taskId: string,
    source: "pipeline" | "orchestrator" = "pipeline",
  ): Promise<string | null> {
    if (!projectDir) return null;

    const branchName = `pipeline/${taskId.slice(0, 8)}`;

    // Get current branch (to verify we're on a base branch)
    const currentBranch = await this.getCurrentBranch(projectDir);
    if (!currentBranch) {
      console.warn(`[branch-manager] Cannot determine current branch in ${projectDir}`);
      return null;
    }

    // Create and checkout the task branch
    const proc = Bun.spawn(["git", "checkout", "-b", branchName], {
      cwd: projectDir,
      stdout: "pipe",
      stderr: "pipe",
    });

    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      // Branch might already exist (crash recovery) — try switching to it
      if (stderr.includes("already exists")) {
        const switchProc = Bun.spawn(["git", "checkout", branchName], {
          cwd: projectDir,
          stdout: "pipe",
          stderr: "pipe",
        });
        const switchExit = await switchProc.exited;
        if (switchExit !== 0) {
          console.error(`[branch-manager] Failed to switch to existing branch ${branchName}: ${await new Response(switchProc.stderr).text()}`);
          return null;
        }
      } else {
        console.error(`[branch-manager] Failed to create branch ${branchName}: ${stderr}`);
        return null;
      }
    }

    // Record lock
    await this.loadLocks();
    const lock: BranchLock = {
      projectDir,
      branch: branchName,
      taskId,
      acquiredAt: new Date().toISOString(),
      source,
    };
    this.locks.set(this.lockKey(projectDir, branchName), lock);
    await this.saveLocks();

    console.log(`[branch-manager] Checked out ${branchName} in ${projectDir} (task ${taskId.slice(0, 8)}...)`);
    return branchName;
  }

  // Release the branch lock and return to the base branch (main).
  async release(projectDir: string, taskId: string): Promise<void> {
    if (!projectDir) return;

    const branchName = `pipeline/${taskId.slice(0, 8)}`;

    // Switch back to main (or default branch)
    const baseBranch = await this.getBaseBranch(projectDir);
    const proc = Bun.spawn(["git", "checkout", baseBranch], {
      cwd: projectDir,
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      console.warn(`[branch-manager] Failed to checkout ${baseBranch} after release: ${stderr}`);
    }

    // Remove lock
    await this.loadLocks();
    this.locks.delete(this.lockKey(projectDir, branchName));
    await this.saveLocks();

    console.log(`[branch-manager] Released ${branchName}, returned to ${baseBranch} in ${projectDir}`);
  }

  // Check if current branch matches the expected task branch.
  // Used by wrapup guard to prevent committing on wrong branch.
  async verifyBranch(projectDir: string, taskId: string): Promise<boolean> {
    const expectedBranch = `pipeline/${taskId.slice(0, 8)}`;
    const currentBranch = await this.getCurrentBranch(projectDir);
    return currentBranch === expectedBranch;
  }

  // Clean up stale locks older than maxAgeMs (crash recovery on startup).
  // Returns number of stale locks removed.
  async cleanStale(maxAgeMs: number): Promise<number> {
    await this.loadLocks();
    const now = Date.now();
    let cleaned = 0;

    for (const [key, lock] of this.locks) {
      const age = now - new Date(lock.acquiredAt).getTime();
      if (age > maxAgeMs) {
        // Try to return to base branch if the stale branch is checked out
        const currentBranch = await this.getCurrentBranch(lock.projectDir);
        if (currentBranch === lock.branch) {
          const baseBranch = await this.getBaseBranch(lock.projectDir);
          const proc = Bun.spawn(["git", "checkout", baseBranch], {
            cwd: lock.projectDir,
            stdout: "pipe",
            stderr: "pipe",
          });
          await proc.exited;
        }

        this.locks.delete(key);
        cleaned++;
        console.log(`[branch-manager] Cleaned stale lock: ${lock.branch} in ${lock.projectDir} (age: ${Math.round(age / 60000)}min)`);
      }
    }

    if (cleaned > 0) {
      await this.saveLocks();
    }

    return cleaned;
  }

  // Get all active branch locks (for /branches Telegram command).
  async getActiveLocks(): Promise<BranchLock[]> {
    await this.loadLocks();
    return Array.from(this.locks.values());
  }

  // --- Git helpers ---

  private async getCurrentBranch(projectDir: string): Promise<string | null> {
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

  private async getBaseBranch(projectDir: string): Promise<string> {
    // Try common default branch names
    for (const candidate of ["main", "master"]) {
      const proc = Bun.spawn(["git", "rev-parse", "--verify", `refs/heads/${candidate}`], {
        cwd: projectDir,
        stdout: "pipe",
        stderr: "pipe",
      });
      const exitCode = await proc.exited;
      if (exitCode === 0) return candidate;
    }
    return "main"; // Fallback
  }
}
