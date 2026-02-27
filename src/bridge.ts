// bridge.ts — Main entry point for the Isidore Cloud communication bridge
// Runs Telegram bot (and email poller when configured) as a single service

import { loadConfig } from "./config";
import { SessionManager } from "./session";
import { ClaudeInvoker } from "./claude";
import { ProjectManager } from "./projects";
import { createTelegramBot } from "./telegram";
import { escMd } from "./format";
import { PipelineWatcher } from "./pipeline";
import { ReversePipelineWatcher } from "./reverse-pipeline";
import { TaskOrchestrator } from "./orchestrator";
import { BranchManager } from "./branch-manager";

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

  // Initialize project manager
  const projectManager = new ProjectManager(config, sessions);
  await projectManager.loadRegistry();
  await projectManager.loadState();

  // Restore active project cwd on startup
  const activeProject = projectManager.getActiveProject();
  if (activeProject) {
    const path = projectManager.getProjectPath(activeProject);
    if (path) {
      claude.setWorkingDirectory(path);
    }
    console.log(`[bridge] Restored project: ${activeProject.displayName} (${path || "no local path"})`);
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

  // Start Telegram bot (pass reverse pipeline, orchestrator, and pipeline watcher)
  const bot = createTelegramBot(config, claude, sessions, projectManager, reversePipeline, orchestrator, branchManager);

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

      // Non-workflow results → direct Telegram notification
      const status = result.status === "completed" ? "completed" : "failed";
      const summary = result.result?.slice(0, 500) || (result as unknown as Record<string, unknown>).summary as string || result.error || "no output";
      const msg =
        `**Delegation result** (${status})\n` +
        `Task: \`${taskId.slice(0, 8)}...\`\n` +
        (delegation.project ? `Project: ${escMd(delegation.project)}\n` : "") +
        `Prompt: ${escMd(delegation.prompt)}\n\n` +
        escMd(summary);
      try {
        await bot.api.sendMessage(config.telegramAllowedUserId, msg, {
          parse_mode: "Markdown",
        });
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
        await bot.api.sendMessage(
          config.telegramAllowedUserId,
          `**Recovered ${recovered.length} in-flight delegation(s) from before restart:**\n${lines.join("\n")}`,
          { parse_mode: "Markdown" },
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
        await bot.api.sendMessage(config.telegramAllowedUserId, message, {
          parse_mode: "Markdown",
        });
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
    pipeline.start();
  } else {
    console.log("[bridge] Pipeline watcher disabled (PIPELINE_ENABLED=0)");
  }

  // Graceful shutdown
  const shutdown = async () => {
    console.log("[bridge] Shutting down...");
    reversePipeline?.stop();
    pipeline?.stop();
    bot.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log("[bridge] Starting Telegram bot (long polling)...");
  bot.start({
    onStart: () => {
      console.log("[bridge] Telegram bot is running");
    },
  });

  // Email bridge placeholder — Phase 4
  if (config.emailImapHost) {
    console.log("[bridge] Email bridge configured but not yet implemented");
  }
}

main().catch((err) => {
  console.error("[bridge] Fatal error:", err);
  process.exit(1);
});
