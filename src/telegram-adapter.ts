// telegram-adapter.ts — TelegramAdapter wrapping existing createTelegramBot()
// Does NOT rewrite telegram.ts — wraps the existing Bot instance.
// Phase 2 will migrate command registration to the adapter interface.

import { Bot } from "grammy";
import type { Config } from "./config";
import type { ClaudeInvoker } from "./claude";
import type { SessionManager } from "./session";
import type { ProjectManager } from "./projects";
import type { ReversePipelineWatcher } from "./reverse-pipeline";
import type { TaskOrchestrator } from "./orchestrator";
import type { BranchManager } from "./branch-manager";
import type { RateLimiter } from "./rate-limiter";
import type {
  MessengerAdapter,
  MessageOptions,
  CommandHandler,
  MessageHandler,
} from "./messenger-adapter";
import { createTelegramBot } from "./telegram";

export class TelegramAdapter implements MessengerAdapter {
  private bot: Bot;
  private userId: number;
  private maxChunkSize: number;

  constructor(
    config: Config,
    claude: ClaudeInvoker,
    sessions: SessionManager,
    projects: ProjectManager,
    reversePipeline?: ReversePipelineWatcher | null,
    orchestrator?: TaskOrchestrator | null,
    branchManager?: BranchManager | null,
    rateLimiter?: RateLimiter | null,
  ) {
    this.bot = createTelegramBot(
      config,
      claude,
      sessions,
      projects,
      reversePipeline,
      orchestrator,
      branchManager,
      rateLimiter,
    );
    this.userId = config.telegramAllowedUserId;
    this.maxChunkSize = config.telegramMaxChunkSize;
  }

  async sendDirectMessage(text: string, options?: MessageOptions): Promise<void> {
    await this.bot.api.sendMessage(this.userId, text, {
      parse_mode: options?.parseMode === "HTML" ? "HTML" : "Markdown",
    });
  }

  async sendTypingIndicator(): Promise<void> {
    await this.bot.api.sendChatAction(this.userId, "typing");
  }

  // Phase 1: no-op — commands already registered inside createTelegramBot()
  // Phase 2 will migrate command registration to use this method
  registerCommand(_command: string, _handler: CommandHandler): void {
    // Commands are registered inside telegram.ts for Phase 1
  }

  // Phase 1: no-op — message handler already registered inside createTelegramBot()
  registerMessageHandler(_handler: MessageHandler): void {
    // Message handler registered inside telegram.ts for Phase 1
  }

  async start(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.bot.start({
        onStart: () => {
          console.log("[telegram-adapter] Telegram bot is running");
          resolve();
        },
      });
    });
  }

  stop(): void {
    this.bot.stop();
  }

  getUserId(): number {
    return this.userId;
  }

  getMaxMessageSize(): number {
    return this.maxChunkSize;
  }

  /**
   * Escape hatch: access the raw Grammy Bot instance.
   * Should NOT be used by bridge.ts — exists for edge cases during Phase 1 transition.
   * @deprecated Will be removed when all consumers use MessengerAdapter interface.
   */
  getRawBot(): Bot {
    return this.bot;
  }
}
