import { Position } from '@xyflow/react';

/**
 * Shared geometry for React Flow's default bezier edges. Single source of truth
 * for the control-point math so the RENDERED edge (TypedEdge) and the
 * drop-on-edge hit test (NodeEditor's findNearestEdge) agree exactly — if the
 * two drifted, a node could highlight an edge it wouldn't actually snap onto,
 * or snap onto one that never highlighted.
 */

/** React Flow's default bezier curvature (getBezierPath's `curvature`). */
export const BEZIER_CURVATURE = 0.25;

/** The multi-channel RIBBON, shared by the canvas wire (TypedEdge) and the
 *  Node Designer's edge stubs: the gap between channel lines and the stroke
 *  width per channel count. (The old `4 0.5` ribbon dash never rendered on the
 *  canvas: React Flow's `.animated` 5px dash is CSS and beat the attribute.) */
export const RIBBON_GAP = 3.5 / 3;
export function ribbonStrokeWidth(count: number): number {
  return count >= 4 ? 0.8 : count >= 3 ? 1 : count >= 2 ? 1.2 : 1.5;
}

/** Half the drawn width of a `count`-channel ribbon, outer line edge included. */
export function ribbonHalfWidth(count: number): number {
  return ((count - 1) / 2) * RIBBON_GAP + ribbonStrokeWidth(count) / 2;
}

/** Each channel line's perpendicular offset from the centreline, RIBBON_GAP
 *  apart and centred (TypedEdge and the intro window's wires). */
export function ribbonOffsets(count: number): number[] {
  if (count <= 1) return [0];
  const offsets: number[] = [];
  const half = (count - 1) / 2;
  for (let i = 0; i < count; i++) {
    offsets.push((i - half) * RIBBON_GAP);
  }
  return offsets;
}

/** The unit vector the offsets run along: perpendicular to source → target. */
export function ribbonNormal(sx: number, sy: number, tx: number, ty: number): [number, number] {
  const dx = tx - sx;
  const dy = ty - sy;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  return [-dy / len, dx / len];
}

/**
 * React Flow's control-handle length for one side of a bezier edge: half the
 * FORWARD distance along that side's exit axis, or a slow sqrt ramp when the
 * other endpoint is behind it. Mirrors @xyflow/system's calculateControlOffset
 * — using the straight-line distance instead blows the handle up on short
 * near-perpendicular hops and hairpins the curve right before the input socket.
 */
export function bezierControlOffset(distance: number): number {
  return distance >= 0 ? 0.5 * distance : BEZIER_CURVATURE * 25 * Math.sqrt(-distance);
}

/**
 * Source-side control point for a color-circle (radial-exit) edge, matching
 * TypedEdge's getRadialBezierPath. `(rx,ry)` is the unit radial exit vector
 * (circle center → handle center); the control length is React Flow's forward
 * offset projected onto that radial, with the same 16px floor so a perpendicular
 * exit stays readable. Keeping this here (shared with the renderer) is what lets
 * the drop-on-edge hit test agree with the drawn color edge.
 */
export function radialControlPoint(
  sx: number, sy: number,
  rx: number, ry: number,
  tx: number, ty: number,
): [number, number] {
  const k = Math.max(bezierControlOffset((tx - sx) * rx + (ty - sy) * ry), 16);
  return [sx + rx * k, sy + ry * k];
}

/**
 * One control point of a cardinal cubic-bezier edge, matching React Flow's
 * getControlWithCurvature. `(x1,y1)` is the endpoint this control belongs to,
 * `(x2,y2)` the opposite endpoint, `pos` the side the handle exits.
 */
export function cardinalControlPoint(
  pos: Position,
  x1: number, y1: number,
  x2: number, y2: number,
): [number, number] {
  switch (pos) {
    case Position.Left:   return [x1 - bezierControlOffset(x1 - x2), y1];
    case Position.Right:  return [x1 + bezierControlOffset(x2 - x1), y1];
    case Position.Top:    return [x1, y1 - bezierControlOffset(y1 - y2)];
    case Position.Bottom: return [x1, y1 + bezierControlOffset(y2 - y1)];
    default:              return [x1, y1];
  }
}

