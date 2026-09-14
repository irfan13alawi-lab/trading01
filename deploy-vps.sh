#!/bin/bash
set -euo pipefail

# SSH/systemd shells may not load the interactive Node environment. Keep the
# deploy script usable from both an interactive shell and a non-interactive SSH
# command, where npm/node otherwise appear to be missing.
export PATH="/home/ubuntu/.local/bin:/home/ubuntu/.hermes/node/bin:${PATH:-/usr/local/bin:/usr/bin:/bin}"

BASE_URL="https://raw.githubusercontent.com/irfan13alawi-lab/trading01/main"
CACHE_BUST="$(date +%s)"
PROXY_DIR="/home/ubuntu/nexora-proxy"
TMP_DIR="$(mktemp -d /tmp/nexora-deploy.XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT

download() {
  curl -fL --retry 3 --connect-timeout 10 --max-time 60 \
    -H 'Cache-Control: no-cache' "$BASE_URL/$1?cb=$CACHE_BUST" -o "$TMP_DIR/$1"
}

download server.js
download package.json
download Nexora_V4_Clean.html
download nexora-mobile.html
download nexora-proxy.service
download nexora-watchdog.sh
download nexora-watchdog.service
download nexora-journald.conf

cd "$PROXY_DIR"
install -m 0644 "$TMP_DIR/server.js" server.js
install -m 0644 "$TMP_DIR/package.json" package.json
npm install --omit=dev

sudo install -m 0644 "$TMP_DIR/Nexora_V4_Clean.html" /var/www/html/nexora/index.html
sudo install -m 0644 "$TMP_DIR/nexora-mobile.html" /var/www/html/nexora/mobile.html
sudo install -m 0644 "$TMP_DIR/nexora-proxy.service" /etc/systemd/system/nexora-proxy.service
sudo install -m 0755 "$TMP_DIR/nexora-watchdog.sh" "$PROXY_DIR/nexora-watchdog.sh"
sudo install -m 0644 "$TMP_DIR/nexora-watchdog.service" /etc/systemd/system/nexora-watchdog.service
sudo install -d -m 0755 /etc/systemd/journald.conf.d
sudo install -m 0644 "$TMP_DIR/nexora-journald.conf" /etc/systemd/journald.conf.d/nexora.conf

node --check "$PROXY_DIR/server.js"
sudo systemctl daemon-reload
sudo systemctl restart systemd-journald
sudo journalctl --vacuum-size=300M
sudo systemctl enable nexora-proxy nexora-watchdog
sudo systemctl restart nexora-proxy
sudo systemctl restart nexora-watchdog

sleep 5
printf '%s\n' '--- HEALTH ---'
curl -fsS http://127.0.0.1:18085/healthz
printf '\n%s\n' '--- PAPER STATUS ---'
curl -fsS http://127.0.0.1:18085/paper/status
printf '\n%s\n' '--- SERVICES ---'
systemctl is-active nexora-proxy
systemctl is-active nexora-watchdog
