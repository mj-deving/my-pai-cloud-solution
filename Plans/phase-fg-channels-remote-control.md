# Phase F+G: Claude Channels + Remote Control — Implementation Plan v2

**Date:** 2026-03-26 (v2: addresses all Fabric + Codex review findings)
**Updated:** 2026-04-02 (Phase F complete, Phase G still pending)
**Scope:** Add Claude Channels (Telegram plugin) + Remote Control as supplementary access surfaces alongside the existing bridge
**Approach:** Non-destructive — bridge stays primary, Channels and Remote Control are additive
**Dependencies:** Claude Code v2.1.80+ on VPS (currently v2.1.84 — upgraded 2026-03-26)
**Reviewed by:** Fabric review_code (12 findings, all addressed), Codex GPT-5.4 (3 code findings, all fixed in separate commit)

## Status Summary

| Phase | Status | Notes |
|-------|--------|-------|
| Step 0 (CLI Upgrade) | COMPLETE | v2.1.84 on VPS, bridge verified |
| Phase F (Channels) | COMPLETE | Bot live, MCP tools working, hooks firing |
| Phase G (Remote Control) | PENDING | Needs interactive acceptance of workspace trust prompt |

## Blocker Resolution (verified 2026-03-26)

| Blocker | Status | Evidence |
|---------|--------|----------|
| Plugin availability | RESOLVED | `telegram@claude-plugins-official` v0.0.4 installed and enabled on VPS |
| OAuth session | RESOLVED | `claude auth status` → `loggedIn: true`, `authMethod: claude.ai`, `subscriptionType: max`, email: `mariusclaude@proton.me` |
| Memory.db sharing | RESOLVED | Hooks are in `~/.claude/settings.json` (global). All Claude sessions on VPS fire the same 14 hooks. memory.db access is via hooks (LoadContext, PRDSync, etc.) — not bridge-specific. |

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
│  ├── memory.db (SQLite — all surfaces via PAI hooks)  │
│  ├── PAI hooks (14 hooks, global in settings.json)    │
│  └── .claude/settings.json (shared config)            │
└──────────────────────────────────────────────────────┘
```

## Key Design Decisions

### 1. Bridge vs Channels — Coexistence, Not Replacement

**Decision:** Run both. Different Telegram bots, different use cases:
- **Bridge bot** (existing): Full PAI experience — commands, memory, pipeline, orchestrator
- **Channels bot** (new, separate bot token): Direct Claude access with permission relay — useful when you want raw Claude without PAI overhead

**Why not replace?** The bridge does things Channels can't: custom commands, memory injection via ClaudeInvoker, pipeline dispatch, streaming status messages, auto-wrapup, importance scoring. Channels does things the bridge can't: permission relay (approve/deny tool use from Telegram), native Claude session management.

### 2. Remote Control — Server Mode as Systemd Service

**Decision:** Run as a separate systemd service alongside the bridge. Uses worktree spawning for isolation.

**Why:** Gives Marius direct CLI access from mobile without SSH. Useful for ad-hoc work, debugging, manual operations that don't go through the bridge.

### 3. Shared Hooks — All Access Surfaces Benefit

PAI hooks fire on ALL Claude sessions — they're in `~/.claude/settings.json` (global). Verified hooks include SecurityValidator, LoadContext, PRDSync, RatingCapture, SessionAutoName. Terminal-specific hooks (KittyEnvPersist, VoiceCompletion, ResponseTabReset) will silently no-op in non-terminal contexts — safe.

**Hook scoping note:** No bridge-specific env vars (TELEGRAM_USER_ID, etc.) leak into Channels/Remote sessions because those are set by the bridge process, not by settings.json. Channels and Remote Control sessions inherit only the systemd Environment= vars.

## Implementation Order (revised per Fabric review)

```
1. ✅ Upgrade Claude CLI on VPS to v2.1.80+ (v2.1.84 installed 2026-03-26)
2. ✅ Verify bridge still works after upgrade (GATE — passed)
3. ⏳ Phase G: Remote Control — BLOCKED on interactive trust acceptance
4. ⏳ Verify Phase G works from mobile app (GATE)
5. ✅ Phase F: Claude Channels — COMPLETE (bot live, MCP + hooks verified)
6. ✅ Verify Phase F coexists with bridge (GATE — passed)
7. ✅ Phase F systemd service created; Phase G service created but disabled
8. ✅ Documented in CLAUDE.md
```

Note: Implementation order deviated from plan — Phase F was completed before Phase G due to the interactive trust acceptance blocker on Remote Control.

## Step 0: Upgrade Claude CLI (prerequisite for both) — COMPLETE

Upgraded to v2.1.84 on 2026-03-26. Bridge verified working after upgrade.

## Phase G: Remote Control (Server Mode) — PENDING

**Blocker:** Requires interactive acceptance of "Enable Remote Control?" workspace trust prompt. Cannot be automated — needs SSH TTY session: `ssh -t isidore_cloud 'cd ~/projects/my-pai-cloud-solution && ~/.npm-global/bin/claude'` → accept → `/exit` → `sudo systemctl enable --now isidore-cloud-remote`

### Prerequisites
- [x] Claude CLI v2.1.51+ on VPS (v2.1.84 installed)
- [x] OAuth session valid (`claude auth status` → logged in as mariusclaude@proton.me, max subscription)
- [x] Systemd service file created (`isidore-cloud-remote`, disabled — awaiting trust acceptance)
- [ ] Claude mobile app installed on Marius's phone
- [ ] Interactive workspace trust acceptance (BLOCKER)

### Step 1: Test Interactive Remote Control
```bash
# On VPS via SSH (in tmux for persistence)
ssh isidore_cloud
tmux new -s remote-test
claude --remote-control "PAI Cloud Test"
# Terminal shows session URL and QR code
# Press spacebar to toggle QR display
```
On phone: Open Claude app → session list → "PAI Cloud Test" (green dot) → connect → send test message.

**Verify:** Response received on phone. Then exit the test session.

### Step 2: Server Mode with Worktree Spawning
```bash
claude remote-control \
  --name "PAI Cloud" \
  --spawn worktree \
  --capacity 4
