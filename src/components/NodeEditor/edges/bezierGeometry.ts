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

/**
 * Insert a new routing waypoint `p` into `waypoints` at the position that adds
 * the least detour to the poly-line source → …waypoints… → target. Returns a new
 * array (never mutates). Ordering by minimum added length keeps a freshly-placed
 * point on the visually-correct part of the wire regardless of click order.
 */
export function insertWaypointOrdered(
  source: { x: number; y: number },
  target: { x: number; y: number },
  waypoints: Array<{ x: number; y: number }>,
  p: { x: number; y: number },
): Array<{ x: number; y: number }> {
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
  const next = waypoints.slice();
  next.splice(bestIdx, 0, { x: p.x, y: p.y });
  return next;
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
