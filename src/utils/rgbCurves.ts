import { unitToken, wordToken, splitRecords, formatUnit, POINT_LIST_MAX_RECORDS } from './pointListCodec';
import { field, readerMemo, roundUnit } from './lutReader';
import { halfTable, fetchHalf, rangeHalf, FS_LUT_SIZE } from './lutTable';

/**
 * Blender's RGB Curves (ShaderNodeRGBCurve) on the TRUSTED side: the ONE
 * reader of an RGB Curves node's `values.curveC/R/G/B` / `values.extend`, the
 * CPU twin of `fsRgbCurves` (engine/lutHelperText.ts, which bakes the same
 * table inside the preview, the export and podest), and the editor's pure
 * point operations.
 *
 * Storage: each curve is the point-list grammar of utils/pointListCodec.ts —
 * records `X Y [WORD]`, 2..32 of them, both coordinates in [0,1]; the third
 * token is a future handle type, tolerated and DROPPED (every point is Auto
 * today). Every writer stores `values.extend` as `'horizontal'` or leaves it
 * ABSENT (Extrapolated); the reader also takes the explicit `'extrapolate'` the
 * generated code spells — silently, the same as absent — and only any OTHER
 * present value is rejected (`isCurveExtend`). ABSENT means the identity line /
 * Extrapolated, so a fresh node, Reset and every byte-stability snapshot read
 * the same.
 *
 * Every consumer — codegen, the CPU evaluator, the card art and the editor —
 * reads the curves the GPU bakes: `points` is always the parse of the
 * CANONICAL string (1e-4-rounded), never the raw stored text (the auto
 * handles amplify any difference), and edge values come from the same
 * HALF-float table the shader samples (utils/lutTable.ts).
 */

/** Tab order C R G B — Blender's `cur = 3` (Combined) is the editor's default. */
export const CURVE_KEYS = Object.freeze({ c: 'curveC', r: 'curveR', g: 'curveG', b: 'curveB' } as const);
export type CurveChannel = keyof typeof CURVE_KEYS;
export const CURVE_CHANNELS: readonly CurveChannel[] = Object.freeze(['c', 'r', 'g', 'b'] as const);
export const IDENTITY_CURVE = '0 0,1 1';
export const CURVE_MAX_POINTS = POINT_LIST_MAX_RECORDS;
export const CURVE_MIN_POINTS = 2;

/** Blender's two extend modes, as the generated code spells them (`fsRgbCurves(…, "extrapolate")`). */
export type CurveExtend = 'extrapolate' | 'horizontal';
/** THE extend vocabulary, on the exact string — `'Horizontal'`, `'__proto__'` and non-strings are not modes. The
 *  reader (whose `rejectedExtend` the editor's junk-dropping write reads), codeToGraph's argument reader and the
 *  editor's Extend select all ask this one predicate. */
export function isCurveExtend(v: unknown): v is CurveExtend {
  return v === 'extrapolate' || v === 'horizontal';
}

export interface CurvePoint {
  readonly x: number;
  readonly y: number;
}
export interface CurveRead {
  readonly points: readonly CurvePoint[];
  readonly canonical: string;
  /** A stored value was present but unreadable — the identity line stands in, and the code says so. */
  readonly rejected: boolean;
  /** The stored string carried third (handle-type) tokens, which were dropped. */
  readonly droppedHandles: boolean;
}
export interface RgbCurves {
  readonly c: CurveRead;
  readonly r: CurveRead;
  readonly g: CurveRead;
  readonly b: CurveRead;
  readonly extend: CurveExtend;
  /** All four exactly [(0,0),(1,1)] AND not Horizontal — Blender's own rule (BKE_curvemapping_is_map_identity):
   *  Horizontal clamps to [0,1] even on the identity line. The helper then bakes NOTHING. */
  readonly identity: boolean;
  readonly rejectedChannels: readonly ('C' | 'R' | 'G' | 'B')[];
  /** `values.extend` was present but neither 'horizontal' nor 'extrapolate': Extrapolated stands in, and the code
   *  and the editor say so (Color Ramp's `rejectedInterp`). */
  readonly rejectedExtend: boolean;
}

/** §A5 grammar: 2 or 3 tokens per record (a third must be a lowercase word, and is dropped), ALL-OR-NOTHING,
 *  2..32 records, stable-sorted by x. null = unreadable. */
