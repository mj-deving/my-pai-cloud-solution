// config.ts — Central configuration for Isidore Cloud bridge service
// Reads from environment variables with Zod validation (Phase 1: Pipeline Hardening)

import { z } from "zod";

// Helper: parse optional numeric env var with validation
const optionalInt = (min: number, max: number, fallback: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v ? parseInt(v, 10) : fallback))
    .pipe(z.number().int().min(min).max(max));

// Helper: parse boolean-ish env var ("0" = false, anything else = true)
const envBool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? fallback : v !== "0"));

const EnvSchema = z.object({
  // Required
  TELEGRAM_BOT_TOKEN: z.string().min(1, "TELEGRAM_BOT_TOKEN is required"),
  TELEGRAM_ALLOWED_USER_ID: z
    .string()
    .min(1, "TELEGRAM_ALLOWED_USER_ID is required")
    .transform((v) => parseInt(v, 10))
    .pipe(z.number().int().positive()),

  // Email (optional — Phase 4)
  EMAIL_IMAP_HOST: z.string().optional(),
  EMAIL_IMAP_PORT: optionalInt(1, 65535, 993),
  EMAIL_IMAP_USER: z.string().optional(),
  EMAIL_IMAP_PASS: z.string().optional(),
  EMAIL_SMTP_HOST: z.string().optional(),
  EMAIL_SMTP_PORT: optionalInt(1, 65535, 587),
  EMAIL_FROM_ADDRESS: z.string().optional(),
  EMAIL_ALLOWED_SENDERS: z
    .string()
    .optional()
    .transform((v) => v?.split(",")),

  // Session
  SESSION_ID_FILE: z.string().optional(),
  CLAUDE_BINARY: z.string().optional(),

  // Project handoff
  PROJECT_REGISTRY_FILE: z.string().optional(),
  HANDOFF_STATE_FILE: z.string().optional(),
  PROJECT_SYNC_SCRIPT: z.string().optional(),
  KNOWLEDGE_SYNC_SCRIPT: z.string().optional(),

  // Pipeline
  PIPELINE_ENABLED: envBool(true),
  PIPELINE_DIR: z.string().optional(),
  PIPELINE_POLL_INTERVAL_MS: optionalInt(500, 300_000, 5_000),
  PIPELINE_MAX_CONCURRENT: optionalInt(1, 32, 1),

  // Reverse pipeline
  REVERSE_PIPELINE_ENABLED: envBool(true),
  REVERSE_PIPELINE_POLL_INTERVAL_MS: optionalInt(500, 300_000, 5_000),

  // Orchestrator
  ORCHESTRATOR_ENABLED: envBool(true),
  ORCHESTRATOR_MAX_DELEGATION_DEPTH: optionalInt(1, 10, 3),
  ORCHESTRATOR_WORKFLOW_TIMEOUT_MS: optionalInt(60_000, 7_200_000, 30 * 60 * 1000),

  // Branch isolation
  BRANCH_ISOLATION_ENABLED: envBool(true),
  BRANCH_ISOLATION_STALE_LOCK_MAX_MS: optionalInt(60_000, 86_400_000, 60 * 60 * 1000),

  // Resource guard
  RESOURCE_GUARD_ENABLED: envBool(true),
  RESOURCE_GUARD_MEMORY_THRESHOLD_MB: optionalInt(64, 16384, 512),

  // Rate limiter
  RATE_LIMITER_ENABLED: envBool(true),
  RATE_LIMITER_FAILURE_THRESHOLD: optionalInt(1, 100, 3),
  RATE_LIMITER_WINDOW_MS: optionalInt(10_000, 3_600_000, 300_000),
  RATE_LIMITER_COOLDOWN_MS: optionalInt(30_000, 7_200_000, 3_600_000),

  // Verifier
  VERIFIER_ENABLED: envBool(true),
  VERIFIER_TIMEOUT_MS: optionalInt(5_000, 300_000, 30_000),

  // Auto-commit after Telegram responses
  AUTO_COMMIT_ENABLED: envBool(false),

  // Quick model
  QUICK_MODEL: z.string().optional(),

  // Phase 1: Pipeline hardening
  PIPELINE_DEDUP_ENABLED: envBool(true),
  AGENT_REGISTRY_ENABLED: envBool(false),
  AGENT_REGISTRY_DB_PATH: z.string().optional(),
  AGENT_REGISTRY_HEARTBEAT_INTERVAL_MS: optionalInt(1_000, 300_000, 10_000),
  AGENT_REGISTRY_STALE_THRESHOLD_MS: optionalInt(5_000, 600_000, 60_000),
  MESSENGER_TYPE: z.string().optional(),

  // Phase 2: Dashboard
  DASHBOARD_ENABLED: envBool(false),
  DASHBOARD_PORT: optionalInt(1024, 65535, 3456),
  DASHBOARD_BIND: z.string().optional(),
  DASHBOARD_TOKEN: z.string().optional(),
  DASHBOARD_SSE_POLL_MS: optionalInt(500, 60_000, 2_000),

  // Phase 3 V2-A: Memory Store
  MEMORY_ENABLED: envBool(false),
  MEMORY_DB_PATH: z.string().optional(),
  MEMORY_OLLAMA_URL: z.string().optional(),
  MEMORY_EMBEDDING_MODEL: z.string().optional(),
  MEMORY_MAX_EPISODES: optionalInt(100, 100_000, 10_000),
  MEMORY_DECAY_LAMBDA: z
    .string()
    .optional()
    .transform((v) => (v ? parseFloat(v) : 0.023)),

  // Phase 3 V2-B: Context Injection
  CONTEXT_INJECTION_ENABLED: envBool(false),
  CONTEXT_MAX_TOKENS: optionalInt(500, 8_000, 2_000),
  CONTEXT_MAX_CHARS: optionalInt(1_000, 20_000, 5_000),

  // Phase 3 V2-C: Handoff
  HANDOFF_ENABLED: envBool(false),
  HANDOFF_DIR: z.string().optional(),
  HANDOFF_INACTIVITY_MINUTES: optionalInt(5, 120, 30),

  // Phase 3 V2-D: PRD Executor
  PRD_EXECUTOR_ENABLED: envBool(false),
  PRD_DETECTION_MIN_LENGTH: optionalInt(100, 5_000, 500),
  PRD_MAX_RETRIES: optionalInt(1, 10, 3),
  PRD_PROGRESS_INTERVAL_MS: optionalInt(5_000, 60_000, 15_000),

  // Phase 4: Injection Scanning
  INJECTION_SCAN_ENABLED: envBool(true),

  // Phase 4: Scheduler
  SCHEDULER_ENABLED: envBool(false),
  SCHEDULER_POLL_INTERVAL_MS: optionalInt(5_000, 300_000, 60_000),
  SCHEDULER_DB_PATH: z.string().optional(),

  // Phase 4: Policy Engine
  POLICY_ENABLED: envBool(false),
  POLICY_FILE: z.string().optional(),

  // Phase C: Synthesis Loop
  SYNTHESIS_ENABLED: envBool(false),
  SYNTHESIS_MIN_EPISODES: optionalInt(1, 100, 3),

  // Phase C: Agent Definitions
  AGENT_DEFINITIONS_ENABLED: envBool(false),
  AGENT_DEFINITIONS_DIR: z.string().optional(),

  // Phase D: Observation Masking
  OBSERVATION_MASKING_ENABLED: envBool(false),
  OBSERVATION_MASKING_WINDOW: optionalInt(1, 20, 5),

  // Phase D: Project Whiteboards
  WHITEBOARD_ENABLED: envBool(false),

  // Live status messages
  STATUS_EDIT_INTERVAL_MS: optionalInt(1000, 10_000, 2_500),
});

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
  pipelineMaxConcurrent: number;

  // Reverse pipeline (Isidore → Gregor delegation)
  reversePipelineEnabled: boolean;
  reversePipelinePollIntervalMs: number;

  // Orchestrator (DAG-based workflow decomposition)
  orchestratorEnabled: boolean;
  orchestratorMaxDelegationDepth: number;
  orchestratorWorkflowTimeoutMs: number;

  // Branch isolation (Phase 5C)
  branchIsolationEnabled: boolean;
  branchIsolationStaleLockMaxMs: number;

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

  // Auto-commit
  autoCommitEnabled: boolean;

  // Limits
  telegramMaxChunkSize: number;
  maxClaudeTimeoutMs: number;

  // Phase 1: Pipeline hardening
  pipelineDedupEnabled: boolean;
  agentRegistryEnabled: boolean;
  agentRegistryDbPath: string;
  agentRegistryHeartbeatIntervalMs: number;
  agentRegistryStaleThresholdMs: number;
  messengerType: string;

  // Phase 2: Dashboard
  dashboardEnabled: boolean;
  dashboardPort: number;
  dashboardBind: string;
  dashboardToken: string;
  dashboardSsePollMs: number;

  // Phase 3 V2-A: Memory Store
  memoryEnabled: boolean;
  memoryDbPath: string;
  memoryOllamaUrl: string;
  memoryEmbeddingModel: string;
  memoryMaxEpisodes: number;
  memoryDecayLambda: number;

  // Phase 3 V2-B: Context Injection
  contextInjectionEnabled: boolean;
  contextMaxTokens: number;
  contextMaxChars: number;

  // Phase 3 V2-C: Handoff
  handoffEnabled: boolean;
  handoffDir: string;
  handoffInactivityMinutes: number;

  // Phase 3 V2-D: PRD Executor
  prdExecutorEnabled: boolean;
  prdDetectionMinLength: number;
  prdMaxRetries: number;
  prdProgressIntervalMs: number;

  // Phase 4: Injection Scanning
  injectionScanEnabled: boolean;

  // Phase 4: Scheduler
  schedulerEnabled: boolean;
  schedulerPollIntervalMs: number;
  schedulerDbPath: string;

  // Phase 4: Policy Engine
  policyEnabled: boolean;
  policyFile: string;

  // Phase C: Synthesis Loop
  synthesisEnabled: boolean;
  synthesisMinEpisodes: number;

  // Phase C: Agent Definitions
  agentDefinitionsEnabled: boolean;
  agentDefinitionsDir: string;

  // Phase D: Observation Masking
  observationMaskingEnabled: boolean;
  observationMaskingWindow: number;

  // Phase D: Project Whiteboards
  whiteboardEnabled: boolean;

  // Live status messages
  statusEditIntervalMs: number;
}

