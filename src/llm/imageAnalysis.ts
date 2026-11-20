/**
 * What the app can MEASURE in a picture, with no model: its colours, its
 * brightness and contrast, how many features fit across, which way they run,
 * whether they repeat. A request made with a picture carries these as a few
 * lines of text (`pictureLines`), so ANY model can use the picture — the small
 * local ones included, which cannot see — and the picture itself never leaves
 * the computer (docs/dev/node-generator.md § A picture in the request).
 *
 * PURE: pixels in, numbers and fixed words out. Nothing the lines say is text
 * from the file — a hex colour, a count, an angle, a word from the tables
 * below — so a picture cannot carry an instruction into the prompt. The
 * pixels are adversarial like every dropped file: every size is checked, and
 * nothing here throws.
 *
 * Deterministic: the same pixels give the same lines, byte for byte (no
 * random start for the colour clustering).
 */

/** RGBA pixels, row by row from the top — a canvas `ImageData`'s shape. */
export interface PixelGrid {
  width: number;
  height: number;
  data: ArrayLike<number>;
}

/** What the picture looks like, as one of a fixed set. */
export type PictureHint = 'flat' | 'gradient' | 'stripes' | 'streaks' | 'grid' | 'grain' | 'blotches' | 'clouds';

export interface PictureDirection {
  /** `rising` / `falling`: diagonal, read left to right. */
  kind: 'horizontal' | 'vertical' | 'rising' | 'falling';
  /** Degrees from horizontal, 0–90. */
  angle: number;
}

export interface PictureFacts {
  /** Most common first; `share` is 0–1 of the opaque pixels. */
  palette: { hex: string; share: number }[];
  /** Mean lightness, 0 (black) – 1 (white). */
  brightness: number;
  /** Spread of the lightness (its standard deviation). */
  contrast: number;
  /** Light-and-dark cycles across the width and down the height; 0 = none. */
  across: number;
  down: number;
  /** Which way the features run, or null when no way dominates. */
  direction: PictureDirection | null;
  /** The features repeat evenly. */
  regular: boolean;
  /** Two flat tones with hard edges between them. */
  sharp: boolean;
  /** For a smooth fade: the brighter side. */
  brighter: 'top' | 'bottom' | 'left' | 'right' | null;
  hint: PictureHint;
}

/** The longest side the measuring grid may have; a larger picture is averaged down. */
export const ANALYSIS_GRID = 96;
/** The longest side read from the source: past it pixels are skipped, not averaged. */
const MAX_SOURCE_SIDE = 1024;
const MAX_COLOURS = 5;
/** Colours closer than this (Oklab distance) count as one. */
const MERGE_DISTANCE = 0.05;
/** A colour under this share of the picture is left out. */
const MIN_SHARE = 0.03;
/** Under this share, a colour between two larger ones counts as their blended edge. */
const BLEND_SHARE = 0.12;
/** Lightness spread under which the picture is one flat colour. */
const FLAT_CONTRAST = 0.03;

const srgbToLinear = (v: number): number => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const linearToSrgb = (c: number): number => {
  const v = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.max(c, 0) ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(v * 255)));
};