export function parseCurve(raw: unknown): { points: CurvePoint[]; droppedHandles: boolean } | null {
  const recs = splitRecords(raw, CURVE_MIN_POINTS, CURVE_MAX_POINTS);
  if (!recs) return null;
  const points: CurvePoint[] = [];
  let droppedHandles = false;
  for (const rec of recs) {
    if (rec.length < 2 || rec.length > 3 || (rec.length === 3 && !wordToken(rec[2]))) return null;
    const x = unitToken(rec[0]);
    const y = unitToken(rec[1]);
    if (x === null || y === null) return null;
    if (rec.length === 3) droppedHandles = true;
    points.push({ x, y });
  }
  return { points: points.sort((a, b) => a.x - b.x), droppedHandles };
}

/** THE writer: formatUnit both coordinates, ' ' between them, ',' between records. Output alphabet `[0-9., ]`. */
export function formatCurve(points: readonly CurvePoint[]): string {
  return points.map((p) => `${formatUnit(p.x)} ${formatUnit(p.y)}`).join(',');
}

const freezePoints = (points: readonly CurvePoint[]): readonly CurvePoint[] =>
  Object.freeze(points.map((p) => Object.freeze({ x: p.x, y: p.y })));

const memo = readerMemo<RgbCurves>();

function readCurve(raw: unknown): CurveRead {
  let canonical = IDENTITY_CURVE;
  let rejected = false;
  let droppedHandles = false;
  if (raw !== undefined && raw !== '') {
    const parsed = parseCurve(raw);
    if (parsed) {
      canonical = formatCurve(parsed.points);
      droppedHandles = parsed.droppedHandles;
    } else rejected = true;
  }
  return Object.freeze({ points: freezePoints(parseCurve(canonical)?.points ?? []), canonical, rejected, droppedHandles });
}

/** THE reader (codegen, CPU, card, editor, price). Total on `unknown`. A curve: undefined/'' → identity, not
 *  rejected; non-string or unreadable → identity + rejected. extend: exactly 'horizontal', else 'extrapolate'
 *  (+ rejectedExtend when a key was present and is not `isCurveExtend`). Each channel's `points` is ALWAYS the parse
 *  of its `canonical`. Memoised on the injective string-only key of utils/lutReader.ts (bounded). */
export function readRgbCurves(values: unknown): RgbCurves {
  const raws = CURVE_CHANNELS.map((ch) => field(values, CURVE_KEYS[ch]));
  const rawExtend = field(values, 'extend');
  return memo([...raws, rawExtend], () => {
    const [c, r, g, b] = raws.map(readCurve);
    const extend: CurveExtend = rawExtend === 'horizontal' ? 'horizontal' : 'extrapolate';
    const rejectedExtend = rawExtend !== undefined && !isCurveExtend(rawExtend);
    const rejectedChannels = (['C', 'R', 'G', 'B'] as const).filter((_, i) => [c, r, g, b][i].rejected);
    return Object.freeze({
      c,
      r,
      g,
      b,
      extend,
      identity: extend !== 'horizontal' && [c, r, g, b].every((k) => k.canonical === IDENTITY_CURVE),
      rejectedChannels: Object.freeze(rejectedChannels),
      rejectedExtend,
    });
  });
}

/** The key `fsLut.make` caches these curves' baked table under — spelled exactly as FS_RGB_CURVES_LINES computes
 *  it from the strings graphToCode emits (`'curves ' + extend + ' ' + R|G|B|C`), so equal nodes share ONE texture.
 *  null for the identity form, which returns `vec3(col)` and bakes nothing. graphToCode counts the texture budget by
 *  it; lutHelpers.test.ts runs the emitted helper and finds its texture under this key, for every corpus entry. */
export function curvesTableKey(curves: RgbCurves): string | null {
  if (curves.identity) return null;
  return `curves ${curves.extend} ${[curves.r, curves.g, curves.b, curves.c].map((k) => k.canonical).join('|')}`;
}

type V2 = [number, number];
interface Bez {
  h0: V2;
  k: V2;
  h2: V2;
}

/** FLT_EPSILON — Blender's guard in the first/last handle fix and the table loop. */
const EPS = 1.1920928955078125e-7;

