// a2a-server.ts — A2A (Agent-to-Agent) protocol server for Isidore Cloud
// Provides JSON-RPC 2.0 endpoints for agent discovery and message exchange.
// Mounted on the Dashboard HTTP server for /a2a/* and /.well-known/* routes.

import type { Config } from "./config";
import type { ClaudeInvoker } from "./claude";

// --- A2A Protocol Types ---

interface AgentCard {
  name: string;
  description: string;
  url: string;
  version: string;
  capabilities: {
    streaming: boolean;
    pushNotifications: boolean;
  };
  skills: Array<{
    id: string;
    name: string;
    description: string;
  }>;
  authentication: {
    schemes: string[];
  };
}

interface A2AMessage {
  jsonrpc: "2.0";
  id: string;
  method: string;
  params: {
    message: {
      role: "user";
      parts: Array<{ type: "text"; text: string }>;
    };
    metadata?: Record<string, unknown>;
  };
}

interface JsonRpcError {
  jsonrpc: "2.0";
  id: string | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface JsonRpcResult {
  jsonrpc: "2.0";
  id: string;
  result: {
    message: {
      role: "agent";
      parts: Array<{ type: "text"; text: string }>;
    };
  };
}

// --- A2A Server ---

export class A2AServer {
  private config: Config;
  private claude: ClaudeInvoker;

  constructor(config: Config, claude: ClaudeInvoker) {
    this.config = config;
    this.claude = claude;
  }

  /**
   * Main route handler — called by Dashboard for /a2a/* and /.well-known/* routes.
   * Returns null for unrecognized routes (dashboard handles 404).
   */
  async handleRequest(req: Request, url: URL): Promise<Response | null> {
    const path = url.pathname;

    // Agent card — public discovery (no auth per A2A spec)
    if (path === "/.well-known/agent-card.json" && req.method === "GET") {
      return this.handleAgentCard();
    }

    // All other A2A routes require auth
    if (path === "/a2a/message/send" && req.method === "POST") {
      if (!this.checkAuth(req)) return this.unauthorizedResponse();
      return await this.handleSend(req);
    }

    if (path === "/a2a/message/stream" && req.method === "POST") {
      if (!this.checkAuth(req)) return this.unauthorizedResponse();
      return await this.handleStream(req);
    }

    // Not an A2A route
    return null;
  }

  /**
   * Returns the agent card describing Isidore Cloud's capabilities.
   */
  getAgentCard(): AgentCard {
    // Use A2A_PUBLIC_URL if set (for reverse proxy / public-facing), fall back to dashboard bind
    const baseUrl = process.env.A2A_PUBLIC_URL || `http://${this.config.dashboardBind}:${this.config.dashboardPort}`;
    return {
      name: "Isidore Cloud",
      description:
        "PAI cloud assistant — Telegram bridge with episodic memory, DAG summarization, and cross-agent pipeline",
      url: `${baseUrl}/a2a`,
      version: "2.0.0",
      capabilities: {
        streaming: true,
        pushNotifications: false,
      },
      skills: [
        {
          id: "general-assistant",
          name: "General Assistant",
          description:
            "Answer questions, analyze code, write content, and perform general-purpose tasks",
        },
        {
          id: "memory-search",
          name: "Memory Search",
          description:
            "Search episodic and semantic memory for past conversations, learnings, and project context",
        },
        {
          id: "pipeline-dispatch",
          name: "Pipeline Dispatch",
          description:
            "Delegate tasks to other agents via the cross-user pipeline (forward and reverse)",
        },
      ],
      authentication: {
        schemes: ["bearer"],
      },
    };
  }

  // --- Route Handlers ---

