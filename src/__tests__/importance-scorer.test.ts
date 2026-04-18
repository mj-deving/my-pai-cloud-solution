import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  splitContent,
  buildScorerPrompt,
  rescoreEpisode,
  SCORER_PROMPT_VERSION,
  type Scorer,
} from "../hooks/importance-scorer";

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

function seed(db: Database, content: string, importance: number, metadata: string | null = null): number {
  const r = db
    .query("INSERT INTO episodes (timestamp, source, role, content, importance, metadata) VALUES (?, 'channels', 'assistant', ?, ?, ?)")
    .run(new Date().toISOString(), content, importance, metadata);
  return Number(r.lastInsertRowid);
}

describe("importance-scorer — splitContent", () => {
  test("extracts USER and ASSISTANT blocks from turn content", () => {
    const split = splitContent("USER: hello\nASSISTANT: hi there");
    expect(split.user).toBe("hello");
    expect(split.assistant).toBe("hi there");
  });

  test("returns null user when content has only ASSISTANT block", () => {
    const split = splitContent("ASSISTANT: a standalone response");
    expect(split.user).toBeNull();
    expect(split.assistant).toBe("a standalone response");
  });

  test("handles multi-line assistant content", () => {
    const split = splitContent("USER: q\nASSISTANT: line1\nline2\nline3");
    expect(split.assistant).toContain("line1");
    expect(split.assistant).toContain("line3");
  });
});

describe("importance-scorer — buildScorerPrompt", () => {
  test("includes user + assistant blocks", () => {
    const p = buildScorerPrompt({ user: "q", assistant: "a" });
    expect(p.user).toContain("USER: q");
    expect(p.user).toContain("ASSISTANT: a");
  });

  test("omits user block when user is null", () => {
    const p = buildScorerPrompt({ user: null, assistant: "alone" });
    expect(p.user).not.toContain("USER:");
    expect(p.user).toContain("ASSISTANT: alone");
  });

  test("system prompt mentions 1-10 scale", () => {
    const p = buildScorerPrompt({ user: "x", assistant: "y" });
    expect(p.system).toContain("1-10");
  });
});

describe("importance-scorer — rescoreEpisode", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "scorer-test-"));
    dbPath = join(tmpDir, "memory.db");
    const db = new Database(dbPath);
    initSchema(db);
    db.close();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("updates importance and stamps metadata with scorer_version", async () => {
    const dbw = new Database(dbPath);
    const id = seed(dbw, "USER: q\nASSISTANT: a", 3);
    dbw.close();

    const fakeScorer: Scorer = { score: async () => 8 };
    const result = await rescoreEpisode(dbPath, id, fakeScorer);

    expect(result.updated).toBe(true);
    expect(result.score).toBe(8);

    const db = new Database(dbPath, { readonly: true });
    const row = db.query("SELECT importance, metadata FROM episodes WHERE id = ?").get(id) as {
      importance: number;
      metadata: string;
    };
    db.close();
    expect(row.importance).toBe(8);
    expect(JSON.parse(row.metadata)).toEqual({ scorer_version: SCORER_PROMPT_VERSION });
  });

  test("is idempotent — skips if current scorer_version already recorded", async () => {
    const dbw = new Database(dbPath);
    const metaWithVersion = JSON.stringify({ scorer_version: SCORER_PROMPT_VERSION });
    const id = seed(dbw, "USER: q\nASSISTANT: a", 5, metaWithVersion);
    dbw.close();

    let called = 0;
    const scorer: Scorer = {
      score: async () => {
        called++;
        return 9;
      },
    };
    const result = await rescoreEpisode(dbPath, id, scorer);
    expect(result.updated).toBe(false);
    expect(called).toBe(0);
  });

  test("re-scores when stored version differs from current version", async () => {
    const dbw = new Database(dbPath);
    const oldMeta = JSON.stringify({ scorer_version: "v0.9.0" });
    const id = seed(dbw, "USER: q\nASSISTANT: a", 4, oldMeta);
    dbw.close();

    const scorer: Scorer = { score: async () => 7 };
    const result = await rescoreEpisode(dbPath, id, scorer);
    expect(result.updated).toBe(true);
    expect(result.score).toBe(7);
  });

  test("throws when scorer returns non-integer text", async () => {
    const dbw = new Database(dbPath);
    const id = seed(dbw, "USER: q\nASSISTANT: a", 3);
    dbw.close();

    const badScorer: Scorer = { score: async () => "unparseable" as unknown as number };
    await expect(rescoreEpisode(dbPath, id, badScorer)).rejects.toThrow();
  });

  test("returns { updated: false } when episode id is missing", async () => {
    const scorer: Scorer = { score: async () => 5 };
    const result = await rescoreEpisode(dbPath, 9999, scorer);
    expect(result.updated).toBe(false);
    expect(result.score).toBeNull();
  });
});
