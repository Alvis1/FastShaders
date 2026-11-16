/**
 * three r184's MaterialX noise on the CPU — the SAME numbers the shader
 * computes, so a noise card and the evaluator agree with the 3D view.
 *
 * A line-for-line port of `three/src/nodes/materialx/lib/mx_noise.js` (itself
 * MaterialX's `mx_noise.glsl`), restricted to the calls graphToCode emits for
 * the eight noise nodes, with three's defaults: `mx_noise_float/vec3` (Perlin),
 * `mx_fractal_noise_float/vec3` (3 octaves, lacunarity 2, diminish ½),
 * `mx_cell_noise_float`, and `mx_worley_noise_float/vec2/vec3` (jitter 1,
 * metric int(1) — the SQUARED distance). It replaces a 2-D Ken-Perlin stand-in
 * that shared nothing with the GPU but the name: twice the contrast, a
 * different lattice, no third axis — so a card could never look like the mesh.
 *
 * Integer maths is the shader's: Bob Jenkins' lookup3 hash on 32-bit unsigned
 * words (`>>> 0` after every step, `uint(int)` as a bit reinterpretation), and
 * `mx_bits_to_01` as the fp32 division it is. Floats are JS doubles, so a value
 * can differ from the GPU's fp32 in the last few bits — invisible on a card
 * and far inside a label's precision.
 *
 * A LEAF (no imports): cpuEvaluator and the card renderer both read it.
 */

export type MxNoiseType =
  | 'perlin'
  | 'perlinVec3'
  | 'fbm'
  | 'fbmVec3'
  | 'cellNoise'
  | 'voronoi'
  | 'voronoiVec2'
  | 'voronoiVec3';

// ===== lookup3 (mx_rotl32, mx_bjmix, mx_bjfinal, mx_hash_int) =====

/** `uint(int(0xdeadbeef)) + (len << 2) + 13` for an n-word key. */
const SEED2 = (0xdeadbeef + (2 << 2) + 13) >>> 0;
const SEED3 = (0xdeadbeef + (3 << 2) + 13) >>> 0;
const SEED4 = (0xdeadbeef + (4 << 2) + 13) >>> 0;

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

function bjfinal(a: number, b: number, c: number): number {
  c = (c ^ b) >>> 0; c = (c - rotl(b, 14)) >>> 0;
  a = (a ^ c) >>> 0; a = (a - rotl(c, 11)) >>> 0;
  b = (b ^ a) >>> 0; b = (b - rotl(a, 25)) >>> 0;
  c = (c ^ b) >>> 0; c = (c - rotl(b, 16)) >>> 0;
  a = (a ^ c) >>> 0; a = (a - rotl(c, 4)) >>> 0;
  b = (b ^ a) >>> 0; b = (b - rotl(a, 14)) >>> 0;
  c = (c ^ b) >>> 0; c = (c - rotl(b, 24)) >>> 0;
  return c;
}

/** mx_hash_int(x, y). `x >>> 0` is `uint(int x)`: the same 32 bits. */
function hash2(x: number, y: number): number {
  return bjfinal((SEED2 + (x >>> 0)) >>> 0, (SEED2 + (y >>> 0)) >>> 0, SEED2);
}

/** mx_hash_int(x, y, z). */
function hash3(x: number, y: number, z: number): number {
  return bjfinal((SEED3 + (x >>> 0)) >>> 0, (SEED3 + (y >>> 0)) >>> 0, (SEED3 + (z >>> 0)) >>> 0);
}

/**
 * mx_hash_int(x, y, z, xx) AS THREE r184 RUNS IT: with NO `mx_bjmix` round.
 * MaterialX mixes the first three words before adding the fourth, and three's
 * transpiled source still calls `mx_bjmix( a, b, c )` — but that Fn has no
 * layout and returns nothing, so the call is never built into the shader and
 * the GPU computes `bjfinal(a + xx, b, c)`. MEASURED (mxNoise.test.ts, the 3-D
 * Voronoi rows): with the mix the port missed the GPU by up to 0.74, without
 * it by 5e-7. The only caller is the 3-D Worley jitter; matching the screen is
 * the point, so the port copies the omission. Recheck on a three bump.
 */
function hash4(x: number, y: number, z: number, xx: number): number {
  const a = (SEED4 + (x >>> 0) + (xx >>> 0)) >>> 0;
  const b = (SEED4 + (y >>> 0)) >>> 0;
  const c = (SEED4 + (z >>> 0)) >>> 0;
  return bjfinal(a, b, c);
}

/** mx_bits_to_01: `float(bits) / float(0xffffffff)` in fp32, where the
 *  divisor rounds to exactly 2^32. */
function bits01(bits: number): number {
  return Math.fround(bits) / 4294967296;
}

// ===== Perlin (mx_fade, mx_gradient_float, mx_perlin_noise_*) =====

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function grad2(hash: number, x: number, y: number): number {
  const h = hash & 7;
  const u = h < 4 ? x : y;
  const v = 2 * (h < 4 ? y : x);
  return ((h & 1) ? -u : u) + ((h & 2) ? -v : v);
}

function grad3(hash: number, x: number, y: number, z: number): number {
  const h = hash & 15;
  const u = h < 8 ? x : y;
  const v = h < 4 ? y : (h === 12 || h === 14 ? x : z);
  return ((h & 1) ? -u : u) + ((h & 2) ? -v : v);
}

