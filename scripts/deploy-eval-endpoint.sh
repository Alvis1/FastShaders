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

# The headers the upload sends, as the template allows them — read BEFORE the
# upload, so a template line this cannot parse stops here instead of leaving a
# new endpoint live and unverified. The verification below asks for exactly
# these.
REQ_HEADERS="$(sed -n "s/.*header('Access-Control-Allow-Headers: \([^']*\)').*/\1/p" "$ROOT/server/fastshaders-eval-upload.php" \
  | head -1 | tr 'A-Z' 'a-z' | tr -d ' ')"
[ -n "$REQ_HEADERS" ] || { echo "cannot read Access-Control-Allow-Headers from the template" >&2; exit 1; }

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
# The study host's CORS preflight (fs.sferas.lv posts here cross-origin — see
# $ALLOWED_ORIGINS in the template), judged the way a browser judges it: a 2xx
# status, that exact origin back, and every header the upload sends allowed —
# asked for as the template lists them. A foreign origin must get no origin.
preflight() {
  curl -s -o /dev/null -D - -X OPTIONS "$BASE/upload.php" -H "Origin: $1" \
    -H 'Access-Control-Request-Method: POST' \
    -H "Access-Control-Request-Headers: $REQ_HEADERS" \
    | tr -d '\r' || true
}
header_of() { awk -v h="$1" 'tolower($0) ~ "^" h ":" { sub(/^[^:]*: */, ""); print tolower($0) }'; }
PF_STUDY="$(preflight https://fs.sferas.lv)"
STUDY_STATUS="$(printf '%s\n' "$PF_STUDY" | awk 'NR == 1 { print $2 }')"
CORS_STUDY="$(printf '%s\n' "$PF_STUDY" | header_of access-control-allow-origin)"
STUDY_HEADERS="$(printf '%s\n' "$PF_STUDY" | header_of access-control-allow-headers | tr -d ' ')"
CORS_OTHER="$(preflight https://example.com | header_of access-control-allow-origin)"
MISSING=""
for h in $(printf '%s' "$REQ_HEADERS" | tr ',' ' '); do
  case ",$STUDY_HEADERS," in *",$h,"*|*",*,"*) ;; *) MISSING="$MISSING $h" ;; esac
done
case "$STUDY_STATUS" in 2??) STUDY_OK=1 ;; *) STUDY_OK=0 ;; esac
echo "  upload.php (GET, expect 405): $UP_CODE"
echo "  list.php   (anon, expect 401): $LS_CODE"
echo "  list.php   (auth, expect 200): $LS_AUTH"
echo "  upload.php (preflight from fs.sferas.lv, expect 2xx + that origin + all headers): status ${STUDY_STATUS:-none}, origin ${CORS_STUDY:-none}${MISSING:+, headers NOT allowed:$MISSING}"
echo "  upload.php (preflight from example.com, expect no origin): ${CORS_OTHER:-none}"
[ "$UP_CODE" = "405" ] && [ "$LS_CODE" = "401" ] && [ "$LS_AUTH" = "200" ] \
  && [ "$STUDY_OK" = 1 ] && [ "$CORS_STUDY" = "https://fs.sferas.lv" ] && [ -z "$MISSING" ] && [ -z "$CORS_OTHER" ] \
  && echo "endpoint live ✓  →  $BASE/list.php" \
  || { echo "UNEXPECTED — check the output above" >&2; exit 1; }
