#!/usr/bin/env bash
# Deploy the eval-study collection endpoint to imgame.va.lv — the server of
# Vidzeme University of Applied Sciences (ViA), the data controller the consent
# names, which since consent-16 (2026-11-09) also HOLDS the data. Until then the
# endpoint was the researcher's own alvismisjuns.lv (docs/dev/eval-mode.md).
#
#   bash scripts/deploy-eval-endpoint.sh
#
# The repo is public, so it keeps `scripts/eval-endpoint/*.php` as CHANGE-ME
# TEMPLATES; the secrets live in the gitignored `.vscode/eval-endpoint.json` and
# are rendered in here (render-eval-endpoint.mjs). The SSH login is NOT copied
# there: `sftpConfig` + `sftpName` name the entry in the ImGame project's own
# gitignored `.vscode/sftp.json`, the one place that login is kept. The password
# reaches psftp/plink through a 0600 file in a temp dir removed on exit, never
# through argv.
#
# Where it lands — the ImGame site's container `imgame_dev_php` (php:8-apache,
# `AllowOverride All` on /var/www/), whose ONLY mount is its docroot:
#   host      /var/www/imgame_dev_lite/src/fastshaders-eval/   (remoteDir)
#   container /var/www/html/fastshaders-eval/                   (what PHP sees)
#   web       https://imgame.va.lv/fastshaders-eval/            (publicBase)
# With no writable mount outside the docroot, the inbox (`inboxDir`, a CONTAINER
# path) is a random-named folder inside the endpoint folder, owned by www-data
# (uid 33), mode 0700, behind TWO deny rules: its own .htaccess and the endpoint
# folder's (scripts/eval-endpoint/htaccess serves nothing but upload.php and
# list.php, and raises post_max_size, which the image leaves at 8M). The ImGame
# site is uploaded into the same docroot by hand; SFTP never deletes, but a
# "sync with delete" there would remove this folder AND the packages — the
# ImGame README says so.
#
# Re-run after editing a template or rotating a secret. It ends with the only
# check that exercises the whole path: a real 16 MB package POSTed from the
# study origin through Cloudflare must answer 200, lie on the server's disk at
# its full size, come back byte-identical through list.php, and NOT be
# reachable by URL — and is then deleted again.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EVAL_CONF="$ROOT/.vscode/eval-endpoint.json"
TEMPLATE="$ROOT/scripts/eval-endpoint/fastshaders-eval-upload.php"
STUDY_ORIGIN="https://fs.sferas.lv"
[ -f "$EVAL_CONF" ] || { echo "missing $EVAL_CONF (endpoint secrets)"; exit 1; }
for tool in psftp plink; do
  command -v "$tool" >/dev/null || { echo "$tool not found — brew install putty"; exit 1; }
done

# One value per call, so a space inside a value can never shift the others.
cfg() {
  node -e '
    const [conf, key] = process.argv.slice(1);
    const v = require(conf)[key];
    if (typeof v !== "string" || !v) { console.error(`${key} is missing from ${conf}`); process.exit(1); }
    process.stdout.write(v);
  ' "$EVAL_CONF" "$1"
}
PUBLIC_BASE="$(cfg publicBase)"
REMOTE_DIR="$(cfg remoteDir)"
INBOX_DIR="$(cfg inboxDir)"
UPLOAD_KEY="$(cfg uploadKey)"
VIEW_USER="$(cfg viewUser)"
VIEW_PW="$(cfg viewPassword)"
SFTP_CONF="$(cfg sftpConfig)"
SFTP_NAME="$(cfg sftpName)"

# The app sends the key compiled into it (EVAL_UPLOAD_KEY), never this config's:
# a rotated uploadKey with the app unchanged would refuse every participant's
# package with a 403 while every check below passed with the config's key.
APP_KEY="$(sed -n "s/^export const EVAL_UPLOAD_KEY: string = '\([^']*\)';.*/\1/p" "$ROOT/src/eval/evalUpload.ts")"
[ -n "$APP_KEY" ] || { echo "cannot read EVAL_UPLOAD_KEY from src/eval/evalUpload.ts" >&2; exit 1; }
[ "$APP_KEY" = "$UPLOAD_KEY" ] || { echo "uploadKey in $EVAL_CONF differs from EVAL_UPLOAD_KEY in src/eval/evalUpload.ts — the app could not upload" >&2; exit 1; }

# The two paths go into remote shell commands and a psftp batch: plain absolute
# paths only.
SAFE_PATH='^/[A-Za-z0-9._/-]+$'
for p in "$REMOTE_DIR" "$INBOX_DIR"; do
  if ! [[ "$p" =~ $SAFE_PATH ]] || [[ "$p" == *..* ]]; then echo "unsafe path in $EVAL_CONF: $p" >&2; exit 1; fi
