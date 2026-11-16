/**
 * The noise card draws what the 3D view samples (owner, 2026-11-16: "the noise
 * node visual does not sync with the iframe"): three's own MaterialX noise
 * (mxNoise, held to a GPU readback in mxNoise.test.ts) over the WINDOW its
 * `pos` input spans. These pin the renderer's half: every pixel is the noise
 * at its centre — x across channel 0, y UP channel 1 (3-D y is up, a canvas
 * row is down; the first cut ran the motion of `pos + time` up the card while
 * the mesh's ran down) — converted as three converts the input, and shown as
 * the mesh shows the value — sRGB-encoded, as the preview writes linear light.
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_NOISE_WINDOW, noiseGreyByte, rawNoiseDisplay, renderNoisePreview, type NoiseType, type NoiseWindow } from './noisePreview';
import { mxNoise } from './mxNoise';
import { linearToSrgb01 } from './colorUtils';

const SIZE = 8;

function buffer(): ImageData {
  return { width: SIZE, height: SIZE, data: new Uint8ClampedArray(SIZE * SIZE * 4) } as unknown as ImageData;
}

function render(type: NoiseType, win: NoiseWindow | null, scale = 1): Uint8ClampedArray {
  return renderNoisePreview(type, SIZE, { scale }, win, buffer()).data;
}

/** What pixel (x, y) must show: the noise of the window's channels there. */
function expected(type: NoiseType, win: NoiseWindow, scale: number, x: number, y: number): number {
  const w = Math.min(win.min.length, 4);
  const ch: number[] = [];
  for (let c = 0; c < w; c++) {
    const lo = win.min[c], hi = win.max[c];
    if (c === 0) ch.push(lo + (hi - lo) * ((x + 0.5) / SIZE));
    else if (c === 1) ch.push(hi - (hi - lo) * ((y + 0.5) / SIZE));
    else ch.push((lo + hi) / 2);
  }
  // mxNoise applies three's conversion itself (mxNoiseInput): the reference.
  const v = mxNoise(type, ch.map((c) => c * scale))[0];
  // Linear light, written as the preview writes it: sRGB-encoded.
  return Math.round(linearToSrgb01(rawNoiseDisplay(type, v)) * 255);
}

function expectCard(type: NoiseType, win: NoiseWindow, scale = 1) {
  const data = render(type, win, scale);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 4;
      const want = expected(type, win, scale, x, y);
      expect(data[i], `${type} w${win.min.length} (${x}, ${y})`).toBe(want);
      expect(data[i + 1]).toBe(want);
      expect(data[i + 2]).toBe(want);
      expect(data[i + 3]).toBe(255);
    }
  }
}

const TYPES: NoiseType[] = ['perlin', 'perlinVec3', 'fbm', 'fbmVec3', 'cellNoise', 'voronoi', 'voronoiVec2', 'voronoiVec3'];

