// prd-executor.ts — V2-D: Autonomous PRD execution pipeline
// Detects PRDs, parses into structured plans, executes steps, reports progress.

import type { Config } from "./config";
import type { ClaudeInvoker } from "./claude";
import type { ProjectManager } from "./projects";
import type { MemoryStore } from "./memory";
import type { TaskOrchestrator } from "./orchestrator";
import type { MessengerAdapter } from "./messenger-adapter";
import { PRDParser } from "./prd-parser";
import type { ParsedPRD, PRDProgress } from "./schemas";

export class PRDExecutor {
  private parser: PRDParser;
  private activePRDs = new Map<string, PRDProgress>();
  private abortControllers = new Map<string, AbortController>();

  constructor(
    private config: Config,
    private claude: ClaudeInvoker,
    private projects: ProjectManager,
    private memory: MemoryStore | null,
    private orchestrator: TaskOrchestrator | null,
    private messenger: MessengerAdapter | null,
  ) {
    this.parser = new PRDParser(claude);
  }

  /** Check if a message looks like a PRD based on length and structure. */
  detect(message: string): boolean {
    if (message.length < this.config.prdDetectionMinLength) return false;
    // Heuristic: contains requirement-like patterns
    const prdSignals = [
      /\brequirement/i, /\bimplement/i, /\bbuild\b/i, /\bcreate\b/i,
      /\bfeature/i, /\bspec\b/i, /\bprd\b/i, /\bshould\b/i,
      /^[-*]\s/m, // bullet points
      /^\d+\.\s/m, // numbered lists
    ];
    const matchCount = prdSignals.filter(p => p.test(message)).length;
    return matchCount >= 2;
  }

  /** Execute a PRD from text (Telegram message or pipeline task). */
  async execute(text: string, sourceProject?: string): Promise<PRDProgress> {
    const prdId = crypto.randomUUID().slice(0, 8);
    const ac = new AbortController();
    this.abortControllers.set(prdId, ac);

    const progress: PRDProgress = {
      prdId,
      title: "Parsing PRD...",
      status: "parsing",
      currentStep: 0,
      totalSteps: 0,
      project: sourceProject ?? null,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: null,
      error: null,
    };
    this.activePRDs.set(prdId, progress);

    try {
      // 1. Parse PRD
      const { prd, error } = await this.parser.parse(text);
      if (!prd || ac.signal.aborted) {
        progress.status = prd ? "aborted" : "failed";
        progress.error = error || "Aborted";
        progress.updatedAt = new Date().toISOString();
        return progress;
      }

      progress.title = prd.title;
      progress.totalSteps = prd.suggestedSteps.length;
      progress.project = prd.project || sourceProject || null;
      progress.status = "setup";
      progress.updatedAt = new Date().toISOString();

      // Record to memory
      if (this.memory) {
        await this.memory.record({
          timestamp: new Date().toISOString(),
          source: "prd",
          project: progress.project,
          role: "system",
          content: `PRD detected: ${prd.title}\nRequirements: ${prd.requirements.join(", ")}\nComplexity: ${prd.estimatedComplexity}`,
          summary: `PRD: ${prd.title} (${prd.estimatedComplexity})`,
        });
      }

      // Notify user
      await this.notify(`**PRD detected:** ${prd.title}\nComplexity: ${prd.estimatedComplexity}\nSteps: ${prd.suggestedSteps.length}`);

      // 2. Execute based on complexity
      progress.status = "executing";
      progress.updatedAt = new Date().toISOString();

      if (prd.estimatedComplexity === "simple" || !this.orchestrator) {
        await this.executeSimple(prdId, prd, progress, ac.signal);
      } else {
        await this.executeWithOrchestrator(prdId, prd, progress);
      }

      if (ac.signal.aborted) {
        progress.status = "aborted";
        progress.updatedAt = new Date().toISOString();
        return progress;
      }

      // 3. Final status (cast needed: executeSimple/executeWithOrchestrator mutate progress.status)
      if ((progress.status as string) !== "failed") {
        progress.status = "completed";
        progress.completedAt = new Date().toISOString();
      }
      progress.updatedAt = new Date().toISOString();

      await this.notify(`**PRD ${progress.status}:** ${prd.title}\nSteps: ${progress.currentStep}/${progress.totalSteps}`);

      return progress;
    } catch (err) {
      progress.status = "failed";
      progress.error = String(err);
      progress.updatedAt = new Date().toISOString();
      return progress;
    } finally {
      this.abortControllers.delete(prdId);
    }
  }

  /** Get all active PRD progress objects (for dashboard). */
  getActivePRDs(): PRDProgress[] {
    return Array.from(this.activePRDs.values());
  }

  /** Gracefully abort all active PRD executions. */
  stop(): void {
    for (const [id, ac] of this.abortControllers) {
      ac.abort();
      console.log(`[prd-executor] Aborted PRD ${id}`);
    }
    this.abortControllers.clear();
  }

  private async executeSimple(
    prdId: string,
    prd: ParsedPRD,
    progress: PRDProgress,
    signal: AbortSignal,
  ): Promise<void> {
    for (let i = 0; i < prd.suggestedSteps.length; i++) {
      if (signal.aborted) return;

      const step = prd.suggestedSteps[i]!;
      progress.currentStep = i + 1;
      progress.updatedAt = new Date().toISOString();

      const prompt = `You are executing step ${i + 1}/${prd.suggestedSteps.length} of PRD "${prd.title}".
Step: ${step.description}
Overall requirements: ${prd.requirements.join("; ")}
Constraints: ${prd.constraints.join("; ")}

Execute this step and report what you did.`;

      const response = await this.claude.oneShot(prompt);

      if (response.error) {
        progress.status = "failed";
        progress.error = `Step ${i + 1} failed: ${response.error}`;
        return;
      }

      // Record step result to memory
      if (this.memory) {
        await this.memory.record({
          timestamp: new Date().toISOString(),
          source: "prd",
          project: progress.project,
          role: "assistant",
          content: response.result.slice(0, 2000),
          summary: `PRD step ${i + 1}/${prd.suggestedSteps.length}: ${step.description}`,
        });
      }
    }
  }

  private async executeWithOrchestrator(
    prdId: string,
    prd: ParsedPRD,
    progress: PRDProgress,
  ): Promise<void> {
    if (!this.orchestrator) {
      await this.executeSimple(prdId, prd, progress, new AbortController().signal);
      return;
    }

    // Create a workflow from the PRD steps
    const stepsDescription = prd.suggestedSteps
      .map((s, i) => `Step ${i + 1} (${s.assignee}): ${s.description}${s.dependsOn.length > 0 ? ` [depends on: ${s.dependsOn.join(", ")}]` : ""}`)
      .join("\n");

    const workflowPrompt = `Execute PRD: ${prd.title}\n\n${prd.description}\n\nSteps:\n${stepsDescription}`;

    const result = await this.orchestrator.createWorkflow(workflowPrompt, progress.project ?? undefined);

    if (result.error) {
      progress.status = "failed";
      progress.error = `Workflow creation failed: ${result.error}`;
      return;
    }

    // Track workflow progress
    progress.totalSteps = result.workflow?.steps.length ?? prd.suggestedSteps.length;
    progress.updatedAt = new Date().toISOString();
  }

  private async notify(message: string): Promise<void> {
    if (!this.messenger) return;
    try {
      await this.messenger.sendDirectMessage(message, { parseMode: "Markdown" });
    } catch (err) {
      console.warn(`[prd-executor] Notification failed: ${err}`);
    }
  }
}
