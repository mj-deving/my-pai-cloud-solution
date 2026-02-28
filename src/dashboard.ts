// dashboard.ts — Phase 2: Web dashboard for Isidore Cloud pipeline monitoring
// Bun.serve HTTP server with REST API, SSE real-time updates, and self-contained HTML frontend.
// All data source dependencies are nullable — handles missing components gracefully.

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config";
import type { PipelineWatcher } from "./pipeline";
import type { TaskOrchestrator } from "./orchestrator";
import type { ReversePipelineWatcher } from "./reverse-pipeline";
import type { RateLimiter } from "./rate-limiter";
import type { ResourceGuard } from "./resource-guard";
import type { AgentRegistry } from "./agent-registry";
import type { IdempotencyStore } from "./idempotency";
import { getDashboardHtml } from "./dashboard-html";

interface SSEClient {
  controller: ReadableStreamDefaultController;
  signal: AbortSignal;
}

interface DirCacheEntry {
  entries: string[];
  timestamp: number;
}

export class Dashboard {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private sseClients: Set<SSEClient> = new Set();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastSnapshots: Record<string, string> = {};
  private startTime = Date.now();
  private dirCache: Map<string, DirCacheEntry> = new Map();
  private static DIR_CACHE_TTL_MS = 10_000;

  private pipelineDir: string;
  private resultsDir: string;
  private ackDir: string;
  private tasksDir: string;

  constructor(
    private config: Config,
    private pipeline: PipelineWatcher | null = null,
    private orchestrator: TaskOrchestrator | null = null,
    private reversePipeline: ReversePipelineWatcher | null = null,
    private rateLimiter: RateLimiter | null = null,
    private resourceGuard: ResourceGuard | null = null,
    private agentRegistry: AgentRegistry | null = null,
    private idempotencyStore: IdempotencyStore | null = null,
  ) {
    this.pipelineDir = config.pipelineDir;
    this.resultsDir = join(config.pipelineDir, "results");
    this.ackDir = join(config.pipelineDir, "ack");
    this.tasksDir = join(config.pipelineDir, "tasks");
  }

  start(): void {
    if (this.server) return;

    const htmlPage = getDashboardHtml();

    this.server = Bun.serve({
      hostname: this.config.dashboardBind,
      port: this.config.dashboardPort,
      fetch: async (req) => {
        // Auth check
        if (!this.checkAuth(req)) {
          return new Response("Unauthorized", { status: 401 });
        }

        const url = new URL(req.url);
        const path = url.pathname;

        try {
          if (path === "/" || path === "/index.html") {
            return new Response(htmlPage, {
              headers: { "Content-Type": "text/html; charset=utf-8" },
            });
          }

          if (path === "/api/status") return this.jsonResponse(await this.getStatus());
          if (path === "/api/pipeline") return this.jsonResponse(await this.getPipelineData());
          if (path === "/api/agents") return this.jsonResponse(this.getAgentsData());
          if (path === "/api/workflows") return this.jsonResponse(this.getWorkflowsData(url.searchParams.get("status")));
          if (path === "/api/health") return this.jsonResponse(this.getHealthData());
          if (path === "/api/history") return this.jsonResponse(await this.getHistoryData(url.searchParams));
          if (path === "/api/task") return this.jsonResponse(await this.getTaskData(url.searchParams.get("filename")));
          if (path === "/events") return this.handleSSE(req);

          return new Response("Not Found", { status: 404 });
        } catch (err) {
          console.error(`[dashboard] Route error ${path}: ${err}`);
          return this.jsonResponse({ error: String(err) }, 500);
        }
      },
    });

    // Start SSE poll timer
    this.pollTimer = setInterval(() => this.sseSnapshot(), this.config.dashboardSsePollMs);

    console.log(`[dashboard] Listening on http://${this.config.dashboardBind}:${this.config.dashboardPort}`);
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    // Close all SSE connections
    for (const client of this.sseClients) {
      try { client.controller.close(); } catch { /* already closed */ }
    }
    this.sseClients.clear();

    if (this.server) {
      this.server.stop();
      this.server = null;
    }
    console.log("[dashboard] Stopped");
  }