describe('renderNoisePreview: the window the shader samples', () => {
  it('every pixel is the noise at its centre, x across channel 0 and y UP channel 1', () => {
    const win = { min: [-1.3, -0.7, 0.2], max: [2.1, 1.9, 0.8] };
    for (const type of TYPES) expectCard(type, win, 2);
  });

  it("a pos of any width is converted as three converts it (float, vec2, vec4; fBm's vec3 layout)", () => {
    const wins: NoiseWindow[] = [
      { min: [-2], max: [3] },                         // float: (f, f), fBm (f, f, f)
      { min: [0, 0], max: [1, 1] },                    // vec2 (uv): fBm pads z = 0
      { min: [-1, -1, -1, 5], max: [1, 1, 1, 9] },     // vec4: .zw dropped, fBm drops .w
    ];
    for (const win of wins) for (const type of TYPES) expectCard(type, win, 3);
  });

  it('a third channel is held at its middle: the card is a slice', () => {
    const lowZ = render('perlin', { min: [-1, -1, 0.1], max: [1, 1, 0.1] }, 2);
    const spanZ = render('perlin', { min: [-1, -1, -0.6], max: [1, 1, 0.8] }, 2);
    expect([...spanZ]).toEqual([...lowZ]);
  });

  it('Scale multiplies the window, as `pos.mul(scale)` does', () => {
    const twice = { min: [-2, -2, -2], max: [2, 2, 2] };
    expect([...render('voronoi', DEFAULT_NOISE_WINDOW, 2)]).toEqual([...render('voronoi', twice, 1)]);
  });

  it("null is an unwired pos: Position's ±1, the default sphere", () => {
    expect(DEFAULT_NOISE_WINDOW).toEqual({ min: [-1, -1, -1], max: [1, 1, 1] });
    expect([...render('fbm', null)]).toEqual([...render('fbm', DEFAULT_NOISE_WINDOW)]);
  });

  it("a junk window draws Position's span and never throws", () => {
    const def = [...render('perlin', DEFAULT_NOISE_WINDOW)];
    expect([...render('perlin', { min: [], max: [] })]).toEqual(def);
    expect([...render('perlin', { min: [Number.NaN, -Infinity, -1], max: [Infinity, 1, 1] })]).toEqual(def);
    // A reversed channel reads ordered.
    expect([...render('perlin', { min: [1, 1, 1], max: [-1, -1, -1] })]).toEqual(def);
    expect(() => render('voronoiVec3', { min: [1e300, -1e300, 0], max: [1e301, 1e300, 0] })).not.toThrow();
  });

  it('a big card at a Scale that steps a cell every few rows, either way up, is still exact', () => {
    // The renderer draws one grid (mxNoiseGrid) and reads each byte off a
    // table; the 8 px cards above cannot reach the cell-to-cell sharing.
    const N = 40;
    const big = { width: N, height: N, data: new Uint8ClampedArray(N * N * 4) } as unknown as ImageData;
    const win = { min: [-1.1, -0.9, 0.3], max: [1.3, 1.2, 0.3] };
    for (const scale of [6, -3.5]) {
      for (const type of TYPES) {
        const data = renderNoisePreview(type, N, { scale }, win, big).data;
        let bad = 0;
        for (let y = 0; y < N; y++) {
          for (let x = 0; x < N; x++) {
            const c0 = win.min[0] + (win.max[0] - win.min[0]) * ((x + 0.5) / N);
            const c1 = win.max[1] - (win.max[1] - win.min[1]) * ((y + 0.5) / N);
            const v = mxNoise(type, [c0 * scale, c1 * scale, 0.3 * scale])[0];
            const want = Math.round(linearToSrgb01(rawNoiseDisplay(type, v)) * 255);
            const i = (y * N + x) * 4;
            if (data[i] !== want || data[i + 1] !== want || data[i + 2] !== want || data[i + 3] !== 255) bad++;
          }
        }
        expect(bad, `${type} at Scale ${scale}`).toBe(0);
      }
    }
  });

  it('a junk Scale reads 1, as the evaluator reads it', () => {
    const one = [...render('cellNoise', DEFAULT_NOISE_WINDOW, 1)];
    expect([...renderNoisePreview('cellNoise', SIZE, { scale: 'x' }, null, buffer()).data]).toEqual(one);
  });
});

describe('rawNoiseDisplay: the card shows the value as the mesh shows it', () => {
  it('maps a signed Perlin/fBm value (v + 1)/2 — what an unsigned node outputs', () => {
    expect(rawNoiseDisplay('perlin', -1)).toBe(0);
    expect(rawNoiseDisplay('fbmVec3', 0)).toBe(0.5);
    expect(rawNoiseDisplay('fbm', 1.6)).toBe(1);
  });

  it('shows cell noise and Voronoi (F1², the squared distance) as they are, clamped', () => {
    expect(rawNoiseDisplay('cellNoise', 0.25)).toBe(0.25);
    expect(rawNoiseDisplay('voronoi', 0.36)).toBe(0.36);
    expect(rawNoiseDisplay('voronoiVec3', 2.7)).toBe(1);
    expect(rawNoiseDisplay('voronoi', -0.1)).toBe(0);
  });
});

describe('noiseGreyByte: greyByte without a pow per pixel, to the last bit', () => {
  const ref = (d: number) => Math.round(linearToSrgb01(d) * 255);

  it('agrees on a dense sweep, at random, and at the ends', () => {
    const bad: number[] = [];
    for (let i = 0; i <= 100_000; i++) {
      const d = i / 100_000;
      if (noiseGreyByte(d) !== ref(d)) bad.push(d);
    }
    let seed = 7;
    for (let i = 0; i < 100_000; i++) {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      const d = seed / 4294967296;
      if (noiseGreyByte(d) !== ref(d)) bad.push(d);
    }
    for (const d of [0, 1, -1, 2, Number.NaN, Infinity, 5e-324, 0.0031308, 0.0031308 * (1 + 2 ** -52), 1 - 2 ** -53]) {
      if (noiseGreyByte(d) !== ref(d)) bad.push(d);
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it('agrees on both sides of every step, down to neighbouring doubles', () => {
    const bad: number[] = [];
    for (let k = 1; k <= 255; k++) {
      // Where linearToSrgb01(d)·255 reaches k − ½.
      const c = (k - 0.5) / 255;
      const edge = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      for (let j = -16; j <= 16; j++) {
        for (const d of [edge * (1 + j * 2 ** -52), edge + j * 1e-12]) {
          if (noiseGreyByte(d) !== ref(d)) bad.push(d);
        }
      }
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });
});
