// memory-query.ts — Shared memory query library for Claude Code hooks
// Extracts core scoring/query logic from ContextBuilder for standalone use.
// Used by: user-prompt-submit.ts, session-start.ts, and the bridge itself.

import { Database } from "bun:sqlite";

export interface MemoryQueryOptions {
  dbPath: string;
  maxResults?: number;  // default 10
  maxChars?: number;    // default 5000
  project?: string;
}

export interface ScoredEpisode {
  id: number;
  content: string;
  summary: string | null;
  importance: number;
  score: number;
  source: string;
  timestamp: string;
}

/**
 * Resolve memory.db path from environment.
 * Checks: MEMORY_DB_PATH env var, then fallback to standard location.
 */
export function resolveDbPath(): string {
  if (process.env.MEMORY_DB_PATH) {
    return process.env.MEMORY_DB_PATH;
  }
  const home = process.env.HOME || "/home/isidore_cloud";
  return `${home}/projects/my-pai-cloud-solution/data/memory.db`;
}

/**
 * Query memory.db for relevant context given a user message.
 * Uses FTS5 search with OR semantics, scores by importance * recency * relevance.
 */
export function queryMemory(message: string, options: MemoryQueryOptions): ScoredEpisode[] {
  const maxResults = options.maxResults ?? 10;
  const maxChars = options.maxChars ?? 5000;

  // Extract search words (skip short words, strip punctuation)
  const words = message
    .replace(/[^\w\s]/g, "")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 3);

  const db = new Database(options.dbPath, { readonly: true });

  try {
    // Check if FTS5 table exists
    const hasFts = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='episodes_fts'")
      .get() !== null;

    let rows: Array<Record<string, unknown>>;

    // No search words — fall back to recency-only query (used by session-start hook)
    if (words.length === 0) {
      const conditions: string[] = [];
      const bindings: (string | number)[] = [];
      if (options.project) {
        conditions.push("project = ?");
        bindings.push(options.project);
      }
      bindings.push(maxResults * 3);
      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      rows = db
        .query(
          `SELECT *, 0 as rank FROM episodes ${where}
           ORDER BY datetime(timestamp) DESC
           LIMIT ?`,
        )
        .all(...bindings) as Array<Record<string, unknown>>;
    } else if (hasFts) {
      // FTS5 search with OR semantics for partial matches
      const ftsQuery = words.join(" OR ");
      const conditions: string[] = ["episodes_fts MATCH ?"];
      const bindings: (string | number)[] = [ftsQuery];

      if (options.project) {
        conditions.push("e.project = ?");
        bindings.push(options.project);
      }

      bindings.push(maxResults * 3);

      rows = db
        .query(
          `SELECT e.*, rank
           FROM episodes_fts
           INNER JOIN episodes e ON e.id = episodes_fts.rowid
           WHERE ${conditions.join(" AND ")}
           ORDER BY rank
           LIMIT ?`
        )
        .all(...bindings) as Array<Record<string, unknown>>;
    } else {
      // Fallback: LIKE search
      const likeConditions = words.map(() => "(content LIKE ? OR summary LIKE ?)");
      const likeBindings: (string | number)[] = words.flatMap((w) => [`%${w}%`, `%${w}%`]);

      if (options.project) {
        likeConditions.push("project = ?");
        likeBindings.push(options.project);
      }

      likeBindings.push(maxResults * 3);

      rows = db
        .query(
          `SELECT *, 0 as rank FROM episodes
           WHERE ${likeConditions.join(" AND ")}
           ORDER BY timestamp DESC
           LIMIT ?`
        )
        .all(...likeBindings) as Array<Record<string, unknown>>;
    }

    // Score: 0.4*recency + 0.3*importance/10 + 0.3*relevance
    const now = Date.now();
    const scored: ScoredEpisode[] = rows.map((row) => {
      const hoursSince = (now - new Date(row.timestamp as string).getTime()) / 3_600_000;
      const recency = Math.pow(0.995, Math.max(0, hoursSince));
      const importance = ((row.importance as number) ?? 5) / 10;
      const rawRank = Math.abs((row.rank as number) ?? 0);
      const relevance = rawRank > 0 ? 1 / (1 + rawRank) : 0.5;
      const score = 0.4 * recency + 0.3 * importance + 0.3 * relevance;

      return {
        id: row.id as number,
        content: row.content as string,
        summary: (row.summary as string) ?? null,
        importance: (row.importance as number) ?? 5,
        score,
        source: row.source as string,
        timestamp: row.timestamp as string,
      };
    });

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    // Limit by maxResults and maxChars
    const result: ScoredEpisode[] = [];
    let totalChars = 0;

    for (const ep of scored) {
      const text = ep.summary || ep.content;
      if (totalChars + text.length > maxChars && result.length > 0) break;
      result.push(ep);
      totalChars += text.length;
      if (result.length >= maxResults) break;
    }

    return result;
  } finally {
    db.close();
  }
}

/**
 * Format scored episodes into a context string for injection.
 */
export function formatContext(episodes: ScoredEpisode[]): string {
  if (episodes.length === 0) return "";

  const lines: string[] = ["[Memory Context]", ""];

  for (const ep of episodes) {
    const time = ep.timestamp.slice(0, 16).replace("T", " ");
    const text = ep.importance >= 7
      ? (ep.summary || ep.content.slice(0, 200))
      : (ep.summary || ep.content.slice(0, 80));
    lines.push(`- [${time} ${ep.source}] ${text}`);
  }

  lines.push("", `[${episodes.length} episodes from memory]`);

  return lines.join("\n");
}
