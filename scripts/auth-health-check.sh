#!/bin/bash
# auth-health-check.sh — Check Claude Code OAuth token validity
# Run via cron every 4 hours. Alerts via Telegram bot on failure.
# Usage: crontab: 0 */4 * * * /home/isidore/my-pai-cloud-solution/scripts/auth-health-check.sh

set -euo pipefail

CLAUDE_BIN="${CLAUDE_BINARY:-claude}"
TELEGRAM_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
TELEGRAM_CHAT_ID="${TELEGRAM_ALLOWED_USER_ID:-}"
LOG_FILE="/home/isidore/.claude/auth-health.log"

timestamp() {
    date -u "+%Y-%m-%dT%H:%M:%SZ"
}

log() {
    echo "$(timestamp) $1" >> "$LOG_FILE"
}

alert_telegram() {
    if [ -n "$TELEGRAM_TOKEN" ] && [ -n "$TELEGRAM_CHAT_ID" ]; then
        curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage" \
            -d "chat_id=${TELEGRAM_CHAT_ID}" \
            -d "text=$1" \
            -d "parse_mode=Markdown" > /dev/null 2>&1 || true
    fi
}

# Test Claude auth with a minimal invocation
RESULT=$($CLAUDE_BIN -p "health check: respond with just OK" --max-turns 1 --output-format json 2>&1) || true

if echo "$RESULT" | grep -q '"result"'; then
    log "AUTH_OK"
else
    ERROR_MSG=$(echo "$RESULT" | head -3)
    log "AUTH_FAIL: $ERROR_MSG"

    alert_telegram "$(cat <<'MSG'
*Isidore Auth Alert*

OAuth token may be expired. Claude health check failed.

Re-auth steps:
1. `ssh -L 7160:localhost:7160 isidore`
2. `claude /login`
3. Complete OAuth in browser

Error: Check `/home/isidore/.claude/auth-health.log`
MSG
)"

    exit 1
fi