/*
 * ONE-CELL MEMOS. Every hash is a pure function of a lattice cell's integer
 * corner, and a card samples its pixels row by row, so neighbouring samples
 * almost always share a cell (one cell spans 48 px of a 96 px card at Scale 1).
 * Each body below keeps the hashes (Perlin) or jitter offsets (Worley) of the
 * LAST cell it saw and recomputes them only when the cell changes. Measured per
 * 96 px card (node, M-series Mac, 2026-11-16), before → after: 3-D Voronoi
 * 3.0 → 0.7 ms (1.2 at Scale 5), fBm 2.0 → 1.0 ms (1.6 at Scale 5), 3-D Perlin
 * 0.73 → 0.42 ms; the 2-D stand-in this replaced drew 0.3–0.5 ms. The memo is
 * keyed on the integer corner alone, so it can never answer for another cell;
 * fBm gives each octave its own slot, since its three octaves alternate. These
 * memos serve the POINT calls — the evaluator, and a float `pos`'s diagonal; a
 * card draws through the grid bodies further down (mxNoiseGrid).
 */

/** mx_hash_vec3's three bytes: the shift that picks channel `ch`. */
const BYTE_SHIFT = [0, 8, 16] as const;

/** Channel `ch` of a corner hash: the whole hash for the float call (`ch` < 0),
 *  else that byte of mx_hash_vec3. */
function hashChannel(k: number, ch: number): number {
  return ch < 0 ? k : (k >>> BYTE_SHIFT[ch]) & 0xff;
}

let p2X = 0, p2Y = 0, p2Ok = false;
const p2H = new Uint32Array(4);

/**
 * mx_perlin_noise_float (vec2), or channel `ch` of mx_perlin_noise_vec3
 * (`ch` = −1 for the float version: the whole hash feeds the gradient).
 */
function perlin2(x: number, y: number, ch: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const X = x0 | 0, Y = y0 | 0;
  if (!p2Ok || X !== p2X || Y !== p2Y) {
    const X1 = (X + 1) | 0, Y1 = (Y + 1) | 0;
    p2H[0] = hash2(X, Y); p2H[1] = hash2(X1, Y); p2H[2] = hash2(X, Y1); p2H[3] = hash2(X1, Y1);
    p2X = X; p2Y = Y; p2Ok = true;
  }
  const fx = x - x0, fy = y - y0;
  const u = fade(fx), v = fade(fy);
  const g00 = grad2(hashChannel(p2H[0], ch), fx, fy);
  const g10 = grad2(hashChannel(p2H[1], ch), fx - 1, fy);
  const g01 = grad2(hashChannel(p2H[2], ch), fx, fy - 1);
  const g11 = grad2(hashChannel(p2H[3], ch), fx - 1, fy - 1);
  const s1 = 1 - u;
  return 0.6616 * ((1 - v) * (g00 * s1 + g10 * u) + v * (g01 * s1 + g11 * u));
}

/** Per-slot cell key (X, Y, Z) and validity; slot 0 also serves plain Perlin. */
const P3_SLOTS = 3;
const p3Key = new Int32Array(P3_SLOTS * 3);
const p3Ok = [false, false, false];
const p3H = new Uint32Array(P3_SLOTS * 8);

/** mx_perlin_noise_float (vec3), or channel `ch` of mx_perlin_noise_vec3. */
function perlin3(x: number, y: number, z: number, ch: number, slot = 0): number {
  const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
  const X = x0 | 0, Y = y0 | 0, Z = z0 | 0;
  const k = slot * 3, o = slot * 8;
  if (!p3Ok[slot] || p3Key[k] !== X || p3Key[k + 1] !== Y || p3Key[k + 2] !== Z) {
    const X1 = (X + 1) | 0, Y1 = (Y + 1) | 0, Z1 = (Z + 1) | 0;
    p3H[o] = hash3(X, Y, Z); p3H[o + 1] = hash3(X1, Y, Z);
    p3H[o + 2] = hash3(X, Y1, Z); p3H[o + 3] = hash3(X1, Y1, Z);
    p3H[o + 4] = hash3(X, Y, Z1); p3H[o + 5] = hash3(X1, Y, Z1);
    p3H[o + 6] = hash3(X, Y1, Z1); p3H[o + 7] = hash3(X1, Y1, Z1);
    p3Key[k] = X; p3Key[k + 1] = Y; p3Key[k + 2] = Z; p3Ok[slot] = true;
  }
  const fx = x - x0, fy = y - y0, fz = z - z0;
  const u = fade(fx), v = fade(fy), w = fade(fz);
  const v0 = grad3(hashChannel(p3H[o], ch), fx, fy, fz);
  const v1 = grad3(hashChannel(p3H[o + 1], ch), fx - 1, fy, fz);
  const v2 = grad3(hashChannel(p3H[o + 2], ch), fx, fy - 1, fz);
  const v3 = grad3(hashChannel(p3H[o + 3], ch), fx - 1, fy - 1, fz);
  const v4 = grad3(hashChannel(p3H[o + 4], ch), fx, fy, fz - 1);
  const v5 = grad3(hashChannel(p3H[o + 5], ch), fx - 1, fy, fz - 1);
  const v6 = grad3(hashChannel(p3H[o + 6], ch), fx, fy - 1, fz - 1);
  const v7 = grad3(hashChannel(p3H[o + 7], ch), fx - 1, fy - 1, fz - 1);
  const s1 = 1 - u, t1 = 1 - v, r1 = 1 - w;
  return 0.982 * (
    r1 * (t1 * (v0 * s1 + v1 * u) + v * (v2 * s1 + v3 * u))
    + w * (t1 * (v4 * s1 + v5 * u) + v * (v6 * s1 + v7 * u))
  );
}

/** mx_fractal_noise_float / channel `ch` of _vec3, three's defaults (3
 *  octaves, lacunarity 2, diminish ½). Its `p` is a vec3 by layout. */
function fractal3(x: number, y: number, z: number, ch: number): number {
  let result = 0;
  let amplitude = 1;
  for (let o = 0; o < 3; o++) {
    result += amplitude * perlin3(x, y, z, ch, o);
    amplitude *= 0.5;
    x *= 2; y *= 2; z *= 2;
  }
  return result;
}

