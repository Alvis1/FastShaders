/**
 * The KTX2 encoder seam (Phase 8, Step 1), with a STUB encoder: no encoder
 * ships in this phase, so the registry, the per-slot planning, the output
 * validation and the never-rejecting checked call are pinned against fixture
 * bytes (three r184's own KTX2 test textures) instead of a real encode.
 *
 * `isolate: false`: the registry is module state shared by every file in the
 * worker, so it is reset in afterEach.
 */
import { afterEach, describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  KTX2_DEFAULT_ZSTD,
  KTX2_MAX_DIM,
  KTX2_MAX_OUTPUT_BYTES,
  KTX2_MIME,
  encodeKtx2Checked,
  expectedKtx2Levels,
  getKtx2Encoder,
  hasKtx2Encoder,
  ktx2Eligible,
  ktx2RequestFor,
  setKtx2Encoder,
  validateKtx2Output,
  type Ktx2EncodeRequest,
  type Ktx2Encoder,
} from './ktx2Encoder';

const fixture = (f: string) => new Uint8Array(readFileSync(new URL(`../engine/fixtures/ktx2/${f}`, import.meta.url)));
const UASTC = fixture('2d_uastc.ktx2');
const ETC1S = fixture('2d_etc1s.ktx2');
const RGBA8 = fixture('2d_rgba8.ktx2');

const withU32 = (bytes: Uint8Array, at: number, value: number) => {
  const copy = bytes.slice();
  new DataView(copy.buffer).setUint32(at, value, true);
  return copy;
};
/** A copy whose KVD is one `KTXorientation` entry, appended after the level data. */
function withOrientation(bytes: Uint8Array, value: string): Uint8Array {
  const length = 'KTXorientation'.length + 1 + value.length + 1;
  const entry = new Uint8Array(4 + length + ((4 - (length % 4)) % 4));
  new DataView(entry.buffer).setUint32(0, length, true);
  [...`KTXorientation\0${value}\0`].forEach((c, i) => (entry[4 + i] = c.charCodeAt(0)));
  const out = new Uint8Array(bytes.length + entry.length);
  out.set(bytes);
  out.set(entry, bytes.length);
  new DataView(out.buffer).setUint32(56, bytes.length, true);
  new DataView(out.buffer).setUint32(60, entry.length, true);
  return out;
}

const request = (over: Partial<Ktx2EncodeRequest> = {}): Ktx2EncodeRequest => {
  const width = over.width ?? 40;
  const height = over.height ?? 40;
  return {
    rgba: new Uint8Array(Math.max(0, width * height * 4) || 0),
    width,
    height,
    colorSpace: 'srgb',
    mipmaps: true,
    normalMap: false,
    mode: 'uastc',
    zstdLevel: KTX2_DEFAULT_ZSTD,
    ...over,
  };
};

function stub(encode: Ktx2Encoder['encode']): Ktx2Encoder & { calls: number } {
  const s = {
    id: 'stub',
    version: '0',
    where: 'test' as const,
    calls: 0,
    encode(req: Ktx2EncodeRequest, signal?: AbortSignal) {
      s.calls++;
      return encode(req, signal);
    },
  };
  return s;
}
const returning = (bytes: Uint8Array) => stub(async () => bytes);

afterEach(() => setKtx2Encoder(null));

describe('the registry', () => {
  it('is empty by default (no encoder ships), and set/get/has round-trip', () => {
    expect(getKtx2Encoder()).toBeNull();
    expect(hasKtx2Encoder()).toBe(false);
    const enc = returning(UASTC);
    setKtx2Encoder(enc);
    expect(getKtx2Encoder()).toBe(enc);
    expect(hasKtx2Encoder()).toBe(true);
    setKtx2Encoder(null);
    expect(hasKtx2Encoder()).toBe(false);
  });

  it('records the owner\'s settings: UASTC + zstd 18, and the image/ktx2 mime', () => {
    expect(KTX2_DEFAULT_ZSTD).toBe(18);
    expect(KTX2_MIME).toBe('image/ktx2');
    expect(KTX2_MAX_DIM).toBe(4096);
    expect(KTX2_MAX_OUTPUT_BYTES).toBe(32 * 1024 * 1024);
  });
});

