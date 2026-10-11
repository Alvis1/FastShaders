import { describe, it, expect } from 'vitest';
import {
  parseCurve,
  formatCurve,
  readRgbCurves,
  curveTable,
  rgbCurvesHalf,
  evalRgbCurves,
  rgbCurvesRange,
  curvePath,
  addPoint,
  movePoint,
  deletePoint,
  isCurveExtend,
  IDENTITY_CURVE,
  CURVE_MAX_POINTS,
  type CurvePoint,
} from './rgbCurves';
import { fetchHalf } from './lutTable';

/**
 * RGB Curves' trusted-side twin. The node's description says "exactly as in
 * Blender", so the per-curve table is held to an IN-TEST transcription of
 * Blender's C (the copies in the design scratchpad, quoted below with their
 * source lines), run in float32 at every store Blender makes — not to the
 * helper text, which `curveTable` transcribes too and lutHelpers.test.ts holds
 * bit-exact. Two independent transcriptions agreeing is the point.
 */

const P = (s: string): CurvePoint[] => parseCurve(s)!.points;

// ─── Blender transcription (float32 at each store) ────────────────────────────

const f = Math.fround;
const FLT_EPSILON = 1.1920928955078125e-7;
type V3 = [number, number, number];
interface BezTriple {
  vec: [V3, V3, V3]; // [h1, key, h2]
}

/* colortools.cc:572 — static void calchandle_curvemap(BezTriple *bezt, const BezTriple *prev, const BezTriple *next)
 *   if (prev == nullptr) { p3 = next->vec[1]; pt[0] = 2.0f * p2[0] - p3[0]; pt[1] = 2.0f * p2[1] - p3[1]; p1 = pt; }
 *   else { p1 = prev->vec[1]; }
 *   if (next == nullptr) { p1 = prev->vec[1]; pt[0] = 2.0f * p2[0] - p1[0]; pt[1] = 2.0f * p2[1] - p1[1]; p3 = pt; }
 *   else { p3 = next->vec[1]; }
 *   sub_v2_v2v2(dvec_a, p2, p1); sub_v2_v2v2(dvec_b, p3, p2);
 *   len_a = len_v2(dvec_a); len_b = len_v2(dvec_b);
 *   if (len_a == 0.0f) len_a = 1.0f;  if (len_b == 0.0f) len_b = 1.0f;
 *   if (ELEM(bezt->h1, HD_AUTO, …) || …) { // auto
 *     tvec[0] = dvec_b[0] / len_b + dvec_a[0] / len_a; tvec[1] = dvec_b[1] / len_b + dvec_a[1] / len_a;
 *     len = len_v2(tvec) * 2.5614f;
 *     if (len != 0.0f) {
 *       if (ELEM(bezt->h1, HD_AUTO, …)) { len_a /= len; madd_v2_v2v2fl(p2_h1, p2, tvec, -len_a); }
 *       if (ELEM(bezt->h2, HD_AUTO, …)) { len_b /= len; madd_v2_v2v2fl(p2_h2, p2, tvec, len_b); } } }
 */
function calchandleCurvemap(bezt: BezTriple, prev: BezTriple | null, next: BezTriple | null): void {
  const p2 = bezt.vec[1];
  const pt: V3 = [0, 0, 0];
  let p1: V3;
  let p3: V3;
  if (prev === null) {
    p3 = next!.vec[1];
    pt[0] = f(2 * p2[0] - p3[0]);
    pt[1] = f(2 * p2[1] - p3[1]);
    p1 = pt;
  } else p1 = prev.vec[1];
  if (next === null) {
    p1 = prev!.vec[1];
    pt[0] = f(2 * p2[0] - p1[0]);
    pt[1] = f(2 * p2[1] - p1[1]);
    p3 = pt;
  } else p3 = next.vec[1];
  const dvecA = [f(p2[0] - p1[0]), f(p2[1] - p1[1])];
  const dvecB = [f(p3[0] - p2[0]), f(p3[1] - p2[1])];
  let lenA = f(Math.sqrt(dvecA[0] * dvecA[0] + dvecA[1] * dvecA[1]));
  let lenB = f(Math.sqrt(dvecB[0] * dvecB[0] + dvecB[1] * dvecB[1]));
  if (lenA === 0) lenA = 1;
  if (lenB === 0) lenB = 1;
  const tvec = [f(dvecB[0] / lenB + dvecA[0] / lenA), f(dvecB[1] / lenB + dvecA[1] / lenA)];
  const len = f(f(Math.sqrt(tvec[0] * tvec[0] + tvec[1] * tvec[1])) * f(2.5614));
  if (len !== 0) {
    lenA = f(lenA / len);
    bezt.vec[0][0] = f(p2[0] + tvec[0] * -lenA);
    bezt.vec[0][1] = f(p2[1] + tvec[1] * -lenA);
    lenB = f(lenB / len);
    bezt.vec[2][0] = f(p2[0] + tvec[0] * lenB);
    bezt.vec[2][1] = f(p2[1] + tvec[1] * lenB);
  }
}

/* curve.cc — void BKE_curve_correct_bezpart(const float v1[2], float v2[2], float v3[2], const float v4[2])
 *   h1 = v1 - v2; h2 = v4 - v3; len = v4[0] - v1[0]; len1 = fabsf(h1[0]); len2 = fabsf(h2[0]);
 *   if ((len1 + len2) == 0.0f) return;
 *   if ((len1 + len2) > len) { fac = len / (len1 + len2); v2 = v1 - fac * h1; v3 = v4 - fac * h2; } */
