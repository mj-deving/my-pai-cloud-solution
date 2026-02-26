// config.ts — Central configuration for Isidore Cloud bridge service
// Reads from environment variables with sensible defaults

export interface Config {
  // Telegram
  telegramBotToken: string;
  telegramAllowedUserId: number;

  // Email (optional — Phase 4)
  emailImapHost?: string;
  emailImapPort?: number;
  emailImapUser?: string;
  emailImapPass?: string;
  emailSmtpHost?: string;
  emailSmtpPort?: number;
  emailFromAddress?: string;
  emailAllowedSenders?: string[];

  // Session
  sessionIdFile: string;
  claudeBinary: string;

  // Project handoff
  projectRegistryFile: string;
  handoffStateFile: string;
  projectSyncScript: string;
  knowledgeSyncScript: string;

  // Limits
  telegramMaxChunkSize: number; // Telegram API limit is 4096
  maxClaudeTimeoutMs: number;
}

export function loadConfig(): Config {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is required");
  }

  const userId = process.env.TELEGRAM_ALLOWED_USER_ID;
  if (!userId) {
    throw new Error("TELEGRAM_ALLOWED_USER_ID is required");
  }

  return {
    telegramBotToken: token,
    telegramAllowedUserId: parseInt(userId, 10),

    emailImapHost: process.env.EMAIL_IMAP_HOST,
    emailImapPort: process.env.EMAIL_IMAP_PORT
      ? parseInt(process.env.EMAIL_IMAP_PORT, 10)
      : 993,
    emailImapUser: process.env.EMAIL_IMAP_USER,
    emailImapPass: process.env.EMAIL_IMAP_PASS,
    emailSmtpHost: process.env.EMAIL_SMTP_HOST,
    emailSmtpPort: process.env.EMAIL_SMTP_PORT
      ? parseInt(process.env.EMAIL_SMTP_PORT, 10)
      : 587,
    emailFromAddress: process.env.EMAIL_FROM_ADDRESS,
    emailAllowedSenders: process.env.EMAIL_ALLOWED_SENDERS?.split(","),

    sessionIdFile:
      process.env.SESSION_ID_FILE ||
      `${process.env.HOME}/.claude/active-session-id`,
    claudeBinary: process.env.CLAUDE_BINARY || "claude",

    projectRegistryFile:
      process.env.PROJECT_REGISTRY_FILE ||
      `${process.env.HOME}/pai-knowledge/HANDOFF/projects.json`,
    handoffStateFile:
      process.env.HANDOFF_STATE_FILE ||
      `${process.env.HOME}/.claude/handoff-state.json`,
    projectSyncScript:
      process.env.PROJECT_SYNC_SCRIPT ||
      `${process.env.HOME}/projects/my-pai-cloud-solution/scripts/project-sync.sh`,
    knowledgeSyncScript:
      process.env.KNOWLEDGE_SYNC_SCRIPT ||
      `${process.env.HOME}/projects/my-pai-cloud-solution/scripts/sync-knowledge.sh`,

    telegramMaxChunkSize: 4000, // Leave margin below 4096 API limit
    maxClaudeTimeoutMs: 5 * 60 * 1000, // 5 minutes max per invocation
  };
}
