// standalone/dashboard/pipeline-reader.ts — Filesystem reads for pipeline directories
// Provides task/result/history data without bridge runtime dependencies.

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

interface DirCacheEntry {
  entries: string[];
  timestamp: number;
}

const DIR_CACHE_TTL_MS = 10_000;

export class PipelineReader {
  private tasksDir: string;
  private resultsDir: string;
  private ackDir: string;
  private dirCache = new Map<string, DirCacheEntry>();

  constructor(pipelineDir: string) {
    this.tasksDir = join(pipelineDir, "tasks");
    this.resultsDir = join(pipelineDir, "results");
    this.ackDir = join(pipelineDir, "ack");
  }

  async getStatus(): Promise<Record<string, unknown>> {
    const pending = await this.countJsonFiles(this.tasksDir);
    const completed = await this.countJsonFiles(this.resultsDir);
    return { pending, completed, inFlight: [] }; // inFlight is bridge-only state
  }

  async getPipelineData(): Promise<Record<string, unknown>> {
    const pending: unknown[] = [];
    const completed: unknown[] = [];
    const error: unknown[] = [];

    // Pending tasks
    try {
      const taskFiles = await this.cachedReaddir(this.tasksDir);
      for (const file of taskFiles.filter(f => f.endsWith(".json"))) {
        try {
          const raw = await readFile(join(this.tasksDir, file), "utf-8");
          pending.push({ ...JSON.parse(raw), filename: file });
        } catch { /* skip */ }
      }
    } catch { /* dir may not exist */ }

    // Results
    try {
      const resultFiles = await this.cachedReaddir(this.resultsDir);
      for (const file of resultFiles.filter(f => f.endsWith(".json")).slice(-20)) {
        try {
          const raw = await readFile(join(this.resultsDir, file), "utf-8");
          const result = JSON.parse(raw);
          (result.status === "completed" ? completed : error).push({ ...result, filename: file });
        } catch { /* skip */ }
      }
    } catch { /* dir may not exist */ }

    return { pending, inProgress: [], completed, error };
  }

  async getHistory(params: URLSearchParams): Promise<Record<string, unknown>> {
    const query = (params.get("q") ?? "").toLowerCase();
    const statusFilter = params.get("status") ?? "";
    const limit = Math.min(parseInt(params.get("limit") ?? "20", 10) || 20, 200);
    const offset = parseInt(params.get("offset") ?? "0", 10) || 0;

    const results: Array<Record<string, unknown>> = [];

    for (const [dir, source] of [[this.resultsDir, "results"], [this.ackDir, "ack"]] as const) {
      try {
        const files = await this.cachedReaddir(dir);
        for (const file of files.filter(f => f.endsWith(".json"))) {
          try {
            const raw = await readFile(join(dir, file), "utf-8");
            const data = JSON.parse(raw);
            if (statusFilter && data.status !== statusFilter) continue;
            if (query && !JSON.stringify(data).toLowerCase().includes(query)) continue;
            results.push({ ...data, filename: file, source });
          } catch { /* skip */ }
        }
      } catch { /* dir may not exist */ }
    }

    results.sort((a, b) => String(b.timestamp ?? "").localeCompare(String(a.timestamp ?? "")));
    const paged = results.slice(offset, offset + limit);
    return { results: paged, total: results.length, limit, offset };
  }

  async getTask(filename: string | null): Promise<Record<string, unknown>> {
    if (!filename) return { error: "filename parameter required" };

    // Path traversal guard
    if (filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
      return { error: "invalid filename" };
    }

    for (const dir of [this.resultsDir, this.ackDir, this.tasksDir]) {
      try {
        const filePath = join(dir, filename);
        const s = await stat(filePath);
        if (s.isFile()) {
          return JSON.parse(await readFile(filePath, "utf-8"));
        }
      } catch { /* not in this dir */ }
    }

    return { error: "Task not found" };
  }

  private async countJsonFiles(dir: string): Promise<number> {
    try {
      const files = await this.cachedReaddir(dir);
      return files.filter(f => f.endsWith(".json")).length;
    } catch { return 0; }
  }

  private async cachedReaddir(dir: string): Promise<string[]> {
    const cached = this.dirCache.get(dir);
    if (cached && Date.now() - cached.timestamp < DIR_CACHE_TTL_MS) return cached.entries;
    const entries = await readdir(dir);
    this.dirCache.set(dir, { entries, timestamp: Date.now() });
    return entries;
  }
}