describe('planning', () => {
  it('ktx2Eligible: integer sides, multiples of 4, within [4, 4096]', () => {
    expect(ktx2Eligible(40, 40)).toEqual({ ok: true });
    expect(ktx2Eligible(4, 4096)).toEqual({ ok: true });
    expect(ktx2Eligible(42, 40)).toEqual({ ok: false, reason: 'not-multiple-of-4' });
    expect(ktx2Eligible(40, 42)).toEqual({ ok: false, reason: 'not-multiple-of-4' });
    expect(ktx2Eligible(8192, 40)).toEqual({ ok: false, reason: 'too-large' });
    expect(ktx2Eligible(40, 4100)).toEqual({ ok: false, reason: 'too-large' });
    expect(ktx2Eligible(0, 40)).toEqual({ ok: false, reason: 'too-small' });
    expect(ktx2Eligible(40, -4)).toEqual({ ok: false, reason: 'too-small' });
    for (const junk of [NaN, Infinity, 40.5, '40' as unknown as number, null as unknown as number]) {
      expect(ktx2Eligible(junk, 40).ok).toBe(false);
      expect(ktx2Eligible(40, junk).ok).toBe(false);
    }
  });

  it('expectedKtx2Levels is floor(log2(max side)) + 1 with mipmaps, else 1', () => {
    expect(expectedKtx2Levels(40, 40, true)).toBe(6);
    expect(expectedKtx2Levels(40, 40, false)).toBe(1);
    expect(expectedKtx2Levels(4096, 4, true)).toBe(13);
    expect(expectedKtx2Levels(4, 4, true)).toBe(3);
    expect(expectedKtx2Levels(64, 32, true)).toBe(7);
    expect(expectedKtx2Levels(NaN, 40, true)).toBe(1);
  });

  it('ktx2RequestFor: colour slots are sRGB, normal and data are linear, always UASTC + zstd 18', () => {
    const px = { rgba: new Uint8Array(40 * 40 * 4), width: 40, height: 40 };
    const plan = (slot: Parameters<typeof ktx2RequestFor>[0], mipmapped = true) => {
      const r = ktx2RequestFor(slot, px, { mipmapped });
      expect(r.rgba).toBe(px.rgba);
      expect([r.width, r.height, r.mode, r.zstdLevel]).toEqual([40, 40, 'uastc', 18]);
      return [r.colorSpace, r.normalMap, r.mipmaps];
    };
    expect(plan('baseColor')).toEqual(['srgb', false, true]);
    expect(plan('emissive')).toEqual(['srgb', false, true]);
    expect(plan('normal')).toEqual(['linear', true, true]);
    expect(plan('data', false)).toEqual(['linear', false, false]);
  });
});

describe('validateKtx2Output', () => {
  const req = { width: 40, height: 40, colorSpace: 'srgb', mipmaps: true, mode: 'uastc' } as const;

  it('accepts 2d_uastc.ktx2 for a 40x40 sRGB mipmapped UASTC request', () => {
    expect(validateKtx2Output(UASTC, req)).toEqual({ ok: true });
    // UASTC may be zstd-supercompressed; the header alone decides.
    expect(validateKtx2Output(withU32(UASTC, 44, 2), req)).toEqual({ ok: true });
    expect(validateKtx2Output(ETC1S, { ...req, mode: 'etc1s' })).toEqual({ ok: true });
    expect(validateKtx2Output(withOrientation(UASTC, 'rd'), req)).toEqual({ ok: true });
    expect(validateKtx2Output(withOrientation(UASTC, 'rdi'), req)).toEqual({ ok: true });
  });

  it.each([
    ['color-space', UASTC, { ...req, colorSpace: 'linear' as const }],
    ['size', UASTC, { ...req, width: 20, height: 20 }],
    ['size', UASTC, { ...req, width: 40, height: 44 }],
    ['size', withU32(UASTC, 36, 6), req],
    // KHR_texture_basisu: pixelDepth and layerCount must be 0, not merely <= 1.
    ['size', withU32(UASTC, 28, 1), req],
    ['size', withU32(UASTC, 32, 1), req],
    ['levels', UASTC, { ...req, mipmaps: false }],
    ['not-basis', RGBA8, req],
    ['mode', ETC1S, req],
    ['mode', UASTC, { ...req, mode: 'etc1s' as const }],
    ['mode', withU32(UASTC, 44, 1), req],
    ['orientation', withOrientation(UASTC, 'ru'), req],
    ['orientation', withOrientation(UASTC, ''), req],
    ['not-ktx2', UASTC.slice(0, 100), req],
    ['not-ktx2', new Uint8Array(64), req],
  ])('rejects: %s', (reason, bytes, r) => {
    expect(validateKtx2Output(bytes, r)).toEqual({ ok: false, reason });
  });

  it('rejects an output over 32 MiB, before reading it', () => {
    const at = (n: number) => {
      const big = new Uint8Array(n);
      big.set(UASTC);
      return big;
    };
    expect(validateKtx2Output(at(KTX2_MAX_OUTPUT_BYTES), req)).toEqual({ ok: true });
    expect(validateKtx2Output(at(KTX2_MAX_OUTPUT_BYTES + 1), req)).toEqual({ ok: false, reason: 'too-large' });
  });
});

