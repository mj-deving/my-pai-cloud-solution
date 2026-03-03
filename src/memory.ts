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

    // Schema migration: add importance, access_count, last_accessed columns (idempotent)
    this.migrateSchema();
  }

  private migrateSchema(): void {
    const migrations = [
      "ALTER TABLE episodes ADD COLUMN importance INTEGER DEFAULT 5",
      "ALTER TABLE episodes ADD COLUMN access_count INTEGER DEFAULT 0",
      "ALTER TABLE episodes ADD COLUMN last_accessed TEXT",
    ];
    for (const sql of migrations) {
      try {
        this.db.exec(sql);
      } catch (err) {
        // "duplicate column name" means migration already applied — safe to ignore
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("duplicate column")) {
          console.warn(`[memory] Migration warning: ${msg}`);
        }
      }
    }
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
    const importance = episode.importance ?? 5;
    const result = this.db
      .query(
        `INSERT INTO episodes (timestamp, source, project, session_id, role, content, summary, metadata, importance, access_count, last_accessed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
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
        importance,
        episode.timestamp,
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

    // Track access on returned episodes
    this.trackAccess(episodes);

    return { episodes, knowledge: this.queryKnowledge(params.query), totalTokens };
  }

  /** Scored query: ranks by recency, importance, and FTS5 relevance. */
  async scoredQuery(params: MemoryQuery): Promise<MemoryResult> {
    const maxResults = params.maxResults ?? 10;
    const maxTokens = params.maxTokens ?? 2000;

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

    // Fetch more than needed so we can re-rank
    bindings.push(maxResults * 3);

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

    // Score and sort: 0.4*recency + 0.3*importance/10 + 0.3*relevance
    const now = Date.now();
    const scored = rows.map(row => {
      const ep = this.rowToEpisode(row);
      const hoursSince = (now - new Date(ep.timestamp).getTime()) / 3_600_000;
      const recency = Math.pow(0.995, hoursSince);
      const importance = ((row.importance as number) ?? 5) / 10;
      // FTS5 rank is negative (more negative = better match), normalize to 0-1
      const rawRank = Math.abs((row.rank as number) ?? 0);
      const relevance = rawRank > 0 ? 1 / (1 + rawRank) : 0.5;
      const score = 0.4 * recency + 0.3 * importance + 0.3 * relevance;
      return { ep, score, row };
    });

    scored.sort((a, b) => b.score - a.score);

    const episodes: Episode[] = [];
    let totalTokens = 0;
    for (const { ep } of scored) {
      const tokenEstimate = Math.ceil(ep.content.length / 4);
      if (totalTokens + tokenEstimate > maxTokens && episodes.length > 0) break;
      episodes.push(ep);
      totalTokens += tokenEstimate;
      if (episodes.length >= maxResults) break;
    }

    this.trackAccess(episodes);

    return { episodes, knowledge: this.queryKnowledge(params.query), totalTokens };
  }

  /** Track access: increment access_count and update last_accessed for episodes. */
  private trackAccess(episodes: Episode[]): void {
    if (episodes.length === 0) return;
    const now = new Date().toISOString();
    const stmt = this.db.query(
      "UPDATE episodes SET access_count = access_count + 1, last_accessed = ? WHERE id = ?"
    );
    for (const ep of episodes) {
      if (ep.id) {
        try { stmt.run(now, ep.id); } catch { /* non-critical */ }
      }
    }
  }

  /** Get the most recent session summary episode. */
  getLatestSessionSummary(project?: string): Episode | null {
    const conditions = ["source = 'session_summary'"];
    const bindings: string[] = [];
    if (project) {
      conditions.push("project = ?");
      bindings.push(project);
    }
    const row = this.db
      .query(`SELECT * FROM episodes WHERE ${conditions.join(" AND ")} ORDER BY timestamp DESC LIMIT 1`)
      .get(...bindings) as Record<string, unknown> | null;
    return row ? this.rowToEpisode(row) : null;
  }

  /** Get system state from knowledge table. */
  getSystemState(key: string): string | null {
    const row = this.db
      .query("SELECT content FROM knowledge WHERE domain = 'system' AND key = ?")
      .get(key) as { content: string } | null;
    return row?.content ?? null;
  }

  /** Set system state in knowledge table. */
  setSystemState(key: string, value: string): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO knowledge (domain, key, content, confidence, source_episode_ids)
         VALUES ('system', ?, ?, 1.0, '[]')`
      )
      .run(key, value);
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

  /** Prune episodes by importance * recency score. Never prune importance >= 8. */
  private async pruneIfNeeded(): Promise<void> {
    const count = (this.db.query("SELECT COUNT(*) as cnt FROM episodes").get() as { cnt: number })?.cnt ?? 0;
    if (count <= this.maxEpisodes) return;

    const excess = count - this.maxEpisodes;
    // Delete lowest-scoring episodes, but never those with importance >= 8
    // Score = importance * recency_factor where recency_factor = 0.995^hours_since_creation
    // SQLite doesn't have pow(), so we approximate: lower timestamp = lower score
    // We sort by (importance * 1.0 / 10) * (julianday(timestamp) - julianday('2026-01-01')) ASC
    // This keeps high-importance and recent episodes, prunes low-importance old ones
    this.db.exec(`
      DELETE FROM episodes WHERE id IN (
        SELECT id FROM episodes
        WHERE importance < 8 OR importance IS NULL
        ORDER BY (COALESCE(importance, 5) * 1.0) * (julianday(timestamp) - julianday('2026-01-01')) ASC
        LIMIT ${excess}
      )
    `);
    console.log(`[memory] Pruned ${excess} low-value episodes (limit: ${this.maxEpisodes})`);
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
      importance: (row.importance as number) ?? 5,
      access_count: (row.access_count as number) ?? 0,
      last_accessed: (row.last_accessed as string) ?? undefined,
    };
  }

  /** Get episodes since a given ID (for synthesis). */
  getEpisodesSince(sinceId: number, limit = 100): Episode[] {
    const rows = this.db
      .query("SELECT * FROM episodes WHERE id > ? ORDER BY id ASC LIMIT ?")
      .all(sinceId, limit) as Array<Record<string, unknown>>;
    return rows.map(row => this.rowToEpisode(row));
  }

  /** Get whiteboard entry for a project. Returns content or null. */
  getWhiteboard(project: string): string | null {
    const row = this.db
      .query("SELECT content FROM knowledge WHERE domain = 'whiteboard' AND key = ?")
      .get(project) as { content: string } | null;
    return row?.content ?? null;
  }

  /** Upsert whiteboard entry for a project. */
  setWhiteboard(project: string, content: string): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO knowledge (domain, key, content, confidence, source_episode_ids)
         VALUES ('whiteboard', ?, ?, 0.9, '[]')`
      )
      .run(project, content);
  }

  /** Get distinct non-null project names from episodes since a given ID. */
  getRecentProjectNames(sinceId: number): string[] {
    const rows = this.db
      .query("SELECT DISTINCT project FROM episodes WHERE id > ? AND project IS NOT NULL ORDER BY project")
      .all(sinceId) as Array<{ project: string }>;
    return rows.map(row => row.project);
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
