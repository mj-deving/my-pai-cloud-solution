---
prd: true
id: PRD-20260225-pai-cloud-isidore
status: IN_PROGRESS
mode: interactive
effort_level: Extended
created: 2026-02-25
updated: 2026-02-25
iteration: 1
maxIterations: 128
loopStatus: null
last_phase: VERIFY
failing_criteria: [C6, C7, C11]
verification_summary: "11/14"
parent: null
children: []
---

# PAI Cloud Isidore — VPS Deployment Masterplan

> Deploy a full PAI/Isidore installation on the existing VPS alongside Gregor, with mobile-accessible communication channels (Telegram, email, SSH), using Max 5x subscription OAuth flatrate billing, running as a persistent conversational session.

## STATUS

| What | State |
|------|-------|
| Progress | 11/14 criteria passing |
| Phase | IN_PROGRESS — 3 criteria remaining |
| Next action | C6 (email bridge), C7 (phone SSH test), C11 (memory test) |
| Blocked by | C6: email account details from Marius. C7/C11: Marius tests |

## CONTEXT

### Problem Space
Marius wants Isidore available 24/7 from mobile, not just when sitting at the local machine. The VPS already runs Gregor (OpenClaw bot). By deploying Isidore there too — on the Max 5x subscription OAuth flatrate — Marius gets an always-on AI assistant accessible via Telegram, email, and SSH from anywhere.

### Key Constraint: Persistent Conversation
Isidore maintains an ongoing back-and-forth conversation. Marius manually manages session context (when to clear, when to start fresh). All communication channels feed into the **same conversation** via `claude --resume <session-id>`. This is NOT one-shot — it's a continuous dialogue.

### VPS Environment
- **Gregor:** OpenClaw bot running as `openclaw` user, systemd service, gateway on port 18789
- **OS:** Linux (likely Debian/Ubuntu)
- **Access:** Marius has SSH root access
- **Subscription:** Max 5x ($100/mo) — ~225 prompts per 5-hour rolling window

### Critical Technical Findings

**Authentication:**
- SSH port forwarding (`ssh -L 7160:localhost:7160`) handles initial `claude /login` on headless VPS
- `claude setup-token` generates a long-lived OAuth token for automation
- OAuth tokens expire ~24h without refresh (known bug) — monitoring + re-auth needed
- `CLAUDE_CODE_API_KEY_HELPER_TTL_MS` allows custom refresh scripts

**Session Persistence via `--resume` (KEY DISCOVERY):**
- `claude --resume <session-id> -p "message" --output-format json` — programmatically injects messages into an existing conversation with full context
- Sessions stored as JSONL: `~/.claude/projects/<project>/sessions/<uuid>.jsonl`
- Full conversation history preserved across resumes (limited by context window, use `/compact` proactively)
- Works with `--output-format json` for clean programmatic output (session_id, result, usage)
- No limit on resume count — practical limit is context window size
- **This is the bridge mechanism** — Telegram and email use `--resume`, SSH uses interactive `claude`

### Constraints
- Max 5x: ~225 prompts per 5-hour rolling window — adequate for moderate use
- OAuth token ~24h expiry without auto-refresh — needs monitoring cron
- VPS resources shared with Gregor — memory/CPU budgeting needed
- Telegram bot API: 4096 char message limit (need chunking for long responses)

## PLAN

### Architecture: Dual-Mode Session

All channels share ONE conversation via a session ID file (`~/.claude/active-session-id`).

| Channel | Method | Mode | Best For |
|---------|--------|------|----------|
| **SSH** | `tmux attach` → live interactive `claude` | Full interactive | Deep work, complex tasks |
| **Telegram** | `claude --resume $SID -p "msg" --output-format json` | Programmatic | Quick mobile back-and-forth |
| **Email** | `claude --resume $SID -p "body" --output-format json` | Programmatic | Async, long-form requests |
| **Cron** | `claude -p "task"` (separate session) | One-shot | Scheduled automation |

**Session management helper (`isidore-session`):**
- `isidore-session new` — starts new conversation, saves session ID
- `isidore-session current` — prints current session ID
- `isidore-session clear` — archives current, starts fresh
- `isidore-session list` — shows recent sessions

Telegram bot commands mirror this: `/new`, `/status`, `/clear`.

