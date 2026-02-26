// telegram.ts — Telegram bot for Isidore Cloud bridge
// Long polling (no webhook/HTTPS needed), sender validation, message chunking

import { Bot, type Context } from "grammy";
import type { Config } from "./config";
import type { ClaudeInvoker } from "./claude";
import type { SessionManager } from "./session";
import type { ProjectManager } from "./projects";
import { compactFormat, chunkMessage } from "./format";
import { lightweightWrapup } from "./wrapup";

export function createTelegramBot(
  config: Config,
  claude: ClaudeInvoker,
  sessions: SessionManager,
  projects: ProjectManager,
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
    const activeProject = projects.getActiveProject();
    const projectList = projects.listProjects();

    let msg = `Isidore Cloud bridge active.\n\n`;
    msg += `Session: ${session ? session.slice(0, 8) + "..." : "none"}\n`;
    msg += `Project: ${activeProject ? activeProject.displayName : "none"}\n`;
    msg += `Available: ${projectList.map((p) => p.name).join(", ") || "none"}\n`;
    msg += `\nCommands:\n`;
    msg += `/project <name> — Switch project\n`;
    msg += `/projects — List available projects\n`;
    msg += `/done — Commit + push current project\n`;
    msg += `/handoff — Done + status summary\n`;
    msg += `/new — Fresh conversation\n`;
    msg += `/status — Current session info\n`;
    msg += `/clear — Archive & restart\n`;
    msg += `/newproject <name> — Create new project\n`;
    msg += `/deleteproject <name> — Remove project from registry\n`;
    msg += `/compact — Compact context\n`;
    msg += `/oneshot <msg> — One-shot (no session)`;

    await ctx.reply(msg);
  });

  // /projects — List available projects with active marker
  bot.command("projects", async (ctx) => {
    const projectList = projects.listProjects();
    const activeName = projects.getActiveProjectName();

    if (projectList.length === 0) {
      await ctx.reply("No projects registered. Add to config/projects.json.");
      return;
    }

    let msg = "**Available Projects:**\n\n";
    for (const p of projectList) {
      const marker = p.name === activeName ? " ← active" : "";
      const session = projects.getSessionForProject(p.name);
      const sessionInfo = session ? ` (session: ${session.slice(0, 8)}...)` : "";
      msg += `• **${p.displayName}** (${p.name})${marker}${sessionInfo}\n`;
    }

    await ctx.reply(msg, { parse_mode: "Markdown" });
  });

  // /project <name> — Switch active project
  bot.command("project", async (ctx) => {
    const name = ctx.match?.trim();
    if (!name) {
      await ctx.reply(
        "Usage: /project <name>\nSee /projects for available projects.",
      );
      return;
    }

    await ctx.replyWithChatAction("typing");

    // 1. Push current project if it has uncommitted changes
    const currentProject = projects.getActiveProject();
    if (currentProject) {
      const pushResult = await projects.syncPush(currentProject);
      if (pushResult.ok) {
        console.log(`[telegram] Auto-pushed ${currentProject.name}`);
      }
    }

    // 2. Look up target project
    const target = projects.getProject(name);
    if (!target) {
      const available = projects
        .listProjects()
        .map((p) => p.name)
        .join(", ");
      await ctx.reply(
        `Project not found: "${name}"\nAvailable: ${available || "none"}`,
      );
      return;
    }

    // 3. Ensure project is cloned
    const cloneResult = await projects.ensureCloned(target);
    if (!cloneResult.ok) {
      await ctx.reply(`Cannot switch: ${cloneResult.output}`);
      return;
    }

    // 4. Pull latest code
    const pullResult = await projects.syncPull(target);

    // 5. Pull latest knowledge (CLAUDE.local.md → CLAUDE.handoff.md, etc.)
    const knowledgeResult = await projects.knowledgeSyncPull();

    // 6. Switch project + session + cwd
    const result = await projects.setActiveProject(target.name);
    if (!result) {
      await ctx.reply("Failed to switch project.");
      return;
    }

    if (result.path) {
      claude.setWorkingDirectory(result.path);
    }

    const autoDetected = cloneResult.autoDetected || result.autoDetected;
    let msg = `Switched to **${target.displayName}**\n`;
    if (result.path) {
      msg += `Path: \`${result.path}\`${autoDetected ? " (auto-detected)" : ""}\n`;
    } else {
      msg += "Path: not configured for this instance\n";
    }
    msg += pullResult.ok ? "Git: pulled latest\n" : `Git: ${pullResult.output}\n`;
    msg += knowledgeResult.ok ? "Knowledge: synced" : "Knowledge: sync skipped";

    await ctx.reply(msg, { parse_mode: "Markdown" });
  });

  // /newproject <name> — Create a new project (GitHub repo + VPS dir + registry)
  bot.command("newproject", async (ctx) => {
    const name = ctx.match?.trim();
    if (!name) {
      await ctx.reply(
        "Usage: /newproject <name>\nName must be lowercase kebab-case (e.g. my-cool-project).",
      );
      return;
    }

    await ctx.replyWithChatAction("typing");
    await ctx.reply(`Creating project "${name}"...`);

    // 1. Create the project (GitHub + VPS dir + scaffold + registry)
    const result = await projects.createProject(name);
    if ("error" in result) {
      await ctx.reply(`Failed: ${result.error}`);
      return;
    }

    // 2. Auto-switch to the new project
    const switchResult = await projects.setActiveProject(result.project.name);
    if (switchResult?.path) {
      claude.setWorkingDirectory(switchResult.path);
    }

    // 3. Confirm with details
    const org = "mj-deving";
    let msg = `**Project created: ${result.project.displayName}**\n\n`;
    msg += `GitHub: \`${org}/${result.project.name}\` (private)\n`;
    msg += `VPS: \`${result.project.paths.vps}\`\n`;
    msg += `Status: active + fresh session\n\n`;
    msg += `To clone locally:\n`;
    msg += `\`git clone https://github.com/${org}/${result.project.name}.git ~/projects/${result.project.name}\``;

    await ctx.reply(msg, { parse_mode: "Markdown" });
  });

  // /deleteproject <name> — Remove a project from registry (exact match only)
  bot.command("deleteproject", async (ctx) => {
    const name = ctx.match?.trim();
    if (!name) {
      await ctx.reply(
        "Usage: /deleteproject <name>\nUse the exact project name (see /projects).",
      );
      return;
    }

    await ctx.replyWithChatAction("typing");

    const result = await projects.deleteProject(name);
    if ("error" in result) {
      await ctx.reply(`Failed: ${result.error}`);
      return;
    }

    const removed = result.project;
    let msg = `**Deleted: ${removed.displayName}**\n\n`;
    msg += `Removed from registry + handoff state.\n\n`;
    msg += `**Manual cleanup (if needed):**\n`;
    if (removed.paths.vps) {
      msg += `VPS dir: \`rm -rf ${removed.paths.vps}\`\n`;
    }
    msg += `GitHub: \`gh repo delete mj-deving/${removed.name} --yes\``;

    await ctx.reply(msg, { parse_mode: "Markdown" });
  });

  // /done — Commit + push current project + knowledge sync
  bot.command("done", async (ctx) => {
    const activeProject = projects.getActiveProject();
    if (!activeProject) {
      await ctx.reply("No active project. Use /project <name> first.");
      return;
    }

    await ctx.replyWithChatAction("typing");

    // 1. Git commit + push
    const gitResult = await projects.syncPush(activeProject);
    // 2. Knowledge sync push (CLAUDE.local.md, WORK/, SESSIONS/, etc.)
    const knowledgeResult = await projects.knowledgeSyncPush();

    let msg = `**${activeProject.displayName}**\n`;
    msg += gitResult.ok ? "Git: pushed\n" : `Git: ${gitResult.output}\n`;
    msg += knowledgeResult.ok ? "Knowledge: synced\n" : "Knowledge: sync skipped\n";
    msg += "Ready for local pickup.";

    await ctx.reply(msg, { parse_mode: "Markdown" });
  });

  // /handoff — Done + detailed status summary
  bot.command("handoff", async (ctx) => {
    const activeProject = projects.getActiveProject();
    if (!activeProject) {
      await ctx.reply("No active project. Use /project <name> first.");
      return;
    }

    await ctx.replyWithChatAction("typing");

    // 1. Git commit + push
    const pushResult = await projects.syncPush(activeProject);
    // 2. Knowledge sync push
    const knowledgeResult = await projects.knowledgeSyncPush();

    // Build status summary
    const session = await sessions.current();
    const path = projects.getProjectPath(activeProject);

    let msg = `**Handoff: ${activeProject.displayName}**\n\n`;
    msg += `Git: ${pushResult.ok ? "pushed" : pushResult.output}\n`;
    msg += `Knowledge: ${knowledgeResult.ok ? "synced" : "sync skipped"}\n`;
    msg += `Session: ${session ? session.slice(0, 8) + "..." : "none"}\n`;
    if (path) msg += `Path: \`${path}\`\n`;
    msg += "\n";
    if (activeProject.paths.local) {
      msg += `To pick up locally:\n`;
      msg += `\`cd ${activeProject.paths.local} && git pull\``;
    } else {
      msg += "Cloud-only project — no local path configured.";
    }

    await ctx.reply(msg, { parse_mode: "Markdown" });
  });

  // /new — Start a new conversation session
  bot.command("new", async (ctx) => {
    await sessions.newSession();
    await ctx.reply(
      "Session cleared. Next message starts a fresh conversation.",
    );
  });

  // /status — Show current session + project info
  bot.command("status", async (ctx) => {
    const { current, archived } = await sessions.list();
    const activeProject = projects.getActiveProject();
    const path = activeProject ? projects.getProjectPath(activeProject) : null;

    let msg = `**Project:** ${activeProject ? activeProject.displayName : "none"}\n`;
    if (path) msg += `**Path:** \`${path}\`\n`;
    msg += `**Session:** ${current ? current.slice(0, 8) + "..." : "none"}\n`;
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

    // Auto-commit tracked changes after response (non-blocking)
    const activeProject = projects.getActiveProject();
    if (activeProject) {
      const projectPath = projects.getProjectPath(activeProject);
      if (projectPath) {
        lightweightWrapup(projectPath).catch((err) => {
          console.warn(`[telegram] Wrapup error: ${err}`);
        });
      }
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