// ===== Worley (mx_worley_distance, mx_worley_noise_*) =====

let w2X = 0, w2Y = 0, w2Ok = false;
/** Jitter (ox, oy) of the 3×3 cells around the memo cell, x-major. */
const w2Off = new Float64Array(9 * 2);

/** F1², F2², F3² of the 3×3 cell window (2-D), into `out`. */
function worley2(x: number, y: number, out: number[]): void {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const X = x0 | 0, Y = y0 | 0;
  if (!w2Ok || X !== w2X || Y !== w2Y) {
    let i = 0;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const cx = (dx + X) | 0, cy = (dy + Y) | 0;
        // mx_cell_noise_vec3(vec2) → mx_hash_int(ix, iy, k); `.xy` of it,
        // through the jitter step (o − ½)·1 + ½ exactly as written.
        w2Off[i++] = (bits01(hash3(cx, cy, 0)) - 0.5) + 0.5;
        w2Off[i++] = (bits01(hash3(cx, cy, 1)) - 0.5) + 0.5;
      }
    }
    w2X = X; w2Y = Y; w2Ok = true;
  }
  const lx = x - x0, ly = y - y0;
  let f1 = 1e6, f2 = 1e6, f3 = 1e6;
  let i = 0;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const ddx = dx + w2Off[i++] - lx, ddy = dy + w2Off[i++] - ly;
      const d = ddx * ddx + ddy * ddy;
      if (d < f1) { f3 = f2; f2 = f1; f1 = d; }
      else if (d < f2) { f3 = f2; f2 = d; }
      else if (d < f3) f3 = d;
    }
  }
  out[0] = f1; out[1] = f2; out[2] = f3;
}

let w3X = 0, w3Y = 0, w3Z = 0, w3Ok = false;
/** Jitter (ox, oy, oz) of the 3×3×3 cells around the memo cell, x-major. */
const w3Off = new Float64Array(27 * 3);

/** F1², F2², F3² of the 3×3×3 cell window (3-D), into `out`. */
function worley3(x: number, y: number, z: number, out: number[]): void {
  const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
  const X = x0 | 0, Y = y0 | 0, Z = z0 | 0;
  if (!w3Ok || X !== w3X || Y !== w3Y || Z !== w3Z) {
    let i = 0;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const cx = (dx + X) | 0, cy = (dy + Y) | 0, cz = (dz + Z) | 0;
          // mx_cell_noise_vec3(vec3) → mx_hash_int(ix, iy, iz, k).
          w3Off[i++] = (bits01(hash4(cx, cy, cz, 0)) - 0.5) + 0.5;
          w3Off[i++] = (bits01(hash4(cx, cy, cz, 1)) - 0.5) + 0.5;
          w3Off[i++] = (bits01(hash4(cx, cy, cz, 2)) - 0.5) + 0.5;
        }
      }
    }
    w3X = X; w3Y = Y; w3Z = Z; w3Ok = true;
  }
  const lx = x - x0, ly = y - y0, lz = z - z0;
  let f1 = 1e6, f2 = 1e6, f3 = 1e6;
  let i = 0;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        const ddx = dx + w3Off[i++] - lx, ddy = dy + w3Off[i++] - ly, ddz = dz + w3Off[i++] - lz;
        const d = ddx * ddx + ddy * ddy + ddz * ddz;
        if (d < f1) { f3 = f2; f2 = f1; f1 = d; }
        else if (d < f2) { f3 = f2; f2 = d; }
        else if (d < f3) f3 = d;
      }
    }
  }
  out[0] = f1; out[1] = f2; out[2] = f3;
}

// ===== The node calls =====

/** The node's OUTPUT width: float 1, Voronoi (vec2) 2, every vec3 type 3. */
export function mxNoiseWidth(type: MxNoiseType): number {
  if (type === 'perlinVec3' || type === 'fbmVec3' || type === 'voronoiVec3') return 3;
  if (type === 'voronoiVec2') return 2;
  return 1;
}

/**
 * What three hands the noise for a `pos` of `p.length` channels (already
 * multiplied by Scale). Every call but fBm's goes through
 * `texcoord.convert('vec2|vec3')`, which keeps a vec3 and turns ANY other width
 * into a vec2 — a float splats `(f, f)`, a vec4 drops `.zw`. fBm's Fn has a
 * vec3 LAYOUT instead, so its argument is formatted to vec3: a float splats
 * `(f, f, f)`, a vec2 pads `(x, y, 0)`, a vec4 drops `.w`
 * (NodeBuilder.format). Returns 2 or 3 numbers; an empty `p` reads as 0.
 */
export function mxNoiseInput(type: MxNoiseType, p: readonly number[]): number[] {
  const n = p.length;
  const a = n > 0 ? p[0] : 0;
  if (type === 'fbm' || type === 'fbmVec3') {
    if (n <= 1) return [a, a, a];
    return [a, p[1], n >= 3 ? p[2] : 0];
  }
  if (n === 3) return [a, p[1], p[2]];
  if (n <= 1) return [a, a];
  return [a, p[1]];
}

const scratch = [0, 0, 0];

/**
 * Channel `ch` of the node's RAW output (before any 0–1 remap) at the
 * converted input `x, y[, z]` — `z === null` is the vec2 overload. The point
 * read, allocation-free: the evaluator's, and a float `pos`'s diagonal on a
 * card (a card's grid goes through mxNoiseGrid, which equals it exactly).
 */
