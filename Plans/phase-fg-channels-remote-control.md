# Phase F+G: Claude Channels + Remote Control — Implementation Plan

**Date:** 2026-03-26
**Scope:** Add Claude Channels (Telegram plugin) + Remote Control as supplementary access surfaces alongside the existing bridge
**Approach:** Non-destructive — bridge stays primary, Channels and Remote Control are additive
**Dependencies:** Claude Code v2.1.80+ on VPS (currently 2.1.76 — upgrade required)

## Architecture After Implementation

```
┌──────────────────────────────────────────────────────┐
│                PAI Cloud (VPS)                        │
├──────────────────────────────────────────────────────┤
│  Access Surfaces (user-to-agent)                     │
│  ├── Telegram Bridge (PRIMARY — Grammy bot)          │
│  │   └── bridge.ts → ClaudeInvoker → claude CLI      │
│  ├── Claude Channels (SUPPLEMENTARY — official plugin)│
│  │   └── claude --channels plugin:telegram → session  │
│  ├── Remote Control (SUPPLEMENTARY — server mode)     │
│  │   └── claude remote-control → mobile/web access    │
│  └── Dashboard (MONITORING — Bun.serve :3456)         │
├──────────────────────────────────────────────────────┤
│  Shared Resources                                     │
│  ├── memory.db (SQLite — all surfaces share)          │
│  ├── PAI hooks (fire on all Claude sessions)          │
│  └── .claude/settings.json (shared config)            │
└──────────────────────────────────────────────────────┘
```

## Key Design Decisions

### 1. Bridge vs Channels — Coexistence, Not Replacement

The bridge is a custom Telegram bot with 30+ commands, memory integration, pipeline dispatch, statusline, and streaming. Claude Channels' official Telegram plugin is a simpler integration — it forwards messages directly to a Claude session.

**Decision:** Run both. Different Telegram bots, different use cases:
- **Bridge bot** (existing): Full PAI experience — commands, memory, pipeline, orchestrator
- **Channels bot** (new, separate bot token): Direct Claude access with permission relay — useful when you want raw Claude without PAI overhead

**Why not replace?** The bridge does things Channels can't: custom commands, memory injection, pipeline dispatch, streaming status messages, auto-wrapup, importance scoring. Channels does things the bridge can't: permission relay (approve/deny tool use from Telegram), native Claude session management.

### 2. Remote Control — Server Mode as Systemd Service

Remote Control lets you steer a VPS session from the Claude mobile app. Server mode (`claude remote-control --spawn worktree`) supports multiple concurrent sessions.

**Decision:** Run as a separate systemd service alongside the bridge. Uses worktree spawning for isolation.

**Why:** Gives Marius direct CLI access from mobile without SSH. Useful for ad-hoc work, debugging, manual operations that don't go through the bridge.

### 3. Shared Hooks — All Access Surfaces Benefit

PAI hooks (UserPromptSubmit, PostToolUse, SessionStart) fire on ALL Claude sessions — bridge-spawned, Channels, and Remote Control. Memory context injection works everywhere.

## Phase F: Claude Channels (Telegram Plugin)

### Prerequisites
- [ ] Upgrade Claude CLI on VPS to v2.1.80+ (`npm update -g @anthropic-ai/claude-code`)
- [ ] Create a second Telegram bot via @BotFather (name: "Isidore Direct" or similar)
- [ ] Get the new bot token

### Step 1: Install and Configure the Telegram Plugin
```bash
# On VPS, in a tmux session
claude
/plugin install telegram@claude-plugins-official
/reload-plugins
/telegram:configure <NEW_BOT_TOKEN>
```

### Step 2: Start Channels Session
```bash
claude --channels plugin:telegram@claude-plugins-official \
  --name "Isidore Channels"
```

### Step 3: Pair Your Telegram Account
1. Send any message to the new bot from Telegram
2. Bot responds with a pairing code
3. In the Claude session: `/telegram:access pair <code>`
4. Lock to allowlist: `/telegram:access policy allowlist`

### Step 4: Test Permission Relay
1. Send a message that triggers tool use (e.g., "read package.json")
2. Channels should forward the approval prompt to Telegram
3. Approve from Telegram with "yes <verdict-id>"
4. Verify tool executes and result returns to Telegram

