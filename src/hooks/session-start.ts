#!/usr/bin/env bun
// session-start.ts — Claude Code SessionStart hook
// Loads PAI identity and project context from memory.db at session start.
//
// Reads from stdin: { session_id, cwd }
// Writes to stdout: context string to inject (or empty string)
//
// TRIGGER: SessionStart
// DESIGN: Fail-open — errors are logged to stderr, empty output on failure.
//         Injects recent project episodes + knowledge entries.

import { Database } from "bun:sqlite";
import { queryMemory, formatContext, resolveDbPath } from "./memory-query";

interface SessionStartInput {
  session_id?: string;
  cwd?: string;
}

async function main() {
  try {
    const raw = await Bun.stdin.text();
    const input: SessionStartInput = JSON.parse(raw);
    const cwd = input.cwd || process.cwd();

    // Detect project from cwd (last path component)
    const projectName = cwd.split("/").pop() || "unknown";

    const dbPath = resolveDbPath();

    // Check DB exists
    const dbFile = Bun.file(dbPath);
    if (!(await dbFile.exists())) {
      console.error(`[session-start] memory.db not found at ${dbPath}`);
      console.log("");
      process.exit(0);
    }

    const sections: string[] = [];

    // Load recent project-scoped episodes
    const projectEpisodes = queryMemory(`project:${projectName}`, {
      dbPath,
      maxResults: 5,
      maxChars: 2000,
      project: projectName,
    });

    if (projectEpisodes.length > 0) {
      sections.push(`## Recent Project Context (${projectName})\n${formatContext(projectEpisodes)}`);
    }

    // Load recent knowledge entries (direct DB query for knowledge table)
    try {
      const db = new Database(dbPath, { readonly: true });
      try {
        const knowledge = db
          .query("SELECT domain, key, content FROM knowledge ORDER BY id DESC LIMIT 5")
          .all() as Array<{ domain: string; key: string; content: string }>;

        if (knowledge.length > 0) {
          const knowledgeText = knowledge
            .map((k) => `- [${k.domain}] ${k.key}: ${k.content.slice(0, 100)}`)
            .join("\n");
          sections.push(`## Recent Knowledge\n${knowledgeText}`);
        }
      } finally {
        db.close();
      }
    } catch (err) {
      console.error(`[session-start] Knowledge query error: ${err}`);
    }

    if (sections.length > 0) {
      console.log(sections.join("\n\n"));
    } else {
      console.log(""); // No context to inject
    }
  } catch (err) {
    console.error(`[session-start] Error: ${err}`);
    console.log(""); // Fail open
  }
}

main();