export function mxNoiseChannel(type: MxNoiseType, x: number, y: number, z: number | null, ch = 0): number {
  switch (type) {
    case 'perlin':
      return z === null ? perlin2(x, y, -1) : perlin3(x, y, z, -1);
    case 'perlinVec3':
      return z === null ? perlin2(x, y, ch) : perlin3(x, y, z, ch);
    case 'fbm':
      return fractal3(x, y, z ?? 0, -1);
    case 'fbmVec3':
      return fractal3(x, y, z ?? 0, ch);
    case 'cellNoise':
      return z === null
        ? bits01(hash2(Math.floor(x) | 0, Math.floor(y) | 0))
        : bits01(hash3(Math.floor(x) | 0, Math.floor(y) | 0, Math.floor(z) | 0));
    case 'voronoi':
    case 'voronoiVec2':
    case 'voronoiVec3':
      if (z === null) worley2(x, y, scratch);
      else worley3(x, y, z, scratch);
      return scratch[ch] ?? scratch[0];
  }
}

// ===== Grids: a card's whole picture at once (mxNoiseGrid) =====

/*
 * A noise card samples an axis-aligned GRID — column c at x = xs[c], row r at
 * y = ys[r], one z for the whole picture (a slice) — and most of a pixel's work
 * changes only per COLUMN (the x cell, fx and its fade), per ROW (the y cell, fy
 * and its fade; z's are fixed) or per lattice CELL (the hashes, and how each
 * corner's gradient splits into an x term and a constant). The bodies below do
 * each of those once, where the point functions above redo all of it at every
 * pixel. Measured per 96 px card, bytes included (noisePreview.ts; node,
 * M-series Mac, 2026-11-16, Scale 1–5, 2-D and 3-D), point → grid: Perlin
 * 0.6–1.1 → 0.07–0.13 ms, fBm 1.9–2.8 → 0.2–0.7, Voronoi 0.85–2.1 → 0.13–0.47,
 * cell 0.37–0.46 → 0.04. In the app, 8 animated cards at Scale 3 went from 22%
 * to 15% of the main thread (81% → 56% under a 4× CPU throttle, 38 → 51 fps).
 *
 * EXACT, not approximate: per pixel each body performs the same floating-point
 * operations on the same operands in the same order as the point function —
 * only a sum of TWO terms is ever written the other way round, which IEEE
 * addition answers identically — so every value equals mxNoiseChannel's
 * (mxNoise.test.ts sweeps it). Two consequences worth keeping: a corner's
 * gradient is `±x′ ± k` with k a row constant, written `sx·x′ + k` (sx is ±1 or
 * ±2, an exact multiply; 0 when the gradient never reads x, which can differ
 * from the point function only in the SIGN of a zero); and the Voronoi body
 * prunes a cell only when its row-constant part alone already reaches the
 * nearest distance so far, which cannot change a minimum.
 */

let gColX = new Int32Array(0);
let gColF = new Float64Array(0);
let gColFm = new Float64Array(0);
let gColU = new Float64Array(0);
let gColS = new Float64Array(0);
let gColRun = new Int32Array(0);
/** Per run: the least and greatest fx of its columns (NaN ignored). */
let gRunLo = new Float64Array(0);
let gRunHi = new Float64Array(0);
let gOctX = new Float64Array(0);
let gOctY = new Float64Array(0);

/** Size the shared column scratch for `nx` columns (grown, never shrunk). */
function ensureColumns(nx: number): void {
  if (gColX.length >= nx) return;
  gColX = new Int32Array(nx);
  gColF = new Float64Array(nx);
  gColFm = new Float64Array(nx);
  gColU = new Float64Array(nx);
  gColS = new Float64Array(nx);
  gColRun = new Int32Array(nx);
  gRunLo = new Float64Array(nx);
  gRunHi = new Float64Array(nx);
}

/**
 * Per column: the x cell, fx, fx − 1, fade(fx), 1 − fade(fx), and the index of
 * the RUN of equal cells the column belongs to; per run, the span of its fx.
 * Returns the run count.
 */
function prepareColumns(xs: ArrayLike<number>, nx: number): number {
  ensureColumns(nx);
  let runs = 0;
  for (let c = 0; c < nx; c++) {
    const x = xs[c];
    const x0 = Math.floor(x);
    const X = x0 | 0;
    const fx = x - x0;
    const u = fade(fx);
    gColX[c] = X;
    gColF[c] = fx;
    gColFm[c] = fx - 1;
    gColU[c] = u;
    gColS[c] = 1 - u;
    if (c > 0 && X !== gColX[c - 1]) runs++;
    if (c === 0 || gColRun[c - 1] !== runs) {
      gRunLo[runs] = Infinity;
      gRunHi[runs] = -Infinity;
    }
    gColRun[c] = runs;
    if (fx < gRunLo[runs]) gRunLo[runs] = fx;
    if (fx > gRunHi[runs]) gRunHi[runs] = fx;
  }
  return nx > 0 ? runs + 1 : 0;
}

/**
 * Hashes cached per run, valid while the row's y cell is unchanged. A hash is
 * a pure function of its integer corner, so a run takes what it can from its
 * neighbours instead of hashing again: the corners it shares with the run just
 * left of it (entered earlier in this row, so valid for this y), and — when the
 * rows have stepped one cell, up or (a card's rows run DOWN its y) down — its
 * own previous corners on the side it stepped from. At high Scale
 * the hashes were over half of fBm's time and nearly half of Voronoi's; each
 * corner (and each Worley cell's jitter) is now computed about once a picture.
 */
let gRunHash = new Uint32Array(0);
let gRunY = new Int32Array(0);
let gRunOk = new Uint8Array(0);

function ensureRuns(runs: number, perRun: number): void {
  if (gRunHash.length < runs * perRun) gRunHash = new Uint32Array(runs * perRun);
  if (gRunY.length < runs) {
    gRunY = new Int32Array(runs);
    gRunOk = new Uint8Array(runs);
  }
  gRunOk.fill(0, 0, runs);
}