/** Linear sRGB → Oklab (Björn Ottosson's matrices). */
function toOklab(r: number, g: number, b: number): [number, number, number] {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabToHex(L: number, a: number, b: number): string {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return `#${rgb.map((c) => linearToSrgb(c).toString(16).padStart(2, '0')).join('')}`;
}

interface Grid {
  w: number;
  h: number;
  /** Oklab per cell, 3 values each. */
  lab: Float64Array;
  /** 1 where the cell holds something to look at (not transparent). */
  solid: Uint8Array;
  solidCount: number;
}

/** Average the picture down to the measuring grid, in linear light. */
function measuringGrid(p: PixelGrid): Grid | null {
  const { width, height, data } = p;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) return null;
  if (!data || typeof data.length !== 'number' || data.length < width * height * 4) return null;
  const scale = Math.min(1, ANALYSIS_GRID / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  // Read at most MAX_SOURCE_SIDE samples a side, however large the source is.
  const stepX = Math.max(1, Math.ceil(width / MAX_SOURCE_SIDE));
  const stepY = Math.max(1, Math.ceil(height / MAX_SOURCE_SIDE));
  const sum = new Float64Array(w * h * 4);
  for (let y = 0; y < height; y += stepY) {
    const gy = Math.min(h - 1, Math.floor((y * h) / height));
    for (let x = 0; x < width; x += stepX) {
      const gx = Math.min(w - 1, Math.floor((x * w) / width));
      const i = (y * width + x) * 4;
      const alpha = Number(data[i + 3]) / 255;
      if (!(alpha > 0)) continue;
      const o = (gy * w + gx) * 4;
      sum[o] += srgbToLinear(Number(data[i])) * alpha;
      sum[o + 1] += srgbToLinear(Number(data[i + 1])) * alpha;
      sum[o + 2] += srgbToLinear(Number(data[i + 2])) * alpha;
      sum[o + 3] += alpha;
    }
  }
  const lab = new Float64Array(w * h * 3);
  const solid = new Uint8Array(w * h);
  let solidCount = 0;
  for (let c = 0; c < w * h; c++) {
    const weight = sum[c * 4 + 3];
    if (!(weight > 0)) continue;
    const [L, a, b] = toOklab(sum[c * 4] / weight, sum[c * 4 + 1] / weight, sum[c * 4 + 2] / weight);
    if (!Number.isFinite(L) || !Number.isFinite(a) || !Number.isFinite(b)) continue;
    lab[c * 3] = L;
    lab[c * 3 + 1] = a;
    lab[c * 3 + 2] = b;
    solid[c] = 1;
    solidCount++;
  }
  return solidCount > 0 ? { w, h, lab, solid, solidCount } : null;
}

/**
 * The picture's colours: k-means in Oklab from a FIXED start (the cell nearest
 * the mean, then each time the cell farthest from every centre so far), close
 * centres merged, rare ones dropped.
 */
function palette(g: Grid): { hex: string; share: number }[] {
  const cells: number[] = [];
  for (let c = 0; c < g.w * g.h; c++) if (g.solid[c]) cells.push(c);
  const lab = g.lab;
  const dist = (c: number, k: number[]): number =>
    (lab[c * 3] - k[0]) ** 2 + (lab[c * 3 + 1] - k[1]) ** 2 + (lab[c * 3 + 2] - k[2]) ** 2;

  const mean = [0, 0, 0];
  for (const c of cells) for (let j = 0; j < 3; j++) mean[j] += lab[c * 3 + j] / cells.length;
  const centres: number[][] = [];
  let first = cells[0];
  for (const c of cells) if (dist(c, mean) < dist(first, mean)) first = c;
  centres.push([lab[first * 3], lab[first * 3 + 1], lab[first * 3 + 2]]);
  const nearest = new Float64Array(cells.length).fill(Infinity);
  while (centres.length < MAX_COLOURS + 1) {
    let far = -1;
    let farD = MERGE_DISTANCE ** 2;
    const latest = centres[centres.length - 1];
    for (let i = 0; i < cells.length; i++) {
      nearest[i] = Math.min(nearest[i], dist(cells[i], latest));
      if (nearest[i] > farD) { farD = nearest[i]; far = i; }
    }
    if (far < 0) break;
    const c = cells[far];
    centres.push([lab[c * 3], lab[c * 3 + 1], lab[c * 3 + 2]]);
  }

  const owner = new Int32Array(cells.length);
  let counts: number[] = [];
  for (let round = 0; round < 12; round++) {
    const sums = centres.map(() => [0, 0, 0]);
    counts = centres.map(() => 0);
    for (let i = 0; i < cells.length; i++) {
      let best = 0;
      let bestD = Infinity;
      for (let k = 0; k < centres.length; k++) {
        const d = dist(cells[i], centres[k]);
        if (d < bestD) { bestD = d; best = k; }
      }
      owner[i] = best;
      counts[best]++;
      for (let j = 0; j < 3; j++) sums[best][j] += lab[cells[i] * 3 + j];
    }
    for (let k = 0; k < centres.length; k++) {
      if (counts[k] > 0) centres[k] = sums[k].map((v) => v / counts[k]);
    }
  }

  // Merge what k-means split that the eye would call one colour.
  let groups = centres.map((c, k) => ({ c, n: counts[k] })).filter((x) => x.n > 0);
  for (let merged = true; merged; ) {
    merged = false;
    outer: for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const a = groups[i];
        const b = groups[j];
        const d = Math.hypot(a.c[0] - b.c[0], a.c[1] - b.c[1], a.c[2] - b.c[2]);
        if (d >= MERGE_DISTANCE) continue;
        const n = a.n + b.n;
        groups[i] = { c: a.c.map((v, q) => (v * a.n + b.c[q] * b.n) / n), n };
        groups.splice(j, 1);
        merged = true;
        break outer;
      }
    }
  }
  groups.sort((a, b) => b.n - a.n || a.c[0] - b.c[0]);
  // A rare colour lying BETWEEN two common ones is the blend along their
  // shared edge (the grid averages pixels), not a colour of the picture: its
  // cells go to the nearer of the two.
  const gap = (a: number[], b: number[]): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  for (let i = groups.length - 1; i >= 2; i--) {
    const c = groups[i];
    if (c.n / cells.length >= BLEND_SHARE) continue;
    let home = -1;
    for (let a = 0; a < i && home < 0; a++) {
      for (let b = a + 1; b < i; b++) {
        if (gap(groups[a].c, c.c) + gap(c.c, groups[b].c) > gap(groups[a].c, groups[b].c) * 1.15) continue;
        home = gap(groups[a].c, c.c) <= gap(groups[b].c, c.c) ? a : b;
        break;
      }
    }
    if (home < 0) continue;
    groups[home] = { c: groups[home].c, n: groups[home].n + c.n };
    groups.splice(i, 1);
  }
  groups.sort((a, b) => b.n - a.n || a.c[0] - b.c[0]);
  const kept = groups.filter((x, i) => i === 0 || x.n / cells.length >= MIN_SHARE).slice(0, MAX_COLOURS);

  // The colours as REPORTED: every cell goes to the nearest kept colour, and
  // each colour is its cells' MIDDLE value per channel, not their mean — so a
  // flat colour comes back exact although a few of its cells are edge blends.
  const members: number[][][] = kept.map(() => [[], [], []]);
  for (const c of cells) {
    let best = 0;
    let bestD = Infinity;
    for (let k = 0; k < kept.length; k++) {
      const d = dist(c, kept[k].c);
      if (d < bestD) { bestD = d; best = k; }
    }
    for (let j = 0; j < 3; j++) members[best][j].push(lab[c * 3 + j]);
  }
  return members
    .map((m) => ({ hex: oklabToHex(median(m[0]), median(m[1]), median(m[2])), share: m[0].length / cells.length }))
    .filter((c) => c.share > 0)
    .sort((x, y) => y.share - x.share || (x.hex < y.hex ? -1 : 1));
}

