// standalone/dashboard/server.ts — Bun.serve HTTP server for standalone dashboard
// 22 routes: filesystem reads, read-only SQLite, Claude dispatch, A2A, SSE.
// Bridge-only routes return { enabled: false }.

import type { DashboardConfig } from "./config";
import type { DbReader } from "./db-reader";
import type { PipelineReader } from "./pipeline-reader";
import type { ClaudeRunner } from "./claude-runner";
import type { A2AHandler } from "./a2a-handler";
import { getDashboardHtml } from "../../src/dashboard-html";
import { scanForInjection } from "../../src/injection-scan";
import { generateQR } from "../../src/qr-generator";

interface SSEClient {
  controller: ReadableStreamDefaultController;
  signal: AbortSignal;
}

const BRIDGE_ONLY = { enabled: false, standalone: true, message: "Requires bridge" };
const MAX_BODY_BYTES = 8_192;

export class DashboardServer {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private sseClients = new Set<SSEClient>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastSnapshots: Record<string, string> = {};
  private startTime = Date.now();

  constructor(
    private config: DashboardConfig,
    private db: DbReader,
    private pipeline: PipelineReader,
    private runner: ClaudeRunner,
    private a2a: A2AHandler | null,
  ) {}

  start(): void {
    if (this.server) return;

    const html = getDashboardHtml();

    this.server = Bun.serve({
      hostname: this.config.dashboardBind,
      port: this.config.dashboardPort,
      fetch: async (req) => {
        const url = new URL(req.url);
        const path = url.pathname;

        // A2A routes (agent card is public, rest need auth)
        if (this.a2a && (path.startsWith("/.well-known/") || path.startsWith("/a2a/"))) {
          const resp = await this.a2a.handleRequest(req, url);
          if (resp) return resp;
        }

        // Auth check
        if (!this.checkAuth(req)) {
          return new Response("Unauthorized", { status: 401 });
        }

        try {
          // Static HTML
          if (path === "/" || path === "/index.html") {
            return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
          }

          // Standalone routes (filesystem + SQLite + computation)
          if (path === "/api/status") return this.json(await this.getStatus());
          if (path === "/api/pipeline") return this.json(await this.pipeline.getPipelineData());
          if (path === "/api/history") return this.json(await this.pipeline.getHistory(url.searchParams));
          if (path === "/api/task") return this.json(await this.pipeline.getTask(url.searchParams.get("filename")));
          if (path === "/api/memory") return this.json(this.db.getMemoryStats());
          if (path === "/api/dag") return this.json(this.db.getDagStats());
          if (path === "/api/qr") {
            const text = url.searchParams.get("text");
            if (!text) return this.json({ error: "text parameter required" }, 400);
            return this.json({ qr: await generateQR(text) });
          }

          // Gateway route
          if (path === "/api/send" && req.method === "POST") return await this.handleSend(req);

          // SSE
          if (path === "/events") return this.handleSSE(req);

          // Bridge-only stubs
          if (path === "/api/agents") return this.json(BRIDGE_ONLY);
          if (path === "/api/workflows") return this.json(BRIDGE_ONLY);
          if (path === "/api/health") return this.json({ pipeline: await this.pipeline.getStatus() });
          if (path === "/api/prds") return this.json(BRIDGE_ONLY);
          if (path === "/api/synthesis") return this.json(BRIDGE_ONLY);
          if (path === "/api/health-monitor") return this.json(BRIDGE_ONLY);
          if (path === "/api/session") return this.json({ uptime: Date.now() - this.startTime });
          if (path === "/api/playbooks") return this.json(BRIDGE_ONLY);
          if (path === "/api/worktrees") return this.json(BRIDGE_ONLY);

          return new Response("Not Found", { status: 404 });
        } catch (err) {
          console.error(`[dashboard] Route error ${path}: ${err}`);
          return this.json({ error: "Internal server error" }, 500);
        }
      },
    });

    this.pollTimer = setInterval(() => this.sseSnapshot(), this.config.dashboardSsePollMs);
    console.log(`[dashboard] Listening on http://${this.config.dashboardBind}:${this.config.dashboardPort}`);
  }

