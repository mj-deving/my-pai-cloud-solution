// format.ts — Compact mobile-friendly response formatter
// Strips Algorithm verbosity for Telegram/email, preserves key content

// Strip PAI Algorithm formatting for compact mobile output
export function compactFormat(raw: string): string {
  let text = raw;

  // Remove Algorithm header lines
  text = text.replace(
    /♻︎ Entering the PAI ALGORITHM.*═+\n?/g,
    "",
  );
  text = text.replace(/━━━ .+ ━━━ \d+\/\d+\n?/g, "");

  // Remove voice curl lines
  text = text.replace(/`curl -s -X POST http:\/\/localhost:8888.*`\n?/g, "");

  // Remove ISC quality gate blocks
  text = text.replace(
    /🔒 \*\*I(?:DEAL STATE CRITERIA|SC) QUALITY GATE.*?GATE:.*?\n/gs,
    "",
  );

  // Remove capability audit blocks
  text = text.replace(/⚒️ CAPABILITY AUDIT.*?Scan:.*?\n/gs, "");

  // Remove task list display markers
  text = text.replace(/\[INVOKE TaskList.*?\]\n?/g, "");
  text = text.replace(/\[INVOKE TaskCreate.*?\]\n?/g, "");
  text = text.replace(/\[INVOKE TaskUpdate.*?\]\n?/g, "");

  // Remove time check lines
  text = text.replace(/⏱️ TIME CHECK:.*\n?/g, "");
  text = text.replace(/⏱️ FINAL TIME:.*\n?/g, "");

  // Remove blank line runs (3+ → 2)
  text = text.replace(/\n{3,}/g, "\n\n");

  // Trim
  text = text.trim();

  // Remove Algorithm phase content that's not user-facing
  // (OBSERVE reverse engineering, THINK pressure test, PLAN strategy, etc.)
  text = text.replace(/🔎 \*\*REVERSE ENGINEERING\*\*[\s\S]*?(?=\n##|\n━━━|\n🗣️|$)/g, "");
  text = text.replace(/🔬 \*\*PRESSURE TEST\*\*[\s\S]*?(?=\n##|\n━━━|\n🗣️|$)/g, "");
  text = text.replace(/📋 \*\*PLAN MODE[\s\S]*?(?=\n##|\n━━━|\n🗣️|$)/g, "");
  text = text.replace(/📋 \*\*PREREQUISITE[\s\S]*?(?=\n##|\n━━━|\n🗣️|$)/g, "");
  text = text.replace(/📋 \*\*EXECUTION STRATEGY[\s\S]*?(?=\n##|\n━━━|\n🗣️|$)/g, "");
  text = text.replace(/📋 \*\*FILE-EDIT MANIFEST[\s\S]*?(?=\n##|\n━━━|\n🗣️|$)/g, "");
  text = text.replace(/🔍 \*\*VERIFICATION PLAN[\s\S]*?(?=\n##|\n━━━|\n🗣️|$)/g, "");
  text = text.replace(/🔍 \*\*ALGORITHM REFLECTION[\s\S]*?(?=\n##|\n━━━|\n🗣️|$)/g, "");
  text = text.replace(/📝 \*\*ISC MUTATIONS[\s\S]*?(?=\n##|\n━━━|\n🗣️|$)/g, "");
  text = text.replace(/🔍 \*\*MECHANICAL VERIFICATION[\s\S]*?(?=\n##|\n━━━|\n🗣️|$)/g, "");
  text = text.replace(/📝 \*\*LEARNING:[\s\S]*?(?=\n🗣️|$)/g, "");

  // Remove TASK line (already shown as context)
  text = text.replace(/🗒️ TASK:.*\n?/g, "");

  // Remove blank line runs again after all stripping
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.trim();

  // Note: don't truncate here — let chunkMessage() handle splitting
  // for Telegram's 4096 char limit. Preserving full content > losing it.

  return text;
}

// Extract the most relevant content sections from a full Algorithm response
function extractKeyContent(text: string): string | null {
  const parts: string[] = [];

  // Extract TASK line
  const taskMatch = text.match(/🗒️ TASK: (.+)/);
  if (taskMatch) parts.push(`**${taskMatch[1]}**`);

  // Extract voice summary
  const voiceMatch = text.match(/🗣️ Isidore(?:\s+Cloud)?: (.+)/);
  if (voiceMatch?.[1]) parts.push(voiceMatch[1]);

  // Extract any code blocks
  const codeBlocks = text.match(/```[\s\S]*?```/g);
  if (codeBlocks) {
    parts.push(...codeBlocks.slice(0, 2)); // Max 2 code blocks
  }

  return parts.length > 0 ? parts.join("\n\n") : null;
}

// Chunk a message into Telegram-safe pieces (< maxSize chars)
export function chunkMessage(text: string, maxSize: number): string[] {
  if (text.length <= maxSize) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxSize) {
      chunks.push(remaining);
      break;
    }

    // Try to break at a paragraph boundary
    let breakPoint = remaining.lastIndexOf("\n\n", maxSize);
    if (breakPoint < maxSize * 0.3) {
      // If paragraph break is too early, try line break
      breakPoint = remaining.lastIndexOf("\n", maxSize);
    }
    if (breakPoint < maxSize * 0.3) {
      // Last resort: break at space
      breakPoint = remaining.lastIndexOf(" ", maxSize);
    }
    if (breakPoint < 1) {
      // Absolute last resort: hard break
      breakPoint = maxSize;
    }

    chunks.push(remaining.slice(0, breakPoint));
    remaining = remaining.slice(breakPoint).trimStart();
  }

  // Add part indicators if multiple chunks
  if (chunks.length > 1) {
    return chunks.map((c, i) => `[${i + 1}/${chunks.length}]\n${c}`);
  }
  return chunks;
}