function correctBezpart(v1: V3, v2: V3, v3: V3, v4: V3): void {
  const h1 = [f(v1[0] - v2[0]), f(v1[1] - v2[1])];
  const h2 = [f(v4[0] - v3[0]), f(v4[1] - v3[1])];
  const len = f(v4[0] - v1[0]);
  const len1 = Math.abs(h1[0]);
  const len2 = Math.abs(h2[0]);
  if (f(len1 + len2) === 0) return;
  if (f(len1 + len2) > len) {
    const fac = f(len / f(len1 + len2));
    v2[0] = f(v1[0] - fac * h1[0]);
    v2[1] = f(v1[1] - fac * h1[1]);
    v3[0] = f(v4[0] - fac * h2[0]);
    v3[1] = f(v4[1] - fac * h2[1]);
  }
}

/* curve.cc:1696 — void BKE_curve_forward_diff_bezier(float q0, float q1, float q2, float q3, float *p, int it, int stride)
 *   f = float(it); rt0 = q0; rt1 = 3.0f * (q1 - q0) / f; f *= f; rt2 = 3.0f * (q0 - 2.0f * q1 + q2) / f; f *= it;
 *   rt3 = (q3 - q0 + 3.0f * (q1 - q2)) / f;
 *   q0 = rt0; q1 = rt1 + rt2 + rt3; q2 = 2 * rt2 + 6 * rt3; q3 = 6 * rt3;
 *   for (a = 0; a <= it; a++) { *p = q0; p += stride; q0 += q1; q1 += q2; q2 += q3; } */
function forwardDiffBezier(q0: number, q1: number, q2: number, q3: number, out: number[]): void {
  const it = 31; // CM_RESOL - 1
  let fl = f(it);
  const rt0 = q0;
  const rt1 = f((3 * f(q1 - q0)) / fl);
  fl = f(fl * fl);
  const rt2 = f((3 * f(q0 - 2 * q1 + q2)) / fl);
  fl = f(fl * it);
  const rt3 = f(f(q3 - q0 + 3 * f(q1 - q2)) / fl);
  let a0 = rt0;
  let a1 = f(rt1 + rt2 + rt3);
  let a2 = f(2 * rt2 + 6 * rt3);
  const a3 = f(6 * rt3);
  for (let a = 0; a <= it; a++) {
    out.push(a0);
    a0 = f(a0 + a1);
    a1 = f(a1 + a2);
    a2 = f(a2 + a3);
  }
}

interface BlenderCurveMap {
  table: { x: number; y: number }[];
  extIn: [number, number];
  extOut: [number, number];
  extrapolate: boolean;
}

/* colortools.cc:687 — static float curvemap_calc_extend(cumap, cuma, float x, const float first[2], const float last[2])
 *   if (x <= first[0]) { if ((cumap->flag & CUMA_EXTEND_EXTRAPOLATE) == 0) return first[1];
 *     if (cuma->ext_in[0] == 0.0f) return first[1] + cuma->ext_in[1] * 10000.0f;
 *     return first[1] + cuma->ext_in[1] * (x - first[0]) / cuma->ext_in[0]; }
 *   if (x >= last[0]) { … return last[1]; … if (cuma->ext_out[0] == 0.0f) return last[1] - cuma->ext_out[1] * 10000.0f;
 *     return last[1] + cuma->ext_out[1] * (x - last[0]) / cuma->ext_out[0]; }
 *   return 0.0f; */
function calcExtend(cm: Pick<BlenderCurveMap, 'extIn' | 'extOut' | 'extrapolate'>, x: number, first: number[], last: number[]): number {
  if (x <= first[0]) {
    if (!cm.extrapolate) return first[1];
    if (cm.extIn[0] === 0) return f(first[1] + cm.extIn[1] * 10000);
    return f(first[1] + f(f(cm.extIn[1] * f(x - first[0])) / cm.extIn[0]));
  }
  if (x >= last[0]) {
    if (!cm.extrapolate) return last[1];
    if (cm.extOut[0] === 0) return f(last[1] - cm.extOut[1] * 10000);
    return f(last[1] + f(f(cm.extOut[1] * f(x - last[0])) / cm.extOut[0]));
  }
  return 0;
}

