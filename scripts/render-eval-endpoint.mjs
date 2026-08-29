/**
 * Render the eval-endpoint PHP templates with the real secrets.
 * Used by scripts/deploy-eval-endpoint.sh — see that file for why the repo
 * keeps only CHANGE-ME templates (it is public; the pin must not be in git).
 *
 *   node scripts/render-eval-endpoint.mjs <templateDir> <outDir> <configPath>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [tplDir, outDir, confPath] = process.argv.slice(2);
const c = JSON.parse(readFileSync(confPath, 'utf8'));

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
    .filter((l) => /^\$(SECRET|VIEW_PASSWORD|VIEW_USER|INBOX)\s*=/.test(l) && l.includes('CHANGE-ME'));
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
    ["$VIEW_USER     = 'researcher';", `$VIEW_USER     = ${php(c.viewUser)};`],
    ["$VIEW_PASSWORD = 'CHANGE-ME-AND-MAKE-IT-DIFFERENT';", `$VIEW_PASSWORD = ${php(c.viewPassword)};`],
    [
      "$INBOX         = __DIR__ . '/eval-inbox';   // must match upload.php (absolute path recommended)",
      `$INBOX         = ${php(c.inboxDir)};   // must match upload.php`,
    ],
  ],
  'list.php',
);

writeFileSync(join(outDir, 'upload.php'), upload);
writeFileSync(join(outDir, 'list.php'), list);
console.log('rendered upload.php + list.php');
