param(
  [string]$VpsHost = $env:NEXORA_VPS_HOST,
  [string]$VpsUser = $env:NEXORA_VPS_USER,
  [string]$KeyPath = $env:NEXORA_SSH_KEY_PATH,
  [string]$ProxyDir = $env:NEXORA_VPS_PROXY_DIR,
  [string]$WebRoot = $env:NEXORA_VPS_WEB_ROOT,
  [string]$NodeBin = $env:NEXORA_VPS_NODE_BIN,
  [string]$StateFile = $env:NEXORA_VPS_STATE_FILE,
  [int]$ApiPort = 18085
)

$ErrorActionPreference = 'Stop'
foreach ($required in @{
  NEXORA_VPS_HOST = $VpsHost
  NEXORA_VPS_USER = $VpsUser
  NEXORA_SSH_KEY_PATH = $KeyPath
  NEXORA_VPS_PROXY_DIR = $ProxyDir
  NEXORA_VPS_WEB_ROOT = $WebRoot
  NEXORA_VPS_NODE_BIN = $NodeBin
}.GetEnumerator()) {
  if ([string]::IsNullOrWhiteSpace($required.Value)) {
    throw "Set $($required.Key) in your private local environment before deployment."
  }
}
if ($VpsHost -notmatch '^[A-Za-z0-9.-]+$' -or $VpsUser -notmatch '^[A-Za-z_][A-Za-z0-9._-]*$') {
  throw 'VPS host or user contains unsupported characters.'
}
foreach ($remotePath in @($ProxyDir, $WebRoot, $NodeBin)) {
  if ($remotePath -notmatch '^/[A-Za-z0-9._/-]+$') {
    throw 'Remote paths must be absolute POSIX paths without shell-special characters.'
  }
}
if ([string]::IsNullOrWhiteSpace($StateFile)) { $StateFile = $ProxyDir.TrimEnd('/') + '/paper-bot-state.json' }
if ($StateFile -notmatch '^/[A-Za-z0-9._/-]+$') { throw 'StateFile must be an absolute POSIX path.' }
if ($ApiPort -lt 1 -or $ApiPort -gt 65535) { throw 'ApiPort must be between 1 and 65535.' }
$rawBase = 'https://raw.githubusercontent.com/irfan13alawi-lab/trading01/main'
$remoteScript = @'
set -eu
PROXY_DIR='@@PROXY_DIR@@'
WEB_ROOT='@@WEB_ROOT@@'
NODE_BIN='@@NODE_BIN@@'
STATE_FILE='@@STATE_FILE@@'
API_PORT='@@API_PORT@@'
tmpdir="$(mktemp -d "$PROXY_DIR/.nexora-deploy.XXXXXX")"
cleanup() { rm -rf "$tmpdir"; }
trap cleanup EXIT

curl -fsSL --retry 3 --max-time 60 "$RAW_BASE/server.js" -o "$tmpdir/server.js"
curl -fsSL --retry 3 --max-time 60 "$RAW_BASE/prebreakout-scanner.cjs" -o "$tmpdir/prebreakout-scanner.cjs"
curl -fsSL --retry 3 --max-time 60 "$RAW_BASE/Nexora_V4_Clean.html" -o "$tmpdir/index.html"
test -s "$tmpdir/server.js"
test -s "$tmpdir/prebreakout-scanner.cjs"
test -s "$tmpdir/index.html"
if [ ! -x "$NODE_BIN" ]; then
  printf 'node runtime not found\n' >&2
  exit 127
fi
"$NODE_BIN" --check "$tmpdir/server.js"
"$NODE_BIN" --check "$tmpdir/prebreakout-scanner.cjs"
grep -Fq "PAPER VPS CHECKING..." "$tmpdir/index.html"
grep -Fq "risk size uses each ledger current equity" "$tmpdir/index.html"
grep -Fq "PREBREAKOUT_RESEARCH_V1" "$tmpdir/server.js"
grep -Fq "FIB_SWING_PULLBACK_V1" "$tmpdir/server.js"
grep -Fq "MONITORING_ONLY" "$tmpdir/server.js"
grep -Fq "RESEARCH_COLLECTION" "$tmpdir/server.js"
grep -Fq "PAPER_RESEARCH_HARD_DD_PCT = 50" "$tmpdir/server.js"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
if [ -f "$PROXY_DIR/server.js" ]; then
  cp -a "$PROXY_DIR/server.js" "$PROXY_DIR/server.js.pre-$stamp"
