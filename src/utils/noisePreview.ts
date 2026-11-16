// Noise THUMBNAILS. The noise node's card draws three's own MaterialX noise
// (utils/mxNoise — the numbers the shader computes) over the range of values
// its `pos` input takes, so the card is a picture of what the 3D view samples:
// the same lattice, contrast and scale, moving as the mesh moves.
//
// `perlin2D` below is NOT that: a 2-D Ken-Perlin stand-in kept only for the
// DECORATIVE tiles that imitate a preset's look (PresetCard, TextureCard, the
// LED tile, the tutorial shades). It is never a noise node's card again — as
// one it shared nothing with the GPU but the name (twice the contrast, another
// lattice, no third axis), and the card could never look like the mesh.

import { valueNum } from './valueCoerce';
import { mxNoiseChannel, mxNoiseGrid, type MxNoiseType } from './mxNoise';
import { MODEL_POSITION_BOUND } from './modelPositionBound';
import { linearToSrgb01 } from './colorUtils';

/**
 * A 0…1 LINEAR value as the byte the 3D view shows for it. The shader's value
 * is linear light and the preview writes it out sRGB-encoded (no tone
 * mapping), so mid-grey 0.5 is drawn ~0.74 on the mesh; a card that wrote the
 * raw value read a third darker than the sphere beside it (measured
 * 2026-11-16: mesh 0.77, card 0.53, on the same unlit Perlin). The Color Ramp
 * card encodes the same way (colorRamp.ts).
 */
function greyByte(display: number): number {
  return Math.round(linearToSrgb01(display) * 255);
}

// Permutation table (Ken Perlin's original)
const PERM = new Uint8Array(512);
const P = [
  151,160,137,91,90,15,131,13,201,95,96,53,194,233,7,225,140,36,103,30,69,142,
  8,99,37,240,21,10,23,190,6,148,247,120,234,75,0,26,197,62,94,252,219,203,117,
  35,11,32,57,177,33,88,237,149,56,87,174,20,125,136,171,168,68,175,74,165,71,
  134,139,48,27,166,77,146,158,231,83,111,229,122,60,211,133,230,220,105,92,41,
  55,46,245,40,244,102,143,54,65,25,63,161,1,216,80,73,209,76,132,187,208,89,
  18,169,200,196,135,130,116,188,159,86,164,100,109,198,173,186,3,64,52,217,226,
  250,124,123,5,202,38,147,118,126,255,82,85,212,207,206,59,227,47,16,58,17,182,
  189,28,42,223,183,170,213,119,248,152,2,44,154,163,70,221,153,101,155,167,43,
  172,9,129,22,39,253,19,98,108,110,79,113,224,232,178,185,112,104,218,246,97,
  228,251,34,242,193,238,210,144,12,191,179,162,241,81,51,145,235,249,14,239,
  107,49,192,214,31,181,199,106,157,184,84,204,176,115,121,50,45,127,4,150,254,
  138,236,205,93,222,114,67,29,24,72,243,141,128,195,78,66,215,61,156,180,
];
for (let i = 0; i < 256; i++) { PERM[i] = P[i]; PERM[i + 256] = P[i]; }

function fade(t: number): number { return t * t * t * (t * (t * 6 - 15) + 10); }
function lerp(a: number, b: number, t: number): number { return a + t * (b - a); }
function grad(hash: number, x: number, y: number): number {
  const h = hash & 7;
  const u = h < 4 ? x : y;
  const v = h < 4 ? y : x;
  return ((h & 1) ? -u : u) + ((h & 2) ? -2 * v : 2 * v);
}

/** Perlin noise in roughly [-1, 1]. */
export function perlin2D(x: number, y: number): number {
  const xi = Math.floor(x) & 255;
  const yi = Math.floor(y) & 255;
  const xf = x - Math.floor(x);
  const yf = y - Math.floor(y);
  const u = fade(xf);
  const v = fade(yf);
  const aa = PERM[PERM[xi] + yi];
  const ab = PERM[PERM[xi] + yi + 1];
  const ba = PERM[PERM[xi + 1] + yi];
  const bb = PERM[PERM[xi + 1] + yi + 1];
  return lerp(
    lerp(grad(aa, xf, yf), grad(ba, xf - 1, yf), u),
    lerp(grad(ab, xf, yf - 1), grad(bb, xf - 1, yf - 1), u),
    v,
  );
}

