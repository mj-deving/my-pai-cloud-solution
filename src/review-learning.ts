// review-learning.ts — Parse Codex review findings and store as knowledge entries
// Closes the feedback loop: review → memory.db → context injection → better code

import type { MemoryStore } from "./memory";

export interface ReviewFinding {
  severity: "P0" | "P1" | "P2" | "P3";
  text: string;
  line: number; // 1-based line number in the review output
}

/**
 * Parse Codex review output for [P0]-[P3] severity markers.
 * Returns structured findings sorted by severity (P0 first).
 */
export function parseReviewFindings(reviewOutput: string): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  const lines = reviewOutput.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const match = line.match(/\[(P[0-3])\]/);
    if (match) {
      const severity = match[1] as ReviewFinding["severity"];
      let text = line.trim();
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j]!;
        if (!next.trim() || /\[P[0-3]\]/.test(next)) break;
        text += "\n" + next.trim();
      }
      findings.push({ severity, text, line: i + 1 });
    }
  }

  const order: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
  findings.sort((a, b) => (order[a.severity] ?? 0) - (order[b.severity] ?? 0));

  return findings;
}

/**
 * Store review findings as knowledge entries in memory.db.
 * Domain: "codex-review", key: "{severity}: {summary}"
 */
export async function storeReviewFindings(
  memoryStore: MemoryStore,
  findings: ReviewFinding[],
  context: { branch?: string; project?: string },
): Promise<number> {
  let stored = 0;
  for (const finding of findings) {
    const firstLine = (finding.text.split("\n")[0] ?? "").replace(/\[P[0-3]\]\s*/, "").trim();
    const summary = firstLine.length > 80 ? firstLine.slice(0, 77) + "..." : firstLine;
    const key = `${finding.severity}: ${summary}`;

    const content = [
      `Severity: ${finding.severity}`,
      context.branch ? `Branch: ${context.branch}` : null,
      context.project ? `Project: ${context.project}` : null,
      `Finding:\n${finding.text}`,
    ]
      .filter(Boolean)
      .join("\n");

    const confidenceMap: Record<string, number> = { P0: 1.0, P1: 0.9, P2: 0.7, P3: 0.5 };
    const confidence = confidenceMap[finding.severity] ?? 0.5;

    await memoryStore.distill("codex-review", key, content, [], confidence);
    stored++;
  }
  return stored;
}