/** The middle value of a list (0 for an empty one). */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Light-and-dark cycles along one line of lightness values: sign changes
 * around the mean, with a dead band so a value hovering at the mean does not
 * count as a feature each time it wobbles.
 */
function cyclesAlong(line: Float64Array, n: number, mean: number, band: number): number {
  let sign = 0;
  let changes = 0;
  for (let i = 0; i < n; i++) {
    // A 3-tap smooth: one stray cell is not a feature.
    const v = (line[Math.max(0, i - 1)] + 2 * line[i] + line[Math.min(n - 1, i + 1)]) / 4 - mean;
    const s = v > band ? 1 : v < -band ? -1 : 0;
    if (s === 0 || s === sign) continue;
    if (sign !== 0) changes++;
    sign = s;
  }
  return changes / 2;
}

/** How well a line matches itself shifted by `lag`: 1 = exactly, 0 = not at all. */
function selfMatch(L: Float64Array, w: number, h: number, mean: number, lagX: number, lagY: number): number {
  let num = 0;
  let den = 0;
  for (let y = 0; y + lagY < h; y++) {
    for (let x = 0; x + lagX < w; x++) {
      const a = L[y * w + x] - mean;
      const b = L[(y + lagY) * w + (x + lagX)] - mean;
      num += a * b;
      den += (a * a + b * b) / 2;
    }
  }
  return den > 0 ? num / den : 0;
}

/** The best self-match at a shift near one feature's length (±30%). */
function repeatStrength(L: Float64Array, w: number, h: number, mean: number, cycles: number, alongX: boolean): number {
  const size = alongX ? w : h;
  if (cycles < 1.5) return 0;
  const period = size / cycles;
  let best = 0;
  for (let lag = Math.max(2, Math.floor(period * 0.7)); lag <= Math.min(size - 2, Math.ceil(period * 1.3)); lag++) {
    best = Math.max(best, alongX ? selfMatch(L, w, h, mean, lag, 0) : selfMatch(L, w, h, mean, 0, lag));
  }
  return best;
}

