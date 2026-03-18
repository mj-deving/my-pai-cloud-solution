// health-monitor.ts — Periodic health checks for bridge subsystems (Graduated Extraction Phase 2)

export interface HealthCheck {
  name: string;
  status: "ok" | "degraded" | "down";
  message?: string;
}

export interface HealthSnapshot {
  overall: "ok" | "degraded" | "down";
  uptime: number;
  timestamp: string;
  checks: HealthCheck[];
  telegram: { success: number; failure: number; rate: number };
}

const SEVERITY: Record<HealthCheck["status"], number> = {
  ok: 0,
  degraded: 1,
  down: 2,
};

const STATUS_BY_SEVERITY: HealthCheck["status"][] = ["ok", "degraded", "down"];
const TELEGRAM_DEGRADED_THRESHOLD = 0.8;

const TELEGRAM_WINDOW_SIZE = 100;

export class HealthMonitor {
  private checks: Map<string, () => HealthCheck> = new Map();
  private telegramWindow: boolean[] = []; // sliding window: true = success, false = failure
  private startedAt = Date.now();
  private timer: ReturnType<typeof setInterval> | null = null;
  private cachedSnapshot: HealthSnapshot | null = null;

  constructor(private config: { healthMonitorPollMs: number }) {}

  registerCheck(name: string, fn: () => HealthCheck): void {
    this.checks.set(name, fn);
    // Invalidate cache when checks change
    this.cachedSnapshot = null;
  }

  getSnapshot(): HealthSnapshot {
    if (this.cachedSnapshot) return this.cachedSnapshot;
    return this.runChecks();
  }

  recordTelegramSuccess(): void {
    this.telegramWindow.push(true);
    if (this.telegramWindow.length > TELEGRAM_WINDOW_SIZE) this.telegramWindow.shift();
    this.cachedSnapshot = null;
  }

  recordTelegramFailure(): void {
    this.telegramWindow.push(false);
    if (this.telegramWindow.length > TELEGRAM_WINDOW_SIZE) this.telegramWindow.shift();
    this.cachedSnapshot = null;
  }

  start(): void {
    this.cachedSnapshot = this.runChecks();
    this.timer = setInterval(() => {
      this.cachedSnapshot = this.runChecks();
    }, this.config.healthMonitorPollMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private runChecks(): HealthSnapshot {
    const results: HealthCheck[] = [];
    let maxSeverity = 0;

    for (const [name, fn] of this.checks) {
      try {
        const result = fn();
        results.push(result);
        maxSeverity = Math.max(maxSeverity, SEVERITY[result.status]);
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : String(err);
        results.push({ name, status: "down", message });
        maxSeverity = Math.max(maxSeverity, SEVERITY.down);
      }
    }

    // Telegram health: sliding window rate < 0.8 adds a degraded signal
    const total = this.telegramWindow.length;
    const success = this.telegramWindow.filter(Boolean).length;
    const failure = total - success;
    const rate = total > 0 ? success / total : 1.0;
    if (total > 0 && rate < TELEGRAM_DEGRADED_THRESHOLD) {
      maxSeverity = Math.max(maxSeverity, SEVERITY.degraded);
    }

    return {
      overall: STATUS_BY_SEVERITY[maxSeverity] ?? "ok",
      uptime: Date.now() - this.startedAt,
      timestamp: new Date().toISOString(),
      checks: results,
      telegram: {
        success,
        failure,
        rate,
      },
    };
  }
}
