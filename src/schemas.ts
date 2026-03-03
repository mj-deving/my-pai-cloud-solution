// schemas.ts — Zod schemas for all external data types (Phase 1: Pipeline Hardening)
// Replaces unsafe `JSON.parse(x) as Type` with validated parsing at every cross-agent boundary.

import { z } from "zod";

// --- Decision Trace ---

export const DecisionTraceSchema = z.object({
  timestamp: z.string(),
  phase: z.string(),
  decision: z.string(),
  reason_code: z.string(),
  context: z.record(z.string(), z.unknown()).optional(),
});

export type DecisionTrace = z.infer<typeof DecisionTraceSchema>;

// --- Pipeline Task (inbound from Gregor) ---

export const EscalationSchema = z.object({
  reason: z.string(),
  criteria: z.array(z.string()),
  gregor_partial_result: z.string().optional(),
});

export const PipelineTaskSchema = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  timestamp: z.string(),
  type: z.string(),
  priority: z.string().optional(),
  mode: z.string().optional(),
  project: z.string().optional(),
  prompt: z.string(),
  context: z.record(z.string(), z.unknown()).optional(),
  constraints: z.record(z.string(), z.unknown()).optional(),
  session_id: z.string().optional(),
  timeout_minutes: z.number().optional(),
  max_turns: z.number().optional(),
  escalation: EscalationSchema.optional(),
  // Phase 1: Idempotency fields
  op_id: z.string().optional(),
  auto_op_id: z.boolean().optional(),
}).strict();

export type PipelineTask = z.infer<typeof PipelineTaskSchema>;

// --- Structured Result ---

export const StructuredResultSchema = z.object({
  summary: z.string(),
  artifacts: z.array(z.object({
    path: z.string(),
    type: z.string(),
    description: z.string(),
  })).optional(),
  follow_up_needed: z.boolean().optional(),
  suggested_next_prompt: z.string().optional(),
});

export type StructuredResult = z.infer<typeof StructuredResultSchema>;

// --- Pipeline Result (outbound to Gregor) ---

export const PipelineResultSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  from: z.string(),
  to: z.string(),
  timestamp: z.string(),
  status: z.enum(["completed", "error"]),
  result: z.string().optional(),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
  }).optional(),
  error: z.string().optional(),
  warnings: z.array(z.string()).optional(),
  session_id: z.string().optional(),
  structured: StructuredResultSchema.optional(),
  escalation_handled: z.boolean().optional(),
  recommendations_for_sender: z.string().optional(),
  branch: z.string().optional(),
  // Phase 1: Decision traces
  decision_traces: z.array(DecisionTraceSchema).optional(),
}).strict();

export type PipelineResult = z.infer<typeof PipelineResultSchema>;

// --- Workflow ---

export const WorkflowStepSchema = z.object({
  id: z.string(),
  description: z.string(),
  prompt: z.string(),
  assignee: z.enum(["isidore", "gregor"]),
  status: z.enum(["pending", "blocked", "in_progress", "completed", "failed"]),
  dependsOn: z.array(z.string()),
  project: z.string().optional(),
  result: z.string().optional(),
  error: z.string().optional(),
  taskId: z.string().optional(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  retryCount: z.number(),
});

export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;

export const WorkflowSchema = z.object({
  id: z.string(),
  originTaskId: z.string(),
  originFrom: z.string(),
  description: z.string(),
  status: z.enum(["active", "completed", "failed", "cancelled"]),
  steps: z.array(WorkflowStepSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().optional(),
  delegationDepth: z.number(),
});

export type Workflow = z.infer<typeof WorkflowSchema>;

// --- Claude JSON Output (passthrough — Claude may add fields) ---

export const ClaudeJsonOutputSchema = z.object({
  session_id: z.string().optional(),
  result: z.string().optional(),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
  }).optional(),
}).passthrough();

export type ClaudeJsonOutput = z.infer<typeof ClaudeJsonOutputSchema>;

// --- Branch Lock ---

export const BranchLockSchema = z.object({
  projectDir: z.string(),
  branch: z.string(),
  taskId: z.string(),
  acquiredAt: z.string(),
  source: z.enum(["pipeline", "orchestrator"]),
});

export type BranchLock = z.infer<typeof BranchLockSchema>;

export const BranchLockMapSchema = z.record(z.string(), BranchLockSchema);

export type BranchLockMap = z.infer<typeof BranchLockMapSchema>;

// --- AgentMessage Envelope ---

export const TaskPayloadSchema = z.object({
  kind: z.literal("task"),
  task: PipelineTaskSchema,
});

export const ResultPayloadSchema = z.object({
  kind: z.literal("result"),
  result: PipelineResultSchema,
});

export const HeartbeatPayloadSchema = z.object({
  kind: z.literal("heartbeat"),
  agentId: z.string(),
  name: z.string(),
  status: z.string(),
  uptime: z.number(),
});

