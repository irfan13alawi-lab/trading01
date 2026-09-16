#!/bin/sh
set -u

HEALTH_URL="${NEXORA_HEALTH_URL:-http://127.0.0.1:18085/healthz}"
STATUS_URL="${NEXORA_STATUS_URL:-http://127.0.0.1:18085/paper/status}"
STATE_FILE="${NEXORA_WATCHDOG_STATE:-/home/ubuntu/nexora-proxy/.nexora-watchdog-state}"
INTERVAL="${NEXORA_WATCHDOG_INTERVAL:-60}"
MAX_SCAN_AGE_SEC="${NEXORA_MAX_SCAN_AGE_SEC:-1800}"
NODE_BIN="${NEXORA_NODE_BIN:-/home/ubuntu/.local/bin/node}"
TELEGRAM_TOKEN="${TELEGRAM_BOT_TOKEN:-${TELEGRAM_TOKEN:-}}"

send_alert() {
  [ -n "$TELEGRAM_TOKEN" ] || return 0
  [ -n "${TELEGRAM_CHAT_ID:-}" ] || return 0
  /usr/bin/curl -fsS --max-time 10 -X POST \
    "https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage" \
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
  status_check=""
  if [ -n "$health_payload" ] && [ -n "$status_payload" ] && [ -x "$NODE_BIN" ]; then
    status_check=$(printf '%s\n%s' "$health_payload" "$status_payload" | \
      NEXORA_MAX_SCAN_AGE_SEC="$MAX_SCAN_AGE_SEC" "$NODE_BIN" -e '
        let input="";
        process.stdin.on("data", chunk => input += chunk);
        process.stdin.on("end", () => {
          try {
            const parts = input.split(/\n(?=\{)/);
            const health = JSON.parse(parts[0]);
            const status = JSON.parse(parts.slice(1).join("\n"));
            const now = Date.now();
            const lastScan = Date.parse(status.lastScanAt || "");
            const lastError = String(status.lastError || (status.runtime && status.runtime.lastScanError) || "").trim();
            const sources = health.sources || {};
            const liveMarket = ["bitget", "binance", "okx"].some(name =>
              sources[name] && (sources[name].displayStatus === "LIVE" || sources[name].status === "LIVE"));
            const scanStale = !Number.isFinite(lastScan) ||
              now - lastScan > Number(process.env.NEXORA_MAX_SCAN_AGE_SEC || 1800) * 1000;
            const reasons = [];
            if (status.enabled !== true || status.running !== true) reasons.push("bot not running");
            if (lastError) reasons.push("lastError: " + lastError);
            if (!liveMarket) reasons.push("market source unavailable");
            if (scanStale) reasons.push("last scan stale");
            console.log(reasons.length ? "down|" + reasons.join("; ") : "up|healthy");
          } catch (error) {
            console.log("down|invalid status JSON");
          }
        });
      ' 2>/dev/null || true)
  fi
  if [ "$status_check" = up\|healthy ]; then
    current_state="up"
    if [ "$last_state" = "down" ]; then
      send_alert "NEXORA WATCHDOG\nPaper Bot VPS kembali ONLINE."
    fi
  else
    current_state="down"
    if [ "$last_state" != "down" ]; then
      detail="${status_check#down|}"
      [ -n "$detail" ] || detail="health/status endpoint tidak bisa dibaca"
      send_alert "NEXORA WATCHDOG\nPaper Bot VPS bermasalah: ${detail}"
    fi
  fi
  printf '%s\n' "$current_state" > "$STATE_FILE" 2>/dev/null || true
  last_state="$current_state"
  sleep "$INTERVAL"
done
