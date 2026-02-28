// prd-parser.ts — V2-D: Extracts structured PRD from freeform text via Claude one-shot
// Used by PRDExecutor to decompose user messages into actionable plans.

import type { ClaudeInvoker } from "./claude";
import { safeParse, ParsedPRDSchema, type ParsedPRD } from "./schemas";

const PARSE_PROMPT = `You are a PRD parser. Extract a structured PRD from the following text.
Return ONLY valid JSON matching this schema:
{
  "title": "short title",
  "description": "1-2 sentence summary",
  "project": "project-name or null if ambiguous",
  "requirements": ["req1", "req2"],
  "constraints": ["constraint1"],
  "estimatedComplexity": "simple|medium|complex",
  "suggestedSteps": [
    {"description": "step desc", "assignee": "isidore|gregor|ask", "dependsOn": []}
  ]
}

Rules:
- simple: 1-3 steps, single file/feature
- medium: 4-10 steps, multiple files
- complex: 10+ steps, architectural changes
- assignee "isidore" for code/analysis, "gregor" for infrastructure/deployment, "ask" if unclear
- dependsOn references other step indices as strings ("0", "1", etc.)

Text to parse:
`;

export class PRDParser {
  constructor(private claude: ClaudeInvoker) {}

  /** Parse freeform text into a structured PRD via Claude one-shot. */
  async parse(text: string): Promise<{ prd: ParsedPRD | null; error?: string }> {
    try {
      const response = await this.claude.oneShot(PARSE_PROMPT + text);

      if (response.error) {
        return { prd: null, error: response.error };
      }

      // Extract JSON from response (Claude may wrap in markdown code blocks)
      const jsonStr = this.extractJson(response.result);
      if (!jsonStr) {
        return { prd: null, error: "No JSON found in Claude response" };
      }

      const result = safeParse(ParsedPRDSchema, jsonStr, "prd-parser");
      if (!result.success) {
        return { prd: null, error: `Schema validation failed: ${result.error}` };
      }

      return { prd: result.data };
    } catch (err) {
      return { prd: null, error: `Parse error: ${err}` };
    }
  }

  private extractJson(text: string): string | null {
    // Try to find JSON in code blocks first
    const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (codeBlockMatch?.[1]) {
      return codeBlockMatch[1].trim();
    }

    // Try to find raw JSON object
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch?.[0]) {
      return jsonMatch[0];
    }

    return null;
  }
}