export function loadConfig(): Config {
  const result = EnvSchema.safeParse(process.env);
  if (!result.success) {
    const msg = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("\n  ");
    throw new Error(`Configuration validation failed:\n  ${msg}`);
  }

  const env = result.data;
  const home = process.env.HOME || "/home/isidore_cloud";

  return {
    telegramBotToken: env.TELEGRAM_BOT_TOKEN,
    telegramAllowedUserId: env.TELEGRAM_ALLOWED_USER_ID,

    emailImapHost: env.EMAIL_IMAP_HOST,
    emailImapPort: env.EMAIL_IMAP_PORT,
    emailImapUser: env.EMAIL_IMAP_USER,
    emailImapPass: env.EMAIL_IMAP_PASS,
    emailSmtpHost: env.EMAIL_SMTP_HOST,
    emailSmtpPort: env.EMAIL_SMTP_PORT,
    emailFromAddress: env.EMAIL_FROM_ADDRESS,
    emailAllowedSenders: env.EMAIL_ALLOWED_SENDERS,

    sessionIdFile: env.SESSION_ID_FILE || `${home}/.claude/active-session-id`,
    claudeBinary: env.CLAUDE_BINARY || "claude",

    projectRegistryFile:
      env.PROJECT_REGISTRY_FILE || `${home}/pai-knowledge/HANDOFF/projects.json`,
    handoffStateFile:
      env.HANDOFF_STATE_FILE || `${home}/.claude/handoff-state.json`,
    projectSyncScript:
      env.PROJECT_SYNC_SCRIPT ||
      `${home}/projects/my-pai-cloud-solution/scripts/project-sync.sh`,
    knowledgeSyncScript:
      env.KNOWLEDGE_SYNC_SCRIPT ||
      `${home}/projects/my-pai-cloud-solution/scripts/sync-knowledge.sh`,

    pipelineEnabled: env.PIPELINE_ENABLED,
    pipelineDir: env.PIPELINE_DIR || "/var/lib/pai-pipeline",
    pipelinePollIntervalMs: env.PIPELINE_POLL_INTERVAL_MS,
    pipelineMaxConcurrent: env.PIPELINE_MAX_CONCURRENT,

    reversePipelineEnabled: env.REVERSE_PIPELINE_ENABLED,
    reversePipelinePollIntervalMs: env.REVERSE_PIPELINE_POLL_INTERVAL_MS,

    orchestratorEnabled: env.ORCHESTRATOR_ENABLED,
    orchestratorMaxDelegationDepth: env.ORCHESTRATOR_MAX_DELEGATION_DEPTH,
    orchestratorWorkflowTimeoutMs: env.ORCHESTRATOR_WORKFLOW_TIMEOUT_MS,

    branchIsolationEnabled: env.BRANCH_ISOLATION_ENABLED,
    branchIsolationStaleLockMaxMs: env.BRANCH_ISOLATION_STALE_LOCK_MAX_MS,

    resourceGuardEnabled: env.RESOURCE_GUARD_ENABLED,
    resourceGuardMemoryThresholdMb: env.RESOURCE_GUARD_MEMORY_THRESHOLD_MB,

    rateLimiterEnabled: env.RATE_LIMITER_ENABLED,
    rateLimiterFailureThreshold: env.RATE_LIMITER_FAILURE_THRESHOLD,
    rateLimiterWindowMs: env.RATE_LIMITER_WINDOW_MS,
    rateLimiterCooldownMs: env.RATE_LIMITER_COOLDOWN_MS,

    verifierEnabled: env.VERIFIER_ENABLED,
    verifierTimeoutMs: env.VERIFIER_TIMEOUT_MS,

    quickModel: env.QUICK_MODEL || "haiku",

    autoCommitEnabled: env.AUTO_COMMIT_ENABLED,
    telegramMaxChunkSize: 4000,
    maxClaudeTimeoutMs: 5 * 60 * 1000,

    // Phase 1: Pipeline hardening
    pipelineDedupEnabled: env.PIPELINE_DEDUP_ENABLED,
    agentRegistryEnabled: env.AGENT_REGISTRY_ENABLED,
    agentRegistryDbPath:
      env.AGENT_REGISTRY_DB_PATH || "/var/lib/pai-pipeline/agent-registry.db",
    agentRegistryHeartbeatIntervalMs: env.AGENT_REGISTRY_HEARTBEAT_INTERVAL_MS,
    agentRegistryStaleThresholdMs: env.AGENT_REGISTRY_STALE_THRESHOLD_MS,
    messengerType: env.MESSENGER_TYPE || "telegram",

    // Phase 2: Dashboard
    dashboardEnabled: env.DASHBOARD_ENABLED,
    dashboardPort: env.DASHBOARD_PORT,
    dashboardBind: env.DASHBOARD_BIND || "127.0.0.1",
    dashboardToken: env.DASHBOARD_TOKEN || "",
    dashboardSsePollMs: env.DASHBOARD_SSE_POLL_MS,

    // Phase 3 V2-A: Memory Store
    memoryEnabled: env.MEMORY_ENABLED,
    memoryDbPath: env.MEMORY_DB_PATH || `${home}/projects/my-pai-cloud-solution/data/memory.db`,
    memoryOllamaUrl: env.MEMORY_OLLAMA_URL || "http://localhost:11434",
    memoryEmbeddingModel: env.MEMORY_EMBEDDING_MODEL || "nomic-embed-text",
    memoryMaxEpisodes: env.MEMORY_MAX_EPISODES,
    memoryDecayLambda: env.MEMORY_DECAY_LAMBDA,

    // Phase 3 V2-B: Context Injection
    contextInjectionEnabled: env.CONTEXT_INJECTION_ENABLED,
    contextMaxTokens: env.CONTEXT_MAX_TOKENS,
    contextMaxChars: env.CONTEXT_MAX_CHARS,

    // Phase 3 V2-C: Handoff
    handoffEnabled: env.HANDOFF_ENABLED,
    handoffDir: env.HANDOFF_DIR || `${home}/.claude/handoff/`,
    handoffInactivityMinutes: env.HANDOFF_INACTIVITY_MINUTES,

    // Phase 3 V2-D: PRD Executor
    prdExecutorEnabled: env.PRD_EXECUTOR_ENABLED,
    prdDetectionMinLength: env.PRD_DETECTION_MIN_LENGTH,
    prdMaxRetries: env.PRD_MAX_RETRIES,
    prdProgressIntervalMs: env.PRD_PROGRESS_INTERVAL_MS,

    // Phase 4: Injection Scanning
    injectionScanEnabled: env.INJECTION_SCAN_ENABLED,

    // Phase 4: Scheduler
    schedulerEnabled: env.SCHEDULER_ENABLED,
    schedulerPollIntervalMs: env.SCHEDULER_POLL_INTERVAL_MS,
    schedulerDbPath: env.SCHEDULER_DB_PATH || env.AGENT_REGISTRY_DB_PATH || "/var/lib/pai-pipeline/agent-registry.db",

    // Phase 4: Policy Engine
    policyEnabled: env.POLICY_ENABLED,
    policyFile: env.POLICY_FILE || `${home}/projects/my-pai-cloud-solution/policy.yaml`,

    // Phase C: Synthesis Loop
    synthesisEnabled: env.SYNTHESIS_ENABLED,
    synthesisMinEpisodes: env.SYNTHESIS_MIN_EPISODES,

    // Phase C: Agent Definitions
    agentDefinitionsEnabled: env.AGENT_DEFINITIONS_ENABLED,
    agentDefinitionsDir: env.AGENT_DEFINITIONS_DIR || `${home}/projects/my-pai-cloud-solution/.pai/agents`,

    // Phase D: Observation Masking
    observationMaskingEnabled: env.OBSERVATION_MASKING_ENABLED,
    observationMaskingWindow: env.OBSERVATION_MASKING_WINDOW,

    // Phase D: Project Whiteboards
    whiteboardEnabled: env.WHITEBOARD_ENABLED,

    // Live status messages
    statusEditIntervalMs: env.STATUS_EDIT_INTERVAL_MS,
  };
}
