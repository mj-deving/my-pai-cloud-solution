// bridge.ts — Main entry point for the Isidore Cloud communication bridge
// Runs Telegram bot (and email poller when configured) as a single service

import { loadConfig } from "./config";
import { SessionManager } from "./session";
import { ClaudeInvoker } from "./claude";
import { ProjectManager } from "./projects";
import { createTelegramBot } from "./telegram";
import { PipelineWatcher } from "./pipeline";

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

  // Start Telegram bot
  const bot = createTelegramBot(config, claude, sessions, projectManager);

  // Start pipeline watcher (cross-user task queue)
  let pipeline: PipelineWatcher | null = null;
  if (config.pipelineEnabled) {
    pipeline = new PipelineWatcher(config);
    pipeline.start();
  } else {
    console.log("[bridge] Pipeline watcher disabled (PIPELINE_ENABLED=0)");
  }

  // Graceful shutdown
  const shutdown = async () => {
    console.log("[bridge] Shutting down...");
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
