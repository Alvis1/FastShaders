<?php
/**
 * FastShaders eval-package upload endpoint (delivery option B).
 * Companion of src/eval/evalUpload.ts — see EVAL_MODE_PLAN.md §4 Phase 5.
 *
 * LIVE ON imgame.va.lv (since 2026-11-09, consent-16): the server of Vidzeme
 * University of Applied Sciences (ViA), the data controller the consent names,
 * at https://imgame.va.lv/fastshaders-eval/upload.php. Until then it ran on the
 * researcher's own alvismisjuns.lv. EVERY app build posts here, cross-origin
 * (DEFAULT_EVAL_UPLOAD_URL in vite.config.ts), so the consent's "uploaded to
 * ViA's study server imgame.va.lv" holds whichever host served the app.
 *
 * DEPLOY: `bash scripts/deploy-eval-endpoint.sh` renders the secrets in,
 * uploads this file with list.php and the folder's .htaccess, and proves the
 * whole path with a real package. The recipe it encodes:
 *   1. $SECRET below and EVAL_UPLOAD_KEY in src/eval/evalUpload.ts are the same
 *      value (public by construction: it ships in the app bundle).
 *   2. $INBOX: a directory PHP can WRITE. Outside the web root is safest; the
 *      ViA container's only mount IS the web root, so there it is a random-
 *      named folder beside this file behind two deny rules (README.md).
 *   3. post_max_size must cover $MAX_BYTES: a package is the raw request body.
 *      The php:8-apache image keeps 8M; the folder's .htaccess raises it.
 *   4. Every app origin is in $ALLOWED_ORIGINS below.
 *   5. Moving this endpoint to another host is a CONSENT change: the text names
 *      the host (evalDisclosure.test.ts ties it to EVAL_UPLOAD_URL), so it gets
 *      new wording and a CONSENT_TEXT_VERSION bump.
 *   6. Optionally set $NOTIFY to get a mail per received package (the file
 *      itself stays on the server — PHP mail() attachments are unreliable, and
 *      the ViA container has no mail transport configured).
 *
 * Hardening: POST-only, constant-time key check, strict filename pattern
 * (exactly what evalZipFileName() emits), size cap, zip magic check,
 * never-overwrite storage, and an inbox directory denied to the web (0700 +
 * a deny-all .htaccess written on first use). The client-visible key stops
 * drive-by spam only; these checks are the actual controls. CORS is an
 * exact-origin allowlist, never `*`: it decides which PAGES may read the
 * answer, not who may send — a non-browser client ignores it anyway, so the
 * checks above stay the controls.
 */

// A PHP warning printed BEFORE http_response_code() sends the headers with a
// 200: a failed write then reached the participant as "uploaded", followed by
// "write failed" in a body nobody reads. The ViA container has no php.ini, and
// PHP's built-in default is display_errors=1, so it is switched off here (and
// in the folder's .htaccess). The client also requires the body to be "ok".
ini_set('display_errors', '0');

$SECRET    = 'CHANGE-ME';
$MAX_BYTES = 64 * 1024 * 1024;
// The inbox shares its disk with the ImGame site, and the key is public, so a
// package that would leave less than this free is refused (507) rather than
// filling the disk for both projects.
$MIN_FREE_BYTES = 1024 * 1024 * 1024;
// Where packages are stored. SAFEST is a path OUTSIDE the web root — then no
// web-server config can ever serve it and list.php's streaming is the only way
// in. It must also be WRITABLE by PHP, which no refusal ever tests:
// list.php?health makes a real write there, and every deploy script stops
// unless it passes. The default below keeps the two files self-contained and
// relies on the 0700 mode + the deny-all .htaccess written on first use (which
// needs AllowOverride to be on). The live value is rendered from inboxDir.
$INBOX     = __DIR__ . '/eval-inbox';   // ← set an ABSOLUTE path outside the web root
$NOTIFY    = ''; // e.g. 'alvis.misjuns@va.lv' — empty disables the notification mail