export type NoiseType = MxNoiseType;

/**
 * The span of values a noise's `pos` takes over the surface, per channel:
 * the card's x runs across channel 0, its y UP channel 1 (3-D y is up, a
 * canvas row is down), and any further channel is held at its middle — a
 * slice. It is cpuEvaluator's RANGE of the `pos` wire at the card's time, so
 * `Position + Time` slides the window exactly as the shader's input slides,
 * `Position × 3` widens it, and a float `pos` gives stripes, as on the mesh.
 */
export interface NoiseWindow {
  readonly min: readonly number[];
  readonly max: readonly number[];
}

/** Unwired `pos` is Position: the default sphere's ±1 in every axis. */
export const DEFAULT_NOISE_WINDOW: NoiseWindow = {
  min: [-MODEL_POSITION_BOUND, -MODEL_POSITION_BOUND, -MODEL_POSITION_BOUND],
  max: [MODEL_POSITION_BOUND, MODEL_POSITION_BOUND, MODEL_POSITION_BOUND],
};

/**
 * The 0…1 grey for one RAW noise value: a signed Perlin/fBm value maps
 * (v + 1)/2 — what an unsigned node (`.mul(0.5).add(0.5)`) shows on the mesh,
 * so the range switch never changes the card — and everything else is the
 * value itself, clamped as a colour channel clamps: cell noise is 0…1 and
 * Voronoi is F1², the SQUARED distance the shader holds (three passes metric 1).
 */
export function rawNoiseDisplay(type: NoiseType, v: number): number {
  const signed = type === 'perlin' || type === 'perlinVec3' || type === 'fbm' || type === 'fbmVec3';
  const d = signed ? (v + 1) * 0.5 : v;
  return d > 0 ? (d < 1 ? d : 1) : 0;
}

/** A window channel the card can draw: finite and ordered, else Position's ±1. */
function windowChannel(win: NoiseWindow, c: number): [number, number] {
  const lo = win.min[c], hi = win.max[c];
  if (typeof lo !== 'number' || typeof hi !== 'number' || !Number.isFinite(lo) || !Number.isFinite(hi)) {
    return [-MODEL_POSITION_BOUND, MODEL_POSITION_BOUND];
  }
  return lo <= hi ? [lo, hi] : [hi, lo];
}

/*
 * THE BYTE without a Math.pow per pixel. greyByte is a monotone step function
 * of the 0…1 display value, so it is fixed by the 255 values where it steps up.
 * Those are found ONCE, by bisection on greyByte itself down to adjacent
 * doubles, so the table answers exactly what greyByte answers (noisePreview
 * Window.test.ts sweeps it); a 4097-bucket guess lands within one step, since
 * the narrowest step (sRGB's linear toe, 1/(255 · 12.92) ≈ 3.0e-4) is wider
 * than a bucket (2.4e-4). The pow was a tenth of a card's whole cost.
 */
const GREY_BUCKETS = 4096;
/** [k] = the least display value whose byte is ≥ k; [0] = −∞, [256] = +∞. */
let greyStep: Float64Array | null = null;
/** A starting byte per 1/GREY_BUCKETS of the display range. */
let greyGuess: Uint8Array | null = null;
/** Per byte: the opaque grey pixel as ONE 32-bit word in this machine's order. */
let greyPixel: Uint32Array | null = null;