/**
 * Blender curvemap_make_table (non-wrapping, every handle HD_AUTO) plus the GPU end slopes — operation for
 * operation the helper's per-curve body (engine/lutHelperText.ts FS_RGB_CURVES_LINES), so the Float32 bake below
 * is bit-identical to fsRgbCurves'. `table[i]` is the curve at x = i/256; `s0`/`s1` the start/end slope
 * (ext[1]/ext[0]; 1e4 for a vertical end, 0 when Horizontal, clamped to ±1e4, non-finite → 0). A table that came
 * out non-finite is replaced by the identity i/256, as the helper does. `points` must be sorted, 2..32 of them.
 */
export function curveTable(points: readonly CurvePoint[], horizontal: boolean): { table: Float64Array; s0: number; s1: number } {
  const pts = points.length >= 2 ? points : [{ x: 0, y: 0 }, { x: 1, y: 1 }];
  const cnt = pts.length;
  // calchandle_curvemap, HD_AUTO branch.
  const bz: Bez[] = pts.map((pt) => ({ h0: [0, 0], k: [pt.x, pt.y], h2: [0, 0] }));
  for (let i = 0; i < cnt; i++) {
    const k2 = bz[i].k;
    const k1: V2 = i > 0 ? bz[i - 1].k : [2 * k2[0] - bz[i + 1].k[0], 2 * k2[1] - bz[i + 1].k[1]];
    const k3: V2 = i < cnt - 1 ? bz[i + 1].k : [2 * k2[0] - k1[0], 2 * k2[1] - k1[1]];
    const da = [k2[0] - k1[0], k2[1] - k1[1]];
    const db = [k3[0] - k2[0], k3[1] - k2[1]];
    const la = Math.hypot(da[0], da[1]) || 1;
    const lb = Math.hypot(db[0], db[1]) || 1;
    const tv = [db[0] / lb + da[0] / la, db[1] / lb + da[1] / la];
    const tl = Math.hypot(tv[0], tv[1]) * 2.5614;
    if (tl !== 0) {
      bz[i].h0 = [k2[0] - tv[0] * (la / tl), k2[1] - tv[1] * (la / tl)];
      bz[i].h2 = [k2[0] + tv[0] * (lb / tl), k2[1] + tv[1] * (lb / tl)];
    }
  }
  // The first and last handle point at the closest handle rather than the next point's centre.
  if (cnt > 2) {
    const fix = (b: Bez, near: V2, keep: 'h0' | 'h2', toward: (p: number, q: number) => number): [V2, V2] | null => {
      const hl = Math.hypot(b.k[0] - b[keep][0], b.k[1] - b[keep][1]);
      const vx = toward(near[0], b.k[0]) - b.k[0];
      const vy = near[1] - b.k[1];
      const nl = Math.hypot(vx, vy);
      if (nl > EPS) {
        const sx = vx * (hl / nl);
        const sy = vy * (hl / nl);
        return [[b.k[0] + sx, b.k[1] + sy], [b.k[0] - sx, b.k[1] - sy]];
      }
      return null;
    };
    const f0 = fix(bz[0], bz[1].h0, 'h2', Math.max);
    if (f0) {
      bz[0].h2 = f0[0];
      bz[0].h0 = f0[1];
    }
    const fl = fix(bz[cnt - 1], bz[cnt - 2].h2, 'h0', Math.min);
    if (fl) {
      bz[cnt - 1].h0 = fl[0];
      bz[cnt - 1].h2 = fl[1];
    }
  }
  // BKE_curve_correct_bezpart + BKE_curve_forward_diff_bezier, CM_RESOL = 32 samples per segment.
  const xs: number[] = [];
  const ys: number[] = [];
  const diff = (q0: number, q1: number, q2: number, q3: number, out: number[]) => {
    let fd = 31;
    const rt0 = q0;
    const rt1 = (3 * (q1 - q0)) / fd;
    fd *= fd;
    const rt2 = (3 * (q0 - 2 * q1 + q2)) / fd;
    fd *= 31;
    const rt3 = (q3 - q0 + 3 * (q1 - q2)) / fd;
    let d0 = rt0;
    let d1 = rt1 + rt2 + rt3;
    let d2 = 2 * rt2 + 6 * rt3;
    const d3 = 6 * rt3;
    for (let i = 0; i <= 31; i++) {
      out.push(d0);
      d0 += d1;
      d1 += d2;
      d2 += d3;
    }
  };
  for (let i = 0; i < cnt - 1; i++) {
    const v1 = bz[i].k;
    const v2 = bz[i].h2;
    const v3 = bz[i + 1].h0;
    const v4 = bz[i + 1].k;
    const ha = [v1[0] - v2[0], v1[1] - v2[1]];
    const hb = [v4[0] - v3[0], v4[1] - v3[1]];
    const span = v4[0] - v1[0];
    const l1 = Math.abs(ha[0]);
    const l2 = Math.abs(hb[0]);
    if (l1 + l2 !== 0 && l1 + l2 > span) {
      const sc = span / (l1 + l2);
      bz[i].h2 = [v1[0] - sc * ha[0], v1[1] - sc * ha[1]];
      bz[i + 1].h0 = [v4[0] - sc * hb[0], v4[1] - sc * hb[1]];
    }
    diff(v1[0], bz[i].h2[0], bz[i + 1].h0[0], v4[0], xs);
    diff(v1[1], bz[i].h2[1], bz[i + 1].h0[1], v4[1], ys);
  }
  // ext_in / ext_out, unit length (a zero-length handle reads as horizontal rather than Blender's 0/0 NaN).
  const unitDir = (dx: number, dy: number): V2 => {
    const dl = Math.sqrt(dx * dx + dy * dy);
    return dl > 0 ? [dx / dl, dy / dl] : [1, 0];
  };
  const ein = unitDir(bz[0].h0[0] - bz[0].k[0], bz[0].h0[1] - bz[0].k[1]);
  const eout = unitDir(bz[cnt - 1].k[0] - bz[cnt - 1].h2[0], bz[cnt - 1].k[1] - bz[cnt - 1].h2[1]);
  const last = xs.length - 1;
  // curvemap_calc_extend.
  const extendAt = (x: number): number => {
    if (x <= xs[0]) {
      if (horizontal) return ys[0];
      return ein[0] === 0 ? ys[0] + ein[1] * 10000 : ys[0] + (ein[1] * (x - xs[0])) / ein[0];
    }
    if (horizontal) return ys[last];
    return eout[0] === 0 ? ys[last] - eout[1] * 10000 : ys[last] + (eout[1] * (x - xs[last])) / eout[0];
  };
  // The CM_TABLE loop: 257 equal x steps over [0,1].
  const tab = new Float64Array(FS_LUT_SIZE);
  let ptr = 0;
  for (let i = 0; i <= 256; i++) {
    const cx = i * 0.00390625;
    while (cx >= xs[ptr] && ptr !== last) ptr++;
    if (ptr === 0 || (ptr === last && cx >= xs[ptr])) {
      tab[i] = Math.abs(cx - xs[ptr]) <= 1e-6 ? ys[ptr] : extendAt(cx);
    } else {
      let f1 = xs[ptr] - xs[ptr - 1];
      const f2 = xs[ptr] - cx;
      f1 = f1 > EPS ? f2 / f1 : 0;
      tab[i] = f1 * ys[ptr - 1] + (1 - f1) * ys[ptr];
    }
  }
  const slope = (d: V2): number => {
    const sl = horizontal ? 0 : d[0] !== 0 ? d[1] / d[0] : 1e4;
    return Number.isFinite(sl) ? Math.max(-1e4, Math.min(1e4, sl)) : 0;
  };
  const table = tab.every(Number.isFinite) ? tab : tab.map((_, i) => i / 256);
  return { table, s0: slope(ein), s1: slope(eout) };
}

