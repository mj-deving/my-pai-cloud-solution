# Phase 2: Pipeline Dashboard — Implementation Plan

## Context

Phase 1 (pipeline hardening) is complete and deployed: Zod validation, decision traces, idempotency, agent registry, MessengerAdapter. All feature flags validated live on VPS. Phase 2 adds a web dashboard for real-time monitoring and historical search of the pipeline — replacing the text-based `/pipeline` Telegram command with a proper web UI.

The VPS runs nginx on port 80, OpenClaw Java on 8080/8081. Port 3456 is free. Dashboard will bind to localhost only, accessed via SSH tunnel or nginx reverse proxy.

## Approach

**Single-file vanilla frontend** served by `Bun.serve`. No React, no build step, no framework deps. Dark-themed Kanban board with health panels, agent status, workflow progress, historical search, and decision trace viewer. Real-time updates via SSE (Server-Sent Events) with internal 2-second polling against existing in-memory getters.

## File Manifest

### New Files (3)

| File | Purpose | ~Lines |
|------|---------|--------|
| `src/dashboard.ts` | Dashboard class: Bun.serve, REST API routes, SSE handler, auth middleware, filesystem scanning | ~500 |
| `src/dashboard-html.ts` | Exported `getDashboardHtml()` returning self-contained HTML/CSS/JS string | ~700 |
| `config/nginx-dashboard.conf` | nginx reverse proxy snippet (SSE-aware, no buffering) | ~25 |

### Modified Files (4)

| File | Change | ~Lines |
|------|--------|--------|
| `src/config.ts` | Add `DASHBOARD_ENABLED`, `DASHBOARD_PORT`, `DASHBOARD_BIND`, `DASHBOARD_TOKEN`, `DASHBOARD_SSE_POLL_MS` to EnvSchema + Config + loadConfig | +25 |
| `src/idempotency.ts` | Add `stats()` method + in-memory `duplicateHitCount` counter | +20 |
| `src/pipeline.ts` | Expand `getStatus()` to return `inFlight: string[]` instead of `inFlight: number` | +1 |
| `src/bridge.ts` | Import Dashboard, construct after pipeline block (~line 284), add `dashboard?.stop()` to shutdown | +20 |

**Total: 3 new files, 4 modified files, ~1,300 lines added.**

## Architecture

### Dashboard Class (`src/dashboard.ts`)

```
Dashboard
├── constructor(config, pipeline?, orchestrator?, reversePipeline?,
│              rateLimiter?, resourceGuard?, agentRegistry?, idempotencyStore?)
├── start()           → Bun.serve + start SSE poll timer
├── stop()            → close server + clear timer + close SSE clients
├── checkAuth(req)    → bearer token check (optional)
└── routes:
    GET /              → serve HTML
    GET /api/status    → aggregate system health
    GET /api/pipeline  → Kanban columns (pending/inProgress/completed/error)
    GET /api/agents    → agent registry records with stale detection
    GET /api/workflows → all workflows, optional ?status= filter
    GET /api/health    → rate limiter + resource guard + idempotency stats
    GET /api/history   → search results/ + ack/ with ?q=&status=&limit=&offset=
    GET /api/task      → single task detail with decision traces (?filename=)
    GET /events        → SSE stream (status, pipeline, agents, workflows, health events)
```

All data source dependencies are nullable — dashboard handles missing components gracefully (returns `null` in JSON).

### SSE Real-Time Updates

Internal 2-second poll compares snapshots of all getters. When any value changes, push SSE events to all connected clients. Uses `TransformStream` + `req.signal.addEventListener("abort")` for clean disconnect handling. `retry: 3000` header for auto-reconnect.

Events: `connected`, `status`, `pipeline`, `agents`, `workflows`, `health`.

### Frontend Layout (`src/dashboard-html.ts`)

```
<header> — "Isidore Cloud Dashboard" + connection status + uptime
<health-strip> — 4 compact cards: pipeline slots, rate limiter, memory, dedup stats
<kanban> — 4 columns: Pending | In Progress | Completed | Error
<row-split> — Left: Agent cards | Right: Active workflows with step progress
<history> — Search bar + status filter + paginated results
<modal> — Task detail overlay with decision trace timeline
```

