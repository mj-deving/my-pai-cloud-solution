// injection-scan.ts — Prompt injection detection for pipeline tasks
// Scans inbound prompts for common injection patterns (system override, role switching,
// data exfiltration). V1 is log-only — detects and warns but does not block dispatch.

export type RiskLevel = "none" | "low" | "medium" | "high";

export interface ScanResult {
  risk: RiskLevel;
  matched: string[];
}

// Pattern categories with associated risk levels
const PATTERNS: Array<{ regex: RegExp; label: string; risk: RiskLevel }> = [
  // System prompt overrides
  { regex: /ignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions|prompts|rules)/i, label: "system-override:ignore-previous", risk: "high" },
  { regex: /disregard\s+(all\s+)?(previous|prior|above)\s+(instructions|prompts)/i, label: "system-override:disregard", risk: "high" },
  { regex: /forget\s+(everything|all|your)\s+(instructions|rules|guidelines)/i, label: "system-override:forget", risk: "high" },
  { regex: /new\s+system\s+prompt/i, label: "system-override:new-system-prompt", risk: "high" },
  { regex: /override\s+(your|the|system)\s+(instructions|prompt|rules)/i, label: "system-override:override", risk: "high" },

  // Role switching
  { regex: /you\s+are\s+now\s+(a|an|the)\s/i, label: "role-switch:you-are-now", risk: "medium" },
  { regex: /act\s+as\s+(a|an|if|though)\s/i, label: "role-switch:act-as", risk: "low" },
  { regex: /pretend\s+(to\s+be|you\s+are)\s/i, label: "role-switch:pretend", risk: "medium" },
  { regex: /switch\s+to\s+(\w+)\s+mode/i, label: "role-switch:mode-switch", risk: "medium" },
  { regex: /enter\s+(developer|debug|admin|root|sudo)\s+mode/i, label: "role-switch:privileged-mode", risk: "high" },

  // Data exfiltration
  { regex: /send\s+(this|the|all|your)\s+(data|info|content|response|output)\s+to\s/i, label: "exfil:send-to", risk: "high" },
  { regex: /POST\s+https?:\/\//i, label: "exfil:http-post", risk: "medium" },
  { regex: /curl\s+.*https?:\/\//i, label: "exfil:curl", risk: "medium" },
  { regex: /fetch\s*\(\s*['"]https?:\/\//i, label: "exfil:fetch-call", risk: "medium" },
  { regex: /webhook\s*[=:]\s*['"]?https?:\/\//i, label: "exfil:webhook", risk: "high" },

  // Prompt leaking
  { regex: /repeat\s+(your|the)\s+(system\s+)?(prompt|instructions|rules)/i, label: "leak:repeat-prompt", risk: "medium" },
  { regex: /show\s+(me\s+)?(your|the)\s+(system\s+)?(prompt|instructions)/i, label: "leak:show-prompt", risk: "medium" },
  { regex: /what\s+(are|is)\s+your\s+(system\s+)?(prompt|instructions|rules)/i, label: "leak:what-are-instructions", risk: "low" },
];

/**
 * Scan a prompt for injection patterns.
 * Returns risk level (highest matched) and list of matched pattern labels.
 */
export function scanForInjection(text: string): ScanResult {
  const matched: string[] = [];
  let maxRisk: RiskLevel = "none";

  for (const pattern of PATTERNS) {
    if (pattern.regex.test(text)) {
      matched.push(pattern.label);
      if (riskOrder(pattern.risk) > riskOrder(maxRisk)) {
        maxRisk = pattern.risk;
      }
    }
  }

  return { risk: maxRisk, matched };
}

function riskOrder(risk: RiskLevel): number {
  switch (risk) {
    case "none": return 0;
    case "low": return 1;
    case "medium": return 2;
    case "high": return 3;
  }
}
