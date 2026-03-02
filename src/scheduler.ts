// scheduler.ts — SQLite-backed task scheduler for autonomous operation
// Stores cron-like schedules, checks for due tasks on each tick, and emits
// task JSON files to the pipeline tasks/ directory for dispatch.

import { Database } from "bun:sqlite";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config";

export interface Schedule {
  id: number;
  name: string;
  cron_expr: string;
  task_template: string; // JSON string of Partial<PipelineTask>
  enabled: boolean;
  last_run: string | null;
  next_run: string | null;
  created_at: string;
}

export class Scheduler {
  private db: Database;
  private timer: ReturnType<typeof setInterval> | null = null;
  private tasksDir: string;

  constructor(dbPath: string, private config: Config) {
    this.tasksDir = join(config.pipelineDir, "tasks");
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA busy_timeout=5000");
    this.initTables();
  }

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schedules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        cron_expr TEXT NOT NULL,
        task_template TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_run TEXT,
        next_run TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  }

  /** Register a schedule. Updates if name already exists. */
  upsert(name: string, cronExpr: string, taskTemplate: Record<string, unknown>): void {
    // Validate cron expression
    parseCron(cronExpr);

    const templateJson = JSON.stringify(taskTemplate);
    const nextRun = nextCronOccurrence(cronExpr, new Date())?.toISOString() ?? null;

    this.db.query(`
      INSERT INTO schedules (name, cron_expr, task_template, next_run)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        cron_expr = excluded.cron_expr,
        task_template = excluded.task_template,
        next_run = excluded.next_run
    `).run(name, cronExpr, templateJson, nextRun);
  }

  /** Enable or disable a schedule by name. */
  setEnabled(name: string, enabled: boolean): boolean {
    const result = this.db.query("UPDATE schedules SET enabled = ? WHERE name = ?")
      .run(enabled ? 1 : 0, name);
    return result.changes > 0;
  }

  /** List all schedules. */
  list(): Schedule[] {
    return this.db.query("SELECT * FROM schedules ORDER BY name")
      .all() as Schedule[];
  }

  /** Get a single schedule by name. */
  get(name: string): Schedule | null {
    return (this.db.query("SELECT * FROM schedules WHERE name = ?")
      .get(name) as Schedule) ?? null;
  }

  /** Start the scheduler polling loop. */
  start(): void {
    if (this.timer) return;
    const interval = this.config.schedulerPollIntervalMs;
    console.log(`[scheduler] Started (poll every ${interval}ms)`);
    this.timer = setInterval(() => this.tick(), interval);
    // Also tick immediately
    this.tick();
  }

  /** Stop the scheduler. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log("[scheduler] Stopped");
    }
  }

  /** Check for due schedules and emit tasks. */
  async tick(): Promise<void> {
    const now = new Date();
    const nowIso = now.toISOString();

    const due = this.db.query(
      "SELECT * FROM schedules WHERE enabled = 1 AND (next_run IS NULL OR next_run <= ?)"
    ).all(nowIso) as Schedule[];

    for (const schedule of due) {
      try {
        await this.emitTask(schedule);
        // Update last_run and compute next_run
        const nextRun = nextCronOccurrence(schedule.cron_expr, now)?.toISOString() ?? null;
        this.db.query("UPDATE schedules SET last_run = ?, next_run = ? WHERE id = ?")
          .run(nowIso, nextRun, schedule.id);
        console.log(`[scheduler] Emitted task for "${schedule.name}", next: ${nextRun}`);
      } catch (err) {
        console.error(`[scheduler] Failed to emit task for "${schedule.name}": ${err}`);
      }
    }
  }

  /** Trigger a schedule immediately (for /schedule run). */
  async triggerNow(name: string): Promise<boolean> {
    const schedule = this.get(name);
    if (!schedule) return false;

    await this.emitTask(schedule);
    const now = new Date();
    const nextRun = nextCronOccurrence(schedule.cron_expr, now)?.toISOString() ?? null;
    this.db.query("UPDATE schedules SET last_run = ?, next_run = ? WHERE id = ?")
      .run(now.toISOString(), nextRun, schedule.id);
    return true;
  }

  private async emitTask(schedule: Schedule): Promise<void> {
    const template = JSON.parse(schedule.task_template);
    const taskId = `sched-${schedule.name}-${Date.now()}`;

    const task = {
      ...template,
      // Override fields that must be set by scheduler
      id: taskId,
      from: "scheduler",
      to: template.to || "isidore_cloud",
      timestamp: new Date().toISOString(),
      type: template.type || "task",
      priority: template.priority || "low",
      prompt: template.prompt || `Scheduled task: ${schedule.name}`,
      project: template.project || undefined,
      timeout_minutes: template.timeout_minutes || 5,
      max_turns: template.max_turns || 10,
    };

    const filename = `${taskId}.json`;
    const taskPath = join(this.tasksDir, filename);
    await writeFile(taskPath, JSON.stringify(task, null, 2) + "\n", "utf-8");
  }

  /** Close the database. */
  close(): void {
    this.db.close();
    console.log("[scheduler] Database closed");
  }
}

// --- Minimal 5-field cron parser ---

interface CronFields {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
}

/** Parse a 5-field cron expression into expanded sets. */
export function parseCron(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression "${expr}": expected 5 fields, got ${parts.length}`);
  }

  return {
    minutes: expandField(parts[0]!, 0, 59),
    hours: expandField(parts[1]!, 0, 23),
    daysOfMonth: expandField(parts[2]!, 1, 31),
    months: expandField(parts[3]!, 1, 12),
    daysOfWeek: expandField(parts[4]!, 0, 6),
  };
}

function expandField(field: string, min: number, max: number): Set<number> {
  const result = new Set<number>();

  for (const part of field.split(",")) {
    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    const step = stepMatch ? parseInt(stepMatch[2]!, 10) : 1;
    const range = stepMatch ? stepMatch[1]! : part;

    if (range === "*") {
      for (let i = min; i <= max; i += step) result.add(i);
    } else if (range.includes("-")) {
      const [startStr, endStr] = range.split("-");
      const start = parseInt(startStr!, 10);
      const end = parseInt(endStr!, 10);
      if (isNaN(start) || isNaN(end) || start < min || end > max) {
        throw new Error(`Invalid cron range "${part}" (valid: ${min}-${max})`);
      }
      for (let i = start; i <= end; i += step) result.add(i);
    } else {
      const val = parseInt(range, 10);
      if (isNaN(val) || val < min || val > max) {
        throw new Error(`Invalid cron value "${part}" (valid: ${min}-${max})`);
      }
      result.add(val);
    }
  }

  return result;
}

/** Find the next occurrence of a cron schedule after the given date. */
export function nextCronOccurrence(expr: string, after: Date): Date | null {
  const fields = parseCron(expr);
  const candidate = new Date(after);
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);

  // Search up to 366 days ahead
  const limit = 366 * 24 * 60;
  for (let i = 0; i < limit; i++) {
    const month = candidate.getUTCMonth() + 1; // 1-indexed
    const dom = candidate.getUTCDate();
    const dow = candidate.getUTCDay();
    const hour = candidate.getUTCHours();
    const minute = candidate.getUTCMinutes();

    if (
      fields.months.has(month) &&
      fields.daysOfMonth.has(dom) &&
      fields.daysOfWeek.has(dow) &&
      fields.hours.has(hour) &&
      fields.minutes.has(minute)
    ) {
      return candidate;
    }

    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  }

  return null; // No match found within search window
}