/* colortools.cc:732 — static void curvemap_make_table(const CurveMapping *cumap, CurveMap *cuma), non-wrapping,
 * every point HD_AUTO, clipr = [0,1] (so mintable 0, maxtable 1, range = CM_TABLEDIV * 1):
 *   for (a = 0; a < bezt_totpoint; a++) { bezt_next = (a != bezt_totpoint - 1) ? &bezt[a + 1] : nullptr;
 *     calchandle_curvemap(&bezt[a], bezt_prev, bezt_next); bezt_prev = &bezt[a]; }
 *   if (bezt_totpoint > 2 && !use_wrapping) {
 *     if (bezt[0].h2 == HD_AUTO) { hlen = len_v3v3(bezt[0].vec[1], bezt[0].vec[2]);
 *       copy_v3_v3(vec, bezt[1].vec[0]); vec[0] = std::max(vec[0], bezt[0].vec[1][0]); sub_v3_v3(vec, bezt[0].vec[1]);
 *       nlen = len_v3(vec); if (nlen > FLT_EPSILON) { mul_v3_fl(vec, hlen / nlen);
 *         add_v3_v3v3(bezt[0].vec[2], vec, bezt[0].vec[1]); sub_v3_v3v3(bezt[0].vec[0], bezt[0].vec[1], vec); } }
 *     int a = bezt_totpoint - 1; if (bezt[a].h2 == HD_AUTO) { hlen = len_v3v3(bezt[a].vec[1], bezt[a].vec[0]);
 *       copy_v3_v3(vec, bezt[a - 1].vec[2]); vec[0] = std::min(vec[0], bezt[a].vec[1][0]); sub_v3_v3(vec, bezt[a].vec[1]);
 *       nlen = len_v3(vec); if (nlen > FLT_EPSILON) { mul_v3_fl(vec, hlen / nlen);
 *         add_v3_v3v3(bezt[a].vec[0], vec, bezt[a].vec[1]); sub_v3_v3v3(bezt[a].vec[2], bezt[a].vec[1], vec); } } }
 *   for (int a = 0; a < bezt_totpoint - 1; a++, point += 2 * CM_RESOL) curve_eval_bezier_point(bezt[a].vec, bezt[b].vec, point);
 *   cuma->ext_in = (bezt[0].vec[0] - bezt[0].vec[1]) / its length; cuma->ext_out = (bezt[last].vec[1] - bezt[last].vec[2]) / its length;
 *   for (int a = 0; a <= CM_TABLE; a++) { float cur_x = cuma->mintable + range * float(a);
 *     while (cur_x >= point[0] && point != lastpoint) point += 2;
 *     if ((point == firstpoint || (point == lastpoint && cur_x >= point[0])) && !use_wrapping) {
 *       if (compare_ff(cur_x, point[0], 1e-6f)) cmp[a].y = point[1];
 *       else cmp[a].y = curvemap_calc_extend(cumap, cuma, cur_x, firstpoint, lastpoint); }
 *     else { float fac1 = point[0] - point[-2]; float fac2 = point[0] - cur_x;
 *       if (fac1 > FLT_EPSILON) fac1 = fac2 / fac1; else fac1 = 0.0f;
 *       cmp[a].y = fac1 * point[-1] + (1.0f - fac1) * point[1]; } } */
function blenderMakeTable(points: readonly CurvePoint[], extrapolate: boolean): BlenderCurveMap {
  const n = points.length;
  const bezt: BezTriple[] = points.map((p) => ({ vec: [[0, 0, 0], [f(p.x), f(p.y), 0], [0, 0, 0]] }));
  let prev: BezTriple | null = null;
  for (let a = 0; a < n; a++) {
    calchandleCurvemap(bezt[a], prev, a !== n - 1 ? bezt[a + 1] : null);
    prev = bezt[a];
  }
  const len3 = (v: number[]) => f(Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]));
  if (n > 2) {
    {
      const b = bezt[0];
      const hlen = len3([b.vec[1][0] - b.vec[2][0], b.vec[1][1] - b.vec[2][1], 0]);
      const vec: V3 = [...bezt[1].vec[0]] as V3;
      vec[0] = Math.max(vec[0], b.vec[1][0]);
      vec[0] = f(vec[0] - b.vec[1][0]);
      vec[1] = f(vec[1] - b.vec[1][1]);
      const nlen = len3(vec);
      if (nlen > FLT_EPSILON) {
        const s = f(hlen / nlen);
        vec[0] = f(vec[0] * s);
        vec[1] = f(vec[1] * s);
        b.vec[2] = [f(vec[0] + b.vec[1][0]), f(vec[1] + b.vec[1][1]), 0];
        b.vec[0] = [f(b.vec[1][0] - vec[0]), f(b.vec[1][1] - vec[1]), 0];
      }
    }
    {
      const a = n - 1;
      const b = bezt[a];
      const hlen = len3([b.vec[1][0] - b.vec[0][0], b.vec[1][1] - b.vec[0][1], 0]);
      const vec: V3 = [...bezt[a - 1].vec[2]] as V3;
      vec[0] = Math.min(vec[0], b.vec[1][0]);
      vec[0] = f(vec[0] - b.vec[1][0]);
      vec[1] = f(vec[1] - b.vec[1][1]);
      const nlen = len3(vec);
      if (nlen > FLT_EPSILON) {
        const s = f(hlen / nlen);
        vec[0] = f(vec[0] * s);
        vec[1] = f(vec[1] * s);
        b.vec[0] = [f(vec[0] + b.vec[1][0]), f(vec[1] + b.vec[1][1]), 0];
        b.vec[2] = [f(b.vec[1][0] - vec[0]), f(b.vec[1][1] - vec[1]), 0];
      }
    }
  }
  const xs: number[] = [];
  const ys: number[] = [];
  for (let a = 0; a < n - 1; a++) {
    const s = bezt[a].vec;
    const e = bezt[a + 1].vec;
    correctBezpart(s[1], s[2], e[0], e[1]);
    forwardDiffBezier(s[1][0], s[2][0], e[0][0], e[1][0], xs);
    forwardDiffBezier(s[1][1], s[2][1], e[0][1], e[1][1], ys);
  }
  const unit = (dx: number, dy: number): [number, number] => {
    const l = f(Math.sqrt(f(dx * dx + dy * dy)));
    return [f(dx / l), f(dy / l)];
  };
  const b0 = bezt[0].vec;
  const bl = bezt[n - 1].vec;
  const cm = {
    extIn: unit(f(b0[0][0] - b0[1][0]), f(b0[0][1] - b0[1][1])),
    extOut: unit(f(bl[1][0] - bl[2][0]), f(bl[1][1] - bl[2][1])),
    extrapolate,
  };
  const range = f(1 / 256);
  const last = xs.length - 1;
  const table: { x: number; y: number }[] = [];
  let ptr = 0;
  for (let a = 0; a <= 256; a++) {
    const curX = f(0 + range * a);
    while (curX >= xs[ptr] && ptr !== last) ptr++;
    let y: number;
    if (ptr === 0 || (ptr === last && curX >= xs[ptr])) {
      y = Math.abs(f(curX - xs[ptr])) <= f(1e-6) ? ys[ptr] : calcExtend(cm, curX, [xs[0], ys[0]], [xs[last], ys[last]]);
    } else {
      let fac1 = f(xs[ptr] - xs[ptr - 1]);
      const fac2 = f(xs[ptr] - curX);
      fac1 = fac1 > FLT_EPSILON ? f(fac2 / fac1) : 0;
      y = f(fac1 * ys[ptr - 1] + f(1 - fac1) * ys[ptr]);
    }
    table.push({ x: curX, y });
  }
  return { table, ...cm };
}

