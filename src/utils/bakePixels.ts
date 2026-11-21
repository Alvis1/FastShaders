/**
 * BAKE TO TEXTURE — the trusted side's reading of what the sandbox rendered
 * (docs/dev/baking.md). Pure and node-testable.
 *
 * The stage runs the user's shader, so its reply is ADVERSARIAL: only an RGBA
 * Float32Array (the float render target) or Uint8Array (the 8-bit fallback) of
 * exactly `size × size × 4` is accepted, at the requested size, rows TOP FIRST
 * with row 0 at v ≈ 1 — the order a picture is stored in, which an Image node
 * in the app orientation (three's `flipY`) samples back at the same uv. Alpha is
 * COVERAGE: 1 where a triangle was drawn, 0 between the UV islands.
 *
 * Then, here:
 *   - the RANGE of the covered texels is measured. Inside 0..1 it is stored as
 *     it is; outside (a signed Perlin, an HDR colour) it is stored normalised
 *     and the commit puts the range back with a Multiply and an Add, so the
 *     shader reads the original numbers;
 *   - a MESH-layout bake is DILATED: covered texels grow into the empty ones
 *     around each island, so filtering and mipmaps never pull black in along a
 *     UV seam, and what no island reaches takes the mean;
 *   - a colour in range is sRGB-encoded (the Image samples it back linear), data
 *     stays linear.
 */

export type BakeRaw = { width: number; height: number; data: Float32Array | Uint8Array };

/** How far a mesh-layout bake grows its islands, in texels. */
export const BAKE_DILATE_PX = 8;

/** A range narrower than this is stored as one value. */
const FLAT_RANGE = 1e-7;

/** Validate one `fs:bake-result` against what was asked. Null when anything is off. */
export function validateBakeReply(raw: unknown, size: number): BakeRaw | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { ok?: unknown; width?: unknown; height?: unknown; data?: unknown };
  if (r.ok !== true || r.width !== size || r.height !== size) return null;
  const data = r.data;
  if (!(data instanceof Float32Array) && !(data instanceof Uint8Array)) return null;
  if (data.length !== size * size * 4) return null;
  return { width: size, height: size, data };
}

/** A reply as float RGB planes, plus coverage. */
export interface BakePlanes {
  w: number;
  h: number;
  /** RGB as floats, interleaved by 3. */
  rgb: Float32Array;
  covered: Uint8Array;
}

function toPlanes(raw: BakeRaw, fullCoverage: boolean): BakePlanes | 'non-finite' | 'empty' {
  const { width: w, height: h, data } = raw;
  const n = w * h;
  const rgb = new Float32Array(n * 3);
  const covered = new Uint8Array(n);
  const scale = data instanceof Uint8Array ? 1 / 255 : 1;
  let any = false;
  for (let i = 0; i < n; i++) {
    const a = data[i * 4 + 3] * scale;
    const cov = fullCoverage || a > 0.5;
    if (!cov) continue;
    for (let c = 0; c < 3; c++) {
      const v = data[i * 4 + c] * scale;
      if (!Number.isFinite(v)) return 'non-finite';
      rgb[i * 3 + c] = v;
    }
    covered[i] = 1;
    any = true;
  }
  return any ? { w, h, rgb, covered } : 'empty';
}

/**
 * Grow the covered texels `px` rings outward, each new texel the mean of its
 * covered 8-neighbours; whatever no ring reaches takes the mean of the covered
 * texels. Mutates `p`.
 */
