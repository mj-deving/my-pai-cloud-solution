#!/usr/bin/env bun
// isidore-session — CLI helper for managing Isidore conversation sessions
// Usage: isidore-session <new|current|clear|list>

import { SessionManager } from "./session";

const sessionIdFile =
  process.env.SESSION_ID_FILE ||
  `${process.env.HOME}/.claude/active-session-id`;

const sessions = new SessionManager(sessionIdFile);

const command = process.argv[2];

switch (command) {
  case "new": {
    await sessions.newSession();
    console.log("Session cleared. Next Claude invocation starts fresh.");
    break;
  }

  case "current": {
    const id = await sessions.current();
    if (id) {
      console.log(id);
    } else {
      console.log("No active session");
      process.exit(1);
    }
    break;
  }

  case "clear": {
    await sessions.clear();
    console.log("Session cleared and archived. Next invocation starts fresh.");
    break;
  }

  case "list": {
    const { current, archived } = await sessions.list();
    console.log(`Current: ${current || "none"}`);
    if (archived.length > 0) {
      console.log(`\nArchived (${archived.length}):`);
      for (const a of archived) {
        console.log(`  ${a}`);
      }
    }
    break;
  }

  default:
    console.log(
      "Usage: isidore-session <new|current|clear|list>",
    );
    process.exit(1);
}