/* colortools.cc:1153 — float BKE_curvemap_evaluateF(const CurveMapping *cumap, const CurveMap *cuma, float value)
 *   float fi = (value - cuma->mintable) * cuma->range; int i = int(fi);
 *   if (fi < 0.0f || fi > CM_TABLE) return curvemap_calc_extend(cumap, cuma, value, &cuma->table[0].x, &cuma->table[CM_TABLE].x);
 *   if (i < 0) return cuma->table[0].y; if (i >= CM_TABLE) return cuma->table[CM_TABLE].y;
 *   fi = fi - float(i); return (1.0f - fi) * cuma->table[i].y + (fi)*cuma->table[i + 1].y; */
function blenderEvaluateF(cm: BlenderCurveMap, value: number): number {
  let fi = f(f(value - 0) * 256);
  const i = Math.trunc(fi);
  if (fi < 0 || fi > 256) {
    return calcExtend(cm, value, [cm.table[0].x, cm.table[0].y], [cm.table[256].x, cm.table[256].y]);
  }
  if (i < 0) return cm.table[0].y;
  if (i >= 256) return cm.table[256].y;
  fi = f(fi - i);
  return f(f(1 - fi) * cm.table[i].y + fi * cm.table[i + 1].y);
}

const PARITY_CORPUS: string[] = [
  IDENTITY_CURVE,
  '0 0.2,1 0.8',
  '0 0,0.25 0.15,0.75 0.85,1 1',
  '0 0,0.3 0.1,0.6 0.9,1 1',
  '0 0.1,0.4 0.2,0.7 0.95,1 0.9',
  '0 0,0.5 0.8,1 1',
  '0 1,0.5 0.2,1 0.9',
  '0.1 0,0.9 1',
  '0 1,1 0',
  '0 0.5,1 0.5',
  '0 0,0.5 1,1 0',
  '0.2 0.3,0.4 0.1,0.6 0.9,0.8 0.7',
  '0 0,0.02 1,1 1',
  '0 0,0.98 0,1 1',
  '0 0,0 1,1 1',
  '0 0,1 0,1 1',
  '0.25 0.5,0.5 0.75,0.75 0.25',
  Array.from({ length: 8 }, (_, i) => `${(i / 7).toFixed(3)} ${((i * 3) % 7 / 6).toFixed(3)}`).join(','),
  Array.from({ length: 32 }, (_, i) => `${(i / 31).toFixed(4)} ${(0.5 + 0.5 * Math.sin(i)).toFixed(4)}`).join(','),
  Array.from({ length: 32 }, (_, i) => `${(i / 31).toFixed(4)} ${Math.pow(i / 31, 2.2).toFixed(4)}`).join(','),
  '0 0,0.1 0.6,0.2 0.65,1 1',
];

