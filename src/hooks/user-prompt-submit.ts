#!/usr/bin/env bun
// user-prompt-submit.ts — Claude Code UserPromptSubmit hook
// Injects memory context into Claude's prompt via additionalContext.
//
// Reads from stdin: { session_id, user_message }
// Writes to stdout: { additionalContext: "..." } or {}
//
// TRIGGER: UserPromptSubmit
// DESIGN: Fail-open — errors produce {} (no context), never block the prompt.

import { queryMemory, formatContext, resolveDbPath } from "./memory-query";

async function main() {
  try {
    const input = JSON.parse(await Bun.stdin.text());
    const message = input.user_message || "";

    if (!message) {
      console.log(JSON.stringify({}));
      process.exit(0);
    }

    const dbPath = resolveDbPath();

    // Check DB exists before querying
    const dbFile = Bun.file(dbPath);
    if (!(await dbFile.exists())) {
      console.error(`[user-prompt-submit] memory.db not found at ${dbPath}`);
      console.log(JSON.stringify({}));
      process.exit(0);
    }

    const episodes = queryMemory(message, { dbPath, maxResults: 10, maxChars: 5000 });

    if (episodes.length === 0) {
      console.log(JSON.stringify({}));
      process.exit(0);
    }

    const context = formatContext(episodes);
    console.log(JSON.stringify({ additionalContext: context }));
  } catch (err) {
    console.error(`[user-prompt-submit] Error: ${err}`);
    console.log(JSON.stringify({})); // Fail open
  }
}

main();
