// summary-dag.ts — DAG-structured hierarchical summarization over episodes
// Provides a tree of summaries at increasing depths for efficient context retrieval.
// Part of PAI Cloud Evolution Session 1.

import { Database } from "bun:sqlite";

export interface Summary {
  id: number;
  parentId: number | null;
  depth: number;
  content: string;
  sourceEpisodeIds: number[];
  tokenCount: number;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface CreateSummaryInput {
  parentId: number | null;
  depth: number;
  content: string;
  sourceEpisodeIds: number[];
  tokenCount: number;
  metadata?: Record<string, unknown>;
}

export interface DAGEpisode {
  id: number;
  timestamp: string;
  source: string;
  project: string | null;
  role: string;
  content: string;
  summary: string | null;
  importance: number;
  confidence: number;
}

export class SummaryDAG {
  private db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA busy_timeout=5000");
    this.initSchema();
  }

  private initSchema(): void {
    // Episodes table (same as MemoryStore — shared DB)
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
        metadata TEXT,
        importance INTEGER DEFAULT 5,
        access_count INTEGER DEFAULT 0,
        last_accessed TEXT
      )
    `);

    // Summaries table — the DAG nodes
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        parent_id INTEGER,
        depth INTEGER NOT NULL DEFAULT 0,
        content TEXT NOT NULL,
        source_episode_ids TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        metadata TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (parent_id) REFERENCES summaries(id)
      )
    `);

    // Indexes for summaries
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_summaries_parent ON summaries(parent_id)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_summaries_depth ON summaries(depth)");

    // Knowledge table (shared with MemoryStore)
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

    // FTS5 for episodes (same as MemoryStore)
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(
        content, summary,
        content=episodes,
        content_rowid=id
      )
    `);

    // Triggers to keep FTS in sync — INSERT and DELETE
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

    // FTS5 UPDATE trigger — fires when summary column changes
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS episodes_au AFTER UPDATE OF summary ON episodes BEGIN
        INSERT INTO episodes_fts(episodes_fts, rowid, content, summary) VALUES ('delete', old.id, old.content, old.summary);
        INSERT INTO episodes_fts(rowid, content, summary) VALUES (new.id, new.content, new.summary);
      END
    `);

    // Schema migration: add confidence column (idempotent)
    this.migrateSchema();
  }

  private migrateSchema(): void {
    const migrations = [
      "ALTER TABLE episodes ADD COLUMN importance INTEGER DEFAULT 5",
      "ALTER TABLE episodes ADD COLUMN access_count INTEGER DEFAULT 0",
      "ALTER TABLE episodes ADD COLUMN last_accessed TEXT",
      "ALTER TABLE episodes ADD COLUMN confidence REAL DEFAULT 1.0",
    ];
    for (const sql of migrations) {
      try {
        this.db.exec(sql);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("duplicate column")) {
          console.warn(`[summary-dag] Migration warning: ${msg}`);
        }
      }
    }
  }

  /** Record an episode (used when SummaryDAG owns the DB). */
  recordEpisode(ep: {
    timestamp: string;
    source: string;
    role: string;
    content: string;
    importance?: number;
    project?: string;
    summary?: string;
  }): number {
    const result = this.db
      .query(
        `INSERT INTO episodes (timestamp, source, project, role, content, summary, importance, confidence, access_count, last_accessed)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1.0, 0, ?)`
      )
      .run(
        ep.timestamp,
        ep.source,
        ep.project ?? null,
        ep.role,
        ep.content,
        ep.summary ?? null,
        ep.importance ?? 5,
        ep.timestamp
      );
    return Number(result.lastInsertRowid);
  }

  /** Get a single episode by ID. */
  getEpisode(id: number): DAGEpisode | null {
    const row = this.db
      .query("SELECT * FROM episodes WHERE id = ?")
      .get(id) as Record<string, unknown> | null;
    return row ? this.rowToEpisode(row) : null;
  }

  /** Create a summary node in the DAG. */
  create(input: CreateSummaryInput): number {
    const result = this.db
      .query(
        `INSERT INTO summaries (parent_id, depth, content, source_episode_ids, token_count, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.parentId,
        input.depth,
        input.content,
        JSON.stringify(input.sourceEpisodeIds),
        input.tokenCount,
        input.metadata ? JSON.stringify(input.metadata) : null,
        new Date().toISOString()
      );
    return Number(result.lastInsertRowid);
  }

  /** Get a summary by ID. */
  getById(id: number): Summary | null {
    const row = this.db
      .query("SELECT * FROM summaries WHERE id = ?")
      .get(id) as Record<string, unknown> | null;
    return row ? this.rowToSummary(row) : null;
  }

  /** Get child summaries of a parent. */
  getChildren(parentId: number): Summary[] {
    const rows = this.db
      .query("SELECT * FROM summaries WHERE parent_id = ? ORDER BY id ASC")
      .all(parentId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToSummary(r));
  }

  /** Get summaries at a specific depth. */
  getByDepth(depth: number): Summary[] {
    const rows = this.db
      .query("SELECT * FROM summaries WHERE depth = ? ORDER BY id ASC")
      .all(depth) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToSummary(r));
  }

  /** Expand a summary — return its source episodes. */
  expand(summaryId: number): DAGEpisode[] {
    const summary = this.getById(summaryId);
    if (!summary) return [];
    const placeholders = summary.sourceEpisodeIds.map(() => "?").join(",");
    if (placeholders.length === 0) return [];
    const rows = this.db
      .query(`SELECT * FROM episodes WHERE id IN (${placeholders}) ORDER BY id ASC`)
      .all(...summary.sourceEpisodeIds) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToEpisode(r));
  }

  /** Get IDs of the last N episodes (fresh tail — protected from summarization). */
  getFreshTailIds(n: number): number[] {
    const rows = this.db
      .query("SELECT id FROM episodes ORDER BY id DESC LIMIT ?")
      .all(n) as Array<{ id: number }>;
    return rows.map((r) => r.id).reverse();
  }

  /** Get episodes eligible for summarization (not in fresh tail). */
  getSummarizableSince(sinceId: number, freshTailSize: number): DAGEpisode[] {
    const freshTailIds = this.getFreshTailIds(freshTailSize);
    const minFreshId = freshTailIds.length > 0 ? Math.min(...freshTailIds) : Infinity;

    const rows = this.db
      .query("SELECT * FROM episodes WHERE id > ? AND id < ? ORDER BY id ASC")
      .all(sinceId, minFreshId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToEpisode(r));
  }

  /** Update the summary column on an episode (triggers FTS5 update). */
  updateEpisodeSummary(episodeId: number, summary: string): void {
    this.db
      .query("UPDATE episodes SET summary = ? WHERE id = ?")
      .run(summary, episodeId);
  }

  /** Search episodes via FTS5. */
  searchFTS(query: string): DAGEpisode[] {
    const ftsQuery = query.replace(/[^\w\s]/g, "").trim();
    if (!ftsQuery) return [];
    const rows = this.db
      .query(`
        SELECT e.*
        FROM episodes_fts
        INNER JOIN episodes e ON e.id = episodes_fts.rowid
        WHERE episodes_fts MATCH ?
        ORDER BY rank
        LIMIT 20
      `)
      .all(ftsQuery) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToEpisode(r));
  }

  /** Get total summary count. */
  getSummaryCount(): number {
    const row = this.db.query("SELECT COUNT(*) as cnt FROM summaries").get() as { cnt: number } | null;
    return row?.cnt ?? 0;
  }

  /** Get episode count. */
  getEpisodeCount(project?: string): number {
    if (project) {
      const row = this.db.query("SELECT COUNT(*) as cnt FROM episodes WHERE project = ?").get(project) as { cnt: number } | null;
      return row?.cnt ?? 0;
    }
    const row = this.db.query("SELECT COUNT(*) as cnt FROM episodes").get() as { cnt: number } | null;
    return row?.cnt ?? 0;
  }

  /** Get memory stats. */
  getStats(): { episodeCount: number; summaryCount: number; storageSizeBytes: number; hasVectorSearch: boolean } {
    const pageCount = (this.db.query("PRAGMA page_count").get() as { page_count: number } | null)?.page_count ?? 0;
    const pageSize = (this.db.query("PRAGMA page_size").get() as { page_size: number } | null)?.page_size ?? 4096;
    return {
      episodeCount: this.getEpisodeCount(),
      summaryCount: this.getSummaryCount(),
      storageSizeBytes: pageCount * pageSize,
      hasVectorSearch: false,
    };
  }

  /** Get knowledge entry. */
  getWhiteboard(project: string): string | null {
    const row = this.db
      .query("SELECT content FROM knowledge WHERE domain = 'whiteboard' AND key = ?")
      .get(project) as { content: string } | null;
    return row?.content ?? null;
  }

  /** Set whiteboard. */
  setWhiteboard(project: string, content: string): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO knowledge (domain, key, content, confidence, source_episode_ids)
         VALUES ('whiteboard', ?, ?, 0.9, '[]')`
      )
      .run(project, content);
  }

  /** Scored query for context retrieval. */
  scoredQuery(query: string, opts: { maxResults?: number; maxTokens?: number; project?: string } = {}): {
    episodes: DAGEpisode[];
    totalTokens: number;
  } {
    const maxResults = opts.maxResults ?? 10;
    const maxTokens = opts.maxTokens ?? 2000;

    const words = query.replace(/[^\w\s]/g, "").trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return { episodes: [], totalTokens: 0 };
    const ftsQuery = words.join(" OR ");

    const conditions: string[] = ["episodes_fts MATCH ?"];
    const bindings: (string | number)[] = [ftsQuery];

    if (opts.project) {
      conditions.push("e.project = ?");
      bindings.push(opts.project);
    }

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

    const now = Date.now();
    const scored = rows.map((row) => {
      const ep = this.rowToEpisode(row);
      const hoursSince = (now - new Date(ep.timestamp).getTime()) / 3_600_000;
      const recency = Math.pow(0.995, hoursSince);
      const importance = (ep.importance ?? 5) / 10;
      const rawRank = Math.abs((row.rank as number) ?? 0);
      const relevance = rawRank > 0 ? 1 / (1 + rawRank) : 0.5;
      const score = 0.4 * recency + 0.3 * importance + 0.3 * relevance;
      return { ep, score };
    });

    scored.sort((a, b) => b.score - a.score);

    const episodes: DAGEpisode[] = [];
    let totalTokens = 0;
    for (const { ep } of scored) {
      const tokenEstimate = Math.ceil(ep.content.length / 4);
      if (totalTokens + tokenEstimate > maxTokens && episodes.length > 0) break;
      episodes.push(ep);
      totalTokens += tokenEstimate;
      if (episodes.length >= maxResults) break;
    }

    return { episodes, totalTokens };
  }

  /** Close database. */
  close(): void {
    this.db.close();
  }

  private rowToSummary(row: Record<string, unknown>): Summary {
    return {
      id: row.id as number,
      parentId: (row.parent_id as number) ?? null,
      depth: row.depth as number,
      content: row.content as string,
      sourceEpisodeIds: JSON.parse(row.source_episode_ids as string),
      tokenCount: row.token_count as number,
      metadata: row.metadata ? JSON.parse(row.metadata as string) : null,
      createdAt: row.created_at as string,
    };
  }

  private rowToEpisode(row: Record<string, unknown>): DAGEpisode {
    return {
      id: row.id as number,
      timestamp: row.timestamp as string,
      source: row.source as string,
      project: (row.project as string) ?? null,
      role: row.role as string,
      content: row.content as string,
      summary: (row.summary as string) ?? null,
      importance: (row.importance as number) ?? 5,
      confidence: (row.confidence as number) ?? 1.0,
    };
  }
}