/** One cubic bezier segment as a flat tuple [p0x,p0y, c1x,c1y, c2x,c2y, p3x,p3y]. */
export type BezierSegment = [number, number, number, number, number, number, number, number];

/**
 * The cubic a waypoint-free edge draws: the target always enters along its
 * cardinal side; the source leaves along its cardinal side, or along a unit
 * RADIAL `[rx, ry]` (a color-circle source). The same two control points
 * React Flow's getBezierPath and TypedEdge's radial path use.
 */
export function edgeBezier(
  sx: number, sy: number,
  exit: Position | readonly [number, number],
  tx: number, ty: number,
  targetPosition: Position,
): BezierSegment {
  const [c1x, c1y] = typeof exit === 'string'
    ? cardinalControlPoint(exit, sx, sy, tx, ty)
    : radialControlPoint(sx, sy, exit[0], exit[1], tx, ty);
  const [c2x, c2y] = cardinalControlPoint(targetPosition, tx, ty, sx, sy);
  return [sx, sy, c1x, c1y, c2x, c2y, tx, ty];
}

/* ---------------- direction chevrons (a STILL wire's arrows) ---------------- */

/** Flow px of arc per chevron, roughly — the count is rounded to an ODD number
 *  so one always sits on the midpoint and the rest pair off around it. */
export const ARROW_SPACING = 130;
/** The shortest arc the Output→preview LINK puts a chevron on (scaled to its
 *  own arrow size, previewLinkGeometry.ts). Canvas wires have NO minimum: every
 *  still wire carries at least one, even at zero length (owner, 2026-10-17) —
 *  a wire whose direction you cannot read is the thing the chevrons exist to
 *  prevent, and two nodes butted together are exactly where it goes unread. */
export const ARROW_MIN_ARC = 36;
/** How far a chevron's arms reach past the ribbon's own edge, each side. */
export const ARROW_FLARE = 2.75;
/** The most chevrons ONE wire carries, however long — odd, so the midpoint
 *  rule holds; past it the spacing simply grows. Wire length is adversarial:
 *  a restored node position need only be FINITE (graphShape) and a waypoint
 *  may sit anywhere in ±1e6 (edgeExtras), so uncapped a hostile `.fastshader`
 *  asked ONE render for millions of chevrons (64 waypoints inside the
 *  sanitized box: 1.4M; a node at x = 1e12: ~8e9, a loop that never ends) —
 *  a hung tab that the autosave brings back on every reload. 63 still spaces
 *  an 8,000 px wire at ARROW_SPACING. */
export const ARROW_MAX = 63;

/** A chevron's anchor: a point on the curve and the unit tangent there,
 *  pointing source → target. */
export interface ArrowMark { x: number; y: number; ux: number; uy: number }

/** Chords per segment for the arc-length table. 16 keeps the spacing within
 *  a pixel or two on any edge the canvas draws, and costs nothing. */
const ARC_STEPS = 16;

/** Derivative of one axis of a cubic bezier at t (unnormalized). */
function cubicSlope(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const mt = 1 - t;
  return 3 * mt * mt * (p1 - p0) + 6 * mt * t * (p2 - p1) + 3 * t * t * (p3 - p2);
}

/** Point and unit tangent of one segment at parameter t. A vanishing
 *  derivative (a control point sitting on its endpoint) falls back to the
 *  chord, so the mark still points somewhere sensible; a segment with NO
 *  length at all (two sockets on one spot) points +x, source → target, the way
 *  a wire leaves an output socket on a node's right edge. */
export function bezierMarkAt(seg: BezierSegment, t: number): ArrowMark {
  const [p0x, p0y, c1x, c1y, c2x, c2y, p3x, p3y] = seg;
  const x = cubicAt(p0x, c1x, c2x, p3x, t);
  const y = cubicAt(p0y, c1y, c2y, p3y, t);
  let dx = cubicSlope(p0x, c1x, c2x, p3x, t);
  let dy = cubicSlope(p0y, c1y, c2y, p3y, t);
  let len = Math.hypot(dx, dy);
  if (!(len > 1e-9)) { dx = p3x - p0x; dy = p3y - p0y; len = Math.hypot(dx, dy); }
  if (!(len > 1e-9)) return { x, y, ux: 1, uy: 0 };
  return { x, y, ux: dx / len, uy: dy / len };
}