describe('encodeKtx2Checked never rejects', () => {
  it('ok: the encoder\'s bytes, once they validate', async () => {
    const enc = returning(UASTC);
    await expect(encodeKtx2Checked(enc, request())).resolves.toEqual({ ok: true, bytes: UASTC });
    expect(enc.calls).toBe(1);
  });

  it('an ineligible size is refused before the encoder runs', async () => {
    const enc = returning(UASTC);
    await expect(encodeKtx2Checked(enc, request({ width: 42 }))).resolves.toEqual({ ok: false, reason: 'not-multiple-of-4' });
    await expect(encodeKtx2Checked(enc, request({ width: 8192 }))).resolves.toEqual({ ok: false, reason: 'too-large' });
    expect(enc.calls).toBe(0);
  });

  it('an encoder that throws or rejects is encode-failed', async () => {
    const throws = stub(() => {
      throw new Error('boom');
    });
    const rejects = stub(() => Promise.reject(new Error('boom')));
    await expect(encodeKtx2Checked(throws, request())).resolves.toEqual({ ok: false, reason: 'encode-failed' });
    await expect(encodeKtx2Checked(rejects, request())).resolves.toEqual({ ok: false, reason: 'encode-failed' });
  });

  it('aborted: before the encode (the encoder never runs), during it, or when it rejects on abort', async () => {
    const before = new AbortController();
    before.abort();
    const enc = returning(UASTC);
    await expect(encodeKtx2Checked(enc, request(), before.signal)).resolves.toEqual({ ok: false, reason: 'aborted' });
    expect(enc.calls).toBe(0);

    const during = new AbortController();
    const ignoresSignal = stub(async () => (during.abort(), UASTC));
    await expect(encodeKtx2Checked(ignoresSignal, request(), during.signal)).resolves.toEqual({ ok: false, reason: 'aborted' });

    const honours = new AbortController();
    const rejectsOnAbort = stub(async () => {
      honours.abort();
      throw new DOMException('aborted', 'AbortError');
    });
    await expect(encodeKtx2Checked(rejectsOnAbort, request(), honours.signal)).resolves.toEqual({ ok: false, reason: 'aborted' });
  });

  it('an output that fails validation is invalid:<reason>', async () => {
    // The 40x40 fixture for a 44x44 request.
    await expect(encodeKtx2Checked(returning(UASTC), request({ width: 44, height: 44 }))).resolves.toEqual({
      ok: false,
      reason: 'invalid:size',
    });
    await expect(encodeKtx2Checked(returning(ETC1S), request())).resolves.toEqual({ ok: false, reason: 'invalid:mode' });
    await expect(encodeKtx2Checked(returning(RGBA8), request())).resolves.toEqual({ ok: false, reason: 'invalid:not-basis' });
    const notBytes = stub(async () => UASTC.buffer as unknown as Uint8Array);
    await expect(encodeKtx2Checked(notBytes, request())).resolves.toEqual({ ok: false, reason: 'invalid:not-ktx2' });
  });

  it('even a request whose fields throw on read resolves', async () => {
    const hostile = new Proxy(request(), {
      get(target, key) {
        if (key === 'width') throw new Error('getter');
        return Reflect.get(target, key);
      },
    });
    await expect(encodeKtx2Checked(returning(UASTC), hostile)).resolves.toEqual({ ok: false, reason: 'encode-failed' });
  });
});