// Pages that may post here, by EXACT origin — every host the app is served
// from, since every build posts here cross-origin: the study host fs.sferas.lv,
// alvismisjuns.lv (apex and www) and GitHub Pages. evalUpload.test.ts holds this
// list to the hosts the deploy scripts and vite.config.ts name. The POST is not
// a "simple" request (the X-FS-Eval-* headers, an application/zip body), so the
// browser first sends an OPTIONS preflight — and the POST's own response needs
// the Allow-Origin too: without it the browser hides the answer from fetch(),
// so the package is STORED while the participant is told the upload failed.
// No cookies are involved, so no Allow-Credentials.
$ALLOWED_ORIGINS = ['https://fs.sferas.lv', 'https://alvismisjuns.lv', 'https://www.alvismisjuns.lv', 'https://alvis1.github.io'];

$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
header('Vary: Origin');
if (in_array($origin, $ALLOWED_ORIGINS, true)) {
  header('Access-Control-Allow-Origin: ' . $origin);
  header('Access-Control-Allow-Methods: POST');
  // Every header uploadEvalPackage() sets (evalUpload.test.ts pins the match).
  header('Access-Control-Allow-Headers: Content-Type, X-FS-Eval-Name, X-FS-Eval-Key');
  header('Access-Control-Max-Age: 600');
}
// A preflight carries no body and no key: answer it and stop. A foreign origin
// gets the same 204 WITHOUT an Allow-Origin, and that absence is the refusal.
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(204); exit; }

header('Content-Type: text/plain; charset=utf-8');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') { http_response_code(405); exit("POST only\n"); }

$key = $_SERVER['HTTP_X_FS_EVAL_KEY'] ?? '';
if ($SECRET === 'CHANGE-ME' || !hash_equals($SECRET, $key)) { http_response_code(403); exit("refused\n"); }

$name = $_SERVER['HTTP_X_FS_EVAL_NAME'] ?? '';
if (!preg_match('/^fastshaders-eval-[a-z0-9-]{1,80}-\d{12}\.zip$/', $name)) {
  http_response_code(400); exit("bad name\n");
}

$len = (int)($_SERVER['CONTENT_LENGTH'] ?? 0);
if ($len <= 0 || $len > $MAX_BYTES) { http_response_code(413); exit("too large\n"); }
$data = file_get_contents('php://input', false, null, 0, $MAX_BYTES + 1);
if ($data === false || strlen($data) === 0 || strlen($data) > $MAX_BYTES) {
  http_response_code(413); exit("too large\n");
}
if (substr($data, 0, 4) !== "PK\x03\x04") { http_response_code(400); exit("not a zip\n"); }

if (!is_dir($INBOX)) {
  if (!mkdir($INBOX, 0700, true)) { http_response_code(500); exit("no inbox\n"); }
  // Belt and braces if the inbox ever lands inside the webroot.
  @file_put_contents($INBOX . '/.htaccess', "Require all denied\n");
}

$free = @disk_free_space($INBOX);
if ($free !== false && $free - strlen($data) < $MIN_FREE_BYTES) { http_response_code(507); exit("server full\n"); }

// Never overwrite: a re-submitted or colliding name gets a numeric suffix.
$target = $INBOX . '/' . $name;
for ($i = 1; file_exists($target); $i++) {
  $target = $INBOX . '/' . preg_replace('/\.zip$/', "-$i.zip", $name);
}
if (file_put_contents($target, $data) !== strlen($data)) { http_response_code(500); exit("write failed\n"); }

if ($NOTIFY !== '') {
  @mail(
    $NOTIFY,
    'FastShaders eval package received: ' . $name,
    'Stored as ' . basename($target) . ' (' . strlen($data) . " bytes).\n"
  );
}

http_response_code(200);
echo "ok\n";