function greyTables(): void {
  const step = new Float64Array(257);
  step[0] = -Infinity;
  step[256] = Infinity;
  for (let k = 1; k <= 255; k++) {
    // greyByte(0) = 0 < k ≤ 255 = greyByte(1).
    let lo = 0, hi = 1;
    for (;;) {
      const mid = lo + (hi - lo) / 2;
      if (mid <= lo || mid >= hi) break;
      if (greyByte(mid) >= k) hi = mid;
      else lo = mid;
    }
    step[k] = hi;
  }
  const guess = new Uint8Array(GREY_BUCKETS + 1);
  let b = 0;
  for (let i = 0; i <= GREY_BUCKETS; i++) {
    const d = i / GREY_BUCKETS;
    while (d >= step[b + 1]) b++;
    guess[i] = b;
  }
  const littleEndian = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
  const pixel = new Uint32Array(256);
  for (let g = 0; g < 256; g++) {
    pixel[g] = littleEndian
      ? ((255 << 24) | (g << 16) | (g << 8) | g) >>> 0
      : ((g << 24) | (g << 16) | (g << 8) | 255) >>> 0;
  }
  greyStep = step;
  greyGuess = guess;
  greyPixel = pixel;
}

/** The table read: the one byte whose step range holds `d` (0…1). */
function tableByte(d: number, step: Float64Array, guess: Uint8Array): number {
  let b = guess[(d * GREY_BUCKETS) | 0];
  while (d >= step[b + 1]) b++;
  while (d < step[b]) b--;
  return b;
}

/**
 * The byte a card writes for a 0…1 display value (clamped; a non-finite one
 * reads 0, as greyByte reads it) — greyByte, read off its table.
 */
export function noiseGreyByte(display: number): number {
  if (greyStep === null) greyTables();
  const d = !Number.isFinite(display) ? 0 : display > 0 ? (display < 1 ? display : 1) : 0;
  return tableByte(d, greyStep!, greyGuess!);
}

/** Shared per-size scratch: the grid's coordinates and values. */
let gridXs = new Float64Array(0);
let gridYs = new Float64Array(0);
let gridOut = new Float64Array(0);

/**
 * Render one greyscale noise thumbnail: channel 0 of the node's output at
 * `mx_…(pos · scale)` for every pixel of `win` (null = unwired, Position).
 *
 * `reuse` is an optional scratch buffer for callers that redraw on a clock —
 * PreviewNode's animated cards run this on the shared 15 Hz frame ticker
 * (utils/frameTicker), and a fresh
 * `ImageData` per frame is 4·size² bytes of garbage each time (36 KB at the
 * 96 px preview size, so four animated cards minted ~4 MB/s for the collector
 * to sweep at the old 30 Hz). Passing the previous buffer back in reuses it; anything of the
 * wrong shape (or nothing at all) allocates.
 *
 * Reuse is safe because the loop below writes ALL FOUR bytes of every pixel —
 * the three channels from the sample and alpha pinned to 255 — so no part of
 * the previous frame can survive into this one, and `putImageData` copies into
 * the canvas synchronously, so a caller can never be holding the returned
 * buffer across a redraw.
 *
 * The input is converted as three converts it (mxNoiseInput, spelled out per
 * width here): fBm's vec3 layout splats a float and pads a vec2 with z = 0;
 * every other call keeps a vec3 and reads any other width as a vec2 — a float
 * splats (f, f), a vec4 drops .zw. Every value is EXACTLY mxNoiseChannel's at
 * the pixel's centre: the picture is computed as one grid (mxNoiseGrid) — a
 * float `pos`, the one case that is no grid, is a diagonal, the same in every
 * row — and its byte read off greyByte's table.
 */
