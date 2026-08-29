import { describe, it, expect, afterEach, vi } from 'vitest';
import { EVAL_UPLOAD_URL, uploadEvalPackage } from './evalUpload';

const bytes = new TextEncoder().encode('PK\x03\x04fake');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('uploadEvalPackage', () => {
  it('points at the study endpoint as a SAME-ORIGIN path', async () => {
    // Same-origin is what keeps the POST inside the app's own CSP
    // (`connect-src 'self' …`) — an absolute URL to another host would be
    // blocked at runtime with nothing but a console error to show for it.
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
      throw new Error('CSP blocked');
    }));
    await expect(uploadEvalPackage('x.zip', bytes, '/up.php', 'k')).resolves.toBe('failed');
  });

  it('refuses over-cap payloads before shipping bytes', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const huge = { length: 65 * 1024 * 1024 } as unknown as Uint8Array;
    await expect(uploadEvalPackage('x.zip', huge, '/up.php', 'k')).resolves.toBe('failed');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
