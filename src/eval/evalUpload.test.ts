import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('uploadEvalPackage', () => {
  it('points at the study endpoint as a RELATIVE path by default', async () => {
    // Relative keeps the POST inside the app's own CSP (`connect-src 'self' …`)
    // on every host — but it also means it only reaches an endpoint where one
    // exists (alvismisjuns.lv). vitest runs the default build (no
    // FS_EVAL_UPLOAD_URL); the fs.sferas.lv build overrides it, pinned below.
    expect(EVAL_UPLOAD_URL).toBe('/fastshaders-eval/upload.php');
    expect(EVAL_UPLOAD_URL.startsWith('/')).toBe(true);
  });

  it('still no-ops when the endpoint is switched off', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(uploadEvalPackage('x.zip', bytes, '', 'k')).resolves.toBe('disabled');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns ok on a 2xx and sends the name + key headers', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true }));
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

  it('collapses server refusal and network failure to failed, never throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
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
    const php = read('../../server/fastshaders-eval-upload.php');
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

describe('the study host posts to alvismisjuns cross-origin', () => {
  // fs.sferas.lv is static nginx: the relative default 404ed there, so every
  // study package read "Upload failed." (reported 2026-10-02). Four pieces must
  // agree, and each lives in a different file: the sferas build's absolute URL,
  // its connect-src, and the endpoint's preflight AND POST answers.
  const sferas = read('../../scripts/deploy-sferas.sh');
  const vite = read('../../vite.config.ts');
  const php = read('../../server/fastshaders-eval-upload.php');
  const ENDPOINT = 'https://alvismisjuns.lv/fastshaders-eval/upload.php';

  const shellVar = (name: string) => sferas.match(new RegExp(`^${name}="([^"]*)"`, 'm'))?.[1];
  const allowList = (header: string) =>
    (php.match(new RegExp(`header\\('${header}: ([^']*)'\\)`))?.[1] ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);

  it('the sferas build names the endpoint absolutely, through the vite define', () => {
    expect(shellVar('UPLOAD_URL')).toBe(ENDPOINT);
    expect(shellVar('ORIGIN')).toBe('https://fs.sferas.lv');
    expect(sferas).toMatch(/FS_EVAL_UPLOAD_URL="\$UPLOAD_URL"\s*\\\n\s*npm run build/);
    expect(vite).toContain('checkedEvalUploadUrl(process.env.FS_EVAL_UPLOAD_URL');
    expect(vite).toContain('__FS_EVAL_UPLOAD_URL__: JSON.stringify(FS_EVAL_UPLOAD_URL)');
    expect(read('./evalUpload.ts')).toContain('__FS_EVAL_UPLOAD_URL__');
  });

  it("an absolute endpoint's origin joins the build's connect-src", () => {
    expect(vite).toMatch(/const CONNECT_SRC = \[[\s\S]*?EVAL_UPLOAD_ORIGIN[\s\S]*?\]/);
    expect(vite).toContain('`connect-src ${CONNECT_SRC}`');
  });

  it('the endpoint admits exactly the study origin, never a wildcard', () => {
    const list = php.match(/^\$ALLOWED_ORIGINS\s*=\s*\[([^\]]*)\];/m);
    expect(list, '$ALLOWED_ORIGINS').not.toBeNull();
    const origins = [...list![1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
    expect(origins).toEqual([shellVar('ORIGIN')]);
    expect(php).not.toMatch(/Access-Control-Allow-Origin:\s*\*/);
    // Echoed back only after an exact, strict-typed membership test.
    expect(php).toMatch(/in_array\(\$origin, \$ALLOWED_ORIGINS, true\)/);
  });

  it('answers the preflight, and sets Allow-Origin before any refusal can exit', () => {
    const at = (needle: string) => {
      const i = php.indexOf(needle);
      expect(i, needle).toBeGreaterThan(-1);
      return i;
    };
    const allowOrigin = at("header('Access-Control-Allow-Origin: '");
    const preflight = at("=== 'OPTIONS') { http_response_code(204); exit; }");
    // Every refusal below must carry the header too, or the browser hides the
    // status from fetch(); and the preflight must be answered before POST-only.
    expect(allowOrigin).toBeLessThan(preflight);
    expect(preflight).toBeLessThan(at("!== 'POST'"));
    expect(preflight).toBeLessThan(at('hash_equals('));
    expect(allowList('Access-Control-Allow-Methods')).toContain('post');
  });

  it('allows every header uploadEvalPackage actually sends', async () => {
    // A header added to the fetch but not to Allow-Headers fails ONLY
    // cross-origin — i.e. only on the study host, and only as "Upload failed.".
    const fetchSpy = vi.fn(async () => ({ ok: true }));
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

  it('both deploy gates judge the live preflight the way a browser does', () => {
    // Allow-Origin alone passed a preflight Chrome rejects: a 405 that still
    // carries it, or an Allow-Headers list one header short. Both gates also
    // require a 2xx and every header the client sends, and ask for exactly
    // the template's list (pinned ⊇ the client above), so a header added to the
    // client fails the DEPLOY while the live endpoint still lacks it.
    const endpoint = read('../../scripts/deploy-eval-endpoint.sh');
    expect(sferas).toContain('-X OPTIONS "$UPLOAD_URL"');
    expect(sferas).toContain('-H "Access-Control-Request-Headers: $REQ_HEADERS"');
    expect(sferas).toMatch(/\[ "\$PF_OK" = 1 \] && \[ "\$CORS" = "\$ORIGIN" \] && \[ -z "\$MISSING" \]/);
    expect(endpoint).toContain('-H "Access-Control-Request-Headers: $REQ_HEADERS"');
    expect(endpoint).toMatch(
      /\[ "\$STUDY_OK" = 1 \] && \[ "\$CORS_STUDY" = "https:\/\/fs\.sferas\.lv" \] && \[ -z "\$MISSING" \] && \[ -z "\$CORS_OTHER" \]/,
    );
    for (const script of [sferas, endpoint]) expect(script).toMatch(/case "\$\w+_STATUS" in 2\?\?\)/);
  });

  it('the sferas deploy judges the endpoint BEFORE it builds or uploads', () => {
    // Checked after the upload, a lagging endpoint failed the deploy with the
    // new client already live — every study upload broken, not just the deploy.
    const gate = sferas.indexOf('[ "$PF_OK" = 1 ] && [ "$CORS" = "$ORIGIN" ] && [ -z "$MISSING" ]');
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(sferas.indexOf('==> building'));
    expect(gate).toBeLessThan(sferas.indexOf('==> uploading'));
    const endpoint = read('../../scripts/deploy-eval-endpoint.sh');
    expect(endpoint.indexOf('REQ_HEADERS="$(sed')).toBeLessThan(endpoint.indexOf('==> uploading'));
  });

  it("the gates' header extraction reads the template's Allow-Headers line", () => {
    // Both scripts take REQ_HEADERS with this sed expression; if the PHP line
    // is ever reformatted they stop with "cannot read Access-Control-Allow-Headers"
    // at deploy time — this catches it in the suite instead.
    for (const script of [sferas, read('../../scripts/deploy-eval-endpoint.sh')]) {
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
  it('no longer claims a CSP block, and names the real study host', () => {
    const src = read('./evalUpload.ts');
    expect(src).not.toMatch(/CSP[- ]block/i);
    expect(src).toContain('fs.sferas.lv');
  });
});
