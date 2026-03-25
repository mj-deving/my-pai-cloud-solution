#!/usr/bin/env bun
// post-tool-use.ts — Claude Code PostToolUse hook
// Records significant tool interactions in memory.db for future context.
//
// Reads from stdin: { session_id, tool_name, tool_input, tool_output }
// Writes to stdout: {} (no modification to tool result)
//
// TRIGGER: PostToolUse
// DESIGN: Fail-open — errors are logged to stderr, never block tool results.
//         Only stores episodes with importance >= 5 to reduce noise.

import { Database } from "bun:sqlite";
import { resolveDbPath } from "./memory-query";

interface ToolInput {
  session_id?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_output?: { stdout?: string; stderr?: string; [key: string]: unknown };
}

/**
 * Importance scoring heuristic for tool interactions.
 * Higher scores = more likely to be useful for future context.
 */
function scoreImportance(toolName: string, input: unknown, output: unknown): number {
  // Write/Edit operations are significant (code changes)
  if (toolName === "Write" || toolName === "Edit") return 7;

  // Bash with substantial output (likely meaningful command results)
  const out = output as { stdout?: string } | null;
  if (toolName === "Bash" && out?.stdout && out.stdout.length > 100) return 5;

  // Web operations (research, fetching external data)
  if (toolName === "WebSearch" || toolName === "WebFetch") return 6;

  // Task management operations
  if (toolName === "TaskCreate" || toolName === "TaskUpdate") return 5;

  // Default: low importance — not stored
  return 3;
}

/**
 * Truncate a value to a JSON string of at most maxLen characters.
 */
function truncateJson(value: unknown, maxLen: number): string {
  try {
    const json = JSON.stringify(value);
    return json.length > maxLen ? json.slice(0, maxLen) + "..." : json;
  } catch {
    return String(value).slice(0, maxLen);
  }
}

async function main() {
  try {
    const raw = await Bun.stdin.text();
    const input: ToolInput = JSON.parse(raw);
    const { tool_name, tool_input, tool_output, session_id } = input;

    if (!tool_name) {
      console.log(JSON.stringify({}));
      process.exit(0);
    }

    const importance = scoreImportance(tool_name, tool_input, tool_output);

    // Only store if importance >= 5 (reduces noise)
    if (importance >= 5) {
      const dbPath = resolveDbPath();

      // Check DB exists
      const dbFile = Bun.file(dbPath);
      if (!(await dbFile.exists())) {
        console.error(`[post-tool-use] memory.db not found at ${dbPath}`);
        console.log(JSON.stringify({}));
        process.exit(0);
      }

      const db = new Database(dbPath);
      try {
        const content = `[${tool_name}] ${truncateJson(tool_input, 200)} → ${truncateJson(tool_output, 300)}`;
        const summary = `Tool: ${tool_name}`;
        const timestamp = new Date().toISOString();

        db.run(
          `INSERT INTO episodes (timestamp, source, session_id, role, content, summary, importance)
           VALUES (?, 'telegram', ?, 'system', ?, ?, ?)`,
          [timestamp, session_id || null, content, summary, importance]
        );
      } finally {
        db.close();
      }
    }
  } catch (err) {
    console.error(`[post-tool-use] Error: ${err}`);
  }

  // Always output empty object (no modification to tool result)
  console.log(JSON.stringify({}));
}

main();