/**
 * Where a still wire's chevrons go: evenly along the ARC LENGTH of the chain
 * `segs` (one segment, or a waypoint spline's several), an odd count about
 * `spacing` apart so the middle one always sits on the midpoint, none on an
 * arc shorter than `minArc`, and never more than ARROW_MAX. `minArc` defaults
 * to 0 — a canvas wire ALWAYS carries one, even at zero length; only the
 * preview link passes a minimum. Never throws: a non-finite endpoint yields [].
 */
export function arrowMarks(
  segs: readonly BezierSegment[],
  spacing: number = ARROW_SPACING,
  minArc: number = 0,
): ArrowMark[] {
  // No curve, no mark — and with `minArc` 0 an empty chain would otherwise
  // pass the length test and index a segment that is not there (a throw in
  // render blanks the app).
  if (segs.length === 0) return [];
  // Cumulative chord length at the end of every chord, segment after segment.
  const cum: number[] = [];
  let total = 0;
  for (const [p0x, p0y, c1x, c1y, c2x, c2y, p3x, p3y] of segs) {
    let px = p0x, py = p0y;
    for (let i = 1; i <= ARC_STEPS; i++) {
      const t = i / ARC_STEPS;
      const x = cubicAt(p0x, c1x, c2x, p3x, t);
      const y = cubicAt(p0y, c1y, c2y, p3y, t);
      total += Math.hypot(x - px, y - py);
      cum.push(total);
      px = x; py = y;
    }
  }
  if (!(total >= minArc) || !Number.isFinite(total)) return [];
  // Both operands odd, so the min is too. (A huge or infinite quotient — a
  // hostile length, a zero spacing — lands on the cap, never in the loop.)
  const n = Math.min(ARROW_MAX, 2 * Math.max(0, Math.round((total / spacing - 1) / 2)) + 1);
  const marks: ArrowMark[] = [];
  let j = 0;
  for (let k = 0; k < n; k++) {
    const s = (total * (k + 0.5)) / n;
    while (j < cum.length - 1 && cum[j] < s) j++;
    // A chord starts where the previous one ended — across a segment seam too.
    const before = j === 0 ? 0 : cum[j - 1];
    const within = cum[j] > before ? (s - before) / (cum[j] - before) : 0;
    const seg = Math.floor(j / ARC_STEPS);
    const t = ((j % ARC_STEPS) + Math.min(Math.max(within, 0), 1)) / ARC_STEPS;
    marks.push(bezierMarkAt(segs[seg], t));
  }
  return marks;
}

/**
 * ONE path `d` holding every chevron as its own subpath: an open `>` centred
 * on each mark, its tip `depth / 2` ahead along the tangent and its arms
 * `half` to either side `depth / 2` behind. One element per wire, however
 * many chevrons it carries.
 */
export function chevronPath(marks: readonly ArrowMark[], half: number, depth: number = half): string {
  const r = (v: number) => Math.round(v * 100) / 100;
  const a = depth / 2;
  let d = '';
  for (const { x, y, ux, uy } of marks) {
    const bx = x - ux * a, by = y - uy * a;
    d += `M${r(bx - uy * half)},${r(by + ux * half)}L${r(x + ux * a)},${r(y + uy * a)}L${r(bx + uy * half)},${r(by - ux * half)}`;
  }
  return d;
}

/* ---------------- the value chip's anchor ---------------- */

/** An axis-aligned box in flow coordinates: the part of the canvas on screen. */
export interface FlowRect { x0: number; y0: number; x1: number; y1: number }

/** Chords per segment for the visible-midpoint walk — finer than ARC_STEPS
 *  because the clip is per chord, so a coarse chord would snap the chip a few
 *  px as the wire slides past the viewport edge. */
const MID_STEPS = 32;

/**
 * Where a selected wire's value chip sits: the arc-length MIDPOINT of the part
 * of the chain `segs` that lies inside `view` — the middle of the wire as the
 * user sees it, not of the whole curve, so a wire running off-screen keeps its
 * chip in view. A wire wholly inside `view` gets its plain arc midpoint. Each
 * chord is clipped to the box (Liang–Barsky) and the walk advances only along
 * the clipped pieces, so the result always lies ON a visible stretch, even for
 * a wire that leaves the screen and comes back. A `view` that is null or empty
 * (React Flow not measured yet) clips nothing. Null when no part of the wire is
 * on screen, or for a non-finite chain. Never throws.
 */
