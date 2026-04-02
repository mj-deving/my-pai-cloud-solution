// standalone/dashboard/db-reader.ts — Read-only SQLite access for memory.db
// Opens in read-only mode with WAL compatibility and busy_timeout.

import { Database } from "bun:sqlite";

export class DbReader {
  private db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { readonly: true });
    this.db.exec("PRAGMA busy_timeout = 5000");
  }

  getMemoryStats(): Record<string, unknown> {
    try {
      const episodes = this.db.query("SELECT count(*) as n FROM episodes").get() as { n: number } | null;
      const knowledge = this.safeCount("knowledge");
      const pageCount = this.db.query("PRAGMA page_count").get() as { page_count: number } | null;
      const pageSize = this.db.query("PRAGMA page_size").get() as { page_size: number } | null;
      const storageBytes = (pageCount?.page_count ?? 0) * (pageSize?.page_size ?? 4096);

      return {
        enabled: true,
        episodeCount: episodes?.n ?? 0,
        knowledgeCount: knowledge,
        storageBytes,
        vectorSearchEnabled: false,
      };
    } catch (err) {
      return { enabled: true, error: String(err) };
    }
  }

  getDagStats(): Record<string, unknown> {
    try {
      const episodes = this.db.query("SELECT count(*) as n FROM episodes").get() as { n: number } | null;
      const summaries = this.safeCount("summaries");
      return {
        enabled: true,
        episodeCount: episodes?.n ?? 0,
        summaryCount: summaries,
      };
    } catch (err) {
      return { enabled: true, error: String(err) };
    }
  }

  close(): void {
    this.db.close();
  }

  private safeCount(table: string): number {
    try {
      const row = this.db.query(`SELECT count(*) as n FROM ${table}`).get() as { n: number } | null;
      return row?.n ?? 0;
    } catch {
      return 0; // Table may not exist
    }
  }
}
