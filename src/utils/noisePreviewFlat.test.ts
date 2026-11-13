/**
 * The noise card's FLAT thumbnail (PreviewNode): a noise whose input is one
 * value per frame for the whole surface — the camera position, Sound, Time
 * alone, a constant — paints the whole mesh one tone, so its card shows one
 * grey rather than a pattern the model never shows. Which cards go flat is
 * `getSurfaceFieldUpstreamSet`'s answer (edgeValueTruth.test.ts); this pins
 * the grey.
 */
import { describe, it, expect } from 'vitest';
import { flatNoiseDisplay, renderFlatNoisePreview } from './noisePreview';

describe('flatNoiseDisplay', () => {
  it('maps a signed Perlin/fBm value the way the pattern maps the raw field', () => {
    expect(flatNoiseDisplay('perlin', -1, false)).toBe(0);
    expect(flatNoiseDisplay('perlin', 0, false)).toBe(0.5);
    expect(flatNoiseDisplay('fbmVec3', 1, false)).toBe(1);
  });

  it('shows one value as the same grey in either range mode', () => {
    // Signed raw 0.2 is unsigned 0.6: the card must not change on the switch.
    expect(flatNoiseDisplay('perlin', 0.6, true)).toBeCloseTo(flatNoiseDisplay('perlin', 0.2, false), 12);
  });

  it('takes cell noise and Voronoi as they are, clamped to the scale', () => {
    expect(flatNoiseDisplay('cellNoise', 0.3, false)).toBe(0.3);
    expect(flatNoiseDisplay('voronoi', 2.4, false)).toBe(1);
  });

  it('an unknown input (the camera position) is the middle grey, never a guess', () => {
    expect(flatNoiseDisplay('voronoi', null, false)).toBe(0.5);
    expect(flatNoiseDisplay('perlin', Number.NaN, true)).toBe(0.5);
  });
});

describe('renderFlatNoisePreview', () => {
  it('writes every byte of a reused buffer: one grey, opaque', () => {
    const reuse = { width: 3, height: 3, data: new Uint8ClampedArray(3 * 3 * 4).fill(7) } as unknown as ImageData;
    const out = renderFlatNoisePreview(3, 0.5, reuse);
    expect(out).toBe(reuse);
    for (let i = 0; i < out.data.length; i += 4) {
      expect([...out.data.slice(i, i + 4)]).toEqual([128, 128, 128, 255]);
    }
  });
});
