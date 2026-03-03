// memory.ts — V2-A: SQLite-backed episodic + semantic memory store
// Records Telegram messages, pipeline results, workflow outcomes.
// Queryable by keyword (FTS5) or semantic similarity (sqlite-vec when available).

import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Config } from "./config";
import type { EmbeddingProvider } from "./embeddings";
import type { Episode, Knowledge, MemoryQuery, MemoryResult } from "./schemas";

export class MemoryStore {
  private db: Database;
  private hasVec = false;
  private embeddings: EmbeddingProvider | null = null;
  private maxEpisodes: number;
  private decayLambda: number;

  constructor(dbPath: string, config: Config) {
    this.maxEpisodes = config.memoryMaxEpisodes;
    this.decayLambda = config.memoryDecayLambda;
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA busy_timeout=5000");
    this.initTables();
  }

  /** Wire embedding provider after construction (optional). */
  setEmbeddingProvider(provider: EmbeddingProvider): void {
    this.embeddings = provider;
    this.tryLoadVec();
  }

  private initTables(): void {
    // Episodes table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS episodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        source TEXT NOT NULL,
        project TEXT,
        session_id TEXT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        summary TEXT,
        metadata TEXT
      )
    `);

    // FTS5 index for keyword search
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(
        content, summary,
        content=episodes,
        content_rowid=id
      )
    `);

    // Triggers to keep FTS in sync
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS episodes_ai AFTER INSERT ON episodes BEGIN
        INSERT INTO episodes_fts(rowid, content, summary) VALUES (new.id, new.content, new.summary);
      END
    `);
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS episodes_ad AFTER DELETE ON episodes BEGIN
        INSERT INTO episodes_fts(episodes_fts, rowid, content, summary) VALUES ('delete', old.id, old.content, old.summary);
      END
    `);

    // Knowledge table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        domain TEXT NOT NULL,
        key TEXT NOT NULL,
        content TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.5,
        source_episode_ids TEXT,
        expires_at TEXT,
        UNIQUE(domain, key)
      )
    `);

    // Indexes
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_episodes_project ON episodes(project)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_episodes_source ON episodes(source)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_episodes_timestamp ON episodes(timestamp)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_knowledge_domain ON knowledge(domain)");
  }

  private tryLoadVec(): void {
    try {
      this.db.exec("SELECT vec_version()");
      this.hasVec = true;
      console.log("[memory] sqlite-vec available, enabling vector search");
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS episode_embeddings USING vec0(
          episode_id INTEGER PRIMARY KEY,
          embedding float[768]
        )
      `);
    } catch {
      this.hasVec = false;
      console.log("[memory] sqlite-vec not available, using keyword search fallback");
    }
  }

  /** Record an episode to memory. */
  async record(episode: Omit<Episode, "id">): Promise<number> {
    const metadataJson = episode.metadata ? JSON.stringify(episode.metadata) : null;
    const result = this.db
      .query(
        `INSERT INTO episodes (timestamp, source, project, session_id, role, content, summary, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        episode.timestamp,
        episode.source,
        episode.project ?? null,
        episode.session_id ?? null,
        episode.role,
        episode.content,
        episode.summary ?? null,
        metadataJson,
      );

    const episodeId = Number(result.lastInsertRowid);

    // Generate and store embedding if available
    if (this.embeddings?.isAvailable() && this.hasVec) {
      const text = episode.summary || episode.content.slice(0, 500);
      const vec = await this.embeddings.embed(text);
      if (vec) {
        try {
          this.db
            .query("INSERT INTO episode_embeddings (episode_id, embedding) VALUES (?, ?)")
            .run(episodeId, vec);
        } catch (err) {
          console.warn(`[memory] Failed to store embedding for episode ${episodeId}: ${err}`);
        }
      }
    }

    // Prune if over limit
    await this.pruneIfNeeded();

    return episodeId;
  }

  /** Query memory by keyword (FTS5) or semantic similarity. */
  async query(params: MemoryQuery): Promise<MemoryResult> {
    const maxResults = params.maxResults ?? 10;
    const maxTokens = params.maxTokens ?? 2000;
    const episodes: Episode[] = [];
    let totalTokens = 0;

    // Try semantic search first if available
    if (this.embeddings?.isAvailable() && this.hasVec) {
      const vec = await this.embeddings.embed(params.query);
      if (vec) {
        try {
          const rows = this.db
            .query(`
              SELECT e.*, distance
              FROM episode_embeddings ee
              INNER JOIN episodes e ON e.id = ee.episode_id
              WHERE ee.embedding MATCH ?
              ${params.project ? "AND e.project = ?" : ""}
              ${params.source ? "AND e.source = ?" : ""}
              ORDER BY distance
              LIMIT ?
            `)
            .all(
              ...[vec as unknown as string, ...(params.project ? [params.project] : []), ...(params.source ? [params.source] : []), maxResults * 2] as (string | number)[]
            ) as Array<Record<string, unknown>>;

          for (const row of rows) {
            const ep = this.rowToEpisode(row);
            const tokenEstimate = Math.ceil(ep.content.length / 4);
            if (totalTokens + tokenEstimate > maxTokens) break;
            episodes.push(ep);
            totalTokens += tokenEstimate;
          }

          if (episodes.length > 0) {
            return { episodes, knowledge: this.queryKnowledge(params.query), totalTokens };
          }
        } catch (err) {
          console.warn(`[memory] Vector search failed, falling back to FTS5: ${err}`);
        }
      }
    }

    // Fallback: FTS5 keyword search
    const ftsQuery = params.query.replace(/[^\w\s]/g, "").trim();
    if (!ftsQuery) {
      return { episodes: [], knowledge: [], totalTokens: 0 };
    }

    const conditions: string[] = ["episodes_fts MATCH ?"];
    const bindings: (string | number)[] = [ftsQuery];

    if (params.project) {
      conditions.push("e.project = ?");
      bindings.push(params.project);
    }
    if (params.source) {
      conditions.push("e.source = ?");
      bindings.push(params.source);
    }

    bindings.push(maxResults * 2);

    const rows = this.db
      .query(`
        SELECT e.*, rank
        FROM episodes_fts
        INNER JOIN episodes e ON e.id = episodes_fts.rowid
        WHERE ${conditions.join(" AND ")}
        ORDER BY rank
        LIMIT ?
      `)
      .all(...bindings) as Array<Record<string, unknown>>;

    for (const row of rows) {
      const ep = this.rowToEpisode(row);
      const tokenEstimate = Math.ceil(ep.content.length / 4);
      if (totalTokens + tokenEstimate > maxTokens) break;
      episodes.push(ep);
      totalTokens += tokenEstimate;
    }

    return { episodes, knowledge: this.queryKnowledge(params.query), totalTokens };
  }

  /** Distill recent episodes into knowledge entries. */
  async distill(domain: string, key: string, content: string, sourceEpisodeIds: number[], confidence = 0.7): Promise<void> {
    this.db
      .query(
        `INSERT OR REPLACE INTO knowledge (domain, key, content, confidence, source_episode_ids)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(domain, key, content, confidence, JSON.stringify(sourceEpisodeIds));
  }

  /** Get memory stats for dashboard. */
  getStats(): { episodeCount: number; knowledgeCount: number; storageSizeBytes: number; hasVectorSearch: boolean; hasEmbeddings: boolean } {
    const epRow = this.db.query("SELECT COUNT(*) as cnt FROM episodes").get() as { cnt: number } | null;
    const knRow = this.db.query("SELECT COUNT(*) as cnt FROM knowledge").get() as { cnt: number } | null;

    // Estimate storage size from page count
    const pageCount = (this.db.query("PRAGMA page_count").get() as { page_count: number } | null)?.page_count ?? 0;
    const pageSize = (this.db.query("PRAGMA page_size").get() as { page_size: number } | null)?.page_size ?? 4096;

    return {
      episodeCount: epRow?.cnt ?? 0,
      knowledgeCount: knRow?.cnt ?? 0,
      storageSizeBytes: pageCount * pageSize,
      hasVectorSearch: this.hasVec,
      hasEmbeddings: this.embeddings?.isAvailable() ?? false,
    };
  }

  /** Get the last episode ID (for handoff sync pointer). */
  getLastEpisodeId(): number {
    const row = this.db.query("SELECT MAX(id) as maxId FROM episodes").get() as { maxId: number | null } | null;
    return row?.maxId ?? 0;
  }

  /** Prune oldest episodes when over limit. */
  private async pruneIfNeeded(): Promise<void> {
    const count = (this.db.query("SELECT COUNT(*) as cnt FROM episodes").get() as { cnt: number })?.cnt ?? 0;
    if (count <= this.maxEpisodes) return;

    const excess = count - this.maxEpisodes;
    this.db.exec(`DELETE FROM episodes WHERE id IN (SELECT id FROM episodes ORDER BY timestamp ASC LIMIT ${excess})`);
    console.log(`[memory] Pruned ${excess} old episodes (limit: ${this.maxEpisodes})`);
  }

  private queryKnowledge(query: string): Knowledge[] {
    const keywords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    if (keywords.length === 0) return [];

    const conditions = keywords.map(() => "(domain LIKE ? OR key LIKE ? OR content LIKE ?)");
    const bindings = keywords.flatMap(k => [`%${k}%`, `%${k}%`, `%${k}%`]);

    try {
      const rows = this.db
        .query(`SELECT * FROM knowledge WHERE ${conditions.join(" OR ")} LIMIT 5`)
        .all(...bindings) as Array<Record<string, unknown>>;

      return rows.map(row => ({
        id: row.id as number,
        domain: row.domain as string,
        key: row.key as string,
        content: row.content as string,
        confidence: row.confidence as number,
        source_episode_ids: row.source_episode_ids ? JSON.parse(row.source_episode_ids as string) : undefined,
        expires_at: (row.expires_at as string) ?? undefined,
      }));
    } catch {
      return [];
    }
  }

  private rowToEpisode(row: Record<string, unknown>): Episode {
    return {
      id: row.id as number,
      timestamp: row.timestamp as string,
      source: row.source as Episode["source"],
      project: (row.project as string) ?? undefined,
      session_id: (row.session_id as string) ?? undefined,
      role: row.role as Episode["role"],
      content: row.content as string,
      summary: (row.summary as string) ?? undefined,
      metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined,
    };
  }

  /** Get episodes since a given ID (for synthesis). */
  getEpisodesSince(sinceId: number, limit = 100): Episode[] {
    const rows = this.db
      .query("SELECT * FROM episodes WHERE id > ? ORDER BY id ASC LIMIT ?")
      .all(sinceId, limit) as Array<Record<string, unknown>>;
    return rows.map(row => this.rowToEpisode(row));
  }

  /** Get knowledge entries by domain (for synthesis dedup). */
  getKnowledgeByDomain(domain: string): Array<{ key: string; content: string; confidence: number }> {
    const rows = this.db
      .query("SELECT key, content, confidence FROM knowledge WHERE domain = ?")
      .all(domain) as Array<Record<string, unknown>>;
    return rows.map(row => ({
      key: row.key as string,
      content: row.content as string,
      confidence: row.confidence as number,
    }));
  }

  /** Close the database connection. */
  close(): void {
    this.embeddings?.stop();
    this.db.close();
    console.log("[memory] Store closed");
  }
}
