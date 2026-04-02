#!/usr/bin/env bun
// standalone/dashboard/main.ts — Entry point for standalone dashboard service
// Loads config, opens read-only DB, creates server, handles graceful shutdown.

import { loadConfig } from "./config";
import { DbReader } from "./db-reader";
import { PipelineReader } from "./pipeline-reader";
import { ClaudeRunner } from "./claude-runner";
import { A2AHandler } from "./a2a-handler";
import { DashboardServer } from "./server";

// --- Load config ---
const config = loadConfig();

// --- Initialize readers ---
let db: DbReader;
try {
  db = new DbReader(config.memoryDbPath);
  console.log(`[dashboard] Opened memory.db: ${config.memoryDbPath}`);
} catch (err) {
  console.error(`[dashboard] Failed to open memory.db at ${config.memoryDbPath}: ${err}`);
  process.exit(1);
}

const pipeline = new PipelineReader(config.pipelineDir);
const runner = new ClaudeRunner(config.claudeBinary);

// --- Optional A2A handler ---
const a2a = config.a2aEnabled
  ? new A2AHandler(config, runner, config.dashboardToken)
  : null;

// --- Start server ---
const server = new DashboardServer(config, db, pipeline, runner, a2a);
server.start();

// --- Graceful shutdown ---
function shutdown(signal: string): void {
  console.log(`[dashboard] Received ${signal}, shutting down...`);
  server.stop();
  db.close();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
