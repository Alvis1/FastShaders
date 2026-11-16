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
 * fBm gives each octave its own slot, since its three octaves alternate.
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
 * converted input `x, y[, z]` — `z === null` is the vec2 overload. The hot
 * path of the card renderer: no allocation.
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
