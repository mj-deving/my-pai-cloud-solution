// idempotency.ts — SQLite-backed idempotency store for pipeline deduplication
// Prevents duplicate task dispatch by tracking processed operations via sha256 op_id.

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

export class IdempotencyStore {
  private db: Database;
  private duplicateHitCount = 0;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA busy_timeout=5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS processed_ops (
        op_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        status TEXT NOT NULL,
        result_path TEXT,
        processed_at TEXT NOT NULL,
        expires_at TEXT
      )
    `);
  }

  /**
   * Check if an operation has already been processed.
   */
  isDuplicate(opId: string): boolean {
    const row = this.db
      .query("SELECT op_id FROM processed_ops WHERE op_id = ?")
      .get(opId);
    const dup = row !== null;
    if (dup) this.duplicateHitCount++;
    return dup;
  }

  /**
   * Dashboard-friendly stats.
   */
  stats(): { totalOps: number; recentOps: number; duplicatesBlocked: number } {
    const totalRow = this.db
      .query("SELECT COUNT(*) as cnt FROM processed_ops")
      .get() as { cnt: number } | null;
    const recentRow = this.db
      .query("SELECT COUNT(*) as cnt FROM processed_ops WHERE processed_at > ?")
      .get(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()) as { cnt: number } | null;
    return {
      totalOps: totalRow?.cnt ?? 0,
      recentOps: recentRow?.cnt ?? 0,
      duplicatesBlocked: this.duplicateHitCount,
    };
  }

  /**
   * Record a completed operation.
   */
  record(
    opId: string,
    taskId: string,
    status: string,
    resultPath?: string,
  ): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO processed_ops (op_id, task_id, status, result_path, processed_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        opId,
        taskId,
        status,
        resultPath || null,
        new Date().toISOString(),
        // Expire after 7 days
        new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      );
  }

  /**
   * Generate a deterministic op_id from a prompt string using sha256.
   */
  static generateOpId(prompt: string): string {
    const normalized = prompt.trim().replace(/\s+/g, " ");
    return createHash("sha256").update(normalized).digest("hex");
  }

  /**
   * Clean up expired entries.
   */
  cleanup(): number {
    const result = this.db
      .query("DELETE FROM processed_ops WHERE expires_at < ?")
      .run(new Date().toISOString());
    return result.changes;
  }

  close(): void {
    this.db.close();
  }
}
