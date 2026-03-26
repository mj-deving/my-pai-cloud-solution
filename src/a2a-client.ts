// a2a-client.ts — A2A protocol client for outbound agent communication
// Discovers agents via /.well-known/agent-card.json, sends messages via JSON-RPC 2.0

import { z } from "zod";
import type { Config } from "./config";

// Zod schemas for runtime validation of external JSON
const AgentCardSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  url: z.string(),
  version: z.string(),
  capabilities: z.object({
    streaming: z.boolean(),
    pushNotifications: z.boolean(),
  }),
  skills: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      description: z.string(),
    }),
  ),
  authentication: z.object({
    schemes: z.array(z.string()),
  }),
});

type AgentCard = z.infer<typeof AgentCardSchema>;

const JsonRpcErrorSchema = z.object({
  code: z.number(),
  message: z.string(),
});

const JsonRpcResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  result: z.record(z.string(), z.unknown()).optional(),
  error: JsonRpcErrorSchema.optional(),
});

interface A2AClientResponse {
  success: boolean;
  result?: string;
  error?: string;
  taskId?: string;
}

export class A2AClient {
  private discoveredAgents: Map<string, AgentCard> = new Map();

  constructor(private config: Config) {}

  /** Discover an agent by fetching its agent card. Validates response via Zod. */
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
      const rawCard = await response.json();
      const parseResult = AgentCardSchema.safeParse(rawCard);
      if (!parseResult.success) {
        console.warn(
          `[a2a-client] Invalid agent card from ${baseUrl}: ${parseResult.error.issues[0]?.message}`,
        );
        return null;
      }
      const card = parseResult.data;
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

  /** Send a message to a remote agent via A2A protocol. Validates JSON-RPC response. */
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

      // Validate JSON-RPC response structure
      const rawResult = await response.json();
      const parseResult = JsonRpcResponseSchema.safeParse(rawResult);
      if (!parseResult.success) {
        return {
          success: false,
          error: `Malformed JSON-RPC response: ${parseResult.error.issues[0]?.message}`,
        };
      }
      const parsed = parseResult.data;

      if (parsed.error) {
        return {
          success: false,
          error: `${parsed.error.code}: ${parsed.error.message}`,
        };
      }

      if (!parsed.result) {
        return {
          success: false,
          error: "No result in JSON-RPC response",
        };
      }

      // Extract text from A2A response artifacts
      const artifacts = Array.isArray(parsed.result.artifacts)
        ? parsed.result.artifacts
        : [];
      const textParts = artifacts
        .flatMap((a: any) =>
          Array.isArray(a.parts) ? a.parts : [],
        )
        .filter((p: any) => p.type === "text" && p.text)
        .map((p: any) => p.text as string);

      return {
        success: true,
        result: textParts.join("\n") || JSON.stringify(parsed.result),
        taskId: parsed.result.id as string | undefined,
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
