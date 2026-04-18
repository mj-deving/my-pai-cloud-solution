import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseArgs,
  findUnscoredEpisodes,
  runRescore,
} from "../../scripts/rescore-episodes";
import { SCORER_PROMPT_VERSION, type Scorer } from "../hooks/importance-scorer";

function initSchema(db: Database): void {
  db.exec(`
    CREATE TABLE episodes (
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
}

function seed(db: Database, content: string, importance: number, metadata: string | null): number {
  const r = db
    .query(
      "INSERT INTO episodes (timestamp, source, role, content, importance, metadata) VALUES (?, 'channels', 'assistant', ?, ?, ?)"
    )
    .run(new Date().toISOString(), content, importance, metadata);
  return Number(r.lastInsertRowid);
}

describe("rescore-episodes — parseArgs", () => {
  test("defaults to limit=50, dryRun=false, dbPath=null", () => {
    const args = parseArgs([]);
    expect(args.limit).toBe(50);
    expect(args.dryRun).toBe(false);
    expect(args.dbPath).toBeNull();
  });

  test("parses --limit, --dry-run, --db", () => {
    const args = parseArgs(["--limit", "10", "--dry-run", "--db", "/tmp/foo.db"]);
    expect(args.limit).toBe(10);
    expect(args.dryRun).toBe(true);
    expect(args.dbPath).toBe("/tmp/foo.db");
  });

  test("rejects non-positive limit", () => {
    expect(() => parseArgs(["--limit", "0"])).toThrow(/positive integer/);
    expect(() => parseArgs(["--limit", "abc"])).toThrow(/positive integer/);
  });

  test("rejects unknown flags", () => {
    expect(() => parseArgs(["--bogus"])).toThrow(/Unknown argument/);
  });
});

describe("rescore-episodes — findUnscoredEpisodes", () => {
  let tmp: string;
  let dbPath: string;
  let db: Database;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "rescore-test-"));
    dbPath = join(tmp, "memory.db");
    db = new Database(dbPath);
    initSchema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  test("returns episodes with NULL metadata", () => {
    const id = seed(db, "USER: x\nASSISTANT: y", 3, null);
    const found = findUnscoredEpisodes(db, SCORER_PROMPT_VERSION, 50);
    expect(found.map((r) => r.id)).toContain(id);
  });

  test("returns episodes with metadata but missing scorer_version", () => {
    const id = seed(db, "USER: x\nASSISTANT: y", 3, JSON.stringify({ other: "data" }));
    const found = findUnscoredEpisodes(db, SCORER_PROMPT_VERSION, 50);
    expect(found.map((r) => r.id)).toContain(id);
  });

  test("returns episodes with stale scorer_version", () => {
    const id = seed(db, "USER: x\nASSISTANT: y", 3, JSON.stringify({ scorer_version: "v0.1.0" }));
    const found = findUnscoredEpisodes(db, SCORER_PROMPT_VERSION, 50);
    expect(found.map((r) => r.id)).toContain(id);
  });

  test("skips episodes with current scorer_version", () => {
    const id = seed(
      db,
      "USER: x\nASSISTANT: y",
      3,
      JSON.stringify({ scorer_version: SCORER_PROMPT_VERSION })
    );
    const found = findUnscoredEpisodes(db, SCORER_PROMPT_VERSION, 50);
    expect(found.map((r) => r.id)).not.toContain(id);
  });

  test("honors limit", () => {
    for (let i = 0; i < 10; i++) seed(db, "USER: x\nASSISTANT: y", 3, null);
    const found = findUnscoredEpisodes(db, SCORER_PROMPT_VERSION, 3);
    expect(found.length).toBe(3);
  });
});

describe("rescore-episodes — runRescore", () => {
  let tmp: string;
  let dbPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "rescore-run-"));
    dbPath = join(tmp, "memory.db");
    const db = new Database(dbPath);
    initSchema(db);
    db.close();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("updates unscored episodes via scorer", async () => {
    const db = new Database(dbPath);
    const id = seed(db, "USER: q\nASSISTANT: a", 3, null);
    db.close();

    const scorer: Scorer = { score: async () => 8 };
    const stats = await runRescore(dbPath, scorer, { limit: 50, dryRun: false });

    expect(stats.seen).toBe(1);
    expect(stats.updated).toBe(1);
    expect(stats.failed).toBe(0);

    const check = new Database(dbPath, { readonly: true });
    const row = check
      .query("SELECT importance, metadata FROM episodes WHERE id = ?")
      .get(id) as { importance: number; metadata: string };
    check.close();
    expect(row.importance).toBe(8);
    expect(JSON.parse(row.metadata).scorer_version).toBe(SCORER_PROMPT_VERSION);
  });

  test("--dry-run skips UPDATE", async () => {
    const db = new Database(dbPath);
    const id = seed(db, "USER: q\nASSISTANT: a", 3, null);
    db.close();

    let called = 0;
    const scorer: Scorer = {
      score: async () => {
        called++;
        return 9;
      },
    };
    const stats = await runRescore(dbPath, scorer, { limit: 50, dryRun: true });

    expect(stats.seen).toBe(1);
    expect(stats.skipped).toBe(1);
    expect(stats.updated).toBe(0);
    expect(called).toBe(0);

    const check = new Database(dbPath, { readonly: true });
    const row = check
      .query("SELECT importance, metadata FROM episodes WHERE id = ?")
      .get(id) as { importance: number; metadata: string | null };
    check.close();
    expect(row.importance).toBe(3); // unchanged
    expect(row.metadata).toBeNull();
  });

  test("continues batch when one scorer call fails (fail-open)", async () => {
    const db = new Database(dbPath);
    seed(db, "USER: q1\nASSISTANT: a1", 3, null);
    seed(db, "USER: q2\nASSISTANT: a2", 3, null);
    seed(db, "USER: q3\nASSISTANT: a3", 3, null);
    db.close();

    let n = 0;
    const scorer: Scorer = {
      score: async () => {
        n++;
        if (n === 2) throw new Error("haiku boom");
        return 7;
      },
    };
    const stats = await runRescore(dbPath, scorer, { limit: 50, dryRun: false });

    expect(stats.seen).toBe(3);
    expect(stats.updated).toBe(2);
    expect(stats.failed).toBe(1);
  });
});
