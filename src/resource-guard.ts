// resource-guard.ts — Phase 6A: Memory resource guard for pipeline dispatch
// Checks os.freemem() against a configurable threshold before allowing new tasks.

import { freemem } from "node:os";
import type { Config } from "./config";

export class ResourceGuard {
  private thresholdBytes: number;

  constructor(private config: Config) {
    this.thresholdBytes = config.resourceGuardMemoryThresholdMb * 1024 * 1024;
  }

  // Check if there's enough free memory to dispatch a new task
  canDispatch(): boolean {
    return freemem() >= this.thresholdBytes;
  }

  // Dashboard-friendly status
  getStatus(): { freeMb: number; thresholdMb: number; ok: boolean } {
    const freeMb = Math.round(freemem() / 1024 / 1024);
    return {
      freeMb,
      thresholdMb: this.config.resourceGuardMemoryThresholdMb,
      ok: this.canDispatch(),
    };
  }
}