/** Corner gradient split: value = SX[i]·x′ + SK[i]. */
const SX = new Float64Array(8);
const SK = new Float64Array(8);

/** grad2 (the 2-D Perlin gradient) of a corner whose y′ is the row constant `b`. */
function split2(h: number, b: number, i: number): void {
  h &= 7;
  if (h < 4) {
    // u = x′, v = 2·y′: (±x′) + (±2y′).
    SX[i] = (h & 1) ? -1 : 1;
    const v = 2 * b;
    SK[i] = (h & 2) ? -v : v;
  } else {
    // u = y′, v = 2·x′: (±y′) + (±2x′) — the sum turned round, exactly.
    SX[i] = (h & 2) ? -2 : 2;
    SK[i] = (h & 1) ? -b : b;
  }
}

/** grad3 of a corner whose y′, z′ are the row constants `b`, `c`. */
function split3(h: number, b: number, c: number, i: number): void {
  h &= 15;
  if (h < 8) {
    // u = x′, v = y′ (h < 4) or z′.
    SX[i] = (h & 1) ? -1 : 1;
    const v = h < 4 ? b : c;
    SK[i] = (h & 2) ? -v : v;
  } else if (h === 12 || h === 14) {
    // u = y′, v = x′.
    SX[i] = (h & 2) ? -1 : 1;
    SK[i] = (h & 1) ? -b : b;
  } else {
    // u = y′, v = z′: no x term — the point function's own sum.
    SX[i] = 0;
    SK[i] = ((h & 1) ? -b : b) + ((h & 2) ? -c : c);
  }
}

/** mx_perlin_noise_float (vec2) / channel `ch` of _vec3 over the grid. */
function perlin2Grid(xs: ArrayLike<number>, ys: ArrayLike<number>, ch: number, out: Float64Array): void {
  const nx = xs.length, ny = ys.length;
  const runs = prepareColumns(xs, nx);
  ensureRuns(runs, 4);
  for (let r = 0; r < ny; r++) {
    const y = ys[r];
    const y0 = Math.floor(y);
    const Y = y0 | 0, Y1 = (Y + 1) | 0;
    const fy = y - y0, fym = fy - 1;
    const v = fade(fy), t1 = 1 - v;
    const row = r * nx;
    let run = -1;
    let sx0 = 0, sx1 = 0, sx2 = 0, sx3 = 0, k0 = 0, k1 = 0, k2 = 0, k3 = 0;
    for (let c = 0; c < nx; c++) {
      if (gColRun[c] !== run) {
        run = gColRun[c];
        const X = gColX[c], o = run * 4;
        if (!gRunOk[run] || gRunY[run] !== Y) {
          const X1 = (X + 1) | 0, p = o - 4;
          // The run to the left ends one cell short of this one: its right
          // corners are this run's left ones.
          const share = c > 0 && ((gColX[c - 1] + 1) | 0) === X;
          const had = gRunOk[run] === 1, last = gRunY[run];
          const up = had && ((last + 1) | 0) === Y, down = had && ((last - 1) | 0) === Y;
          // A cell up: the old top corners are the new bottom ones; a cell
          // down: the old bottom corners are the new top ones.
          if (up) {
            gRunHash[o] = gRunHash[o + 2]; gRunHash[o + 1] = gRunHash[o + 3];
          } else if (down) {
            gRunHash[o + 2] = gRunHash[o]; gRunHash[o + 3] = gRunHash[o + 1];
          }
          if (!up) {
            gRunHash[o] = share ? gRunHash[p + 1] : hash2(X, Y);
            gRunHash[o + 1] = hash2(X1, Y);
          }
          if (!down) {
            gRunHash[o + 2] = share ? gRunHash[p + 3] : hash2(X, Y1);
            gRunHash[o + 3] = hash2(X1, Y1);
          }
          gRunY[run] = Y; gRunOk[run] = 1;
        }
        split2(hashChannel(gRunHash[o], ch), fy, 0);
        split2(hashChannel(gRunHash[o + 1], ch), fy, 1);
        split2(hashChannel(gRunHash[o + 2], ch), fym, 2);
        split2(hashChannel(gRunHash[o + 3], ch), fym, 3);
        sx0 = SX[0]; sx1 = SX[1]; sx2 = SX[2]; sx3 = SX[3];
        k0 = SK[0]; k1 = SK[1]; k2 = SK[2]; k3 = SK[3];
      }
      const fx = gColF[c], fxm = gColFm[c], u = gColU[c], s1 = gColS[c];
      const g00 = sx0 * fx + k0;
      const g10 = sx1 * fxm + k1;
      const g01 = sx2 * fx + k2;
      const g11 = sx3 * fxm + k3;
      out[row + c] = 0.6616 * (t1 * (g00 * s1 + g10 * u) + v * (g01 * s1 + g11 * u));
    }
  }
}

/**
 * mx_perlin_noise_float (vec3) / channel `ch` of _vec3 over the grid at one z.
 * `amp` < 0 WRITES the value; otherwise adds `amp · value` (an fBm octave).
 */
