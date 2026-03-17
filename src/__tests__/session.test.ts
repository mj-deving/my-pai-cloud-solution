import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { SessionManager, type MemoryStoreLike } from "../session";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tempDir: string;
let sessionFile: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "session-test-"));
  sessionFile = join(tempDir, "active-session-id");
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("SessionManager", () => {
  test("current() returns null when no session file", async () => {
    const sm = new SessionManager(sessionFile);
    expect(await sm.current()).toBeNull();
  });

  test("saveSession() + current() roundtrip", async () => {
    const sm = new SessionManager(sessionFile);
    await sm.saveSession("sess-abc-123");
    expect(await sm.current()).toBe("sess-abc-123");
  });

  test("saveSession() overwrites previous session", async () => {
    const sm = new SessionManager(sessionFile);
    await sm.saveSession("sess-1");
    await sm.saveSession("sess-2");
    expect(await sm.current()).toBe("sess-2");
  });

  test("clear() removes current session", async () => {
    const sm = new SessionManager(sessionFile);
    await sm.saveSession("sess-to-clear");
    await sm.clear();
    expect(await sm.current()).toBeNull();
  });

  test("newSession() archives old and clears", async () => {
    const sm = new SessionManager(sessionFile);
    await sm.saveSession("old-session");
    await sm.newSession();
    expect(await sm.current()).toBeNull();
  });

  test("list() returns current and archived sessions", async () => {
    const sm = new SessionManager(sessionFile);
    await sm.saveSession("sess-1");
    await sm.clear(); // archives sess-1
    await sm.saveSession("sess-2");

    const list = await sm.list();
    expect(list.current).toBe("sess-2");
    expect(list.archived.length).toBeGreaterThanOrEqual(1);
  });

  // --- Workspace session (memory.db backed) ---
  test("workspace session roundtrip via memory store", () => {
    const sm = new SessionManager(sessionFile);
    const data: Record<string, string> = {};
    const store: MemoryStoreLike = {
      getSystemState(key: string) { return data[key] ?? null; },
      setSystemState(key: string, value: string) { data[key] = value; },
    };
    sm.setMemoryStore(store);

    sm.saveWorkspaceSession("ws-sess-123");
    expect(sm.getWorkspaceSession()).toBe("ws-sess-123");
  });

  test("getWorkspaceSession() returns null without memory store", () => {
    const sm = new SessionManager(sessionFile);
    expect(sm.getWorkspaceSession()).toBeNull();
  });
});
