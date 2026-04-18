#!/usr/bin/env bash
# notify.sh — minimal Telegram Bot API push notifier
#
# Replaces bridge-owned proactive notifications for Move 2 of the bridge
# retirement plan (beads my-pai-cloud-solution-679). Intended to be invoked
# from systemd timers + cron, not from user sessions.
#
# Usage:
#   notify.sh "<text>"                       # single message to default chat
#   notify.sh --chat <chat_id> "<text>"      # override target chat
#   echo "<text>" | notify.sh -              # stdin mode
#
# Environment:
#   TELEGRAM_BOT_TOKEN   required (no default)
#   TELEGRAM_CHAT_ID     default chat when --chat not provided
#   TELEGRAM_PARSE_MODE  optional: "Markdown" | "MarkdownV2" | "HTML" (default: none)
#
# Telegram rate limits: 30 msg/sec global, 1 msg/sec per chat, 20 msg/min per group.
# This script does NOT implement backoff — callers must not loop tightly.

set -euo pipefail

# Handle --help / -h BEFORE enforcing env vars so docs are always readable.
if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  sed -n '1,30p' "$0"
  exit 0
fi

: "${TELEGRAM_BOT_TOKEN:?TELEGRAM_BOT_TOKEN must be set (e.g. source bridge.env)}"

chat_id="${TELEGRAM_CHAT_ID:-}"
parse_mode="${TELEGRAM_PARSE_MODE:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --chat)
      chat_id="$2"
      shift 2
      ;;
    --parse-mode)
      parse_mode="$2"
      shift 2
      ;;
    -h|--help)
      sed -n '1,30p' "$0"
      exit 0
      ;;
    -)
      text="$(cat)"
      shift
      ;;
    *)
      text="$1"
      shift
      ;;
  esac
done

if [[ -z "${text:-}" ]]; then
  echo "notify.sh: no message text provided" >&2
  exit 2
fi

if [[ -z "${chat_id}" ]]; then
  echo "notify.sh: TELEGRAM_CHAT_ID unset and --chat not provided" >&2
  exit 2
fi

url="https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage"
args=(-s -X POST "${url}" --data-urlencode "chat_id=${chat_id}" --data-urlencode "text=${text}")
if [[ -n "${parse_mode}" ]]; then
  args+=(--data-urlencode "parse_mode=${parse_mode}")
fi

response="$(curl "${args[@]}")"

if ! echo "${response}" | grep -q '"ok":true'; then
  echo "notify.sh: Telegram API error: ${response}" >&2
  exit 1
fi
