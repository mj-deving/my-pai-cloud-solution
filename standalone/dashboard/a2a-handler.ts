// standalone/dashboard/a2a-handler.ts — A2A JSON-RPC 2.0 handler
// Extracted from src/a2a-server.ts, uses ClaudeRunner instead of ClaudeInvoker.

import type { ClaudeRunner } from "./claude-runner";
import type { DashboardConfig } from "./config";

interface A2AMessage {
  jsonrpc: "2.0";
  id: string;
  method: string;
  params: {
    message: { role: "user"; parts: Array<{ type: "text"; text: string }> };
    metadata?: Record<string, unknown>;
  };
}

export class A2AHandler {
  constructor(
    private config: DashboardConfig,
    private runner: ClaudeRunner,
    private authToken: string,
  ) {}

  async handleRequest(req: Request, url: URL): Promise<Response | null> {
    const path = url.pathname;

    if (path === "/.well-known/agent-card.json" && req.method === "GET") {
      return this.jsonResponse(this.getAgentCard());
    }

    if (path === "/a2a/message/send" && req.method === "POST") {
      if (!this.checkAuth(req)) return new Response("Unauthorized", { status: 401 });
      return await this.handleSend(req);
    }

    if (path === "/a2a/message/stream" && req.method === "POST") {
      if (!this.checkAuth(req)) return new Response("Unauthorized", { status: 401 });
      return await this.handleSend(req); // Same as send for now (no streaming impl)
    }

    return null;
  }

  private getAgentCard(): Record<string, unknown> {
    const baseUrl = this.config.a2aPublicUrl ?? `http://${this.config.dashboardBind}:${this.config.dashboardPort}`;
    return {
      name: "Isidore Cloud",
      description: "PAI cloud assistant with episodic memory and cross-agent pipeline",
      url: `${baseUrl}/a2a`,
      version: "2.0.0",
      capabilities: { streaming: false, pushNotifications: false },
      skills: [
        { id: "general-assistant", name: "General Assistant", description: "Answer questions, analyze code, write content" },
        { id: "memory-search", name: "Memory Search", description: "Search episodic and semantic memory" },
      ],
      authentication: { schemes: ["bearer"] },
    };
  }

  private async handleSend(req: Request): Promise<Response> {
    let body: A2AMessage;
    try {
      body = await req.json() as A2AMessage;
    } catch {
      return this.rpcError(null, -32700, "Parse error");
    }

    if (!body.jsonrpc || body.jsonrpc !== "2.0" || !body.id || !body.method) {
      return this.rpcError(body?.id ?? null, -32600, "Invalid JSON-RPC request");
    }

    const text = body.params?.message?.parts
      ?.filter(p => p.type === "text")
      .map(p => p.text)
      .join("\n") ?? "";

    if (!text.trim()) {
      return this.rpcError(body.id, -32602, "Empty message text");
    }

    try {
      const response = await this.runner.oneShot(text);
      if (response.error && !response.result) {
        return this.rpcError(body.id, -32000, response.error);
      }
      return this.jsonResponse({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          message: { role: "agent", parts: [{ type: "text", text: response.result }] },
        },
      });
    } catch (err) {
      return this.rpcError(body.id, -32000, `Internal error: ${err}`);
    }
  }

  private checkAuth(req: Request): boolean {
    const header = req.headers.get("Authorization");
    return header === `Bearer ${this.authToken}`;
  }

  private jsonResponse(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }

  private rpcError(id: string | null, code: number, message: string): Response {
    return this.jsonResponse({ jsonrpc: "2.0", id, error: { code, message } });
  }
}
