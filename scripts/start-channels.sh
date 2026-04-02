#!/usr/bin/env bash
# Start Isidore Channels in a tmux session
# Claude Code needs an interactive TTY + --channels flag for the Telegram plugin

set -euo pipefail

SESSION="channels"
CLAUDE_BIN="${HOME}/.npm-global/bin/claude"
PROJECT_DIR="${PROJECT_DIR:-${HOME}/projects/my-pai-cloud-solution}"
CHANNEL_PLUGIN="${CHANNEL_PLUGIN:-plugin:telegram@claude-plugins-official}"
CHANNEL_NAME="${CHANNEL_NAME:-Isidore Channels}"

# Kill existing session if any
tmux has-session -t "$SESSION" 2>/dev/null && {
    echo "Killing existing channels session..."
    tmux kill-session -t "$SESSION"
}

# Create new tmux session and launch Claude with channels flag
tmux new-session -d -s "$SESSION" -x 200 -y 50
tmux send-keys -t "$SESSION" "cd $PROJECT_DIR && $CLAUDE_BIN --channels $CHANNEL_PLUGIN --name \"$CHANNEL_NAME\"" Enter

# Startup verification: wait and check for errors
sleep 8
if ! tmux has-session -t "$SESSION" 2>/dev/null; then
    echo "ERROR: tmux session died immediately" >&2
    exit 1
fi

if tmux capture-pane -t "$SESSION" -p | grep -qi "error.*input\|fatal\|TELEGRAM_BOT_TOKEN required"; then
    echo "ERROR: Channels may have failed to start. Check: tmux attach -t $SESSION" >&2
    exit 1
fi

echo "Channels session started in tmux session: $SESSION"
echo "Attach with: tmux attach -t $SESSION"
