import { describe, it, expect } from 'vitest';
import { SIGNED_NOISE_TYPES, hasNoiseRangeFlag, isUnsignedNoise } from './noiseRange';

describe('SIGNED_NOISE_TYPES', () => {
  it('is exactly the four MaterialX types whose raw output is signed', () => {
    expect([...SIGNED_NOISE_TYPES].sort()).toEqual(['fbm', 'fbmVec3', 'perlin', 'perlinVec3']);
  });

  it('excludes the noise types that were already [0, 1]', () => {
    // A remap on these would halve a range that was already correct.
    for (const type of ['cellNoise', 'voronoi', 'voronoiVec2', 'voronoiVec3']) {
      expect(hasNoiseRangeFlag(type), type).toBe(false);
    }
  });

  it('excludes non-noise types and undefined', () => {
    expect(hasNoiseRangeFlag('float')).toBe(false);
    expect(hasNoiseRangeFlag(undefined)).toBe(false);
  });
});

describe('isUnsignedNoise', () => {
  it('is true only for a stored 0 on a flagged type', () => {
    expect(isUnsignedNoise('perlin', { signed: 0 })).toBe(true);
    // The fs:graph autosave round-trips through JSON, and a hand-edited
    // .fastshader can carry anything, so the string form is accepted too.
    expect(isUnsignedNoise('perlin', { signed: '0' })).toBe(true);
  });

  it('treats an ABSENT flag as signed — the whole backwards-compatibility rule', () => {
    expect(isUnsignedNoise('perlin', {})).toBe(false);
    expect(isUnsignedNoise('perlin', undefined)).toBe(false);
  });

  // The reason this is an exact identity test and not `Number(v) < 0.5`:
  // Number() maps every one of these to 0, i.e. to "unsigned". `null` is the one
  // that bites with no tampering at all — a non-finite written to values comes
  // back from the fs:graph autosave as null — so a coercing read would change a
  // shader's appearance across a page reload.
  it('falls back to SIGNED for every junk value', () => {
    const junk: unknown[] = [
      null, undefined, false, true, '', ' ', '0.0', 'false', 'true',
      [], [0], {}, NaN, Infinity, -0.0001, 0.4, 1, '1',
    ];
    for (const v of junk) {
      expect(isUnsignedNoise('perlin', { signed: v }), String(v)).toBe(false);
    }
  });

  it('ignores the flag entirely on a type that never had a signed range', () => {
    // Gated on the def TYPE as well as the value: a tampered .fastshader putting
    // signed:0 on a voronoi node must not emit a remap that codeToGraph is
    // required to refuse to collapse.
    for (const type of ['cellNoise', 'voronoi', 'voronoiVec2', 'voronoiVec3']) {
      expect(isUnsignedNoise(type, { signed: 0 }), type).toBe(false);
    }
  });
});
