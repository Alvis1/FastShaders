// CPU-based 2D noise for node preview thumbnails. These are approximations of
// the GPU-side TSL functions (mx_perlin_noise_*, mx_worley_noise_*, mx_cell_*,
// mx_fractal_noise_*) — accurate enough for a recognisable thumbnail, not for
// use as actual shading. Range conventions match the GPU side: Perlin/fBm in
// [-1, 1] (mapped to [0, 1] for display), Worley/Cell in [0, 1].

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

/** Fractal Brownian motion built on Perlin (3 octaves). */
export function fbm2D(x: number, y: number): number {
  let amp = 0.5;
  let freq = 1;
  let sum = 0;
  for (let o = 0; o < 3; o++) {
    sum += amp * perlin2D(x * freq, y * freq);
    freq *= 2;
    amp *= 0.5;
  }
  return sum;
}

/** Hash-based per-cell random in [0, 1]. */
export function cellNoise2D(x: number, y: number): number {
  const ix = Math.floor(x) & 255;
  const iy = Math.floor(y) & 255;
  return PERM[PERM[ix] + iy] / 255;
}

/** Worley/Voronoi F1 distance (approximate, range ~[0, 1]). */
export function voronoi2D(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  let minDist = 1e10;

  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = ix + dx;
      const cy = iy + dy;
      // Hash-based random point within cell
      const h = PERM[(PERM[(cx & 255)] + (cy & 255)) & 255];
      const px = cx + (h / 255);
      const py = cy + (PERM[(h + 37) & 255] / 255);
      const dist = Math.sqrt((x - px) * (x - px) + (y - py) * (y - py));
      if (dist < minDist) minDist = dist;
    }
  }
  return Math.min(minDist, 1);
}

export type NoiseType =
  | 'perlin'
  | 'perlinVec3'
  | 'fbm'
  | 'fbmVec3'
  | 'cellNoise'
  | 'voronoi'
  | 'voronoiVec2'
  | 'voronoiVec3';

/** Which input ports of the noise node are driven by time. */
export interface TimeInputs {
  pos?: boolean;
}

/** Sample a single greyscale value in [0, 1] for the given noise type at (nx, ny). */
function sampleNoise(type: NoiseType, nx: number, ny: number): number {
  switch (type) {
    case 'perlin':
    case 'perlinVec3':
      // Perlin output is ~[-1, 1] → remap to [0, 1] for display
      return (perlin2D(nx, ny) + 1) * 0.5;
    case 'fbm':
    case 'fbmVec3':
      return (fbm2D(nx, ny) + 1) * 0.5;
    case 'cellNoise':
      return cellNoise2D(nx, ny);
    case 'voronoi':
    case 'voronoiVec2':
    case 'voronoiVec3':
      return voronoi2D(nx, ny);
  }
}

export function renderNoisePreview(
  type: NoiseType,
  size: number,
  values: Record<string, string | number>,
  time: number,
  timeInputs: TimeInputs,
): ImageData {
  const imageData = new ImageData(size, size);
  const data = imageData.data;
  const userScale = Number(values.scale ?? 1);
  const scale = 4.0 * userScale;

  // Time-driven position offset (when time feeds into pos)
  const posOffset = timeInputs.pos ? time * 0.4 : 0;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = (x / size) * scale + posOffset;
      const ny = (y / size) * scale + posOffset * 0.75;

      const v = sampleNoise(type, nx, ny);

      const byte = Math.round(Math.max(0, Math.min(1, v)) * 255);
      const idx = (y * size + x) * 4;
      data[idx] = byte;
      data[idx + 1] = byte;
      data[idx + 2] = byte;
      data[idx + 3] = 255;
    }
  }
  return imageData;
}