describe('curveTable — Blender parity (curvemap_make_table + curvemap_calc_extend + BKE_curvemap_evaluateF)', () => {
  it(`the corpus is the size the spec asks for (${PARITY_CORPUS.length} curves × 2 extend modes)`, () => {
    expect(PARITY_CORPUS.length).toBeGreaterThanOrEqual(20);
  });

  for (const s of PARITY_CORPUS) {
    for (const horizontal of [false, true]) {
      it(`${s.slice(0, 48)} ${horizontal ? 'Horizontal' : 'Extrapolated'}: table within 2e-5, slopes within 1e-5`, () => {
        const pts = P(s);
        const ours = curveTable(pts, horizontal);
        const bl = blenderMakeTable(pts, !horizontal);
        for (let i = 0; i <= 256; i++) {
          // 2e-5, plus — at the two END texels only — one float32 ulp of x along the end slope: Blender's forward
          // differences land the last sample at x = 1.0000001 (measured, the 32-point sine curve), so cur_x = 1
          // takes the LERP branch instead of the "on the point" branch, and a near-vertical end (|s| = 1e4)
          // turns that 1.2e-7 of x into 4e-4 of y. A float32 artefact of Blender's, not a different curve.
          // The curve's own end slope (its handle), whatever Extend does past it.
          const geo = horizontal ? curveTable(pts, false) : ours;
          const endSlope = i === 0 ? Math.abs(geo.s0) : i === 256 ? Math.abs(geo.s1) : 0;
          expect(Math.abs(ours.table[i] - bl.table[i].y), `texel ${i}`).toBeLessThanOrEqual(2e-5 + 2 * FLT_EPSILON * endSlope);
        }
        const blSlope = (d: [number, number]): number =>
          horizontal ? 0 : d[0] !== 0 ? Math.max(-1e4, Math.min(1e4, d[1] / d[0])) : 1e4;
        expect(Math.abs(ours.s0 - blSlope(bl.extIn))).toBeLessThanOrEqual(1e-5 * Math.max(1, Math.abs(ours.s0)));
        expect(Math.abs(ours.s1 - blSlope(bl.extOut))).toBeLessThanOrEqual(1e-5 * Math.max(1, Math.abs(ours.s1)));
        // The two-stage twin's contract: past 0…1, Blender's evaluate is the table end plus the end slope.
        for (const x of [-0.5, 1.7]) {
          const s0ok = Math.abs(ours.s0) < 1e4 && bl.extIn[0] !== 0;
          const s1ok = Math.abs(ours.s1) < 1e4 && bl.extOut[0] !== 0;
          if ((x < 0 && !s0ok) || (x > 1 && !s1ok)) continue; // a vertical end: Blender adds a constant 1e4·ext
          const twin = x < 0 ? ours.table[0] + x * ours.s0 : ours.table[256] + (x - 1) * ours.s1;
          const want = blenderEvaluateF(bl, x);
          expect(Math.abs(twin - want), `x = ${x}`).toBeLessThanOrEqual(2e-5 * Math.max(1, Math.abs(want)));
        }
      });
    }
  }

  it('inside 0…1, Blender\'s evaluate is a lerp of the same table the GPU samples', () => {
    const pts = P('0 0,0.25 0.15,0.75 0.85,1 1');
    const ours = curveTable(pts, false);
    const bl = blenderMakeTable(pts, true);
    for (const x of [0, 0.1, 0.33, 0.5, 0.77, 1]) {
      const i = Math.min(Math.floor(x * 256), 255);
      const fr = x * 256 - i;
      const twin = ours.table[i] * (1 - fr) + ours.table[i + 1] * fr;
      expect(Math.abs(twin - blenderEvaluateF(bl, x))).toBeLessThanOrEqual(2e-5);
    }
  });
});

// ─── The grammar and the reader ───────────────────────────────────────────────

describe('parseCurve / formatCurve — the grammar', () => {
  it('is all-or-nothing, 2..32 records, X Y [word]', () => {
    expect(parseCurve('0 0,1 1')!.points).toEqual([{ x: 0, y: 0 }, { x: 1, y: 1 }]);
    expect(parseCurve('0 0')).toBeNull();
    expect(parseCurve(Array.from({ length: 33 }, (_, i) => `${(i / 32).toFixed(4)} 0`).join(','))).toBeNull();
    expect(parseCurve(Array.from({ length: 32 }, (_, i) => `${(i / 31).toFixed(4)} 0`).join(','))!.points).toHaveLength(32);
    expect(parseCurve('0 0,1 1,0.5')).toBeNull();
    expect(parseCurve('0 0,1 1 x y')).toBeNull();
    expect(parseCurve('0 0,1 -1')).toBeNull();
    expect(parseCurve('0 0,1 1e0')).toBeNull();
    expect(parseCurve('0 0,0x1 1')).toBeNull();
    expect(parseCurve('0 0,1 1 Auto')).toBeNull();
    expect(parseCurve('0 0,1 1 auto9')).toBeNull();
    expect(parseCurve(5)).toBeNull();
    expect(parseCurve('')).toBeNull();
    expect(parseCurve('0 0,' + ' '.repeat(1100) + '1 1')).toBeNull();
  });

  it('tolerates a third lowercase word (a future handle type), drops it and says so', () => {
    const r = parseCurve('0 0 vector,0.5 0.4 auto,1 1')!;
    expect(r.droppedHandles).toBe(true);
    expect(formatCurve(r.points)).toBe('0 0,0.5 0.4,1 1');
    expect(parseCurve('0 0,1 1')!.droppedHandles).toBe(false);
  });

  it('stable-sorts by x, clamps > 1 to 1, and formats idempotently', () => {
    const r = parseCurve('1 1,0 0,0.5 0.2,0.5 0.8')!;
    expect(r.points).toEqual([{ x: 0, y: 0 }, { x: 0.5, y: 0.2 }, { x: 0.5, y: 0.8 }, { x: 1, y: 1 }]);
    expect(formatCurve(parseCurve('0 0,1.5 2')!.points)).toBe('0 0,1 1');
    for (const s of ['0.50 0.250,1 1', '0.123456 0.98765,1 0', ' 0 0 ,  1 1']) {
      const once = formatCurve(parseCurve(s)!.points);
      expect(formatCurve(parseCurve(once)!.points)).toBe(once);
      expect(once).toMatch(/^[0-9., ]+$/);
    }
  });
});