  private handleAgentCard(): Response {
    return new Response(JSON.stringify(this.getAgentCard()), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  private extractText(message: A2AMessage): string {
    return message.params.message.parts
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("\n");
  }

  private async handleSend(req: Request): Promise<Response> {
    // Parse and validate JSON-RPC request
    const parsed = await this.parseA2AMessage(req);
    if ("error" in parsed) return parsed.error;

    const { message, id } = parsed;
    const text = this.extractText(message);

    if (!text.trim()) {
      return this.jsonRpcErrorResponse(id, -32602, "Empty message text");
    }

    try {
      const response = await this.claude.oneShot(text);

      if (response.error) {
        return this.jsonRpcErrorResponse(id, -32000, response.error);
      }

      const result: JsonRpcResult = {
        jsonrpc: "2.0",
        id,
        result: {
          message: {
            role: "agent",
            parts: [{ type: "text", text: response.result }],
          },
        },
      };

      return new Response(JSON.stringify(result), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    } catch (err) {
      console.error(`[a2a] Send error: ${err}`);
      return this.jsonRpcErrorResponse(id, -32000, "Internal error during Claude invocation");
    }
  }

  private async handleStream(req: Request): Promise<Response> {
    // Parse and validate JSON-RPC request
    const parsed = await this.parseA2AMessage(req);
    if ("error" in parsed) return parsed.error;

    const { message, id } = parsed;
    const text = this.extractText(message);

    if (!text.trim()) {
      return this.jsonRpcErrorResponse(id, -32602, "Empty message text");
    }

    // Create SSE stream — uses oneShot (session-isolated, prevents A2A messages polluting user session)
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      start: (controller) => {
        this.claude
          .oneShot(text)
          .then((response) => {
            if (response.error) {
              const errorEvent: JsonRpcError = {
                jsonrpc: "2.0",
                id,
                error: { code: -32000, message: response.error },
              };
              try {
                controller.enqueue(
                  encoder.encode(`event: error\ndata: ${JSON.stringify(errorEvent)}\n\n`),
                );
                controller.close();
              } catch { /* stream closed */ }
              return;
            }
            const final: JsonRpcResult = {
              jsonrpc: "2.0",
              id,
              result: {
                message: {
                  role: "agent",
                  parts: [{ type: "text", text: response.result }],
                },
              },
            };
            try {
              controller.enqueue(
                encoder.encode(`event: result\ndata: ${JSON.stringify(final)}\n\n`),
              );
              controller.close();
            } catch { /* stream closed */ }
          })
          .catch((err) => {
            console.error(`[a2a] Stream error: ${err}`);
            const errorEvent: JsonRpcError = {
              jsonrpc: "2.0",
              id,
              error: { code: -32000, message: "Stream error" },
            };
            try {
              controller.enqueue(
                encoder.encode(`event: error\ndata: ${JSON.stringify(errorEvent)}\n\n`),
              );
              controller.close();
            } catch { /* stream closed */ }
          });
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  // --- Auth ---

  private checkAuth(req: Request): boolean {
    // Fail closed — if token is somehow missing, deny access
    if (!this.config.dashboardToken) return false;
    const authHeader = req.headers.get("Authorization");
    return authHeader === `Bearer ${this.config.dashboardToken}`;
  }

  private unauthorizedResponse(): Response {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // --- JSON-RPC Helpers ---

  private async parseA2AMessage(
    req: Request,
  ): Promise<{ message: A2AMessage; id: string } | { error: Response }> {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return {
        error: this.jsonRpcErrorResponse(null, -32700, "Parse error: invalid JSON"),
      };
    }

    // Validate JSON-RPC structure
    const msg = body as Record<string, unknown>;
    if (
      !msg ||
      typeof msg !== "object" ||
      msg.jsonrpc !== "2.0" ||
      typeof msg.id !== "string" ||
      !msg.params ||
      typeof msg.params !== "object"
    ) {
      return {
        error: this.jsonRpcErrorResponse(
          typeof msg?.id === "string" ? msg.id : null,
          -32600,
          "Invalid JSON-RPC 2.0 request",
        ),
      };
    }

    const params = msg.params as Record<string, unknown>;
    if (
      !params.message ||
      typeof params.message !== "object" ||
      !Array.isArray((params.message as Record<string, unknown>).parts)
    ) {
      return {
        error: this.jsonRpcErrorResponse(
          msg.id as string,
          -32602,
          "Invalid params: message.parts is required",
        ),
      };
    }

    return { message: body as A2AMessage, id: msg.id as string };
  }

  private jsonRpcErrorResponse(
    id: string | null,
    code: number,
    message: string,
  ): Response {
    const errorBody: JsonRpcError = {
      jsonrpc: "2.0",
      id,
      error: { code, message },
    };
    const status = code === -32700 || code === -32600 || code === -32602 ? 400 : 500;
    return new Response(JSON.stringify(errorBody), {
      status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }
}
