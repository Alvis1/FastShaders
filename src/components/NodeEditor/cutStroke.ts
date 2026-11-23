/**
 * The CUT STROKE's geometry (Alt/⌥ + drag on empty canvas or a wire, or the
 * draw toolbar's scissors): does a freehand polyline cross a wire's DRAWN
 * centreline? Pure and DOM-free; `edgeHit.ts` (`edgesCrossedByStroke`) builds
 * each wire's curve exactly as the drop-on-edge hit test does and asks here.
 * docs/dev/canvas-interaction.md, "Cut stroke".
 *
 * Every input is bounded: the stroke is capped at `MAX_CUT_POINTS`, a wire's
 * routing points at the restore cap, and a cubic is never flattened past
 * `MAX_SUBDIVISION_DEPTH` or `MAX_SUBCURVES` pieces, so neither a wire a
 * million units long nor one doubling back on itself can stall a release.
 */
import type { BezierSegment } from './edges/bezierGeometry';

export type Pt = { x: number; y: number };

/** Movement (SCREEN px) before an Alt press becomes a stroke: below it the
 *  press stays today's Alt+click (a wire delete, Preview on a node). The
 *  wire's own drag-disconnect threshold (TypedEdge), so one press cannot be a
 *  click to one handler and a drag to the other. */
export const CUT_CLICK_SLOP_PX = 5;

/** Screen distance between kept stroke samples — the ink's decimation. */
export const CUT_SAMPLE_PX = 2;

/** Points per stroke. 2 px apart, this is a line 2,000+ px long: a sweep
 *  across the whole canvas; later moves are dropped, never the early ones. */
export const MAX_CUT_POINTS = 1024;

/** Stroke points per bounding run: the second level of the rejection. */
const RUN = 16;

/** De Casteljau halvings per cubic, at most: 2^-20 of a curve 10^6 long is
 *  under one flow unit, so the cap is never what decides a real crossing. */
const MAX_SUBDIVISION_DEPTH = 20;

/** Sub-curves examined per WIRE, across all its segments; past it the
 *  remaining pieces are tested as their chords (still exact for a straight
 *  one, never a hang for an adversarial one). */
const MAX_SUBCURVES = 4096;

interface Box { x0: number; y0: number; x1: number; y1: number }

/** A stroke readied for many crossing tests: finite points, its box, and one
 *  box per run of `RUN` segments. Null when fewer than two usable points. */
export interface PreparedStroke {
  readonly pts: readonly Pt[];
  readonly box: Box;
  readonly runs: readonly { box: Box; from: number; to: number }[];
}

const finitePt = (p: Pt | null | undefined): p is Pt =>
  !!p && Number.isFinite(p.x) && Number.isFinite(p.y);

function boxOf(pts: readonly Pt[], from: number, to: number): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = from; i <= to; i++) {
    const p = pts[i];
    if (p.x < x0) x0 = p.x;
    if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.y > y1) y1 = p.y;
  }
  return { x0, y0, x1, y1 };
}

const overlaps = (a: Box, b: Box) => a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;

/** Prepare a stroke: non-finite points dropped, consecutive duplicates
 *  folded, capped at `MAX_CUT_POINTS`. */
export function prepareStroke(raw: readonly Pt[]): PreparedStroke | null {
  const pts: Pt[] = [];
  for (const p of raw) {
    if (pts.length >= MAX_CUT_POINTS) break;
    if (!finitePt(p)) continue;
    const last = pts[pts.length - 1];
    if (last && last.x === p.x && last.y === p.y) continue;
    pts.push({ x: p.x, y: p.y });
  }
  if (pts.length < 2) return null;
  const runs: { box: Box; from: number; to: number }[] = [];
  for (let from = 0; from < pts.length - 1; from += RUN) {
    const to = Math.min(from + RUN, pts.length - 1);
    runs.push({ box: boxOf(pts, from, to), from, to });
  }
  return { pts, box: boxOf(pts, 0, pts.length - 1), runs };
}

/** Sign of the turn a→b→c: >0 left, <0 right, 0 collinear. */
function orient(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  const v = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  return v > 0 ? 1 : v < 0 ? -1 : 0;
}

/** Is collinear c within a–b's box? */
function within(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): boolean {
  return Math.min(ax, bx) <= cx && cx <= Math.max(ax, bx) && Math.min(ay, by) <= cy && cy <= Math.max(ay, by);
}