export function renderNoisePreview(
  type: NoiseType,
  size: number,
  values: Record<string, string | number>,
  win: NoiseWindow | null,
  reuse?: ImageData | null,
): ImageData {
  const imageData =
    reuse && reuse.width === size && reuse.height === size ? reuse : new ImageData(size, size);
  const data = imageData.data;
  const rawScale = valueNum(values.scale ?? 1);
  const scale = Number.isFinite(rawScale) ? rawScale : 1;
  const span = win !== null && win.min.length > 0 && win.max.length > 0 ? win : DEFAULT_NOISE_WINDOW;
  const w = Math.min(span.min.length, span.max.length, 4);
  const [lo0, hi0] = windowChannel(span, 0);
  const [lo1, hi1] = w >= 2 ? windowChannel(span, 1) : [0, 0];
  const [lo2, hi2] = w >= 3 ? windowChannel(span, 2) : [0, 0];
  const mid2 = (lo2 + hi2) * 0.5;
  const fbm = type === 'fbm' || type === 'fbmVec3';
  // Three dimensions when three does: a vec3 pos, or fBm with anything but a vec2…
  const threeD = fbm || w === 3;

  if (gridXs.length !== size) {
    gridXs = new Float64Array(size);
    gridYs = new Float64Array(size);
    gridOut = new Float64Array(size * size);
  }
  const xs = gridXs, ys = gridYs, out = gridOut;
  for (let x = 0; x < size; x++) xs[x] = (lo0 + (hi0 - lo0) * ((x + 0.5) / size)) * scale;
  if (w === 1) {
    // A float pos has no channel 1: (f, f) — fBm's (f, f, f) — a diagonal, so
    // every row is the first.
    for (let x = 0; x < size; x++) out[x] = mxNoiseChannel(type, xs[x], xs[x], fbm ? xs[x] : null, 0);
    for (let y = 1; y < size; y++) out.copyWithin(y * size, 0, size);
  } else {
    // Channel 1 runs UP the card.
    for (let y = 0; y < size; y++) ys[y] = (hi1 - (hi1 - lo1) * ((y + 0.5) / size)) * scale;
    // …and the third coordinate the call receives: a vec2 pads fBm's z with 0.
    const z = threeD ? (fbm && w === 2 ? 0 : mid2) * scale : null;
    mxNoiseGrid(type, xs, ys, z, out, 0);
  }

  if (greyStep === null) greyTables();
  const step = greyStep!, guess = greyGuess!, pixel = greyPixel!;
  const signed = type === 'perlin' || type === 'perlinVec3' || type === 'fbm' || type === 'fbmVec3';
  const aligned = data.byteOffset % 4 === 0;
  const px = aligned ? new Uint32Array(data.buffer, data.byteOffset, size * size) : null;
  for (let i = 0, n = size * size; i < n; i++) {
    // rawNoiseDisplay, inlined.
    const v = out[i];
    const raw = signed ? (v + 1) * 0.5 : v;
    const b = tableByte(raw > 0 ? (raw < 1 ? raw : 1) : 0, step, guess);
    if (px !== null) {
      px[i] = pixel[b];
    } else {
      const idx = i * 4;
      data[idx] = b;
      data[idx + 1] = b;
      data[idx + 2] = b;
      data[idx + 3] = 255;
    }
  }
  return imageData;
}

/**
 * The grey a FLAT thumbnail shows for a noise node's evaluated value `v`
 * (cpuEvaluator's sample, already remapped by the node's range flag), on the
 * same 0…1 display scale as the pattern above: a signed Perlin/fBm value is
 * mapped (v + 1)/2 exactly as `rawNoiseDisplay` maps the raw field, so one value
 * reads the same grey in either range mode. `null` — the input is unknown (the
 * camera position) — is the scale's middle grey: a tone, never a pattern.
 */
export function flatNoiseDisplay(type: NoiseType, v: number | null, unsigned: boolean): number {
  if (v === null || !Number.isFinite(v)) return 0.5;
  // An unsigned node's value is already (raw + 1)/2: shown as it is, clamped.
  if (unsigned) return v > 0 ? (v < 1 ? v : 1) : 0;
  return rawNoiseDisplay(type, v);
}

/**
 * One flat grey thumbnail — the card of a noise whose input is ONE value per
 * frame for the whole surface (its `pos` wired to the camera position, Sound,
 * Time alone or a constant: `getSurfaceFieldUpstreamSet`). The shader then
 * paints the whole mesh one tone, so a pattern on the card would show something
 * the model never does. `reuse` as in `renderNoisePreview`; every byte written.
 */
export function renderFlatNoisePreview(size: number, display: number, reuse?: ImageData | null): ImageData {
  const imageData =
    reuse && reuse.width === size && reuse.height === size ? reuse : new ImageData(size, size);
  const data = imageData.data;
  const byte = greyByte(display);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = byte;
    data[i + 1] = byte;
    data[i + 2] = byte;
    data[i + 3] = 255;
  }
  return imageData;
}
