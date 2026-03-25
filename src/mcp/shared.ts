// mcp/shared.ts — Shared utilities for MCP servers
// DB path resolution and configuration construction.
// Part of PAI Cloud Evolution Session 1.

import type { Config } from "../config";

/** Resolve memory DB path from config or environment. */
export function resolveDbPath(config?: Partial<Config>): string {
  if (config?.memoryDbPath) return config.memoryDbPath;

  const envPath = process.env.MEMORY_DB_PATH;
  if (envPath) return envPath;

  const home = process.env.HOME || "/home/isidore_cloud";
  return `${home}/projects/my-pai-cloud-solution/data/memory.db`;
}

/** Build minimal config for MCP server usage. */
export function buildMcpConfig(overrides: Partial<Config> = {}): Config {
  return {
    memoryMaxEpisodes: parseInt(process.env.MEMORY_MAX_EPISODES || "10000", 10),
    memoryDecayLambda: parseFloat(process.env.MEMORY_DECAY_LAMBDA || "0.023"),
    contextMaxTokens: parseInt(process.env.CONTEXT_MAX_TOKENS || "2000", 10),
    contextMaxChars: parseInt(process.env.CONTEXT_MAX_CHARS || "5000", 10),
    ...overrides,
  } as Config;
}