/** Measure a picture. Null when there is nothing to measure (no pixels, all transparent, a bad size). */
export function analyzePicture(pixels: PixelGrid): PictureFacts | null {
  let g: Grid | null;
  try {
    g = measuringGrid(pixels);
  } catch {
    return null;
  }
  if (!g) return null;
  const { w, h } = g;

  // Lightness per cell; a transparent cell takes the mean, so it is no feature.
  let mean = 0;
  for (let c = 0; c < w * h; c++) if (g.solid[c]) mean += g.lab[c * 3] / g.solidCount;
  const L = new Float64Array(w * h);
  let variance = 0;
  for (let c = 0; c < w * h; c++) {
    L[c] = g.solid[c] ? g.lab[c * 3] : mean;
    variance += (L[c] - mean) ** 2 / (w * h);
  }
  const contrast = Math.sqrt(variance);
  const colours = palette(g);
  const base = { palette: colours, brightness: mean, contrast };
  if (contrast < FLAT_CONTRAST && colours.length <= 1) {
    return { ...base, across: 0, down: 0, direction: null, regular: false, sharp: false, brighter: null, hint: 'flat' };
  }

  const band = contrast * 0.3;
  const rows: number[] = [];
  const cols: number[] = [];
  const line = new Float64Array(Math.max(w, h));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) line[x] = L[y * w + x];
    rows.push(cyclesAlong(line, w, mean, band));
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) line[y] = L[y * w + x];
    cols.push(cyclesAlong(line, h, mean, band));
  }
  const across = median(rows);
  const down = median(cols);

  // Which way the lightness changes most (the structure tensor): features
  // run ACROSS that, so stripes are named by the way they run.
  let jxx = 0;
  let jyy = 0;
  let jxy = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const gx = L[y * w + x + 1] - L[y * w + x - 1];
      const gy = L[(y + 1) * w + x] - L[(y - 1) * w + x];
      jxx += gx * gx;
      jyy += gy * gy;
      jxy += gx * gy;
    }
  }
  const energy = jxx + jyy;
  const coherence = energy > 0 ? Math.hypot(jxx - jyy, 2 * jxy) / energy : 0;
  let direction: PictureDirection | null = null;
  if (coherence >= 0.4 && (across >= 1 || down >= 1)) {
    // The gradient's angle with y DOWN (pixel rows); the features run at a
    // right angle to it. Turned to y UP, so "rising" reads left to right.
    const gradient = 0.5 * Math.atan2(2 * jxy, jxx - jyy);
    let run = (Math.atan2(-Math.cos(gradient), -Math.sin(gradient)) * 180) / Math.PI;
    run = ((run % 180) + 180) % 180;
    if (run < 15 || run > 165) direction = { kind: 'horizontal', angle: 0 };
    else if (Math.abs(run - 90) < 15) direction = { kind: 'vertical', angle: 90 };
    else if (run < 90) direction = { kind: 'rising', angle: Math.round(run / 5) * 5 };
    else direction = { kind: 'falling', angle: Math.round((180 - run) / 5) * 5 };
  }

  const regular = Math.max(
    repeatStrength(L, w, h, mean, across, true),
    repeatStrength(L, w, h, mean, down, false),
  ) >= 0.45;

  // Two flat tones: nearly every cell sits at the dark end or the light end.
  let lo = Infinity;
  let hi = -Infinity;
  for (let c = 0; c < w * h; c++) { lo = Math.min(lo, L[c]); hi = Math.max(hi, L[c]); }
  let atEnds = 0;
  for (let c = 0; c < w * h; c++) if (L[c] - lo < (hi - lo) * 0.2 || hi - L[c] < (hi - lo) * 0.2) atEnds++;
  const sharp = hi - lo > 0.1 && atEnds / (w * h) >= 0.8;

  // A smooth fade: under one feature each way. Name its brighter side.
  let brighter: PictureFacts['brighter'] = null;
  const fade = across < 1 && down < 1;
  if (fade) {
    const half = (x0: number, x1: number, y0: number, y1: number): number => {
      let s = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { s += L[y * w + x]; n++; }
      return n ? s / n : mean;
    };
    const sides: [NonNullable<PictureFacts['brighter']>, number][] = [
      ['top', half(0, w, 0, h >> 1) - half(0, w, h >> 1, h)],
      ['bottom', half(0, w, h >> 1, h) - half(0, w, 0, h >> 1)],
      ['left', half(0, w >> 1, 0, h) - half(w >> 1, w, 0, h)],
      ['right', half(w >> 1, w, 0, h) - half(0, w >> 1, 0, h)],
    ];
    sides.sort((a, b) => b[1] - a[1]);
    if (sides[0][1] > contrast * 0.5) brighter = sides[0][0];
  }

  const most = Math.max(across, down);
  let hint: PictureHint;
  if (contrast < FLAT_CONTRAST) hint = 'flat';
  else if (fade) hint = 'gradient';
  else if (direction) hint = regular ? 'stripes' : 'streaks';
  else if (regular) hint = 'grid';
  // On the measuring grid white noise counts about 9: the smoothing that
  // keeps one stray cell from being a feature merges the finest ones.
  else if (most >= 8) hint = 'grain';
  else if (most >= 3) hint = 'blotches';
  else hint = 'clouds';

  return { ...base, across, down, direction, regular, sharp, brighter, hint };
}

