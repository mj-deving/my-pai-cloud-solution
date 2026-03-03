// dashboard-html.ts — Self-contained HTML/CSS/JS for the Isidore Cloud Dashboard
// Returns a complete HTML page string served by dashboard.ts at GET /
// Dark-themed Kanban board with health panels, agent status, workflow progress,
// historical search, and decision trace viewer. Real-time updates via SSE.

export function getDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Isidore Cloud Dashboard</title>
<style>
  :root {
    --bg: #0d1117;
    --surface: #161b22;
    --border: #30363d;
    --text: #c9d1d9;
    --text-muted: #8b949e;
    --accent: #58a6ff;
    --green: #3fb950;
    --yellow: #d29922;
    --red: #f85149;
    --orange: #db6d28;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.5;
    font-size: 14px;
  }
  a { color: var(--accent); text-decoration: none; }
  header {
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    padding: 12px 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  header h1 { font-size: 18px; font-weight: 600; }
  header h1 span { color: var(--accent); }
  .conn-status {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--text-muted);
  }
  .conn-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--red);
  }
  .conn-dot.connected { background: var(--green); }
  .main { padding: 16px 24px; max-width: 1400px; margin: 0 auto; }

  /* Health strip */
  .health-strip {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 12px;
    margin-bottom: 20px;
  }
  .health-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 12px 16px;
  }
  .health-card .label { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; }
  .health-card .value { font-size: 22px; font-weight: 600; margin-top: 4px; }
  .health-card .sub { font-size: 11px; color: var(--text-muted); margin-top: 2px; }
  .ok { color: var(--green); }
  .warn { color: var(--yellow); }
  .err { color: var(--red); }

  /* Kanban */
  .kanban {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 12px;
    margin-bottom: 20px;
  }
  .kanban-col {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    min-height: 120px;
  }
  .kanban-col-header {
    padding: 10px 14px;
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    border-bottom: 1px solid var(--border);
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .kanban-col-header .count {
    background: var(--border);
    color: var(--text-muted);
    padding: 1px 8px;
    border-radius: 10px;
    font-size: 11px;
  }
  .col-pending .kanban-col-header { border-top: 3px solid var(--accent); border-radius: 8px 8px 0 0; }
  .col-active .kanban-col-header { border-top: 3px solid var(--yellow); border-radius: 8px 8px 0 0; }
  .col-completed .kanban-col-header { border-top: 3px solid var(--green); border-radius: 8px 8px 0 0; }
  .col-error .kanban-col-header { border-top: 3px solid var(--red); border-radius: 8px 8px 0 0; }
  .kanban-items { padding: 8px; }
  .kanban-item {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 8px 10px;
    margin-bottom: 6px;
    font-size: 12px;
    cursor: pointer;
    transition: border-color 0.15s;
  }
  .kanban-item:hover { border-color: var(--accent); }
  .kanban-item .task-id { color: var(--accent); font-family: monospace; font-size: 11px; }
  .kanban-item .task-prompt { color: var(--text); margin-top: 2px; }
  .kanban-item .task-meta { color: var(--text-muted); font-size: 11px; margin-top: 4px; }
  .empty-col { padding: 16px; text-align: center; color: var(--text-muted); font-size: 12px; }

  /* Split row: agents + workflows */
  .split-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    margin-bottom: 20px;
  }
  .section {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  .section-header {
    padding: 10px 14px;
    font-size: 13px;
    font-weight: 600;
    border-bottom: 1px solid var(--border);
  }
  .section-body { padding: 10px 14px; }
  .agent-card {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 0;
    border-bottom: 1px solid var(--border);
  }
  .agent-card:last-child { border-bottom: none; }
  .agent-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
  }
  .agent-dot.online { background: var(--green); }
  .agent-dot.offline { background: var(--text-muted); }
  .agent-dot.stale { background: var(--yellow); }
  .agent-info { flex: 1; }
  .agent-name { font-weight: 600; font-size: 13px; }
  .agent-meta { font-size: 11px; color: var(--text-muted); }
  .workflow-item {
    padding: 8px 0;
    border-bottom: 1px solid var(--border);
  }
  .workflow-item:last-child { border-bottom: none; }
  .wf-header { display: flex; justify-content: space-between; align-items: center; }
  .wf-id { font-family: monospace; font-size: 12px; color: var(--accent); }
  .wf-status { font-size: 11px; padding: 2px 8px; border-radius: 4px; }
  .wf-status.active { background: rgba(210,153,34,0.15); color: var(--yellow); }
  .wf-status.completed { background: rgba(63,185,80,0.15); color: var(--green); }
  .wf-status.failed { background: rgba(248,81,73,0.15); color: var(--red); }
  .wf-desc { font-size: 12px; margin-top: 4px; }
  .wf-progress {
    height: 4px;
    background: var(--border);
    border-radius: 2px;
    margin-top: 6px;
    overflow: hidden;
  }
  .wf-progress-bar {
    height: 100%;
    background: var(--green);
    border-radius: 2px;
    transition: width 0.3s;
  }
  .wf-steps { font-size: 11px; color: var(--text-muted); margin-top: 4px; }

  /* History */
  .history-controls {
    display: flex;
    gap: 10px;
    margin-bottom: 12px;
    align-items: center;
  }
  .history-controls input,
  .history-controls select {
    background: var(--bg);
    border: 1px solid var(--border);
    color: var(--text);
    padding: 6px 10px;
    border-radius: 6px;
    font-size: 13px;
  }
  .history-controls input { flex: 1; }
  .history-controls select { min-width: 120px; }
  .history-table {
    width: 100%;
    border-collapse: collapse;
  }
  .history-table th {
    text-align: left;
    font-size: 11px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    padding: 6px 10px;
    border-bottom: 1px solid var(--border);
  }
  .history-table td {
    padding: 8px 10px;
    font-size: 12px;
    border-bottom: 1px solid var(--border);
  }
  .history-table tr { cursor: pointer; transition: background 0.1s; }
  .history-table tr:hover { background: rgba(88,166,255,0.05); }
  .status-badge {
    display: inline-block;
    padding: 1px 8px;
    border-radius: 4px;
    font-size: 11px;
  }
  .status-badge.completed { background: rgba(63,185,80,0.15); color: var(--green); }
  .status-badge.error { background: rgba(248,81,73,0.15); color: var(--red); }
  .pagination {
    display: flex;
    justify-content: center;
    gap: 8px;
    margin-top: 12px;
  }
  .pagination button {
    background: var(--surface);
    border: 1px solid var(--border);
    color: var(--text);
    padding: 4px 12px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
  }
  .pagination button:disabled { opacity: 0.4; cursor: default; }
  .pagination button:hover:not(:disabled) { border-color: var(--accent); }

  /* Modal */
  .modal-overlay {
    display: none;
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.7);
    z-index: 100;
    justify-content: center;
    align-items: center;
  }
  .modal-overlay.active { display: flex; }
  .modal {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    max-width: 700px;
    width: 90%;
    max-height: 80vh;
    overflow-y: auto;
    padding: 24px;
  }
  .modal-close {
    float: right;
    background: none;
    border: none;
    color: var(--text-muted);
    font-size: 20px;
    cursor: pointer;
  }
  .modal h2 { font-size: 16px; margin-bottom: 12px; }
  .modal pre {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 12px;
    font-size: 12px;
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .trace-timeline { margin-top: 16px; }
  .trace-item {
    display: flex;
    gap: 12px;
    padding: 8px 0;
    border-bottom: 1px solid var(--border);
    font-size: 12px;
  }
  .trace-item:last-child { border-bottom: none; }
  .trace-time { color: var(--text-muted); font-family: monospace; white-space: nowrap; min-width: 80px; }
  .trace-phase {
    padding: 1px 6px;
    border-radius: 3px;
    font-size: 11px;
    background: rgba(88,166,255,0.15);
    color: var(--accent);
    white-space: nowrap;
  }
  .trace-decision { flex: 1; }
  .trace-reason { color: var(--text-muted); font-style: italic; }
  .no-data { color: var(--text-muted); font-size: 13px; text-align: center; padding: 20px; }
  .stat-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .stat-item { padding: 6px 0; }
  .stat-item .stat-label { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.3px; }
  .stat-item .stat-value { font-size: 16px; font-weight: 600; margin-top: 2px; }
  .stat-item .stat-value.small { font-size: 13px; }
  .stat-badges { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
  .stat-badge { font-size: 11px; padding: 2px 8px; border-radius: 4px; }
  .stat-badge.active { background: rgba(63,185,80,0.15); color: var(--green); }
  .stat-badge.inactive { background: rgba(139,148,158,0.15); color: var(--text-muted); }
  @media (max-width: 900px) {
    .kanban { grid-template-columns: repeat(2, 1fr); }
    .split-row { grid-template-columns: 1fr; }
  }
  @media (max-width: 600px) {
    .kanban { grid-template-columns: 1fr; }
    .main { padding: 12px; }
  }
</style>
</head>
<body>
<header>
  <h1><span>Isidore Cloud</span> Dashboard</h1>
  <div class="conn-status">
    <div class="conn-dot" id="connDot"></div>
    <span id="connText">Connecting...</span>
    <span style="margin-left:12px" id="uptime"></span>
  </div>
</header>
<div class="main">
  <!-- Health strip -->
  <div class="health-strip" id="healthStrip">
    <div class="health-card">
      <div class="label">Pipeline Slots</div>
      <div class="value" id="hSlots">-/-</div>
      <div class="sub" id="hSlotsIn">0 in flight</div>
    </div>
    <div class="health-card">
      <div class="label">Rate Limiter</div>
      <div class="value ok" id="hRate">OK</div>
      <div class="sub" id="hRateSub">0 recent failures</div>
    </div>
    <div class="health-card">
      <div class="label">Memory</div>
      <div class="value ok" id="hMem">-</div>
      <div class="sub" id="hMemSub">threshold: -</div>
    </div>
    <div class="health-card">
      <div class="label">Dedup Stats</div>
      <div class="value" id="hDedup">-</div>
      <div class="sub" id="hDedupSub">0 blocked</div>
    </div>
  </div>

  <!-- Kanban -->
  <div class="kanban" id="kanban">
    <div class="kanban-col col-pending">
      <div class="kanban-col-header">Pending <span class="count" id="cntPending">0</span></div>
      <div class="kanban-items" id="colPending"></div>
    </div>
    <div class="kanban-col col-active">
      <div class="kanban-col-header">In Progress <span class="count" id="cntActive">0</span></div>
      <div class="kanban-items" id="colActive"></div>
    </div>
    <div class="kanban-col col-completed">
      <div class="kanban-col-header">Completed <span class="count" id="cntCompleted">0</span></div>
      <div class="kanban-items" id="colCompleted"></div>
    </div>
    <div class="kanban-col col-error">
      <div class="kanban-col-header">Error <span class="count" id="cntError">0</span></div>
      <div class="kanban-items" id="colError"></div>
    </div>
  </div>

  <!-- Agents + Workflows -->
  <div class="split-row">
    <div class="section">
      <div class="section-header">Agents</div>
      <div class="section-body" id="agentsList">
        <div class="no-data">No agents registered</div>
      </div>
    </div>
    <div class="section">
      <div class="section-header">Active Workflows</div>
      <div class="section-body" id="workflowsList">
        <div class="no-data">No active workflows</div>
      </div>
    </div>
  </div>

  <!-- Memory -->
  <div class="split-row">
    <div class="section">
      <div class="section-header">Memory Store</div>
      <div class="section-body" id="memoryPanel">
        <div class="no-data">Memory disabled</div>
      </div>
    </div>
    <div class="section">
      <div class="section-header">&nbsp;</div>
      <div class="section-body"><div class="no-data">Reserved for future panels</div></div>
    </div>
  </div>

  <!-- Synthesis -->
  <div class="split-row">
    <div class="section">
      <div class="section-header">Synthesis Loop</div>
      <div class="section-body" id="synthesisPanel">
        <div class="no-data">Synthesis disabled</div>
      </div>
    </div>
    <div class="section">
      <div class="section-header">&nbsp;</div>
      <div class="section-body"><div class="no-data">Reserved for future panels</div></div>
    </div>
  </div>

  <!-- History -->
  <div class="section" style="margin-bottom:20px">
    <div class="section-header">History</div>
    <div class="section-body">
      <div class="history-controls">
        <input type="text" id="searchInput" placeholder="Search tasks...">
        <select id="statusFilter">
          <option value="">All</option>
          <option value="completed">Completed</option>
          <option value="error">Error</option>
        </select>
      </div>
      <table class="history-table">
        <thead>
          <tr><th>Task ID</th><th>From</th><th>Status</th><th>Time</th><th>Prompt</th></tr>
        </thead>
        <tbody id="historyBody"></tbody>
      </table>
      <div class="pagination">
        <button id="prevPage" disabled>&laquo; Prev</button>
        <span id="pageInfo" style="font-size:12px;color:var(--text-muted);line-height:28px">Page 1</span>
        <button id="nextPage" disabled>Next &raquo;</button>
      </div>
    </div>
  </div>
</div>

<!-- Task detail modal -->
<div class="modal-overlay" id="modalOverlay">
  <div class="modal">
    <button class="modal-close" id="modalClose">&times;</button>
    <h2 id="modalTitle">Task Detail</h2>
    <div id="modalContent"></div>
  </div>
</div>

<script>
(function() {
  const TOKEN = new URLSearchParams(location.search).get('token') || '';
  const headers = TOKEN ? { 'Authorization': 'Bearer ' + TOKEN } : {};
  let startTime = Date.now();
  let historyPage = 0;
  const LIMIT = 20;
  let searchTimer = null;

  // SSE connection
  function connectSSE() {
    const url = '/events' + (TOKEN ? '?token=' + encodeURIComponent(TOKEN) : '');
    const es = new EventSource(url);

    es.addEventListener('connected', () => {
      document.getElementById('connDot').classList.add('connected');
      document.getElementById('connText').textContent = 'Connected';
    });

    es.addEventListener('status', (e) => {
      const d = JSON.parse(e.data);
      if (d.uptime != null) startTime = Date.now() - d.uptime;
    });

    es.addEventListener('health', (e) => {
      renderHealth(JSON.parse(e.data));
    });

    es.addEventListener('pipeline', (e) => {
      renderKanban(JSON.parse(e.data));
    });

    es.addEventListener('agents', (e) => {
      renderAgents(JSON.parse(e.data));
    });

    es.addEventListener('workflows', (e) => {
      renderWorkflows(JSON.parse(e.data));
    });

    es.addEventListener('memory', (e) => {
      renderMemory(JSON.parse(e.data));
    });

    es.addEventListener('synthesis', (e) => {
      renderSynthesis(JSON.parse(e.data));
    });

    es.onerror = () => {
      document.getElementById('connDot').classList.remove('connected');
      document.getElementById('connText').textContent = 'Reconnecting...';
    };
  }

  // Uptime ticker
  setInterval(() => {
    const s = Math.floor((Date.now() - startTime) / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    document.getElementById('uptime').textContent = h + 'h ' + m + 'm uptime';
  }, 10000);

  // Health strip
  function renderHealth(h) {
    if (!h) return;
    if (h.pipeline) {
      document.getElementById('hSlots').textContent = h.pipeline.active + '/' + h.pipeline.max;
      document.getElementById('hSlotsIn').textContent = (h.pipeline.inFlight || []).length + ' in flight';
    }
    if (h.rateLimiter) {
      const rl = h.rateLimiter;
      const el = document.getElementById('hRate');
      el.textContent = rl.paused ? 'PAUSED' : 'OK';
      el.className = 'value ' + (rl.paused ? 'err' : 'ok');
      document.getElementById('hRateSub').textContent = rl.recentFailures + ' recent failures';
    }
    if (h.resourceGuard) {
      const rg = h.resourceGuard;
      const el = document.getElementById('hMem');
      el.textContent = rg.freeMb + ' MB';
      el.className = 'value ' + (rg.ok ? 'ok' : 'warn');
      document.getElementById('hMemSub').textContent = 'threshold: ' + rg.thresholdMb + ' MB';
    }
    if (h.idempotency) {
      const id = h.idempotency;
      document.getElementById('hDedup').textContent = id.totalOps + ' ops';
      document.getElementById('hDedupSub').textContent = id.duplicatesBlocked + ' blocked, ' + id.recentOps + ' recent';
    }
  }

  // Kanban
  function renderKanban(data) {
    if (!data) return;
    const cols = { pending: [], active: [], completed: [], error: [] };
    if (data.pending) cols.pending = data.pending;
    if (data.inProgress) cols.active = data.inProgress;
    if (data.completed) cols.completed = data.completed.slice(0, 10);
    if (data.error) cols.error = data.error.slice(0, 10);

    renderCol('colPending', 'cntPending', cols.pending);
    renderCol('colActive', 'cntActive', cols.active);
    renderCol('colCompleted', 'cntCompleted', cols.completed);
    renderCol('colError', 'cntError', cols.error);
  }

  function renderCol(colId, cntId, items) {
    document.getElementById(cntId).textContent = items.length;
    const el = document.getElementById(colId);
    if (items.length === 0) {
      el.innerHTML = '<div class="empty-col">None</div>';
      return;
    }
    el.innerHTML = items.map(function(t) {
      return '<div class="kanban-item" onclick="window._showTask(\\'' + esc(t.filename || t.taskId || '') + '\\')">' +
        '<div class="task-id">' + esc(t.taskId || t.id || '?') + '</div>' +
        '<div class="task-prompt">' + esc((t.prompt || t.result || '').slice(0, 80)) + '</div>' +
        '<div class="task-meta">' + esc(t.from || '') + (t.project ? ' / ' + esc(t.project) : '') + '</div>' +
        '</div>';
    }).join('');
  }

  // Agents
  function renderAgents(agents) {
    const el = document.getElementById('agentsList');
    if (!agents || agents.length === 0) {
      el.innerHTML = '<div class="no-data">No agents registered</div>';
      return;
    }
    el.innerHTML = agents.map(function(a) {
      const cls = a.stale ? 'stale' : (a.status === 'online' ? 'online' : 'offline');
      return '<div class="agent-card">' +
        '<div class="agent-dot ' + cls + '"></div>' +
        '<div class="agent-info">' +
        '<div class="agent-name">' + esc(a.id) + ' <span style="font-weight:normal;color:var(--text-muted)">(' + esc(a.persona) + ')</span></div>' +
        '<div class="agent-meta">' + esc(a.capabilities.join(', ')) + '</div>' +
        '</div>' +
        '<div style="font-size:11px;color:var(--text-muted)">' + (a.stale ? 'Stale' : esc(a.status)) + '</div>' +
        '</div>';
    }).join('');
  }

  // Workflows
  function renderWorkflows(workflows) {
    const el = document.getElementById('workflowsList');
    if (!workflows || workflows.length === 0) {
      el.innerHTML = '<div class="no-data">No active workflows</div>';
      return;
    }
    el.innerHTML = workflows.map(function(wf) {
      const total = wf.steps ? wf.steps.length : 0;
      const done = wf.steps ? wf.steps.filter(function(s) { return s.status === 'completed'; }).length : 0;
      const pct = total > 0 ? Math.round(done / total * 100) : 0;
      return '<div class="workflow-item">' +
        '<div class="wf-header"><span class="wf-id">' + esc(wf.id.slice(0, 8)) + '...</span>' +
        '<span class="wf-status ' + esc(wf.status) + '">' + esc(wf.status) + '</span></div>' +
        '<div class="wf-desc">' + esc(wf.description || '') + '</div>' +
        '<div class="wf-progress"><div class="wf-progress-bar" style="width:' + pct + '%"></div></div>' +
        '<div class="wf-steps">' + done + '/' + total + ' steps completed</div>' +
        '</div>';
    }).join('');
  }

  // Memory panel
  function renderMemory(data) {
    const el = document.getElementById('memoryPanel');
    if (!data || !data.enabled) {
      el.innerHTML = '<div class="no-data">Memory disabled</div>';
      return;
    }
    const sizeKb = data.storageSizeBytes ? Math.round(data.storageSizeBytes / 1024) : 0;
    const sizeMb = sizeKb > 1024 ? (sizeKb / 1024).toFixed(1) + ' MB' : sizeKb + ' KB';
    el.innerHTML =
      '<div class="stat-grid">' +
        '<div class="stat-item"><div class="stat-label">Episodes</div><div class="stat-value">' + (data.episodeCount || 0) + '</div></div>' +
        '<div class="stat-item"><div class="stat-label">Knowledge</div><div class="stat-value">' + (data.knowledgeCount || 0) + '</div></div>' +
        '<div class="stat-item"><div class="stat-label">Storage</div><div class="stat-value small">' + sizeMb + '</div></div>' +
        '<div class="stat-item"><div class="stat-label">Status</div><div class="stat-value small ok">Active</div></div>' +
      '</div>' +
      '<div class="stat-badges">' +
        '<span class="stat-badge ' + (data.hasVectorSearch ? 'active' : 'inactive') + '">Vector Search ' + (data.hasVectorSearch ? 'ON' : 'OFF') + '</span>' +
        '<span class="stat-badge ' + (data.hasEmbeddings ? 'active' : 'inactive') + '">Embeddings ' + (data.hasEmbeddings ? 'ON' : 'OFF') + '</span>' +
      '</div>';
  }

  // Synthesis panel
  function renderSynthesis(data) {
    const el = document.getElementById('synthesisPanel');
    if (!data || !data.enabled) {
      el.innerHTML = '<div class="no-data">Synthesis disabled</div>';
      return;
    }
    var lastRun = data.lastRun ? formatTime(data.lastRun) : 'Never';
    el.innerHTML =
      '<div class="stat-grid">' +
        '<div class="stat-item"><div class="stat-label">Total Runs</div><div class="stat-value">' + (data.totalRuns || 0) + '</div></div>' +
        '<div class="stat-item"><div class="stat-label">Entries Distilled</div><div class="stat-value">' + (data.totalEntriesDistilled || 0) + '</div></div>' +
        '<div class="stat-item"><div class="stat-label">Last Run</div><div class="stat-value small">' + lastRun + '</div></div>' +
        '<div class="stat-item"><div class="stat-label">Status</div><div class="stat-value small ok">Active</div></div>' +
      '</div>';
  }

  // History
  function loadHistory() {
    const q = document.getElementById('searchInput').value;
    const status = document.getElementById('statusFilter').value;
    const params = new URLSearchParams({ limit: LIMIT, offset: historyPage * LIMIT });
    if (q) params.set('q', q);
    if (status) params.set('status', status);
    fetch('/api/history?' + params, { headers: headers })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        renderHistory(data.results || []);
        document.getElementById('prevPage').disabled = historyPage === 0;
        document.getElementById('nextPage').disabled = (data.results || []).length < LIMIT;
        document.getElementById('pageInfo').textContent = 'Page ' + (historyPage + 1);
      })
      .catch(function() {});
  }

  function renderHistory(results) {
    const el = document.getElementById('historyBody');
    if (results.length === 0) {
      el.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-muted)">No results</td></tr>';
      return;
    }
    el.innerHTML = results.map(function(r) {
      return '<tr onclick="window._showTask(\\'' + esc(r.filename || '') + '\\')">' +
        '<td><span style="font-family:monospace;color:var(--accent)">' + esc((r.taskId || r.id || '').slice(0, 12)) + '</span></td>' +
        '<td>' + esc(r.from || '') + '</td>' +
        '<td><span class="status-badge ' + esc(r.status || '') + '">' + esc(r.status || '') + '</span></td>' +
        '<td style="color:var(--text-muted)">' + formatTime(r.timestamp) + '</td>' +
        '<td>' + esc((r.prompt || r.result || '').slice(0, 60)) + '</td>' +
        '</tr>';
    }).join('');
  }

  // Task detail modal
  window._showTask = function(filename) {
    if (!filename) return;
    fetch('/api/task?filename=' + encodeURIComponent(filename), { headers: headers })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        document.getElementById('modalTitle').textContent = 'Task: ' + (data.taskId || data.id || filename);
        let html = '<pre>' + esc(JSON.stringify(data, null, 2)) + '</pre>';
        if (data.decision_traces && data.decision_traces.length > 0) {
          html += '<h3 style="margin-top:16px;font-size:14px">Decision Traces</h3>';
          html += '<div class="trace-timeline">';
          data.decision_traces.forEach(function(t) {
            html += '<div class="trace-item">' +
              '<div class="trace-time">' + formatTime(t.timestamp) + '</div>' +
              '<div class="trace-phase">' + esc(t.phase) + '</div>' +
              '<div class="trace-decision">' + esc(t.decision) +
              (t.reason_code ? ' <span class="trace-reason">[' + esc(t.reason_code) + ']</span>' : '') +
              '</div></div>';
          });
          html += '</div>';
        }
        document.getElementById('modalContent').innerHTML = html;
        document.getElementById('modalOverlay').classList.add('active');
      })
      .catch(function() {});
  };

  document.getElementById('modalClose').onclick = function() {
    document.getElementById('modalOverlay').classList.remove('active');
  };
  document.getElementById('modalOverlay').onclick = function(e) {
    if (e.target === this) this.classList.remove('active');
  };

  // Search debounce
  document.getElementById('searchInput').addEventListener('input', function() {
    clearTimeout(searchTimer);
    historyPage = 0;
    searchTimer = setTimeout(loadHistory, 300);
  });
  document.getElementById('statusFilter').addEventListener('change', function() {
    historyPage = 0;
    loadHistory();
  });
  document.getElementById('prevPage').onclick = function() {
    if (historyPage > 0) { historyPage--; loadHistory(); }
  };
  document.getElementById('nextPage').onclick = function() {
    historyPage++;
    loadHistory();
  };

  // Helpers
  function esc(s) {
    if (typeof s !== 'string') return '';
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }
  function formatTime(ts) {
    if (!ts) return '';
    try {
      const d = new Date(ts);
      return d.toLocaleString(undefined, { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
    } catch(e) { return ts; }
  }

  // Initial loads
  fetch('/api/health', { headers: headers }).then(function(r) { return r.json(); }).then(renderHealth).catch(function() {});
  fetch('/api/pipeline', { headers: headers }).then(function(r) { return r.json(); }).then(renderKanban).catch(function() {});
  fetch('/api/agents', { headers: headers }).then(function(r) { return r.json(); }).then(renderAgents).catch(function() {});
  fetch('/api/workflows', { headers: headers }).then(function(r) { return r.json(); }).then(renderWorkflows).catch(function() {});
  fetch('/api/memory', { headers: headers }).then(function(r) { return r.json(); }).then(renderMemory).catch(function() {});
  fetch('/api/synthesis', { headers: headers }).then(function(r) { return r.json(); }).then(renderSynthesis).catch(function() {});
  loadHistory();
  connectSSE();
})();
</script>
</body>
</html>`;
}
