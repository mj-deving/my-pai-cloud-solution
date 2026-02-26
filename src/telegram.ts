// telegram.ts — Telegram bot for Isidore Cloud bridge
// Long polling (no webhook/HTTPS needed), sender validation, message chunking

import { Bot, type Context } from "grammy";
import type { Config } from "./config";
import type { ClaudeInvoker } from "./claude";
import type { SessionManager } from "./session";
import { compactFormat, chunkMessage } from "./format";

export function createTelegramBot(
  config: Config,
  claude: ClaudeInvoker,
  sessions: SessionManager,
): Bot {
  const bot = new Bot(config.telegramBotToken);

  // Middleware: authenticate sender — ONLY Marius allowed
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (userId !== config.telegramAllowedUserId) {
      console.warn(
        `[telegram] Rejected message from unauthorized user: ${userId} (${ctx.from?.username})`,
      );
      await ctx.reply("Unauthorized. This bot is private.");
      return;
    }
    await next();
  });

  // /start — Welcome message
  bot.command("start", async (ctx) => {
    const session = await sessions.current();
    await ctx.reply(
      `Isidore Cloud bridge active.\n\nSession: ${session ? session.slice(0, 8) + "..." : "none"}\n\nCommands:\n/new — Fresh conversation\n/status — Current session info\n/clear — Archive & restart\n/compact — Compact context\n/oneshot <msg> — One-shot (no session)`,
    );
  });

  // /new — Start a new conversation session
  bot.command("new", async (ctx) => {
    await sessions.newSession();
    await ctx.reply(
      "Session cleared. Next message starts a fresh conversation.",
    );
  });

  // /status — Show current session info
  bot.command("status", async (ctx) => {
    const { current, archived } = await sessions.list();
    let msg = `**Current session:** ${current ? current.slice(0, 8) + "..." : "none"}\n`;
    msg += `**Archived:** ${archived.length} sessions`;
    if (archived.length > 0) {
      msg += `\nMost recent: ${archived[0]?.slice(0, 20)}...`;
    }
    await ctx.reply(msg, { parse_mode: "Markdown" });
  });

  // /clear — Archive current session and start fresh
  bot.command("clear", async (ctx) => {
    await sessions.clear();
    await ctx.reply(
      "Session cleared and archived. Next message starts fresh.",
    );
  });

  // /compact — Send /compact to Claude to compress context
  bot.command("compact", async (ctx) => {
    await ctx.reply("Compacting context...");
    const response = await claude.send("/compact");
    if (response.error) {
      await ctx.reply(`Error: ${response.error}`);
      return;
    }
    await ctx.reply("Context compacted.");
  });

  // /oneshot <message> — One-shot invocation (no session)
  bot.command("oneshot", async (ctx) => {
    const message = ctx.match;
    if (!message) {
      await ctx.reply("Usage: /oneshot <your message>");
      return;
    }
    await ctx.reply("Processing (one-shot)...");
    const response = await claude.oneShot(message);
    if (response.error) {
      await ctx.reply(`Error: ${response.error}`);
      return;
    }
    const formatted = compactFormat(response.result);
    const chunks = chunkMessage(formatted, config.telegramMaxChunkSize);
    for (const chunk of chunks) {
      await ctx.reply(chunk);
    }
  });

  // Default: forward message to Claude in the active session
  bot.on("message:text", async (ctx) => {
    const message = ctx.message.text;

    // Typing indicator
    await ctx.replyWithChatAction("typing");

    const response = await claude.send(message);

    if (response.error) {
      await ctx.reply(`Error: ${response.error}`);
      return;
    }

    const formatted = compactFormat(response.result);
    const chunks = chunkMessage(formatted, config.telegramMaxChunkSize);

    for (const chunk of chunks) {
      await ctx.reply(chunk);
    }
  });

  // Handle non-text messages
  bot.on("message", async (ctx) => {
    await ctx.reply(
      "I can only process text messages. Send text or use a command.",
    );
  });

  return bot;
}