/** The helper's channel order: r,g,b texels = the R, G, B curves, a = C (Blender's band layout). */
const BAKE_ORDER = ['r', 'g', 'b', 'c'] as const;

type CurveTables = Readonly<Record<CurveChannel, { table: Float64Array; s0: number; s1: number }>>;
const tableMemo = new WeakMap<RgbCurves, CurveTables>();
/** curveTable for all four channels, memoised per reader result (the reader itself is memoised on the strings,
 *  so the card, the editor and the bake share one computation). */
export function curveTables(curves: RgbCurves): CurveTables {
  let hit = tableMemo.get(curves);
  if (!hit) {
    const horizontal = curves.extend === 'horizontal';
    hit = Object.freeze({
      c: curveTable(curves.c.points, horizontal),
      r: curveTable(curves.r.points, horizontal),
      g: curveTable(curves.g.points, horizontal),
      b: curveTable(curves.b.points, horizontal),
    });
    tableMemo.set(curves, hit);
  }
  return hit;
}

const halves = new WeakMap<RgbCurves, { half: Uint16Array; slopes: number[] }>();
/** The helper's bake: 257×4 half floats (R,G,B,C) through a Float32Array + slopes [R0,R1,G0,G1,B0,B1,C0,C1].
 *  Memoised per reader result. fsRgbCurves never bakes the identity form; this still answers it (the identity
 *  table), so a caller need not special-case it. */
