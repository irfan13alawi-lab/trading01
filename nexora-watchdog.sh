#!/bin/sh
set -u

HEALTH_URL="${NEXORA_HEALTH_URL:-http://127.0.0.1:18085/healthz}"
STATUS_URL="${NEXORA_STATUS_URL:-http://127.0.0.1:18085/paper/status}"
STATE_FILE="${NEXORA_WATCHDOG_STATE:-/home/ubuntu/nexora-proxy/.nexora-watchdog-state}"
INTERVAL="${NEXORA_WATCHDOG_INTERVAL:-60}"

send_alert() {
  [ -n "${TELEGRAM_BOT_TOKEN:-}" ] || return 0
  [ -n "${TELEGRAM_CHAT_ID:-}" ] || return 0
  /usr/bin/curl -fsS --max-time 10 -X POST \
    "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
    --data-urlencode "text=$1" >/dev/null 2>&1 || true
}

last_state="unknown"
if [ -f "$STATE_FILE" ]; then
  last_state=$(sed -n '1p' "$STATE_FILE" 2>/dev/null || printf 'unknown')
fi

while :; do
  health_payload=$(/usr/bin/curl -fsS --max-time 10 "$HEALTH_URL" 2>/dev/null || true)
  status_payload=$(/usr/bin/curl -fsS --max-time 10 "$STATUS_URL" 2>/dev/null || true)
  if [ -n "$health_payload" ] && [ -n "$status_payload" ] && printf '%s' "$status_payload" | /bin/grep -q '"running":true'; then
    current_state="up"
    if [ "$last_state" = "down" ]; then
      send_alert "NEXORA WATCHDOG\nPaper Bot VPS kembali ONLINE."
    fi
  else
    current_state="down"
    if [ "$last_state" != "down" ]; then
      send_alert "NEXORA WATCHDOG\nPaper Bot VPS OFFLINE atau service berhenti. Cek systemd/journalctl."
    fi
  fi
  printf '%s\n' "$current_state" > "$STATE_FILE" 2>/dev/null || true
  last_state="$current_state"
  sleep "$INTERVAL"
done
