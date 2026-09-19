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
  it('points at the study endpoint as a RELATIVE path', async () => {
    // Relative keeps the POST inside the app's own CSP (`connect-src 'self' …`)
    // on every host — but it also means it only reaches an endpoint where one
    // exists (alvismisjuns.lv; fs.sferas.lv 404s, see evalUpload.ts's header).
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

describe('evalUpload.ts header', () => {
  it('no longer claims a CSP block, and names the real study host', () => {
    const src = read('./evalUpload.ts');
    expect(src).not.toMatch(/CSP[- ]block/i);
    expect(src).toContain('fs.sferas.lv');
  });
});
