// types.ts — Core type definitions for bridge plugin architecture (Graduated Extraction Phase 3B)

import type { Config } from "./config";
import type { ClaudeInvoker } from "./claude";
import type { SessionManager } from "./session";
import type { ProjectManager } from "./projects";
import type { ModeManager } from "./mode";
import type { MemoryStore } from "./memory";
import type { ContextBuilder } from "./context";
import type { PipelineWatcher } from "./pipeline";
import type { ReversePipelineWatcher } from "./reverse-pipeline";
import type { TaskOrchestrator } from "./orchestrator";
import type { BranchManager } from "./branch-manager";
import type { RateLimiter } from "./rate-limiter";
import type { ResourceGuard } from "./resource-guard";
import type { HealthMonitor } from "./health-monitor";
import type { Scheduler } from "./scheduler";
import type { SynthesisLoop } from "./synthesis";
import type { PRDExecutor } from "./prd-executor";
import type { AgentRegistry } from "./agent-registry";
import type { IdempotencyStore } from "./idempotency";
import type { Dashboard } from "./dashboard";
import type { PolicyEngine } from "./policy";
import type { AgentLoader } from "./agent-loader";
import type { MessengerAdapter } from "./messenger-adapter";
import type { SummaryDAG } from "./summary-dag";
import type { LoopDetector } from "./loop-detection";
import type { A2AServer } from "./a2a-server";
import type { PlaybookRunner } from "./playbook";
import type { WorktreePool } from "./worktree-pool";
import type { ContextCompressor } from "./context-compressor";

/**
 * BridgeContext — typed bag of all initialized subsystems.
 * Replaces positional constructor args for TelegramAdapter and Dashboard.
 * All optional subsystems are nullable (feature-flag gated).
 */
export interface BridgeContext {
  config: Config;
  claude: ClaudeInvoker;
  sessions: SessionManager;
  projects: ProjectManager;
  modeManager: ModeManager;

  // Feature-flagged subsystems (nullable)
  memoryStore: MemoryStore | null;
  contextBuilder: ContextBuilder | null;
  pipeline: PipelineWatcher | null;
  reversePipeline: ReversePipelineWatcher | null;
  orchestrator: TaskOrchestrator | null;
  branchManager: BranchManager | null;
  rateLimiter: RateLimiter | null;
  resourceGuard: ResourceGuard | null;
  healthMonitor: HealthMonitor | null;
  scheduler: Scheduler | null;
  synthesisLoop: SynthesisLoop | null;
  prdExecutor: PRDExecutor | null;
  agentRegistry: AgentRegistry | null;
  idempotencyStore: IdempotencyStore | null;
  policyEngine: PolicyEngine | null;
  agentLoader: AgentLoader | null;
  dashboard: Dashboard | null;
  messenger: MessengerAdapter | null;

  // Session 1: DAG Memory + Loop Detection
  summaryDag: SummaryDAG | null;
  loopDetector: LoopDetector | null;

  // Session 2: A2A Server
  a2aServer: A2AServer | null;

  // Session 3: Playbooks + Worktrees + Compression
  playbook: PlaybookRunner | null;
  worktreePool: WorktreePool | null;
  contextCompressor: ContextCompressor | null;
}

/**
 * Plugin — interface for bridge subsystems (type-only for now).
 * Define the contract; implementations come when earned.
 */
export interface Plugin {
  name: string;
  init(ctx: BridgeContext): Promise<void>;
  start?(): Promise<void>;
  stop?(): void;
}
