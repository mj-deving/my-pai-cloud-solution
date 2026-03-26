// telegram-adapter.ts — TelegramAdapter wrapping existing createTelegramBot()
// Accepts BridgeContext bag instead of 12 positional args (Graduated Extraction Phase 3B).

import { Bot, GrammyError } from "grammy";
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
  StatusMessageHandle,
  CommandHandler,
  MessageHandler,
} from "./messenger-adapter";
import { createTelegramBot } from "./telegram";
import type { SynthesisLoopLike } from "./telegram";
import type { MemoryStore } from "./memory";
import type { Scheduler } from "./scheduler";
import type { ModeManager } from "./mode";
import type { BridgeContext } from "./types";

export class TelegramAdapter implements MessengerAdapter {
  private bot: Bot;
  private userId: number;
  private maxChunkSize: number;

  constructor(ctx: BridgeContext) {
    this.bot = createTelegramBot(
      ctx.config,
      ctx.claude,
      ctx.sessions,
      ctx.projects,
      ctx.reversePipeline,
      ctx.orchestrator,
      ctx.branchManager,
      ctx.rateLimiter,
      ctx.memoryStore,
      ctx.scheduler,
      ctx.modeManager,
      ctx.synthesisLoop as SynthesisLoopLike | null,
      ctx.groupChat,
    );
    this.userId = ctx.config.telegramAllowedUserId;
    this.maxChunkSize = ctx.config.telegramMaxChunkSize;
  }

  async sendDirectMessage(text: string, options?: MessageOptions): Promise<void> {
    try {
      await this.bot.api.sendMessage(this.userId, text, {
        parse_mode: options?.parseMode === "HTML" ? "HTML" : "Markdown",
      });
    } catch (err) {
      // Only retry without formatting on Markdown parse errors (HTTP 400)
      // Let other errors (429 flood, network) propagate
      if (err instanceof GrammyError && err.error_code === 400 && err.description.includes("parse")) {
        await this.bot.api.sendMessage(this.userId, text);
      } else {
        throw err;
      }
    }
  }

  async sendStatusMessage(text: string, options?: MessageOptions): Promise<StatusMessageHandle> {
    const msg = await this.bot.api.sendMessage(this.userId, text, {
      parse_mode: options?.parseMode === "HTML" ? "HTML" : undefined,
    });
    return { messageId: msg.message_id };
  }

  async editMessage(messageId: number, text: string, options?: MessageOptions): Promise<void> {
    try {
      await this.bot.api.editMessageText(this.userId, messageId, text, {
        parse_mode: options?.parseMode === "HTML" ? "HTML" : undefined,
      });
    } catch (err) {
      // Telegram returns 400 if text unchanged or message deleted — absorb
      console.warn(`[telegram-adapter] editMessage error (ignored): ${err}`);
    }
  }

  async deleteMessage(messageId: number): Promise<void> {
    try {
      await this.bot.api.deleteMessage(this.userId, messageId);
    } catch (err) {
      // Message may already be deleted — absorb
      console.warn(`[telegram-adapter] deleteMessage error (ignored): ${err}`);
    }
  }

  async sendTypingIndicator(): Promise<void> {
    await this.bot.api.sendChatAction(this.userId, "typing");
  }

  registerCommand(_command: string, _handler: CommandHandler): void {
    // Commands are registered inside telegram.ts
  }

  registerMessageHandler(_handler: MessageHandler): void {
    // Message handler registered inside telegram.ts
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
   * @deprecated Will be removed when all consumers use MessengerAdapter interface.
   */
  getRawBot(): Bot {
    return this.bot;
  }
}
