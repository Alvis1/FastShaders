#!/usr/bin/env bash
# Deploy FastShaders to https://alvismisjuns.lv/fastshaders/
#
#   npm run deploy:alvismisjuns          # build + upload
#   npm run deploy:alvismisjuns -- --no-build   # upload the existing dist-alvismisjuns/
#
# Credentials come from .vscode/sftp.json (gitignored — the VS Code SFTP
# extension config): host, username, privateKeyPath (PuTTY .ppk), passphrase,
# remotePath. Upload uses psftp, which reads .ppk natively — no key
# conversion, nothing credential-shaped is ever written to disk; the
# passphrase travels via an environment variable into expect.
#
# Requires: brew install putty   (psftp)  — expect ships with macOS.
#
# NB: psftp has no --delete; superseded content-hashed assets accumulate on
# the server over time. Harmless (index.html always points at the current
# ones), but prune /var/www/alvis/src/fastshaders/assets/ manually once in a
# while if the size bothers you.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONF="$ROOT/.vscode/sftp.json"
DIST="$ROOT/dist-alvismisjuns"

[ -f "$CONF" ] || { echo "missing $CONF (SFTP credentials)"; exit 1; }
command -v psftp >/dev/null || { echo "psftp not found — brew install putty"; exit 1; }

read -r HOST USER KEY REMOTE <<< "$(node -e '
  const c = require(process.argv[1]);
  console.log(c.host, c.username, c.privateKeyPath, c.remotePath);
' "$CONF")"
export DEPLOY_PP="$(node -e 'console.log(require(process.argv[1]).passphrase ?? "")' "$CONF")"

if [ "${1:-}" != "--no-build" ]; then
  echo "==> building (base /fastshaders/, CSP for alvismisjuns.lv)"
  cd "$ROOT"
  FS_BASE=/fastshaders/ \
  FS_PREVIEW_ORIGIN='https://alvismisjuns.lv https://www.alvismisjuns.lv' \
    npm run build
  rm -rf "$DIST"
  cp -R "$ROOT/dist" "$DIST"
fi
[ -f "$DIST/index.html" ] || { echo "missing $DIST — run without --no-build first"; exit 1; }

BATCH="$(mktemp)"
trap 'rm -f "$BATCH"' EXIT
{
  echo "cd $REMOTE"
  echo "put -r $DIST fastshaders"
  echo "quit"
} > "$BATCH"

echo "==> uploading to $USER@$HOST:$REMOTE/fastshaders"
export DEPLOY_KEY="$KEY" DEPLOY_BATCH="$BATCH" DEPLOY_TARGET="$USER@$HOST"
expect <<'EOF'
set timeout 900
spawn psftp -i $env(DEPLOY_KEY) -b $env(DEPLOY_BATCH) $env(DEPLOY_TARGET)
expect {
  -re "store key in cache.*"    { send "y\r"; exp_continue }
  -re "Passphrase for key.*:"   { send "$env(DEPLOY_PP)\r"; exp_continue }
  eof
}
EOF

echo "==> verifying"
curl -sS -o /dev/null -w 'https://alvismisjuns.lv/fastshaders/ -> HTTP %{http_code}\n' https://alvismisjuns.lv/fastshaders/
curl -sS https://alvismisjuns.lv/fastshaders/ | grep -o '<meta name="version"[^>]*>' || true