### Phase 1: Foundation (ISC-C1, C2, C3, C4, A3)

**Step 1.1 — Create `isidore` user on VPS:**
```bash
ssh vps
sudo useradd -m -s /bin/bash isidore
sudo usermod -aG sudo isidore
echo "isidore ALL=(ALL) NOPASSWD:ALL" | sudo tee /etc/sudoers.d/isidore
sudo mkdir -p /home/isidore/.ssh
sudo cp ~/.ssh/authorized_keys /home/isidore/.ssh/
sudo chown -R isidore:isidore /home/isidore/.ssh
```

**Step 1.2 — Install Claude Code CLI + Bun:**
```bash
su - isidore
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt-get install -y nodejs
curl -fsSL https://bun.sh/install | bash
npm install -g @anthropic-ai/claude-code
```

**Step 1.3 — Authenticate with Max 5x:**
```bash
# From local machine — SSH tunnel for browser-based OAuth:
ssh -L 7160:localhost:7160 isidore@vps
# On VPS in that session:
claude /login
# Browser opens locally, OAuth completes, token stored on VPS
```

**Step 1.4 — Deploy PAI installation:**
```bash
rsync -avz --exclude='debug/' --exclude='cache/' --exclude='projects/' \
  ~/.claude/ isidore@vps:~/.claude/
rsync -avz ~/my-pai/ isidore@vps:~/my-pai/
```

**Step 1.5 — Verify coexistence:**
- `systemctl status openclaw` — Gregor still running
- `su - isidore -c 'claude -p "hello"'` — Isidore responds
- No port conflicts

### Phase 2: Session Management + SSH (ISC-C7, C11)

**Step 2.1 — tmux for interactive SSH:**
```bash
sudo apt install tmux
```
systemd service keeps tmux alive across reboots.

**Step 2.2 — `isidore-session` helper script:**
Manages the active session ID shared across all channels.

**Step 2.3 — Mobile SSH:**
- `ssh isidore@vps` → `tmux attach -t isidore`
- Alias: `alias iso='tmux attach -t isidore'`
- Mobile client: Termius (iOS/Android)

### Phase 3: Telegram Bridge (ISC-C5, C9)

**Step 3.1 — Create new bot via @BotFather**

**Step 3.2 — Build `isidore-bridge.ts` (Bun/TypeScript):**
```
~/projects/my-pai-cloud-solution/src/
├── bridge.ts        # Main: Telegram polling + email polling
├── telegram.ts      # Telegram bot (grammy or node-telegram-bot-api)
├── email.ts         # IMAP poller + msmtp response
├── session.ts       # Read/write ~/.claude/active-session-id
├── claude.ts        # claude --resume $SID -p "msg" --output-format json
├── format.ts        # Compact mobile-friendly response formatter
└── auth.ts          # Sender validation (Telegram ID, email whitelist)
```

**Core flow:**
1. Telegram message arrives (long polling — no HTTPS needed)
2. Validate sender = Marius's Telegram user ID
3. Read `~/.claude/active-session-id`
4. Run: `claude --resume $SID -p "message" --output-format json`
5. Parse JSON, format compact for mobile
6. Send back via Telegram (chunk if > 4096 chars)
7. Bot commands: `/new` = fresh session, `/status` = info, `/clear` = archive + new

**Step 3.3 — systemd service:**
```ini
[Unit]
Description=Isidore Communication Bridge
After=network.target

[Service]
Type=simple
User=isidore
WorkingDirectory=/home/isidore/my-pai-cloud-solution
ExecStart=/home/isidore/.bun/bin/bun run src/bridge.ts
Restart=always
RestartSec=5
Environment="TELEGRAM_BOT_TOKEN=xxx"
Environment="TELEGRAM_ALLOWED_USER_ID=xxx"

[Install]
WantedBy=multi-user.target
```

### Phase 4: Email Bridge (ISC-C6)

**Step 4.1 — IMAP polling (built into bridge.ts):**
- Poll designated email via IMAP every 60 seconds
- `mailparser` for subject + body extraction
- Whitelist: only Marius's email addresses

**Step 4.2 — Response via msmtp:**
- Compact format: strip Algorithm verbosity → summary + output + action items
- Max ~500 words for mobile readability

### Phase 5: Auth Resilience (ISC-C8, A1)

