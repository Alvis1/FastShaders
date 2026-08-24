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

# Verification is a HARD GATE, not a print. It used to just echo the served
# version meta, which is how three releases (0.3.20-0.3.22) uploaded cleanly
# into a directory nobody serves without anyone noticing: the server was
# restructured on 2026-08-21/22 and the web root moved into `src/public/`,
# while remotePath still pointed at `src/`. Every file transferred, psftp
# exited 0, the site stayed on 0.3.19 — for a week. So: compare what the site
# actually serves against the version we just built, and FAIL on a mismatch.
# The cache-buster matters because Apache serves index.html with an ETag and
# no explicit no-cache, so a plain GET can answer from an intermediary.
echo "==> verifying"
EXPECTED="$(node -p "require('$ROOT/package.json').version")"
curl -sS -o /dev/null -w 'https://alvismisjuns.lv/fastshaders/ -> HTTP %{http_code}\n' https://alvismisjuns.lv/fastshaders/
SERVED="$(curl -sS -H 'Cache-Control: no-cache' "https://alvismisjuns.lv/fastshaders/index.html?cb=$(date +%s)" \
  | sed -n 's/.*<meta name="version" content="\([^"]*\)".*/\1/p')"
if [ "$SERVED" = "$EXPECTED" ]; then
  echo "version $SERVED live ✓"
else
  echo "DEPLOY VERIFICATION FAILED: built $EXPECTED, site serves '${SERVED:-<none>}'" >&2
  echo "The upload reported success, so the bytes most likely landed OUTSIDE the" >&2
  echo "served docroot — check remotePath in .vscode/sftp.json against the real" >&2
  echo "web root (it is the directory whose index.html mtime matches the site's" >&2
  echo "Last-Modified header). As of 2026-08-24: /var/www/alvis/src/public" >&2
  exit 1
fi
