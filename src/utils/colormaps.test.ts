import { describe, it, expect } from 'vitest';
import {
  COLORMAPS,
  getColormap,
  sampleColormapSrgb,
  colormapHexAt,
  colormapGradientCss,
  buildColormapLut,
  colormapStopCount,
  DEFAULT_COLORMAP_ID,
  LUT_SIZE,
  LUT_COORD_SCALE,
  LUT_COORD_OFFSET,
} from './colormaps';
import { srgbToLinear01 } from './colorUtils';

/**
 * These maps are the whole point of the feature: a colormap that is subtly
 * wrong is worse than an obviously arbitrary gradient, because it still LOOKS
 * like the published map while misreporting the data. So the suite pins the
 * published endpoints byte-for-byte, checks the properties that make each
 * family usable (monotone lightness for sequential, a neutral centre for
 * diverging, flat lightness for isoluminant), and checks that the GPU path
 * reproduces the CPU one.
 */

/** Rec. 709 relative luminance of LINEAR components — the quantity that
 *  competes with shading on a lit 3D surface. */
function luminanceOfSrgb([r, g, b]: [number, number, number]): number {
  return (
    0.2126 * srgbToLinear01(r) + 0.7152 * srgbToLinear01(g) + 0.0722 * srgbToLinear01(b)
  );
}

describe('colormap catalogue', () => {
  it('reproduces the published endpoints of the well-known maps', () => {
    // If any of these drift, the generator picked up a different table or the
    // anchor downsampling lost the ends.
    const cases: [string, string, string][] = [
      ['viridis', '#440154', '#fde725'],
      ['magma', '#000004', '#fcfdbf'],
      ['inferno', '#000004', '#fcffa4'],
      ['cividis', '#00224e', '#fee838'],
      ['turbo', '#30123b', '#7a0403'],
      // Moreland's cool-warm: blue → near-neutral grey → red.
      ['coolwarm', '#3b4cc0', '#b40426'],
    ];
    for (const [id, first, last] of cases) {
      const map = getColormap(id);
      expect(colormapHexAt(map, 0), `${id} start`).toBe(first);
      expect(colormapHexAt(map, 1), `${id} end`).toBe(last);
    }
    expect(colormapHexAt(getColormap('coolwarm'), 0.5)).toBe('#dddddd');
  });

  it('every catalogue entry parses to at least two well-formed anchors', () => {
    for (const map of COLORMAPS) {
      expect(colormapStopCount(map), map.id).toBeGreaterThanOrEqual(2);
      for (const stop of map.stops.split(',')) {
        expect(stop, `${map.id}: ${stop}`).toMatch(/^[0-9a-f]{6}$/);
      }
    }
  });

  it('sequential maps ramp lightness monotonically', () => {
    // The defining property: equal steps in value must read as equal steps in
    // lightness, and never double back. A map that dips is a rainbow in
    // disguise and will invent features the data does not have.
    for (const map of COLORMAPS.filter((m) => m.kind === 'sequential')) {
      let prev = -Infinity;
      for (let i = 0; i <= 32; i++) {
        const L = luminanceOfSrgb(sampleColormapSrgb(map, i / 32));
        // A hair of tolerance: the anchors are 8-bit quantized.
        expect(L, `${map.id} at ${i}/32`).toBeGreaterThan(prev - 0.002);
        prev = Math.max(prev, L);
      }
    }
  });

  it('isoluminant maps hold lightness nearly constant', () => {
    // This is what makes them usable on a shaded 3D mesh: the luminance channel
    // is left free for the lighting to describe shape.
    for (const map of COLORMAPS.filter((m) => m.kind === 'isoluminant')) {
      const ls: number[] = [];
      for (let i = 0; i <= 32; i++) ls.push(luminanceOfSrgb(sampleColormapSrgb(map, i / 32)));
      const spread = Math.max(...ls) - Math.min(...ls);
      // Perceptual, not photometric, isoluminance — CET's maps are matched in
      // CIECAM lightness, so Rec.709 luminance still wanders a little.
      expect(spread, map.id).toBeLessThan(0.12);
    }
  });

  it('diverging maps are lightest in the middle and symmetric in lightness', () => {
    for (const map of COLORMAPS.filter((m) => m.kind === 'diverging')) {
      const mid = luminanceOfSrgb(sampleColormapSrgb(map, 0.5));
      const lo = luminanceOfSrgb(sampleColormapSrgb(map, 0));
      const hi = luminanceOfSrgb(sampleColormapSrgb(map, 1));
      expect(mid, `${map.id} centre`).toBeGreaterThan(lo);
      expect(mid, `${map.id} centre`).toBeGreaterThan(hi);
      // The two arms must be equally dark, or one side of zero reads as
      // "more extreme" than the other at the same magnitude.
      expect(Math.abs(lo - hi), `${map.id} arms`).toBeLessThan(0.1);
    }
  });
});