export function rgbCurvesHalf(curves: RgbCurves): { half: Uint16Array; slopes: number[] } {
  let hit = halves.get(curves);
  if (!hit) {
    const all = curveTables(curves);
    const tables = BAKE_ORDER.map((ch) => all[ch]);
    const vals = new Float32Array(FS_LUT_SIZE * 4);
    for (let i = 0; i < FS_LUT_SIZE; i++) for (let k = 0; k < 4; k++) vals[i * 4 + k] = tables[k].table[i];
    hit = { half: halfTable(vals), slopes: tables.flatMap((t) => [t.s0, t.s1]) };
    halves.set(curves, hit);
  }
  return hit;
}

/** One curve as the shader reads it: the table at clamp(x) plus the branch-free extrapolation. */
function stage(half: Uint16Array, channel: 0 | 1 | 2 | 3, s0: number, s1: number, x: number): number {
  return fetchHalf(half, channel, x, false) + Math.min(x, 0) * s0 + Math.max(x - 1, 0) * s1;
}

/** CPU twin of the emitted two-stage expression on the HALF table — C per channel, then R/G/B, then
 *  mix(rgb, post, fac). Identity returns `rgb` (the helper returns vec3(col), with no mix). Non-finite → null. */
export function evalRgbCurves(curves: RgbCurves, rgb: readonly [number, number, number], fac: number): [number, number, number] | null {
  if (!rgb.every(Number.isFinite) || !Number.isFinite(fac)) return null;
  if (curves.identity) return [rgb[0], rgb[1], rgb[2]];
  const { half, slopes: sl } = rgbCurvesHalf(curves);
  const out = [0, 1, 2].map((k) => {
    const pre = stage(half, 3, sl[6], sl[7], rgb[k]);
    const post = stage(half, k as 0 | 1 | 2, sl[2 * k], sl[2 * k + 1], pre);
    return rgb[k] * (1 - fac) + post * fac;
  });
  return out.every(Number.isFinite) ? [out[0], out[1], out[2]] : null;
}

/** `a·b` with 0·±∞ = 0: an unbounded input times a zero weight contributes nothing (not NaN). */
const mul0 = (a: number, b: number): number => (a === 0 || b === 0 ? 0 : a * b);

/** Exact bound of one curve stage over x ∈ [lo, hi]: piecewise linear, so the clamped part is rangeHalf (both
 *  ends + every texel centre inside, 0 and 1 included) and each extension is linear from the table's end. An
 *  infinite bound with a non-zero slope, or a NaN bound, is unbounded → null. */
function stageRange(half: Uint16Array, channel: 0 | 1 | 2 | 3, s0: number, s1: number, lo: number, hi: number): [number, number] | null {
  if (Number.isNaN(lo) || Number.isNaN(hi)) return null;
  const a = Math.min(lo, hi);
  const b = Math.max(lo, hi);
  let [min, max] = rangeHalf(half, channel, a, b, false);
  const see = (v: number) => {
    if (v < min) min = v;
    if (v > max) max = v;
  };
  if (a < 0) {
    if (!Number.isFinite(a) && s0 !== 0) return null;
    see(fetchHalf(half, channel, 0, false) + mul0(a, s0));
  }
  if (b > 1) {
    if (!Number.isFinite(b) && s1 !== 0) return null;
    see(fetchHalf(half, channel, 1, false) + mul0(b - 1, s1));
  }
  return Number.isFinite(min) && Number.isFinite(max) ? [min, max] : null;
}

/** Per-channel bound: stage 1 over [lo,hi], stage 2 over stage 1's range, then the corners of
 *  mix = base·(1−f) + post·f over base × post × fac (multilinear, so the box's corners hold the extremes;
 *  treating base and post as independent only widens it). Identity → the input range itself. Any unbounded
 *  stage → null (unknown). */
