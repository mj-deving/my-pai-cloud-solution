// telegram.ts — Telegram bot for Isidore Cloud bridge
// Long polling (no webhook/HTTPS needed), sender validation, message chunking

import { Bot, type Context } from "grammy";
import type { Config } from "./config";
import type { ClaudeInvoker } from "./claude";
import type { SessionManager } from "./session";
import type { ProjectManager } from "./projects";
import type { ReversePipelineWatcher } from "./reverse-pipeline";
import type { TaskOrchestrator } from "./orchestrator";
import type { PipelineWatcher } from "./pipeline";
import type { BranchManager } from "./branch-manager";
import type { RateLimiter } from "./rate-limiter";
import type { MemoryStore } from "./memory";
import { compactFormat, chunkMessage } from "./format";
import { lightweightWrapup } from "./wrapup";
import type { Scheduler } from "./scheduler";
import { StatusMessage } from "./status-message";
import type { ProgressEvent } from "./claude";
import type { MessengerAdapter } from "./messenger-adapter";

export function createTelegramBot(
  config: Config,
  claude: ClaudeInvoker,
  sessions: SessionManager,
  projects: ProjectManager,
  reversePipeline?: ReversePipelineWatcher | null,
  orchestrator?: TaskOrchestrator | null,
  branchManager?: BranchManager | null,
  rateLimiter?: RateLimiter | null,
  memoryStore?: MemoryStore | null,
  scheduler?: Scheduler | null,
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
    msg += `/oneshot <msg> — One-shot (no session)\n`;
    msg += `/quick <msg> — Quick answer (lightweight model)\n`;
    msg += `/delegate <prompt> — Delegate task to Gregor\n`;
    msg += `/workflow create <prompt> — Create workflow\n`;
    msg += `/workflows — List workflows\n`;
    msg += `/workflow <id> — Workflow details\n`;
    msg += `/cancel <id> — Cancel workflow\n`;
    msg += `/branches — Active branch locks\n`;
    msg += `/pipeline — Pipeline dashboard\n`;
    msg += `/schedule — Manage scheduled tasks`;

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

  // /quick <message> — Quick answer using lightweight model (Phase 6C)
  bot.command("quick", async (ctx) => {
    const message = ctx.match;
    if (!message) {
      await ctx.reply("Usage: /quick <your message>\nUses a lightweight model for fast, cheap responses.");
      return;
    }
    await ctx.replyWithChatAction("typing");
    const response = await claude.quickShot(message);
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

  // /delegate <prompt> — Delegate a task to Gregor via reverse pipeline
  bot.command("delegate", async (ctx) => {
    const prompt = ctx.match?.trim();
    if (!prompt) {
      await ctx.reply("Usage: /delegate <prompt>\nSends a task to Gregor via the reverse pipeline.");
      return;
    }

    if (!reversePipeline) {
      await ctx.reply("Reverse pipeline is not enabled. Set REVERSE_PIPELINE_ENABLED=1.");
      return;
    }

    await ctx.replyWithChatAction("typing");

    const activeProject = projects.getActiveProject();
    const projectName = activeProject?.name;

    try {
      const taskId = await reversePipeline.delegateToGregor(prompt, projectName);
      await ctx.reply(
        `**Delegated to Gregor**\nTask: \`${taskId.slice(0, 8)}...\`\n` +
          (projectName ? `Project: ${projectName}\n` : "") +
          `Status: pending\n\nYou'll be notified when the result arrives.`,
        { parse_mode: "Markdown" },
      );
    } catch (err) {
      await ctx.reply(`Delegation failed: ${err}`);
    }
  });

  // /workflow — Create workflow or show workflow details
  bot.command("workflow", async (ctx) => {
    const input = ctx.match?.trim() || "";

    if (!input) {
      await ctx.reply(
        "Usage:\n/workflow create <prompt> — Create a new workflow\n/workflow status [id] — List all or show one\n/workflow <id> — Show workflow details",
      );
      return;
    }

    // Parse subcommand
    const firstSpace = input.indexOf(" ");
    const subcommand = firstSpace > 0 ? input.slice(0, firstSpace) : input;
    const rest = firstSpace > 0 ? input.slice(firstSpace + 1).trim() : "";

    if (subcommand === "status") {
      if (!orchestrator) {
        await ctx.reply("Orchestrator is not enabled.");
        return;
      }

      if (rest) {
        // /workflow status <id> — show specific workflow
        const wf = orchestrator.getWorkflow(rest);
        if (!wf) {
          await ctx.reply(`Workflow not found: "${rest}"`);
          return;
        }
        await ctx.reply(orchestrator.getWorkflowSummary(wf), { parse_mode: "Markdown" });
        return;
      }

      // /workflow status — list all
      const all = orchestrator.getAllWorkflows();
      if (all.length === 0) {
        await ctx.reply("No workflows. Use /workflow create <prompt> to start one.");
        return;
      }
      all.sort((a, b) => {
        if (a.status === "active" && b.status !== "active") return -1;
        if (b.status === "active" && a.status !== "active") return 1;
        return b.createdAt.localeCompare(a.createdAt);
      });
      let msg = "**Workflows:**\n\n";
      for (const wf of all) {
        const completed = wf.steps.filter((s) => s.status === "completed").length;
        msg += `\`${wf.id.slice(0, 8)}...\` [${wf.status}] ${completed}/${wf.steps.length} steps — ${wf.description.slice(0, 50)}\n`;
      }
      await ctx.reply(msg, { parse_mode: "Markdown" });
      return;
    }

    if (subcommand === "create") {
      if (!rest) {
        await ctx.reply("Usage: /workflow create <prompt>");
        return;
      }

      if (!orchestrator) {
        await ctx.reply("Orchestrator is not enabled. Set ORCHESTRATOR_ENABLED=1.");
        return;
      }

      await ctx.replyWithChatAction("typing");
      await ctx.reply("Creating workflow...");

      const activeProject = projects.getActiveProject();
      const result = await orchestrator.createWorkflow(
        rest,
        activeProject?.name,
      );

      if (result.error) {
        await ctx.reply(`Failed: ${result.error}`);
        return;
      }

      const wf = result.workflow!;
      const stepSummary = wf.steps
        .map((s) => `  ${s.id} (${s.assignee}) ${s.description}`)
        .join("\n");

      await ctx.reply(
        `**Workflow created: \`${wf.id.slice(0, 8)}...\`**\n` +
          `Steps: ${wf.steps.length}\n\n${stepSummary}`,
        { parse_mode: "Markdown" },
      );
      return;
    }

    // /workflow <id> — show details
    if (!orchestrator) {
      await ctx.reply("Orchestrator is not enabled.");
      return;
    }

    const wf = orchestrator.getWorkflow(subcommand);
    if (!wf) {
      await ctx.reply(`Workflow not found: "${subcommand}"`);
      return;
    }

    await ctx.reply(orchestrator.getWorkflowSummary(wf), { parse_mode: "Markdown" });
  });

  // /workflows — List all workflows
  bot.command("workflows", async (ctx) => {
    if (!orchestrator) {
      await ctx.reply("Orchestrator is not enabled.");
      return;
    }

    const all = orchestrator.getAllWorkflows();
    if (all.length === 0) {
      await ctx.reply("No workflows. Use /workflow create <prompt> to start one.");
      return;
    }

    // Sort: active first, then by creation date desc
    all.sort((a, b) => {
      if (a.status === "active" && b.status !== "active") return -1;
      if (b.status === "active" && a.status !== "active") return 1;
      return b.createdAt.localeCompare(a.createdAt);
    });

    let msg = "**Workflows:**\n\n";
    for (const wf of all) {
      const completed = wf.steps.filter((s) => s.status === "completed").length;
      msg += `\`${wf.id.slice(0, 8)}...\` [${wf.status}] ${completed}/${wf.steps.length} steps — ${wf.description.slice(0, 50)}\n`;
    }

    await ctx.reply(msg, { parse_mode: "Markdown" });
  });

  // /cancel <id> — Cancel active workflow
  bot.command("cancel", async (ctx) => {
    const id = ctx.match?.trim();
    if (!id) {
      await ctx.reply("Usage: /cancel <workflow-id>");
      return;
    }

    if (!orchestrator) {
      await ctx.reply("Orchestrator is not enabled.");
      return;
    }

    const wf = orchestrator.getWorkflow(id);
    if (!wf) {
      await ctx.reply(`Workflow not found: "${id}"`);
      return;
    }

    const cancelled = await orchestrator.cancelWorkflow(wf.id);
    if (cancelled) {
      await ctx.reply(`Workflow \`${wf.id.slice(0, 8)}...\` cancelled.`, { parse_mode: "Markdown" });
    } else {
      await ctx.reply(`Cannot cancel — workflow is ${wf.status}.`);
    }
  });

  // /branches — Show active branch locks (Phase 5C)
  bot.command("branches", async (ctx) => {
    if (!branchManager) {
      await ctx.reply("Branch isolation is not enabled. Set BRANCH_ISOLATION_ENABLED=1.");
      return;
    }

    const locks = await branchManager.getActiveLocks();
    if (locks.length === 0) {
      await ctx.reply("No active branch locks.");
      return;
    }

    let msg = "**Active Branch Locks:**\n\n";
    for (const lock of locks) {
      const age = Date.now() - new Date(lock.acquiredAt).getTime();
      const ageMin = Math.round(age / 60000);
      const projectName = lock.projectDir.split("/").pop() || lock.projectDir;
      msg += `\`${lock.branch}\` (${lock.source})\n`;
      msg += `  Project: ${projectName}\n`;
      msg += `  Task: \`${lock.taskId.slice(0, 8)}...\`\n`;
      msg += `  Age: ${ageMin}min\n\n`;
    }

    await ctx.reply(msg, { parse_mode: "Markdown" });
  });

  // /pipeline — Dashboard: forward + reverse pipeline + workflow status
  bot.command("pipeline", async (ctx) => {
    let msg = "**Pipeline Dashboard**\n\n";

    // Reverse pipeline
    if (reversePipeline) {
      const pending = reversePipeline.getPending();
      msg += `**Reverse Pipeline:**\n`;
      msg += `Pending delegations: ${pending.length}\n`;
      if (pending.length > 0) {
        for (const d of pending.slice(0, 5)) {
          msg += `  \`${d.taskId.slice(0, 8)}...\` ${d.prompt}\n`;
        }
      }
    } else {
      msg += `**Reverse Pipeline:** disabled\n`;
    }
    msg += `\n`;

    // Orchestrator
    if (orchestrator) {
      const active = orchestrator.getActiveWorkflows();
      msg += `**Orchestrator:**\n`;
      msg += `Active workflows: ${active.length}\n`;
      for (const wf of active.slice(0, 5)) {
        const completed = wf.steps.filter((s) => s.status === "completed").length;
        msg += `  \`${wf.id.slice(0, 8)}...\` ${completed}/${wf.steps.length} steps — ${wf.description.slice(0, 40)}\n`;
      }
    } else {
      msg += `**Orchestrator:** disabled\n`;
    }
    msg += `\n`;

    // Phase 6A: Rate limiter status
    if (rateLimiter) {
      const rlStatus = rateLimiter.getStatus();
      msg += `**Rate Limiter:**\n`;
      msg += `Status: ${rlStatus.paused ? "PAUSED (cooldown)" : "active"}\n`;
      msg += `Recent failures: ${rlStatus.recentFailures}/${rlStatus.threshold}\n`;
      if (rlStatus.paused && rlStatus.cooldownRemainingMs > 0) {
        const remainMin = Math.ceil(rlStatus.cooldownRemainingMs / 60000);
        msg += `Cooldown remaining: ~${remainMin}min\n`;
      }
    } else {
      msg += `**Rate Limiter:** disabled\n`;
    }

    await ctx.reply(msg, { parse_mode: "Markdown" });
  });

  // /schedule — Manage scheduled tasks
  bot.command("schedule", async (ctx) => {
    if (!scheduler) {
      await ctx.reply("Scheduler is disabled (SCHEDULER_ENABLED=0)");
      return;
    }

    const args = ctx.match?.trim().split(/\s+/) || [];
    const subcommand = args[0];
    const name = args[1];

    if (subcommand === "enable" && name) {
      const ok = scheduler.setEnabled(name, true);
      await ctx.reply(ok ? `Schedule "${name}" enabled.` : `Schedule "${name}" not found.`);
    } else if (subcommand === "disable" && name) {
      const ok = scheduler.setEnabled(name, false);
      await ctx.reply(ok ? `Schedule "${name}" disabled.` : `Schedule "${name}" not found.`);
    } else if (subcommand === "run" && name) {
      const ok = await scheduler.triggerNow(name);
      await ctx.reply(ok ? `Schedule "${name}" triggered.` : `Schedule "${name}" not found.`);
    } else {
      // List all schedules
      const schedules = scheduler.list();
      if (schedules.length === 0) {
        await ctx.reply("No schedules configured.");
        return;
      }
      let msg = "**Schedules:**\n\n";
      for (const s of schedules) {
        const status = s.enabled ? "ON" : "OFF";
        const lastRun = s.last_run ? s.last_run.slice(0, 16).replace("T", " ") : "never";
        const nextRun = s.next_run ? s.next_run.slice(0, 16).replace("T", " ") : "—";
        msg += `\`${s.name}\` [${status}]\n  Cron: \`${s.cron_expr}\`\n  Last: ${lastRun} | Next: ${nextRun}\n\n`;
      }
      msg += "Commands:\n`/schedule enable <name>`\n`/schedule disable <name>`\n`/schedule run <name>`";
      await ctx.reply(msg, { parse_mode: "Markdown" });
    }
  });

  // Default: forward message to Claude in the active session
  bot.on("message:text", async (ctx) => {
    const message = ctx.message.text;
    const chatId = ctx.chat.id;

    // Typing indicator
    await ctx.replyWithChatAction("typing");

    // Create a live status message for progress tracking
    let statusMsgId: number | null = null;
    let currentPhase = "";
    try {
      const statusMsg = await ctx.api.sendMessage(chatId, "Processing...");
      statusMsgId = statusMsg.message_id;
    } catch { /* status message is optional */ }

    let lastEditTime = 0;
    const editInterval = config.statusEditIntervalMs;

    const editStatus = (text: string) => {
      if (!statusMsgId) return;
      const now = Date.now();
      if (now - lastEditTime < editInterval) return;
      lastEditTime = now;
      ctx.api.editMessageText(chatId, statusMsgId, text).catch(() => {});
    };

    const onProgress = (event: ProgressEvent) => {
      switch (event.type) {
        case "phase":
          currentPhase = event.phase;
          editStatus(`━━━ ${event.phase} ━━━`);
          break;
        case "tool_start":
          editStatus(`━━━ ${currentPhase || "..."} ━━━ [${event.tool}]...`);
          break;
        case "tool_end":
          if (currentPhase) editStatus(`━━━ ${currentPhase} ━━━`);
          break;
        case "isc_progress":
          editStatus(`━━━ ${currentPhase || "..."} ━━━ ISC ${event.done}/${event.total}`);
          break;
      }
    };

    const response = await claude.send(message, onProgress);

    // Remove the status message (replaced by actual response)
    if (statusMsgId) {
      ctx.api.deleteMessage(chatId, statusMsgId).catch(() => {});
    }

    if (response.error) {
      await ctx.reply(`Error: ${response.error}`);
      return;
    }

    const formatted = compactFormat(response.result);
    const chunks = chunkMessage(formatted, config.telegramMaxChunkSize);

    for (const chunk of chunks) {
      await ctx.reply(chunk);
    }

    // Record conversation to memory (non-blocking)
    if (memoryStore) {
      const now = new Date().toISOString();
      const project = projects.getActiveProjectName() ?? undefined;
      const sessionId = (await sessions.current()) ?? undefined;
      memoryStore.record({
        timestamp: now,
        source: "telegram",
        project,
        session_id: sessionId,
        role: "user",
        content: message,
      }).catch(err => console.warn(`[telegram] Memory record (user) error: ${err}`));
      memoryStore.record({
        timestamp: now,
        source: "telegram",
        project,
        session_id: sessionId,
        role: "assistant",
        content: response.result,
        summary: formatted.slice(0, 200),
      }).catch(err => console.warn(`[telegram] Memory record (assistant) error: ${err}`));
    }

    // Auto-commit tracked changes after response (non-blocking, feature-flagged)
    if (config.autoCommitEnabled) {
      const activeProject = projects.getActiveProject();
      if (activeProject) {
        const projectPath = projects.getProjectPath(activeProject);
        if (projectPath) {
          lightweightWrapup(projectPath).catch((err) => {
            console.warn(`[telegram] Wrapup error: ${err}`);
          });
        }
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
