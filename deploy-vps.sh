#!/bin/bash
set -euo pipefail

BASE_URL="https://raw.githubusercontent.com/irfan13alawi-lab/trading01/main"
CACHE_BUST="$(date +%s)"
SERVICE_NAME="${NEXORA_SERVICE_NAME:-nexora-proxy}"
PROXY_DIR="${NEXORA_PROXY_DIR:-$(systemctl show "$SERVICE_NAME" --property=WorkingDirectory --value)}"
WEB_ROOT="${NEXORA_WEB_ROOT:?Set NEXORA_WEB_ROOT to the configured dashboard document root}"
NODE_BIN="${NEXORA_NODE_BIN:-$HOME/.local/bin/node}"
API_PORT="${NEXORA_API_PORT:-${PORT:-18085}}"
STATE_FILE="${NEXORA_STATE_FILE:-${PAPER_STATE_FILE:-$PROXY_DIR/paper-bot-state.json}}"
SERVICE_UNIT_PATH="$(systemctl show "$SERVICE_NAME" --property=FragmentPath --value)"
if [ -z "$SERVICE_UNIT_PATH" ] && [ -z "${NEXORA_SYSTEMD_DIR:-}" ]; then
  printf 'Could not locate the proxy systemd unit. Set NEXORA_SYSTEMD_DIR.\n' >&2
  exit 1
fi
SYSTEMD_DIR="${NEXORA_SYSTEMD_DIR:-$(dirname "$SERVICE_UNIT_PATH")}"
if [ -z "$PROXY_DIR" ] || [ ! -d "$PROXY_DIR" ]; then
  printf 'Could not locate the proxy service working directory. Set NEXORA_PROXY_DIR.\n' >&2
  exit 1
fi
if [ ! -x "$NODE_BIN" ]; then
  printf 'Set NEXORA_NODE_BIN to the installed Node.js executable.\n' >&2
  exit 1
fi
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

download() {
  curl -fL --retry 3 --connect-timeout 10 --max-time 60 \
    -H 'Cache-Control: no-cache' "$BASE_URL/$1?cb=$CACHE_BUST" -o "$TMP_DIR/$1"
}

download server.js
download prebreakout-scanner.cjs
download package.json
download Nexora_V4_Clean.html
download nexora-mobile.html
download nexora-proxy.service
download nexora-watchdog.sh
download nexora-watchdog.service

cd "$PROXY_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
for file in server.js prebreakout-scanner.cjs package.json; do
  if [ -f "$PROXY_DIR/$file" ]; then cp -a "$PROXY_DIR/$file" "$PROXY_DIR/$file.pre-$STAMP"; fi
done
if [ -f "$STATE_FILE" ]; then cp -a "$STATE_FILE" "$STATE_FILE.pre-$STAMP"; fi
if [ -f "$WEB_ROOT/index.html" ]; then
  sudo cp -a "$WEB_ROOT/index.html" "$WEB_ROOT/index.html.pre-$STAMP"
fi
install -m 0644 "$TMP_DIR/server.js" "$PROXY_DIR/.server.js.new-$STAMP"
install -m 0644 "$TMP_DIR/prebreakout-scanner.cjs" "$PROXY_DIR/.prebreakout-scanner.cjs.new-$STAMP"
install -m 0644 "$TMP_DIR/package.json" "$PROXY_DIR/.package.json.new-$STAMP"
mv -f "$PROXY_DIR/.server.js.new-$STAMP" "$PROXY_DIR/server.js"
mv -f "$PROXY_DIR/.prebreakout-scanner.cjs.new-$STAMP" "$PROXY_DIR/prebreakout-scanner.cjs"
mv -f "$PROXY_DIR/.package.json.new-$STAMP" "$PROXY_DIR/package.json"
npm install --omit=dev

sudo install -m 0644 "$TMP_DIR/Nexora_V4_Clean.html" "$WEB_ROOT/.nexora-index-$STAMP"
sudo mv -f "$WEB_ROOT/.nexora-index-$STAMP" "$WEB_ROOT/index.html"
sudo install -m 0644 "$TMP_DIR/nexora-mobile.html" "$WEB_ROOT/.nexora-mobile-$STAMP"
sudo mv -f "$WEB_ROOT/.nexora-mobile-$STAMP" "$WEB_ROOT/mobile.html"
sudo install -m 0644 "$TMP_DIR/nexora-proxy.service" "$SYSTEMD_DIR/nexora-proxy.service"
sudo install -m 0755 "$TMP_DIR/nexora-watchdog.sh" "$PROXY_DIR/nexora-watchdog.sh"
sudo install -m 0644 "$TMP_DIR/nexora-watchdog.service" "$SYSTEMD_DIR/nexora-watchdog.service"

"$NODE_BIN" --check "$PROXY_DIR/server.js"
"$NODE_BIN" --check "$PROXY_DIR/prebreakout-scanner.cjs"
sudo systemctl daemon-reload
sudo systemctl enable nexora-proxy nexora-watchdog
sudo systemctl restart nexora-proxy
sudo systemctl restart nexora-watchdog

READY=0
for attempt in $(seq 1 45); do
  if curl -fsS --connect-timeout 2 --max-time 3 "http://127.0.0.1:$API_PORT/healthz" >"$TMP_DIR/health.json" 2>/dev/null && \
     curl -fsS --connect-timeout 2 --max-time 3 "http://127.0.0.1:$API_PORT/paper/summary" >"$TMP_DIR/summary.json" 2>/dev/null && \
     grep -Fq '"ok":true' "$TMP_DIR/health.json" && \
     grep -Fq '"ok":true' "$TMP_DIR/summary.json"; then
    READY=1
    break
  fi
  sleep 2
done
if [ "$READY" -ne 1 ]; then
  printf 'Nexora proxy did not pass health checks within 90 seconds; previous state backup is preserved.\n' >&2
  exit 1
fi
printf '%s\n' '--- HEALTH ---'
curl -fsS "http://127.0.0.1:$API_PORT/healthz"
printf '\n%s\n' '--- PAPER SUMMARY ---'
curl -fsS "http://127.0.0.1:$API_PORT/paper/summary"
printf '\n%s\n' '--- SERVICES ---'
systemctl is-active nexora-proxy
systemctl is-active nexora-watchdog
