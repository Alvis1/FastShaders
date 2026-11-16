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
import { mxNoise, mxNoiseChannel, mxNoiseGrid, mxNoiseInput, mxNoiseWidth, type MxNoiseType } from './mxNoise';

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

describe('mxNoiseGrid: a card\'s whole picture, EXACTLY the point function', () => {
  const TYPES: MxNoiseType[] = ['perlin', 'perlinVec3', 'fbm', 'fbmVec3', 'cellNoise', 'voronoi', 'voronoiVec2', 'voronoiVec3'];

  /** Every grid value against mxNoiseChannel at the same coordinates — the
   *  same number, not a close one (a zero's sign aside; NaN matches NaN). */
  function mismatches(type: MxNoiseType, xs: number[], ys: number[], z: number | null, ch = 0): string[] {
    const out = new Float64Array(xs.length * ys.length).fill(12345);
    mxNoiseGrid(type, xs, ys, z, out, ch);
    const bad: string[] = [];
    for (let r = 0; r < ys.length; r++) {
      for (let c = 0; c < xs.length; c++) {
        const got = out[r * xs.length + c];
        const want = mxNoiseChannel(type, xs[c], ys[r], z, ch);
        if (!(got === want || (Number.isNaN(got) && Number.isNaN(want)))) {
          bad.push(`${type} ch${ch} (${xs[c]}, ${ys[r]}, ${z}): grid ${got} point ${want}`);
        }
      }
    }
    return bad;
  }

  /** A card's axes: x across, y running DOWN the rows (the card's y is up). */
  function cardAxes(n: number, lo: number, hi: number, scale: number): [number[], number[]] {
    const xs: number[] = [], ys: number[] = [];
    for (let i = 0; i < n; i++) {
      xs.push((lo + (hi - lo) * ((i + 0.5) / n)) * scale);
      ys.push((hi - (hi - lo) * ((i + 0.5) / n)) * scale);
    }
    return [xs, ys];
  }

  it('on card grids at every Scale (high ones step a cell every row), 2-D and 3-D', () => {
    const bad: string[] = [];
    for (const scale of [0.5, 1, 3, 5, 12, -2.5]) {
      const [xs, ys] = cardAxes(40, -1.3, 1.1, scale);
      for (const type of TYPES) {
        for (const z of [null, 0.37 * scale, -1.25, 2]) bad.push(...mismatches(type, xs, ys, z));
      }
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it('on the lattice itself, across cells out of order, and stepping y both ways', () => {
    const lattice = [-2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2];
    const shuffled = [0.2, 3.7, 3.9, -4.1, 8.1, 8.6, 7.9, 0.2, 0.4];
    const zigzag = [0.5, 1.5, 0.5, -0.5, 0.5, 2.5, 3.5, 2.5, 1.5, 0.5, -3.5];
    const bad: string[] = [];
    for (const type of TYPES) {
      for (const z of [null, 0, 1.5]) {
        bad.push(...mismatches(type, lattice, lattice, z));
        bad.push(...mismatches(type, shuffled, zigzag, z));
        bad.push(...mismatches(type, zigzag, shuffled, z));
      }
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it('every other channel too (the Voronoi F2/F3 reads go point by point)', () => {
    const [xs, ys] = cardAxes(16, -1, 1, 4);
    const bad: string[] = [];
    for (const [type, chs] of [['perlinVec3', [1, 2]], ['fbmVec3', [1, 2]], ['voronoiVec2', [1]], ['voronoiVec3', [1, 2]]] as const) {
      for (const ch of chs) for (const z of [null, 0.6]) bad.push(...mismatches(type, xs, ys, z, ch));
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it('on junk and wrapping coordinates, without throwing', () => {
    const junk = [Number.NaN, Infinity, -Infinity, 1e300, -1e300, 2 ** 31 - 0.5, 2 ** 31 + 0.5, -(2 ** 31) - 0.5, 0.5];
    const bad: string[] = [];
    for (const type of TYPES) {
      for (const z of [null, Number.NaN, 1e300, 0.25]) bad.push(...mismatches(type, junk, junk, z));
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it('keeps nothing between calls: a different size and window right after gives the same values', () => {
    const [ax, ay] = cardAxes(30, -2, 2, 7);
    const [bx, by] = cardAxes(7, 0, 1, 1);
    const bad: string[] = [];
    for (const type of TYPES) {
      bad.push(...mismatches(type, ax, ay, 0.4));
      bad.push(...mismatches(type, bx, by, 0.4));
      bad.push(...mismatches(type, ax, ay, null));
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });
});