export function dilate(p: BakePlanes, px: number): void {
  const { w, h, rgb } = p;
  let cov = p.covered;
  for (let pass = 0; pass < px; pass++) {
    const next = cov.slice();
    let grew = false;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (cov[i]) continue;
        let r = 0, g = 0, b = 0, k = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w || (dx === 0 && dy === 0)) continue;
            const j = yy * w + xx;
            if (!cov[j]) continue;
            r += rgb[j * 3];
            g += rgb[j * 3 + 1];
            b += rgb[j * 3 + 2];
            k++;
          }
        }
        if (k === 0) continue;
        rgb[i * 3] = r / k;
        rgb[i * 3 + 1] = g / k;
        rgb[i * 3 + 2] = b / k;
        next[i] = 1;
        grew = true;
      }
    }
    cov = next;
    if (!grew) break;
  }
  // The rest: the mean of what was covered, so no black reaches a mip level.
  let r = 0, g = 0, b = 0, k = 0;
  for (let i = 0; i < w * h; i++) {
    if (!p.covered[i]) continue;
    r += rgb[i * 3];
    g += rgb[i * 3 + 1];
    b += rgb[i * 3 + 2];
    k++;
  }
  if (k > 0) {
    for (let i = 0; i < w * h; i++) {
      if (cov[i]) continue;
      rgb[i * 3] = r / k;
      rgb[i * 3 + 1] = g / k;
      rgb[i * 3 + 2] = b / k;
    }
  }
  p.covered = cov;
}

/** sRGB OETF (IEC 61966-2-1), linear 0..1 → encoded 0..1. */
export function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

export interface BakeImageResult {
  width: number;
  height: number;
  /** RGBA8, rows top first, alpha 255. */
  rgba: Uint8ClampedArray<ArrayBuffer>;
  /** The stored values read back as `v·scale + offset`; null when stored as they are. */
  remap: { scale: number; offset: number } | null;
  /** 'color' only for an in-range colour; a remapped value is always stored as data. */
  colorSpace: 'color' | 'data';
  /** Share of texels a triangle covered (1 for the UV square). */
  coverage: number;
}

export interface BakeImageOptions {
  /** How many of R, G, B carry the value (1 = scalar, 2 = vec2, 3 = vec3). */
  channels: 1 | 2 | 3;
  colorSpace: 'color' | 'data';
  /** Dilate (a mesh-layout bake); the UV square covers every texel. */
  meshLayout: boolean;
}

export type BakeImageOutcome = BakeImageResult | { error: 'non-finite' | 'empty' };

/** Turn a validated reply into the picture an Image node stores. */
export function bakeImage(raw: BakeRaw, opts: BakeImageOptions): BakeImageOutcome {
  const planes = toPlanes(raw, !opts.meshLayout);
  if (planes === 'non-finite' || planes === 'empty') return { error: planes };
  const n = planes.w * planes.h;
  let coveredCount = 0;
  for (let i = 0; i < n; i++) coveredCount += planes.covered[i];

  // The range of the channels that carry the value, over covered texels.
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) {
    if (!planes.covered[i]) continue;
    for (let c = 0; c < opts.channels; c++) {
      const v = planes.rgb[i * 3 + c];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  if (opts.meshLayout) dilate(planes, BAKE_DILATE_PX);

  const inRange = lo >= 0 && hi <= 1;
  const span = hi - lo;
  const remap = inRange ? null : { scale: span > FLAT_RANGE ? span : 0, offset: lo };
  const colorSpace = inRange ? opts.colorSpace : 'data';
  const encode = (v: number): number => {
    let x = remap ? (remap.scale > 0 ? (v - remap.offset) / remap.scale : 0) : v;
    x = x < 0 ? 0 : x > 1 ? 1 : x;
    if (colorSpace === 'color') x = linearToSrgb(x);
    return Math.round(x * 255);
  };

  const rgba = new Uint8ClampedArray(new ArrayBuffer(n * 4));
  for (let i = 0; i < n; i++) {
    const r = encode(planes.rgb[i * 3]);
    const g = opts.channels >= 2 ? encode(planes.rgb[i * 3 + 1]) : r;
    const b = opts.channels >= 3 ? encode(planes.rgb[i * 3 + 2]) : opts.channels === 1 ? r : 0;
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = 255;
  }
  return { width: planes.w, height: planes.h, rgba, remap, colorSpace, coverage: coveredCount / n };
}
