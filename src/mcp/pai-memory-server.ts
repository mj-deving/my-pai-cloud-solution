#!/usr/bin/env bun
// mcp/pai-memory-server.ts — MCP server exposing memory.db operations
// Runs as a child process of Claude Code via .mcp.json configuration.
// Part of PAI Cloud Evolution Session 1.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { SummaryDAG } from "../summary-dag";
import { MemoryToolHandlers } from "./memory-tools";
import { resolveDbPath, buildMcpConfig } from "./shared";

const config = buildMcpConfig();
const dbPath = resolveDbPath(config);
const dag = new SummaryDAG(dbPath);
const handlers = new MemoryToolHandlers(dag);

const server = new Server(
  { name: "pai-memory", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "memory_store",
      description: "Record an episode to PAI memory",
      inputSchema: {
        type: "object" as const,
        properties: {
          content: { type: "string", description: "Episode content" },
          source: { type: "string", description: "Source: telegram, pipeline, etc." },
          role: { type: "string", description: "Role: user, assistant, system" },
          importance: { type: "number", description: "Importance 1-10 (default: 5)" },
          project: { type: "string", description: "Project name (optional)" },
        },
        required: ["content", "source", "role"],
      },
    },
    {
      name: "memory_recall",
      description: "Search PAI memory via keyword (FTS5)",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: { type: "string", description: "Search query" },
          project: { type: "string", description: "Filter by project (optional)" },
        },
        required: ["query"],
      },
    },
    {
      name: "memory_search",
      description: "Scored search of PAI memory (recency + importance + relevance)",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: { type: "string", description: "Search query" },
          maxResults: { type: "number", description: "Max results (default: 10)" },
          maxTokens: { type: "number", description: "Max tokens (default: 2000)" },
          project: { type: "string", description: "Filter by project (optional)" },
        },
        required: ["query"],
      },
    },
    {
      name: "memory_summarize",
      description: "Summarize a set of episodes (requires summarizer — returns placeholder if not wired)",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: { type: "string", description: "Topic to summarize around" },
          maxTokens: { type: "number", description: "Summary budget in tokens" },
        },
        required: ["query"],
      },
    },
    {
      name: "memory_expand",
      description: "Expand a DAG summary to its source episodes",
      inputSchema: {
        type: "object" as const,
        properties: {
          summaryId: { type: "number", description: "Summary ID to expand" },
        },
        required: ["summaryId"],
      },
    },
    {
      name: "memory_whiteboard_read",
      description: "Read a project whiteboard",
      inputSchema: {
        type: "object" as const,
        properties: {
          project: { type: "string", description: "Project name" },
        },
        required: ["project"],
      },
    },
    {
      name: "memory_whiteboard_write",
      description: "Write to a project whiteboard",
      inputSchema: {
        type: "object" as const,
        properties: {
          project: { type: "string", description: "Project name" },
          content: { type: "string", description: "Whiteboard content" },
        },
        required: ["project", "content"],
      },
    },
    {
      name: "memory_stats",
      description: "Get PAI memory statistics",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
  ],
}));

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "memory_store": {
        const result = await handlers.store({
          content: args!.content as string,
          source: args!.source as string,
          role: args!.role as string,
          importance: args?.importance as number | undefined,
          project: args?.project as string | undefined,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      }
      case "memory_recall": {
        const result = await handlers.recall({
          query: args!.query as string,
          project: args?.project as string | undefined,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      }
      case "memory_search": {
        const result = await handlers.search({
          query: args!.query as string,
          maxResults: args?.maxResults as number | undefined,
          maxTokens: args?.maxTokens as number | undefined,
          project: args?.project as string | undefined,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      }
      case "memory_summarize": {
        // Summarize tool — queries memory, then returns episodes for now
        // Full summarizer integration requires wiring deps at bridge level
        const searchResult = await handlers.search({
          query: args!.query as string,
          maxTokens: args?.maxTokens as number | undefined,
        });
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              note: "Summarizer not wired in standalone MCP mode. Returning raw episodes.",
              episodes: searchResult.episodes,
              totalTokens: searchResult.totalTokens,
            }),
          }],
        };
      }
      case "memory_expand": {
        const result = await handlers.expand({
          summaryId: args!.summaryId as number,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      }
      case "memory_whiteboard_read": {
        const result = await handlers.whiteboardRead({
          project: args!.project as string,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      }
      case "memory_whiteboard_write": {
        const result = await handlers.whiteboardWrite({
          project: args!.project as string,
          content: args!.content as string,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      }
      case "memory_stats": {
        const result = await handlers.stats();
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

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[pai-memory] MCP server started");
}

main().catch((err) => {
  console.error("[pai-memory] Fatal:", err);
  process.exit(1);
});
