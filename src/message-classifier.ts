// message-classifier.ts — Route messages to direct API or Claude CLI
// Pure function, no dependencies. Testable in isolation.

import type { BridgeMode } from "./mode";

export type MessageRoute = "direct" | "cli";

// Developer keywords that indicate complex work requiring CLI
const CLI_KEYWORDS = /\b(git|code|debug|refactor|deploy|fix|test|build|review|merge|branch|commit|push|pull|error|bug|crash|log|implement|create|delete|remove|add|update|modify|edit|write|read|check|verify|analyze|investigate|diagnose|pipeline|schema|config|hook|migration|release|upgrade|revert)\b/i;

// File/path references that indicate code work
const PATH_PATTERNS = /(?:src\/|\.ts\b|\.md\b|\.json\b|\.yaml\b|\.sh\b|~\/|\/home\/|node_modules|package\.json|tsconfig|\.env)/i;

// Explicit requests to use full CLI
const CLI_EXPLICIT = /\b(use claude|full mode|cli mode|algorithm|think deeply|deep analysis)\b/i;

/**
 * Classify a message as needing the full Claude CLI or the lightweight direct API.
 *
 * Priority order:
 * 1. Commands → cli
 * 2. Project mode → cli (needs file ops, git, working directory)
 * 3. Developer keywords → cli
 * 4. File/path references → cli
 * 5. Long messages (>300 chars) → cli
 * 6. Explicit CLI request → cli
 * 7. Everything else → direct
 */
export function classifyMessage(text: string, mode: BridgeMode): MessageRoute {
  const trimmed = text.trim();

  // 1. Commands always go to CLI
  if (trimmed.startsWith("/")) return "cli";

  // 2. Project mode always goes to CLI (needs file ops context)
  if (mode.type === "project") return "cli";

  // 3. Developer keywords
  if (CLI_KEYWORDS.test(trimmed)) return "cli";

  // 4. File/path references
  if (PATH_PATTERNS.test(trimmed)) return "cli";

  // 5. Long messages likely complex
  if (trimmed.length > 300) return "cli";

  // 6. Explicit CLI request
  if (CLI_EXPLICIT.test(trimmed)) return "cli";

  // 7. Everything else → direct (greetings, questions, general chat)
  return "direct";
}