export function visibleArcMidpoint(
  segs: readonly BezierSegment[],
  view: FlowRect | null,
): [number, number] | null {
  const clip = view && view.x1 > view.x0 && view.y1 > view.y0 ? view : null;
  // Visible pieces as [ax, ay, bx, by, length].
  const pieces: Array<[number, number, number, number, number]> = [];
  let total = 0;
  for (const [p0x, p0y, c1x, c1y, c2x, c2y, p3x, p3y] of segs) {
    let px = p0x, py = p0y;
    for (let i = 1; i <= MID_STEPS; i++) {
      const t = i / MID_STEPS;
      const x = cubicAt(p0x, c1x, c2x, p3x, t);
      const y = cubicAt(p0y, c1y, c2y, p3y, t);
      const piece = clip ? clipChord(px, py, x, y, clip) : [px, py, x, y] as const;
      if (piece) {
        const len = Math.hypot(piece[2] - piece[0], piece[3] - piece[1]);
        if (len > 0) { pieces.push([piece[0], piece[1], piece[2], piece[3], len]); total += len; }
      }
      px = x; py = y;
    }
  }
  if (!(total > 0) || !Number.isFinite(total)) return null;
  let s = total / 2;
  for (const [ax, ay, bx, by, len] of pieces) {
    if (s <= len) {
      const f = s / len;
      return [ax + (bx - ax) * f, ay + (by - ay) * f];
    }
    s -= len;
  }
  const last = pieces[pieces.length - 1];
  return [last[2], last[3]];
}

/** The part of the chord a→b inside `r`, or null when it misses the box. */
function clipChord(
  ax: number, ay: number, bx: number, by: number, r: FlowRect,
): readonly [number, number, number, number] | null {
  const dx = bx - ax, dy = by - ay;
  let t0 = 0, t1 = 1;
  const p = [-dx, dx, -dy, dy];
  const q = [ax - r.x0, r.x1 - ax, ay - r.y0, r.y1 - ay];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return null;
      continue;
    }
    const u = q[i] / p[i];
    if (p[i] < 0) { if (u > t1) return null; if (u > t0) t0 = u; }
    else { if (u < t0) return null; if (u < t1) t1 = u; }
  }
  return [ax + dx * t0, ay + dy * t0, ax + dx * t1, ay + dy * t1];
}

/**
 * Convert a poly-line of points into a chain of smooth cubic bezier segments
 * using a (clamped) Catmull-Rom spline: the curve passes THROUGH every point,
 * with tangents derived from each point's neighbours. End tangents clamp to the
 * end point (duplicated), so the spline starts/ends without overshoot. Used for
 * edges routed through user waypoints — shared by the renderer (TypedEdge) and
 * the drop-on-edge hit test so what highlights is exactly what the wire draws.
 */
export function catmullRomToBeziers(pts: Array<[number, number]>): BezierSegment[] {
  const segs: BezierSegment[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? pts[i + 1];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    segs.push([p1[0], p1[1], c1x, c1y, c2x, c2y, p2[0], p2[1]]);
  }
  return segs;
}

/** SVG path `d` for a Catmull-Rom spline through `pts` (>= 2 points). */
export function splinePath(pts: Array<[number, number]>): string {
  if (pts.length < 2) return '';
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (const [, , c1x, c1y, c2x, c2y, px, py] of catmullRomToBeziers(pts)) {
    d += ` C${c1x},${c1y} ${c2x},${c2y} ${px},${py}`;
  }
  return d;
}

