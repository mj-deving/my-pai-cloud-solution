// synthesis.ts — Phase C: Knowledge synthesis loop
// Periodically distills recent episodic memory into reusable knowledge entries.
// Groups episodes by source domain, calls Claude one-shot to extract patterns,
// and writes distilled knowledge back to MemoryStore.

import { Database } from "bun:sqlite";
import type { Config } from "./config";
import type { MemoryStore } from "./memory";
import type { ClaudeInvoker } from "./claude";
import type { Episode } from "./schemas";

export interface SynthesisResult {
  domainsProcessed: number;
  entriesDistilled: number;
  skippedDomains: string[];
  errors: string[];
}

export interface SynthesisStats {
  lastRun: string | null;
  totalRuns: number;
  totalEntriesDistilled: number;
}

interface PolicyEngineLike {
  check(action: string, context: Record<string, unknown>): Promise<{ allowed: boolean; reason: string }>;
}

export class SynthesisLoop {
  private db: Database;
  private policyEngine: PolicyEngineLike | null = null;
  private notifyCallback: ((msg: string) => Promise<void>) | null = null;

  constructor(
    private config: Config,
    private memoryStore: MemoryStore,
    private claude: ClaudeInvoker,
  ) {
    this.db = new Database(config.memoryDbPath);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA busy_timeout=5000");
    this.initStateTable();
  }

  /** Wire policy engine after construction (optional). */
  setPolicyEngine(engine: PolicyEngineLike): void {
    this.policyEngine = engine;
  }

  /** Wire notification callback after construction (optional). */
  setNotifyCallback(cb: (msg: string) => Promise<void>): void {
    this.notifyCallback = cb;
  }

