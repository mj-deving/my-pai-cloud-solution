// telegram.ts — Telegram bot for Isidore Cloud bridge
// Long polling (no webhook/HTTPS needed), sender validation, message chunking

import { Bot, GrammyError, type Context } from "grammy";
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
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { formatResponse, chunkMessage, toggleFormatMode, getFormatMode } from "./format";
import type { Scheduler } from "./scheduler";
import { StatusMessage } from "./status-message";
import type { ProgressEvent } from "./claude";
import type { MessengerAdapter } from "./messenger-adapter";
import type { ModeManager } from "./mode";
import { formatStatusline, type GitInfo } from "./statusline";
import { AuthManager } from "./auth";
import { createOrReusePR, upsertReviewComment, mergePR, findPR, runGh } from "./github";

/** Run codex exec --full-auto to fix review issues, commit + push if changes made */
async function runCodexAutofix(
  reviewOutput: string,
  cwd: string,
): Promise<{ fixed: boolean; commitHash?: string; output: string }> {
  const codexBin = `${process.env.HOME}/.npm-global/bin/codex`;

  const fixProc = Bun.spawn(
    [codexBin, "exec", "--full-auto",
      `Fix the following code review issues. Make minimal, surgical changes only. Do not refactor unrelated code:\n\n${reviewOutput}`],
    { cwd, stdout: "pipe", stderr: "pipe", timeout: 180_000 },
  );
  const fixOut = await new Response(fixProc.stdout).text();
  const fixExit = await fixProc.exited;

  if (fixExit !== 0) {
    return { fixed: false, output: `Auto-fix failed (exit ${fixExit})` };
  }

  // Check for changes
  const diffProc = Bun.spawn(["git", "diff", "--quiet"], { cwd, stdout: "pipe", stderr: "pipe" });
  const hasDiff = await diffProc.exited !== 0;
  const cachedProc = Bun.spawn(["git", "diff", "--cached", "--quiet"], { cwd, stdout: "pipe", stderr: "pipe" });
  const hasCached = await cachedProc.exited !== 0;

  if (!hasDiff && !hasCached) {
    return { fixed: false, output: "No changes made by auto-fix" };
  }

  // Stage modified files only (not untracked)
  const addProc = Bun.spawn(["git", "add", "-u"], { cwd, stdout: "pipe", stderr: "pipe" });
  await addProc.exited;

  // Commit
  const commitProc = Bun.spawn(
    ["git", "commit", "-m", "fix: address Codex review findings\n\nAuto-fixed by Codex"],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );
  if (await commitProc.exited !== 0) {
    return { fixed: false, output: "Auto-fix: commit failed" };
  }

  // Push
  const pushProc = Bun.spawn(["git", "push"], { cwd, stdout: "pipe", stderr: "pipe" });
  if (await pushProc.exited !== 0) {
    return { fixed: false, output: "Auto-fix: push failed" };
  }

  // Get commit hash
  const hashProc = Bun.spawn(["git", "rev-parse", "--short", "HEAD"], { cwd, stdout: "pipe", stderr: "pipe" });
  const hash = (await new Response(hashProc.stdout).text()).trim();

  return { fixed: true, commitHash: hash, output: fixOut };
}