export function rgbCurvesRange(
  curves: RgbCurves,
  lo: readonly number[],
  hi: readonly number[],
  facLo: number,
  facHi: number,
): { min: number[]; max: number[] } | null {
  if (curves.identity) {
    const min = [0, 1, 2].map((k) => Math.min(lo[k], hi[k]));
    const max = [0, 1, 2].map((k) => Math.max(lo[k], hi[k]));
    return min.every((v) => !Number.isNaN(v)) && max.every((v) => !Number.isNaN(v)) ? { min, max } : null;
  }
  if (!Number.isFinite(facLo) || !Number.isFinite(facHi)) return null;
  const { half, slopes: sl } = rgbCurvesHalf(curves);
  const min: number[] = [];
  const max: number[] = [];
  for (let k = 0; k < 3; k++) {
    const pre = stageRange(half, 3, sl[6], sl[7], lo[k], hi[k]);
    const post = pre && stageRange(half, k as 0 | 1 | 2, sl[2 * k], sl[2 * k + 1], pre[0], pre[1]);
    if (!post) return null;
    const corners: number[] = [];
    for (const base of [lo[k], hi[k]]) for (const p of post) for (const f of [facLo, facHi]) corners.push(mul0(base, 1 - f) + mul0(p, f));
    if (corners.some(Number.isNaN)) return null;
    min.push(Math.min(...corners));
    max.push(Math.max(...corners));
  }
  return { min, max };
}

const coord = (n: number): string => String(Math.round(n * 100) / 100);
/** SVG path of a curve over [0,1]² from its table (every 4th texel, 65 points), y flipped, clamped to
 *  [-0.25, 1.25] so a steep extrapolated end leaves the box instead of blowing up the path. */
export function curvePath(table: Float64Array, w: number, h: number): string {
  const parts: string[] = [];
  for (let i = 0; i < FS_LUT_SIZE; i += 4) {
    const v = table[i];
    const y = Number.isFinite(v) ? Math.min(Math.max(v, -0.25), 1.25) : 0;
    parts.push(`${i === 0 ? 'M' : 'L'}${coord((i / 256) * w)} ${coord((1 - y) * h)}`);
  }
  return parts.join(' ');
}

// ─── Editor ops — pure; points never cross, so a point's index is stable through drags, nudges and typed X ───
// Coordinates are rounded as the canonical string holds them (`roundUnit`).

/** x clamped between the neighbours (0 / 1 at the ends), y to [0,1], both rounded as stored. */
function clampAt(points: readonly CurvePoint[], i: number, x: number, y: number): CurvePoint {
  const loX = i > 0 ? points[i - 1].x : 0;
  const hiX = i < points.length - 1 ? points[i + 1].x : 1;
  const cx = Number.isFinite(x) ? Math.min(Math.max(x, loX), hiX) : points[i].x;
  return { x: roundUnit(cx), y: roundUnit(Number.isFinite(y) ? y : points[i].y) };
}

/** A new point at (x, y), inserted AFTER any point with an equal x. null at the 32-point cap. */
export function addPoint(points: readonly CurvePoint[], x: number, y: number): { points: CurvePoint[]; index: number } | null {
  if (points.length >= CURVE_MAX_POINTS) return null;
  const pt = { x: roundUnit(x), y: roundUnit(y) };
  const next = [...points];
  let index = next.findIndex((p) => p.x > pt.x);
  if (index < 0) index = next.length;
  next.splice(index, 0, pt);
  return { points: next, index };
}

/** Move point i to (x, y) without crossing a neighbour. An invalid index returns an unchanged copy. */
export function movePoint(points: readonly CurvePoint[], i: number, x: number, y: number): CurvePoint[] {
  if (!Number.isInteger(i) || i < 0 || i >= points.length) return [...points];
  const moved = clampAt(points, i, x, y);
  return points.map((p, k) => (k === i ? moved : p));
}

/** null at two points (a curve needs two) or for an index that is not a point. */
export function deletePoint(points: readonly CurvePoint[], i: number): CurvePoint[] | null {
  if (points.length <= CURVE_MIN_POINTS || !Number.isInteger(i) || i < 0 || i >= points.length) return null;
  return points.filter((_, k) => k !== i);
}
