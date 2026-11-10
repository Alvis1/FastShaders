#!/usr/bin/env bash
# The study upload, judged from ONE app origin. Both host deploys
# (deploy-sferas.sh, deploy-alvismisjuns.sh) run it BEFORE they build or upload
# anything, so a lagging or broken endpoint stops the deploy while the host
# still serves its previous build — instead of every participant's package.
#
#   bash scripts/check-eval-upload.sh <app origin>   # e.g. https://fs.sferas.lv
#   bash scripts/check-eval-upload.sh --url          # print the URL the build posts to
#
# Every build posts finished study packages to ViA's endpoint on imgame.va.lv
# (DEFAULT_EVAL_UPLOAD_URL in vite.config.ts, read from that line so there is
# one copy; an FS_EVAL_UPLOAD_URL override moves the build AND this check).
# Two checks, because each catches what the other cannot:
#   1. the CORS preflight, judged the way a browser judges it: a 2xx status,
#      this exact origin echoed back, and every header the upload sends
#      allowed — asked for as the endpoint TEMPLATE lists them
#      (evalUpload.test.ts pins template ⊇ client). Allow-Origin alone passed
#      a 405 that still carried it, and an Allow-Headers list one header short:
#      both fail in Chrome, as "Upload failed." on every package;
#   2. list.php?health, a real write in the inbox behind its private login
#      (.vscode/eval-endpoint.json). Every other answer is given before
#      upload.php writes: from 2026-10-08 to 10-20 a read-only inbox 500ed every
#      package while the preflight stayed green.
# If either fails: bash scripts/deploy-eval-endpoint.sh, then deploy again.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UPLOAD_URL="${FS_EVAL_UPLOAD_URL:-$(sed -n "s/^const DEFAULT_EVAL_UPLOAD_URL = '\([^']*\)';.*/\1/p" "$ROOT/vite.config.ts")}"
[ -n "$UPLOAD_URL" ] || { echo "cannot read DEFAULT_EVAL_UPLOAD_URL from vite.config.ts" >&2; exit 1; }
if [ "${1:-}" = "--url" ]; then printf '%s\n' "$UPLOAD_URL"; exit 0; fi
ORIGIN="${1:?usage: check-eval-upload.sh <app origin> | --url}"
case "$UPLOAD_URL" in
  https://*/upload.php) ;;
  *) echo "cannot judge $UPLOAD_URL: the check needs an absolute https …/upload.php beside its list.php" >&2; exit 1 ;;
esac

# The headers the app's upload sends, as the endpoint TEMPLATE allows them. The
# preflight below asks the LIVE endpoint for exactly these, so a header added to
# the client stops the deploy while the live endpoint still lacks it.
REQ_HEADERS="$(sed -n "s/.*header('Access-Control-Allow-Headers: \([^']*\)').*/\1/p" "$ROOT/scripts/eval-endpoint/fastshaders-eval-upload.php" \
  | head -1 | tr 'A-Z' 'a-z' | tr -d ' ')"
[ -n "$REQ_HEADERS" ] || { echo "cannot read Access-Control-Allow-Headers from scripts/eval-endpoint/fastshaders-eval-upload.php" >&2; exit 1; }

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
echo "  upload preflight from $ORIGIN: status ${PF_STATUS:-none}, origin ${CORS:-none}${MISSING:+, headers NOT allowed:$MISSING} (expected 2xx, $ORIGIN)"
[ "$PF_OK" = 1 ] && [ "$CORS" = "$ORIGIN" ] && [ -z "$MISSING" ] \
  || { echo "  → the live endpoint ($UPLOAD_URL) does not admit $ORIGIN's upload; nothing was built or uploaded. Run  bash scripts/deploy-eval-endpoint.sh  first." >&2; exit 1; }

EVAL_CONF="$ROOT/.vscode/eval-endpoint.json"
[ -f "$EVAL_CONF" ] || { echo "missing $EVAL_CONF (the inbox login for the store check)" >&2; exit 1; }
VIEW_USER="$(node -e 'process.stdout.write(String(require(process.argv[1]).viewUser ?? ""))' "$EVAL_CONF")"
VIEW_PW="$(node -e 'process.stdout.write(String(require(process.argv[1]).viewPassword ?? ""))' "$EVAL_CONF")"
HEALTH="$(curl -sS -u "$VIEW_USER:$VIEW_PW" "${UPLOAD_URL%/upload.php}/list.php?health" | head -1 || true)"
echo "  upload inbox: ${HEALTH:-no answer} (expected inbox ok)"
[ "${HEALTH#inbox ok:}" != "$HEALTH" ] \
  || { echo "  → the endpoint cannot store a package; nothing was built or uploaded. Fix the inbox (scripts/eval-endpoint/README.md), then run  bash scripts/deploy-eval-endpoint.sh." >&2; exit 1; }
