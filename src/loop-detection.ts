// loop-detection.ts — Safety middleware preventing infinite tool-call loops
// Hashes tool calls per session, escalates through warn → instruct → hard stop.
// Part of PAI Cloud Evolution Session 1 (from DeerFlow pattern).

export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

export interface LoopDetection {
  phase: 1 | 2 | 3;
  action: "warn" | "instruct" | "hard_stop";
  hash: string;
  count: number;
  message: string;
}

export interface LoopDetectorConfig {
  warnThreshold?: number;
  instructThreshold?: number;
  hardStopThreshold?: number;
  maxSessions?: number;
}

/** Produce a deterministic key for a tool call: tool name + deep-sorted args. */
export function hashToolCall(tool: string, args: Record<string, unknown>): string {
  return `${tool}:${stableStringify(args)}`;
}

/** Deep-sort object keys for deterministic JSON serialization. */
function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const pairs = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
  return `{${pairs.join(",")}}`;
}

export class LoopDetector {
  // Map preserves insertion order — delete + re-set gives O(1) LRU
  private sessions = new Map<string, Map<string, number>>();
  private warnAt: number;
  private instructAt: number;
  private hardStopAt: number;
  private maxSessions: number;

  constructor(config: LoopDetectorConfig = {}) {
    this.warnAt = config.warnThreshold ?? 3;
    this.instructAt = config.instructThreshold ?? 4;
    this.hardStopAt = config.hardStopThreshold ?? 5;
    this.maxSessions = config.maxSessions ?? 100;
  }

  /** Record a tool call. Returns detection result if threshold crossed, null otherwise. */
  record(sessionId: string, call: ToolCall): LoopDetection | null {
    this.ensureSession(sessionId);

    const hash = hashToolCall(call.tool, call.args);
    const counts = this.sessions.get(sessionId)!;
    const newCount = (counts.get(hash) ?? 0) + 1;
    counts.set(hash, newCount);

    if (newCount >= this.hardStopAt) {
      return {
        phase: 3,
        action: "hard_stop",
        hash,
        count: newCount,
        message: `HARD STOP: Tool '${call.tool}' called ${newCount} times with identical args. Killing process.`,
      };
    }

    if (newCount >= this.instructAt) {
      return {
        phase: 2,
        action: "instruct",
        hash,
        count: newCount,
        message: `WARNING: Tool '${call.tool}' called ${newCount} times with identical args. Stop calling this tool — you are in a loop.`,
      };
    }

    if (newCount >= this.warnAt) {
      return {
        phase: 1,
        action: "warn",
        hash,
        count: newCount,
        message: `Notice: Tool '${call.tool}' called ${newCount} times with identical args. Consider varying your approach.`,
      };
    }

    return null;
  }

  /** Clear tracking for a session. */
  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  private ensureSession(sessionId: string): void {
    if (this.sessions.has(sessionId)) {
      // Move to end for LRU: delete + re-set preserves Map insertion order
      const counts = this.sessions.get(sessionId)!;
      this.sessions.delete(sessionId);
      this.sessions.set(sessionId, counts);
    } else {
      // Evict oldest if at capacity
      if (this.sessions.size >= this.maxSessions) {
        const oldest = this.sessions.keys().next().value;
        if (oldest) this.sessions.delete(oldest);
      }
      this.sessions.set(sessionId, new Map());
    }
  }
}
