// bridge.ts — Main entry point for the Isidore Cloud communication bridge
// Runs Telegram bot (and email poller when configured) as a single service

import { loadConfig } from "./config";
import { SessionManager } from "./session";
import { ClaudeInvoker } from "./claude";
import { ProjectManager } from "./projects";
import { TelegramAdapter } from "./telegram-adapter";
import type { MessengerAdapter } from "./messenger-adapter";
import { escMd } from "./format";
import { PipelineWatcher } from "./pipeline";
import { ReversePipelineWatcher } from "./reverse-pipeline";
import { TaskOrchestrator } from "./orchestrator";
import { BranchManager } from "./branch-manager";
import { ResourceGuard } from "./resource-guard";
import { RateLimiter } from "./rate-limiter";
import { Verifier } from "./verifier";
import { IdempotencyStore } from "./idempotency";
import { AgentRegistry } from "./agent-registry";
import { Dashboard } from "./dashboard";
import { MemoryStore } from "./memory";
import { EmbeddingProvider } from "./embeddings";
import { ContextBuilder } from "./context";
import { PRDExecutor } from "./prd-executor";
import { Scheduler } from "./scheduler";
import { PolicyEngine } from "./policy";
import { SynthesisLoop } from "./synthesis";
import { AgentLoader } from "./agent-loader";
import { ModeManager } from "./mode";
import { DailyMemoryWriter } from "./daily-memory";