/** What each hint is called in the prompt. */
const HINT_TEXT: Readonly<Record<PictureHint, string>> = {
  flat: 'one flat colour',
  gradient: 'a smooth fade',
  stripes: 'even stripes',
  streaks: 'uneven streaks (like wood grain or brushed metal)',
  grid: 'an even grid of cells or dots',
  grain: 'fine grain (like noise)',
  blotches: 'uneven blotches or cells (like noise or Voronoi cells)',
  clouds: 'a few large soft shapes (like clouds)',
};

/** The words that pick the worked examples when the request has no text. */
const HINT_WORDS: Readonly<Record<PictureHint, string>> = {
  flat: 'solid plain',
  gradient: 'gradient fade',
  stripes: 'stripes bands lines',
  streaks: 'streaks wood grain flow',
  grid: 'grid dots cells tiles checker',
  grain: 'noise grain',
  blotches: 'cells noise voronoi blotches',
  clouds: 'clouds smoke soft noise',
};

export const pictureHintWords = (f: PictureFacts): string => HINT_WORDS[f.hint];

const count = (n: number): string => (n >= 20 ? 'more than 20' : n < 1 ? 'under 1' : `about ${Math.round(n)}`);

/**
 * The measurements as the request carries them: a fixed frame around hex
 * colours, counts, an angle and words from the tables above. About 120 tokens.
 */
export function pictureLines(f: PictureFacts): string[] {
  const lines = ['PICTURE (measured by the app from the picture the user added; you cannot see it)'];
  lines.push(`- colours, most common first: ${f.palette.map((c) => `${c.hex} ${Math.max(1, Math.round(c.share * 100))}%`).join(', ')}`);
  const tone = f.brightness < 0.35 ? 'dark' : f.brightness > 0.7 ? 'bright' : 'medium';
  const spread = f.contrast < 0.05 ? 'very low' : f.contrast < 0.12 ? 'low' : f.contrast < 0.22 ? 'medium' : 'high';
  lines.push(`- brightness: ${tone} (${f.brightness.toFixed(2)} of 1); contrast: ${spread}`);
  if (f.hint === 'flat') {
    lines.push('- looks like: one flat colour');
  } else if (f.hint === 'gradient') {
    lines.push(`- looks like: a smooth fade${f.brighter ? `, brighter at the ${f.brighter}` : ''}`);
  } else {
    lines.push(`- scale: ${count(f.across)} light-and-dark features across, ${count(f.down)} down`);
    const d = f.direction;
    lines.push(`- direction: ${
      !d ? 'none (the features run every way)'
        : d.kind === 'horizontal' ? 'the features run horizontally'
          : d.kind === 'vertical' ? 'the features run vertically'
            : `the features run diagonally, ${d.kind} to the right at about ${d.angle} degrees`
    }`);
    lines.push(`- repetition: ${f.regular ? 'even (it repeats)' : 'uneven'}; edges: ${f.sharp ? 'hard, two flat tones' : 'soft'}`);
    lines.push(`- looks like: ${HINT_TEXT[f.hint]}`);
  }
  lines.push('Use these colours as color(0x…) values. A coordinate that runs 0 to 1 across the surface, multiplied by N, gives about N features across.');
  return lines;
}