export const EventPayloadSchema = z.object({
  kind: z.literal("event"),
  eventType: z.string(),
  data: z.record(z.string(), z.unknown()).optional(),
});

export const AgentMessagePayloadSchema = z.discriminatedUnion("kind", [
  TaskPayloadSchema,
  ResultPayloadSchema,
  HeartbeatPayloadSchema,
  EventPayloadSchema,
]);

export const AgentMessageSchema = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  type: z.string(),
  priority: z.enum(["high", "normal", "low"]).optional(),
  timestamp: z.string(),
  ttl: z.number().optional(),
  correlationId: z.string().optional(),
  payload: AgentMessagePayloadSchema,
});

export type AgentMessage = z.infer<typeof AgentMessageSchema>;

// --- V2-A: Memory (Episode + Knowledge) ---

export const EpisodeSchema = z.object({
  id: z.number().int().optional(), // auto-increment
  timestamp: z.string(),
  source: z.enum(["telegram", "pipeline", "orchestrator", "handoff", "prd", "synthesis", "session_summary"]),
  project: z.string().nullable().optional(),
  session_id: z.string().nullable().optional(),
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
  summary: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  importance: z.number().int().min(1).max(10).optional(),
  access_count: z.number().int().optional(),
  last_accessed: z.string().nullable().optional(),
});

export type Episode = z.infer<typeof EpisodeSchema>;

export const KnowledgeSchema = z.object({
  id: z.number().int().optional(),
  domain: z.string(),
  key: z.string(),
  content: z.string(),
  confidence: z.number().min(0).max(1),
  source_episode_ids: z.array(z.number()).optional(),
  expires_at: z.string().nullable().optional(),
});

export type Knowledge = z.infer<typeof KnowledgeSchema>;

export const MemoryQuerySchema = z.object({
  query: z.string(),
  project: z.string().optional(),
  source: z.enum(["telegram", "pipeline", "orchestrator", "handoff", "prd", "synthesis", "session_summary"]).optional(),
  maxResults: z.number().int().min(1).max(100).optional(),
  maxTokens: z.number().int().min(100).max(16000).optional(),
  recencyBias: z.number().min(0).max(1).optional(),
});

export type MemoryQuery = z.infer<typeof MemoryQuerySchema>;

export const MemoryResultSchema = z.object({
  episodes: z.array(EpisodeSchema),
  knowledge: z.array(KnowledgeSchema),
  totalTokens: z.number(),
});

export type MemoryResult = z.infer<typeof MemoryResultSchema>;

// --- V2-D: PRD Executor ---

export const ParsedPRDStepSchema = z.object({
  description: z.string(),
  assignee: z.enum(["isidore", "gregor", "ask"]),
  dependsOn: z.array(z.string()),
});

export const ParsedPRDSchema = z.object({
  title: z.string(),
  description: z.string(),
  project: z.string().nullable(),
  requirements: z.array(z.string()),
  constraints: z.array(z.string()),
  estimatedComplexity: z.enum(["simple", "medium", "complex"]),
  suggestedSteps: z.array(ParsedPRDStepSchema),
});

export type ParsedPRD = z.infer<typeof ParsedPRDSchema>;

export const PRDProgressSchema = z.object({
  prdId: z.string(),
  title: z.string(),
  status: z.enum(["parsing", "setup", "executing", "verifying", "completed", "failed", "aborted"]),
  currentStep: z.number().int(),
  totalSteps: z.number().int(),
  project: z.string().nullable(),
  startedAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
});

export type PRDProgress = z.infer<typeof PRDProgressSchema>;

// --- Safe Parse Helpers ---

export interface SafeParseSuccess<T> {
  success: true;
  data: T;
}

export interface SafeParseFailure {
  success: false;
  error: string;
}

export type SafeParseResult<T> = SafeParseSuccess<T> | SafeParseFailure;

/**
 * Parse raw JSON string or object against a Zod schema. Returns typed result.
 * Used at cross-agent boundaries where invalid data should be handled gracefully.
 */
export function safeParse<T>(
  schema: z.ZodType<T>,
  raw: string | unknown,
  label: string,
): SafeParseResult<T> {
  try {
    const data = typeof raw === "string" ? JSON.parse(raw) : raw;
    const result = schema.safeParse(data);
    if (result.success) {
      return { success: true, data: result.data };
    }
    const msg = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    console.warn(`[schemas] ${label}: validation failed — ${msg}`);
    return { success: false, error: msg };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[schemas] ${label}: parse error — ${msg}`);
    return { success: false, error: msg };
  }
}

/**
 * Parse and throw on failure. Used for internal/trusted data where failure is a bug.
 */
export function strictParse<T>(
  schema: z.ZodType<T>,
  raw: string | unknown,
  label: string,
): T {
  const result = safeParse(schema, raw, label);
  if (!result.success) {
    throw new Error(`[schemas] ${label}: strict parse failed — ${result.error}`);
  }
  return result.data;
}