describe('readRgbCurves — total on adversarial values', () => {
  const poison: unknown[] = [{ toString: 1 }, Symbol('s'), { [Symbol.toPrimitive]: () => { throw new Error('boom'); } }, [1], 5, null];

  it('absent / empty is identity, not rejected; extend is exactly horizontal or extrapolate', () => {
    const c = readRgbCurves(undefined);
    expect(c.identity).toBe(true);
    expect(c.rejectedChannels).toEqual([]);
    expect(c.c.canonical).toBe(IDENTITY_CURVE);
    expect(readRgbCurves({ curveC: '' }).identity).toBe(true);
    expect(readRgbCurves({ extend: 'horizontal' }).extend).toBe('horizontal');
    expect(readRgbCurves({ extend: 'Horizontal' }).extend).toBe('extrapolate');
    expect(readRgbCurves({ extend: {} }).extend).toBe('extrapolate');
  });

  it('isCurveExtend is the exact vocabulary the reader, codeToGraph and the editor all ask', () => {
    expect(['extrapolate', 'horizontal'].every(isCurveExtend)).toBe(true);
    for (const bad of ['Horizontal', 'clamp', '', '__proto__', 5, {}, undefined, null]) expect(isCurveExtend(bad)).toBe(false);
  });

  it('a present-but-unknown extend is REJECTED (announced), as Color Ramp\'s interp is; absent and both words are not', () => {
    // The explicit 'extrapolate' — what the generated code spells — reads silently, the same as absent.
    for (const ok of [undefined, 'horizontal', 'extrapolate']) expect(readRgbCurves({ extend: ok }).rejectedExtend).toBe(false);
    for (const bad of ['Horizontal', 'clamp', '', 5, {}, Symbol('e'), { toString: 1 }]) {
      const c = readRgbCurves({ extend: bad });
      expect(c).toMatchObject({ extend: 'extrapolate', rejectedExtend: true, identity: true });
      expect(c.rejectedChannels).toEqual([]);
    }
  });

  it('an over-cap curve is keyed as ONE value: two different 2 MB strings read as the SAME memo object', () => {
    const a = readRgbCurves({ curveC: '1'.repeat(2_000_000), curveR: '2'.repeat(2_000_000) });
    const b = readRgbCurves({ curveC: '3'.repeat(2_100_000), curveR: '4'.repeat(1025) });
    expect(a).toBe(b);
    expect(a.rejectedChannels).toEqual(['C', 'R']);
  });

  it('identity is all four lines AND not Horizontal (Blender\'s rule)', () => {
    expect(readRgbCurves({ extend: 'horizontal' }).identity).toBe(false);
    expect(readRgbCurves({ curveG: '0 0,0.5 0.5,1 1' }).identity).toBe(false);
    expect(readRgbCurves({ curveB: '0 0,1 1' }).identity).toBe(true);
  });

  it('a non-string or unreadable curve is the identity line, rejected, named by channel', () => {
    for (const p of poison) {
      let c!: ReturnType<typeof readRgbCurves>;
      expect(() => { c = readRgbCurves({ curveC: p, curveR: p, curveG: 'garbage', curveB: '0 0,1 1', extend: p }); }).not.toThrow();
      expect(c.rejectedChannels).toEqual(['C', 'R', 'G']);
      expect(c.c.canonical).toBe(IDENTITY_CURVE);
      expect(c.extend).toBe('extrapolate');
    }
  });

  it('points are ALWAYS the parse of the canonical (rounded) string, frozen', () => {
    const c = readRgbCurves({ curveR: '0 0.123456,1 0.98765' });
    expect(c.r.canonical).toBe('0 0.1235,1 0.9877');
    expect(c.r.points).toEqual([{ x: 0, y: 0.1235 }, { x: 1, y: 0.9877 }]);
    expect(Object.isFrozen(c) && Object.isFrozen(c.r) && Object.isFrozen(c.r.points)).toBe(true);
  });

  it('the memo returns the same object for equal strings', () => {
    expect(readRgbCurves({ curveC: '0 0,0.5 0.7,1 1' })).toBe(readRgbCurves({ curveC: '0 0,0.5 0.7,1 1' }));
  });

  it('a stored U+0000 cannot make two different nodes share a memo entry, in either read order', () => {
    // The key used to join the five raw parts with U+0000 unescaped, so each crafted pair keyed the SAME and the
    // second node read showed the first one's curves (and its price: identity 1 vs a bake).
    const pair = (y: string) => [
      { curveC: `0 0,1 ${y}\u0000s:0 0.2,1 1`, curveB: 'q' }, // C and B unreadable: identity, rejected
      { curveC: `0 0,1 ${y}`, curveR: '0 0.2,1 1', extend: 'q\u0000t:undefined' }, // readable C and R, junk extend
    ] as const;
    const [a1, b1] = pair('0.5');
    const ra = readRgbCurves(a1);
    const rb = readRgbCurves(b1);
    const [a2, b2] = pair('0.25');
    const rb2 = readRgbCurves(b2); // the other order
    const ra2 = readRgbCurves(a2);
    for (const r of [ra, ra2]) {
      expect(r).toMatchObject({ identity: true, rejectedChannels: ['C', 'B'], rejectedExtend: false });
    }
    expect(rb).toMatchObject({ identity: false, rejectedChannels: [], rejectedExtend: true });
    expect([rb.c.canonical, rb.r.canonical]).toEqual(['0 0,1 0.5', '0 0.2,1 1']);
    expect(rb2).toMatchObject({ identity: false, rejectedChannels: [], rejectedExtend: true });
    expect(rb2.c.canonical).toBe('0 0,1 0.25');
  });
});

// ─── The table, the CPU twin and the range ────────────────────────────────────