function hypot(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

type Pt = { x: number; y: number };

/**
 * Where in `waypoints` a new point `p` belongs: the index that adds the least
 * detour to the poly-line source → …waypoints… → target.
 */
function waypointInsertIndex(source: Pt, target: Pt, waypoints: readonly Pt[], p: Pt): number {
  const pts = [source, ...waypoints, target];
  let bestIdx = 0;
  let bestCost = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const detour = hypot(a, p) + hypot(p, b) - hypot(a, b);
    if (detour < bestCost) {
      bestCost = detour;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/**
 * Insert a new routing waypoint `p` into `waypoints` at the position that adds
 * the least detour to the poly-line source → …waypoints… → target. Returns a new
 * array (never mutates). Ordering by minimum added length keeps a freshly-placed
 * point on the visually-correct part of the wire regardless of click order.
 */
export function insertWaypointOrdered(
  source: Pt,
  target: Pt,
  waypoints: Array<Pt>,
  p: Pt,
): Array<Pt> {
  const next = waypoints.slice();
  next.splice(waypointInsertIndex(source, target, waypoints, p), 0, { x: p.x, y: p.y });
  return next;
}

/**
 * Share one wire's routing points between the two halves a node spliced onto it
 * leaves behind. The node's `center` sits at the position it would take as a
 * waypoint, so what lies before it stays with the source half and what lies
 * after goes with the target half. Points within `radius` of the node are
 * DISSOLVED — they would sit under the card or kink the new wires into it —
 * and every other point is kept exactly. Never mutates.
 */
export function splitWaypointsAtNode(
  source: Pt,
  target: Pt,
  waypoints: readonly Pt[],
  center: Pt,
  radius: number,
): { before: Pt[]; after: Pt[] } {
  const k = waypointInsertIndex(source, target, waypoints, center);
  const far = (w: Pt) => hypot(w, center) > radius;
  return { before: waypoints.slice(0, k).filter(far), after: waypoints.slice(k).filter(far) };
}

/** Minimum distance from (px,py) to a Catmull-Rom spline through `pts`. */
export function distancePointToSpline(
  pts: Array<[number, number]>,
  px: number,
  py: number,
): number {
  let best = Infinity;
  for (const [p0x, p0y, c1x, c1y, c2x, c2y, p3x, p3y] of catmullRomToBeziers(pts)) {
    const d = distancePointToCubicBezier(p0x, p0y, c1x, c1y, c2x, c2y, p3x, p3y, px, py);
    if (d < best) best = d;
  }
  return best;
}

/** Evaluate one axis of a cubic bezier at parameter t. */
function cubicAt(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const mt = 1 - t;
  return mt * mt * mt * p0 + 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t * p3;
}

/**
 * Minimum distance from point (px,py) to the cubic bezier
 * (sx,sy) → c1 → c2 → (tx,ty). A coarse scan brackets the nearest parameter,
 * then successive refinement passes zoom in around the best sample — so the
 * reported distance stays within a fraction of a pixel of the true minimum
 * regardless of the edge's arc length. (The old fixed 21-point scan reported
 * distances up to ~half the sample spacing too large on long edges — tens of
 * px on a big edge — which, against a small snap radius, caused the
 * intermittent "doesn't detect the edge" misses.)
 */
export function distancePointToCubicBezier(
  sx: number, sy: number,
  c1x: number, c1y: number,
  c2x: number, c2y: number,
  tx: number, ty: number,
  px: number, py: number,
): number {
  const dist2 = (t: number): number => {
    const bx = cubicAt(sx, c1x, c2x, tx, t);
    const by = cubicAt(sy, c1y, c2y, ty, t);
    const dx = bx - px;
    const dy = by - py;
    return dx * dx + dy * dy;
  };

  const COARSE = 30;
  let bestT = 0;
  let bestD2 = Infinity;
  for (let i = 0; i <= COARSE; i++) {
    const t = i / COARSE;
    const d2 = dist2(t);
    if (d2 < bestD2) { bestD2 = d2; bestT = t; }
  }

  // Zoom in around the best parameter a few times; each pass shrinks the
  // bracket by ~6×, so resolution is effectively arc-length-independent.
  let step = 1 / COARSE;
  const REFINE_PASSES = 3;
  const FINE = 12;
  for (let pass = 0; pass < REFINE_PASSES; pass++) {
    const lo = Math.max(0, bestT - step);
    const hi = Math.min(1, bestT + step);
    for (let i = 0; i <= FINE; i++) {
      const t = lo + ((hi - lo) * i) / FINE;
      const d2 = dist2(t);
      if (d2 < bestD2) { bestD2 = d2; bestT = t; }
    }
    step = (hi - lo) / FINE;
  }

  return Math.sqrt(bestD2);
}
