#!/usr/bin/env bash
# Deploy FastShaders to https://fs.sferas.lv/  (the study host).
#
#   npm run deploy:sferas
#   npm run deploy:sferas -- --no-build     # re-upload the existing snapshot
#
# Same shape as deploy-alvismisjuns.sh, four differences:
#   • base is `/` — that host serves the app at its ROOT, not under a subpath;
#   • FS_PREVIEW_ORIGIN names this host, so the sandboxed preview iframe (an
#     opaque origin, hence never `'self'`) may fetch the built-in models;
#   • FS_EVAL_UPLOAD_URL names alvismisjuns's study endpoint ABSOLUTELY (and
#     vite.config.ts adds its origin to connect-src): this host is static nginx
#     with no endpoint, so the app's relative default 404ed here and every
#     participant's package read "Upload failed." until 2026-10-02. The LIVE
#     endpoint must pass this origin's CORS preflight AND be able to store
#     (list.php?health), and both are checked FIRST: if either fails, nothing
#     is built or uploaded (deploy the endpoint with
#     `bash scripts/deploy-eval-endpoint.sh`, then run this again);
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
ORIGIN="https://fs.sferas.lv"
UPLOAD_URL="https://alvismisjuns.lv/fastshaders-eval/upload.php"
# The headers the app's upload sends, as the endpoint TEMPLATE allows them
# (evalUpload.test.ts pins template ⊇ client). The preflight gate below asks
# the LIVE endpoint for exactly these BEFORE anything is uploaded, so a header
# added to the client stops this deploy while the live endpoint still lacks
# it — the study host keeps its previous build — instead of every upload.
REQ_HEADERS="$(sed -n "s/.*header('Access-Control-Allow-Headers: \([^']*\)').*/\1/p" "$ROOT/scripts/eval-endpoint/fastshaders-eval-upload.php" \
  | head -1 | tr 'A-Z' 'a-z' | tr -d ' ')"

[ -n "$REQ_HEADERS" ] || { echo "cannot read Access-Control-Allow-Headers from scripts/eval-endpoint/fastshaders-eval-upload.php"; exit 1; }
[ -f "$CONF" ] || { echo "missing $CONF (SFTP credentials)"; exit 1; }
command -v psftp >/dev/null || { echo "psftp not found — brew install putty"; exit 1; }

# The study upload, judged BEFORE anything is built or uploaded, the way a
# browser judges the preflight: a 2xx status, this exact origin echoed, and
# every header the upload sends allowed. Allow-Origin alone is not enough (a
# 405 that still carries it, or an Allow-Headers list one header short, fails
# in the browser), and any one missing means every package reads "Upload
# failed." with nothing else looking wrong.
echo "==> checking the study upload endpoint"
PREFLIGHT="$(curl -sS -o /dev/null -D - -X OPTIONS "$UPLOAD_URL" \
  -H "Origin: $ORIGIN" \
  -H 'Access-Control-Request-Method: POST' \
  -H "Access-Control-Request-Headers: $REQ_HEADERS" \
  | tr -d '\r' || true)"
header_of() { awk -v h="$1" 'tolower($0) ~ "^" h ":" { sub(/^[^:]*: */, ""); print tolower($0) }'; }
PF_STATUS="$(printf '%s\n' "$PREFLIGHT" | awk 'NR == 1 { print $2 }')"
CORS="$(printf '%s\n' "$PREFLIGHT" | header_of access-control-allow-origin)"
PF_HEADERS="$(printf '%s\n' "$PREFLIGHT" | header_of access-control-allow-headers | tr -d ' ')"
MISSING=""
for h in $(printf '%s' "$REQ_HEADERS" | tr ',' ' '); do
  case ",$PF_HEADERS," in *",$h,"*|*",*,"*) ;; *) MISSING="$MISSING $h" ;; esac
done
case "$PF_STATUS" in 2??) PF_OK=1 ;; *) PF_OK=0 ;; esac
echo "  upload preflight: status ${PF_STATUS:-none}, origin ${CORS:-none}${MISSING:+, headers NOT allowed:$MISSING} (expected 2xx, $ORIGIN)"
[ "$PF_OK" = 1 ] && [ "$CORS" = "$ORIGIN" ] && [ -z "$MISSING" ] \
  || { echo "  → the live endpoint does not admit $ORIGIN's upload; nothing was uploaded. Run  bash scripts/deploy-eval-endpoint.sh  first." >&2; exit 1; }