function perlin3Grid(
  xs: ArrayLike<number>, ys: ArrayLike<number>, z: number, ch: number, out: Float64Array, amp: number,
): void {
  const nx = xs.length, ny = ys.length;
  const runs = prepareColumns(xs, nx);
  ensureRuns(runs, 8);
  const z0 = Math.floor(z);
  const Z = z0 | 0, Z1 = (Z + 1) | 0;
  const fz = z - z0, fzm = fz - 1;
  const w = fade(fz), r1 = 1 - w;
  for (let r = 0; r < ny; r++) {
    const y = ys[r];
    const y0 = Math.floor(y);
    const Y = y0 | 0, Y1 = (Y + 1) | 0;
    const fy = y - y0, fym = fy - 1;
    const v = fade(fy), t1 = 1 - v;
    const row = r * nx;
    let run = -1;
    let sx0 = 0, sx1 = 0, sx2 = 0, sx3 = 0, sx4 = 0, sx5 = 0, sx6 = 0, sx7 = 0;
    let k0 = 0, k1 = 0, k2 = 0, k3 = 0, k4 = 0, k5 = 0, k6 = 0, k7 = 0;
    for (let c = 0; c < nx; c++) {
      if (gColRun[c] !== run) {
        run = gColRun[c];
        const X = gColX[c], o = run * 8;
        if (!gRunOk[run] || gRunY[run] !== Y) {
          const X1 = (X + 1) | 0, p = o - 8;
          const share = c > 0 && ((gColX[c - 1] + 1) | 0) === X;
          const had = gRunOk[run] === 1, last = gRunY[run];
          const up = had && ((last + 1) | 0) === Y, down = had && ((last - 1) | 0) === Y;
          if (up) {
            gRunHash[o] = gRunHash[o + 2]; gRunHash[o + 1] = gRunHash[o + 3];
            gRunHash[o + 4] = gRunHash[o + 6]; gRunHash[o + 5] = gRunHash[o + 7];
          } else if (down) {
            gRunHash[o + 2] = gRunHash[o]; gRunHash[o + 3] = gRunHash[o + 1];
            gRunHash[o + 6] = gRunHash[o + 4]; gRunHash[o + 7] = gRunHash[o + 5];
          }
          if (!up) {
            gRunHash[o] = share ? gRunHash[p + 1] : hash3(X, Y, Z);
            gRunHash[o + 4] = share ? gRunHash[p + 5] : hash3(X, Y, Z1);
            gRunHash[o + 1] = hash3(X1, Y, Z);
            gRunHash[o + 5] = hash3(X1, Y, Z1);
          }
          if (!down) {
            gRunHash[o + 2] = share ? gRunHash[p + 3] : hash3(X, Y1, Z);
            gRunHash[o + 6] = share ? gRunHash[p + 7] : hash3(X, Y1, Z1);
            gRunHash[o + 3] = hash3(X1, Y1, Z);
            gRunHash[o + 7] = hash3(X1, Y1, Z1);
          }
          gRunY[run] = Y; gRunOk[run] = 1;
        }
        split3(hashChannel(gRunHash[o], ch), fy, fz, 0);
        split3(hashChannel(gRunHash[o + 1], ch), fy, fz, 1);
        split3(hashChannel(gRunHash[o + 2], ch), fym, fz, 2);
        split3(hashChannel(gRunHash[o + 3], ch), fym, fz, 3);
        split3(hashChannel(gRunHash[o + 4], ch), fy, fzm, 4);
        split3(hashChannel(gRunHash[o + 5], ch), fy, fzm, 5);
        split3(hashChannel(gRunHash[o + 6], ch), fym, fzm, 6);
        split3(hashChannel(gRunHash[o + 7], ch), fym, fzm, 7);
        sx0 = SX[0]; sx1 = SX[1]; sx2 = SX[2]; sx3 = SX[3];
        sx4 = SX[4]; sx5 = SX[5]; sx6 = SX[6]; sx7 = SX[7];
        k0 = SK[0]; k1 = SK[1]; k2 = SK[2]; k3 = SK[3];
        k4 = SK[4]; k5 = SK[5]; k6 = SK[6]; k7 = SK[7];
      }
      const fx = gColF[c], fxm = gColFm[c], u = gColU[c], s1 = gColS[c];
      const v0 = sx0 * fx + k0;
      const v1 = sx1 * fxm + k1;
      const v2 = sx2 * fx + k2;
      const v3 = sx3 * fxm + k3;
      const v4 = sx4 * fx + k4;
      const v5 = sx5 * fxm + k5;
      const v6 = sx6 * fx + k6;
      const v7 = sx7 * fxm + k7;
      const n = 0.982 * (
        r1 * (t1 * (v0 * s1 + v1 * u) + v * (v2 * s1 + v3 * u))
        + w * (t1 * (v4 * s1 + v5 * u) + v * (v6 * s1 + v7 * u))
      );
      if (amp < 0) out[row + c] = n;
      else out[row + c] += amp * n;
    }
  }
}

/** fractal3 over the grid: three perlin3Grid octaves, each at doubled
 *  coordinates — `x *= 2` repeated, exactly as the point function doubles. */
function fractal3Grid(xs: ArrayLike<number>, ys: ArrayLike<number>, z: number, ch: number, out: Float64Array): void {
  const nx = xs.length, ny = ys.length;
  if (gOctX.length !== nx) gOctX = new Float64Array(nx);
  if (gOctY.length !== ny) gOctY = new Float64Array(ny);
  for (let c = 0; c < nx; c++) gOctX[c] = xs[c];
  for (let r = 0; r < ny; r++) gOctY[r] = ys[r];
  out.fill(0, 0, nx * ny);
  let amplitude = 1;
  for (let o = 0; o < 3; o++) {
    perlin3Grid(gOctX, gOctY, z, ch, out, amplitude);
    amplitude *= 0.5;
    for (let c = 0; c < nx; c++) gOctX[c] *= 2;
    for (let r = 0; r < ny; r++) gOctY[r] *= 2;
    z *= 2;
  }
}

/** mx_cell_noise_float over the grid (`z === null`: the vec2 overload). */
function cellGrid(xs: ArrayLike<number>, ys: ArrayLike<number>, z: number | null, out: Float64Array): void {
  const nx = xs.length, ny = ys.length;
  prepareColumns(xs, nx);
  const Z = z === null ? 0 : Math.floor(z) | 0;
  for (let r = 0; r < ny; r++) {
    const Y = Math.floor(ys[r]) | 0;
    const row = r * nx;
    let X = 0, value = 0;
    for (let c = 0; c < nx; c++) {
      if (c === 0 || gColX[c] !== X) {
        X = gColX[c];
        value = z === null ? bits01(hash2(X, Y)) : bits01(hash3(X, Y, Z));
      }
      out[row + c] = value;
    }
  }
}