export interface SynthesisLoopLike {
  run(): Promise<unknown>;
}

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
  modeManager?: ModeManager | null,
  synthesisLoop?: SynthesisLoopLike | null,
): Bot {
  const bot = new Bot(config.telegramBotToken);

  // Global error handler — prevents unhandled GrammyErrors from crashing the process
  bot.catch((err) => {
    const ctx = err.ctx;
    const e = err.error;
    console.error(`[telegram] bot.catch — update ${ctx.update.update_id}:`, e);
    // Best-effort reply to user (may fail if the error is from reply itself)
    ctx.reply("Something went wrong processing that message. Please try again.").catch(() => {});
  });

  const authManager = new AuthManager();

  // Cached git info to avoid running git on every message
  let cachedGitInfo: { info: GitInfo; ts: number } | null = null;
  const GIT_CACHE_TTL = 30_000; // 30s

  /** Turn raw Claude CLI errors into actionable Telegram messages. */
  function friendlyError(raw: string): string {
    if (raw.includes("No conversation found with session ID")) {
      return "Session expired. Send another message to start fresh.";
    }
    if (raw.includes("authentication_failed") || raw.includes("OAuth token has expired") || raw.includes("authentication_error")) {
      return "OAuth token expired. Use /reauth to re-authenticate from your phone.";
    }
    if (raw.includes("bun': No such file") || (raw.includes("hook") && raw.includes("failed"))) {
      return "Hook failure on VPS — check bun symlink and hook paths.";
    }
    if (raw.includes("rate_limit") || raw.includes("429") || raw.includes("overloaded")) {
      return "Rate limited by Anthropic. Wait a few minutes and retry.";
    }
    if (/exited with code \d+:\s*$/.test(raw)) {
      return "Claude crashed with no output. Likely a hook failure — check VPS logs.";
    }
    return raw;
  }

  /** Safe reply with Markdown — falls back to plain text only on Markdown parse errors. */
  async function safeReply(ctx: Context, text: string, extra?: Record<string, unknown>): Promise<void> {
    try {
      await ctx.reply(text, { parse_mode: "Markdown", ...extra });
    } catch (err) {
      // Only retry without Markdown on parse errors (HTTP 400 "can't parse entities")
      // Let other errors (429 flood, network) propagate to bot.catch
      if (err instanceof GrammyError && err.error_code === 400 && err.description.includes("parse")) {
        await ctx.reply(text);
      } else {
        throw err;
      }
    }
  }

  /** Send "typing..." repeatedly until stopped. Telegram expires it after ~5s. */
  function startTypingLoop(chatId: number): () => void {
    const send = () => bot.api.sendChatAction(chatId, "typing").catch(() => {});
    send();
    const interval = setInterval(send, 4000);
    return () => clearInterval(interval);
  }

  async function getGitInfo(): Promise<GitInfo | undefined> {
    const mode = modeManager?.getCurrentMode();
    if (!mode) return undefined;

    let dir: string | undefined;
    if (mode.type === "project") {
      const activeProject = projects.getActiveProject();
      if (activeProject) dir = projects.getProjectPath(activeProject) ?? undefined;
    } else {
      dir = config.workspaceDir;
    }
    if (!dir) return undefined;

    // Return cached if fresh
    if (cachedGitInfo && Date.now() - cachedGitInfo.ts < GIT_CACHE_TTL) {
      return cachedGitInfo.info;
    }

    try {
      const [branchProc, statusProc] = [
        Bun.spawn(["git", "branch", "--show-current"], { cwd: dir, stdout: "pipe", stderr: "pipe" }),
        Bun.spawn(["git", "status", "--porcelain"], { cwd: dir, stdout: "pipe", stderr: "pipe" }),
      ];
      const [branchOut, statusOut] = await Promise.all([
        new Response(branchProc.stdout).text(),
        new Response(statusProc.stdout).text(),
      ]);
      const branch = branchOut.trim() || "detached";
      const lines = statusOut.trim().split("\n").filter(Boolean);
      let changed = 0;
      let untracked = 0;
      for (const line of lines) {
        if (line.startsWith("??")) untracked++;
        else changed++;
      }
      const info: GitInfo = { branch, changed, untracked };
      cachedGitInfo = { info, ts: Date.now() };
      return info;
    } catch {
      return undefined;
    }
  }

  // Invalidate git cache on mode switch
  modeManager?.onChange(() => { cachedGitInfo = null; });

  // Helper: build statusline for current state
  const buildStatusline = async (): Promise<string> => {
    if (!modeManager) return "";
    const mode = modeManager.getCurrentMode();
    const now = new Date();
    const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const projectName = mode.type === "project" ? mode.name : undefined;
    const episodeCount = memoryStore?.getEpisodeCount(projectName) ?? 0;
    const contextPercent = modeManager.getContextPercent();
    const git = await getGitInfo();
    return formatStatusline(mode, {
      time,
      messageCount: modeManager.getMessageCount(),
      contextPercent,
      episodeCount,
      formatMode: getFormatMode(),
      git,
    });
  };

  // Helper: append statusline to last chunk
  const appendStatusline = async (chunks: string[]): Promise<string[]> => {
    if (!modeManager || chunks.length === 0) return chunks;
    const statusline = await buildStatusline();
    const result = [...chunks];
    result[result.length - 1] += `\n\n\`\`\`\n${statusline}\n\`\`\``;
    return result;
  };

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

    const mode = modeManager?.getCurrentMode();
    const modeStr = mode ? (mode.type === "workspace" ? "workspace" : `project (${mode.name})`) : "unknown";

    let msg = `Isidore Cloud bridge active.\n\n`;
    msg += `Mode: ${modeStr}\n`;
    msg += `Session: ${session ? session.slice(0, 8) + "..." : "none"}\n`;
    msg += `Project: ${activeProject ? activeProject.displayName : "none"}\n`;
    msg += `Available: ${projectList.map((p) => p.name).join(", ") || "none"}\n`;
    msg += `\nCommands: /help for details\n`;
    msg += `/workspace — Switch to workspace mode\n`;
    msg += `/project <name> — Switch to project mode\n`;
    msg += `/projects — List available projects\n`;
    msg += `/wrapup — Session wrapup (writes MEMORY.md + CLAUDE.md)\n`;
    msg += `/keep — Dismiss auto-wrapup suggestion\n`;
    msg += `/help [cmd] — Command help\n`;
    msg += `/sync — Commit, push + status\n`;
    msg += `/pull — Pull latest from remote\n`;
    msg += `/new — Fresh conversation\n`;
    msg += `/status — Current session info\n`;
    msg += `/clear — Archive & restart\n`;
    msg += `/compact — Compact context\n`;
    msg += `/verbose — Toggle light/raw output\n`;
    msg += `/oneshot <msg> — One-shot (no session)\n`;
    msg += `/quick <msg> — Quick answer (lightweight model)\n`;
    msg += `/delegate <prompt> — Delegate task to Gregor\n`;
    msg += `/workflow create <prompt> — Create workflow\n`;
    msg += `/workflows — List workflows\n`;
    msg += `/cancel <id> — Cancel workflow\n`;
    msg += `/pipeline — Pipeline dashboard\n`;
    msg += `/schedule — Manage scheduled tasks\n`;
    msg += `/review [branch] — Codex review a cloud/* branch (posts to PR)\n`;
    msg += `/merge cloud/<name> — Merge cloud branch via GitHub PR\n`;
    msg += `/branches — List cloud/* branches\n`;
    msg += `/deploy — Pull latest & restart bridge\n`;
    msg += `/reauth — Re-authenticate Claude CLI\n`;
    msg += `/newproject <name> — Create new project\n`;
    msg += `/deleteproject <name> — Remove project`;

    await ctx.reply(msg);
  });

  // /help — Command help
  const helpTexts: Record<string, string> = {
    workspace: "`/workspace` (alias `/home`)\nSwitch to workspace mode — autonomous operations, daily memory, agent interactions.",
    project: "`/project NAME`\nSwitch to project mode for a git-tracked repo. Session is per-project.\nExample: `/project my-pai-cloud-solution`",
    projects: "`/projects`\nList all registered projects with their session status.",
    wrapup: "`/wrapup`\nSession wrapup — synthesizes two files:\n- **MEMORY.md**: operational knowledge, session continuity, learnings\n- **CLAUDE.md**: architecture hygiene (remove stale, add new)\n\nRun before `/clear` to persist context across sessions.",
    keep: "`/keep`\nDismiss the auto-wrapup suggestion. Context continues growing.",
    sync: "`/sync`\nCommit + push current project changes, create/reuse a GitHub PR, then run Codex review (posted to PR as comment). If CODEX_AUTOFIX=1, auto-fixes issues and pushes.",
    pull: "`/pull`\nPull latest from remote. Skips if uncommitted changes exist.\n`/pull --force` — discard all local changes and reset to origin/main.",
    review: "`/review [cloud/branch-name]`\nReview a cloud/* branch using Codex. Posts review as PR comment if PR exists. If CODEX_AUTOFIX=1, auto-fixes issues and pushes. No argument lists available branches.\nExample: `/review cloud/pipeline-fixes`",
    merge: "`/merge cloud/branch-name`\nMerge a cloud/* branch via its GitHub PR, then sync local main and clean up the branch.",
    deploy: "`/deploy`\nPull latest code from origin/main and restart the bridge.\nWarns if uncommitted files will be overwritten — use `/deploy force` to proceed.\nShows commit list on success.",
    new: "`/new`\nStart a fresh conversation (new session ID). Does NOT persist context — use `/wrapup` first.",
    status: "`/status`\nShow current mode, session ID, message count, token usage, context %, and episode count.",
    clear: "`/clear`\nGenerate session summary, archive the session, and start fresh.",
    compact: "`/compact`\nCompress conversation context to free up token space.",
    verbose: "`/verbose`\nToggle output format:\n- **Light** (default): strips noise (curl, time checks, ISC gates, audits). Keeps all content.\n- **Raw**: full unmodified Claude output.",
    oneshot: "`/oneshot MESSAGE`\nOne-shot question — fresh context, no session persistence.",
    quick: "`/quick MESSAGE`\nQuick answer using a lightweight model (haiku).",
    delegate: "`/delegate PROMPT`\nDelegate a task to Gregor via the reverse pipeline.",
    workflow: "`/workflow create PROMPT` — Create a multi-step workflow\n`/workflows` — List active workflows\n`/workflow ID` — Workflow details\n`/cancel ID` — Cancel a workflow",
    pipeline: "`/pipeline`\nShow pipeline dashboard — pending/active tasks, recent results.",
    schedule: "`/schedule`\nManage scheduled tasks. Sub-commands: `enable`, `disable`, `run`, or list all.",
    newproject: "`/newproject NAME`\nCreate a new project — GitHub repo, VPS clone, CLAUDE.md scaffold, registry entry.",
    deleteproject: "`/deleteproject NAME`\nRemove a project from the registry.",
    branches: "`/branches`\nList all `cloud/*` branches on the remote for the active project.",
    reauth: "`/reauth`\nRe-authenticate the Claude CLI with a fresh OAuth token.\nUseful when auth expires on the VPS.",
    help: "`/help [command]`\nShow help for a specific command, or list all commands.",
  };

  bot.command("help", async (ctx) => {
    const arg = ctx.match?.trim().toLowerCase();

    if (arg && helpTexts[arg]) {
      try {
        await ctx.reply(helpTexts[arg], { parse_mode: "Markdown" });
      } catch {
        // Markdown parse failure (e.g. special chars) — fallback to plain text
        await ctx.reply(helpTexts[arg]);
      }
      return;
    }

    if (arg) {
      await ctx.reply(`Unknown command: "${arg}"\n\nAvailable: ${Object.keys(helpTexts).map(c => `/${c}`).join(", ")}`);
      return;
    }

    // No argument — grouped overview
    let msg = "**Commands**\n\n";
    msg += "**Mode:**\n/workspace · /project · /projects\n\n";
    msg += "**Session:**\n/wrapup · /keep · /clear · /compact · /verbose · /new · /status\n\n";
    msg += "**Git:**\n/sync · /pull · /review · /merge\n\n";
    msg += "**Quick:**\n/oneshot · /quick\n\n";
    msg += "**Pipeline:**\n/delegate · /workflow · /workflows · /cancel · /pipeline\n\n";
    msg += "**Admin:**\n/deploy · /schedule · /branches · /newproject · /deleteproject · /reauth\n\n";
    msg += "Use `/help command` for details.";
    await safeReply(ctx, msg);
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

    await safeReply(ctx, msg);
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

    // 5. Switch project + session + cwd
    const result = await projects.setActiveProject(target.name);
    if (!result) {
      await ctx.reply("Failed to switch project.");
      return;
    }

    if (result.path) {
      claude.setWorkingDirectory(result.path);
    }

    // Emit mode change to project
    if (modeManager) {
      modeManager.switchToProject(target.name);
    }

    const autoDetected = cloneResult.autoDetected || result.autoDetected;
    let msg = `Switched to **${target.displayName}**\n`;
    if (result.path) {
      msg += `Path: \`${result.path}\`${autoDetected ? " (auto-detected)" : ""}\n`;
    } else {
      msg += "Path: not configured for this instance\n";
    }
    msg += pullResult.ok ? "Git: pulled latest" : `Git: ${pullResult.output}`;

    if (modeManager) {
      msg += `\n\n\`\`\`\n${await buildStatusline()}\n\`\`\``;
    }

    await safeReply(ctx, msg);
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

    await safeReply(ctx, msg);
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

    await safeReply(ctx, msg);
  });

  // /sync — Commit + push + status + Codex review
  bot.command("sync", async (ctx) => {
    const activeProject = projects.getActiveProject();
    if (!activeProject) {
      await ctx.reply("No active project. Use /project <name> first.");
      return;
    }

    const stopTyping = startTypingLoop(ctx.chat.id);

    // 1. Git commit + push
    const gitResult = await projects.syncPush(activeProject);

    // Build status summary
    const session = await sessions.current();
    const path = projects.getProjectPath(activeProject);

    // Extract branch name from output (project-sync.sh prints "BRANCH: cloud/...")
    const branchMatch = gitResult.output.match(/BRANCH: (cloud\/\S+)/);
    const cloudBranch = branchMatch?.[1];

    let msg = `**Sync: ${activeProject.displayName}**\n\n`;
    msg += `Git: ${gitResult.ok ? "pushed" : gitResult.output}\n`;
    if (cloudBranch) {
      msg += `Branch: \`${cloudBranch}\`\n`;
    }
    msg += `Session: ${session ? session.slice(0, 8) + "..." : "none"}\n`;
    if (path) msg += `Path: \`${path}\`\n`;
    msg += "\n";

    // 2. Create or reuse PR after successful push
    let prCreated = false;
    if (gitResult.ok && cloudBranch && path) {
      const prResult = await createOrReusePR(
        cloudBranch,
        cloudBranch.replace("cloud/", ""),
        `Cloud sync from Isidore.\n\nBranch: \`${cloudBranch}\``,
        path,
      );
      if (prResult.ok && prResult.pr) {
        msg += `PR: ${prResult.pr.url}\n`;
        msg += `Merge: \`/merge ${cloudBranch}\``;
        prCreated = true;
      }
    }

    if (!prCreated) {
      // Fallback: old-style hints
      if (cloudBranch) {
        msg += `Review: \`/review ${cloudBranch}\`\nMerge: \`/merge ${cloudBranch}\``;
      } else if (activeProject.paths.local) {
        msg += `To pick up locally:\n`;
        msg += `\`cd ${activeProject.paths.local} && git pull\``;
      } else {
        msg += "Cloud-only project — no local path configured.";
      }
    }

    stopTyping();
    await safeReply(ctx, msg);

    // 3. Run Codex review and post to PR (async, non-blocking)
    if (gitResult.ok && cloudBranch) {
      const projectDir = projects.getProjectPath(activeProject);
      if (projectDir) {
        const reviewTyping = startTypingLoop(ctx.chat.id);
        try {
          const codexBin = `${process.env.HOME}/.npm-global/bin/codex`;
          const reviewArgs = [codexBin, "review", "--base", "main"];
          const reviewProc = Bun.spawn(reviewArgs, {
            cwd: projectDir,
            stdout: "pipe",
            stderr: "pipe",
            timeout: 120_000,
          });
          const reviewOut = (await new Response(reviewProc.stdout).text()).trim();
          const reviewExit = await reviewProc.exited;

          reviewTyping();
          if (reviewExit === 0 && reviewOut && !reviewOut.includes("CODEX_REVIEW_FAILED")) {
            const codexLine = reviewOut.split("\n").findIndex(l => l.startsWith("codex"));
            const reviewBody = codexLine >= 0
              ? reviewOut.slice(reviewOut.indexOf("\n", reviewOut.indexOf("codex")) + 1).trim()
              : reviewOut;

            if (reviewBody && reviewBody.length > 10) {
              // Post review to PR as comment
              const prPostResult = await upsertReviewComment(cloudBranch, reviewBody, projectDir);
              const truncated = reviewBody.length > 3500
                ? reviewBody.slice(0, 3500) + "\n...(truncated)"
                : reviewBody;
              const prNote = prPostResult.ok ? " (posted to PR)" : "";
              let autofixNote = "";

              // Auto-fix if issues found and enabled
              const hasIssues = /\[P[0-3]\]/.test(reviewBody);
              if (hasIssues && config.codexAutofixEnabled) {
                await ctx.replyWithChatAction("typing");
                // Checkout cloud branch for fix
                const coProc = Bun.spawn(["git", "checkout", cloudBranch], { cwd: projectDir, stdout: "pipe", stderr: "pipe" });
                if (await coProc.exited === 0) {
                  const fixResult = await runCodexAutofix(reviewBody, projectDir);
                  if (fixResult.fixed) {
                    autofixNote = `\nAuto-fix: applied and pushed (\`${fixResult.commitHash}\`)`;
                  } else {
                    autofixNote = `\nAuto-fix: ${fixResult.output}`;
                  }
                  const returnProc = Bun.spawn(["git", "checkout", "main"], { cwd: projectDir, stdout: "pipe", stderr: "pipe" });
                  const returnExit = await returnProc.exited;
                  if (returnExit !== 0) {
                    const returnErr = (await new Response(returnProc.stderr).text()).trim();
                    autofixNote += `\nBranch restore failed: ${returnErr.slice(0, 200)}`;
                  }
                }
              }

              await safeReply(ctx, `**Codex Review${prNote}:**\n${truncated}${autofixNote}`);
            } else {
              await ctx.reply("Codex review: no issues found.");
            }
          } else if (reviewExit !== 0) {
            const reason = reviewOut.includes("401") || reviewOut.includes("Unauthorized")
              ? "auth expired — run `codex auth` on VPS"
              : reviewOut.includes("429") || reviewOut.includes("rate")
              ? "rate limit reached"
              : reviewOut.includes("timeout") || reviewOut.includes("Timeout")
              ? "timed out"
              : `exited with code ${reviewExit}`;
            await ctx.reply(`Codex review unavailable (${reason}).`).catch(() => {});
          }
        } catch {
          reviewTyping();
        }
      }
    }
  });

  // /pull [--force] — Pull latest from remote for active project
  bot.command("pull", async (ctx) => {
    const activeProject = projects.getActiveProject();
    if (!activeProject) {
      await ctx.reply("No active project. Use /project <name> first.");
      return;
    }

    const arg = ctx.match?.trim();
    const force = arg === "--force" || arg === "-f";

    await ctx.replyWithChatAction("typing");

    if (force) {
      const pullResult = await projects.syncForcePull(activeProject);
      let msg = `**Force Pull: ${activeProject.displayName}**\n\n`;
      msg += `Git: ${pullResult.ok ? "reset to origin/main" : pullResult.output}`;
      await safeReply(ctx, msg);
    } else {
      const pullResult = await projects.syncPull(activeProject);
      let msg = `**Pull: ${activeProject.displayName}**\n\n`;
      msg += `Git: ${pullResult.ok ? "pulled latest" : pullResult.output}`;
      await safeReply(ctx, msg);
    }
  });

  // /review [branch] — Review a cloud/* branch using Codex + Claude
  bot.command("review", async (ctx) => {
    const branch = ctx.match?.trim();
    const activeProject = projects.getActiveProject();
    const projectDir = activeProject ? projects.getProjectPath(activeProject) : null;

    if (!projectDir) {
      await ctx.reply("No active project. Use /project <name> first.");
      return;
    }

    await ctx.replyWithChatAction("typing");

    // List branches if no argument
    if (!branch) {
      try {
        const fetchProc = Bun.spawn(["git", "fetch", "origin", "--prune"], { cwd: projectDir, stdout: "pipe", stderr: "pipe" });
        await fetchProc.exited;
        const listProc = Bun.spawn(["git", "branch", "-r", "--list", "origin/cloud/*"], { cwd: projectDir, stdout: "pipe", stderr: "pipe" });
        const branches = (await new Response(listProc.stdout).text()).trim();
        if (!branches) {
          await ctx.reply("No cloud/* branches found.");
        } else {
          const names = branches.split("\n").map(b => b.trim().replace("origin/", ""));
          await safeReply(ctx, `**Cloud branches:**\n${names.map(n => `• \`${n}\``).join("\n")}\n\nUsage: \`/review cloud/branch-name\``);
        }
      } catch {
        await ctx.reply("Failed to list branches.");
      }
      return;
    }

    // Validate branch name
    if (!branch.startsWith("cloud/")) {
      await safeReply(ctx, "Only cloud/* branches can be reviewed. Usage: `/review cloud/branch-name`");
      return;
    }

    const statusMsg = await ctx.reply(`Reviewing \`${branch}\`...`).catch(() => null);

    try {
      // Fetch and verify branch exists
      const fetchProc = Bun.spawn(["git", "fetch", "origin"], { cwd: projectDir, stdout: "pipe", stderr: "pipe" });
      await fetchProc.exited;

      const verifyProc = Bun.spawn(["git", "rev-parse", `origin/${branch}`], { cwd: projectDir, stdout: "pipe", stderr: "pipe" });
      if (await verifyProc.exited !== 0) {
        await safeReply(ctx, `Branch \`origin/${branch}\` not found.`);
        return;
      }

      // Get diff stats
      const statsProc = Bun.spawn(["git", "diff", "--stat", `main...origin/${branch}`], { cwd: projectDir, stdout: "pipe", stderr: "pipe" });
      const stats = (await new Response(statsProc.stdout).text()).trim();

      // Get commit log
      const logProc = Bun.spawn(["git", "log", "--oneline", `main..origin/${branch}`], { cwd: projectDir, stdout: "pipe", stderr: "pipe" });
      const commitLog = (await new Response(logProc.stdout).text()).trim();

      // Checkout branch for review — abort if both attempts fail
      const checkoutProc = Bun.spawn(["git", "checkout", branch], { cwd: projectDir, stdout: "pipe", stderr: "pipe" });
      const checkoutExit = await checkoutProc.exited;
      if (checkoutExit !== 0) {
        // Try creating local tracking branch
        const trackProc = Bun.spawn(["git", "checkout", "-b", branch, `origin/${branch}`], { cwd: projectDir, stdout: "pipe", stderr: "pipe" });
        const trackExit = await trackProc.exited;
        if (trackExit !== 0) {
          const trackErr = (await new Response(trackProc.stderr).text()).trim();
          await safeReply(ctx, `Cannot checkout \`${branch}\` — dirty working tree or branch conflict.\n${trackErr.slice(0, 200)}`);
          return;
        }
      }

      // Run Codex review
      const codexBin = `${process.env.HOME}/.npm-global/bin/codex`;
      const codexProc = Bun.spawn([codexBin, "review", "--base", "main"], { cwd: projectDir, stdout: "pipe", stderr: "pipe", timeout: 120_000 });
      const codexOut = await new Response(codexProc.stdout).text();
      const codexExit = await codexProc.exited;

      // Auto-fix: if review found issues and CODEX_AUTOFIX is enabled, fix before returning to main
      const codexReviewBody = codexOut.trim();
      const hasIssues = /\[P[0-3]\]/.test(codexReviewBody);
      let autofixNote = "";
      if (hasIssues && config.codexAutofixEnabled && codexExit === 0) {
        await ctx.replyWithChatAction("typing");
        const fixResult = await runCodexAutofix(codexReviewBody, projectDir);
        if (fixResult.fixed) {
          autofixNote = `\n**Auto-fix:** Applied and pushed (\`${fixResult.commitHash}\`). Re-review recommended.\n`;
        } else {
          autofixNote = `\n**Auto-fix:** ${fixResult.output}\n`;
        }
      }

      // Return to main
      Bun.spawn(["git", "checkout", "main"], { cwd: projectDir, stdout: "pipe", stderr: "pipe" });

      // Post review to PR as comment (if PR exists)
      let prNote = "";
      if (codexExit === 0 && codexReviewBody && codexReviewBody.length > 10) {
        const prPostResult = await upsertReviewComment(branch, codexReviewBody, projectDir);
        if (prPostResult.ok) prNote = " (posted to PR)";
      }

      // Check for PR URL
      const pr = await findPR(branch, projectDir);

      // Build review message
      let msg = `**Review: \`${branch}\`**\n\n`;
      if (pr) msg += `PR: ${pr.url}\n\n`;
      msg += `**Commits:**\n\`\`\`\n${commitLog}\n\`\`\`\n\n`;
      msg += `**Changes:**\n\`\`\`\n${stats}\n\`\`\`\n\n`;
      if (codexExit === 0 && codexReviewBody && codexReviewBody.length > 10) {
        msg += `**Codex Review${prNote}:**\n${codexOut.slice(-3000)}\n\n`;
      } else if (codexExit === 0) {
        msg += `**Codex Review:** No issues found.\n\n`;
      } else {
        // Extract reason from output
        const reason = codexOut.includes("401") || codexOut.includes("Unauthorized")
          ? "Codex auth expired — run `codex auth` on VPS"
          : codexOut.includes("timeout") || codexOut.includes("Timeout")
          ? "Codex review timed out"
          : codexOut.includes("rate") || codexOut.includes("429")
          ? "Codex rate limit reached"
          : `Codex exited with code ${codexExit}`;
        msg += `**Codex Review:** Unavailable (${reason})\nReview the diff above manually.\n\n`;
      }
      if (autofixNote) msg += autofixNote;
      msg += `To merge: \`/merge ${branch}\``;

      // Chunk and send
      const chunks = chunkMessage(msg, 4000);
      for (const chunk of chunks) {
        await safeReply(ctx, chunk);
      }
    } catch (err) {
      await ctx.reply(`Review failed: ${String(err).slice(0, 200)}`);
      // Return to main on error
      Bun.spawn(["git", "checkout", "main"], { cwd: projectDir, stdout: "pipe", stderr: "pipe" });
    }
  });

  // /merge <branch> — Merge a reviewed cloud/* branch into main
  bot.command("merge", async (ctx) => {
    const branch = ctx.match?.trim();
    const activeProject = projects.getActiveProject();
    const projectDir = activeProject ? projects.getProjectPath(activeProject) : null;

    if (!projectDir) {
      await ctx.reply("No active project. Use /project <name> first.");
      return;
    }

    if (!branch || !branch.startsWith("cloud/")) {
      await safeReply(ctx, "Usage: `/merge cloud/branch-name`");
      return;
    }

    const stopTyping = startTypingLoop(ctx.chat.id);

    try {
      const result = await mergePR(branch, projectDir);
      stopTyping();

      if (result.ok) {
        await safeReply(ctx, `Merged \`${branch}\` → main via PR.\n${result.output}`);
      } else if (result.output.includes("No open PR")) {
        await safeReply(ctx, `No open PR found for \`${branch}\`.\nCreate one first with \`/sync\`, or push the branch and create a PR on GitHub.`);
      } else if (result.output.includes("PR merged, but")) {
        await safeReply(ctx, `${result.output.slice(0, 500)}\nThe PR was merged on GitHub. Run \`/pull\` to sync locally.`);
      } else {
        await safeReply(ctx, `Merge failed: ${result.output.slice(0, 500)}`);
      }
    } catch (err) {
      stopTyping();
      await ctx.reply(`Merge error: ${String(err).slice(0, 300)}`);
    }
  });

  // /deploy [force] — Pull latest code from origin/main and restart bridge
  bot.command("deploy", async (ctx) => {
    const force = ctx.match?.trim().toLowerCase() === "force";
    const stopTyping = startTypingLoop(ctx.chat.id);
    const scriptPath = join(dirname(import.meta.dir), "scripts", "self-deploy.sh");

    try {
      // Step 1: Check for updates and dirty state
      if (!force) {
        const checkProc = Bun.spawn(["bash", scriptPath, "--check"], {
          stdout: "pipe",
          stderr: "pipe",
          timeout: 30_000,
        });
        const checkOut = (await new Response(checkProc.stdout).text()).trim();
        await checkProc.exited;

        if (checkOut.startsWith("ALREADY_CURRENT")) {
          stopTyping();
          await ctx.reply("Already up to date. No changes to deploy.");
          return;
        }

        // Parse dirty files warning
        if (checkOut.includes("DIRTY_FILES")) {
          const lines = checkOut.split("\n");
          const dirtyStart = lines.indexOf("DIRTY_FILES");
          const dirtyEnd = lines.indexOf("END_DIRTY");
          const dirtyFiles = lines.slice(dirtyStart + 1, dirtyEnd).join("\n");

          // Parse pending commits
          const pendingIdx = lines.indexOf("PENDING");
          const pendingCommits = pendingIdx >= 0 ? lines.slice(pendingIdx + 1).join("\n").trim() : "";

          let msg = "**Deploy will overwrite uncommitted files:**\n";
          msg += `\`\`\`\n${dirtyFiles}\n\`\`\`\n`;
          if (pendingCommits) msg += `\n**Pending commits:**\n\`\`\`\n${pendingCommits}\n\`\`\`\n`;
          msg += "\nSend `/deploy force` to proceed, or `/sync` first to save changes.";

          stopTyping();
          await safeReply(ctx, msg);
          return;
        }
      }

      // Step 2: Actually deploy
      const proc = Bun.spawn(["bash", scriptPath], {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 60_000,
      });
      const stdout = (await new Response(proc.stdout).text()).trim();
      const stderr = (await new Response(proc.stderr).text()).trim();
      const exitCode = await proc.exited;

      if (stdout.startsWith("ALREADY_CURRENT")) {
        stopTyping();
        await ctx.reply("Already up to date. No changes to deploy.");
        return;
      }

      if (exitCode !== 0) {
        stopTyping();
        const errDetail = stderr ? `\n\`\`\`\n${stderr.slice(0, 500)}\n\`\`\`` : "";
        await safeReply(ctx, `Deploy failed.${errDetail}`);
        return;
      }

      if (stdout.includes("UPDATED")) {
        const lines = stdout.split("\n");
        const depsUpdated = lines.includes("DEPS_UPDATED");
        const updatedIdx = lines.indexOf("UPDATED");
        const commits = lines.slice(updatedIdx + 1)
          .filter(l => l !== "DEPS_UPDATED" && !l.startsWith("DIRTY_FILES") && l !== "END_DIRTY")
          .join("\n").trim();

        let msg = "Deploy successful.";
        if (commits) msg += `\n\n**Commits:**\n\`\`\`\n${commits}\n\`\`\``;
        if (depsUpdated) msg += "\n\nDependencies updated.";
        msg += "\n\nRestarting in 3s...";

        stopTyping();
        await safeReply(ctx, msg);

        setTimeout(() => {
          Bun.spawn(["sudo", "systemctl", "restart", "isidore-cloud-bridge"], {
            stdout: "ignore",
            stderr: "ignore",
          });
        }, 3000);
        return;
      }

      stopTyping();
      await safeReply(ctx, `Deploy returned unexpected output:\n\`\`\`\n${stdout.slice(0, 500)}\n\`\`\``);
    } catch (err) {
      stopTyping();
      await ctx.reply(`Deploy error: ${String(err).slice(0, 300)}`);
    }
  });

  // /new — Start a new conversation session
  bot.command("new", async (ctx) => {
    await sessions.newSession();
    await ctx.reply(
      "Session cleared. Next message starts a fresh conversation.",
    );
  });

  // /status — Show current session + project info + mode
  bot.command("status", async (ctx) => {
    const { current, archived } = await sessions.list();
    const activeProject = projects.getActiveProject();
    const path = activeProject ? projects.getProjectPath(activeProject) : null;
    const mode = modeManager?.getCurrentMode();

    let msg = "";
    if (mode) {
      msg += `**Mode:** ${mode.type === "workspace" ? "workspace" : `project (${mode.name})`}\n`;
    }
    msg += `**Project:** ${activeProject ? activeProject.displayName : "none"}\n`;
    if (path) msg += `**Path:** \`${path}\`\n`;
    msg += `**Session:** ${current ? current.slice(0, 8) + "..." : "none"}\n`;
    if (modeManager) {
      msg += `**Messages:** ${modeManager.getMessageCount()}\n`;
      const usage = modeManager.getLastUsage();
      if (usage) {
        const totalInput = (usage.input_tokens || 0) +
          (usage.cache_creation_input_tokens || 0) +
          (usage.cache_read_input_tokens || 0);
        msg += `**Tokens:** ${totalInput.toLocaleString()} input, ${usage.output_tokens.toLocaleString()} output\n`;
      }
      const ctxPct = modeManager.getContextPercent();
      if (ctxPct != null) msg += `**Context:** ${ctxPct}%\n`;
    }
    msg += `**Archived:** ${archived.length} sessions`;
    if (archived.length > 0) {
      msg += `\nMost recent: ${archived[0]?.slice(0, 20)}...`;
    }
    if (modeManager) {
      msg += `\n\n\`\`\`\n${await buildStatusline()}\n\`\`\``;
    }
    await safeReply(ctx, msg);
  });

  // /clear — Archive current session and start fresh (with session summary)
  bot.command("clear", async (ctx) => {
    // Generate session summary before clearing (non-blocking on failure)
    if (memoryStore) {
      const stopTyping = startTypingLoop(ctx.chat.id);
      try {
        await ctx.reply("Generating session summary...");
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
            const project = projects.getActiveProjectName() ?? undefined;
            await memoryStore.record({
              timestamp: new Date().toISOString(),
              source: "session_summary",
              project,
              session_id: (await sessions.current()) ?? undefined,
              role: "system",
              content: summaryResponse.result.slice(0, 1000),
              summary: "Session summary before /clear",
              importance: 9,
            });
          }
        }
      } catch (err) {
        console.warn(`[telegram] Session summary generation failed: ${err}`);
      } finally {
        stopTyping();
      }
    }

    await sessions.clear();
    await ctx.reply(
      "Session cleared and archived. Next message starts fresh.",
    );
  });

  // /compact — Send /compact to Claude to compress context
  bot.command("compact", async (ctx) => {
    await ctx.reply("Compacting context...");
    const stopTyping = startTypingLoop(ctx.chat.id);
    const response = await claude.send("/compact");
    stopTyping();
    if (response.error) {
      await ctx.reply(`⚠️ ${friendlyError(response.error)}`);
      return;
    }
    await ctx.reply("Context compacted.");
  });

  // /verbose — Toggle output format between light strip and raw
  bot.command("verbose", async (ctx) => {
    const mode = toggleFormatMode();
    const desc = mode === "raw"
      ? "Raw — full unmodified output"
      : "Light — noise stripped, content preserved";
    await ctx.reply(`Output format: ${desc}`);
  });

  // /oneshot <message> — One-shot invocation (no session)
  bot.command("oneshot", async (ctx) => {
    const message = ctx.match;
    if (!message) {
      await ctx.reply("Usage: /oneshot <your message>");
      return;
    }
    await ctx.reply("Processing (one-shot)...");
    const stopTyping = startTypingLoop(ctx.chat.id);
    const response = await claude.oneShot(message);
    stopTyping();
    if (response.error) {
      await ctx.reply(`⚠️ ${friendlyError(response.error)}`);
      return;
    }
    const formatted = formatResponse(response.result);
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
    const stopTyping = startTypingLoop(ctx.chat.id);
    const response = await claude.quickShot(message);
    stopTyping();
    if (response.error) {
      await ctx.reply(`⚠️ ${friendlyError(response.error)}`);
      return;
    }
    const formatted = formatResponse(response.result);
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
      await safeReply(ctx,
        `**Delegated to Gregor**\nTask: \`${taskId.slice(0, 8)}...\`\n` +
          (projectName ? `Project: ${projectName}\n` : "") +
          `Status: pending\n\nYou'll be notified when the result arrives.`,
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
        await safeReply(ctx, orchestrator.getWorkflowSummary(wf));
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
      await safeReply(ctx, msg);
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

      const stopTyping = startTypingLoop(ctx.chat.id);
      await ctx.reply("Creating workflow...");

      const activeProject = projects.getActiveProject();
      const result = await orchestrator.createWorkflow(
        rest,
        activeProject?.name,
      );
      stopTyping();

      if (result.error) {
        await ctx.reply(`Failed: ${result.error}`);
        return;
      }

      const wf = result.workflow!;
      const stepSummary = wf.steps
        .map((s) => `  ${s.id} (${s.assignee}) ${s.description}`)
        .join("\n");

      await safeReply(ctx,
        `**Workflow created: \`${wf.id.slice(0, 8)}...\`**\n` +
          `Steps: ${wf.steps.length}\n\n${stepSummary}`,
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

    await safeReply(ctx, orchestrator.getWorkflowSummary(wf));
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

    await safeReply(ctx, msg);
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
      await safeReply(ctx, `Workflow \`${wf.id.slice(0, 8)}...\` cancelled.`);
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

    await safeReply(ctx, msg);
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

    await safeReply(ctx, msg);
  });

  // /workspace or /home — Switch to workspace mode
  bot.command(["workspace", "home"], async (ctx) => {
    if (!modeManager) {
      await ctx.reply("Mode manager not available.");
      return;
    }

    // If in project mode, auto-push before switching and clear active project
    const currentProject = projects.getActiveProject();
    if (currentProject) {
      const pushResult = await projects.syncPush(currentProject);
      if (pushResult.ok) {
        console.log(`[telegram] Auto-pushed ${currentProject.name} before workspace switch`);
      }
      await projects.clearActiveProject();
    }

    modeManager.switchToWorkspace();
    claude.setWorkingDirectory(config.workspaceDir);

    // Load workspace session
    const wsSession = sessions.getWorkspaceSession();
    if (wsSession) {
      await sessions.saveSession(wsSession);
    }

    const statusline = await buildStatusline();
    await ctx.reply(`Switched to workspace mode.\n\n\`\`\`\n${statusline}\n\`\`\``);
  });

  // /wrapup — Manual session wrapup (both modes)
  bot.command("wrapup", async (ctx) => {
    if (!modeManager) {
      await ctx.reply("Mode manager not available.");
      return;
    }

    const stopTyping = startTypingLoop(ctx.chat.id);
    await performWrapup(ctx.chat.id);
    stopTyping();
    const statusline = await buildStatusline();
    await ctx.reply(`Session wrapped up. Fresh context started.\n\n\`\`\`\n${statusline}\n\`\`\``);
  });

  // /keep — Cancel pending auto-wrapup
  bot.command("keep", async (ctx) => {
    if (!modeManager) {
      await ctx.reply("Mode manager not available.");
      return;
    }
    modeManager.requestKeep();
    await ctx.reply("Got it — wrapup suggestion dismissed.");
  });

  // Compute Claude Code's auto-memory path for a project directory.
  // Claude Code normalizes: replace / and _ with -, strip dots.
  function computeAutoMemoryPath(projectDir: string): string {
    const home = process.env.HOME || "/home/isidore_cloud";
    const slug = projectDir.replace(/[/_]/g, "-").replace(/\./g, "");
    return join(home, ".claude", "projects", slug, "memory", "MEMORY.md");
  }

  // Helper: perform session wrapup (shared between suggestion and manual)
  async function performWrapup(chatId?: number): Promise<void> {
    if (!memoryStore || !modeManager) return;

    // Gather recent episodes (used for both summary and file synthesis)
    const recentEpisodes = memoryStore.getEpisodesSince(
      Math.max(0, memoryStore.getLastEpisodeId() - 20), 20,
    );
    const conversationText = recentEpisodes
      .map(ep => `[${ep.role}] ${(ep.summary || ep.content).slice(0, 150)}`)
      .join("\n");

    // 1. Generate session summary → memory.db episode (both modes)
    try {
      if (recentEpisodes.length > 0) {
        const summaryPrompt = `Summarize this conversation in 3-5 bullets: what was discussed, what was decided, what's pending.\n\n${conversationText.slice(0, 2000)}`;
        const summaryResponse = await claude.quickShot(summaryPrompt);
        if (summaryResponse.result && !summaryResponse.error) {
          const project = projects.getActiveProjectName() ?? undefined;
          await memoryStore.record({
            timestamp: new Date().toISOString(),
            source: "session_summary",
            project,
            session_id: (await sessions.current()) ?? undefined,
            role: "system",
            content: summaryResponse.result.slice(0, 1000),
            summary: "Session summary (wrapup)",
            importance: 9,
          });
        }
      }
    } catch (err) {
      console.warn(`[telegram] Wrapup summary failed: ${err}`);
    }

    // 2. In project mode: write MEMORY.md + CLAUDE.md (mirrors local wrapup Steps 3+6)
    const activeProject = projects.getActiveProject();
    if (activeProject) {
      const projectDir = projects.getProjectPath(activeProject);
      if (projectDir) {
        await writeWrapupFiles(projectDir, activeProject.displayName, conversationText);
      }
    }

    // 3. Rotate session + reset metrics
    await sessions.rotateWorkspaceSession();
    modeManager.resetSessionMetrics();
    await sessions.newSession();
  }

  // Write MEMORY.md and CLAUDE.md for a project (mirrors local wrapup Steps 3+6)
  async function writeWrapupFiles(
    projectDir: string,
    displayName: string,
    conversationText: string,
  ): Promise<void> {
    const now = new Date().toISOString();

    // --- Step 3: Synthesize MEMORY.md ---
    try {
      const memoryPath = computeAutoMemoryPath(projectDir);
      let currentMemory = "";
      try {
        currentMemory = await readFile(memoryPath, "utf-8");
      } catch {
        // No existing MEMORY.md — will create fresh
      }

      const synthesizePrompt = `You are synthesizing the auto-memory file for a project. This is a FULL REWRITE — every section gets a fresh pass based on current content and recent conversation.

PROJECT: ${displayName}
WRAPUP TIME: ${now}

CURRENT MEMORY.md (may be empty):
${currentMemory.slice(0, 2000)}

RECENT CONVERSATION:
${conversationText.slice(0, 2000)}

SYNTHESIS RULES:
1. REWRITE completely — do not append. Every section gets a fresh pass.
2. Keep under 150 lines total. Trim least-important items proportionally if over.
3. No internal redundancy — info appears in one section only.
4. No cross-file duplication — never include architecture, config, or design decisions (those belong in CLAUDE.md).
5. Promote, don't hoard — if an operational detail is important enough for every session, note it for CLAUDE.md promotion instead of keeping it here.
6. Preserve stable information (credentials, key paths) verbatim.
7. Update dynamic sections (session continuity, active next steps).
8. Remove stale entries (completed next steps, outdated state, resolved issues).
9. Add new entries from this session (new decisions, learnings, next steps).

CONTENT BOUNDARIES — strict two-file separation:
- CLAUDE.md owns: architecture, config, design decisions, build commands, module table, VPS details, conventions
- MEMORY.md owns: everything else — operational knowledge, debugging learnings, credentials, session continuity, current focus, next steps, blockers

Format:
# ${displayName} — Session Memory

> Architecture and config live in **CLAUDE.md** (git-tracked).
> This file holds **operational knowledge**, **session continuity**, and **debugging learnings**.

## Session Continuity

**Last wrapup:** ${now}
**Current focus:** [1-2 sentences on what was being worked on]

### Completed This Session
- [what was done]

### In Progress
- [active work items, or "None"]

### Next Steps
1. [prioritized next actions, max 5]

### Blockers
- [anything blocking progress, or "None"]

## Operational Knowledge (not in CLAUDE.md)
- [paths, credentials, config NOT in CLAUDE.md]

## Patterns & Learnings
- [what works, what to avoid, debugging insights]

## File Ownership Rules
| File | Owns | Written by |
|------|------|-----------|
| **CLAUDE.md** | Architecture, config, design decisions | Implementation commits + wrapup hygiene |
| **MEMORY.md** | Operational knowledge, session continuity, learnings | Auto-memory + wrapup |

**Rule:** Never duplicate between these two files. Promote to CLAUDE.md if it belongs there.

Respond with ONLY the markdown content, no code fences.`;

      const memoryResponse = await claude.quickShot(synthesizePrompt);
      if (memoryResponse.result && !memoryResponse.error) {
        await mkdir(dirname(memoryPath), { recursive: true });
        await writeFile(memoryPath, memoryResponse.result.trim() + "\n", "utf-8");
        console.log(`[telegram] Wrapup: wrote MEMORY.md (${memoryPath})`);
      }
    } catch (err) {
      console.warn(`[telegram] Wrapup MEMORY.md synthesis failed: ${err}`);
    }

    // --- Step 6: Synthesize CLAUDE.md with hygiene ---
    try {
      const claudeMdPath = join(projectDir, "CLAUDE.md");
      let currentClaudeMd = "";
      try {
        currentClaudeMd = await readFile(claudeMdPath, "utf-8");
      } catch {
        // No CLAUDE.md — skip, don't create from scratch
      }

      if (currentClaudeMd) {
        const claudeMdPrompt = `You are performing hygiene on a project's CLAUDE.md file. This file is auto-loaded by Claude Code every session and must stay current, concise, and high-signal.

PROJECT: ${displayName}

CURRENT CLAUDE.md:
${currentClaudeMd.slice(0, 4000)}

RECENT CONVERSATION (what changed this session):
${conversationText.slice(0, 2000)}

HYGIENE RULES — apply all of these:
1. REMOVE stale content: completed work, resolved issues, one-time decisions, outdated descriptions
2. REMOVE noise: task-specific details that don't apply to every session
3. REMOVE duplication: anything that belongs in MEMORY.md (operational knowledge, debugging tips, session state, next steps)
4. UPDATE descriptions that no longer match current behavior (e.g., changed thresholds, new flows)
5. ADD new architectural changes from this session: new modules, changed message flows, new commands, new design decisions
6. KEEP: architecture, config, design decisions, build/run commands, module responsibilities, VPS details, conventions, commands reference
7. Target: ≤ 150 lines total

CONTENT BOUNDARIES — strict two-file separation:
- CLAUDE.md owns: architecture, config, design decisions, build commands, module table, VPS details, conventions
- MEMORY.md owns: operational knowledge, debugging learnings, credentials, session continuity, current focus, next steps, blockers
- NEVER put session state, next steps, or debugging tips in CLAUDE.md

Rewrite the CLAUDE.md completely. Preserve its structure and sections. Output ONLY the markdown, no code fences.`;

        const claudeMdResponse = await claude.quickShot(claudeMdPrompt);
        if (claudeMdResponse.result && !claudeMdResponse.error) {
          await writeFile(claudeMdPath, claudeMdResponse.result.trim() + "\n", "utf-8");
          console.log(`[telegram] Wrapup: wrote CLAUDE.md (${claudeMdPath})`);
        }
      }
    } catch (err) {
      console.warn(`[telegram] Wrapup CLAUDE.md hygiene failed: ${err}`);
    }
  }

  // /reauth — Re-authenticate Claude CLI via OAuth from mobile
  bot.command("reauth", async (ctx) => {
    const status = await authManager.checkStatus();
    const statusText = status.valid
      ? `Current token valid until ${status.expiresAt!.toISOString().slice(0, 16).replace("T", " ")} UTC`
      : "Current token is expired or missing";

    const url = authManager.startAuth();

    await safeReply(ctx,
      `🔐 **OAuth Re-authentication**\n\n` +
      `${statusText}\n\n` +
      `**Steps:**\n` +
      `1. Tap the link below\n` +
      `2. Sign in to claude.ai\n` +
      `3. Copy the authorization code shown\n` +
      `4. Paste it here as your next message\n\n` +
      `⏱ You have 5 minutes.\n\n` +
      `[Authenticate →](${url})`,
      { link_preview_options: { is_disabled: true } },
    );
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
      await safeReply(ctx, msg);
    }
  });

  // Default: forward message to Claude in the active session
  bot.on("message:text", async (ctx) => {
    const message = ctx.message.text;
    const chatId = ctx.chat.id;

    // Intercept auth code if we're in the /reauth flow
    if (authManager.isAwaitingCode()) {
      const result = await authManager.exchangeCode(message);
      if (result.ok) {
        await ctx.reply("✅ Re-authenticated successfully. Claude CLI is ready.");
      } else {
        await ctx.reply(`❌ Auth failed: ${result.error}`);
      }
      return;
    }

    // Typing indicator — repeats every 4s until response arrives
    const stopTyping = startTypingLoop(chatId);

    // Create a live status message for progress tracking
    let statusMsgId: number | null = null;
    let currentPhase = "";
    try {
      const statusMsg = await ctx.api.sendMessage(chatId, "Processing...");
      statusMsgId = statusMsg.message_id;
    } catch { /* status message is optional */ }

    let lastEditTime = 0;
    let lastEditText = "";
    const editInterval = config.statusEditIntervalMs;
    const maxStatusLen = 3000; // Leave room under Telegram's 4096 limit

    const editStatus = (text: string) => {
      if (!statusMsgId) return;
      // Skip if text hasn't changed
      if (text === lastEditText) return;
      const now = Date.now();
      if (now - lastEditTime < editInterval) return;
      lastEditTime = now;
      lastEditText = text;
      ctx.api.editMessageText(chatId, statusMsgId, text).catch(() => {});
    };

    // Rolling content buffer for live preview
    let contentBuffer = "";
    let toolLog: string[] = [];

    const buildStatusView = (): string => {
      const header = `━━━ ${currentPhase || "processing"} ━━━`;
      let tools = toolLog.length > 0 ? toolLog.slice(-5).join("\n") : "";
      if (tools.length > 500) tools = tools.slice(-500);
      // Trim content to fit, keeping the tail (most recent)
      let content = contentBuffer;
      const overhead = header.length + tools.length + 10;
      if (content.length + overhead > maxStatusLen) {
        content = "…" + content.slice(-(maxStatusLen - overhead));
      }
      const parts = [header];
      if (tools) parts.push(tools);
      if (content) parts.push(content);
      return parts.join("\n\n");
    };

    const onProgress = (event: ProgressEvent) => {
      switch (event.type) {
        case "phase":
          currentPhase = event.phase;
          editStatus(buildStatusView());
          break;
        case "tool_start": {
          const detail = event.detail ? `: ${event.detail.slice(0, 60)}` : "";
          toolLog.push(`▸ ${event.tool}${detail}`.slice(0, 80));
          editStatus(buildStatusView());
          break;
        }
        case "tool_end":
          // Mark last matching tool as done
          for (let i = toolLog.length - 1; i >= 0; i--) {
            if (toolLog[i]!.startsWith(`▸ ${event.tool}`)) {
              toolLog[i] = toolLog[i]!.replace("▸", "✓");
              break;
            }
          }
          editStatus(buildStatusView());
          break;
        case "content":
          contentBuffer = event.text;
          editStatus(buildStatusView());
          break;
        case "isc_progress":
          editStatus(buildStatusView() + `\n\nISC ${event.done}/${event.total}`);
          break;
      }
    };

    const response = await claude.send(message, onProgress);

    stopTyping();

    // Remove the status message (replaced by actual response)
    if (statusMsgId) {
      ctx.api.deleteMessage(chatId, statusMsgId).catch(() => {});
    }

    if (response.error) {
      await ctx.reply(`⚠️ ${friendlyError(response.error)}`);
      return;
    }

    // Track message BEFORE building statusline so CTX% and msg count are current
    if (modeManager) {
      modeManager.recordMessage(response.usage, response.contextWindow, response.lastTurnUsage);
    }

    const retryNote = response.retried ? "↻ Recovered after retry\n\n" : "";
    const formatted = retryNote + formatResponse(response.result);
    const rawChunks = chunkMessage(formatted, config.telegramMaxChunkSize);
    const chunks = await appendStatusline(rawChunks);

    for (const chunk of chunks) {
      await ctx.reply(chunk);
    }

    // Suggest-only wrapup check (both modes)
    if (modeManager) {
      const suggestion = modeManager.shouldSuggestWrapup();
      if (suggestion.suggest) {
        modeManager.markSuggestionSent();
        await ctx.reply(`\u26A0\uFE0F ${suggestion.reason}`);
      }

      // Importance-triggered synthesis flush
      if (memoryStore && synthesisLoop) {
        try {
          const unsynthesized = memoryStore.getUnsynthesizedImportanceSum();
          if (unsynthesized > config.workspaceImportanceFlushThreshold) {
            synthesisLoop.run().catch(err =>
              console.warn(`[telegram] Importance-triggered synthesis failed: ${err}`),
            );
          }
        } catch (err) {
          console.warn(`[telegram] Importance flush check error: ${err}`);
        }
      }
    }

    // Record conversation to memory (non-blocking, with importance scoring)
    if (memoryStore) {
      const now = new Date().toISOString();
      const project = projects.getActiveProjectName() ?? undefined;
      const sessionId = (await sessions.current()) ?? undefined;

      // User message: record directly (importance defaults to 5)
      memoryStore.record({
        timestamp: now,
        source: "telegram",
        project,
        session_id: sessionId,
        role: "user",
        content: message.slice(0, 1000),
      }).catch(err => console.warn(`[telegram] Memory record (user) error: ${err}`));

      // Assistant message: generate summary + importance via haiku, strip formatting, cap content
      (async () => {
        try {
          // Strip Algorithm formatting (phase headers, ━━━ lines, box chars)
          let cleanContent = response.result
            .replace(/━+.*?━+/g, "")
            .replace(/[═╔╗╚╝║╠╣╦╩╬┌┐└┘├┤┬┴┼─│]/g, "")
            .replace(/♻︎|🗒️|🔎|💪🏼|🏹|🧠|📐|🔨|⚡|✅|📚|🔄|📃|🔧|🗣️|📋/g, "")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
          cleanContent = cleanContent.slice(0, 1000);

          const { summary, importance } = await claude.rateAndSummarize(cleanContent);

          await memoryStore.record({
            timestamp: now,
            source: "telegram",
            project,
            session_id: sessionId,
            role: "assistant",
            content: cleanContent,
            summary,
            importance,
          });
        } catch (err) {
          // Fallback: record without rating
          memoryStore.record({
            timestamp: now,
            source: "telegram",
            project,
            session_id: sessionId,
            role: "assistant",
            content: response.result.slice(0, 1000),
            summary: formatted.slice(0, 200),
          }).catch(e => console.warn(`[telegram] Memory record fallback error: ${e}`));
          console.warn(`[telegram] Memory rating error: ${err}`);
        }
      })();
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