# ...and that it can STORE what it admits. The preflight is answered before any
# write, so it stayed green from 2026-10-08 to 10-20 while the site's rebuilt
# container had /app read-only and every real package answered 500.
# list.php?health makes a real write in the inbox; it needs the inbox's private
# login, from the endpoint's gitignored config.
EVAL_CONF="$ROOT/.vscode/eval-endpoint.json"
[ -f "$EVAL_CONF" ] || { echo "missing $EVAL_CONF (the inbox login for the store check)"; exit 1; }
read -r VIEW_USER VIEW_PW <<< "$(node -e '
  const c = require(process.argv[1]);
  console.log(c.viewUser, c.viewPassword);
' "$EVAL_CONF")"
HEALTH="$(curl -sS -u "$VIEW_USER:$VIEW_PW" "${UPLOAD_URL%/upload.php}/list.php?health" | head -1 || true)"
echo "  upload inbox: ${HEALTH:-no answer} (expected inbox ok)"
[ "${HEALTH#inbox ok:}" != "$HEALTH" ] \
  || { echo "  → the endpoint cannot store a package; nothing was uploaded. Fix the inbox (scripts/eval-endpoint/README.md), then run  bash scripts/deploy-eval-endpoint.sh." >&2; exit 1; }

if [ "${1:-}" != "--no-build" ]; then
  # public/js is generated from the submodule: build only from a committed pointer.
  bash "$ROOT/scripts/check-submodule.sh"
  echo "==> building (base /, CSP for fs.sferas.lv, study uploads to alvismisjuns.lv)"
  cd "$ROOT"
  FS_BASE=/ \
  FS_PREVIEW_ORIGIN="$ORIGIN" \
  FS_EVAL_UPLOAD_URL="$UPLOAD_URL" \
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
# proves nothing about what the site actually serves. The CSP line is the
# study upload's other half: the served page's CSP must let it reach the
# endpoint (whose preflight was checked before the upload). The last check is
# the device-comparison page, a DIRECTORY url like /evalp/ but its own Vite
# entry (dist/compare/index.html): it must answer 200 with ITS page at the
# version just built — the title names it, because a host that fell back to
# index.html would answer 200 with the right version too.
echo "==> verifying"
EXPECTED="$(node -p "require('$ROOT/package.json').version")"
PAGE="$(curl -sS -H 'Cache-Control: no-cache' "$ORIGIN/index.html?cb=$(date +%s)")"
SERVED="$(printf '%s' "$PAGE" | sed -n 's/.*<meta name="version" content="\([^"]*\)".*/\1/p')"
EVALP="$(curl -sS -o /dev/null -w '%{http_code}' "$ORIGIN/evalp/")"
UPLOAD_ORIGIN="$(node -p "new URL('$UPLOAD_URL').origin")"
CSP_OK="$(printf '%s' "$PAGE" | grep -o "connect-src [^;\"]*" | grep -cF "$UPLOAD_ORIGIN" || true)"
COMPARE="$(curl -sS -H 'Cache-Control: no-cache' -w '\n%{http_code}' "$ORIGIN/compare/?cb=$(date +%s)" || true)"
COMPARE_CODE="$(printf '%s' "$COMPARE" | tail -n 1)"
COMPARE_VER="$(printf '%s' "$COMPARE" | sed -n 's/.*<meta name="version" content="\([^"]*\)".*/\1/p')"
COMPARE_OK="$(printf '%s' "$COMPARE" | grep -c 'Device comparison' || true)"
echo "  version served: ${SERVED:-none} (expected $EXPECTED)"
echo "  /evalp/       : $EVALP"
echo "  CSP names the upload origin: $([ "$CSP_OK" -ge 1 ] && echo yes || echo NO)"
echo "  /compare/     : ${COMPARE_CODE:-none}, version ${COMPARE_VER:-none}$([ "$COMPARE_OK" -ge 1 ] || echo ', NOT the comparison page')"
[ "$SERVED" = "$EXPECTED" ] && [ "$EVALP" = "200" ] && [ "$CSP_OK" -ge 1 ] \
  && [ "$COMPARE_CODE" = "200" ] && [ "$COMPARE_VER" = "$EXPECTED" ] && [ "$COMPARE_OK" -ge 1 ] \
  && echo "fs.sferas.lv live ✓" \
  || { echo "MISMATCH — check the output above" >&2; exit 1; }