/** Per run (and row's y cell): each neighbour cell's x, y, z jitters for the
 *  Worley grids, x-major (dx, dy[, dz]), 27 slots a run. */
let gWorOx = new Float64Array(0);
let gWorOy = new Float64Array(0);
let gWorOz = new Float64Array(0);
/** Per neighbour cell at the current row: dx + ox, (dy + oy − ly)², (dz + oz − lz)², and their sum. */
const WA = new Float64Array(27);
const WY = new Float64Array(27);
const WZ = new Float64Array(27);
const WP = new Float64Array(27);
/** The cells a run's columns can find their nearest in (see worleyKeep). */
const WKEEP = new Int32Array(27);

function ensureWorley(runs: number): void {
  if (gWorOx.length < runs * 27) {
    gWorOx = new Float64Array(runs * 27);
    gWorOy = new Float64Array(runs * 27);
    gWorOz = new Float64Array(runs * 27);
  }
  if (gRunY.length < runs) {
    gRunY = new Int32Array(runs);
    gRunOk = new Uint8Array(runs);
  }
  gRunOk.fill(0, 0, runs);
}

/**
 * The cells (of WA/WY/WZ/WP's first `n`) that can hold the NEAREST point for a
 * column of this run, into WKEEP; returns how many. With fx anywhere in
 * [lo, hi], a cell's distance is at most the larger of its distances at the two
 * ends — computed as the pixel computes it, every step of which is monotone in
 * |dx + ox − fx| — so U, the least such bound, is at least every column's F1²;
 * and a cell's distance is at least its row part WP (the y/z terms alone), so a
 * cell with WP > U can never be the nearest. Kept with `<=`, so a tie at U
 * still keeps the cell that reaches it: the minimum is EXACTLY the point
 * function's. (`threeD` adds WZ as the pixel adds it, after WY.)
 */
function worleyKeep(n: number, lo: number, hi: number, threeD: boolean): number {
  let U = 1e6;
  for (let k = 0; k < n; k++) {
    const ta = WA[k] - lo, tb = WA[k] - hi;
    const da = threeD ? ta * ta + WY[k] + WZ[k] : ta * ta + WY[k];
    const db = threeD ? tb * tb + WY[k] + WZ[k] : tb * tb + WY[k];
    const m = da > db ? da : db;
    if (m < U) U = m;
  }
  let kept = 0;
  for (let k = 0; k < n; k++) if (WP[k] <= U) WKEEP[kept++] = k;
  return kept;
}

/** F1² of mx_worley_noise (vec2) over the grid. */
function worley2Grid(xs: ArrayLike<number>, ys: ArrayLike<number>, out: Float64Array): void {
  const nx = xs.length, ny = ys.length;
  const runs = prepareColumns(xs, nx);
  ensureWorley(runs);
  for (let r = 0; r < ny; r++) {
    const y = ys[r];
    const y0 = Math.floor(y);
    const Y = y0 | 0;
    const ly = y - y0;
    const row = r * nx;
    let run = -1, kept = 0;
    for (let c = 0; c < nx; c++) {
      if (gColRun[c] !== run) {
        run = gColRun[c];
        const X = gColX[c], o = run * 27;
        if (!gRunOk[run] || gRunY[run] !== Y) {
          // As the Perlin hashes: from the run to the left (its dx 0, +1 are
          // this run's −1, 0), and from this run's own row below (dy 0, +1 are
          // −1, 0 now) — read ahead of the write, so the shift is in place.
          const share = c > 0 && ((gColX[c - 1] + 1) | 0) === X;
          const had = gRunOk[run] === 1, last = gRunY[run];
          const up = had && ((last + 1) | 0) === Y, down = had && ((last - 1) | 0) === Y;
          for (let a = 0; a < 3; a++) {
            // Walk dy AWAY from the side the slots are read from.
            for (let bi = 0; bi < 3; bi++) {
              const b = down ? 2 - bi : bi;
              const i = o + a * 3 + b;
              let src = -1;
              if (up && b < 2) src = i + 1;
              else if (down && b > 0) src = i - 1;
              else if (share && a < 2) src = i - 27 + 3;
              if (src >= 0) {
                gWorOx[i] = gWorOx[src];
                gWorOy[i] = gWorOy[src];
              } else {
                const cx = (a - 1 + X) | 0, cy = (b - 1 + Y) | 0;
                // mx_cell_noise_vec3(vec2) → mx_hash_int(ix, iy, k), through
                // the jitter step (o − ½)·1 + ½ exactly as written.
                gWorOx[i] = (bits01(hash3(cx, cy, 0)) - 0.5) + 0.5;
                gWorOy[i] = (bits01(hash3(cx, cy, 1)) - 0.5) + 0.5;
              }
            }
          }
          gRunY[run] = Y; gRunOk[run] = 1;
        }
        let i = o, k = 0;
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            const ddy = dy + gWorOy[i] - ly;
            WA[k] = dx + gWorOx[i];
            WY[k] = ddy * ddy;
            WZ[k] = 0;
            WP[k] = WY[k];
            i++; k++;
          }
        }
        kept = worleyKeep(9, gRunLo[run], gRunHi[run], false);
      }
      const lx = gColF[c];
      let f1 = 1e6;
      for (let j = 0; j < kept; j++) {
        const k = WKEEP[j];
        const ddx = WA[k] - lx;
        const d = ddx * ddx + WY[k];
        if (d < f1) f1 = d;
      }
      out[row + c] = f1;
    }
  }
}

