// statusline.ts — Statusline appended to every Telegram reply
// Shows mode, time, context bar, message count, git info, and episode count.

import type { BridgeMode } from "./mode";
import type { FormatMode } from "./format";

export interface GitInfo {
  branch: string;
  changed: number;   // modified/deleted
  untracked: number;  // new files
}

/** Build a text-based context bar: ████░░░░░░ 17% */
function contextBar(percent: number, width = 10): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;
  const filledStr = "\u2588".repeat(filled);   // █
  const emptyStr = "\u2591".repeat(empty);      // ░
  return `${filledStr}${emptyStr} ${clamped}%`;
}

export function formatStatusline(
  mode: BridgeMode,
  stats: {
    time: string;           // HH:MM
    messageCount: number;
    contextPercent?: number; // if available
    episodeCount: number;
    formatMode?: FormatMode; // light or raw
    git?: GitInfo;          // project mode only
  },
): string {
  const modeIcon = mode.type === "workspace" ? "\u{1F3E0}" : "\u{1F4C1}";
  const modeName = mode.type === "workspace" ? "workspace" : mode.name;

  // Line 1: mode · format · git info · time
  const line1Parts = [`${modeIcon} ${modeName}`];
  if (stats.formatMode === "raw") line1Parts.push("raw");
  if (stats.git) {
    const gitStr = `${stats.git.branch} ~${stats.git.changed} +${stats.git.untracked}`;
    line1Parts.push(gitStr);
  }
  line1Parts.push(stats.time);

  // Line 2: CTX bar · msg count · episode count
  const ctxStr = `CTX ${contextBar(stats.contextPercent ?? 0)}`;
  const line2Parts = [
    ctxStr,
    `msg ${stats.messageCount}`,
    `${stats.episodeCount}ep`,
  ].filter(Boolean);

  return [
    "\u2550\u2550 PAI \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550",
    line1Parts.join(" \u00B7 "),
    line2Parts.join(" \u00B7 "),
  ].join("\n");
}
