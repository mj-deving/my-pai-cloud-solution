// standalone/dashboard/config.ts — Zod-validated configuration for standalone dashboard
import { z } from "zod";

const ConfigSchema = z.object({
  dashboardPort: z.coerce.number().int().min(1).max(65535).default(3456),
  dashboardBind: z.string().default("127.0.0.1"),
  dashboardToken: z.string().min(1, "DASHBOARD_TOKEN is required"),
  dashboardSsePollMs: z.coerce.number().int().min(500).default(2000),
  pipelineDir: z.string().default("/var/lib/pai-pipeline"),
  memoryDbPath: z.string().default(""),
  claudeBinary: z.string().default("claude"),
  a2aEnabled: z.coerce.boolean().default(false),
  a2aPublicUrl: z.string().optional(),
});

export type DashboardConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(): DashboardConfig {
  const home = process.env.HOME ?? "/home/isidore_cloud";
  const raw = {
    dashboardPort: process.env.DASHBOARD_PORT,
    dashboardBind: process.env.DASHBOARD_BIND,
    dashboardToken: process.env.DASHBOARD_TOKEN,
    dashboardSsePollMs: process.env.DASHBOARD_SSE_POLL_MS,
    pipelineDir: process.env.PIPELINE_DIR,
    memoryDbPath: process.env.MEMORY_DB_PATH || `${home}/projects/my-pai-cloud-solution/data/memory.db`,
    claudeBinary: process.env.CLAUDE_BINARY,
    a2aEnabled: process.env.A2A_ENABLED,
    a2aPublicUrl: process.env.A2A_PUBLIC_URL,
  };

  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    console.error("[dashboard] Config validation failed:");
    for (const issue of result.error.issues) {
      console.error(`  ${issue.path.join(".")}: ${issue.message}`);
    }
    process.exit(1);
  }
  return result.data;
}