  private initStateTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS synthesis_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
  }

  private getState(key: string): string | null {
    const row = this.db
      .query("SELECT value FROM synthesis_state WHERE key = ?")
      .get(key) as { value: string } | null;
    return row?.value ?? null;
  }

  private setState(key: string, value: string): void {
    this.db
      .query("INSERT OR REPLACE INTO synthesis_state (key, value) VALUES (?, ?)")
      .run(key, value);
  }

  /** Get synthesis statistics. */
  getStats(): SynthesisStats {
    return {
      lastRun: this.getState("lastRunTimestamp"),
      totalRuns: parseInt(this.getState("totalRuns") || "0", 10),
      totalEntriesDistilled: parseInt(this.getState("totalEntriesDistilled") || "0", 10),
    };
  }

  /** Run one synthesis cycle. */
  async run(): Promise<SynthesisResult> {
    const result: SynthesisResult = {
      domainsProcessed: 0,
      entriesDistilled: 0,
      skippedDomains: [],
      errors: [],
    };

    // Step 1: Policy check
    if (this.policyEngine) {
      const check = await this.policyEngine.check("synthesis.run", {});
      if (!check.allowed) {
        console.log(`[synthesis] Policy denied synthesis.run: ${check.reason}`);
        return result;
      }
    }

    // Step 2: Read last synthesized episode ID
    const lastSynthesizedId = parseInt(this.getState("lastSynthesizedId") || "0", 10);

    // Step 3: Fetch episodes since last synthesis
    const episodes = this.memoryStore.getEpisodesSince(lastSynthesizedId);
    if (episodes.length === 0) {
      console.log("[synthesis] No new episodes to synthesize");
      return result;
    }

    console.log(`[synthesis] Found ${episodes.length} new episodes since ID ${lastSynthesizedId}`);

    // Step 4: Group episodes by source domain
    const domainMap = new Map<string, Episode[]>();
    for (const ep of episodes) {
      const domain = ep.source; // "pipeline", "orchestrator", "telegram", etc.
      const existing = domainMap.get(domain) || [];
      existing.push(ep);
      domainMap.set(domain, existing);
    }

    // Step 5-6: Process each domain
    let maxEpisodeId = lastSynthesizedId;
    for (const [domain, domainEpisodes] of domainMap) {
      // Track the max episode ID across all domains
      for (const ep of domainEpisodes) {
        if (ep.id !== undefined && ep.id > maxEpisodeId) {
          maxEpisodeId = ep.id;
        }
      }

      // Step 5: Skip domains with too few episodes
      if (domainEpisodes.length < this.config.synthesisMinEpisodes) {
        result.skippedDomains.push(domain);
        console.log(`[synthesis] Skipping domain "${domain}" — only ${domainEpisodes.length} episodes (min: ${this.config.synthesisMinEpisodes})`);
        continue;
      }

      try {
        // Step 6a: Get existing knowledge for this domain
        const existingKnowledge = this.memoryStore.getKnowledgeByDomain(domain);

        // Step 6b: Build synthesis prompt
        const prompt = this.buildPrompt(domain, existingKnowledge, domainEpisodes);

        // Step 6c: Call Claude one-shot
        console.log(`[synthesis] Synthesizing domain "${domain}" (${domainEpisodes.length} episodes)`);
        const response = await this.claude.oneShot(prompt);

        if (response.error) {
          result.errors.push(`${domain}: Claude error — ${response.error}`);
          continue;
        }

        // Step 6d: Parse JSON array from response
        const entries = this.parseEntries(response.result);
        if (entries === null) {
          result.errors.push(`${domain}: Failed to parse JSON array from Claude response`);
          continue;
        }

        // Step 6e: Write each entry to memory store
        const episodeIds = domainEpisodes
          .map(ep => ep.id)
          .filter((id): id is number => id !== undefined);

        for (const entry of entries) {
          await this.memoryStore.distill(
            domain,
            entry.key,
            entry.content,
            episodeIds,
            entry.confidence,
          );
          result.entriesDistilled++;
        }

        result.domainsProcessed++;
        console.log(`[synthesis] Domain "${domain}": distilled ${entries.length} knowledge entries`);
      } catch (err) {
        result.errors.push(`${domain}: ${err}`);
      }
    }

    // Step 7: Update lastSynthesizedId
    this.setState("lastSynthesizedId", String(maxEpisodeId));

    // Step 8: Update lastRunTimestamp
    this.setState("lastRunTimestamp", new Date().toISOString());

    // Step 9: Increment totalRuns and totalEntriesDistilled
    const prevRuns = parseInt(this.getState("totalRuns") || "0", 10);
    this.setState("totalRuns", String(prevRuns + 1));

    const prevDistilled = parseInt(this.getState("totalEntriesDistilled") || "0", 10);
    this.setState("totalEntriesDistilled", String(prevDistilled + result.entriesDistilled));

    // Step 10: Record a synthesis episode
    const summaryContent = `Synthesis run: ${result.domainsProcessed} domains processed, ${result.entriesDistilled} entries distilled. Skipped: ${result.skippedDomains.join(", ") || "none"}. Errors: ${result.errors.length}`;
    await this.memoryStore.record({
      timestamp: new Date().toISOString(),
      source: "synthesis",
      role: "system",
      content: summaryContent,
      summary: `Synthesized ${result.entriesDistilled} knowledge entries from ${result.domainsProcessed} domains`,
    });

    // Step 11: Notify if callback is set
    if (this.notifyCallback) {
      const notifyMsg = `Synthesis complete: ${result.domainsProcessed} domains, ${result.entriesDistilled} entries distilled${result.errors.length > 0 ? `, ${result.errors.length} errors` : ""}`;
      try {
        await this.notifyCallback(notifyMsg);
      } catch (err) {
        console.warn(`[synthesis] Notify callback failed: ${err}`);
      }
    }

    console.log(`[synthesis] Run complete: ${result.domainsProcessed} domains, ${result.entriesDistilled} entries, ${result.errors.length} errors`);

    // Step 12: Return result
    return result;
  }

  private buildPrompt(
    domain: string,
    existingKnowledge: Array<{ key: string; content: string; confidence: number }>,
    episodes: Episode[],
  ): string {
    return `You are synthesizing knowledge from recent system episodes.

Domain: ${domain}

Existing knowledge for this domain:
${existingKnowledge.map(k => `- [${k.key}] ${k.content}`).join("\n") || "(none)"}

New episodes to synthesize:
${episodes.map(ep => `[${ep.timestamp}] ${ep.content.slice(0, 300)}`).join("\n\n")}

Distill reusable knowledge from these episodes. Output ONLY a JSON array of objects, each with:
- "key": short identifier (kebab-case, e.g. "pipeline-timeout-pattern")
- "content": the knowledge (1-3 sentences)
- "confidence": how confident (0.0-1.0)

Rules:
- Do not repeat existing knowledge entries (check the keys above)
- Focus on patterns, decisions, and lessons — skip trivial observations
- If no meaningful knowledge can be extracted, return an empty array []`;
  }

  private parseEntries(text: string): Array<{ key: string; content: string; confidence: number }> | null {
    // Find the JSON array in the response text
    const arrayMatch = text.match(/\[[\s\S]*\]/);
    if (!arrayMatch) {
      // Could be an empty response — check for empty array
      if (text.includes("[]")) return [];
      return null;
    }

    try {
      const parsed = JSON.parse(arrayMatch[0]);
      if (!Array.isArray(parsed)) return null;

      // Validate each entry has the required fields
      return parsed.filter(
        (entry: unknown): entry is { key: string; content: string; confidence: number } =>
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as Record<string, unknown>).key === "string" &&
          typeof (entry as Record<string, unknown>).content === "string" &&
          typeof (entry as Record<string, unknown>).confidence === "number",
      );
    } catch {
      return null;
    }
  }

  /** Close the synthesis state database connection. */
  close(): void {
    this.db.close();
    console.log("[synthesis] State DB closed");
  }
}
