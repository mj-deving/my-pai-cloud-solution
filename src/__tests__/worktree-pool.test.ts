// worktree-pool.test.ts — Tests for WorktreePool (git worktree management)
// All git operations are mocked via injected gitRunner — no real git commands.

import { describe, expect, it, mock, beforeEach } from "bun:test";
import {
  WorktreePool,
  type WorktreeSlot,
  type SprintContract,
  type AcquireOptions,
  type ReleaseOptions,
} from "../worktree-pool";
import type { Config } from "../config";

// Minimal config stub with worktree fields
function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    worktreeEnabled: true,
    worktreeMaxSlots: 3,
    ...overrides,
  } as Config;
}

type GitRunnerFn = (
  args: string[],
  cwd: string
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

function makeGitRunner(exitCode = 0, stdout = "", stderr = "") {
  return mock<GitRunnerFn>(() =>
    Promise.resolve({ stdout, stderr, exitCode })
  );
}

describe("WorktreePool", () => {
  // ── acquire ───────────────────────────────────────────────

  describe("acquire", () => {
    it("should acquire a slot and return slot info", async () => {
      const runner = makeGitRunner();
      const pool = new WorktreePool(makeConfig(), undefined, runner);

      const slot = await pool.acquire("/repo", { taskId: "abcd1234-5678" });

      expect(slot.taskId).toBe("abcd1234-5678");
      expect(slot.branch).toBe("wt-abcd1234");
      expect(slot.status).toBe("active");
      expect(slot.projectDir).toBe("/repo");
      expect(slot.worktreePath).toContain("/repo/.worktrees/");
      expect(slot.id).toBeTruthy();
      expect(slot.acquiredAt).toBeInstanceOf(Date);
      // Should have called git worktree add
      expect(runner).toHaveBeenCalledTimes(1);
      const callArgs = runner.mock.calls[0]!;
      expect(callArgs[0] as string[]).toContain("worktree");
      expect(callArgs[0] as string[]).toContain("add");
    });

    it("should reject when slot limit exceeded", async () => {
      const runner = makeGitRunner();
      const pool = new WorktreePool(makeConfig({ worktreeMaxSlots: 2 }), undefined, runner);

      await pool.acquire("/repo", { taskId: "task-1" });
      await pool.acquire("/repo", { taskId: "task-2" });

      await expect(pool.acquire("/repo", { taskId: "task-3" })).rejects.toThrow(
        /slot limit/i
      );
    });

    it("should generate correct branch name from taskId", async () => {
      const runner = makeGitRunner();
      const pool = new WorktreePool(makeConfig(), undefined, runner);

      const slot = await pool.acquire("/repo", {
        taskId: "deadbeef-cafe-1234",
      });

      expect(slot.branch).toBe("wt-deadbeef");
    });

    it("should create worktree at correct path", async () => {
      const runner = makeGitRunner();
      const pool = new WorktreePool(makeConfig(), undefined, runner);

      const slot = await pool.acquire("/my/project", { taskId: "abc12345" });

      expect(slot.worktreePath).toStartWith("/my/project/.worktrees/");
      // git worktree add <path> -b <branch>
      const args = runner.mock.calls[0]![0] as string[];
      expect(args[0]).toBe("worktree");
      expect(args[1]).toBe("add");
      expect(args[2]).toBe(slot.worktreePath);
      expect(args[3]).toBe("-b");
      expect(args[4]).toBe("wt-abc12345");
    });

    it("should reject duplicate taskId", async () => {
      const runner = makeGitRunner();
      const pool = new WorktreePool(makeConfig(), undefined, runner);

      await pool.acquire("/repo", { taskId: "same-task" });

      await expect(
        pool.acquire("/repo", { taskId: "same-task" })
      ).rejects.toThrow(/duplicate|already/i);
    });

    it("should use custom branch name when provided", async () => {
      const runner = makeGitRunner();
      const pool = new WorktreePool(makeConfig(), undefined, runner);

      const slot = await pool.acquire("/repo", {
        taskId: "custom-1234",
        branch: "feature/my-branch",
      });

      expect(slot.branch).toBe("feature/my-branch");
    });
  });

  // ── release ───────────────────────────────────────────────

  describe("release", () => {
    it("should release and remove slot from pool", async () => {
      const runner = makeGitRunner();
      const pool = new WorktreePool(makeConfig(), undefined, runner);

      const slot = await pool.acquire("/repo", { taskId: "rel-task" });
      runner.mockClear();

      await pool.release(slot.id);

      expect(pool.getStatus().active).toBe(0);
      // Should call: worktree remove + branch -D
      expect(runner).toHaveBeenCalledTimes(2);
    });

    it("should run git merge when merge option is set", async () => {
      const runner = makeGitRunner();
      const pool = new WorktreePool(makeConfig(), undefined, runner);

      const slot = await pool.acquire("/repo", { taskId: "merge-task" });
      runner.mockClear();

      await pool.release(slot.id, { merge: true });

      // Should call: merge + worktree remove + branch -D
      expect(runner).toHaveBeenCalledTimes(3);
      const mergeCall = runner.mock.calls[0]![0] as string[];
      expect(mergeCall[0]).toBe("merge");
      expect(mergeCall[1]).toBe(slot.branch);
    });

    it("should be no-op for non-existent slot", async () => {
      const runner = makeGitRunner();
      const pool = new WorktreePool(makeConfig(), undefined, runner);

      // Should not throw
      await pool.release("non-existent-id");
      expect(runner).not.toHaveBeenCalled();
    });

    it("should handle createPR option", async () => {
      const runner = makeGitRunner();
      const pool = new WorktreePool(makeConfig(), undefined, runner);

      const slot = await pool.acquire("/repo", { taskId: "pr-task" });
      runner.mockClear();

      // createPR skips merge but still removes worktree and branch
      await pool.release(slot.id, { createPR: true });

      // worktree remove + branch -D (no merge)
      expect(runner).toHaveBeenCalledTimes(2);
      // No merge call
      const allCalls = runner.mock.calls.map((c) => (c![0] as string[])[0]);
      expect(allCalls).not.toContain("merge");
    });
  });

  // ── validateContract ──────────────────────────────────────

  describe("validateContract", () => {
    it("should approve valid contract", () => {
      const pool = new WorktreePool(makeConfig(), undefined, makeGitRunner());

      const contract: SprintContract = {
        taskId: "t1",
        deliverables: ["Add authentication module"],
        verificationCriteria: ["Tests pass for auth"],
        estimatedFiles: 3,
        approved: false,
      };

      const result = pool.validateContract(contract, "Implement user authentication");
      expect(result.approved).toBe(true);
    });

    it("should reject contract with empty deliverables", () => {
      const pool = new WorktreePool(makeConfig(), undefined, makeGitRunner());

      const contract: SprintContract = {
        taskId: "t2",
        deliverables: [],
        verificationCriteria: ["Something"],
        estimatedFiles: 1,
        approved: false,
      };

      const result = pool.validateContract(contract, "Do stuff");
      expect(result.approved).toBe(false);
      expect(result.reason).toMatch(/deliverable/i);
    });

    it("should reject contract with empty verification criteria", () => {
      const pool = new WorktreePool(makeConfig(), undefined, makeGitRunner());

      const contract: SprintContract = {
        taskId: "t3",
        deliverables: ["Build feature"],
        verificationCriteria: [],
        estimatedFiles: 1,
        approved: false,
      };

      const result = pool.validateContract(contract, "Build feature");
      expect(result.approved).toBe(false);
      expect(result.reason).toMatch(/verification|criteria/i);
    });

    it("should reject contract with irrelevant deliverables", () => {
      const pool = new WorktreePool(makeConfig(), undefined, makeGitRunner());

      const contract: SprintContract = {
        taskId: "t4",
        deliverables: ["Update database schema for payments"],
        verificationCriteria: ["Schema migrations run"],
        estimatedFiles: 2,
        approved: false,
      };

      const result = pool.validateContract(
        contract,
        "Implement user authentication and login flow"
      );
      expect(result.approved).toBe(false);
      expect(result.reason).toMatch(/relevant|overlap/i);
    });
  });

  // ── cleanStale ────────────────────────────────────────────

  describe("cleanStale", () => {
    it("should detect and clean stale slots", async () => {
      const runner = makeGitRunner();
      // 100ms stale timeout for testing
      const pool = new WorktreePool(makeConfig(), 100, runner);

      await pool.acquire("/repo", { taskId: "stale-task" });
      runner.mockClear();

      // Wait for stale timeout
      await new Promise((r) => setTimeout(r, 150));

      const cleaned = await pool.cleanStale();
      expect(cleaned).toBe(1);
      expect(pool.getStatus().active).toBe(0);
    });

    it("should be no-op when no stale slots", async () => {
      const runner = makeGitRunner();
      // 10 second stale timeout — nothing will be stale
      const pool = new WorktreePool(makeConfig(), 10_000, runner);

      await pool.acquire("/repo", { taskId: "fresh-task" });
      runner.mockClear();

      const cleaned = await pool.cleanStale();
      expect(cleaned).toBe(0);
      expect(pool.getStatus().active).toBe(1);
    });
  });

  // ── getStatus ─────────────────────────────────────────────

  describe("getStatus", () => {
    it("should return correct counts", async () => {
      const runner = makeGitRunner();
      const pool = new WorktreePool(makeConfig({ worktreeMaxSlots: 5 }), 100, runner);

      // Empty pool
      expect(pool.getStatus()).toEqual({
        total: 5,
        active: 0,
        available: 5,
        stale: 0,
      });

      // Acquire 2 slots
      const s1 = await pool.acquire("/repo", { taskId: "status-1" });
      await pool.acquire("/repo", { taskId: "status-2" });

      expect(pool.getStatus()).toEqual({
        total: 5,
        active: 2,
        available: 3,
        stale: 0,
      });

      // Wait for stale
      await new Promise((r) => setTimeout(r, 150));

      const status = pool.getStatus();
      expect(status.stale).toBe(2);
      expect(status.active).toBe(2); // still counted as active until cleaned
    });
  });
});
