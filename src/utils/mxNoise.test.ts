/**
 * The CPU MaterialX port against the GPU itself.
 *
 * `mxNoiseGpu.fixture.json` was READ BACK from three r184 running in the
 * editor's own preview frame (a compute pass over 64 fixed points, 2026-11-16):
 * every call graphToCode emits for the eight noise nodes, plus the two input
 * conversions three applies on the way in (a float `pos` and a vec4 `pos`).
 * A port that only matched itself would be the stand-in this replaced — a
 * picture that agreed with nothing on screen — so the reference is the shader's
 * own output, not a second hand-written copy. The tolerance is the fp32 the GPU
 * computes in against the doubles here.
 */
import { describe, it, expect } from 'vitest';
import fixture from './mxNoiseGpu.fixture.json';
import { mxNoise, mxNoiseChannel, mxNoiseInput, mxNoiseWidth, type MxNoiseType } from './mxNoise';

const TOL = 2e-4;
const inputs = fixture.inputs as number[][];
const results = fixture.results as Record<string, number[][]>;

function expectRows(
  key: string,
  type: MxNoiseType,
  pick: (p: number[]) => number[],
  channels: number[],
  gpuChannels: number[] = channels,
) {
  const rows = results[key];
  expect(rows, key).toHaveLength(inputs.length);
  inputs.forEach((p, i) => {
    const got = mxNoise(type, pick(p));
    channels.forEach((c, k) => {
      const want = rows[i][gpuChannels[k]];
      expect(Math.abs(got[c] - want), `${key} #${i} ch${c}: cpu ${got[c]} gpu ${want}`).toBeLessThan(TOL);
    });
  });
}

describe('mxNoise matches three r184 on the GPU', () => {
  it('Perlin, 2-D and 3-D', () => {
    expectRows('perlin2', 'perlin', (p) => [p[0], p[1]], [0]);
    expectRows('perlin3', 'perlin', (p) => p, [0]);
  });

  it('Perlin (vec3), every channel', () => {
    expectRows('perlinVec3_2', 'perlinVec3', (p) => [p[0], p[1]], [0, 1, 2]);
    expectRows('perlinVec3_3', 'perlinVec3', (p) => p, [0, 1, 2]);
  });

  it('fBm: three octaves, and a vec2 pos padded to (x, y, 0)', () => {
    expectRows('fbm3', 'fbm', (p) => p, [0]);
    expectRows('fbm2', 'fbm', (p) => [p[0], p[1]], [0]);
    expectRows('fbmVec3_3', 'fbmVec3', (p) => p, [0, 1, 2]);
  });

  it('cell noise, 2-D and 3-D', () => {
    expectRows('cell2', 'cellNoise', (p) => [p[0], p[1]], [0]);
    expectRows('cell3', 'cellNoise', (p) => p, [0]);
  });

  it('Voronoi: F1², F2², F3² (metric 1, the squared distance), 2-D and 3-D', () => {
    expectRows('worley2', 'voronoiVec3', (p) => [p[0], p[1]], [0, 1, 2]);
    expectRows('worley2', 'voronoi', (p) => [p[0], p[1]], [0], [3]);
    expectRows('worley3', 'voronoiVec3', (p) => p, [0, 1, 2]);
    expectRows('worley3', 'voronoi', (p) => p, [0], [3]);
    expectRows('worleyVec2_3', 'voronoiVec2', (p) => p, [0, 1]);
  });

  it("three's input conversion: a float splats to (f, f), a vec4 drops .zw", () => {
    expectRows('perlinFloat1', 'perlin', (p) => [p[0]], [0]);
    expectRows('perlinVec4', 'perlin', (p) => [p[0], p[1], p[2], 7], [0]);
  });
});

describe('mxNoise shape', () => {
  it('converts pos as three does: vec2|vec3 for every call, a vec3 layout for fBm', () => {
    expect(mxNoiseInput('perlin', [2])).toEqual([2, 2]);
    expect(mxNoiseInput('voronoi', [1, 2, 3, 4])).toEqual([1, 2]);
    expect(mxNoiseInput('cellNoise', [1, 2, 3])).toEqual([1, 2, 3]);
    expect(mxNoiseInput('fbm', [2])).toEqual([2, 2, 2]);
    expect(mxNoiseInput('fbmVec3', [1, 2])).toEqual([1, 2, 0]);
    expect(mxNoiseInput('fbm', [1, 2, 3, 4])).toEqual([1, 2, 3]);
  });

  it('returns the declared output width', () => {
    for (const type of ['perlin', 'perlinVec3', 'fbm', 'fbmVec3', 'cellNoise', 'voronoi', 'voronoiVec2', 'voronoiVec3'] as const) {
      expect(mxNoise(type, [0.3, 0.7, 1.1])).toHaveLength(mxNoiseWidth(type));
    }
  });

  it('the allocation-free channel read agrees with the whole output', () => {
    const p = [1.37, -2.21, 0.53];
    for (const type of ['perlin', 'perlinVec3', 'fbm', 'fbmVec3', 'cellNoise', 'voronoi', 'voronoiVec2', 'voronoiVec3'] as const) {
      const all = mxNoise(type, p);
      all.forEach((v, c) => expect(mxNoiseChannel(type, p[0], p[1], p[2], c)).toBe(v));
    }
  });

  it('Perlin and fBm vanish on the lattice (the rule the docs lean on)', () => {
    expect(mxNoise('perlin', [3, -2, 5])[0]).toBe(0);
    expect(mxNoise('fbm', [0, 0, 8])[0]).toBe(0);
  });

  it('never throws on junk coordinates', () => {
    for (const v of [Number.NaN, Infinity, -Infinity, 1e300, -1e12]) {
      for (const type of ['perlin', 'fbm', 'cellNoise', 'voronoiVec3'] as const) {
        expect(() => mxNoise(type, [v, v, v])).not.toThrow();
      }
    }
  });
});
