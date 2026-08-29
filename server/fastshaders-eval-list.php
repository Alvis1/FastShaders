<?php
/**
 * FastShaders eval inbox — the researcher's single collection point.
 * Companion of fastshaders-eval-upload.php (which receives) — this one lets
 * you SEE and download what arrived, from any browser.
 *
 * DEPLOY: upload beside upload.php (e.g. /fastshaders-eval/list.php), set
 * $VIEW_USER/$VIEW_PASSWORD below, and keep $INBOX identical to the one in
 * upload.php. Open https://<host>/fastshaders-eval/list.php.
 *
 * *** THE PASSWORD HERE MUST NOT BE THE UPLOAD KEY. ***
 * The upload key ships inside the app's JavaScript bundle and is therefore
 * public by construction — it exists only to deter drive-by posting. This
 * page exposes participant data, so it gets its own private password.
 *
 * Files are STREAMED by this script rather than linked directly, so the inbox
 * directory itself can stay unreachable from the web (see $INBOX in
 * upload.php: ideally a path OUTSIDE the docroot).
 */

$VIEW_USER     = 'researcher';
$VIEW_PASSWORD = 'CHANGE-ME-AND-MAKE-IT-DIFFERENT';
$INBOX         = __DIR__ . '/eval-inbox';   // must match upload.php (absolute path recommended)

// --- auth ---------------------------------------------------------------
$user = $_SERVER['PHP_AUTH_USER'] ?? '';
$pass = $_SERVER['PHP_AUTH_PW'] ?? '';
$ok = $VIEW_PASSWORD !== 'CHANGE-ME-AND-MAKE-IT-DIFFERENT'
   && hash_equals($VIEW_USER, $user) && hash_equals($VIEW_PASSWORD, $pass);
if (!$ok) {
  header('WWW-Authenticate: Basic realm="FastShaders eval inbox"');
  http_response_code(401);
  exit("Authentication required.\n");
}

// --- download one package ----------------------------------------------
if (isset($_GET['get'])) {
  $name = (string)$_GET['get'];
  // Same pattern the uploader accepts, plus its collision suffix (-1, -2…).
  if (!preg_match('/^fastshaders-eval-[a-z0-9-]{1,80}-\d{12}(-\d+)?\.zip$/', $name)) {
    http_response_code(400); exit("bad name\n");
  }
  $path = $INBOX . '/' . $name;              // no traversal: the regex has no dots-slashes
  if (!is_file($path)) { http_response_code(404); exit("not found\n"); }
  header('Content-Type: application/zip');
  header('Content-Length: ' . filesize($path));
  header('Content-Disposition: attachment; filename="' . $name . '"');
  readfile($path);
  exit;
}

// --- listing ------------------------------------------------------------
$files = is_dir($INBOX)
  ? array_values(array_filter(scandir($INBOX), fn($f) => str_ends_with($f, '.zip')))
  : [];
usort($files, fn($a, $b) => filemtime("$INBOX/$b") <=> filemtime("$INBOX/$a"));
$total = array_sum(array_map(fn($f) => filesize("$INBOX/$f"), $files));
$h = fn($s) => htmlspecialchars((string)$s, ENT_QUOTES, 'UTF-8');
?><!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>FastShaders eval inbox</title>
<style>
  body{font:15px/1.5 system-ui,sans-serif;margin:0;padding:2rem;background:#f4f5f2;color:#1d2126}
  h1{font-size:1.4rem;margin:0 0 .25rem}
  .sub{color:#5b6570;margin:0 0 1.5rem;font-size:.9rem}
  table{border-collapse:collapse;width:100%;max-width:60rem;background:#fff;border:1px solid #d8dcd6}
  th,td{text-align:left;padding:.55rem .8rem;border-bottom:1px solid #e6e9e4;font-variant-numeric:tabular-nums}
  th{font-size:.72rem;letter-spacing:.1em;text-transform:uppercase;color:#5b6570;background:#eef0ec}
  tr:last-child td{border-bottom:none}
  a{color:#31688e}
  code{background:#eef0ec;padding:.1em .35em}
  .empty{color:#5b6570}
</style></head><body>
<h1>FastShaders eval inbox</h1>
<p class="sub"><?= count($files) ?> package<?= count($files) === 1 ? '' : 's' ?> ·
  <?= number_format($total / 1048576, 1) ?> MB total ·
  analyse with <code>npm run eval:analysis -- &lt;folder&gt;</code> after downloading</p>
<?php if (!$files): ?>
  <p class="empty">Nothing received yet.</p>
<?php else: ?>
<table>
  <tr><th>participant</th><th>received</th><th>size</th><th>file</th></tr>
<?php foreach ($files as $f):
  // fastshaders-eval-<participant>-<YYYYMMDDHHMM>.zip
  preg_match('/^fastshaders-eval-(.+)-\d{12}/', $f, $m);
  $participant = $m[1] ?? '?'; ?>
  <tr>
    <td><?= $h($participant) ?></td>
    <td><?= $h(date('Y-m-d H:i', filemtime("$INBOX/$f"))) ?></td>
    <td><?= number_format(filesize("$INBOX/$f") / 1024, 0) ?> KB</td>
    <td><a href="?get=<?= urlencode($f) ?>"><?= $h($f) ?></a></td>
  </tr>
<?php endforeach; ?>
</table>
<?php endif; ?>
</body></html>
