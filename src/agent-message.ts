// agent-message.ts — AgentMessage envelope for inter-agent communication
// Wraps PipelineTask/PipelineResult at transport layer. Disk format unchanged for Gregor compat.

import type { AgentMessage, PipelineTask, PipelineResult } from "./schemas";

/**
 * Wrap a PipelineTask into an AgentMessage envelope.
 */
export function pipelineTaskToMessage(task: PipelineTask): AgentMessage {
  return {
    id: crypto.randomUUID(),
    from: task.from,
    to: task.to,
    type: "task",
    priority: (task.priority as "high" | "normal" | "low") || "normal",
    timestamp: new Date().toISOString(),
    correlationId: task.id,
    payload: {
      kind: "task",
      task,
    },
  };
}

/**
 * Wrap a PipelineResult into an AgentMessage envelope.
 */
export function resultToMessage(result: PipelineResult): AgentMessage {
  return {
    id: crypto.randomUUID(),
    from: result.from,
    to: result.to,
    type: "result",
    timestamp: new Date().toISOString(),
    correlationId: result.taskId,
    payload: {
      kind: "result",
      result,
    },
  };
}

/**
 * Create a heartbeat AgentMessage for the agent registry.
 */
export function heartbeatMessage(
  agentId: string,
  name: string,
  status: string,
  uptime: number,
): AgentMessage {
  return {
    id: crypto.randomUUID(),
    from: agentId,
    to: "registry",
    type: "heartbeat",
    timestamp: new Date().toISOString(),
    payload: {
      kind: "heartbeat",
      agentId,
      name,
      status,
      uptime,
    },
  };
}