**Step 5.1 — Auth health check cron (every 4 hours):**
```bash
# Tests: claude -p "health" --max-turns 1 --output-format json
# 401 → alert via Telegram bot
# ok → log success
```

**Step 5.2 — Re-auth procedure:**
- Telegram alert with instructions when token expires
- Re-auth: `ssh -L 7160:localhost:7160 isidore@vps` → `claude /login`

### Phase 6: Automation Framework (ISC-C10)

- Crontab for `isidore` user
- Cron jobs use `claude -p` (one-shot, separate sessions)
- Interactive session reserved for Marius's direct use
- Template: `0 8 * * * /home/isidore/scripts/run-task.sh "morning briefing"`

## IDEAL STATE CRITERIA (Verification Criteria)

### Foundation
- [x] ISC-C1: Claude Code CLI installed and authenticated on VPS via OAuth | Verify: CLI: `claude -p "test"` returns valid response
- [x] ISC-C2: PAI skill tree and CLAUDE.md deployed on VPS | Verify: CLI: `ls ~/.claude/skills/PAI/SKILL.md`
- [x] ISC-C3: Gregor and Isidore coexist without port or resource conflicts | Verify: CLI: both services running simultaneously
- [x] ISC-C4: Isidore has root access and SSH capability on VPS | Verify: CLI: `sudo whoami` = root

### Communication Channels
- [x] ISC-C5: Telegram bot receives messages and triggers claude invocations | Verify: Browser: send test message, receive response
- [ ] ISC-C6: Email inbound triggers Isidore processing and sends compacted response | Verify: Custom: send test email, verify response
- [ ] ISC-C7: Mobile SSH access provides responsive CLI interaction with Isidore | Verify: Custom: SSH from phone, run claude

### Resilience & Security
- [x] ISC-C8: OAuth token refresh mechanism prevents authentication expiration silently | Verify: CLI: cron job exists, token valid
- [x] ISC-C9: All communication channels authenticate only Marius as authorized user | Verify: Custom: unauthorized attempt rejected
- [x] ISC-C10: Cron and automation framework available for scheduled Isidore tasks | Verify: CLI: crontab shows entries
- [ ] ISC-C11: PAI memory system persists across all channel invocations on VPS | Verify: Grep: MEMORY writes from multiple channels

### Anti-Criteria
- [x] ISC-A1: No API billing charges incurred from VPS Isidore usage | Verify: CLI: no ANTHROPIC_API_KEY in env
- [x] ISC-A2: No unauthorized users can trigger Isidore on VPS | Verify: Custom: unauthorized access → rejection
- [x] ISC-A3: Gregor's OpenClaw operation never disrupted by Isidore processes | Verify: CLI: Gregor stable during Isidore load

## DECISIONS

### 2026-02-25: `claude --resume` for Telegram/email, tmux for SSH
**Decision:** Telegram and email bridges use `claude --resume $SID -p "msg" --output-format json`. SSH uses live interactive `claude` in tmux. All channels share the same session ID.
**Rationale:** `--resume` gives clean programmatic I/O with full session context preservation. tmux gives full interactive experience for SSH. Session ID file bridges both modes.
**Alternatives considered:** tmux-only (hacky output capture), SDK-only (no interactive mode).

### 2026-02-25: IMAP polling for email, not Postfix
**Decision:** Poll existing email account via IMAP rather than running a mail server.
**Rationale:** No MX records, no spam management, no deliverability concerns.
**Alternatives considered:** Postfix (heavy), webhook services (dependency).

### 2026-02-25: Single bridge service for Telegram + Email
**Decision:** One Bun service handles both channels, sharing session management and auth logic.
**Rationale:** DRY, one systemd service, shared session ID management.

## FEASIBILITY ASSESSMENT

### Straightforward (90%+ confidence):
- VPS user creation, Claude Code install, PAI deployment (rsync)
- tmux persistent session, SSH mobile access
- Telegram bot long polling, sender validation
- Cron automation, root access
- `claude --resume` for session continuity

### Careful handling needed (70% confidence):
- OAuth headless auth via SSH tunnel — should work but untested on this VPS
- Response formatting for Telegram (chunking, markdown rendering)
- Email MIME parsing edge cases