CSS: Dark theme (GitHub-dark palette), CSS Grid layout, responsive (stacks on mobile). Kanban columns with colored top borders (blue/yellow/green/red).

JS: Vanilla — EventSource for SSE, fetch for API, render functions per section, debounced search, modal for task detail.

### Auth & Access Strategy

**Phase 2A (now):** SSH tunnel only — `ssh -L 3456:localhost:3456 isidore_cloud`, browse `http://localhost:3456`. Zero external exposure, zero auth needed.

**Phase 2B (later):** nginx reverse proxy config included in `config/nginx-dashboard.conf` for when external access is wanted. Will require `DASHBOARD_TOKEN` to be set.

Auth layers:
1. **Network**: `hostname: "127.0.0.1"` — not reachable from internet directly
2. **Token** (optional): `DASHBOARD_TOKEN` env var → `Authorization: Bearer <token>` on every request. SSE uses `?token=` query param fallback. When no token set, localhost binding alone provides security.
3. **nginx** (future): Reverse proxy config ready in repo for when needed.

### Config Additions

```
DASHBOARD_ENABLED=0          # Feature flag (default: disabled)
DASHBOARD_PORT=3456          # HTTP port (default: 3456)
DASHBOARD_BIND=127.0.0.1    # Bind address (default: localhost only)
DASHBOARD_TOKEN=             # Optional bearer token
DASHBOARD_SSE_POLL_MS=2000   # SSE snapshot poll interval
```

### bridge.ts Wiring

Placed after pipeline construction (line ~284), before graceful shutdown:

```typescript
// Phase 2: Dashboard web server
let dashboard: Dashboard | null = null;
if (config.dashboardEnabled) {
  dashboard = new Dashboard(config, pipeline, orchestrator, reversePipeline,
    rateLimiter, resourceGuard, agentRegistry, idempotencyStore);
  dashboard.start();
  console.log(`[bridge] Dashboard enabled on ${config.dashboardBind}:${config.dashboardPort}`);
} else {
  console.log("[bridge] Dashboard disabled (DASHBOARD_ENABLED=0)");
}
```

Shutdown: `dashboard?.stop()` before `messenger.stop()`.

### History Search (`/api/history`)

Scans `results/` and `ack/` directories. 10-second directory listing cache. Parses JSON files, filters by query params, sorts by timestamp descending, paginates. Max 200 results per request.

### IdempotencyStore Enhancement

Add `stats()` method:
```typescript
stats(): { totalOps: number; recentOps: number; duplicatesBlocked: number }
```
- `totalOps`: COUNT(*) from processed_ops
- `recentOps`: COUNT where processed_at > 24h ago
- `duplicatesBlocked`: in-memory counter incremented when `isDuplicate()` returns true

### PipelineWatcher Enhancement

Expand `getStatus()`:
```typescript
// Before: { active: number; max: number; inFlight: number }
// After:  { active: number; max: number; inFlight: string[] }
```
Count is `inFlight.length`. No existing callers affected (nobody calls `getStatus()` externally yet).

## Implementation Order

```
Step 1: config.ts (env vars)     ─┐
Step 2: idempotency.ts (stats)   ─┤── all independent
Step 3: pipeline.ts (getStatus)  ─┤
Step 4: dashboard-html.ts (HTML) ─┘
                                   ↓
Step 5: dashboard.ts (server)    ← depends on 1-4
                                   ↓
Step 6: bridge.ts (wiring)       ← depends on 5
Step 7: nginx config (for repo)  ← independent, not deployed yet
                                   ↓
Step 8: Deploy + test on VPS     ← depends on all
```

Steps 1-4 are parallelizable. Step 5 is the core. Step 8 validates everything.

## Verification

1. `bunx tsc --noEmit` — type-checks all new + modified files
2. Deploy to VPS, enable `DASHBOARD_ENABLED=1`, restart service
3. SSH tunnel: `ssh -L 3456:127.0.0.1:3456 isidore_cloud`
4. Open `http://localhost:3456` in browser
5. Verify each panel: health strip, Kanban columns, agent cards, workflows, search
6. Submit a test pipeline task → watch Kanban update in real-time via SSE
7. Click a completed task → verify decision traces in modal
8. Search history → verify filtering and pagination
9. Check logs: no errors, dashboard startup message present
10. nginx config committed to repo for future use (not deployed yet)