```

**Port verification (Fabric finding #9):**
Remote Control uses outbound HTTPS only — no inbound ports opened. All traffic goes through Anthropic API over TLS. No firewall changes needed.
```bash
# Verify no new listening ports after start
ssh isidore_cloud 'ss -tlnp | grep -v "3456\|22\|25"'
```

### Step 3: Systemd Service

**Requires sudo (Fabric finding #6):**
```bash
# Verify sudo access first
ssh isidore_cloud 'sudo -n true && echo "sudo OK" || echo "sudo NOT available"'
```

Create `/etc/systemd/system/isidore-cloud-remote.service`:
```ini
[Unit]
Description=Isidore Cloud Remote Control (Claude Code Server Mode)
After=network.target isidore-cloud-bridge.service
Wants=network-online.target
# No PartOf — supplementary services survive bridge restarts independently

[Service]
Type=simple
User=isidore_cloud
WorkingDirectory=/home/isidore_cloud/projects/my-pai-cloud-solution
Environment=HOME=/home/isidore_cloud
Environment=PAI_DIR=/home/isidore_cloud/.claude
Environment=PATH=/home/isidore_cloud/.bun/bin:/home/isidore_cloud/.npm-global/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/home/isidore_cloud/.npm-global/bin/claude remote-control --name "PAI Cloud" --spawn worktree --capacity 4
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