async function main() {
  console.log("[bridge] Starting Isidore Cloud communication bridge...");

  // Load configuration
  const config = loadConfig();
  console.log("[bridge] Config loaded");
  console.log(
    `[bridge] Allowed Telegram user: ${config.telegramAllowedUserId}`,
  );

  // Initialize session manager
  const sessions = new SessionManager(config.sessionIdFile);
  const currentSession = await sessions.current();
  console.log(
    `[bridge] Active session: ${currentSession ? currentSession.slice(0, 8) + "..." : "none (will create on first message)"}`,
  );

  // Initialize Claude invoker
  const claude = new ClaudeInvoker(config, sessions);

  // Initialize project manager (state loaded after memory store is ready)
  const projectManager = new ProjectManager(config, sessions);
  await projectManager.loadRegistry();

  // Initialize ModeManager — starts in workspace, may restore project mode after state load
  const modeManager = new ModeManager();
  claude.setWorkingDirectory(config.workspaceDir);

  // Create workspace directory if needed
  {
    const { mkdir: mkdirFs } = await import("node:fs/promises");
    const { existsSync } = await import("node:fs");
    await mkdirFs(config.workspaceDir, { recursive: true });

    // Initialize workspace git repo if enabled and no .git
    if (config.workspaceGitEnabled && !existsSync(`${config.workspaceDir}/.git`)) {
      const initProc = Bun.spawn(["git", "init"], {
        cwd: config.workspaceDir,
        stdout: "pipe",
        stderr: "pipe",
      });
      const exitCode = await initProc.exited;
      if (exitCode === 0) {
        console.log(`[bridge] Initialized workspace git repo: ${config.workspaceDir}`);
      }
    }
    console.log(`[bridge] Workspace dir: ${config.workspaceDir}`);
  }

  // Initialize reverse pipeline watcher (Isidore → Gregor delegation)
  let reversePipeline: ReversePipelineWatcher | null = null;
  if (config.reversePipelineEnabled) {
    reversePipeline = new ReversePipelineWatcher(config);
  } else {
    console.log("[bridge] Reverse pipeline disabled (REVERSE_PIPELINE_ENABLED=0)");
  }

  // Initialize orchestrator (DAG-based workflow decomposition)
  let orchestrator: TaskOrchestrator | null = null;
  if (config.orchestratorEnabled) {
    orchestrator = new TaskOrchestrator(config, claude, reversePipeline);
  } else {
    console.log("[bridge] Orchestrator disabled (ORCHESTRATOR_ENABLED=0)");
  }

  // Initialize branch manager (Phase 5C: task-specific branch isolation)
  let branchManager: BranchManager | null = null;
  if (config.branchIsolationEnabled) {
    branchManager = new BranchManager(config.pipelineDir);
    const cleaned = await branchManager.cleanStale(config.branchIsolationStaleLockMaxMs);
    if (cleaned > 0) {
      console.log(`[bridge] Cleaned ${cleaned} stale branch lock(s)`);
    }
    console.log("[bridge] Branch isolation enabled");
  } else {
    console.log("[bridge] Branch isolation disabled (BRANCH_ISOLATION_ENABLED=0)");
  }

  // Phase 6A: Initialize resource guard
  let resourceGuard: ResourceGuard | null = null;
  if (config.resourceGuardEnabled) {
    resourceGuard = new ResourceGuard(config);
    const status = resourceGuard.getStatus();
    console.log(`[bridge] Resource guard enabled (threshold: ${status.thresholdMb}MB, free: ${status.freeMb}MB)`);
  } else {
    console.log("[bridge] Resource guard disabled (RESOURCE_GUARD_ENABLED=0)");
  }

  // Phase 6A: Initialize rate limiter
  let rateLimiter: RateLimiter | null = null;
  if (config.rateLimiterEnabled) {
    rateLimiter = new RateLimiter(config);
    claude.setRateLimiter(rateLimiter);
    console.log(`[bridge] Rate limiter enabled (threshold: ${config.rateLimiterFailureThreshold} failures in ${config.rateLimiterWindowMs / 1000}s)`);
  } else {
    console.log("[bridge] Rate limiter disabled (RATE_LIMITER_ENABLED=0)");
  }

  // Phase 6B: Initialize verifier
  let verifier: Verifier | null = null;
  if (config.verifierEnabled) {
    verifier = new Verifier(config);
    console.log(`[bridge] Verifier enabled (timeout: ${config.verifierTimeoutMs}ms)`);
  } else {
    console.log("[bridge] Verifier disabled (VERIFIER_ENABLED=0)");
  }

  // Phase 1: Initialize SQLite-backed agent registry
  let agentRegistry: AgentRegistry | null = null;
  if (config.agentRegistryEnabled) {
    agentRegistry = new AgentRegistry(config.agentRegistryDbPath);
    agentRegistry.register("isidore_cloud", "isidore", ["pipeline", "orchestrator", "telegram"]);
    agentRegistry.startHeartbeat("isidore_cloud", config.agentRegistryHeartbeatIntervalMs);
    console.log(`[bridge] Agent registry enabled (db: ${config.agentRegistryDbPath})`);
  } else {
    console.log("[bridge] Agent registry disabled (AGENT_REGISTRY_ENABLED=0)");
  }

  // Phase 1: Initialize idempotency store (shares DB with registry)
  let idempotencyStore: IdempotencyStore | null = null;
  if (config.pipelineDedupEnabled) {
    idempotencyStore = new IdempotencyStore(config.agentRegistryDbPath);
    console.log("[bridge] Pipeline dedup enabled");
  } else {
    console.log("[bridge] Pipeline dedup disabled (PIPELINE_DEDUP_ENABLED=0)");
  }

  // Phase 3 V2-A: Memory Store
  let memoryStore: MemoryStore | null = null;
  let embeddingProvider: EmbeddingProvider | null = null;
  if (config.memoryEnabled) {
    const { mkdir: mkdirFs } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdirFs(dirname(config.memoryDbPath), { recursive: true });
    memoryStore = new MemoryStore(config.memoryDbPath, config);
    embeddingProvider = new EmbeddingProvider(config);
    await embeddingProvider.init();
    memoryStore.setEmbeddingProvider(embeddingProvider);
    const stats = memoryStore.getStats();
    console.log(`[bridge] Memory store initialized (${stats.episodeCount} episodes, vec: ${stats.hasVectorSearch})`);
    // Wire memory store to project manager for state persistence
    projectManager.setMemoryStore(memoryStore);
  } else {
    console.log("[bridge] Memory store disabled (MEMORY_ENABLED=0)");
  }

  // Wire memory store to session manager for workspace session persistence
  if (memoryStore) {
    sessions.setMemoryStore(memoryStore);
  }

  // Load project state (after memory store is wired, so it can use memory.db)
  await projectManager.loadState();
  // Restore previous project mode if one was active, otherwise stay in workspace
  const previousProject = projectManager.getActiveProjectName();
  if (previousProject) {
    const projectEntry = projectManager.getActiveProject();
    const projectPath = projectEntry ? projectManager.getProjectPath(projectEntry) : null;
    if (projectPath) {
      modeManager.switchToProject(previousProject);
      claude.setWorkingDirectory(projectPath);
      console.log(`[bridge] Mode: project (restored: ${previousProject})`);
    } else {
      // Project exists in state but path not available on this machine — fall back to workspace
      await projectManager.clearActiveProject();
      console.log(`[bridge] Previous project ${previousProject} not available, staying in workspace`);
    }
  }

  // Phase 3 V2-B: Context Injection
  if (config.contextInjectionEnabled && memoryStore) {
    const contextBuilder = new ContextBuilder(memoryStore, config);
    claude.setContextBuilder(contextBuilder);
    // Phase D: Log observation masking status
    if (config.observationMaskingEnabled) {
      console.log(`[bridge] Observation masking enabled (window: ${config.observationMaskingWindow} episodes)`);
    }
    console.log("[bridge] Context injection enabled");
  } else if (config.contextInjectionEnabled && !memoryStore) {
    console.log("[bridge] Context injection requires MEMORY_ENABLED=1, skipping");
  }

  // Phase 4: Policy Engine
  let policyEngine: PolicyEngine | null = null;
  if (config.policyEnabled) {
    policyEngine = new PolicyEngine(config.policyFile);
    console.log(`[bridge] Policy engine enabled (${config.policyFile})`);
  } else {
    console.log("[bridge] Policy engine disabled (POLICY_ENABLED=0)");
  }

  // Phase 4: Scheduler
  let scheduler: Scheduler | null = null;
  if (config.schedulerEnabled) {
    scheduler = new Scheduler(config.schedulerDbPath, config);
    // Built-in schedules
    scheduler.upsert("daily-synthesis", "0 2 * * *", {
      type: "synthesis",
      prompt: "Run memory synthesis: review recent episodes, distill knowledge, identify patterns.",
      timeout_minutes: 10,
      max_turns: 15,
    });
    scheduler.upsert("weekly-review", "0 3 * * 0", {
      type: "task",
      prompt: "System health review: check memory stats, pipeline throughput, error rates, disk usage. Report anomalies.",
      timeout_minutes: 10,
      max_turns: 15,
    });
    scheduler.upsert("daily-memory", config.workspaceDailyMemoryCron, {
      type: "daily-memory",
      prompt: "Write daily memory summary",
      timeout_minutes: 5,
      max_turns: 5,
    });
    console.log(`[bridge] Scheduler enabled (db: ${config.schedulerDbPath})`);
  } else {
    console.log("[bridge] Scheduler disabled (SCHEDULER_ENABLED=0)");
  }

  // Phase C: Agent Loader
  let agentLoader: AgentLoader | null = null;
  if (config.agentDefinitionsEnabled) {
    agentLoader = new AgentLoader(config.agentDefinitionsDir);
    const agents = await agentLoader.loadAll();
    if (agentRegistry) {
      agentLoader.registerAll(agentRegistry);
    }
    console.log(`[bridge] Agent definitions loaded (${agents.length} agents)`);
  } else {
    console.log("[bridge] Agent definitions disabled (AGENT_DEFINITIONS_ENABLED=0)");
  }

  // Phase C: Synthesis Loop
  let synthesisLoop: SynthesisLoop | null = null;
  if (config.synthesisEnabled && memoryStore) {
    synthesisLoop = new SynthesisLoop(config, memoryStore, claude);
    if (policyEngine) {
      synthesisLoop.setPolicyEngine(policyEngine);
    }
    // Phase D: Wire whiteboard generation
    if (config.whiteboardEnabled) {
      synthesisLoop.setWhiteboardEnabled(true);
      console.log("[bridge] Whiteboard generation enabled (during synthesis runs)");
    }
    const stats = synthesisLoop.getStats();
    console.log(`[bridge] Synthesis loop enabled (${stats.totalRuns} runs, ${stats.totalEntriesDistilled} entries distilled)`);
  } else if (config.synthesisEnabled && !memoryStore) {
    console.log("[bridge] Synthesis loop requires MEMORY_ENABLED=1, skipping");
  } else {
    console.log("[bridge] Synthesis loop disabled (SYNTHESIS_ENABLED=0)");
  }

  // Phase 1: Create messenger adapter based on config
  let messenger: MessengerAdapter;
  if (config.messengerType === "telegram") {
    messenger = new TelegramAdapter(
      config,
      claude,
      sessions,
      projectManager,
      reversePipeline,
      orchestrator,
      branchManager,
      rateLimiter,
      memoryStore,
      scheduler,
      modeManager,
      synthesisLoop,
    );
  } else {
    throw new Error(`Unsupported messenger type: ${config.messengerType}`);
  }

  // Wire messenger to subsystems for live Telegram status updates (pre-pipeline)
  if (orchestrator) orchestrator.setMessenger(messenger);
  if (synthesisLoop) synthesisLoop.setMessenger(messenger);
  if (reversePipeline) reversePipeline.setMessenger(messenger);

  // Wire reverse pipeline result callback → orchestrator routing or Telegram notification
  if (reversePipeline) {
    reversePipeline.setResultCallback(async (taskId, result, delegation) => {
      // Route workflow-associated results to orchestrator
      if (orchestrator && delegation.workflowId && delegation.stepId) {
        // Tolerate handler writing 'summary' instead of 'result' (schema compat)
        const resultText = result.result || (result as unknown as Record<string, unknown>).summary as string || "";
        if (result.status === "completed") {
          await orchestrator.completeStep(delegation.workflowId, delegation.stepId, resultText);
        } else {
          await orchestrator.failStep(delegation.workflowId, delegation.stepId, result.error || "unknown error");
        }
        return; // Orchestrator handles its own notifications
      }

      // Non-workflow results → direct messenger notification
      const status = result.status === "completed" ? "completed" : "failed";
      const summary = result.result?.slice(0, 500) || (result as unknown as Record<string, unknown>).summary as string || result.error || "no output";
      const msg =
        `**Delegation result** (${status})\n` +
        `Task: \`${taskId.slice(0, 8)}...\`\n` +
        (delegation.project ? `Project: ${escMd(delegation.project)}\n` : "") +
        `Prompt: ${escMd(delegation.prompt)}\n\n` +
        escMd(summary);
      try {
        await messenger.sendDirectMessage(msg, { parseMode: "Markdown" });
      } catch (err) {
        console.error(`[bridge] Failed to send delegation result notification: ${err}`);
      }
    });

    // Recover in-flight delegations from before restart
    const recovered = await reversePipeline.loadPending();
    if (recovered.length > 0) {
      const lines = recovered.map(
        (d) => `- \`${d.taskId.slice(0, 8)}...\` ${escMd(d.prompt)}`,
      );
      try {
        await messenger.sendDirectMessage(
          `**Recovered ${recovered.length} in-flight delegation(s) from before restart:**\n${lines.join("\n")}`,
          { parseMode: "Markdown" },
        );
      } catch (err) {
        console.error(`[bridge] Failed to send recovery notification: ${err}`);
      }
    }

    reversePipeline.start();
  }

  // Wire orchestrator: notification callback + load persisted workflows
  if (orchestrator) {
    orchestrator.setNotifyCallback(async (message) => {
      try {
        await messenger.sendDirectMessage(message, { parseMode: "Markdown" });
      } catch (err) {
        console.error(`[bridge] Orchestrator notification error: ${err}`);
      }
    });

    if (branchManager) {
      orchestrator.setBranchManager(branchManager);
    }

    const count = await orchestrator.loadWorkflows();
    console.log(`[bridge] Orchestrator ready (${count} workflow(s) recovered)`);
  }

  // Phase 6A: Wire rate limiter events → messenger notifications + orchestrator re-kick
  if (rateLimiter) {
    rateLimiter.onEvent((event) => {
      const msg = event === "paused"
        ? "**Rate limiter activated** — automated dispatch paused (cooldown active)"
        : "**Rate limiter resumed** — automated dispatch active";
      messenger.sendDirectMessage(msg, { parseMode: "Markdown" })
        .catch((err: unknown) => console.error(`[bridge] Rate limiter notification error: ${err}`));

      // On resume: kick orchestrator to retry deferred steps
      if (event === "resumed" && orchestrator) {
        for (const wf of orchestrator.getActiveWorkflows()) {
          orchestrator.advanceWorkflow(wf.id).catch((err: unknown) => {
            console.warn(`[bridge] Orchestrator re-kick error: ${err}`);
          });
        }
      }
    });

    // Wire rate limiter to orchestrator
    if (orchestrator) {
      orchestrator.setRateLimiter(rateLimiter);
    }
  }

  // Phase 6B: Wire verifier to orchestrator and reverse pipeline
  if (verifier) {
    if (orchestrator) {
      orchestrator.setVerifier(verifier);
    }
    if (reversePipeline) {
      reversePipeline.setVerifier(verifier);
    }
  }

  // Start pipeline watcher (cross-user task queue)
  let pipeline: PipelineWatcher | null = null;
  if (config.pipelineEnabled) {
    pipeline = new PipelineWatcher(config);
    // Wire orchestrator hook for type:"orchestrate" tasks
    if (orchestrator) {
      pipeline.setOrchestrator(orchestrator);
    }
    // Wire branch manager for task-specific branch isolation
    if (branchManager) {
      pipeline.setBranchManager(branchManager);
    }
    // Phase 6A: Wire resource guard and rate limiter
    if (resourceGuard) {
      pipeline.setResourceGuard(resourceGuard);
    }
    if (rateLimiter) {
      pipeline.setRateLimiter(rateLimiter);
    }
    // Phase 6B: Wire verifier
    if (verifier) {
      pipeline.setVerifier(verifier);
    }
    // Phase 1: Wire idempotency store
    if (idempotencyStore) {
      pipeline.setIdempotencyStore(idempotencyStore);
    }
    // Phase 4: Wire policy engine to pipeline
    if (policyEngine) {
      pipeline.setPolicyEngine(policyEngine);
    }
    // Phase C: Wire memory store to pipeline for outcome recording
    if (memoryStore) {
      pipeline.setMemoryStore(memoryStore);
    }
    // Phase C: Wire synthesis loop to pipeline for type:"synthesis" tasks
    if (synthesisLoop) {
      pipeline.setSynthesisLoop(synthesisLoop);
    }
    // Workspace: Wire daily memory writer to pipeline for type:"daily-memory" tasks
    if (memoryStore) {
      const dailyMemoryWriter = new DailyMemoryWriter(
        memoryStore, claude, config.workspaceDir, config.workspaceGitEnabled,
      );
      pipeline.setDailyMemoryWriter(dailyMemoryWriter);
      console.log(`[bridge] Daily memory writer enabled (workspace: ${config.workspaceDir})`);
    }
    pipeline.setMessenger(messenger);
    pipeline.start();
  } else {
    console.log("[bridge] Pipeline watcher disabled (PIPELINE_ENABLED=0)");
  }

  // Phase 4: Wire policy engine to orchestrator
  if (policyEngine && orchestrator) {
    orchestrator.setPolicyEngine(policyEngine);
  }

  // Phase C: Wire memory store and agent loader to orchestrator
  if (orchestrator) {
    if (memoryStore) {
      orchestrator.setMemoryStore(memoryStore);
    }
    if (agentLoader) {
      orchestrator.setAgentLoader(agentLoader);
    }
  }

  // Phase 3 V2-D: PRD Executor
  let prdExecutor: PRDExecutor | null = null;
  if (config.prdExecutorEnabled) {
    prdExecutor = new PRDExecutor(config, claude, projectManager, memoryStore, orchestrator, messenger);
    // Wire to pipeline for type:"prd" routing
    if (pipeline) {
      pipeline.setPRDExecutor(prdExecutor);
    }
    console.log("[bridge] PRD executor enabled");
  } else {
    console.log("[bridge] PRD executor disabled (PRD_EXECUTOR_ENABLED=0)");
  }

  // Phase 2: Dashboard web server
  let dashboard: Dashboard | null = null;
  if (config.dashboardEnabled) {
    dashboard = new Dashboard(
      config, pipeline, orchestrator, reversePipeline,
      rateLimiter, resourceGuard, agentRegistry, idempotencyStore,
      memoryStore, prdExecutor, synthesisLoop,
    );
    dashboard.start();
  } else {
    console.log("[bridge] Dashboard disabled (DASHBOARD_ENABLED=0)");
  }

  // Phase C: Wire notify callback to synthesis loop
  if (synthesisLoop) {
    synthesisLoop.setNotifyCallback(async (msg) => {
      try {
        await messenger.sendDirectMessage(msg, { parseMode: "Markdown" });
      } catch (err) {
        console.error(`[bridge] Synthesis notification error: ${err}`);
      }
    });
  }

  // Phase 4: Wire policy escalation to messenger and start scheduler
  if (policyEngine) {
    policyEngine.setEscalationCallback(async (action, context) => {
      const msg = `**Policy escalation** — action \`${action}\` requires approval\n` +
        `Context: ${JSON.stringify(context).slice(0, 300)}`;
      try {
        await messenger.sendDirectMessage(msg, { parseMode: "Markdown" });
      } catch (err) {
        console.error(`[bridge] Policy escalation notification error: ${err}`);
      }
    });
  }
  if (scheduler) {
    scheduler.start();
  }

  // Graceful shutdown
  const shutdown = async () => {
    console.log("[bridge] Shutting down...");

    // Generate session summary before shutdown (best-effort, non-blocking)
    // Note: works for both workspace and project modes
    if (memoryStore) {
      try {
        const recentEpisodes = memoryStore.getEpisodesSince(
          Math.max(0, memoryStore.getLastEpisodeId() - 20), 20
        );
        if (recentEpisodes.length > 0) {
          const conversationText = recentEpisodes
            .map(ep => `[${ep.role}] ${(ep.summary || ep.content).slice(0, 150)}`)
            .join("\n");
          const summaryPrompt = `Summarize this conversation in 3-5 bullets: what was discussed, what was decided, what's pending.\n\n${conversationText.slice(0, 2000)}`;
          const summaryResponse = await claude.quickShot(summaryPrompt);
          if (summaryResponse.result && !summaryResponse.error) {
            const project = projectManager.getActiveProjectName() ?? undefined;
            await memoryStore.record({
              timestamp: new Date().toISOString(),
              source: "session_summary",
              project,
              session_id: (await sessions.current()) ?? undefined,
              role: "system",
              content: summaryResponse.result.slice(0, 1000),
              summary: "Session summary before shutdown",
              importance: 9,
            });
            console.log("[bridge] Session summary saved to memory");
          }
        }
      } catch (err) {
        console.warn(`[bridge] Session summary generation failed (non-blocking): ${err}`);
      }
    }

    // Phase 4: Stop scheduler
    scheduler?.stop();
    scheduler?.close();
    // V2-D: Graceful PRD abort
    prdExecutor?.stop();
    dashboard?.stop();
    rateLimiter?.stop();
    reversePipeline?.stop();
    pipeline?.stop();
    // Phase 1: Deregister agent and close DB connections
    if (agentRegistry) {
      agentRegistry.deregister("isidore_cloud");
      agentRegistry.close();
    }
    idempotencyStore?.close();
    // Phase C: Close synthesis state DB
    synthesisLoop?.close();
    // V2-A: Close memory store
    memoryStore?.close();
    messenger.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log("[bridge] Starting messenger...");
  await messenger.start();

  // Email bridge placeholder — Phase 4
  if (config.emailImapHost) {
    console.log("[bridge] Email bridge configured but not yet implemented");
  }
}

main().catch((err) => {
  console.error("[bridge] Fatal error:", err);
  process.exit(1);
});
