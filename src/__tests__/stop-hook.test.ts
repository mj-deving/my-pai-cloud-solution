import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseStopInput,
  extractLastTurn,
  scoreTurnImportance,
  writeTurnEpisode,
  type StopInput,
  type Turn,
} from "../hooks/stop";

function initEpisodesSchema(db: Database): void {
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
      last_accessed TEXT,
      user_id TEXT,
      channel TEXT
    )
  `);
  db.exec(`
    CREATE VIRTUAL TABLE episodes_fts USING fts5(
      content, summary, content=episodes, content_rowid=id
    )
  `);
  db.exec(`
    CREATE TRIGGER episodes_ai AFTER INSERT ON episodes BEGIN
      INSERT INTO episodes_fts(rowid, content, summary) VALUES (new.id, new.content, new.summary);
    END
  `);
}

describe("stop hook — parseStopInput", () => {
  test("parses Claude Code Stop payload", () => {
    const raw = JSON.stringify({
      session_id: "abc-123",
      transcript_path: "/tmp/trans.jsonl",
      stop_hook_active: false,
      hook_event_name: "Stop",
    });
    const parsed = parseStopInput(raw);
    expect(parsed.session_id).toBe("abc-123");
    expect(parsed.transcript_path).toBe("/tmp/trans.jsonl");
    expect(parsed.stop_hook_active).toBe(false);
  });

  test("defaults stop_hook_active to false when missing", () => {
    const parsed = parseStopInput(JSON.stringify({ session_id: "x", transcript_path: "/t" }));
    expect(parsed.stop_hook_active).toBe(false);
  });

  test("throws on malformed JSON", () => {
    expect(() => parseStopInput("not json")).toThrow();
  });
});

describe("stop hook — extractLastTurn", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "stop-hook-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("extracts user + assistant pair from JSONL transcript", () => {
    const path = join(tmpDir, "t.jsonl");
    writeFileSync(
      path,
      [
        JSON.stringify({ type: "user", message: { role: "user", content: "Hello" } }),
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "Hi there" }] },
        }),
      ].join("\n") + "\n"
    );

    const turn = extractLastTurn(path);
    expect(turn).not.toBeNull();
    expect(turn!.user).toBe("Hello");
    expect(turn!.assistant).toBe("Hi there");
    expect(turn!.toolUses).toEqual([]);
  });

  test("captures tool_use names in the latest assistant turn", () => {
    const path = join(tmpDir, "t.jsonl");
    writeFileSync(
      path,
      [
        JSON.stringify({ type: "user", message: { role: "user", content: "Read foo.txt" } }),
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "Reading now" },
              { type: "tool_use", name: "Read", input: { path: "foo.txt" } },
            ],
          },
        }),
      ].join("\n") + "\n"
    );

    const turn = extractLastTurn(path);
    expect(turn!.toolUses).toContain("Read");
  });

  test("handles user content given as array of blocks", () => {
    const path = join(tmpDir, "t.jsonl");
    writeFileSync(
      path,
      [
        JSON.stringify({
          type: "user",
          message: { role: "user", content: [{ type: "text", text: "block text" }] },
        }),
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "ack" }] },
        }),
      ].join("\n") + "\n"
    );

    const turn = extractLastTurn(path);
    expect(turn!.user).toBe("block text");
  });

  test("returns null when there is no assistant turn yet", () => {
    const path = join(tmpDir, "t.jsonl");
    writeFileSync(
      path,
      JSON.stringify({ type: "user", message: { role: "user", content: "alone" } }) + "\n"
    );
    expect(extractLastTurn(path)).toBeNull();
  });

  test("returns null when transcript file is missing", () => {
    expect(extractLastTurn(join(tmpDir, "missing.jsonl"))).toBeNull();
  });

  test("skips malformed JSONL lines without throwing", () => {
    const path = join(tmpDir, "t.jsonl");
    writeFileSync(
      path,
      [
        "this is not json",
        JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
        "also not json",
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
        }),
      ].join("\n") + "\n"
    );
    const turn = extractLastTurn(path);
    expect(turn!.assistant).toBe("hello");
  });
});

describe("stop hook — scoreTurnImportance", () => {
  test("short conversational turn scores low", () => {
    const turn: Turn = { user: "hi", assistant: "hello", toolUses: [] };
    expect(scoreTurnImportance(turn)).toBeLessThanOrEqual(4);
  });

  test("Write/Edit tool use boosts importance", () => {
    const turn: Turn = { user: "fix bug", assistant: "done", toolUses: ["Write", "Edit"] };
    expect(scoreTurnImportance(turn)).toBeGreaterThanOrEqual(7);
  });

  test("long substantive assistant response scores higher", () => {
    const turn: Turn = {
      user: "explain",
      assistant: "x".repeat(2000),
      toolUses: [],
    };
    expect(scoreTurnImportance(turn)).toBeGreaterThanOrEqual(5);
  });

  test("score is clamped to [1, 10]", () => {
    const big: Turn = {
      user: "x".repeat(5000),
      assistant: "x".repeat(50000),
      toolUses: ["Write", "Edit", "Bash", "WebFetch", "Task"],
    };
    expect(scoreTurnImportance(big)).toBeLessThanOrEqual(10);

    const tiny: Turn = { user: "", assistant: "x", toolUses: [] };
    expect(scoreTurnImportance(tiny)).toBeGreaterThanOrEqual(1);
  });
});

describe("stop hook — writeTurnEpisode", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "stop-hook-db-"));
    dbPath = join(tmpDir, "memory.db");
    const db = new Database(dbPath);
    initEpisodesSchema(db);
    db.close();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("inserts an episode with source='channels' and role='assistant'", () => {
    const turn: Turn = { user: "q", assistant: "a", toolUses: [] };
    const id = writeTurnEpisode(dbPath, turn, "sess-1", "proj-x");
    expect(id).toBeGreaterThan(0);

    const db = new Database(dbPath, { readonly: true });
    const row = db.query("SELECT source, role, session_id, project, content, importance FROM episodes WHERE id = ?").get(id) as Record<string, unknown>;
    db.close();

    expect(row.source).toBe("channels");
    expect(row.role).toBe("assistant");
    expect(row.session_id).toBe("sess-1");
    expect(row.project).toBe("proj-x");
    expect(String(row.content)).toContain("a");
  });

  test("content includes the user prompt as context", () => {
    const turn: Turn = { user: "explain FTS5", assistant: "full-text search", toolUses: [] };
    const id = writeTurnEpisode(dbPath, turn, "s", null);
    const db = new Database(dbPath, { readonly: true });
    const row = db.query("SELECT content FROM episodes WHERE id = ?").get(id) as { content: string };
    db.close();
    expect(row.content).toContain("explain FTS5");
    expect(row.content).toContain("full-text search");
  });

  test("importance is stored (computed before write)", () => {
    const turn: Turn = { user: "q", assistant: "a", toolUses: ["Write", "Edit"] };
    const id = writeTurnEpisode(dbPath, turn, "s", null);
    const db = new Database(dbPath, { readonly: true });
    const row = db.query("SELECT importance FROM episodes WHERE id = ?").get(id) as { importance: number };
    db.close();
    expect(row.importance).toBeGreaterThanOrEqual(7);
  });

  test("FTS5 index is updated via trigger", () => {
    const turn: Turn = { user: "pentatonic", assistant: "scale theory", toolUses: [] };
    writeTurnEpisode(dbPath, turn, "s", null);
    const db = new Database(dbPath, { readonly: true });
    const hit = db.query("SELECT rowid FROM episodes_fts WHERE episodes_fts MATCH 'pentatonic'").get();
    db.close();
    expect(hit).not.toBeNull();
  });
});
