// statusline.ts — Two-line statusline appended to every Telegram reply
// Shows mode, time, message count, context %, and episode count.

import type { BridgeMode } from "./mode";

export function formatStatusline(
  mode: BridgeMode,
  stats: {
    time: string;           // HH:MM
    messageCount: number;
    maxMessages?: number;   // workspace only
    contextPercent?: number; // if available
    episodeCount: number;
  },
): string {
  const modeIcon = mode.type === "workspace" ? "\u{1F3E0}" : "\u{1F4C1}";
  const modeName = mode.type === "workspace" ? "workspace" : mode.name;
  const msgStr = stats.maxMessages
    ? `msg ${stats.messageCount}/${stats.maxMessages}`
    : `msg ${stats.messageCount}`;
  const ctxStr = stats.contextPercent != null
    ? `ctx ${stats.contextPercent}%`
    : "";

  const line2Parts = [msgStr, ctxStr, `${stats.episodeCount}ep`].filter(Boolean);

  return [
    "\u2550\u2550 PAI \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550",
    `${modeIcon} ${modeName} \u00B7 ${stats.time}`,
    line2Parts.join(" \u00B7 "),
  ].join("\n");
}
