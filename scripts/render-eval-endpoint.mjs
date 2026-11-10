/**
 * Render the eval-endpoint PHP templates with the real secrets.
 * Used by scripts/deploy-eval-endpoint.sh — see that file for why the repo
 * keeps only CHANGE-ME templates (it is public; the pin must not be in git).
 *
 *   node scripts/render-eval-endpoint.mjs <templateDir> <outDir> <configPath>
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [tplDir, outDir, confPath] = process.argv.slice(2);
const c = JSON.parse(readFileSync(confPath, 'utf8'));

// list.php streams every participant's package, so its password must not be
// guessable: until 2026-11-09 it was a 4-digit number behind a documented
// username, with nothing slowing a guesser down. Refused here, before anything
// is rendered, and stored in list.php only as a SHA-256 hash.
const MIN_VIEW_PASSWORD = 20;
if (typeof c.viewPassword !== 'string' || c.viewPassword.length < MIN_VIEW_PASSWORD) {
  throw new Error(`viewPassword must be at least ${MIN_VIEW_PASSWORD} characters (openssl rand -base64 24)`);
}
if (c.viewPassword === c.uploadKey) throw new Error('viewPassword must differ from uploadKey (the upload key is public)');
const viewHash = createHash('sha256').update(c.viewPassword, 'utf8').digest('hex');

/** PHP single-quoted literal: only \ and ' need escaping. */
const php = (v) => `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

const subst = (src, pairs, label) => {
  let out = src;
  for (const [from, to] of pairs) {
    if (!out.includes(from)) throw new Error(`${label}: template line not found — ${from}`);
    out = out.replace(from, to);
  }
  // Only the ASSIGNMENTS must be rendered — upload.php deliberately KEEPS a
  // `$SECRET === 'CHANGE-ME'` guard so an unconfigured copy refuses everything.
  const unset = out
    .split('\n')
    .filter((l) => /^\$(SECRET|VIEW_PASSWORD_SHA256|VIEW_USER|INBOX)\s*=/.test(l) && l.includes('CHANGE-ME'));
  if (unset.length) throw new Error(`${label}: placeholder survived — ${unset.join(' | ')}`);
  return out;
};

const upload = subst(
  readFileSync(join(tplDir, 'fastshaders-eval-upload.php'), 'utf8'),
  [
    ["$SECRET    = 'CHANGE-ME';", `$SECRET    = ${php(c.uploadKey)};`],
    [
      "$INBOX     = __DIR__ . '/eval-inbox';   // \u2190 set an ABSOLUTE path outside the web root",
      `$INBOX     = ${php(c.inboxDir)};`,
    ],
  ],
  'upload.php',
);

const list = subst(
  readFileSync(join(tplDir, 'fastshaders-eval-list.php'), 'utf8'),
  [
    ["$VIEW_USER            = 'researcher';", `$VIEW_USER            = ${php(c.viewUser)};`],
    ["$VIEW_PASSWORD_SHA256 = 'CHANGE-ME';", `$VIEW_PASSWORD_SHA256 = ${php(viewHash)};`],
    [
      "$INBOX                = __DIR__ . '/eval-inbox';   // must match upload.php (absolute path recommended)",
      `$INBOX                = ${php(c.inboxDir)};   // must match upload.php`,
    ],
  ],
  'list.php',
);

writeFileSync(join(outDir, 'upload.php'), upload);
writeFileSync(join(outDir, 'list.php'), list);
console.log('rendered upload.php + list.php');
