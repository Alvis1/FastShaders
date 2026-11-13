import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EVAL_UPLOAD_URL,
  MAX_UPLOAD_BYTES,
  precheckEvalUpload,
  uploadEvalPackage,
} from './evalUpload';
import { formatMiB } from '@/utils/formatSize';
import lv from '@/i18n/lv.json';

const bytes = new TextEncoder().encode('PK\x03\x04fake');
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const ui = (lv as { ui: Record<string, string> }).ui;

/** The N4 key. Its "64" is a LITERAL (like N3's "max 64 MB"); the pins below tie it to the cap. */
const N4_KEY = 'The file is too large for the study server ({size} MB; it accepts up to 64 MB).';

// Every test starts with a fetch that THROWS: the default URL is ViA's real
// endpoint and node's fetch is real, so a test that forgot its own stub would
// otherwise post a package with the real key. (uploadEvalPackage catches the
// throw and answers 'failed', which the test's own expectation then catches.)
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('unstubbed fetch in evalUpload.test.ts'); }));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('uploadEvalPackage', () => {
  it('points every build at the alvismisjuns.lv staging endpoint by default', async () => {
    // Owner, 2026-11-10: packages land on alvismisjuns.lv and are copied to
    // ViA's imgame.va.lv by hand (the consent still names imgame.va.lv). vitest
    // runs the default build (no FS_EVAL_UPLOAD_URL), so this is what every
    // deploy ships — the pins below hold the copies of the URL to one value.
    expect(EVAL_UPLOAD_URL).toBe('https://alvismisjuns.lv/fastshaders-eval/upload.php');
  });

  it('no test can post to the REAL endpoint: every suite that uploads stubs fetch', () => {
    // The default URL is absolute now, and node's fetch is real, so a suite that
    // reached uploadEvalPackage() unstubbed would store a package in ViA's inbox
    // on every test run (the relative URL it replaced simply threw in node).
    const root = fileURLToPath(new URL('../', import.meta.url));
    const suites = readdirSync(root, { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.test.ts'))
      .map((f) => [f, readFileSync(join(root, f), 'utf8')] as const)
      .filter(([, src]) => /\buploadEvalPackage\s*\(/.test(src));
    expect(suites.map(([f]) => f)).toContain(join('eval', 'evalUpload.test.ts'));
    for (const [f, src] of suites) expect(src, `${f} calls uploadEvalPackage without stubbing fetch`).toContain("vi.stubGlobal('fetch'");
  });

  it('still no-ops when the endpoint is switched off', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(uploadEvalPackage('x.zip', bytes, '', 'k')).resolves.toBe('disabled');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns ok on a 2xx and sends the name + key headers', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, text: async () => 'ok\n' }));
    vi.stubGlobal('fetch', fetchSpy);
    const r = await uploadEvalPackage('fastshaders-eval-p01-202608280000.zip', bytes, '/up.php', 'k');
    expect(r).toBe('ok');
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/up.php');
    expect((init.headers as Record<string, string>)['X-FS-Eval-Name']).toBe(
      'fastshaders-eval-p01-202608280000.zip',
    );
    expect((init.headers as Record<string, string>)['X-FS-Eval-Key']).toBe('k');
  });

  it('a 2xx is not enough: only the endpoint\'s own "ok" body counts as stored', async () => {
    // A PHP warning printed before upload.php's http_response_code(500) turned
    // a failed write into a 200 (display_errors defaults on without a php.ini).
    for (const body of ['<br />\n<b>Warning</b>: file_put_contents(): …write failed\n', 'write failed\n', '', 'okay']) {
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => body })));
      await expect(uploadEvalPackage('x.zip', bytes, '/up.php', 'k'), JSON.stringify(body)).resolves.toBe('failed');
    }
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => 'ok\n' })));
    await expect(uploadEvalPackage('x.zip', bytes, '/up.php', 'k')).resolves.toBe('ok');
  });

  it('collapses server refusal and network failure to failed, never throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, text: async () => 'refused\n' })));
    await expect(uploadEvalPackage('x.zip', bytes, '/up.php', 'k')).resolves.toBe('failed');

    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down');
    }));
    await expect(uploadEvalPackage('x.zip', bytes, '/up.php', 'k')).resolves.toBe('failed');
  });

  it('refuses over-cap payloads before shipping bytes, as its own outcome', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const huge = { length: 65 * 1024 * 1024 } as unknown as Uint8Array;
    await expect(uploadEvalPackage('x.zip', huge, '/up.php', 'k')).resolves.toBe('too-large');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('precheckEvalUpload — the outcomes known before any network I/O', () => {
  it('is null (go ahead) up to and including the cap, too-large one byte past it', () => {
    expect(precheckEvalUpload(MAX_UPLOAD_BYTES, '/up.php')).toBeNull();
    expect(precheckEvalUpload(MAX_UPLOAD_BYTES + 1, '/up.php')).toBe('too-large');
  });

  it('disabled wins, so a build with no endpoint never talks about size', () => {
    expect(precheckEvalUpload(0, '')).toBe('disabled');
    expect(precheckEvalUpload(MAX_UPLOAD_BYTES + 1, '')).toBe('disabled');
  });
});

describe('the client and server caps agree', () => {
  it('MAX_UPLOAD_BYTES is the server template’s $MAX_BYTES (64 MiB)', () => {
    expect(MAX_UPLOAD_BYTES).toBe(64 * 2 ** 20);
    // The live copy is rendered from this template (render-eval-endpoint.mjs
    // substitutes only secrets and the inbox), so this covers the deployed cap.
    const php = read('../../scripts/eval-endpoint/fastshaders-eval-upload.php');
    expect(php).toMatch(/\$MAX_BYTES\s*=\s*64\s*\*\s*1024\s*\*\s*1024\s*;/);
  });
});

describe('the N4 size figure', () => {
  // {size} is formatMiB(…, 'up'): rounding to nearest prints "64" for a package
  // one byte over the cap, i.e. "(64 MB; it accepts up to 64 MB)".
  it('never prints at the cap', () => {
    expect(formatMiB(MAX_UPLOAD_BYTES + 1, 'lv', 'up')).toBe('64,1');
    expect(formatMiB(MAX_UPLOAD_BYTES + 1, 'en', 'up')).toBe('64.1');
    expect(formatMiB(Math.round(65.34 * 2 ** 20), 'lv', 'up')).toBe('65,4');
    expect(formatMiB(100 * 2 ** 20, 'en', 'up')).toBe('100');
    for (let i = 1; i <= 20; i++) {
      const over = MAX_UPLOAD_BYTES + Math.ceil((i * 2 ** 20) / 20);
      expect(Number(formatMiB(over, 'en', 'up'))).toBeGreaterThan(64);
    }
  });
});

describe('SusModal renders the too-large outcome', () => {
  const sus = read('./SusModal.tsx');

  it('decides it synchronously and names the size it measured', () => {
    expect(sus).toContain('precheckEvalUpload(zipBytes.length)');
    expect(sus).toContain("done.upload === 'too-large'");
    expect(sus).toContain("formatMiB(done.zipBytes.length, language, 'up')");
    expect(sus).not.toContain('EVAL_UPLOAD_URL');
  });

  it('styles both failure outcomes as a warning and promotes Download for both', () => {
    const decl = sus.match(/const uploadWarn = ([^;]+);/);
    expect(decl, 'uploadWarn declaration').not.toBeNull();
    expect(decl![1]).toContain("'failed'");
    expect(decl![1]).toContain("'too-large'");
    expect(sus).toContain("uploadWarn ? 'eval-done__warn'");
    expect(sus).toContain("uploadWarn ? ' csv-import-modal__button--yes'");
  });

  it('the N4 key’s literal "64 MB" is the cap, and it has a Latvian entry', () => {
    expect(N4_KEY).toContain(`${MAX_UPLOAD_BYTES / 2 ** 20} MB`);
    expect(sus).toContain(`t('${N4_KEY}', language)`);
    expect(ui[N4_KEY]).toContain('{size}');
    expect(ui[N4_KEY]).toContain('64 MB');
  });
});

describe('every build posts to ViA’s endpoint cross-origin', () => {
  // Until 2026-11-09 the endpoint lived beside the app on alvismisjuns.lv and
  // was reached by a RELATIVE path, so the study host fs.sferas.lv had to name
  // it absolutely (its relative default 404ed: every package read "Upload
  // failed." until 2026-10-02). Now no app host has an endpoint: every build
  // posts to imgame.va.lv, and the pieces that must agree live in different
  // files — the URL's three copies, the build's connect-src, the endpoint's
  // origin list and its preflight AND POST answers, and the deploy gates.
  const sferas = read('../../scripts/deploy-sferas.sh');
  const alvis = read('../../scripts/deploy-alvismisjuns.sh');
  const gateScript = read('../../scripts/check-eval-upload.sh');
  const endpoint = read('../../scripts/deploy-eval-endpoint.sh');
  const vite = read('../../vite.config.ts');
  const php = read('../../scripts/eval-endpoint/fastshaders-eval-upload.php');
  const htaccess = read('../../scripts/eval-endpoint/htaccess');
  const ENDPOINT = EVAL_UPLOAD_URL;

  const shellVar = (src: string, name: string) => src.match(new RegExp(`^${name}="([^"]*)"`, 'm'))?.[1];
  const allowList = (header: string) =>
    (php.match(new RegExp(`header\\('${header}: ([^']*)'\\)`))?.[1] ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);
  const at = (src: string, needle: string) => {
    const i = src.indexOf(needle);
    expect(i, needle).toBeGreaterThan(-1);
    return i;
  };

  it('the URL has ONE value: vite.config.ts’s line, evalUpload.ts’s fallback, and what the shell gate reads', () => {
    const viteUrl = vite.match(/^const DEFAULT_EVAL_UPLOAD_URL = '([^']*)';$/m)?.[1];
    expect(viteUrl, 'DEFAULT_EVAL_UPLOAD_URL on one line, single-quoted (the gate seds it)').toBe(ENDPOINT);
    expect(read('./evalUpload.ts')).toContain(`(typeof __FS_EVAL_UPLOAD_URL__ === 'string' && __FS_EVAL_UPLOAD_URL__) || '${ENDPOINT}';`);
    expect(gateScript).toContain(`sed -n "s/^const DEFAULT_EVAL_UPLOAD_URL = '\\([^']*\\)';.*/\\1/p" "$ROOT/vite.config.ts"`);
    // An env override moves the build AND the gate, and empty means default in both.
    expect(vite).toContain('checkedEvalUploadUrl(process.env.FS_EVAL_UPLOAD_URL || DEFAULT_EVAL_UPLOAD_URL)');
    expect(gateScript).toContain('UPLOAD_URL="${FS_EVAL_UPLOAD_URL:-$(sed');
    expect(vite).toContain('__FS_EVAL_UPLOAD_URL__: JSON.stringify(FS_EVAL_UPLOAD_URL)');
    // No host deploy overrides it any more: one source.
    for (const script of [sferas, alvis]) expect(script).not.toMatch(/FS_EVAL_UPLOAD_URL=/);
  });

  it("the endpoint's origin joins every build's connect-src", () => {
    expect(vite).toMatch(/const CONNECT_SRC = \[[\s\S]*?EVAL_UPLOAD_ORIGIN[\s\S]*?\]/);
    expect(vite).toContain('`connect-src ${CONNECT_SRC}`');
  });

  it('the endpoint admits exactly the app origins, never a wildcard', () => {
    const list = php.match(/^\$ALLOWED_ORIGINS\s*=\s*\[([^\]]*)\];/m);
    expect(list, '$ALLOWED_ORIGINS').not.toBeNull();
    const origins = [...list![1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
    // The hosts the app is served from, each named where its build is made:
    // the study host, alvismisjuns (apex + www, both checked by its deploy) and
    // GitHub Pages (the origin vite.config.ts already lists in connect-src).
    const alvisOrigins = alvis.match(/^for ORIGIN in ([^;]+); do$/m)?.[1].trim().split(/\s+/) ?? [];
    expect(alvisOrigins).toEqual(['https://alvismisjuns.lv', 'https://www.alvismisjuns.lv']);
    expect(alvis).toContain(`FS_PREVIEW_ORIGIN='${alvisOrigins.join(' ')}'`);
    expect(vite).toContain("'https://alvis1.github.io'");
    const appOrigins = [shellVar(sferas, 'ORIGIN'), ...alvisOrigins, 'https://alvis1.github.io'];
    expect([...origins].sort()).toEqual([...appOrigins].sort());
    expect(php).not.toMatch(/Access-Control-Allow-Origin:\s*\*/);
    // Echoed back only after an exact, strict-typed membership test.
    expect(php).toMatch(/in_array\(\$origin, \$ALLOWED_ORIGINS, true\)/);
  });

  it('answers the preflight, and sets Allow-Origin before any refusal can exit', () => {
    const allowOrigin = at(php, "header('Access-Control-Allow-Origin: '");
    const preflight = at(php, "=== 'OPTIONS') { http_response_code(204); exit; }");
    // Every refusal below must carry the header too, or the browser hides the
    // status from fetch(); and the preflight must be answered before POST-only.
    expect(allowOrigin).toBeLessThan(preflight);
    expect(preflight).toBeLessThan(at(php, "!== 'POST'"));
    expect(preflight).toBeLessThan(at(php, 'hash_equals('));
    expect(allowList('Access-Control-Allow-Methods')).toContain('post');
  });

  it('allows every header uploadEvalPackage actually sends', async () => {
    // A header added to the fetch but not to Allow-Headers fails ONLY
    // cross-origin — which is now every upload, as "Upload failed.".
    const fetchSpy = vi.fn(async () => ({ ok: true, text: async () => 'ok\n' }));
    vi.stubGlobal('fetch', fetchSpy);
    await uploadEvalPackage('fastshaders-eval-p01-202610021200.zip', bytes, ENDPOINT, 'k');
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    const sent = Object.keys(init.headers as Record<string, string>).map((h) => h.toLowerCase());
    expect(sent.length).toBeGreaterThan(0);
    const allowed = allowList('Access-Control-Allow-Headers');
    for (const h of sent) expect(allowed, `${h} is not in Access-Control-Allow-Headers`).toContain(h);
    expect(init.method).toBe('POST');
    expect(init.credentials, 'no cookies cross-origin, so no Allow-Credentials').toBeUndefined();
  });

  it('every gate judges the live preflight the way a browser does', () => {
    // Allow-Origin alone passed a preflight Chrome rejects: a 405 that still
    // carries it, or an Allow-Headers list one header short. The gates also
    // require a 2xx and every header the client sends, and ask for exactly the
    // template's list (pinned ⊇ the client above), so a header added to the
    // client fails the DEPLOY while the live endpoint still lacks it.
    expect(gateScript).toContain('-X OPTIONS "$UPLOAD_URL"');
    expect(gateScript).toContain('-H "Access-Control-Request-Headers: $REQ_HEADERS"');
    expect(gateScript).toMatch(/\[ "\$PF_OK" = 1 \] && \[ "\$CORS" = "\$ORIGIN" \] && \[ -z "\$MISSING" \]/);
    // The endpoint deploy asks from EVERY admitted origin, and a foreign one must get none.
    expect(endpoint).toContain('-H "Access-Control-Request-Headers: $REQ_HEADERS"');
    expect(endpoint).toContain('for o in $ORIGINS; do');
    expect(endpoint).toMatch(/\[ "\$PF_OK" = 1 \] && \[ "\$PF_ORIGIN" = "\$o" \] && \[ -z "\$MISSING" \]/);
    expect(endpoint).toContain('[ -z "$PF_FAILED" ] && [ -z "$CORS_OTHER" ]');
    for (const script of [gateScript, endpoint]) expect(script).toMatch(/case "\$\w+_STATUS" in 2\?\?\)/);
  });

  it('both host deploys run the gate BEFORE they build or upload', () => {
    // Checked after the upload, a lagging endpoint failed the deploy with the
    // new client already live — every study upload broken, not just the deploy.
    for (const [name, script] of [['sferas', sferas], ['alvismisjuns', alvis]] as const) {
      const gate = at(script, 'bash "$ROOT/scripts/check-eval-upload.sh" "$ORIGIN"');
      expect(gate, name).toBeLessThan(at(script, '==> building'));
      expect(gate, name).toBeLessThan(at(script, '==> uploading'));
      // ...and after the upload, the served CSP must let the page reach it.
      expect(script, name).toContain('grep -cF "$UPLOAD_ORIGIN"');
    }
    expect(endpoint.indexOf('REQ_HEADERS="$(sed')).toBeLessThan(at(endpoint, '==> uploading'));
  });

  it('the gates prove the inbox can STORE, through list.php?health', () => {
    // Every other check is answered before upload.php writes, so all of them
    // stayed green from 2026-10-08 to 10-20 while the old endpoint's rebuilt
    // container had /app read-only and every real package answered 500.
    const list = read('../../scripts/eval-endpoint/fastshaders-eval-list.php');
    // A real write, behind the inbox's own login, under a name the listing
    // (which shows only .zip) never displays.
    expect(at(list, 'http_response_code(401)')).toBeLessThan(at(list, "if (isset($_GET['health']))"));
    expect(list).toContain("$probe = $dir . '/.fs-health-'");
    expect(list).toContain("@fopen($probe, 'x')");
    expect(list).toContain('@unlink($probe)');
    expect(list).toContain("http_response_code($healthy ? 200 : 503)");
    expect(list).toContain("'inbox ok: '");
    // The listing page raises the same alarm, so the researcher sees it too.
    expect(list).toContain('[$inboxOk, $inboxWhy] = inbox_health($INBOX);');

    const gate = '[ "${HEALTH#inbox ok:}" != "$HEALTH" ]';
    for (const script of [gateScript, endpoint]) {
      expect(script).toContain('list.php?health');
      expect(script).toContain(gate);
    }
    expect(at(endpoint, gate)).toBeLessThan(at(endpoint, 'endpoint live ✓'));
  });

  it('the endpoint deploy proves the whole path with a real package, and removes it', () => {
    // The only check that reaches the disk through Cloudflare and the PHP size
    // limit, from the study origin — then back out through list.php, and NOT
    // out through a plain URL (the ViA inbox sits inside the web root).
    expect(endpoint).toContain('PROBE_BYTES=$((16 * 1024 * 1024))');
    expect(endpoint).toContain('-H "Origin: $STUDY_ORIGIN"');
    expect(endpoint).toContain('[ "$POST_ORIGIN" = "$STUDY_ORIGIN" ]');
    expect(endpoint).toContain('[ "$STORED_BYTES" = "$PROBE_BYTES" ]');
    expect(endpoint).toContain('cmp -s "$STAGE/probe.zip" "$STAGE/back.zip"');
    expect(endpoint).toContain('denied "$DIRECT" && denied "$LISTING"');
    expect(endpoint).toContain('[ "$LEFT" = 0 ]');
    // Its name passes upload.php's own pattern (else the probe tests a refusal).
    const namePattern = php.match(/preg_match\('\/(\^fastshaders-eval-[^']*)\/', \$name\)/)?.[1];
    expect(namePattern, 'upload.php name pattern').toBeTruthy();
    expect(new RegExp(namePattern!.replace(/\\d/g, '\\d')).test('fastshaders-eval-deploy-check-202611091025.zip')).toBe(true);
    expect(endpoint).toContain('PROBE_NAME="fastshaders-eval-deploy-check-$(date -u +%Y%m%d%H%M).zip"');
    // The SSH password reaches psftp/plink as a 0600 FILE, never through argv.
    expect(endpoint).toContain('-pwfile "$STAGE/pw"');
    expect(endpoint).toContain('mode: 0o600');
    expect(endpoint).not.toMatch(/\s-pw\s/);
  });

  it("the endpoint folder's .htaccess lifts post_max_size above the cap and serves only the two scripts", () => {
    // A package is the raw request body, so post_max_size is the limit that
    // applies — php:8-apache leaves it at 8M, which refused anything bigger.
    const m = htaccess.match(/^\s*php_value post_max_size (\d+)M$/m);
    expect(m, 'php_value post_max_size').not.toBeNull();
    expect(Number(m![1]) * 2 ** 20).toBeGreaterThan(MAX_UPLOAD_BYTES);
    expect(htaccess).toMatch(/<FilesMatch "\^\(\?!\(upload\|list\)\\\.php\$\)">\s*Require all denied\s*<\/FilesMatch>/);
    expect(htaccess).toContain('Options -Indexes');
    expect(endpoint).toContain('put \\"$ROOT/scripts/eval-endpoint/htaccess\\" .htaccess');
    // The inbox gets its own deny rule too, written by the deploy.
    expect(endpoint).toContain("printf 'Require all denied\\n' > '$HOST_INBOX/.htaccess'");
  });

  it('the listing password is long, and list.php only ever holds its hash', () => {
    // Until 2026-11-09 it was a 4-digit number in plain text behind the
    // documented username `researcher`: every package was minutes of guessing away.
    const list = read('../../scripts/eval-endpoint/fastshaders-eval-list.php');
    expect(list).toContain("hash_equals($VIEW_PASSWORD_SHA256, hash('sha256', $pass))");
    expect(list).not.toMatch(/\$VIEW_PASSWORD\s*=/);
    const dir = mkdtempSync(join(tmpdir(), 'fs-render-'));
    try {
      const tpl = fileURLToPath(new URL('../../scripts/eval-endpoint', import.meta.url));
      const script = fileURLToPath(new URL('../../scripts/render-eval-endpoint.mjs', import.meta.url));
      const render = (viewPassword: string) => {
        const conf = join(dir, 'conf.json');
        writeFileSync(conf, JSON.stringify({ uploadKey: 'k-public', viewUser: 'researcher', viewPassword, inboxDir: '/x/inbox-1' }));
        return execFileSync(process.execPath, [script, tpl, dir, conf], { stdio: 'pipe' });
      };
      expect(() => render('1234')).toThrow(/at least 20 characters/);
      expect(() => render('k-public')).toThrow();
      const strong = 'correct-horse-battery-staple-42';
      render(strong);
      const out = readFileSync(join(dir, 'list.php'), 'utf8');
      expect(out).not.toContain(strong);
      expect(out).toContain(`$VIEW_PASSWORD_SHA256 = '${createHash('sha256').update(strong).digest('hex')}';`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('PHP never prints an error into an answer, and a full disk refuses before writing', () => {
    // display_errors defaults ON without a php.ini (the ViA container has none):
    // a warning printed before http_response_code(500) sent the headers as 200.
    for (const f of ['fastshaders-eval-upload.php', 'fastshaders-eval-list.php']) {
      const src = read(`../../scripts/eval-endpoint/${f}`);
      expect(src.indexOf("ini_set('display_errors', '0');"), f).toBeGreaterThan(-1);
      expect(src.indexOf("ini_set('display_errors', '0');"), f).toBeLessThan(src.indexOf('header('));
    }
    expect(htaccess).toMatch(/php_flag display_errors off/);
    // The inbox shares its disk with the ImGame site and the key is public.
    expect(php).toMatch(/\$MIN_FREE_BYTES = 1024 \* 1024 \* 1024;/);
    expect(at(php, 'http_response_code(507)')).toBeLessThan(at(php, 'file_put_contents($target'));
  });

  it('the endpoint deploy checks the app’s own key, reports a failed upload, and never writes through a link', () => {
    expect(endpoint).toContain('[ "$APP_KEY" = "$UPLOAD_KEY" ]');
    expect(endpoint).toContain(`sed -n "s/^export const EVAL_UPLOAD_KEY: string = '\\([^']*\\)';.*/\\1/p" "$ROOT/src/eval/evalUpload.ts"`);
    expect(read('./evalUpload.ts')).toMatch(/^export const EVAL_UPLOAD_KEY: string = '[^']+';$/m);
    expect(endpoint).toContain('if ! PSFTP_OUT="$(psftp');
    // Root writes inside a www-data folder: remove, then create with noclobber.
    expect(endpoint).toContain("rm -f '$HOST_INBOX/.htaccess'");
    expect(endpoint).toContain('(umask 022; set -C; printf');
    expect(endpoint).not.toMatch(/chmod 644 '\$HOST_INBOX/);
  });

  it("the gates' header extraction reads the template's Allow-Headers line", () => {
    // Both scripts take REQ_HEADERS with this sed expression; if the PHP line
    // is ever reformatted they stop with "cannot read Access-Control-Allow-Headers"
    // at deploy time — this catches it in the suite instead.
    for (const script of [gateScript, endpoint]) {
      expect(script).toContain(`sed -n "s/.*header('Access-Control-Allow-Headers: \\([^']*\\)').*/\\1/p"`);
    }
    const extracted = php
      .split('\n')
      .map((line) => line.match(/.*header\('Access-Control-Allow-Headers: ([^']*)'\).*/)?.[1])
      .find((v) => v !== undefined);
    expect(extracted?.toLowerCase().replace(/ /g, '').split(',')).toEqual(allowList('Access-Control-Allow-Headers'));
  });
});

describe('evalUpload.ts header', () => {
  it('no longer claims a CSP block, and names the endpoint host and the study host', () => {
    const src = read('./evalUpload.ts');
    expect(src).not.toMatch(/CSP[- ]block/i);
    expect(src).toContain('imgame.va.lv');
    expect(src).toContain('fs.sferas.lv');
  });
});
