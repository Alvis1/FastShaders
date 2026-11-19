/**
 * The local server's address. `isLoopbackBase` must agree with Rust's
 * `parse_base` and `normalizeLocalBase` must only ever produce what that
 * boundary accepts — both checked over the SAME vector file the Rust tests
 * read (src-tauri/tests/llm-urls.json), so neither side can drift alone.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LLM_LOCAL_GET_ROUTES, LLM_LOCAL_POST_ROUTES, LLM_MAX_REQUEST_BYTES } from '@/utils/desktopIpc';
import { DEFAULT_LOCAL_BASE, isLoopbackBase, normalizeLocalBase, requestRefusal } from './endpoint';

interface UrlCase {
  input: string;
  rust: boolean;
  normalized: string | null;
  why: string;
}

const VECTORS = fileURLToPath(new URL('../../src-tauri/tests/llm-urls.json', import.meta.url));
const raw = readFileSync(VECTORS);
const { cases } = JSON.parse(raw.toString('utf8')) as { cases: UrlCase[] };

describe('the shared base-URL vectors', () => {
  it('are there, and plain ASCII (non-ASCII cases are \\u escapes, so the file stays greppable)', () => {
    expect(cases.length).toBeGreaterThanOrEqual(40);
    expect(raw.every((b) => b < 0x80)).toBe(true);
    // Both verdicts are represented, and the UX normalizer forgives something
    // the boundary refuses.
    expect(cases.some((c) => c.rust)).toBe(true);
    expect(cases.some((c) => !c.rust && c.normalized !== null)).toBe(true);
  });

  it('isLoopbackBase is Rust parse_base, row for row', () => {
    for (const c of cases) expect(isLoopbackBase(c.input), `${JSON.stringify(c.input)} (${c.why})`).toBe(c.rust);
  });

  it('normalizeLocalBase gives each row its expected base', () => {
    for (const c of cases) {
      expect(normalizeLocalBase(c.input), `${JSON.stringify(c.input)} (${c.why})`).toBe(c.normalized);
    }
  });

  it('whatever it produces passes the boundary, has no trailing slash and is a fixed point', () => {
    for (const c of cases) {
      if (c.normalized === null) continue;
      expect(isLoopbackBase(c.normalized), c.normalized).toBe(true);
      expect(c.normalized.endsWith('/'), c.normalized).toBe(false);
      expect(normalizeLocalBase(c.normalized)).toBe(c.normalized);
    }
  });

  it('a base the boundary takes verbatim normalizes to itself, minus a trailing slash', () => {
    for (const c of cases) {
      if (c.rust) expect(c.normalized, c.input).toBe(c.input.replace(/\/$/, ''));
    }
  });
});

describe('normalizeLocalBase', () => {
  it('keeps the default', () => {
    expect(normalizeLocalBase(DEFAULT_LOCAL_BASE)).toBe(DEFAULT_LOCAL_BASE);
  });

  it('never folds a non-ASCII letter into an ASCII host', () => {
    // U+212A KELVIN SIGN lower-cases to ASCII "k"; U+0130 to "i" + a combining dot.
    expect(normalizeLocalBase('http://Kocalhost:1234')).toBeNull();
    expect(normalizeLocalBase('http://localhost:1234 ')).toBe('http://localhost:1234');
    expect(normalizeLocalBase('http://lİcalhost:1234')).toBeNull();
  });
});

describe('requestRefusal (what Rust refuses before it connects)', () => {
  const base = 'http://127.0.0.1:1234';

  it('lets an allowed request through', () => {
    expect(requestRefusal(base, '/v1/models', LLM_LOCAL_GET_ROUTES)).toBeNull();
    expect(requestRefusal(base, '/api/chat', LLM_LOCAL_POST_ROUTES, '{}')).toBeNull();
  });

  it('checks the base, then the route, then the size — as Rust does', () => {
    const huge = 'x'.repeat(LLM_MAX_REQUEST_BYTES + 1);
    expect(requestRefusal('http://127.1:1234', '/nope', LLM_LOCAL_POST_ROUTES, huge)).toEqual({
      ok: false,
      code: 'BAD_URL',
      detail: '',
    });
    expect(requestRefusal(base, '/v1/models', LLM_LOCAL_POST_ROUTES, huge)).toEqual({
      ok: false,
      code: 'BAD_ROUTE',
      detail: '',
    });
    expect(requestRefusal(base, '/api/chat', LLM_LOCAL_POST_ROUTES, huge)).toEqual({
      ok: false,
      code: 'TOO_LARGE',
      detail: `${LLM_MAX_REQUEST_BYTES + 1} ${LLM_MAX_REQUEST_BYTES}`,
    });
  });

  it('counts the body in UTF-8 bytes, as Rust does', () => {
    // "ā" is two bytes: half the cap in characters is exactly the cap.
    const half = LLM_MAX_REQUEST_BYTES / 2;
    expect(requestRefusal(base, '/api/chat', LLM_LOCAL_POST_ROUTES, 'ā'.repeat(half))).toBeNull();
    expect(requestRefusal(base, '/api/chat', LLM_LOCAL_POST_ROUTES, 'ā'.repeat(half) + 'x')).toEqual({
      ok: false,
      code: 'TOO_LARGE',
      detail: `${LLM_MAX_REQUEST_BYTES + 1} ${LLM_MAX_REQUEST_BYTES}`,
    });
  });

  it('routes are exact strings', () => {
    for (const path of ['/v1/models/', '/V1/models', '/v1/models?x', 'v1/models', '/api/generate', '']) {
      expect(requestRefusal(base, path, LLM_LOCAL_GET_ROUTES)?.code, path).toBe('BAD_ROUTE');
    }
  });
});