describe('curveTable — shapes', () => {
  it('identity is exactly i/256 with end slopes 1/1, and 0/0 Horizontal', () => {
    const e = curveTable(P(IDENTITY_CURVE), false);
    for (let i = 0; i <= 256; i++) expect(e.table[i]).toBeCloseTo(i / 256, 12);
    expect([e.s0, e.s1].map((v) => +v.toFixed(9))).toEqual([1, 1]);
    const h = curveTable(P(IDENTITY_CURVE), true);
    expect([h.s0, h.s1]).toEqual([0, 0]);
  });

  it('a 2-point line (0,0.2)–(1,0.8) is linear with slope 0.6 at both ends', () => {
    const t = curveTable(P('0 0.2,1 0.8'), false);
    for (let i = 0; i <= 256; i += 16) expect(t.table[i]).toBeCloseTo(0.2 + 0.6 * (i / 256), 9);
    expect(t.s0).toBeCloseTo(0.6, 9);
    expect(t.s1).toBeCloseTo(0.6, 9);
  });

  it('a symmetric S-curve is point-symmetric: f(1 − x) = 1 − f(x)', () => {
    const t = curveTable(P('0 0,0.25 0.15,0.75 0.85,1 1'), false);
    for (let i = 0; i <= 256; i++) expect(Math.abs(t.table[256 - i] - (1 - t.table[i]))).toBeLessThanOrEqual(1e-6);
  });

  it('a duplicate end x gives a finite table and |slope| ≤ 1e4', () => {
    for (const s of ['0 0,0 1,1 1', '0 0,1 0,1 1', '0.5 0,0.5 1', '0.5 0.2,0.5 0.5,0.5 0.9']) {
      const t = curveTable(P(s), false);
      expect(t.table.every(Number.isFinite), s).toBe(true);
      expect(Math.abs(t.s0) <= 1e4 && Math.abs(t.s1) <= 1e4, s).toBe(true);
    }
  });

  it('a 2000-case fuzz never throws, never yields NaN, and keeps slopes clamped', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let k = 0; k < 2000; k++) {
      const n = 2 + Math.floor(rnd() * 31);
      const pts = Array.from({ length: n }, () => ({ x: rnd() < 0.1 ? Math.round(rnd()) : +rnd().toFixed(4), y: +rnd().toFixed(4) }))
        .sort((a, b) => a.x - b.x);
      for (const horizontal of [false, true]) {
        const t = curveTable(pts, horizontal);
        expect(t.table.every(Number.isFinite)).toBe(true);
        expect(Number.isFinite(t.s0) && Math.abs(t.s0) <= 1e4 && Number.isFinite(t.s1) && Math.abs(t.s1) <= 1e4).toBe(true);
      }
    }
  });
});

describe('evalRgbCurves — the CPU twin of the two-stage expression', () => {
  it('identity returns the input untouched, HDR included', () => {
    const c = readRgbCurves({});
    expect(evalRgbCurves(c, [0.2, -0.5, 1.7], 0.3)).toEqual([0.2, -0.5, 1.7]);
  });

  it('identity + Horizontal clamps to [0,1] (the table ends, slope 0)', () => {
    const c = readRgbCurves({ extend: 'horizontal' });
    const out = evalRgbCurves(c, [-0.5, 0.5, 1.7], 1)!;
    expect(out[0]).toBe(0);
    expect(out[1]).toBeCloseTo(0.5, 3);
    expect(out[2]).toBe(1);
  });

  it('C then R/G/B, then mix toward the input by Factor', () => {
    const c = readRgbCurves({ curveC: '0 0.2,1 0.8', curveR: '0 0,1 0.5' });
    const out = evalRgbCurves(c, [0.5, 0.5, 0.5], 1)!;
    // C(0.5) = 0.5; R halves it, G/B pass.
    expect(out[0]).toBeCloseTo(0.25, 3);
    expect(out[1]).toBeCloseTo(0.5, 3);
    const half = evalRgbCurves(c, [0.5, 0.5, 0.5], 0.5)!;
    expect(half[0]).toBeCloseTo(0.375, 3);
    expect(evalRgbCurves(c, [0.5, 0.5, 0.5], 0)).toEqual([0.5, 0.5, 0.5]);
  });

  it('HDR inputs continue along the end slopes (Extrapolated)', () => {
    const c = readRgbCurves({ curveC: '0 0.2,1 0.8' });
    const out = evalRgbCurves(c, [-0.5, 1.7, 0.5], 1)!;
    expect(out[0]).toBeCloseTo(0.2 - 0.5 * 0.6, 3);
    expect(out[1]).toBeCloseTo(0.8 + 0.7 * 0.6, 3);
  });

  it('reads the HALF table the shader samples (S-curve)', () => {
    const c = readRgbCurves({ curveC: '0 0,0.25 0.15,0.75 0.85,1 1' });
    const { half } = rgbCurvesHalf(c);
    const out = evalRgbCurves(c, [0.3, 0.3, 0.3], 1)!;
    expect(out[0]).toBe(fetchHalf(half, 0, fetchHalf(half, 3, 0.3, false), false));
  });

  it('non-finite in → null', () => {
    const c = readRgbCurves({ curveC: '0 0,1 0.5' });
    expect(evalRgbCurves(c, [NaN, 0, 0], 1)).toBeNull();
    expect(evalRgbCurves(c, [0, 0, 0], Infinity)).toBeNull();
  });
});