  // --- Auth ---

  private checkAuth(req: Request): boolean {
    if (!this.config.dashboardToken) return true; // No token = no auth required

    // Check Authorization header
    const authHeader = req.headers.get("Authorization");
    if (authHeader === `Bearer ${this.config.dashboardToken}`) return true;

    // Check query param (for SSE EventSource which can't set headers)
    const url = new URL(req.url);
    if (url.searchParams.get("token") === this.config.dashboardToken) return true;

    return false;
  }

  // --- SSE ---

  private handleSSE(req: Request): Response {
    const stream = new ReadableStream({
      start: (controller) => {
        const client: SSEClient = { controller, signal: req.signal };
        this.sseClients.add(client);

        // Send connected event
        this.sendSSEEvent(client, "connected", { time: new Date().toISOString() });

        // Clean up on disconnect
        req.signal.addEventListener("abort", () => {
          this.sseClients.delete(client);
        });
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no", // nginx: disable buffering
      },
    });
  }

  private sendSSEEvent(client: SSEClient, event: string, data: unknown): void {
    try {
      const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\nretry: 3000\n\n`;
      client.controller.enqueue(new TextEncoder().encode(payload));
    } catch {
      // Client disconnected — will be cleaned up by abort handler
      this.sseClients.delete(client);
    }
  }

  private broadcastSSE(event: string, data: unknown): void {
    for (const client of this.sseClients) {
      this.sendSSEEvent(client, event, data);
    }
  }

  private async sseSnapshot(): Promise<void> {
    if (this.sseClients.size === 0) return;

    // Only push changed data
    const snapshots: Array<[string, string, () => unknown | Promise<unknown>]> = [
      ["status", "status", () => this.getStatus()],
      ["health", "health", () => this.getHealthData()],
      ["pipeline", "pipeline", () => this.getPipelineData()],
      ["agents", "agents", () => this.getAgentsData()],
      ["workflows", "workflows", () => this.getWorkflowsData(null)],
    ];

    for (const [key, event, getter] of snapshots) {
      try {
        const data = await getter();
        const json = JSON.stringify(data);
        if (json !== this.lastSnapshots[key]) {
          this.lastSnapshots[key] = json;
          this.broadcastSSE(event, data);
        }
      } catch (err) {
        console.warn(`[dashboard] SSE snapshot error for ${key}: ${err}`);
      }
    }
  }

  // --- API Data Getters ---

  private async getStatus(): Promise<Record<string, unknown>> {
    return {
      uptime: Date.now() - this.startTime,
      pipeline: this.pipeline?.getStatus() ?? null,
      sseClients: this.sseClients.size,
    };
  }

  private async getPipelineData(): Promise<Record<string, unknown>> {
    const pending: unknown[] = [];
    const inProgress: unknown[] = [];
    const completed: unknown[] = [];
    const error: unknown[] = [];

    // Pending tasks from tasks/ directory
    try {
      const taskFiles = await this.cachedReaddir(this.tasksDir);
      for (const file of taskFiles.filter(f => f.endsWith(".json"))) {
        try {
          const raw = await readFile(join(this.tasksDir, file), "utf-8");
          const task = JSON.parse(raw);
          pending.push({ ...task, filename: file });
        } catch { /* skip unreadable */ }
      }
    } catch { /* dir may not exist */ }

    // In-progress from pipeline status
    if (this.pipeline) {
      const status = this.pipeline.getStatus();
      for (const filename of status.inFlight) {
        inProgress.push({ filename, status: "in_progress" });
      }
    }

    // Results (completed + error) from results/ directory
    try {
      const resultFiles = await this.cachedReaddir(this.resultsDir);
      for (const file of resultFiles.filter(f => f.endsWith(".json")).slice(-20)) {
        try {
          const raw = await readFile(join(this.resultsDir, file), "utf-8");
          const result = JSON.parse(raw);
          if (result.status === "completed") {
            completed.push({ ...result, filename: file });
          } else {
            error.push({ ...result, filename: file });
          }
        } catch { /* skip */ }
      }
    } catch { /* dir may not exist */ }

    return { pending, inProgress, completed, error };
  }

  private getAgentsData(): unknown[] {
    if (!this.agentRegistry) return [];
    return this.agentRegistry.getAgents(this.config.agentRegistryStaleThresholdMs);
  }

  private getWorkflowsData(statusFilter: string | null): unknown[] {
    if (!this.orchestrator) return [];
    let workflows = this.orchestrator.getAllWorkflows();
    if (statusFilter) {
      workflows = workflows.filter(w => w.status === statusFilter);
    }
    return workflows;
  }

  private getHealthData(): Record<string, unknown> {
    return {
      pipeline: this.pipeline?.getStatus() ?? null,
      rateLimiter: this.rateLimiter?.getStatus() ?? null,
      resourceGuard: this.resourceGuard?.getStatus() ?? null,
      idempotency: this.idempotencyStore?.stats() ?? null,
      reversePipeline: this.reversePipeline
        ? { pending: this.reversePipeline.getPending().length }
        : null,
    };
  }

  private async getHistoryData(params: URLSearchParams): Promise<Record<string, unknown>> {
    const query = (params.get("q") || "").toLowerCase();
    const statusFilter = params.get("status") || "";
    const limit = Math.min(parseInt(params.get("limit") || "20", 10) || 20, 200);
    const offset = parseInt(params.get("offset") || "0", 10) || 0;

    const results: Array<Record<string, unknown>> = [];

    // Scan results/ and ack/ directories
    for (const dir of [this.resultsDir, this.ackDir]) {
      try {
        const files = await this.cachedReaddir(dir);
        for (const file of files.filter(f => f.endsWith(".json"))) {
          try {
            const raw = await readFile(join(dir, file), "utf-8");
            const data = JSON.parse(raw);

            // Apply filters
            if (statusFilter && data.status !== statusFilter) continue;
            if (query) {
              const searchable = JSON.stringify(data).toLowerCase();
              if (!searchable.includes(query)) continue;
            }

            results.push({
              ...data,
              filename: file,
              source: dir === this.resultsDir ? "results" : "ack",
            });
          } catch { /* skip */ }
        }
      } catch { /* dir may not exist */ }
    }

    // Sort by timestamp descending
    results.sort((a, b) => {
      const ta = String(a.timestamp || "");
      const tb = String(b.timestamp || "");
      return tb.localeCompare(ta);
    });

    // Paginate
    const paged = results.slice(offset, offset + limit);
    return { results: paged, total: results.length, limit, offset };
  }

  private async getTaskData(filename: string | null): Promise<Record<string, unknown>> {
    if (!filename) return { error: "filename parameter required" };

    // Search in results/, ack/, then tasks/
    for (const dir of [this.resultsDir, this.ackDir, this.tasksDir]) {
      try {
        const filePath = join(dir, filename);
        const s = await stat(filePath);
        if (s.isFile()) {
          const raw = await readFile(filePath, "utf-8");
          return JSON.parse(raw);
        }
      } catch { /* not in this dir */ }
    }

    return { error: "Task not found" };
  }

  // --- Helpers ---

  private jsonResponse(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  private async cachedReaddir(dir: string): Promise<string[]> {
    const cached = this.dirCache.get(dir);
    if (cached && Date.now() - cached.timestamp < Dashboard.DIR_CACHE_TTL_MS) {
      return cached.entries;
    }

    const entries = await readdir(dir);
    this.dirCache.set(dir, { entries, timestamp: Date.now() });
    return entries;
  }
}