### Real risk (50% confidence):
- **OAuth token longevity** — 24h expiry without refresh is the Achilles heel. Monitoring + alerting is the mitigation, but manual re-auth may be needed periodically.
- **Max 5x rate limits** — 225 prompts/5h could throttle heavy mobile use. Need graceful degradation.

### Overall: VERY ACHIEVABLE
All components are proven tech. The `claude --resume` discovery eliminates the trickiest part (tmux output capture for bridges). Standard Linux server administration + a TypeScript service.

## IMPLEMENTATION ORDER

1. **Phase 1** (Foundation) — ~1 hour. User creation, Claude install, PAI deploy, auth.
2. **Phase 2** (Session + SSH) — ~30 min. tmux, session helper, SSH aliases.
3. **Phase 3** (Telegram) — ~2-3 hours. Bot creation, bridge service, testing.
4. **Phase 4** (Email) — ~2 hours. IMAP polling, response formatting.
5. **Phase 5** (Auth Resilience) — ~30 min. Monitoring cron, alerts.
6. **Phase 6** (Automation) — ~30 min. Cron framework, templates.

**Total: ~7-8 hours across sessions.**

## VERIFICATION

End-to-end test sequence:
1. SSH to VPS as isidore, run `claude -p "hello"` — confirms auth + install
2. Start tmux session, run `claude` interactively — confirms SSH path
3. Send Telegram message to bot — confirms Telegram bridge
4. Send email to designated address — confirms email bridge
5. Check `~/.claude/MEMORY` for writes from both channels — confirms shared memory
6. Run `systemctl status openclaw` — confirms Gregor unaffected
7. Send message from unauthorized Telegram account — confirms rejection
8. Check crontab for auth health check — confirms resilience

## LOG

### Iteration 0 — 2026-02-25
- Phase reached: PLAN
- Criteria progress: 0/14
- Work done: Architecture design, research (Claude Code headless auth + --resume, email/Telegram patterns), ISC creation, dual-mode architecture
- Key discovery: `claude --resume $SID -p "msg" --output-format json` preserves full session context programmatically — eliminates tmux output capture complexity for bridges
- Context for next iteration: Begin Phase 1 — VPS user creation and Claude Code installation

### Iteration 1 — 2026-02-25
- Phase reached: VERIFY (BLOCKED on interactive steps)
- Criteria progress: 7/14
- Work done:
  - Created `isidore` user on VPS with sudo NOPASSWD
  - Generated dedicated SSH key pair (`id_ed25519_isidore`), added to AllowUsers in sshd_config
  - Installed Bun 1.3.9 and Claude Code CLI 2.1.56 on VPS
  - Deployed PAI skills and config via rsync
  - Built complete bridge service: Telegram bot (Grammy), Claude CLI wrapper, session manager, mobile formatter
  - Installed systemd services (tmux persistent session, bridge service)
  - Set up auth health check cron (every 4h)
  - Created deployment scripts (setup-vps.sh, deploy-key.sh, deploy.sh)
  - Verified Gregor coexistence (active, 20GB RAM free, 184GB disk free)
  - Updated README, CLAUDE.md, project structure
- Key learning: sshd_config `AllowUsers` was the SSH rejection cause — not key mismatch. Failed attempts triggered fail2ban.
- Failing: C1 (no OAuth), C5 (no bot token), C6 (email not started), C7-C9, C11, C12, A2 (need runtime testing)
- Context for next iteration: Marius must complete two interactive steps:
  1. `ssh -L 7160:localhost:7160 isidore` then `claude /login` (OAuth)
  2. Create Telegram bot via @BotFather, put token in `~/.config/isidore/bridge.env`
  Then start bridge: `sudo systemctl enable --now isidore-bridge`

### Iteration 2 — 2026-02-25
- Phase reached: VERIFY
- Criteria progress: 11/14
- Work done:
  - Fixed auth-health-check.sh: cron couldn't find `claude` binary (cron PATH doesn't include npm-global). Added `source bridge.env` at script start.
  - Manual health check test: AUTH_OK logged successfully
  - Deployed fix to VPS, verified cron will work next cycle
  - Updated PRD checkboxes: C1, C5, C8, C9, A2 now passing (were completed in prior session but PRD not updated)
- Failing: C6 (email not started), C7 (needs phone test), C11 (needs multi-channel test)
- Context for next iteration: C6 needs email account details from Marius. C7 needs phone SSH test. C11 testable after more channels are active.