done
# inboxDir is what PHP opens INSIDE the container; its host twin is the same
# folder name under remoteDir. That pairing is checked on disk below — the probe
# package must land exactly there.
INBOX_NAME="$(basename "$INBOX_DIR")"
HOST_INBOX="$REMOTE_DIR/$INBOX_NAME"
[ "$(basename "$(dirname "$INBOX_DIR")")" = "$(basename "$REMOTE_DIR")" ] \
  || { echo "inboxDir must sit directly inside the endpoint folder (…/$(basename "$REMOTE_DIR")/<inbox>)" >&2; exit 1; }

STAGE="$(mktemp -d)"
PROBE_LEFT=""
LOGIN="$(node -e '
  const fs = require("fs");
  const [conf, name, pwfile] = process.argv.slice(1);
  const all = JSON.parse(fs.readFileSync(conf, "utf8"));
  const e = (Array.isArray(all) ? all : [all]).find((x) => x && x.name === name);
  if (!e) { console.error(`no entry named "${name}" in ${conf}`); process.exit(1); }
  if (typeof e.password !== "string" || !e.password) { console.error(`entry "${name}" has no password — this script logs in with it`); process.exit(1); }
  fs.writeFileSync(pwfile, e.password, { mode: 0o600 });
  console.log([e.host, e.port || 22, e.username].join("\n"));
' "$SFTP_CONF" "$SFTP_NAME" "$STAGE/pw")" || { rm -rf "$STAGE"; exit 1; }
SSH_HOST="$(printf '%s\n' "$LOGIN" | sed -n 1p)"
SSH_PORT="$(printf '%s\n' "$LOGIN" | sed -n 2p)"
SSH_USER="$(printf '%s\n' "$LOGIN" | sed -n 3p)"
SSH_OPTS=(-batch -P "$SSH_PORT" -pwfile "$STAGE/pw")
remote() { plink -ssh "${SSH_OPTS[@]}" "$SSH_USER@$SSH_HOST" "$1"; }
PROBE_GLOB="'$HOST_INBOX'/fastshaders-eval-deploy-check-*.zip"
cleanup() {
  if [ -n "$PROBE_LEFT" ]; then
    remote "rm -f $PROBE_GLOB" >/dev/null 2>&1 \
      || echo "  ! could not delete the probe package — remove $HOST_INBOX/fastshaders-eval-deploy-check-*.zip by hand" >&2
  fi
  rm -rf "$STAGE"
}
trap cleanup EXIT

# Render the templates with the real secrets (see render-eval-endpoint.mjs).
node "$ROOT/scripts/render-eval-endpoint.mjs" "$ROOT/scripts/eval-endpoint" "$STAGE" "$EVAL_CONF"

# The headers the upload sends, as the template allows them, and the origins it
# admits — read BEFORE the upload, so a template line this cannot parse stops
# here instead of leaving a new endpoint live and unverified. The verification
# below asks for exactly these.
REQ_HEADERS="$(sed -n "s/.*header('Access-Control-Allow-Headers: \([^']*\)').*/\1/p" "$TEMPLATE" \
  | head -1 | tr 'A-Z' 'a-z' | tr -d ' ')"
[ -n "$REQ_HEADERS" ] || { echo "cannot read Access-Control-Allow-Headers from the template" >&2; exit 1; }
ORIGINS="$(node -e '
  const php = require("fs").readFileSync(process.argv[1], "utf8");
  const m = php.match(/^\$ALLOWED_ORIGINS\s*=\s*\[([^\]]*)\];/m);
  if (!m) process.exit(1);
  console.log([...m[1].matchAll(/\x27([^\x27]*)\x27/g)].map((x) => x[1]).join(" "));
' "$TEMPLATE")" || { echo "cannot read \$ALLOWED_ORIGINS from the template" >&2; exit 1; }
case " $ORIGINS " in *" $STUDY_ORIGIN "*) ;; *) echo "\$ALLOWED_ORIGINS lacks the study origin $STUDY_ORIGIN" >&2; exit 1 ;; esac