describe('sampleColormapSrgb', () => {
  const viridis = getColormap('viridis');

  it('clamps out-of-range and non-finite t to the ramp ends', () => {
    expect(colormapHexAt(viridis, -5)).toBe(colormapHexAt(viridis, 0));
    expect(colormapHexAt(viridis, 5)).toBe(colormapHexAt(viridis, 1));
    expect(colormapHexAt(viridis, NaN)).toBe(colormapHexAt(viridis, 0));
  });

  it('reverse mirrors the ramp', () => {
    expect(colormapHexAt(viridis, 0, true)).toBe(colormapHexAt(viridis, 1));
    expect(colormapHexAt(viridis, 0.25, true)).toBe(colormapHexAt(viridis, 0.75));
  });

  it('interpolates between anchors rather than snapping to them', () => {
    const n = colormapStopCount(viridis);
    const a = sampleColormapSrgb(viridis, 0 / (n - 1));
    const b = sampleColormapSrgb(viridis, 1 / (n - 1));
    const mid = sampleColormapSrgb(viridis, 0.5 / (n - 1));
    for (let c = 0; c < 3; c++) {
      expect(mid[c]).toBeCloseTo((a[c] + b[c]) / 2, 5);
    }
  });
});

describe('getColormap', () => {
  it('falls back to the default for anything unrecognized', () => {
    // Ids arrive from .fastshader files — an unknown one must still render.
    for (const bad of [undefined, null, '', 'jet', '__proto__', 42, {}]) {
      expect(getColormap(bad as unknown).id).toBe(DEFAULT_COLORMAP_ID);
    }
  });

  it('degrades a malformed anchor to black instead of NaN', () => {
    // NaN here would reach the baked LUT and then the emitted module.
    const broken = { id: 'x', label: 'x', kind: 'sequential' as const, stops: 'zzzzzz,ffffff' };
    const [r, g, b] = sampleColormapSrgb(broken, 0);
    expect([r, g, b]).toEqual([0, 0, 0]);
    expect(buildColormapLut(broken).every(Number.isFinite)).toBe(true);
  });
});

describe('buildColormapLut', () => {
  const viridis = getColormap('viridis');

  it('is LUT_SIZE RGBA texels of finite linear-light values with alpha 1', () => {
    const lut = buildColormapLut(viridis);
    expect(lut).toHaveLength(LUT_SIZE * 4);
    for (let i = 0; i < LUT_SIZE; i++) {
      expect(lut[i * 4 + 3]).toBe(1);
      for (let c = 0; c < 3; c++) {
        const v = lut[i * 4 + c];
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it('stores LINEAR light, not the sRGB the catalogue publishes', () => {
    // The distinction this whole module exists to keep straight: the texture is
    // sampled as raw data in the renderer's linear working space, so baking the
    // sRGB numbers would brighten every map and flatten its uniformity.
    const lut = buildColormapLut(viridis);
    // Texel i holds the ramp at i/(N−1) exactly, so compare at a texel rather
    // than at t = 0.5 (which falls between texels 127 and 128).
    const i = 128;
    const [r, g, b] = sampleColormapSrgb(viridis, i / (LUT_SIZE - 1));
    expect(lut[i * 4]).toBeCloseTo(srgbToLinear01(r), 6);
    expect(lut[i * 4 + 1]).toBeCloseTo(srgbToLinear01(g), 6);
    expect(lut[i * 4 + 2]).toBeCloseTo(srgbToLinear01(b), 6);
    // …and the two spaces really do differ here (guards against the test
    // passing because the value happened to be 0 or 1).
    expect(Math.abs(lut[i * 4 + 1] - g)).toBeGreaterThan(0.05);
  });

  it('endpoints land on texel 0 and texel N-1 under the shader coordinate map', () => {
    // Mirrors what the emitted TSL does: u = t·SCALE + OFFSET, then a linear
    // fetch reads index position u·N − 0.5.
    const indexAt = (t: number) => (t * LUT_COORD_SCALE + LUT_COORD_OFFSET) * LUT_SIZE - 0.5;
    expect(indexAt(0)).toBeCloseTo(0, 9);
    expect(indexAt(1)).toBeCloseTo(LUT_SIZE - 1, 9);
    expect(indexAt(0.5)).toBeCloseTo((LUT_SIZE - 1) / 2, 9);
  });

  it('reverse flips the baked table rather than needing shader work', () => {
    const fwd = buildColormapLut(viridis);
    const rev = buildColormapLut(viridis, true);
    for (let c = 0; c < 4; c++) {
      expect(rev[c]).toBeCloseTo(fwd[(LUT_SIZE - 1) * 4 + c], 6);
    }
  });
});

describe('colormapGradientCss', () => {
  const viridis = getColormap('viridis');

  it('emits one continuous gradient with the true endpoints', () => {
    const css = colormapGradientCss(viridis);
    expect(css.startsWith('linear-gradient(90deg, ')).toBe(true);
    expect(css).toContain('#440154 0.000%');
    expect(css).toContain('#fde725 100.000%');
  });

  it('renders hard bands at the same positions the shader quantizes to', () => {
    // Band i spans [i/N, (i+1)/N] and takes the colour at its CENTRE — the
    // preview has to agree with `floor(t·N) + 0.5` in the emitted TSL or the
    // levels control looks broken.
    const css = colormapGradientCss(viridis, false, 4);
    const centre = colormapHexAt(viridis, 0.5 / 4);
    expect(css).toContain(`${centre} 0.000%`);
    expect(css).toContain(`${centre} 25.000%`);
    expect(css.match(/#[0-9a-f]{6}/g)).toHaveLength(8); // 4 bands × 2 stops
  });

  it('treats 0 and 1 levels as continuous', () => {
    expect(colormapGradientCss(viridis, false, 1)).toBe(colormapGradientCss(viridis, false, 0));
  });
});
