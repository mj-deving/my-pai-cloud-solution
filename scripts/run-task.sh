#!/bin/bash
# run-task.sh — Run a one-shot Claude task (for cron automation)
# Usage: run-task.sh "morning briefing" [--notify]
# Uses one-shot mode (separate session, no resume)

set -euo pipefail

CLAUDE_BIN="${CLAUDE_BINARY:-claude}"
TASK="${1:?Usage: run-task.sh \"task description\" [--notify]}"
NOTIFY="${2:-}"
LOG_DIR="/home/isidore_cloud/.claude/cron-logs"

mkdir -p "$LOG_DIR"

TIMESTAMP=$(date -u "+%Y%m%d-%H%M%S")
LOG_FILE="$LOG_DIR/${TIMESTAMP}_$(echo "$TASK" | tr ' ' '-' | head -c 30).log"

echo "$(date -u) Running task: $TASK" > "$LOG_FILE"

RESULT=$($CLAUDE_BIN -p "$TASK" --max-turns 3 --output-format json 2>&1) || true
echo "$RESULT" >> "$LOG_FILE"

# Optional: send result via Telegram
if [ "$NOTIFY" = "--notify" ]; then
    TELEGRAM_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
    TELEGRAM_CHAT_ID="${TELEGRAM_ALLOWED_USER_ID:-}"

    if [ -n "$TELEGRAM_TOKEN" ] && [ -n "$TELEGRAM_CHAT_ID" ]; then
        # Extract result text, truncate for Telegram
        MSG=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('result','No result')[:3000])" 2>/dev/null || echo "Task completed. Check logs.")

        curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage" \
            -d "chat_id=${TELEGRAM_CHAT_ID}" \
            -d "text=Cron task: $TASK%0A%0A$MSG" > /dev/null 2>&1 || true
    fi
fi

echo "$(date -u) Task complete" >> "$LOG_FILE"
