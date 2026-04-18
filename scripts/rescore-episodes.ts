#!/usr/bin/env bun
// rescore-episodes.ts — batch rescorer for memory.db episodes (Move 3)
//
// Queries episodes whose metadata.scorer_version is missing or stale, calls
// HaikuScorer, and updates importance via rescoreEpisode(). Designed to run
// as a systemd timer every ~15 minutes.
//
// Usage:
//   rescore-episodes.ts [--limit N] [--dry-run] [--db PATH]
//
// Flags:
//   --limit N      Maximum episodes to process per run (default: 50)
//   --dry-run      Log what would be rescored, do not UPDATE
//   --db PATH      Override memory.db path (default: resolveDbPath())
//
// Fails open per-episode: a single bad episode does not abort the batch.
// Exit code 0 even if some episodes fail (progress is logged).

import { Database } from "bun:sqlite";
import { HaikuScorer } from "../src/hooks/haiku-scorer";
import {
  rescoreEpisode,
  SCORER_PROMPT_VERSION,
  type Scorer,
} from "../src/hooks/importance-scorer";
import { resolveDbPath } from "../src/hooks/memory-query";

export interface RescoreArgs {
  limit: number;
  dryRun: boolean;
  dbPath: string | null;
}

export interface UnscoredEpisode {
  id: number;
}

export function parseArgs(argv: string[]): RescoreArgs {
  let limit = 50;
  let dryRun = false;
  let dbPath: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--limit") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`--limit must be a positive integer, got: ${argv[i]}`);
      }
      limit = n;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--db") {
      dbPath = argv[++i] ?? null;
    } else if (arg === "-h" || arg === "--help") {
      console.log(
        "rescore-episodes.ts [--limit N] [--dry-run] [--db PATH]\n" +
          "  --limit N   Max episodes per run (default: 50)\n" +
          "  --dry-run   Skip UPDATE, just log\n" +
          "  --db PATH   Override memory.db path"
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { limit, dryRun, dbPath };
}

/**
 * Find episodes whose metadata.scorer_version is missing or does not match
 * the current SCORER_PROMPT_VERSION. Ordered oldest-first so backfill is stable.
 */
export function findUnscoredEpisodes(
  db: Database,
  version: string,
  limit: number
): UnscoredEpisode[] {
  const rows = db
    .query(
      `SELECT id FROM episodes
       WHERE metadata IS NULL
          OR json_extract(metadata, '$.scorer_version') IS NULL
          OR json_extract(metadata, '$.scorer_version') != ?
       ORDER BY id ASC
       LIMIT ?`
    )
    .all(version, limit) as UnscoredEpisode[];
  return rows;
}

export interface RescoreStats {
  seen: number;
  updated: number;
  skipped: number;
  failed: number;
}

export async function runRescore(
  dbPath: string,
  scorer: Scorer,
  args: { limit: number; dryRun: boolean },
  version: string = SCORER_PROMPT_VERSION
): Promise<RescoreStats> {
  const stats: RescoreStats = { seen: 0, updated: 0, skipped: 0, failed: 0 };
  const db = new Database(dbPath);
  try {
    const targets = findUnscoredEpisodes(db, version, args.limit);

    for (const row of targets) {
      stats.seen++;
      if (args.dryRun) {
        console.log(`[rescore] DRY episode ${row.id}`);
        stats.skipped++;
        continue;
      }
      try {
        const result = await rescoreEpisode(db, row.id, scorer, version);
        if (result.updated) {
          stats.updated++;
          console.log(`[rescore] episode ${row.id} → ${result.score}`);
        } else {
          stats.skipped++;
        }
      } catch (err) {
        stats.failed++;
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[rescore] episode ${row.id} failed: ${msg}`);
        // Fail open — continue with next episode.
      }
    }
  } finally {
    db.close();
  }

  return stats;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = args.dbPath ?? resolveDbPath();
  const scorer = new HaikuScorer();
  const stats = await runRescore(dbPath, scorer, {
    limit: args.limit,
    dryRun: args.dryRun,
  });
  console.log(
    `[rescore] done: seen=${stats.seen} updated=${stats.updated} skipped=${stats.skipped} failed=${stats.failed}`
  );
}

if (import.meta.main) {
  void main();
}
