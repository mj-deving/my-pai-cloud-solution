#!/usr/bin/env bun
// stop.ts — Claude Code Stop hook for turn recording
// Writes the latest completed turn (user prompt + assistant response) into memory.db
// so Channels + native Claude Code sessions record conversations the same way the
// bridge's ClaudeInvoker.recordTurn() did.
//
// Move 1 of the bridge-retirement plan (beads my-pai-cloud-solution-25x).
// Reference: codenamev/claude_memory schema + disler/claude-code-hooks-multi-agent-observability
//
// Stdin shape: { session_id, transcript_path, stop_hook_active, hook_event_name }
// Stdout: {} (always — fail open, never block the turn)

import { Database } from "bun:sqlite";
import { readFileSync, existsSync } from "node:fs";
import { resolveDbPath } from "./memory-query";

export interface StopInput {
  session_id: string;
  transcript_path: string;
  stop_hook_active: boolean;
  hook_event_name?: string;
}

export interface Turn {
  user: string | null;
  assistant: string;
  toolUses: string[];
}

export function parseStopInput(raw: string): StopInput {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  return {
    session_id: String(parsed.session_id ?? ""),
    transcript_path: String(parsed.transcript_path ?? ""),
    stop_hook_active: Boolean(parsed.stop_hook_active ?? false),
    hook_event_name: parsed.hook_event_name as string | undefined,
  };
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((block) => (block as { type?: string }).type === "text")
      .map((block) => String((block as { text?: string }).text ?? ""))
      .join("\n")
      .trim();
  }
  return "";
}

function extractToolUses(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((block) => (block as { type?: string }).type === "tool_use")
    .map((block) => String((block as { name?: string }).name ?? ""))
    .filter(Boolean);
}

export function extractLastTurn(transcriptPath: string): Turn | null {
  if (!existsSync(transcriptPath)) return null;

  const lines = readFileSync(transcriptPath, "utf-8").split("\n").filter(Boolean);

  let lastAssistantContent: unknown = null;
  let lastUserContent: unknown = null;

  for (const line of lines) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = entry.type;
    const message = entry.message as { role?: string; content?: unknown } | undefined;
    if (!message) continue;

    if (type === "user" || message.role === "user") {
      lastUserContent = message.content;
      lastAssistantContent = null;
    } else if (type === "assistant" || message.role === "assistant") {
      lastAssistantContent = message.content;
    }
  }

  if (lastAssistantContent === null) return null;

  const assistantText = extractText(lastAssistantContent);
  const toolUses = extractToolUses(lastAssistantContent);
  const userText = lastUserContent !== null ? extractText(lastUserContent) : "";

  return {
    user: userText || null,
    assistant: assistantText,
    toolUses,
  };
}

const HIGH_VALUE_TOOLS = new Set(["Write", "Edit", "NotebookEdit"]);
const MEDIUM_VALUE_TOOLS = new Set(["Task", "WebFetch", "WebSearch", "Bash"]);

export function scoreTurnImportance(turn: Turn): number {
  let score = 3;

  const assistantLen = turn.assistant.length;
  if (assistantLen > 1500) score += 2;
  else if (assistantLen > 400) score += 1;

  for (const tool of turn.toolUses) {
    if (HIGH_VALUE_TOOLS.has(tool)) score += 3;
    else if (MEDIUM_VALUE_TOOLS.has(tool)) score += 1;
  }

  if (score < 1) score = 1;
  if (score > 10) score = 10;
  return score;
}

export function writeTurnEpisode(
  dbPath: string,
  turn: Turn,
  sessionId: string,
  project: string | null
): number {
  const timestamp = new Date().toISOString();
  const importance = scoreTurnImportance(turn);
  const toolSuffix = turn.toolUses.length > 0 ? ` [tools: ${turn.toolUses.join(", ")}]` : "";
  const content = turn.user
    ? `USER: ${turn.user}\nASSISTANT: ${turn.assistant}${toolSuffix}`
    : `ASSISTANT: ${turn.assistant}${toolSuffix}`;

  const db = new Database(dbPath);
  try {
    const result = db
      .query(
        `INSERT INTO episodes (timestamp, source, project, session_id, role, content, summary, metadata, importance, access_count, last_accessed)
         VALUES (?, 'channels', ?, ?, 'assistant', ?, NULL, NULL, ?, 0, ?)`
      )
      .run(timestamp, project, sessionId || null, content, importance, timestamp);
    return Number(result.lastInsertRowid);
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  try {
    const raw = await Bun.stdin.text();
    if (!raw.trim()) {
      console.log("{}");
      return;
    }

    const input = parseStopInput(raw);

    if (input.stop_hook_active) {
      console.log("{}");
      return;
    }

    const turn = extractLastTurn(input.transcript_path);
    if (!turn || !turn.assistant) {
      console.log("{}");
      return;
    }

    const dbPath = resolveDbPath();
    if (!existsSync(dbPath)) {
      console.error(`[stop-hook] memory.db not found at ${dbPath}`);
      console.log("{}");
      return;
    }

    const project = process.cwd().split("/").pop() || null;
    writeTurnEpisode(dbPath, turn, input.session_id, project);
  } catch (err) {
    console.error(`[stop-hook] Error: ${err}`);
  }
  console.log("{}");
}

if (import.meta.main) {
  void main();
}
