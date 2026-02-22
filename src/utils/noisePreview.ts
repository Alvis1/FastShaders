// CPU-based 2D noise for node preview thumbnails

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
function lerp(t: number, a: number, b: number): number { return a + t * (b - a); }

function grad2(hash: number, x: number, y: number): number {
  const h = hash & 3;
  const u = h < 2 ? x : y;
  const v = h < 2 ? y : x;
  return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
}

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

  return lerp(v,
    lerp(u, grad2(aa, xf, yf), grad2(ba, xf - 1, yf)),
    lerp(u, grad2(ab, xf, yf - 1), grad2(bb, xf - 1, yf - 1)),
  );
}

export function fbm2D(
  x: number, y: number,
  octaves: number, lacunarity: number, diminish: number,
): number {
  let value = 0, amplitude = 1, frequency = 1, maxAmp = 0;
  for (let i = 0; i < octaves; i++) {
    value += perlin2D(x * frequency, y * frequency) * amplitude;
    maxAmp += amplitude;
    amplitude *= diminish;
    frequency *= lacunarity;
  }
  return value / maxAmp;
}

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

export type NoiseType = 'noise' | 'fractal' | 'voronoi';

/** Which input ports of the noise node are driven by time. */
export interface TimeInputs {
  pos?: boolean;
  octaves?: boolean;
  lacunarity?: boolean;
  diminish?: boolean;
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
  const baseMultiplier = type === 'fractal' ? 8.0 : 4.0;
  const scale = baseMultiplier * userScale;

  // Time-driven position offset (when time feeds into pos)
  const posOffset = timeInputs.pos ? time * 0.4 : 0;

  // Time-driven parameter modulation (oscillate ±30% around base value)
  const baseOctaves = Number(values.octaves ?? 4);
  const octaves = timeInputs.octaves
    ? Math.max(1, Math.round(baseOctaves + Math.sin(time * 0.8) * 3))
    : baseOctaves;

  const baseLacunarity = Number(values.lacunarity ?? 2);
  const lacunarity = timeInputs.lacunarity
    ? baseLacunarity + Math.sin(time * 0.6) * baseLacunarity * 0.3
    : baseLacunarity;

  const baseDiminish = Number(values.diminish ?? 0.5);
  const diminish = timeInputs.diminish
    ? Math.max(0.05, baseDiminish + Math.sin(time * 0.5) * baseDiminish * 0.4)
    : baseDiminish;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = (x / size) * scale + posOffset;
      const ny = (y / size) * scale + posOffset * 0.75;

      let v: number;
      switch (type) {
        case 'noise':
          v = (perlin2D(nx, ny) + 1) * 0.5;
          break;
        case 'fractal':
          v = (fbm2D(nx, ny, octaves, lacunarity, diminish) + 1) * 0.5;
          break;
        case 'voronoi':
          v = voronoi2D(nx, ny);
          break;
      }

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
