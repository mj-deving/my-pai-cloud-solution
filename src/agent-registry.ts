// agent-registry.ts — SQLite-backed agent registry with heartbeat and stale detection
// Tracks active agents (Isidore, Gregor, future agents) for dashboard and health monitoring.

import { Database } from "bun:sqlite";

export interface AgentRecord {
  id: string;
  persona: string;
  status: string;
  capabilities: string[];
  last_heartbeat: string;
  registered_at: string;
  stale: boolean;
}

export class AgentRegistry {
  private db: Database;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA busy_timeout=5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        persona TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'online',
        capabilities TEXT NOT NULL DEFAULT '[]',
        last_heartbeat TEXT NOT NULL,
        registered_at TEXT NOT NULL
      )
    `);
  }

  /**
   * Register or update an agent on startup.
   */
  register(id: string, persona: string, capabilities: string[] = []): void {
    const now = new Date().toISOString();
    this.db
      .query(
        `INSERT INTO agents (id, persona, status, capabilities, last_heartbeat, registered_at)
         VALUES (?, ?, 'online', ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           persona = excluded.persona,
           status = 'online',
           capabilities = excluded.capabilities,
           last_heartbeat = excluded.last_heartbeat`,
      )
      .run(id, persona, JSON.stringify(capabilities), now, now);
  }

  /**
   * Update heartbeat timestamp for an agent.
   */
  heartbeat(id: string): void {
    this.db
      .query("UPDATE agents SET last_heartbeat = ?, status = 'online' WHERE id = ?")
      .run(new Date().toISOString(), id);
  }

  /**
   * Start periodic heartbeat for an agent.
   */
  startHeartbeat(id: string, intervalMs: number): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => this.heartbeat(id), intervalMs);
    // Immediate first heartbeat
    this.heartbeat(id);
  }

  /**
   * Stop periodic heartbeat.
   */
  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Mark an agent as offline on shutdown.
   */
  deregister(id: string): void {
    this.db
      .query("UPDATE agents SET status = 'offline', last_heartbeat = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
  }

  /**
   * Get all agents with stale detection.
   */
  getAgents(staleThresholdMs = 60000): AgentRecord[] {
    const rows = this.db
      .query("SELECT id, persona, status, capabilities, last_heartbeat, registered_at FROM agents")
      .all() as Array<{
        id: string;
        persona: string;
        status: string;
        capabilities: string;
        last_heartbeat: string;
        registered_at: string;
      }>;

    const now = Date.now();
    return rows.map((row) => ({
      id: row.id,
      persona: row.persona,
      status: row.status,
      capabilities: JSON.parse(row.capabilities) as string[],
      last_heartbeat: row.last_heartbeat,
      registered_at: row.registered_at,
      stale:
        row.status === "online" &&
        now - new Date(row.last_heartbeat).getTime() > staleThresholdMs,
    }));
  }

  close(): void {
    this.stopHeartbeat();
    this.db.close();
  }
}