/** F1² of mx_worley_noise (vec3) over the grid at one z. */
function worley3Grid(xs: ArrayLike<number>, ys: ArrayLike<number>, z: number, out: Float64Array): void {
  const nx = xs.length, ny = ys.length;
  const runs = prepareColumns(xs, nx);
  ensureWorley(runs);
  const z0 = Math.floor(z);
  const Z = z0 | 0;
  const lz = z - z0;
  for (let r = 0; r < ny; r++) {
    const y = ys[r];
    const y0 = Math.floor(y);
    const Y = y0 | 0;
    const ly = y - y0;
    const row = r * nx;
    let run = -1, kept = 0;
    for (let c = 0; c < nx; c++) {
      if (gColRun[c] !== run) {
        run = gColRun[c];
        const X = gColX[c], o = run * 27;
        if (!gRunOk[run] || gRunY[run] !== Y) {
          // Shared as in worley2Grid; a dy step is 3 slots here, a dx step 9.
          const share = c > 0 && ((gColX[c - 1] + 1) | 0) === X;
          const had = gRunOk[run] === 1, last = gRunY[run];
          const up = had && ((last + 1) | 0) === Y, down = had && ((last - 1) | 0) === Y;
          for (let a = 0; a < 3; a++) {
            for (let bi = 0; bi < 3; bi++) {
              const b = down ? 2 - bi : bi;
              for (let e = 0; e < 3; e++) {
                const i = o + (a * 3 + b) * 3 + e;
                let src = -1;
                if (up && b < 2) src = i + 3;
                else if (down && b > 0) src = i - 3;
                else if (share && a < 2) src = i - 27 + 9;
                if (src >= 0) {
                  gWorOx[i] = gWorOx[src];
                  gWorOy[i] = gWorOy[src];
                  gWorOz[i] = gWorOz[src];
                } else {
                  const cx = (a - 1 + X) | 0, cy = (b - 1 + Y) | 0, cz = (e - 1 + Z) | 0;
                  // mx_cell_noise_vec3(vec3) → mx_hash_int(ix, iy, iz, k).
                  gWorOx[i] = (bits01(hash4(cx, cy, cz, 0)) - 0.5) + 0.5;
                  gWorOy[i] = (bits01(hash4(cx, cy, cz, 1)) - 0.5) + 0.5;
                  gWorOz[i] = (bits01(hash4(cx, cy, cz, 2)) - 0.5) + 0.5;
                }
              }
            }
          }
          gRunY[run] = Y; gRunOk[run] = 1;
        }
        let i = o, k = 0;
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            for (let dz = -1; dz <= 1; dz++) {
              const ddy = dy + gWorOy[i] - ly, ddz = dz + gWorOz[i] - lz;
              WA[k] = dx + gWorOx[i];
              WY[k] = ddy * ddy;
              WZ[k] = ddz * ddz;
              WP[k] = WY[k] + WZ[k];
              i++; k++;
            }
          }
        }
        kept = worleyKeep(27, gRunLo[run], gRunHi[run], true);
      }
      const lx = gColF[c];
      let f1 = 1e6;
      for (let j = 0; j < kept; j++) {
        const k = WKEEP[j];
        const ddx = WA[k] - lx;
        const d = ddx * ddx + WY[k] + WZ[k];
        if (d < f1) f1 = d;
      }
      out[row + c] = f1;
    }
  }
}

/**
 * Channel `ch` of the node's RAW output over a GRID: `out[r · xs.length + c]`
 * is EXACTLY `mxNoiseChannel(type, xs[c], ys[r], z, ch)` — the converted input,
 * as there (`z === null` is the vec2 overload; fBm reads a null z as 0) — for a
 * fraction of the cost (see "Grids" above). What a noise card draws: one call
 * per frame, no allocation once its scratch has grown to the card's size.
 */
export function mxNoiseGrid(
  type: MxNoiseType,
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  z: number | null,
  out: Float64Array,
  ch = 0,
): void {
  switch (type) {
    case 'perlin':
      if (z === null) perlin2Grid(xs, ys, -1, out);
      else perlin3Grid(xs, ys, z, -1, out, -1);
      return;
    case 'perlinVec3':
      if (z === null) perlin2Grid(xs, ys, ch, out);
      else perlin3Grid(xs, ys, z, ch, out, -1);
      return;
    case 'fbm':
      fractal3Grid(xs, ys, z ?? 0, -1, out);
      return;
    case 'fbmVec3':
      fractal3Grid(xs, ys, z ?? 0, ch, out);
      return;
    case 'cellNoise':
      cellGrid(xs, ys, z, out);
      return;
    default:
      if (ch === 0) {
        if (z === null) worley2Grid(xs, ys, out);
        else worley3Grid(xs, ys, z, out);
        return;
      }
      // F2/F3: the point function, pixel by pixel (no card draws them).
      for (let r = 0; r < ys.length; r++) {
        for (let c = 0; c < xs.length; c++) out[r * xs.length + c] = mxNoiseChannel(type, xs[c], ys[r], z, ch);
      }
  }
}

/**
 * The node's whole RAW output for a `pos` (already multiplied by Scale), at
 * its declared width — exactly what `mx_…(pos.mul(scale))` holds.
 */
export function mxNoise(type: MxNoiseType, p: readonly number[]): number[] {
  const q = mxNoiseInput(type, p);
  const z = q.length === 3 ? q[2] : null;
  const width = mxNoiseWidth(type);
  if (type === 'voronoi' || type === 'voronoiVec2' || type === 'voronoiVec3') {
    if (z === null) worley2(q[0], q[1], scratch);
    else worley3(q[0], q[1], z, scratch);
    return scratch.slice(0, width);
  }
  const out: number[] = [];
  for (let c = 0; c < width; c++) out.push(mxNoiseChannel(type, q[0], q[1], z, c));
  return out;
}
