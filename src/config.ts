// Isidore Cloud was here — handoff test 2026-02-26
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

  // Pipeline (cross-user task queue)
  pipelineEnabled: boolean;
  pipelineDir: string;
  pipelinePollIntervalMs: number;
  pipelineMaxConcurrent: number; // Max simultaneous Claude dispatches

  // Reverse pipeline (Isidore → Gregor delegation)
  reversePipelineEnabled: boolean;
  reversePipelinePollIntervalMs: number;

  // Orchestrator (DAG-based workflow decomposition)
  orchestratorEnabled: boolean;
  orchestratorMaxDelegationDepth: number;
  orchestratorWorkflowTimeoutMs: number;

  // Branch isolation (Phase 5C)
  branchIsolationEnabled: boolean;
  branchIsolationStaleLockMaxMs: number; // Max age before stale lock cleanup

  // Resource guard (Phase 6A)
  resourceGuardEnabled: boolean;
  resourceGuardMemoryThresholdMb: number;

  // Rate limiter (Phase 6A)
  rateLimiterEnabled: boolean;
  rateLimiterFailureThreshold: number;
  rateLimiterWindowMs: number;
  rateLimiterCooldownMs: number;

  // Verifier (Phase 6B)
  verifierEnabled: boolean;
  verifierTimeoutMs: number;

  // Quick model (Phase 6C)
  quickModel: string;

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

    pipelineEnabled: process.env.PIPELINE_ENABLED !== "0",
    pipelineDir: process.env.PIPELINE_DIR || "/var/lib/pai-pipeline",
    pipelinePollIntervalMs: process.env.PIPELINE_POLL_INTERVAL_MS
      ? parseInt(process.env.PIPELINE_POLL_INTERVAL_MS, 10)
      : 5_000,
    pipelineMaxConcurrent: process.env.PIPELINE_MAX_CONCURRENT
      ? parseInt(process.env.PIPELINE_MAX_CONCURRENT, 10)
      : 1, // Default 1 = backwards compatible sequential

    reversePipelineEnabled: process.env.REVERSE_PIPELINE_ENABLED !== "0",
    reversePipelinePollIntervalMs: process.env.REVERSE_PIPELINE_POLL_INTERVAL_MS
      ? parseInt(process.env.REVERSE_PIPELINE_POLL_INTERVAL_MS, 10)
      : 5_000,

    orchestratorEnabled: process.env.ORCHESTRATOR_ENABLED !== "0",
    orchestratorMaxDelegationDepth: process.env.ORCHESTRATOR_MAX_DELEGATION_DEPTH
      ? parseInt(process.env.ORCHESTRATOR_MAX_DELEGATION_DEPTH, 10)
      : 3,
    orchestratorWorkflowTimeoutMs: process.env.ORCHESTRATOR_WORKFLOW_TIMEOUT_MS
      ? parseInt(process.env.ORCHESTRATOR_WORKFLOW_TIMEOUT_MS, 10)
      : 30 * 60 * 1000, // 30 minutes

    branchIsolationEnabled: process.env.BRANCH_ISOLATION_ENABLED !== "0",
    branchIsolationStaleLockMaxMs: process.env.BRANCH_ISOLATION_STALE_LOCK_MAX_MS
      ? parseInt(process.env.BRANCH_ISOLATION_STALE_LOCK_MAX_MS, 10)
      : 60 * 60 * 1000, // 1 hour

    resourceGuardEnabled: process.env.RESOURCE_GUARD_ENABLED !== "0",
    resourceGuardMemoryThresholdMb: process.env.RESOURCE_GUARD_MEMORY_THRESHOLD_MB
      ? parseInt(process.env.RESOURCE_GUARD_MEMORY_THRESHOLD_MB, 10)
      : 512,

    rateLimiterEnabled: process.env.RATE_LIMITER_ENABLED !== "0",
    rateLimiterFailureThreshold: process.env.RATE_LIMITER_FAILURE_THRESHOLD
      ? parseInt(process.env.RATE_LIMITER_FAILURE_THRESHOLD, 10)
      : 3,
    rateLimiterWindowMs: process.env.RATE_LIMITER_WINDOW_MS
      ? parseInt(process.env.RATE_LIMITER_WINDOW_MS, 10)
      : 300_000, // 5 minutes
    rateLimiterCooldownMs: process.env.RATE_LIMITER_COOLDOWN_MS
      ? parseInt(process.env.RATE_LIMITER_COOLDOWN_MS, 10)
      : 3_600_000, // 60 minutes

    verifierEnabled: process.env.VERIFIER_ENABLED !== "0",
    verifierTimeoutMs: process.env.VERIFIER_TIMEOUT_MS
      ? parseInt(process.env.VERIFIER_TIMEOUT_MS, 10)
      : 30_000, // 30 seconds

    quickModel: process.env.QUICK_MODEL || "haiku",

    telegramMaxChunkSize: 4000, // Leave margin below 4096 API limit
    maxClaudeTimeoutMs: 5 * 60 * 1000, // 5 minutes max per invocation
  };
}