fi
if [ -f "$PROXY_DIR/prebreakout-scanner.cjs" ]; then
  cp -a "$PROXY_DIR/prebreakout-scanner.cjs" "$PROXY_DIR/prebreakout-scanner.cjs.pre-$stamp"
fi
if [ -f "$STATE_FILE" ]; then
  cp -a "$STATE_FILE" "$STATE_FILE.pre-$stamp"
fi
if [ -f "$WEB_ROOT/index.html" ]; then
  sudo cp -a "$WEB_ROOT/index.html" "$WEB_ROOT/index.html.pre-$stamp"
fi

install -m 0644 "$tmpdir/server.js" "$tmpdir/server.js.ready"
install -m 0644 "$tmpdir/prebreakout-scanner.cjs" "$tmpdir/prebreakout-scanner.cjs.ready"
mv -f "$tmpdir/server.js.ready" "$PROXY_DIR/server.js"
mv -f "$tmpdir/prebreakout-scanner.cjs.ready" "$PROXY_DIR/prebreakout-scanner.cjs"
sudo install -m 0644 "$tmpdir/index.html" "$WEB_ROOT/.nexora-index-$stamp"
sudo mv -f "$WEB_ROOT/.nexora-index-$stamp" "$WEB_ROOT/index.html"
sudo systemctl restart nexora-proxy
ready=0
for attempt in $(seq 1 45); do
  if curl -fsS --connect-timeout 2 --max-time 3 "http://127.0.0.1:$API_PORT/healthz" >"$tmpdir/health.json" 2>/dev/null &&
     curl -fsS --connect-timeout 2 --max-time 3 "http://127.0.0.1:$API_PORT/paper/summary" >"$tmpdir/summary.json" 2>/dev/null &&
     grep -Fq '"ok":true' "$tmpdir/health.json" &&
     grep -Fq '"ok":true' "$tmpdir/summary.json" &&
     grep -Fq '"buildId":"v5.5.1-fibonacci-shadow-secure-2026-10-03"' "$tmpdir/summary.json" &&
     grep -Fq '"strategyId":"FIB_SWING_PULLBACK_V1"' "$tmpdir/summary.json"; then
    ready=1
    break
  fi
  sleep 2
done
if [ "$ready" -ne 1 ]; then
  printf 'VPS service did not pass health and Strategy Lab checks within 90 seconds. Existing state backup was preserved.\n' >&2
  exit 1
fi
printf 'DEPLOY_OK\n'
'@

$remoteScript = $remoteScript.Replace('$RAW_BASE', $rawBase)
$remoteScript = $remoteScript.Replace('@@PROXY_DIR@@', $ProxyDir)
$remoteScript = $remoteScript.Replace('@@WEB_ROOT@@', $WebRoot)
$remoteScript = $remoteScript.Replace('@@NODE_BIN@@', $NodeBin)
$remoteScript = $remoteScript.Replace('@@STATE_FILE@@', $StateFile)
$remoteScript = $remoteScript.Replace('@@API_PORT@@', [string]$ApiPort)
$remoteScript = $remoteScript -replace "`r`n", "`n"
$remoteScript = $remoteScript.Replace("`r", '')
if (-not (Test-Path -LiteralPath $KeyPath)) {
  throw "SSH key not found: $KeyPath"
}

Write-Host 'Deploying Nexora build to the configured VPS...'
$remoteScript | & ssh.exe -i $KeyPath -o BatchMode=yes -o StrictHostKeyChecking=accept-new "$VpsUser@$VpsHost" 'bash -s'
if ($LASTEXITCODE -ne 0) {
  throw "VPS deployment failed with exit code $LASTEXITCODE"
}
