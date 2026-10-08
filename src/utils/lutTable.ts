import { toHalfFloat, fromHalfFloat } from './binaryCodec';

/**
 * The CPU twin of what `fsLut` (engine/lutHelperText.ts) puts on the GPU: a
 * 257×1 RGBA half-float table sampled through a half-texel inset. Color Ramp
 * and RGB Curves read their card values, edge values and ranges from the HALF
 * table rather than the float bake, so the editor shows what the shader
 * computes — f32 vs f16 differs by up to 1e-3 near 1.0, which the range display
 * would otherwise print as a different number than the preview shows.
 *
 * Texel i holds x = i/256 (Blender's CM_TABLE + 1 entries, so both 0 and 1 are
 * exact texel centres). `fsLut.at` samples u = t·256/257 + 0.5/257, which puts
 * the texel-space coordinate at exactly t·256.
 */

/** Blender CM_TABLE + 1; texel i is x = i/256. */
export const FS_LUT_SIZE = 257;

const LAST = FS_LUT_SIZE - 1;

/** toHalfFloat per entry — exactly fsLut.make's loop, so the two are bit-identical. */
export function halfTable(vals: Float32Array): Uint16Array {
  const out = new Uint16Array(vals.length);
  for (let i = 0; i < vals.length; i++) out[i] = toHalfFloat(vals[i]);
  return out;
}

const texel = (half: Uint16Array, channel: number, i: number): number => fromHalfFloat(half[i * 4 + channel] ?? 0);

/** CPU twin of fsLut.at on a decoded half table. Linear: x = clamp(t,0,1)·256, lerp texels floor(x), floor(x)+1
 *  (clamped to 256). Nearest: texel clamp(floor(t·256 + 0.5), 0, 256) — what both WebGL nearest sampling and three's
 *  WGSL textureLoad path (floor(u·257) clamped) give with this inset. Non-finite t → NaN. */
export function fetchHalf(half: Uint16Array, channel: 0 | 1 | 2 | 3, t: number, nearest: boolean): number {
  if (!Number.isFinite(t)) return NaN;
  if (nearest) {
    const i = Math.floor(t * LAST + 0.5);
    return texel(half, channel, i < 0 ? 0 : i > LAST ? LAST : i);
  }
  const x = (t < 0 ? 0 : t > 1 ? 1 : t) * LAST;
  const i0 = Math.floor(x);
  const i1 = i0 + 1 > LAST ? LAST : i0 + 1;
  const f = x - i0;
  const a = texel(half, channel, i0);
  return f === 0 ? a : a + (texel(half, channel, i1) - a) * f;
}

/** Exact [min,max] of fetchHalf over t ∈ [lo,hi] (either may be ±Infinity; clamped to [0,1] like ClampToEdge):
 *  linear = fetch(lo), fetch(hi) and every texel centre i/256 strictly inside; nearest = every texel from
 *  round(lo·256) to round(hi·256). A NaN bound is "unknown" — the whole [0,1] on that side — and a reversed
 *  interval is read in order, so neither can return an empty or NaN range. */
export function rangeHalf(half: Uint16Array, channel: 0 | 1 | 2 | 3, lo: number, hi: number, nearest: boolean): [number, number] {
  let a = Number.isNaN(lo) ? 0 : lo < 0 ? 0 : lo > 1 ? 1 : lo;
  let b = Number.isNaN(hi) ? 1 : hi < 0 ? 0 : hi > 1 ? 1 : hi;
  if (a > b) [a, b] = [b, a];
  let min = Infinity;
  let max = -Infinity;
  const see = (v: number) => {
    if (v < min) min = v;
    if (v > max) max = v;
  };
  if (nearest) {
    const i0 = Math.floor(a * LAST + 0.5);
    const i1 = Math.floor(b * LAST + 0.5);
    for (let i = i0; i <= i1; i++) see(texel(half, channel, i));
  } else {
    see(fetchHalf(half, channel, a, false));
    see(fetchHalf(half, channel, b, false));
    for (let i = Math.floor(a * LAST) + 1; i < b * LAST; i++) see(texel(half, channel, i));
  }
  return [min, max];
}
