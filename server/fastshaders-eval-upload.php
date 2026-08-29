<?php
/**
 * FastShaders eval-package upload endpoint (delivery option B).
 * Companion of src/eval/evalUpload.ts — see EVAL_MODE_PLAN.md §4 Phase 5.
 *
 * DEPLOY (alvismisjuns.lv):
 *   1. Pick a real secret; set $SECRET below AND EVAL_UPLOAD_KEY in
 *      src/eval/evalUpload.ts to the same value.
 *   2. Upload this file to /fastshaders-eval/upload.php (i.e. a sibling of
 *      the /fastshaders/ app dir — same origin, so the app's CSP already
 *      permits the POST; no server config change needed).
 *   3. Set EVAL_UPLOAD_URL in src/eval/evalUpload.ts to
 *      '/fastshaders-eval/upload.php' and redeploy the app.
 *   4. Optionally set $NOTIFY to get a mail per received package (the file
 *      itself stays on the server — PHP mail() attachments are unreliable,
 *      and the zip is already safely stored).
 *   5. If you enable this, extend the consent text to say the package is
 *      transferred to the university's server — today's wording only
 *      promises "handed to the researcher".
 *   6. Check the host's post_max_size covers your expected package size
 *      (shader zips with images/models can reach tens of MB).
 *
 * Hardening: POST-only, constant-time key check, strict filename pattern
 * (exactly what evalZipFileName() emits), size cap, zip magic check,
 * never-overwrite storage, and an inbox directory denied to the web (0700 +
 * a deny-all .htaccess written on first use). The client-visible key stops
 * drive-by spam only; these checks are the actual controls.
 */

$SECRET    = 'CHANGE-ME';
$MAX_BYTES = 64 * 1024 * 1024;
// Where packages are stored. SAFEST is a path OUTSIDE the web root, e.g.
// '/var/www/alvis/eval-inbox' — then no Apache config can ever serve it and
// list.php's streaming is the only way in. The default below keeps the two
// files self-contained and relies on the 0700 mode + the deny-all .htaccess
// written on first use (which needs AllowOverride to be on).
$INBOX     = __DIR__ . '/eval-inbox';   // ← set an ABSOLUTE path outside the web root
$NOTIFY    = ''; // e.g. 'alvis.misjuns@va.lv' — empty disables the notification mail

// Same-origin deployments need no CORS. If the endpoint must ever accept the
// GitHub Pages origin, uncomment (and widen the app's connect-src):
// header('Access-Control-Allow-Origin: https://alvis1.github.io');
// header('Access-Control-Allow-Headers: Content-Type, X-FS-Eval-Name, X-FS-Eval-Key');
// if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(204); exit; }

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
