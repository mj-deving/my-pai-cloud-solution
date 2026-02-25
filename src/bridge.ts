// bridge.ts — Main entry point for the Isidore communication bridge
// Runs Telegram bot (and email poller when configured) as a single service

import { loadConfig } from "./config";
import { SessionManager } from "./session";
import { ClaudeInvoker } from "./claude";
import { createTelegramBot } from "./telegram";

async function main() {
  console.log("[bridge] Starting Isidore communication bridge...");

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

  // Start Telegram bot
  const bot = createTelegramBot(config, claude, sessions);

  // Graceful shutdown
  const shutdown = async () => {
    console.log("[bridge] Shutting down...");
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
    // TODO: Phase 4 — IMAP polling + msmtp response
  }
}

main().catch((err) => {
  console.error("[bridge] Fatal error:", err);
  process.exit(1);
});