**Service ordering (Fabric finding #5):**
- `After=isidore-cloud-bridge.service` — waits for bridge to start first on boot
- No `PartOf` — supplementary services stay up during bridge deploys/restarts (Codex P2)

```bash
sudo cp /tmp/isidore-cloud-remote.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable isidore-cloud-remote
sudo systemctl start isidore-cloud-remote
```

### Step 4: Worktree Cleanup (Fabric finding #8)

Remote Control with `--spawn worktree` creates git worktrees per session. Cleanup strategy:

**Automatic:** Claude cleans up worktrees when sessions disconnect normally.

**Manual fallback:** If worktrees persist after abnormal exits:
```bash
# Check stale worktrees
ssh isidore_cloud 'cd ~/projects/my-pai-cloud-solution && git worktree list'

# Prune dead worktrees
ssh isidore_cloud 'cd ~/projects/my-pai-cloud-solution && git worktree prune'
```

**Automated cleanup cron (add alongside existing backup cron):**
```bash
ssh isidore_cloud '(crontab -l 2>/dev/null; echo "30 3 * * * cd ~/projects/my-pai-cloud-solution && git worktree prune 2>/dev/null") | crontab -'
```

### Step 5: Verify
1. Connect from mobile app → send message → get response
2. PAI hooks fire (check `journalctl -u isidore-cloud-remote` for hook traces)
3. Bridge unaffected (`sudo systemctl is-active isidore-cloud-bridge`)
4. Multiple sessions work (phone + claude.ai/code)
5. Service restart → sessions reconnectable

### Risks
- **10-minute timeout** if VPS unreachable. Mitigation: systemd Restart=on-failure, RestartSec=10.
- **OAuth session expiry.** Mitigation: periodic check via `claude auth status`. Re-auth: `claude auth login`.
- **Worktree disk usage.** Mitigation: capacity=4, daily prune cron.

## Phase F: Claude Channels (Telegram Plugin) — COMPLETE

Channels is live on VPS as of 2026-03-26. Implementation details below reflect what was actually deployed.

### Actual Implementation

- **Service:** `isidore-cloud-channels` systemd service, tmux-based
- **Launch:** `claude --channels` flag (not `--channels plugin:telegram@...` as originally planned)
- **Plugin:** `telegram@claude-plugins-official` v0.0.4 installed and enabled
- **Access control:** `access.json` allowlist (not `/telegram:access` commands as originally planned)
- **MCP servers:** Configured via `.mcp.json` — pai-memory-server and pai-context-server working
- **Hooks:** All 14 PAI hooks fire correctly in Channels sessions (verified via journalctl)
- **Bot:** Separate Telegram bot token, coexists with bridge bot

### Prerequisites (all met)
- [x] Claude CLI v2.1.80+ on VPS (v2.1.84 installed)
- [x] OAuth session valid (verified above)
- [x] Create second Telegram bot via @BotFather
- [x] Get the new bot token and configure plugin

### Step 0.5: Verify Plugin Availability (Fabric finding #1)

```bash
# After CLI upgrade, test plugin install infrastructure
ssh isidore_cloud 'claude plugins list'
# Expected: "No plugins installed" (confirms command works)

# Search for official Telegram plugin
ssh isidore_cloud 'claude plugins search telegram 2>&1 || claude plugin list --available 2>&1'
```

If the plugin isn't found, check Claude Code release notes for the correct plugin name. The plugin may be `telegram` (not `telegram@claude-plugins-official`).

**If plugin install fails entirely:** Channels is research preview — document the failure and defer to a later Claude Code version. Bridge remains primary.

### Step 1: Install and Configure the Telegram Plugin

```bash
# On VPS, start Claude interactively
ssh isidore_cloud
tmux new -s channels-setup
claude

# Inside Claude session:
/plugin install telegram@claude-plugins-official
/reload-plugins
/telegram:configure <NEW_BOT_TOKEN>
# Expected: "Telegram plugin configured successfully"
```

**Token storage (Fabric finding #7):**
The bot token is stored in Claude's plugin configuration (likely `~/.claude/plugins/` or `settings.json`). Verify:
```bash
# After configuration, check where token landed
ssh isidore_cloud 'grep -r "BOT_TOKEN_PREFIX" ~/.claude/plugins/ ~/.claude/settings.json 2>/dev/null | head -5'
```
Token is stored in plaintext — same security model as bridge.env. Access restricted to `isidore_cloud` user (file permissions 600).

### Step 2: Start Channels Session
```bash
claude --channels plugin:telegram@claude-plugins-official \
  --name "Isidore Channels"
```

### Step 3: Pair Your Telegram Account
1. Send any message to the **new** bot (Isidore Direct) from Telegram
2. Bot responds with a pairing code
3. In the Claude session: `/telegram:access pair <code>`
4. Lock to allowlist: `/telegram:access policy allowlist`

### Step 4: Test Permission Relay
1. Send a message that triggers tool use (e.g., "read package.json")
2. Channels forwards the approval prompt to Telegram
3. Approve from Telegram with "yes <verdict-id>"
4. Verify tool executes and result returns to Telegram

### Step 5: Systemd Service

```ini
[Unit]
Description=Isidore Cloud Channels (Claude Code Telegram Plugin)
After=network.target isidore-cloud-bridge.service
Wants=network-online.target
# No PartOf — supplementary services survive bridge restarts independently

[Service]
Type=simple
User=isidore_cloud
WorkingDirectory=/home/isidore_cloud/projects/my-pai-cloud-solution
Environment=HOME=/home/isidore_cloud
Environment=PAI_DIR=/home/isidore_cloud/.claude
Environment=PATH=/home/isidore_cloud/.bun/bin:/home/isidore_cloud/.npm-global/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/home/isidore_cloud/.npm-global/bin/claude --channels plugin:telegram@claude-plugins-official --name "Isidore Channels"
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

### Step 6: Verify Coexistence (Fabric finding #4 — automated)

```bash
#!/bin/bash
# scripts/verify-access-surfaces.sh
set -e
# Source bridge.env for DASHBOARD_TOKEN
source ~/.config/isidore_cloud/bridge.env 2>/dev/null || true
echo "[1/5] Bridge service..."
sudo systemctl is-active isidore-cloud-bridge || { echo "FAIL: bridge down"; exit 1; }

echo "[2/5] Channels service..."
sudo systemctl is-active isidore-cloud-channels || echo "WARN: channels not running"

echo "[3/5] Remote Control service..."
sudo systemctl is-active isidore-cloud-remote || echo "WARN: remote not running"

echo "[4/5] Dashboard accessible..."
curl -sf -o /dev/null -H "Authorization: Bearer $DASHBOARD_TOKEN" http://127.0.0.1:3456/ || echo "WARN: dashboard down"

echo "[5/5] No port conflicts..."
ss -tlnp | grep -E "LISTEN" | grep -v "3456\|22" | head -5

echo "Verification complete."
```

### Step 7: Memory Sharing Verification (Fabric finding #3 — resolved)

PAI hooks are global (`~/.claude/settings.json`). All sessions fire them. To confirm:
```bash
# After sending a message via Channels bot, check memory.db
ssh isidore_cloud 'bun -e "
  const db = require(\"bun:sqlite\").Database;
  const d = new db(\"/home/isidore_cloud/projects/my-pai-cloud-solution/data/memory.db\");
  const rows = d.query(\"SELECT id, source, content FROM episodes ORDER BY id DESC LIMIT 3\").all();
  console.log(JSON.stringify(rows, null, 2));
"'
# Should show the Channels message recorded as an episode
```

If memory is NOT being recorded: hooks may not fire on plugin sessions. In that case, Channels operates without memory context — acceptable for a supplementary surface.

### Risks
- **Channels is research preview** — may change or be removed. Mitigation: bridge stays primary.
- **Two bots can confuse** — Mitigation: name them "Isidore" (bridge) vs "Isidore Direct" (channels).
- **Session lifetime** — Channels session may timeout. Mitigation: systemd Restart=on-failure.
- **Plugin install may fail** — Mitigation: test locally first, defer if unavailable.

### Tests
1. Send message to Channels bot → get response
2. Send message to Bridge bot → get response (unaffected)
3. Permission relay: trigger tool use → approve from Telegram
4. Memory sharing: query memory.db after Channels message
5. Restart Channels service → bot reconnects

## Rollback Procedure (Fabric finding #4)

If any phase breaks the bridge:

```bash
# 1. Stop supplementary services
sudo systemctl stop isidore-cloud-channels isidore-cloud-remote 2>/dev/null

# 2. Restart bridge
sudo systemctl restart isidore-cloud-bridge
sleep 5
sudo systemctl is-active isidore-cloud-bridge

# 3. If bridge is STILL broken (CLI upgrade issue):
npm install -g @anthropic-ai/claude-code@2.1.76
sudo systemctl restart isidore-cloud-bridge

# 4. Verify
curl -s -H "Authorization: Bearer $DASHBOARD_TOKEN" http://127.0.0.1:3456/api/status
```

## Feature Flags

No new feature flags needed — these are external services, not bridge subsystems. Enable/disable via systemd:
```bash
# Enable (start on boot):
sudo systemctl enable isidore-cloud-channels
sudo systemctl enable isidore-cloud-remote

# Disable (don't start on boot):
sudo systemctl disable isidore-cloud-channels
sudo systemctl disable isidore-cloud-remote
```

## Documentation Updates (Fabric finding #12 — complete)

**CLAUDE.md VPS Details → Services:**
```markdown
- **Services:**
  - `isidore-cloud-bridge` (Telegram + pipeline + orchestrator) — PRIMARY
  - `isidore-cloud-channels` (Claude Channels Telegram plugin) — SUPPLEMENTARY
  - `isidore-cloud-remote` (Remote Control server mode) — SUPPLEMENTARY
  - `isidore-cloud-tmux` (persistent tmux)

**Service management:**
  sudo systemctl status isidore-cloud-{bridge,channels,remote}
  sudo journalctl -u isidore-cloud-channels -f
  sudo systemctl enable isidore-cloud-channels   # start on boot
  sudo systemctl disable isidore-cloud-channels  # don't start on boot
```

**CLAUDE.md Telegram Commands:**
```markdown
- **Channels bot (Isidore Direct):** Direct Claude access with permission relay (separate bot token, supplementary)
- **Remote Control:** Connect via Claude mobile app or claude.ai/code (server mode, supplementary)
```

**CLAUDE.md Troubleshooting (new section):**
```markdown
## Troubleshooting: Access Surfaces

**Channels not responding:**
  sudo journalctl -u isidore-cloud-channels -n 50
  # Look for: plugin install failed, bot token invalid, session timeout
  sudo systemctl restart isidore-cloud-channels

**Remote Control not visible in Claude app:**
  sudo journalctl -u isidore-cloud-remote -n 50
  claude auth status  # Check if OAuth expired
  # If expired: claude auth login

**Memory not shared:**
  Check if hooks fire: journalctl -u isidore-cloud-channels | grep hook
  If no hook logs: Channels operates without memory (acceptable for supplementary surface)
```

## Review Resolution Log

| Finding | Source | Severity | Resolution |
|---------|--------|----------|------------|
| Plugin availability unverified | Fabric #1 | BLOCKER | Added Step 0.5 with search/fallback. Verified `plugins list` works on VPS. |
| OAuth session not validated | Fabric #2 | BLOCKER | Verified via `claude auth status`. Documented re-auth procedure. |
| Memory.db sharing undefined | Fabric #3 | BLOCKER | Verified hooks are global. Added Step 7 memory verification procedure. |
| No rollback procedure | Fabric #4 | HIGH | Added full rollback section with CLI downgrade path. |
| Service ordering missing | Fabric #5 | HIGH | Added After=bridge, PartOf=bridge to both services. |
| Sudo not documented | Fabric #6 | HIGH | Added sudo verification step before service creation. |
| Plugin auth flow incomplete | Fabric #7 | MEDIUM | Documented token storage location and permissions. |
| Worktree cleanup undefined | Fabric #8 | MEDIUM | Added git worktree prune cron + manual fallback. |
| Port bindings not documented | Fabric #9 | MEDIUM | Clarified: outbound HTTPS only, no inbound ports. |
| Implementation order incomplete | Fabric #10 | MEDIUM | Revised to gate-based sequence with rollback at each step. |
| Hook scoping untested | Fabric #11 | MEDIUM | Documented: hooks are global, bridge env vars don't leak. |
| Documentation incomplete | Fabric #12 | MEDIUM | Added troubleshooting section, service management commands. |
| Bun not in PATH for systemd units | Codex P1 | HIGH | Added Environment=PATH with ~/.bun/bin to both service units. |
| PartOf couples services to bridge restarts | Codex P2 | MEDIUM | Removed PartOf — supplementary services survive bridge deploys. |
| verify script missing bridge.env source | Codex P3 | LOW | Added `source ~/.config/isidore_cloud/bridge.env` to script. |
| enable/disable not valid systemctl verb | Codex P3 | LOW | Split into separate `enable` and `disable` commands. |