### Step 5: Systemd Service
Create `/etc/systemd/system/isidore-cloud-channels.service`:
```ini
[Unit]
Description=Isidore Cloud Channels (Claude Code Telegram Plugin)
After=network.target
Wants=network-online.target

[Service]
Type=simple
User=isidore_cloud
WorkingDirectory=/home/isidore_cloud/projects/my-pai-cloud-solution
Environment=HOME=/home/isidore_cloud
Environment=PAI_DIR=/home/isidore_cloud/.claude
ExecStart=/home/isidore_cloud/.npm-global/bin/claude --channels plugin:telegram@claude-plugins-official --name "Isidore Channels"
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

### Step 6: Verify Coexistence
- Bridge service running on bridge bot token ✓
- Channels service running on separate bot token ✓
- Both share memory.db via PAI hooks ✓
- No port conflicts (Channels doesn't open ports) ✓

### Risks
- **Channels is research preview** — may change or be removed. Mitigation: bridge stays primary, Channels is supplementary.
- **Two bots can confuse** — Mitigation: name them clearly ("Isidore" vs "Isidore Direct"), document which is which.
- **Session lifetime** — Channels session may timeout. Mitigation: systemd Restart=on-failure.
- **Plugin install may fail on VPS** — Mitigation: test locally first.

### Tests
1. Send message to Channels bot → get response
2. Send message to Bridge bot → get response (unaffected)
3. Permission relay: trigger tool use → approve from Telegram
4. Both bots share memory context (verify via memory.db query)
5. Restart Channels service → bot reconnects

## Phase G: Remote Control (Server Mode)

### Prerequisites
- [ ] Claude CLI v2.1.51+ on VPS (already met if upgraded for Channels)
- [ ] Claude mobile app installed on Marius's phone

### Step 1: Test Interactive Remote Control
```bash
# On VPS via SSH
claude --remote-control "PAI Cloud"
# Note the session URL and QR code
# Open Claude app on phone → connect to session
```

### Step 2: Server Mode with Worktree Spawning
```bash
claude remote-control \
  --name "PAI Cloud" \
  --spawn worktree \
  --capacity 4
```
This allows up to 4 concurrent sessions, each in an isolated git worktree.

### Step 3: Systemd Service
Create `/etc/systemd/system/isidore-cloud-remote.service`:
```ini
[Unit]
Description=Isidore Cloud Remote Control (Claude Code Server Mode)
After=network.target
Wants=network-online.target

[Service]
Type=simple
User=isidore_cloud
WorkingDirectory=/home/isidore_cloud/projects/my-pai-cloud-solution
Environment=HOME=/home/isidore_cloud
Environment=PAI_DIR=/home/isidore_cloud/.claude
ExecStart=/home/isidore_cloud/.npm-global/bin/claude remote-control --name "PAI Cloud" --spawn worktree --capacity 4
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

### Step 4: Mobile App Connection
1. Install Claude app on phone (iOS/Android)
2. Log in with same Anthropic account as VPS
3. Go to claude.ai/code or Claude app → session list
4. "PAI Cloud" should appear with green dot (online)
5. Connect and send a test message

### Step 5: Verify Isolation
- Remote Control sessions run in separate worktrees (no conflict with bridge)
- PAI hooks fire on Remote Control sessions too
- Bridge continues working independently

### Risks
- **10-minute timeout** if VPS becomes unreachable. Mitigation: systemd restart.
- **Requires claude.ai auth** — API keys don't work. Mitigation: VPS already has OAuth session.
- **Worktree disk usage** — each session gets a worktree. Mitigation: capacity cap of 4, cleanup on exit.

### Tests
1. Connect from mobile app → send message → get response
2. Multiple sessions (phone + tablet) → both work independently
3. Bridge unaffected during Remote Control usage
4. PAI hooks fire on Remote Control sessions (check journalctl)
5. Service restart → sessions reconnectable

## Implementation Order

```
1. Upgrade Claude CLI on VPS (prerequisite for both)
2. Phase G first (simpler — no new bot needed, just a CLI flag)
3. Phase F second (needs new bot token, plugin install)
4. Create systemd services for both
5. Document in CLAUDE.md
```

Phase G first because it has fewer moving parts and tests the Claude CLI upgrade independently.

## Feature Flags

No new feature flags needed — these are external services, not bridge subsystems. Enable/disable via systemd:
```bash
sudo systemctl enable/disable isidore-cloud-channels
sudo systemctl enable/disable isidore-cloud-remote
```

## Documentation Updates

Add to CLAUDE.md VPS Details section:
```markdown
- **Services:**
  - `isidore-cloud-bridge` (Telegram + pipeline + orchestrator) — PRIMARY
  - `isidore-cloud-channels` (Claude Channels Telegram plugin) — SUPPLEMENTARY
  - `isidore-cloud-remote` (Remote Control server mode) — SUPPLEMENTARY
  - `isidore-cloud-tmux` (persistent tmux)
```

Add to Telegram Commands section:
```markdown
- **Channels bot:** Direct Claude access with permission relay (separate bot)
- **Remote Control:** Connect via Claude mobile app or claude.ai/code
```
