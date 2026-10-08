import { describe, it, expect } from 'vitest';
import { linearToSrgb01, srgbToLinear01 } from './colorUtils';
import { linearToSrgbHex } from './gltfImportPlan';

/**
 * ONE linear→sRGB (Color Ramp's stop colours, the glTF import's factor hex).
 * gltfImportPlan's private copy was folded onto it; the sweep pins that every
 * imported colour factor still lands on the SAME 8-bit hex.
 */

/** gltfImportPlan's srgb8 exactly as it was before the fold. */
const clamp01 = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0;
function oldSrgb8(c: unknown): number {
  const l = clamp01(c);
  const s = l <= 0.0031308 ? 12.92 * l : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
  return Math.round(clamp01(s) * 255);
}
const oldHex = (c: unknown) => {
  const h = oldSrgb8(c).toString(16).padStart(2, '0');
  return `#${h}${h}${h}`;
};

describe('linearToSrgb01', () => {
  it('is the inverse of srgbToLinear01 and total over junk', () => {
    for (let i = 0; i <= 1000; i++) {
      const v = i / 1000;
      expect(linearToSrgb01(srgbToLinear01(v))).toBeCloseTo(v, 9);
    }
    for (const v of [NaN, Infinity, -Infinity]) expect(linearToSrgb01(v)).toBe(0);
    expect(linearToSrgb01(-1)).toBe(0);
    expect(linearToSrgb01(2)).toBe(linearToSrgb01(1));
  });

  it('gltfImportPlan\'s colour factors are byte-identical to the private copy it replaced', () => {
    for (let i = 0; i <= 10000; i++) {
      const c = i / 10000;
      expect(linearToSrgbHex([c, c, c]), String(c)).toBe(oldHex(c));
    }
    for (const c of [NaN, Infinity, -Infinity, 'x', -1, 2, null, undefined, {}]) {
      expect(linearToSrgbHex([c, c, c]), String(c)).toBe(oldHex(c));
    }
  });
});