  stop(): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    for (const client of this.sseClients) {
      try { client.controller.close(); } catch { /* closed */ }
    }
    this.sseClients.clear();
    if (this.server) { this.server.stop(); this.server = null; }
    console.log("[dashboard] Stopped");
  }

  // --- Auth ---

  private checkAuth(req: Request): boolean {
    const header = req.headers.get("Authorization");
    if (header === `Bearer ${this.config.dashboardToken}`) return true;
    const url = new URL(req.url);
    if (url.searchParams.get("token") === this.config.dashboardToken) return true;
    return false;
  }

  // --- /api/send gateway ---

  private async handleSend(req: Request): Promise<Response> {
    // Body size guard
    const contentLength = parseInt(req.headers.get("Content-Length") ?? "0", 10);
    if (contentLength > MAX_BODY_BYTES) return this.json({ error: "Request body too large (max 8KB)" }, 413);

    let body: { message?: string };
    try {
      const raw = await req.text();
      if (raw.length > MAX_BODY_BYTES) return this.json({ error: "Request body too large (max 8KB)" }, 413);
      body = JSON.parse(raw);
    } catch {
      return this.json({ error: "Invalid JSON body" }, 400);
    }

    const message = body.message?.trim();
    if (!message) return this.json({ error: "message field is required" }, 400);

    // Injection scan — block high risk (matches bridge behavior)
    const scan = scanForInjection(message);
    if (scan.risk === "high") {
      return this.json({ error: "Blocked: injection risk detected", matched: scan.matched, risk: scan.risk }, 403);
    }

    // Dispatch via ClaudeRunner (handles concurrency cap internally)
    try {
      const result = await this.runner.oneShot(message);
      if (result.error && !result.result) {
        const status = result.error.includes("concurrent") ? 429 : 500;
        return this.json({ error: result.error }, status);
      }
      return this.json({ result: result.result, error: result.error, route: "cli" });
    } catch (err) {
      console.error(`[dashboard] /api/send error: ${err}`);
      return this.json({ error: "Send failed" }, 500);
    }
  }

  // --- Status ---

  private async getStatus(): Promise<Record<string, unknown>> {
    return {
      uptime: Date.now() - this.startTime,
      pipeline: await this.pipeline.getStatus(),
      sseClients: this.sseClients.size,
    };
  }

  // --- SSE ---

  private handleSSE(req: Request): Response {
    const stream = new ReadableStream({
      start: (controller) => {
        const client: SSEClient = { controller, signal: req.signal };
        this.sseClients.add(client);
        this.sendSSE(client, "connected", { time: new Date().toISOString() });
        req.signal.addEventListener("abort", () => this.sseClients.delete(client));
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }

  private sendSSE(client: SSEClient, event: string, data: unknown): void {
    try {
      client.controller.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\nretry: 3000\n\n`));
    } catch { this.sseClients.delete(client); }
  }

  private async sseSnapshot(): Promise<void> {
    if (this.sseClients.size === 0) return;
    const getters: Array<[string, string, () => unknown | Promise<unknown>]> = [
      ["status", "status", () => this.getStatus()],
      ["pipeline", "pipeline", () => this.pipeline.getPipelineData()],
      ["memory", "memory", () => this.db.getMemoryStats()],
      ["dag", "dag", () => this.db.getDagStats()],
    ];
    for (const [key, event, getter] of getters) {
      try {
        const data = await getter();
        const json = JSON.stringify(data);
        if (json !== this.lastSnapshots[key]) {
          this.lastSnapshots[key] = json;
          for (const client of this.sseClients) this.sendSSE(client, event, data);
        }
      } catch { /* skip */ }
    }
  }

  // --- Helpers ---

  private json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }
}
