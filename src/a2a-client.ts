// a2a-client.ts — A2A protocol client for outbound agent communication
// Discovers agents via /.well-known/agent-card.json, sends messages via JSON-RPC 2.0

import type { Config } from "./config";

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

interface A2AClientResponse {
  success: boolean;
  result?: string;
  error?: string;
  taskId?: string;
}

export class A2AClient {
  private discoveredAgents: Map<string, AgentCard> = new Map();

  constructor(private config: Config) {}

  /** Discover an agent by fetching its agent card. */
  async discover(baseUrl: string): Promise<AgentCard | null> {
    const cardUrl = `${baseUrl.replace(/\/$/, "")}/.well-known/agent-card.json`;
    try {
      const response = await fetch(cardUrl);
      if (!response.ok) {
        console.warn(
          `[a2a-client] Agent card fetch failed: ${response.status} from ${cardUrl}`,
        );
        return null;
      }
      const card = (await response.json()) as AgentCard;
      this.discoveredAgents.set(baseUrl, card);
      console.log(
        `[a2a-client] Discovered agent: ${card.name} at ${baseUrl}`,
      );
      return card;
    } catch (err) {
      console.warn(
        `[a2a-client] Failed to discover agent at ${baseUrl}: ${err}`,
      );
      return null;
    }
  }

  /** Send a message to a remote agent via A2A protocol. */
  async send(
    baseUrl: string,
    message: string,
    options?: {
      token?: string;
      timeout?: number;
      metadata?: Record<string, unknown>;
    },
  ): Promise<A2AClientResponse> {
    const url = `${baseUrl.replace(/\/$/, "")}/a2a/message/send`;
    const requestId = crypto.randomUUID();

    const body = {
      jsonrpc: "2.0" as const,
      id: requestId,
      method: "message/send",
      params: {
        message: {
          role: "user" as const,
          parts: [{ type: "text" as const, text: message }],
        },
        ...(options?.metadata && { metadata: options.metadata }),
      },
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (options?.token) {
      headers["Authorization"] = `Bearer ${options.token}`;
    }

    try {
      const controller = new AbortController();
      const timeout = options?.timeout ?? 30_000;
      const timer = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        return {
          success: false,
          error: `HTTP ${response.status}: ${text.slice(0, 200)}`,
        };
      }

      const result = (await response.json()) as Record<string, unknown>;

      if (result.error) {
        const err = result.error as { message?: string; code?: number };
        return {
          success: false,
          error: err.message || "Unknown JSON-RPC error",
        };
      }

      // Extract text from A2A response
      const taskResult = result.result as
        | Record<string, unknown>
        | undefined;
      const artifacts = taskResult?.artifacts as
        | Array<{ parts: Array<{ type: string; text: string }> }>
        | undefined;
      const textParts =
        artifacts
          ?.flatMap((a) => a.parts)
          .filter((p) => p.type === "text")
          .map((p) => p.text) ?? [];

      return {
        success: true,
        result: textParts.join("\n") || JSON.stringify(result.result),
        taskId: taskResult?.id as string | undefined,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("abort")) {
        return {
          success: false,
          error: `Timeout after ${options?.timeout ?? 30_000}ms`,
        };
      }
      return { success: false, error: msg };
    }
  }

  /** Get all discovered agents. */
  getDiscoveredAgents(): Map<string, AgentCard> {
    return new Map(this.discoveredAgents);
  }

  /** Get stats. */
  getStats(): { discoveredAgents: number } {
    return { discoveredAgents: this.discoveredAgents.size };
  }
}
