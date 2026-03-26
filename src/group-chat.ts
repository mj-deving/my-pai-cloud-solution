// group-chat.ts — GroupChatEngine: multi-agent group chat with moderator synthesis
// Dispatches question to N agents in parallel, moderator synthesizes final answer

import type { Config } from "./config";
import type { ClaudeInvoker } from "./claude";
import type { MemoryStore } from "./memory";
import type { AgentLoader } from "./agent-loader";

export interface GroupChatParticipant {
  name: string;
  systemPrompt?: string;
}

export interface GroupChatResponse {
  question: string;
  participants: string[];
  responses: Array<{
    agent: string;
    response: string;
    error?: string;
  }>;
  synthesis: string;
  moderator: string;
}

export class GroupChatEngine {
  private maxAgents: number;

  constructor(
    private config: Config,
    private claude: ClaudeInvoker,
    private memoryStore: MemoryStore | null,
    private agentLoader: AgentLoader | null,
  ) {
    this.maxAgents = config.groupChatMaxAgents;
  }

  /**
   * Run a group chat: dispatch question to participants, collect responses,
   * synthesize via moderator.
   */
  async chat(
    question: string,
    participants: GroupChatParticipant[],
    options?: { moderatorPrompt?: string; project?: string }
  ): Promise<GroupChatResponse> {
    // Cap participants
    const capped = participants.slice(0, this.maxAgents);

    // Phase 1: Dispatch to all agents in parallel
    const responsePromises = capped.map(async (participant) => {
      try {
        const prompt = participant.systemPrompt
          ? `${participant.systemPrompt}\n\nQuestion: ${question}`
          : question;

        const result = await this.claude.oneShot(prompt);
        return {
          agent: participant.name,
          response: result.result || "No response",
          error: result.error || undefined,
        };
      } catch (err) {
        return {
          agent: participant.name,
          response: "",
          error: err instanceof Error ? err.message : String(err),
        };
      }
    });

    const responses = await Promise.all(responsePromises);

    // Phase 2: Moderator synthesis
    const moderatorName = "moderator";
    const moderatorSystemPrompt = options?.moderatorPrompt ||
      "You are a moderator synthesizing responses from multiple AI agents. " +
      "Identify areas of agreement, note disagreements, and produce a clear, " +
      "balanced final answer. Be concise and action-oriented.";

    const responseSummary = responses
      .filter(r => r.response && !r.error)
      .map(r => `**${r.agent}:** ${r.response}`)
      .join("\n\n");

    const synthesisPrompt = `${moderatorSystemPrompt}\n\n` +
      `**Original question:** ${question}\n\n` +
      `**Agent responses:**\n\n${responseSummary}\n\n` +
      `Synthesize these responses into a clear final answer.`;

    let synthesis = "No synthesis available";
    try {
      const synthResult = await this.claude.oneShot(synthesisPrompt);
      synthesis = synthResult.result || synthesis;
    } catch (err) {
      synthesis = `Synthesis failed: ${err instanceof Error ? err.message : String(err)}`;
    }

    // Phase 3: Record to memory
    if (this.memoryStore) {
      const timestamp = new Date().toISOString();
      // Record each agent's response
      for (const resp of responses) {
        if (resp.response && !resp.error) {
          await this.memoryStore.record({
            timestamp,
            source: "group",
            project: options?.project ?? null,
            role: "assistant",
            content: resp.response.slice(0, 2000),
            summary: `${resp.agent}: ${resp.response.slice(0, 100)}`,
            importance: 5,
            user_id: resp.agent,
            channel: "group",
          });
        }
      }
      // Record synthesis
      await this.memoryStore.record({
        timestamp,
        source: "group",
        project: options?.project ?? null,
        role: "system",
        content: synthesis.slice(0, 2000),
        summary: `Group chat synthesis: ${question.slice(0, 80)}`,
        importance: 7,
        user_id: moderatorName,
        channel: "group",
      });
    }

    return {
      question,
      participants: capped.map(p => p.name),
      responses,
      synthesis,
      moderator: moderatorName,
    };
  }

  /** Get stats. */
  getStats(): { maxAgents: number } {
    return { maxAgents: this.maxAgents };
  }
}