describe('rgbCurvesRange — brackets every sample', () => {
  const CASES = [
    { v: { curveC: '0 0,0.25 0.15,0.75 0.85,1 1' }, lo: [0, 0, 0], hi: [1, 1, 1], fac: [1, 1] },
    { v: { curveC: '0 0,0.5 1,1 0', curveG: '0 1,1 0' }, lo: [-0.5, 0.2, 0.1], hi: [1.5, 0.6, 2], fac: [0, 1] },
    { v: { curveR: '0 0.2,1 0.8', extend: 'horizontal' }, lo: [-3, 0, 0], hi: [3, 1, 1], fac: [0.25, 0.75] },
    { v: { curveB: '0.2 0.3,0.4 0.1,0.6 0.9,0.8 0.7' }, lo: [0.3, 0.3, 0.3], hi: [0.35, 0.9, 0.95], fac: [1, 1] },
  ];
  for (const [n, k] of CASES.entries()) {
    it(`case ${n}: dense samples stay inside`, () => {
      const c = readRgbCurves(k.v);
      const r = rgbCurvesRange(c, k.lo, k.hi, k.fac[0], k.fac[1])!;
      expect(r).not.toBeNull();
      for (let s = 0; s <= 200; s++) {
        const t = s / 200;
        const rgb = [0, 1, 2].map((i) => k.lo[i] + (k.hi[i] - k.lo[i]) * t) as [number, number, number];
        for (const fac of [k.fac[0], (k.fac[0] + k.fac[1]) / 2, k.fac[1]]) {
          const out = evalRgbCurves(c, rgb, fac)!;
          for (let i = 0; i < 3; i++) {
            expect(out[i]).toBeGreaterThanOrEqual(r.min[i] - 1e-9);
            expect(out[i]).toBeLessThanOrEqual(r.max[i] + 1e-9);
          }
        }
      }
    });
  }

  it('an unbounded input along a non-zero slope is unknown; Horizontal bounds it', () => {
    expect(rgbCurvesRange(readRgbCurves({ curveC: '0 0.2,1 0.8' }), [-Infinity, 0, 0], [1, 1, 1], 1, 1)).toBeNull();
    const h = rgbCurvesRange(readRgbCurves({ curveC: '0 0.2,1 0.8', extend: 'horizontal' }), [-Infinity, 0, 0], [Infinity, 1, 1], 1, 1)!;
    expect(h.min[0]).toBeCloseTo(0.2, 3);
    expect(h.max[0]).toBeCloseTo(0.8, 3);
  });

  it('identity passes the input range through', () => {
    expect(rgbCurvesRange(readRgbCurves({}), [-1, 0, 2], [1, 0.5, 3], 0, 1)).toEqual({ min: [-1, 0, 2], max: [1, 0.5, 3] });
  });
});

describe('curvePath', () => {
  it('draws 65 points over the box, y flipped, clamped to [-0.25, 1.25]', () => {
    const d = curvePath(curveTable(P(IDENTITY_CURVE), false).table, 100, 100);
    const pts = d.split(/[ML]/).filter(Boolean);
    expect(pts).toHaveLength(65);
    expect(d.startsWith('M0 100')).toBe(true);
    expect(d.endsWith('L100 0')).toBe(true);
    const steep = new Float64Array(257).fill(9);
    expect(curvePath(steep, 100, 100)).toContain('L100 -25');
  });
});

// ─── Editor ops ───────────────────────────────────────────────────────────────

describe('editor ops — points never cross, caps hold', () => {
  const base = P('0 0,0.5 0.5,1 1');

  it('addPoint inserts after an equal x, rounds, and refuses at 32', () => {
    const r = addPoint(base, 0.5, 0.123456)!;
    expect(r.index).toBe(2);
    expect(r.points[2]).toEqual({ x: 0.5, y: 0.1235 });
    const full = Array.from({ length: CURVE_MAX_POINTS }, (_, i) => ({ x: i / 31, y: 0 }));
    expect(addPoint(full, 0.5, 0.5)).toBeNull();
  });

  it('movePoint clamps x between the neighbours (0/1 at the ends) and y to [0,1]', () => {
    expect(movePoint(base, 1, 2, 2)[1]).toEqual({ x: 1, y: 1 });
    expect(movePoint(base, 1, -1, -1)[1]).toEqual({ x: 0, y: 0 });
    expect(movePoint(base, 0, 0.9, 0.3)[0]).toEqual({ x: 0.5, y: 0.3 });
    expect(movePoint(base, 2, 0.1, 0.3)[2]).toEqual({ x: 0.5, y: 0.3 });
    expect(movePoint(base, 1, NaN, 0.7)[1]).toEqual({ x: 0.5, y: 0.7 });
    expect(movePoint(base, 7, 0, 0)).toEqual(base);
    // Never crosses, so formatting keeps the order (and the index) stable.
    const moved = movePoint(base, 1, 0.99, 0.2);
    expect(parseCurve(formatCurve(moved))!.points).toEqual(moved);
  });

  it('deletePoint refuses below two points or an invalid index', () => {
    expect(deletePoint(base, 1)).toEqual([{ x: 0, y: 0 }, { x: 1, y: 1 }]);
    expect(deletePoint(P(IDENTITY_CURVE), 0)).toBeNull();
    expect(deletePoint(base, 3)).toBeNull();
    expect(deletePoint(base, 0.5)).toBeNull();
  });
});
