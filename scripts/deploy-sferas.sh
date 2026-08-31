#!/usr/bin/env bash
# Deploy FastShaders to https://fs.sferas.lv/  (the study host).
#
#   npm run deploy:sferas
#   npm run deploy:sferas -- --no-build     # re-upload the existing snapshot
#
# Same shape as deploy-alvismisjuns.sh, three differences:
#   • base is `/` — that host serves the app at its ROOT, not under a subpath;
#   • FS_PREVIEW_ORIGIN names this host, so the sandboxed preview iframe (an
#     opaque origin, hence never `'self'`) may fetch the built-in models;
#   • the target is /var/www/fs/src, the docroot of the dedicated `fs`
#     container (nginx). NB `/var/www/sferas/src` is a DIFFERENT, shared
#     directory holding a dozen unrelated projects — never deploy there.
#
# Credentials come from the same gitignored .vscode/sftp.json.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONF="$ROOT/.vscode/sftp.json"
DIST="$ROOT/dist-sferas"
REMOTE="/var/www/fs/src"

[ -f "$CONF" ] || { echo "missing $CONF (SFTP credentials)"; exit 1; }
command -v psftp >/dev/null || { echo "psftp not found — brew install putty"; exit 1; }

if [ "${1:-}" != "--no-build" ]; then
  echo "==> building (base /, CSP for fs.sferas.lv)"
  cd "$ROOT"
  FS_BASE=/ \
  FS_PREVIEW_ORIGIN='https://fs.sferas.lv' \
    npm run build
  rm -rf "$DIST"
  cp -R "$ROOT/dist" "$DIST"
fi
[ -f "$DIST/index.html" ] || { echo "missing $DIST — run without --no-build first"; exit 1; }

read -r HOST USER KEY <<< "$(node -e '
  const c = require(process.argv[1]);
  console.log(c.host, c.username, c.privateKeyPath);
' "$CONF")"
export DEPLOY_PP="$(node -e 'console.log(require(process.argv[1]).passphrase ?? "")' "$CONF")"

BATCH="$(mktemp)"
trap 'rm -f "$BATCH"' EXIT
{
  # Upload the CONTENTS into the existing docroot (put -r of the directory
  # itself would nest it as src/dist-sferas/).
  echo "cd $REMOTE"
  for f in "$DIST"/*; do echo "put -r $f"; done
  echo "quit"
} > "$BATCH"

echo "==> uploading to $USER@$HOST:$REMOTE"
export DEPLOY_KEY="$KEY" DEPLOY_BATCH="$BATCH" DEPLOY_TARGET="$USER@$HOST"
expect <<'EOF' | grep -v "Passphrase for key" | tail -5
set timeout 900
spawn psftp -be -i $env(DEPLOY_KEY) -b $env(DEPLOY_BATCH) $env(DEPLOY_TARGET)
expect {
  -re "store key in cache.*"    { send "y\r"; exp_continue }
  -re "Passphrase for key.*:"   { send "$env(DEPLOY_PP)\r"; exp_continue }
  eof
}
EOF

# Hard gate, exactly as the alvismisjuns script documents: a clean psftp exit
# proves nothing about what the site actually serves.
echo "==> verifying"
EXPECTED="$(node -p "require('$ROOT/package.json').version")"
SERVED="$(curl -sS -H 'Cache-Control: no-cache' "https://fs.sferas.lv/index.html?cb=$(date +%s)" \
  | sed -n 's/.*<meta name="version" content="\([^"]*\)".*/\1/p')"
EVALP="$(curl -sS -o /dev/null -w '%{http_code}' https://fs.sferas.lv/evalp/)"
echo "  version served: ${SERVED:-none} (expected $EXPECTED)"
echo "  /evalp/       : $EVALP"
[ "$SERVED" = "$EXPECTED" ] && [ "$EVALP" = "200" ] \
  && echo "fs.sferas.lv live ✓" \
  || { echo "MISMATCH — check the output above" >&2; exit 1; }
