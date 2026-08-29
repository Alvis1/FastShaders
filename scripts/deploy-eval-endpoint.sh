#!/usr/bin/env bash
# Deploy the eval-study collection endpoint to alvismisjuns.lv.
#
#   bash scripts/deploy-eval-endpoint.sh
#
# The repo keeps `server/*.php` as CHANGE-ME TEMPLATES because it is public;
# the real secrets live in the gitignored `.vscode/eval-endpoint.json` (same
# pattern as `.vscode/sftp.json`, which supplies the SSH credentials). This
# script renders the templates with those secrets into a temp dir and uploads
# the rendered copies — so no password is ever written into a tracked file.
#
# Re-run it after editing either template or rotating a secret.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SFTP_CONF="$ROOT/.vscode/sftp.json"
EVAL_CONF="$ROOT/.vscode/eval-endpoint.json"
[ -f "$SFTP_CONF" ] || { echo "missing $SFTP_CONF (SSH credentials)"; exit 1; }
[ -f "$EVAL_CONF" ] || { echo "missing $EVAL_CONF (endpoint secrets)"; exit 1; }
command -v psftp >/dev/null || { echo "psftp not found — brew install putty"; exit 1; }

read -r REMOTE_DIR UPLOAD_KEY VIEW_USER VIEW_PW INBOX_DIR <<< "$(node -e '
  const c = require(process.argv[1]);
  console.log(c.remoteDir, c.uploadKey, c.viewUser, c.viewPassword, c.inboxDir);
' "$EVAL_CONF")"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# Render the templates with the real secrets (see render-eval-endpoint.mjs).
node "$ROOT/scripts/render-eval-endpoint.mjs" "$ROOT/server" "$STAGE" "$EVAL_CONF"

read -r HOST USER KEY <<< "$(node -e '
  const c = require(process.argv[1]);
  console.log(c.host, c.username, c.privateKeyPath);
' "$SFTP_CONF")"
export DEPLOY_PP="$(node -e 'console.log(require(process.argv[1]).passphrase ?? "")' "$SFTP_CONF")"

BATCH="$STAGE/batch.txt"
{
  echo "mkdir $REMOTE_DIR"
  echo "cd $REMOTE_DIR"
  echo "put $STAGE/upload.php upload.php"
  echo "put $STAGE/list.php list.php"
  echo "quit"
} > "$BATCH"

echo "==> uploading endpoint to $USER@$HOST:$REMOTE_DIR"
export DEPLOY_KEY="$KEY" DEPLOY_BATCH="$BATCH" DEPLOY_TARGET="$USER@$HOST"
expect <<'EOF' | grep -v "Passphrase for key"
set timeout 300
# -be: continue past errors. `mkdir` fails harmlessly once the directory
# exists, and psftp's default batch mode would abort the whole upload on it.
# The HTTP verification below is the real gate.
spawn psftp -be -i $env(DEPLOY_KEY) -b $env(DEPLOY_BATCH) $env(DEPLOY_TARGET)
expect {
  -re "store key in cache.*"    { send "y\r"; exp_continue }
  -re "Passphrase for key.*:"   { send "$env(DEPLOY_PP)\r"; exp_continue }
  eof
}
EOF

echo "==> verifying"
BASE="https://alvismisjuns.lv/$(basename "$REMOTE_DIR")"
UP_CODE="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/upload.php")"                    # GET → 405
LS_CODE="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/list.php")"                      # anon → 401
LS_AUTH="$(curl -s -o /dev/null -w '%{http_code}' -u "$VIEW_USER:$VIEW_PW" "$BASE/list.php")"
echo "  upload.php (GET, expect 405): $UP_CODE"
echo "  list.php   (anon, expect 401): $LS_CODE"
echo "  list.php   (auth, expect 200): $LS_AUTH"
[ "$UP_CODE" = "405" ] && [ "$LS_CODE" = "401" ] && [ "$LS_AUTH" = "200" ] \
  && echo "endpoint live ✓  →  $BASE/list.php" \
  || { echo "UNEXPECTED — check the output above" >&2; exit 1; }
