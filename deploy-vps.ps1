param(
  [string]$VpsHost = '43.156.52.203',
  [string]$VpsUser = 'ubuntu',
  [string]$KeyPath = "$env:USERPROFILE\.ssh\nexora-personal-deploy"
)

$ErrorActionPreference = 'Stop'
$rawBase = 'https://raw.githubusercontent.com/irfan13alawi-lab/trading01/main'
$remoteScript = @'
set -eu
tmpdir="$(mktemp -d /tmp/nexora-deploy.XXXXXX)"
cleanup() { rm -rf "$tmpdir"; }
trap cleanup EXIT

curl -fsSL --retry 3 --max-time 60 "$RAW_BASE/server.js" -o "$tmpdir/server.js"
curl -fsSL --retry 3 --max-time 60 "$RAW_BASE/Nexora_V4_Clean.html" -o "$tmpdir/index.html"
test -s "$tmpdir/server.js"
test -s "$tmpdir/index.html"
node_bin="$(command -v node || true)"
if [ -z "$node_bin" ] && [ -x /home/ubuntu/.local/bin/node ]; then
  node_bin=/home/ubuntu/.local/bin/node
fi
if [ -z "$node_bin" ]; then
  printf 'node runtime not found\n' >&2
  exit 127
fi
"$node_bin" --check "$tmpdir/server.js"
grep -Fq "PAPER VPS CHECKING..." "$tmpdir/index.html"
grep -Fq "build v4.8-p0p2" "$tmpdir/index.html"
grep -Fq "MONITORING_ONLY" "$tmpdir/server.js"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
if [ -f /home/ubuntu/nexora-proxy/server.js ]; then
  cp -a /home/ubuntu/nexora-proxy/server.js "/home/ubuntu/nexora-proxy/server.js.pre-$stamp"
fi
if [ -f /var/www/html/nexora/index.html ]; then
  sudo cp -a /var/www/html/nexora/index.html "/var/www/html/nexora/index.html.pre-$stamp"
fi

install -o ubuntu -g ubuntu -m 0644 "$tmpdir/server.js" /home/ubuntu/nexora-proxy/server.js
sudo install -o root -g root -m 0644 "$tmpdir/index.html" /var/www/html/nexora/index.html
sudo systemctl restart nexora-proxy
sleep 3
curl -fsS --max-time 15 http://127.0.0.1:18085/healthz >/tmp/nexora-health.json
curl -fsS --max-time 15 http://127.0.0.1:18085/paper/summary >/tmp/nexora-summary.json
grep -Fq '"ok":true' /tmp/nexora-health.json
grep -Fq '"ok":true' /tmp/nexora-summary.json
printf 'DEPLOY_OK\n'
cat /tmp/nexora-health.json
cat /tmp/nexora-summary.json
'@

$remoteScript = $remoteScript.Replace('$RAW_BASE', $rawBase)
if (-not (Test-Path -LiteralPath $KeyPath)) {
  throw "SSH key not found: $KeyPath"
}

Write-Host "Deploying Nexora from $rawBase to $VpsUser@$VpsHost..."
$remoteScript | & ssh.exe -i $KeyPath -o BatchMode=yes -o StrictHostKeyChecking=accept-new "$VpsUser@$VpsHost" 'bash -s'
if ($LASTEXITCODE -ne 0) {
  throw "VPS deployment failed with exit code $LASTEXITCODE"
}
