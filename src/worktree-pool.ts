// worktree-pool.ts — Git worktree pool for parallel task isolation
// Sprint contracts validate agent work before execution (Anthropic harness pattern).

import type { Config } from "./config";

// ── Types ───────────────────────────────────────────────────

export interface WorktreeSlot {
  id: string;
  taskId: string;
  projectDir: string;
  worktreePath: string;
  branch: string;
  acquiredAt: Date;
  status: "active" | "releasing" | "stale";
}

export interface SprintContract {
  taskId: string;
  deliverables: string[];
  verificationCriteria: string[];
  estimatedFiles: number;
  approved: boolean;
}

export interface AcquireOptions {
  taskId: string;
  branch?: string;
}

export interface ReleaseOptions {
  merge?: boolean;
  createPR?: boolean;
}

type GitRunner = (
  args: string[],
  cwd: string
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

// ── WorktreePool ────────────────────────────────────────────

const DEFAULT_STALE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

export class WorktreePool {
  private slots: Map<string, WorktreeSlot> = new Map();
  private maxSlots: number;
  private staleTimeoutMs: number;
  private git: GitRunner;

  constructor(
    config: Config,
    staleTimeoutMs?: number,
    gitRunner?: GitRunner
  ) {
    this.maxSlots = config.worktreeMaxSlots;
    this.staleTimeoutMs = staleTimeoutMs ?? DEFAULT_STALE_TIMEOUT_MS;
    this.git = gitRunner ?? this.defaultGitRunner;
  }

  // ── Public API ──────────────────────────────────────────

  /**
   * Acquire a worktree slot for a task.
   * Creates a new git worktree branch at {projectDir}/.worktrees/{slotId}.
   */
  async acquire(
    projectDir: string,
    options: AcquireOptions
  ): Promise<WorktreeSlot> {
    // Check for duplicate taskId
    for (const slot of this.slots.values()) {
      if (slot.taskId === options.taskId) {
        throw new Error(
          `Duplicate taskId: "${options.taskId}" already has an active worktree slot`
        );
      }
    }

    // Check slot availability
    if (this.slots.size >= this.maxSlots) {
      throw new Error(
        `Worktree slot limit reached (${this.maxSlots}). Release a slot before acquiring a new one.`
      );
    }

    const slotId = generateId();
    const branch = options.branch ?? `wt-${options.taskId.slice(0, 8)}`;
    const worktreePath = `${projectDir}/.worktrees/${slotId}`;

    // Create worktree: git worktree add <path> -b <branch>
    const result = await this.git(
      ["worktree", "add", worktreePath, "-b", branch],
      projectDir
    );

    if (result.exitCode !== 0) {
      throw new Error(
        `git worktree add failed (exit ${result.exitCode}): ${result.stderr}`
      );
    }

    const slot: WorktreeSlot = {
      id: slotId,
      taskId: options.taskId,
      projectDir,
      worktreePath,
      branch,
      acquiredAt: new Date(),
      status: "active",
    };

    this.slots.set(slotId, slot);
    return slot;
  }

  /**
   * Release a worktree slot, optionally merging or creating a PR.
   * No-op if slotId not found.
   */
  async release(slotId: string, options?: ReleaseOptions): Promise<void> {
    const slot = this.slots.get(slotId);
    if (!slot) return;

    slot.status = "releasing";

    // If merge requested, merge worktree branch back to source
    if (options?.merge) {
      const mergeResult = await this.git(
        ["merge", slot.branch],
        slot.projectDir
      );
      if (mergeResult.exitCode !== 0) {
        // Restore status and throw — caller decides what to do
        slot.status = "active";
        throw new Error(
          `git merge ${slot.branch} failed (exit ${mergeResult.exitCode}): ${mergeResult.stderr}`
        );
      }
    }

    // Remove the worktree directory
    const removeResult = await this.git(
      ["worktree", "remove", slot.worktreePath],
      slot.projectDir
    );

    if (removeResult.exitCode !== 0) {
      // Force remove on failure
      const forceResult = await this.git(
        ["worktree", "remove", "--force", slot.worktreePath],
        slot.projectDir
      );
      if (forceResult.exitCode !== 0) {
        // Worktree removal failed — don't drop the slot, keep tracking it
        slot.status = "active";
        console.error(`[worktree-pool] Failed to remove worktree ${slot.worktreePath}: ${forceResult.stderr}`);
        throw new Error(`Failed to remove worktree: ${forceResult.stderr}`);
      }
    }

    // If createPR requested, preserve the branch (don't delete it)
    if (options?.createPR) {
      // Push branch for PR creation — branch must survive for the PR
      await this.git(["push", "-u", "origin", slot.branch], slot.projectDir);
      console.log(`[worktree-pool] Branch ${slot.branch} pushed for PR creation`);
    } else {
      // Delete the branch (no PR needed)
      await this.git(["branch", "-D", slot.branch], slot.projectDir);
    }

    this.slots.delete(slotId);
  }

  /**
   * Validate a sprint contract against the step specification.
   * Pure logic — no LLM calls. Checks structure + keyword relevance.
   */
  validateContract(
    contract: SprintContract,
    stepSpec: string
  ): { approved: boolean; reason: string } {
    // Must have at least one deliverable
    if (!contract.deliverables.length) {
      return {
        approved: false,
        reason: "Contract must have at least one deliverable.",
      };
    }

    // Must have at least one verification criterion
    if (!contract.verificationCriteria.length) {
      return {
        approved: false,
        reason: "Contract must have at least one verification criterion.",
      };
    }

    // Check keyword overlap between deliverables and step spec
    const specWords = extractKeywords(stepSpec);
    const deliverableWords = extractKeywords(contract.deliverables.join(" "));

    const overlap = [...specWords].filter((w) => deliverableWords.has(w));
    if (overlap.length === 0) {
      return {
        approved: false,
        reason:
          "Deliverables have no keyword overlap with step specification. Ensure deliverables are relevant to the task.",
      };
    }

    return { approved: true, reason: "Contract approved." };
  }

  /**
   * Detect and clean stale worktrees (older than staleTimeoutMs).
   * Stale slots are released without merge.
   */
  async cleanStale(): Promise<number> {
    const now = Date.now();
    const staleIds: string[] = [];

    for (const [id, slot] of this.slots) {
      if (
        slot.status === "active" &&
        now - slot.acquiredAt.getTime() > this.staleTimeoutMs
      ) {
        staleIds.push(id);
      }
    }

    for (const id of staleIds) {
      await this.release(id);
    }

    return staleIds.length;
  }

  /**
   * Get current pool status: totals, active count, available, stale count.
   */
  getStatus(): {
    total: number;
    active: number;
    available: number;
    stale: number;
  } {
    const now = Date.now();
    let stale = 0;

    for (const slot of this.slots.values()) {
      if (
        slot.status === "active" &&
        now - slot.acquiredAt.getTime() > this.staleTimeoutMs
      ) {
        stale++;
      }
    }

    const active = this.slots.size;
    return {
      total: this.maxSlots,
      active,
      available: this.maxSlots - active,
      stale,
    };
  }

  // ── Internal ────────────────────────────────────────────

  /**
   * Default git runner using Bun.spawn. Used when no gitRunner injected.
   */
  private async defaultGitRunner(
    args: string[],
    cwd: string
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const proc = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    const exitCode = await proc.exited;
    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
  }
}

// ── Helpers ─────────────────────────────────────────────────

/** Generate a unique slot ID. */
function generateId(): string {
  return crypto.randomUUID();
}

/** Extract meaningful keywords (3+ chars, lowercased) from text. */
function extractKeywords(text: string): Set<string> {
  const stopWords = new Set([
    "the", "and", "for", "with", "that", "this", "from", "are", "was",
    "will", "have", "has", "been", "not", "but", "all", "can", "had",
    "her", "his", "one", "our", "out", "its", "than", "then", "them",
  ]);

  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !stopWords.has(w));

  return new Set(words);
}
