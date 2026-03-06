// format.ts — Response formatter for Telegram output
// Two modes: "light" (default) strips noise only, "raw" passes through unmodified

export type FormatMode = "light" | "raw";

let currentMode: FormatMode = "light";

export function getFormatMode(): FormatMode {
  return currentMode;
}

export function setFormatMode(mode: FormatMode): void {
  currentMode = mode;
}

export function toggleFormatMode(): FormatMode {
  currentMode = currentMode === "light" ? "raw" : "light";
  return currentMode;
}

// Apply current format mode to a response
export function formatResponse(raw: string): string {
  if (currentMode === "raw") return raw.trim();
  return lightStrip(raw);
}

// Light strip — remove only noise, keep all meaningful content
function lightStrip(raw: string): string {
  let text = raw;

  // Remove voice curl lines (localhost voice API calls)
  text = text.replace(/`curl -s -X POST http:\/\/localhost:8888.*`\n?/g, "");

  // Remove ISC quality gate blocks
  text = text.replace(
    /🔒 \*\*I(?:DEAL STATE CRITERIA|SC) QUALITY GATE.*?GATE:.*?\n/gs,
    "",
  );

  // Remove capability audit blocks
  text = text.replace(/⚒️ CAPABILITY AUDIT.*?Scan:.*?\n/gs, "");

  // Remove task tool invoke markers
  text = text.replace(/\[INVOKE TaskList.*?\]\n?/g, "");
  text = text.replace(/\[INVOKE TaskCreate.*?\]\n?/g, "");
  text = text.replace(/\[INVOKE TaskUpdate.*?\]\n?/g, "");

  // Remove time check lines
  text = text.replace(/⏱️ TIME CHECK:.*\n?/g, "");
  text = text.replace(/⏱️ FINAL TIME:.*\n?/g, "");

  // Collapse blank line runs (3+ → 2)
  text = text.replace(/\n{3,}/g, "\n\n");

  return text.trim();
}

// Escape special characters for Telegram Markdown (v1) in untrusted text
export function escMd(text: string): string {
  return text.replace(/([_*`\[])/g, "\\$1");
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