# This runs as ROOT on the host, inside a folder www-data owns: www-data could
# swap the inbox's .htaccess for a symlink to any host file, and a plain `>` or
# chmod would follow it. So the file is removed and re-created with noclobber
# (set -C: refuses to write through anything that reappeared) under umask 022,
# and nothing is chmod-ed by path.
echo "==> preparing $SSH_USER@$SSH_HOST:$REMOTE_DIR"
remote "set -e
mkdir -p '$REMOTE_DIR' '$HOST_INBOX'
chown 33:33 '$HOST_INBOX'
chmod 700 '$HOST_INBOX'
rm -f '$HOST_INBOX/.htaccess'
(umask 022; set -C; printf 'Require all denied\n' > '$HOST_INBOX/.htaccess')" \
  || { echo "  → SSH failed. If the host key is not cached yet, accept it once:  plink -P $SSH_PORT $SSH_USER@$SSH_HOST exit" >&2; exit 1; }

echo "==> uploading the endpoint"
BATCH="$STAGE/batch.txt"
{
  echo "cd \"$REMOTE_DIR\""
  echo "put \"$STAGE/upload.php\" upload.php"
  echo "put \"$STAGE/list.php\" list.php"
  echo "put \"$ROOT/scripts/eval-endpoint/htaccess\" .htaccess"
  echo "quit"
} > "$BATCH"
if ! PSFTP_OUT="$(psftp "${SSH_OPTS[@]}" -b "$BATCH" "$SSH_USER@$SSH_HOST" 2>&1)"; then
  printf '%s\n' "$PSFTP_OUT" >&2
  echo "  → the endpoint upload FAILED part-way: upload.php, list.php and .htaccess may be a mix of old and new. Fix the cause above and run this again." >&2
  exit 1
fi

echo "==> verifying"
code() { curl -s -o /dev/null -w '%{http_code}' "$@" || true; }
header_of() { awk -v h="$1" 'tolower($0) ~ "^" h ":" { sub(/^[^:]*: */, ""); print tolower($0) }'; }
UP_CODE="$(code "$PUBLIC_BASE/upload.php")"                              # GET → 405
LS_CODE="$(code "$PUBLIC_BASE/list.php")"                                # anon → 401
LS_AUTH="$(code -u "$VIEW_USER:$VIEW_PW" "$PUBLIC_BASE/list.php")"       # → 200
HT_CODE="$(code "$PUBLIC_BASE/.htaccess")"                               # never served → 403
# The STORE step, which no refusal reaches: list.php?health makes a real write
# in the inbox and removes it. From 2026-10-08 to 10-20 the old endpoint's inbox
# was read-only and every real package answered 500 behind green checks.
HEALTH="$(curl -s -u "$VIEW_USER:$VIEW_PW" "$PUBLIC_BASE/list.php?health" | head -1 || true)"

# Every app origin's CORS preflight, judged the way a browser judges it: a 2xx
# status, that exact origin back, and every header the upload sends allowed —
# asked for as the template lists them. A foreign origin must get no origin.
preflight() {
  curl -s -o /dev/null -D - -X OPTIONS "$PUBLIC_BASE/upload.php" -H "Origin: $1" \
    -H 'Access-Control-Request-Method: POST' \
    -H "Access-Control-Request-Headers: $REQ_HEADERS" \
    | tr -d '\r' || true
}
PF_FAILED=""
for o in $ORIGINS; do
  PF="$(preflight "$o")"
  PF_STATUS="$(printf '%s\n' "$PF" | awk 'NR == 1 { print $2 }')"
  PF_ORIGIN="$(printf '%s\n' "$PF" | header_of access-control-allow-origin)"
  PF_HEADERS="$(printf '%s\n' "$PF" | header_of access-control-allow-headers | tr -d ' ')"
  MISSING=""
  for h in $(printf '%s' "$REQ_HEADERS" | tr ',' ' '); do
    case ",$PF_HEADERS," in *",$h,"*|*",*,"*) ;; *) MISSING="$MISSING $h" ;; esac
  done
  case "$PF_STATUS" in 2??) PF_OK=1 ;; *) PF_OK=0 ;; esac
  echo "  preflight from $o (expect 2xx + that origin + all headers): status ${PF_STATUS:-none}, origin ${PF_ORIGIN:-none}${MISSING:+, headers NOT allowed:$MISSING}"
  [ "$PF_OK" = 1 ] && [ "$PF_ORIGIN" = "$o" ] && [ -z "$MISSING" ] || PF_FAILED="$PF_FAILED $o"
done
CORS_OTHER="$(preflight https://example.com | header_of access-control-allow-origin)"