/** Do the closed segments a–b and c–d meet (touching counts)? */
export function segmentsIntersect(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): boolean {
  const o1 = orient(ax, ay, bx, by, cx, cy);
  const o2 = orient(ax, ay, bx, by, dx, dy);
  const o3 = orient(cx, cy, dx, dy, ax, ay);
  const o4 = orient(cx, cy, dx, dy, bx, by);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && within(ax, ay, bx, by, cx, cy)) return true;
  if (o2 === 0 && within(ax, ay, bx, by, dx, dy)) return true;
  if (o3 === 0 && within(cx, cy, dx, dy, ax, ay)) return true;
  if (o4 === 0 && within(cx, cy, dx, dy, bx, by)) return true;
  return false;
}

/** Does the chord a–b cross the stroke? Box-rejected per run, then per segment. */
function chordCrossesStroke(s: PreparedStroke, ax: number, ay: number, bx: number, by: number): boolean {
  const cb: Box = { x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by) };
  if (!overlaps(cb, s.box)) return false;
  for (const run of s.runs) {
    if (!overlaps(cb, run.box)) continue;
    for (let i = run.from; i < run.to; i++) {
      const p = s.pts[i], q = s.pts[i + 1];
      if (Math.max(p.x, q.x) < cb.x0 || Math.min(p.x, q.x) > cb.x1
        || Math.max(p.y, q.y) < cb.y0 || Math.min(p.y, q.y) > cb.y1) continue;
      if (segmentsIntersect(ax, ay, bx, by, p.x, p.y, q.x, q.y)) return true;
    }
  }
  return false;
}

/** Could anything inside `b` touch the stroke? Its box, then a run's. */
function nearStroke(s: PreparedStroke, b: Box): boolean {
  if (!overlaps(b, s.box)) return false;
  for (const run of s.runs) if (overlaps(b, run.box)) return true;
  return false;
}

/**
 * Does the stroke cross any of a wire's cubic segments? Each cubic is halved
 * (de Casteljau) only where its CONTROL HULL — which contains the curve — can
 * touch the stroke, until a piece is flat to within `tol` (flow units), and
 * that piece is then tested as its chord. So the work follows the crossing,
 * not the wire's length.
 */
export function strokeCrossesSegments(
  stroke: PreparedStroke,
  segs: readonly BezierSegment[],
  tol: number,
): boolean {
  // A tolerance that is not a positive finite number is the cap's job.
  const t = Number.isFinite(tol) && tol > 0 ? tol : 0.5;
  const flat16 = 16 * t * t;
  let budget = MAX_SUBCURVES;
  const stack: { c: BezierSegment; depth: number }[] = [];
  for (const seg of segs) {
    if (!seg || seg.length !== 8 || !seg.every(Number.isFinite)) continue;
    stack.length = 0;
    stack.push({ c: seg, depth: 0 });
    while (stack.length) {
      const { c, depth } = stack.pop()!;
      const [x0, y0, x1, y1, x2, y2, x3, y3] = c;
      const hull: Box = {
        x0: Math.min(x0, x1, x2, x3), y0: Math.min(y0, y1, y2, y3),
        x1: Math.max(x0, x1, x2, x3), y1: Math.max(y0, y1, y2, y3),
      };
      if (!nearStroke(stroke, hull)) continue;
      budget--;
      // Flatness (Willcocks): the control points' worst deviation from the
      // chord's own thirds, squared, is at most 16·tol² when flat.
      const ux = 3 * x1 - 2 * x0 - x3, uy = 3 * y1 - 2 * y0 - y3;
      const vx = 3 * x2 - x0 - 2 * x3, vy = 3 * y2 - y0 - 2 * y3;
      const flat = Math.max(ux * ux, vx * vx) + Math.max(uy * uy, vy * vy) <= flat16;
      if (flat || depth >= MAX_SUBDIVISION_DEPTH || budget <= 0) {
        if (chordCrossesStroke(stroke, x0, y0, x3, y3)) return true;
        continue;
      }
      const ax = (x0 + x1) / 2, ay = (y0 + y1) / 2;
      const bx = (x1 + x2) / 2, by = (y1 + y2) / 2;
      const cx = (x2 + x3) / 2, cy = (y2 + y3) / 2;
      const dx = (ax + bx) / 2, dy = (ay + by) / 2;
      const ex = (bx + cx) / 2, ey = (by + cy) / 2;
      const mx = (dx + ex) / 2, my = (dy + ey) / 2;
      stack.push({ c: [mx, my, ex, ey, cx, cy, x3, y3], depth: depth + 1 });
      stack.push({ c: [x0, y0, ax, ay, dx, dy, mx, my], depth: depth + 1 });
    }
  }
  return false;
}
