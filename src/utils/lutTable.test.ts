import { describe, it, expect } from 'vitest';
import { FS_LUT_SIZE, halfTable, fetchHalf, rangeHalf } from './lutTable';
import { toHalfFloat, fromHalfFloat } from './binaryCodec';

/** A 257-texel RGBA table whose channel c at texel i is f_c(i/256). */
const table = (f: (x: number, c: number) => number): Uint16Array => {
  const vals = new Float32Array(FS_LUT_SIZE * 4);
  for (let i = 0; i < FS_LUT_SIZE; i++) for (let c = 0; c < 4; c++) vals[i * 4 + c] = f(i / 256, c);
  return halfTable(vals);
};

/** GPU emulation of fsLut.at: u = t·256/257 + 0.5/257, texel space u·257 − 0.5, ClampToEdge. */
const gpuLinear = (half: Uint16Array, c: number, t: number) => {
  const u = t * (256 / 257) + 0.5 / 257;
  const x = Math.min(Math.max(u * 257 - 0.5, 0), 256);
  const i0 = Math.floor(x);
  const i1 = Math.min(i0 + 1, 256);
  const f = x - i0;
  return fromHalfFloat(half[i0 * 4 + c]) * (1 - f) + fromHalfFloat(half[i1 * 4 + c]) * f;
};
/** three's WGSL textureLoad path for a nearest sampler: floor(u·257) clamped. */
const gpuNearest = (half: Uint16Array, c: number, t: number) => {
  const u = Math.min(Math.max(t * (256 / 257) + 0.5 / 257, 0), 1);
  const i = Math.min(Math.max(Math.floor(u * 257), 0), 256);
  return fromHalfFloat(half[i * 4 + c]);
};

describe('lutTable — the CPU twin of fsLut', () => {
  it('is Blender\'s CM_TABLE + 1 texels, and halfTable is toHalfFloat per entry', () => {
    expect(FS_LUT_SIZE).toBe(257);
    const v = new Float32Array([0, 1, -1, 0.1, 65504, 70000, NaN, Infinity, 1e-8]);
    expect([...halfTable(v)]).toEqual([...v].map((x) => toHalfFloat(x)));
  });

  it('texel i holds x = i/256, so both ends are exact texel centres', () => {
    const h = table((x) => x);
    expect(fetchHalf(h, 0, 0, false)).toBe(0);
    expect(fetchHalf(h, 0, 1, false)).toBe(1);
    expect(fetchHalf(h, 0, 0.5, false)).toBe(0.5);
    expect(fetchHalf(h, 0, 0.5, true)).toBe(0.5);
  });

  it('agrees with GPU sampling emulation within f16 + filter precision (2e-3)', () => {
    const h = table((x, c) => [Math.sin(6 * x) * 0.5 + 0.5, x * x, 1 - x, x > 0.3 ? 1 : 0][c]);
    for (let k = -20; k <= 1020; k++) {
      const t = k / 1000;
      for (let c = 0; c < 4; c++) {
        expect(Math.abs(fetchHalf(h, c as 0, t, false) - gpuLinear(h, c, t)), `linear t=${t} c=${c}`).toBeLessThan(2e-3);
        expect(fetchHalf(h, c as 0, t, true), `nearest t=${t} c=${c}`).toBe(gpuNearest(h, c, t));
      }
    }
  });

  it('a non-finite t is NaN (the evaluator substitutes its own fallback)', () => {
    const h = table((x) => x);
    for (const t of [NaN, Infinity, -Infinity]) {
      expect(fetchHalf(h, 0, t, false)).toBeNaN();
      expect(fetchHalf(h, 0, t, true)).toBeNaN();
    }
  });

  it('rangeHalf is the exact extent of fetchHalf over the interval', () => {
    const h = table((x, c) => [Math.sin(9 * x), x, 0.25, Math.cos(13 * x)][c]);
    const brute = (c: number, lo: number, hi: number, nearest: boolean) => {
      let min = Infinity;
      let max = -Infinity;
      const a = Math.min(Math.max(lo, 0), 1);
      const b = Math.min(Math.max(hi, 0), 1);
      for (let k = 0; k <= 20000; k++) {
        const v = fetchHalf(h, c as 0, a + ((b - a) * k) / 20000, nearest);
        min = Math.min(min, v);
        max = Math.max(max, v);
      }
      return [min, max];
    };
    for (const [lo, hi] of [[0, 1], [0.1, 0.13], [0.2, 0.2], [-5, 0.4], [0.6, Infinity], [-Infinity, Infinity], [0.37, 0.71]]) {
      for (let c = 0; c < 4; c++) {
        for (const nearest of [false, true]) {
          const [mn, mx] = rangeHalf(h, c as 0, lo, hi, nearest);
          const [bmn, bmx] = brute(c, lo, hi, nearest);
          // brute samples a subset, so the exact range CONTAINS it and is within one texel step of it
          expect(mn, `${lo},${hi},${c},${nearest}`).toBeLessThanOrEqual(bmn + 1e-12);
          expect(mx, `${lo},${hi},${c},${nearest}`).toBeGreaterThanOrEqual(bmx - 1e-12);
          expect(bmn - mn).toBeLessThan(1e-3);
          expect(mx - bmx).toBeLessThan(1e-3);
        }
      }
    }
  });

  it('a NaN bound is "unknown" (the full side), and a reversed interval still answers', () => {
    const h = table((x) => x);
    expect(rangeHalf(h, 0, NaN, NaN, false)).toEqual([0, 1]);
    expect(rangeHalf(h, 0, 0.75, 0.25, false)).toEqual(rangeHalf(h, 0, 0.25, 0.75, false));
  });
});
