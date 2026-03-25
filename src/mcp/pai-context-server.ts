#!/usr/bin/env bun
// mcp/pai-context-server.ts — MCP server exposing context retrieval
// Runs as a child process of Claude Code via .mcp.json configuration.
// Part of PAI Cloud Evolution Session 1.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { SummaryDAG } from "../summary-dag";
import { ContextToolHandlers } from "./context-tools";
import { resolveDbPath, buildMcpConfig } from "./shared";

const config = buildMcpConfig();
const dbPath = resolveDbPath(config);
const dag = new SummaryDAG(dbPath);
const handlers = new ContextToolHandlers(dag, config);

const server = new Server(
  { name: "pai-context", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "context_suggest",
      description: "Suggest relevant context from PAI memory for a query",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: { type: "string", description: "Query to find relevant context for" },
          maxTokens: { type: "number", description: "Token budget (default: 2000)" },
          project: { type: "string", description: "Filter by project (optional)" },
        },
        required: ["query"],
      },
    },
    {
      name: "context_inject",
      description: "Build formatted context block for prompt injection",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: { type: "string", description: "Query to build context for" },
          project: { type: "string", description: "Filter by project (optional)" },
          maxTokens: { type: "number", description: "Token budget (default: 2000)" },
        },
        required: ["query"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "context_suggest": {
        const result = await handlers.suggest({
          query: args!.query as string,
          maxTokens: args?.maxTokens as number | undefined,
          project: args?.project as string | undefined,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      }
      case "context_inject": {
        const result = await handlers.inject({
          query: args!.query as string,
          project: args?.project as string | undefined,
          maxTokens: args?.maxTokens as number | undefined,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      }
      default:
        return {
          content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text" as const, text: `Error: ${msg}` }],
      isError: true,
    };
  }
});

// Graceful shutdown — checkpoint WAL on exit
process.on("SIGTERM", () => { dag.close(); process.exit(0); });
process.on("SIGINT", () => { dag.close(); process.exit(0); });

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[pai-context] MCP server started");
}

main().catch((err) => {
  console.error("[pai-context] Fatal:", err);
  dag.close();
  process.exit(1);
});