# The whole path, once: a real package from the study origin, through Cloudflare
# and the PHP size limit, onto the disk, back out through list.php — and NOT out
# through a plain URL. 16 MB: twice the image's default post_max_size, so a lost
# .htaccess limit fails here rather than on a participant's first big package.
PROBE_NAME="fastshaders-eval-deploy-check-$(date -u +%Y%m%d%H%M).zip"
PROBE_BYTES=$((16 * 1024 * 1024))
{ printf 'PK\003\004'; head -c $((PROBE_BYTES - 4)) /dev/urandom; } > "$STAGE/probe.zip"
PROBE_LEFT=1
POST_CODE="$(curl -s -o "$STAGE/post.body" -D "$STAGE/post.head" -w '%{http_code}' -X POST "$PUBLIC_BASE/upload.php" \
  -H "Origin: $STUDY_ORIGIN" -H 'Content-Type: application/zip' \
  -H "X-FS-Eval-Name: $PROBE_NAME" -H "X-FS-Eval-Key: $UPLOAD_KEY" \
  --data-binary @"$STAGE/probe.zip" || true)"
POST_BODY="$(head -c 120 "$STAGE/post.body" 2>/dev/null | tr -d '\r\n' || true)"
POST_ORIGIN="$(tr -d '\r' < "$STAGE/post.head" 2>/dev/null | header_of access-control-allow-origin || true)"
# Newest probe on disk (a collision gets a -1 suffix), and its size there.
STORED="$(remote "ls -1t '$HOST_INBOX' | grep '^fastshaders-eval-deploy-check-' | head -1" 2>/dev/null || true)"
STORED_BYTES="$( [ -n "$STORED" ] && remote "stat -c %s '$HOST_INBOX/$STORED'" 2>/dev/null || echo 0)"
BACK_CODE="$(curl -s -u "$VIEW_USER:$VIEW_PW" -o "$STAGE/back.zip" -w '%{http_code}' \
  "$PUBLIC_BASE/list.php?get=${STORED:-$PROBE_NAME}" || true)"
if cmp -s "$STAGE/probe.zip" "$STAGE/back.zip"; then BACK_SAME=yes; else BACK_SAME=no; fi
DIRECT="$(code "$PUBLIC_BASE/$INBOX_NAME/${STORED:-$PROBE_NAME}")"     # never served → 403/404
LISTING="$(code "$PUBLIC_BASE/$INBOX_NAME/")"                          # never listed → 403/404
remote "rm -f $PROBE_GLOB" >/dev/null 2>&1 || true
LEFT="$(remote "ls -1 '$HOST_INBOX' | grep -c '^fastshaders-eval-deploy-check-' || true" 2>/dev/null || echo '?')"
[ "$LEFT" = 0 ] && PROBE_LEFT=""

denied() { [ "$1" = "403" ] || [ "$1" = "404" ]; }
echo "  upload.php GET  (expect 405): $UP_CODE"
echo "  list.php anon   (expect 401): $LS_CODE"
echo "  list.php auth   (expect 200): $LS_AUTH"
echo "  .htaccess       (expect 403): $HT_CODE"
echo "  inbox           (expect inbox ok): ${HEALTH:-no answer}"
echo "  preflight from example.com (expect no origin): ${CORS_OTHER:-none}"
echo "  16 MB package from $STUDY_ORIGIN (expect 200 ok + that origin): ${POST_CODE:-none} ${POST_BODY:-<empty>}, origin ${POST_ORIGIN:-none}"
echo "  on disk         (expect $PROBE_BYTES bytes): ${STORED:-nothing} ${STORED_BYTES}"
echo "  back via list.php (expect 200, byte-identical): $BACK_CODE, $BACK_SAME"
echo "  by direct URL   (expect 403/404): package $DIRECT, folder $LISTING"
echo "  probe removed   (expect 0 left): $LEFT"
[ "$UP_CODE" = "405" ] && [ "$LS_CODE" = "401" ] && [ "$LS_AUTH" = "200" ] && [ "$HT_CODE" = "403" ] \
  && [ "${HEALTH#inbox ok:}" != "$HEALTH" ] \
  && [ -z "$PF_FAILED" ] && [ -z "$CORS_OTHER" ] \
  && [ "$POST_CODE" = "200" ] && [ "$POST_BODY" = "ok" ] && [ "$POST_ORIGIN" = "$STUDY_ORIGIN" ] \
  && [ "$STORED_BYTES" = "$PROBE_BYTES" ] && [ "$BACK_CODE" = "200" ] && [ "$BACK_SAME" = yes ] \
  && denied "$DIRECT" && denied "$LISTING" && [ "$LEFT" = 0 ] \
  && echo "endpoint live ✓  →  $PUBLIC_BASE/list.php" \
  || { echo "UNEXPECTED — check the output above${PF_FAILED:+ (preflight failed for:$PF_FAILED)}" >&2; exit 1; }
