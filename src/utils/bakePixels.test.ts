import { describe, expect, it } from 'vitest';
import { bakeImage, linearToSrgb, validateBakeReply, BAKE_DILATE_PX, type BakeRaw } from './bakePixels';

const S = 64;

/** A reply whose texel (x, y) holds f(x, y) in RGB, coverage from `cov`. */
function reply(f: (x: number, y: number) => [number, number, number], cov: (x: number, y: number) => boolean = () => true): BakeRaw {
  const data = new Float32Array(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      if (!cov(x, y)) continue;
      const [r, g, b] = f(x, y);
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 1;
    }
  }
  return { width: S, height: S, data };
}

describe('validateBakeReply — the stage is adversarial', () => {
  const ok = { ok: true, width: S, height: S, data: new Float32Array(S * S * 4) };
  it('accepts exactly the picture asked for', () => {
    expect(validateBakeReply(ok, S)).not.toBeNull();
    expect(validateBakeReply({ ...ok, data: new Uint8Array(S * S * 4) }, S)).not.toBeNull();
  });
  it('refuses another size, length, type or a failure', () => {
    expect(validateBakeReply(ok, 128)).toBeNull();
    expect(validateBakeReply({ ...ok, data: new Float32Array(S * S * 4 + 4) }, S)).toBeNull();
    expect(validateBakeReply({ ...ok, data: new Uint16Array(S * S * 4) }, S)).toBeNull();
    expect(validateBakeReply({ ...ok, data: Array.from({ length: S * S * 4 }, () => 0) }, S)).toBeNull();
    expect(validateBakeReply({ ...ok, ok: false }, S)).toBeNull();
    expect(validateBakeReply(null, S)).toBeNull();
  });
});

describe('bakeImage', () => {
  it('stores an in-range data value as it is, a scalar as grey', () => {
    const r = bakeImage(reply((x) => [x / (S - 1), 0, 0]), { channels: 1, colorSpace: 'data', meshLayout: false });
    if ('error' in r) throw new Error(r.error);
    expect(r.remap).toBeNull();
    expect(r.colorSpace).toBe('data');
    expect([r.rgba[0], r.rgba[(S - 1) * 4]]).toEqual([0, 255]);
    expect(r.rgba[(S - 1) * 4 + 1]).toBe(255); // grey: G = R
    expect(r.rgba[3]).toBe(255);
  });

  it('a signed range is stored normalised, with the numbers to read it back, as data', () => {
    const r = bakeImage(reply((x) => [-1 + (2 * x) / (S - 1), 0, 0]), { channels: 1, colorSpace: 'color', meshLayout: false });
    if ('error' in r) throw new Error(r.error);
    expect(r.remap?.offset).toBeCloseTo(-1, 6);
    expect(r.remap?.scale).toBeCloseTo(2, 6);
    expect(r.colorSpace).toBe('data');
    // v = stored·scale + offset recovers the value within one 8-bit step.
    const mid = (S / 2) * 4;
    const back = (r.rgba[mid] / 255) * r.remap!.scale + r.remap!.offset;
    expect(Math.abs(back - (-1 + (2 * (S / 2)) / (S - 1)))).toBeLessThan(2 / 255 + 1e-6);
  });

  it('an in-range colour is sRGB-encoded, so the sRGB texture samples it back linear', () => {
    const r = bakeImage(reply(() => [0.5, 0.5, 0.5]), { channels: 3, colorSpace: 'color', meshLayout: false });
    if ('error' in r) throw new Error(r.error);
    expect(r.rgba[0]).toBe(Math.round(linearToSrgb(0.5) * 255));
  });

  it('a mesh layout grows its islands and fills the rest with their mean — no black at a seam', () => {
    const island = (x: number) => x >= 20 && x < 40;
    const r = bakeImage(reply(() => [0.8, 0.8, 0.8], (x) => island(x)), { channels: 1, colorSpace: 'data', meshLayout: true });
    if ('error' in r) throw new Error(r.error);
    expect(r.coverage).toBeCloseTo(20 / S, 6);
    const at = (x: number) => r.rgba[(10 * S + x) * 4];
    expect(at(20 - BAKE_DILATE_PX)).toBe(Math.round(0.8 * 255)); // grown
    expect(at(0)).toBe(Math.round(0.8 * 255)); // the mean beyond the rings
  });

  it('refuses NaN and an empty render', () => {
    expect(bakeImage(reply(() => [NaN, 0, 0]), { channels: 1, colorSpace: 'data', meshLayout: false })).toEqual({ error: 'non-finite' });
    expect(bakeImage(reply(() => [0, 0, 0], () => false), { channels: 1, colorSpace: 'data', meshLayout: true })).toEqual({ error: 'empty' });
  });

  it('reads the 8-bit fallback too', () => {
    const data = new Uint8Array(S * S * 4).fill(255);
    const r = bakeImage({ width: S, height: S, data }, { channels: 3, colorSpace: 'data', meshLayout: false });
    if ('error' in r) throw new Error(r.error);
    expect(r.remap).toBeNull();
    expect(r.rgba[0]).toBe(255);
  });
});
