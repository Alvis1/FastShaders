/**
 * Pure geometry for the Node Designer's glyph editor: rotation about a pivot,
 * exact Bézier subdivision (the "add a point" gesture), nearest-point-on-segment
 * (which segment did the user click?), and freehand stroke simplification.
 *
 * Pure and import-free so the vitest node env can cover it — `designerApp.ts` is
 * @ts-nocheck vanilla with no other automated coverage, and every property that
 * makes these correct is arithmetic: a rotation preserves distance to its pivot,
 * a subdivision leaves the drawn curve bit-identical, a simplified stroke stays
 * inside its tolerance. `socketScale.ts` is the precedent.
 */

export interface Pt { x: number; y: number }

/** 2-decimal rounding — the same "fine" grid `r2` uses in designerApp.ts. */
function n2(v: number): number { return Math.round(v * 100) / 100; }

/* ------------------------------------------------------------------ rotation */

/**
 * Rotate a point about a pivot. `cos`/`sin` are passed in rather than an angle
 * because a rotate gesture applies ONE angle to every selected point: computing
 * the pair once keeps the whole selection on exactly the same rotation (two
 * `Math.cos` calls on the same double are equal, but the intent matters — this is
 * one transform, not N).
 */
export function rotatePt(x: number, y: number, cx: number, cy: number, cos: number, sin: number): Pt {
  const dx = x - cx, dy = y - cy;
  return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
}

/** Signed angle in (−180, 180] — what a rotation readout should show. */
export function normalizeDeg(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d === 0 ? 0 : d;                      // fold -0 so the readout never shows "-0°"
}

/**
 * Snap a rotation to a multiple of `step` degrees.
 *
 * 15° rather than the drag gesture's 30/45 families (`ANGLE_LOCK`): those describe
 * a DIRECTION to travel along and 30/45 are the useful ones; a rotation wants the
 * finer clock face, and 15 is a superset that still lands exactly on 30, 45, 60
 * and 90.
 */
export function snapDeg(deg: number, step = 15): number {
  if (!Number.isFinite(deg) || !(step > 0)) return normalizeDeg(deg);
  return normalizeDeg(Math.round(deg / step) * step);
}

/**
 * Compose a rotation ON TOP of an element's existing `transform`.
 *
 * WHY THIS EXISTS. A `<rect>` is axis-aligned by construction and an `<ellipse>`'s
 * rx/ry are its axes, so rotating their point COORDINATES cannot express a
 * rotation — it just moves the corners, which reads as the shape being resized
 * and skewed. Those elements are rotated by transform instead, and the rotate is
 * PREPENDED so it applies in the element's PARENT space (where the pivot is
 * measured), after whatever the element already does to itself.
 *
 * The caller must pass the element's ORIGINAL transform each frame and the
 * gesture's TOTAL angle — never the last frame's output and a delta, which would
 * accumulate a new rotate() per pointermove and drift on rounding.
 */
export function rotateTransform(original: string | null, deg: number, px: number, py: number): string {
  const rot = 'rotate(' + n2(normalizeDeg(deg)) + ' ' + n2(px) + ' ' + n2(py) + ')';
  const prev = (original || '').trim();
  if (!prev) return rot;
  /* FOLD a leading rotate() about the SAME pivot instead of stacking another one
     on top. Two rotations about one point are one rotation, and the keyboard path
     re-reads the live attribute on every press — so without this, ⌥→ held for a
     second left `rotate(1 …) rotate(1 …) rotate(1 …) …` thirty deep in a 56×56
     glyph's source. A drag is unaffected either way (it always composes from the
     ORIGINAL attribute), which is why this had to be fixed here rather than at
     the call site. */
  const m = /^rotate\(\s*(-?[\d.]+)[\s,]+(-?[\d.]+)[\s,]+(-?[\d.]+)\s*\)\s*/.exec(prev);
  if (m && n2(parseFloat(m[2])) === n2(px) && n2(parseFloat(m[3])) === n2(py)) {
    const total = normalizeDeg(parseFloat(m[1]) + normalizeDeg(deg));
    const rest = prev.slice(m[0].length).trim();
    const folded = 'rotate(' + n2(total) + ' ' + n2(px) + ' ' + n2(py) + ')';
    return rest ? folded + ' ' + rest : folded;
  }
  return rot + ' ' + prev;
}

/* -------------------------------------------------- Bézier evaluate & split */

function lerp(a: Pt, b: Pt, t: number): Pt { return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }; }

export function evalCubic(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
  const u = 1 - t, uu = u * u, tt = t * t;
  return {
    x: uu * u * p0.x + 3 * uu * t * p1.x + 3 * u * tt * p2.x + tt * t * p3.x,
    y: uu * u * p0.y + 3 * uu * t * p1.y + 3 * u * tt * p2.y + tt * t * p3.y,
  };
}

export function evalQuad(p0: Pt, p1: Pt, p2: Pt, t: number): Pt {
  const u = 1 - t;
  return { x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x, y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y };
}

/**
 * de Casteljau split of a cubic at `t`. The two halves draw EXACTLY the curve the
 * original did — that is the whole point of "add a point": the user gets a handle
 * where there wasn't one and the picture does not move. A naive split (dropping a
 * point on the curve and straightening either side) would silently reshape the
 * art, which on a 56px glyph is the difference between a smile and a crease.
 */
export function splitCubic(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): { left: Pt[]; right: Pt[] } {
  const a = lerp(p0, p1, t), b = lerp(p1, p2, t), c = lerp(p2, p3, t);
  const d = lerp(a, b, t), e = lerp(b, c, t);
  const f = lerp(d, e, t);
  return { left: [p0, a, d, f], right: [f, e, c, p3] };
}

/** de Casteljau split of a quadratic at `t` — same exactness guarantee. */
export function splitQuad(p0: Pt, p1: Pt, p2: Pt, t: number): { left: Pt[]; right: Pt[] } {
  const a = lerp(p0, p1, t), b = lerp(p1, p2, t);
  const c = lerp(a, b, t);
  return { left: [p0, a, c], right: [c, b, p2] };
}

/* ------------------------------------------------------------- hit testing */

/** Nearest point on the segment a→b to p, with the parameter and squared distance. */
export function projectOnSegment(p: Pt, a: Pt, b: Pt): { t: number; x: number; y: number; d2: number } {
  const vx = b.x - a.x, vy = b.y - a.y;
  const len2 = vx * vx + vy * vy;
  let t = len2 > 1e-12 ? ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const x = a.x + vx * t, y = a.y + vy * t;
  const dx = p.x - x, dy = p.y - y;
  return { t: t, x: x, y: y, d2: dx * dx + dy * dy };
}

/**
 * Nearest point on a cubic/quadratic to p: a coarse sample followed by a local
 * bisection refinement. Analytic root-finding on a quintic buys nothing here —
 * the canvas is 56 units across and rendered at 5px per unit, so ~0.002 units is
 * already three orders of magnitude finer than a pixel.
 */
export function nearestOnCurve(p: Pt, pts: Pt[], samples = 24, refine = 20): { t: number; x: number; y: number; d2: number } {
  const at = (t: number) => (pts.length === 4 ? evalCubic(pts[0], pts[1], pts[2], pts[3], t) : evalQuad(pts[0], pts[1], pts[2], t));
  const d2 = (q: Pt) => (p.x - q.x) * (p.x - q.x) + (p.y - q.y) * (p.y - q.y);
  let bt = 0, bq = at(0), bd = d2(bq);
  for (let i = 1; i <= samples; i++) {
    const t = i / samples, q = at(t), d = d2(q);
    if (d < bd) { bd = d; bt = t; bq = q; }
  }
  let lo = Math.max(0, bt - 1 / samples), hi = Math.min(1, bt + 1 / samples);
  for (let i = 0; i < refine; i++) {
    const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
    if (d2(at(m1)) < d2(at(m2))) hi = m2; else lo = m1;
  }
  const t = (lo + hi) / 2, q = at(t), d = d2(q);
  if (d < bd) { bd = d; bt = t; bq = q; }
  return { t: bt, x: bq.x, y: bq.y, d2: bd };
}

/* -------------------------------------------------------------- freehand */

/**
 * Ramer–Douglas–Peucker. A freehand drag delivers a pointer sample per frame —
 * 60+ points for a stroke that wants five — and every one of those becomes a
 * draggable handle in an editor capped at 240 of them. Simplification is
 * therefore not polish, it is what makes the output EDITABLE.
 *
 * Iterative rather than recursive: a pathological stroke should not be able to
 * blow the JS stack from a gesture the user cannot see the size of.
 */
export function simplifyRdp(pts: Pt[], tol: number): Pt[] {
  const n = pts.length;
  if (n <= 2) return pts.slice();
  const keep = new Uint8Array(n);
  keep[0] = 1; keep[n - 1] = 1;
  const stack: Array<[number, number]> = [[0, n - 1]];
  const tol2 = tol * tol;
  while (stack.length) {
    const [lo, hi] = stack.pop() as [number, number];
    if (hi <= lo + 1) continue;
    let far = -1, fd = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = projectOnSegment(pts[i], pts[lo], pts[hi]).d2;
      if (d > fd) { fd = d; far = i; }
    }
    if (far < 0 || fd <= tol2) continue;
    keep[far] = 1;
    stack.push([lo, far], [far, hi]);
  }
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) { if (keep[i]) out.push(pts[i]); }
  return out;
}

/**
 * Catmull-Rom through the given points, emitted as cubic path data.
 *
 * Catmull-Rom rather than a least-squares Bézier fit because it INTERPOLATES: the
 * curve passes through every point the simplifier kept, so what the user drew is
 * where the anchors are and dragging one moves the curve there. A fit would put
 * the anchors somewhere the user never pressed.
 */
export function freehandPathData(pts: Pt[], closed = false): string {
  const p = pts.filter((q) => Number.isFinite(q.x) && Number.isFinite(q.y));
  if (p.length < 2) return '';
  if (p.length === 2) return 'M ' + n2(p[0].x) + ' ' + n2(p[0].y) + ' L ' + n2(p[1].x) + ' ' + n2(p[1].y);
  const at = (i: number) => p[i < 0 ? (closed ? p.length + i : 0) : i >= p.length ? (closed ? i - p.length : p.length - 1) : i];
  let d = 'M ' + n2(p[0].x) + ' ' + n2(p[0].y);
  const last = closed ? p.length : p.length - 1;
  for (let i = 0; i < last; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    d += ' C ' + n2(c1.x) + ' ' + n2(c1.y) + ' ' + n2(c2.x) + ' ' + n2(c2.y) + ' ' + n2(p2.x) + ' ' + n2(p2.y);
  }
  return closed ? d + ' Z' : d;
}

/** One pen anchor: a point plus its OUT handle, as an offset. (0,0) = a corner. */
export interface PenAnchor { x: number; y: number; hx: number; hy: number }

/**
 * Pen-tool anchors → path data.
 *
 * Handles are stored as the OUT offset only and the IN handle is its mirror, so
 * an anchor is always smooth — which is what dragging one handle in every pen
 * tool does. A segment whose two ends are both corners emits `L`, not a cubic
 * with coincident controls: the shipped corpus is 43 `L` to 2 `C`, and a straight
 * run written as curves gives the point editor four handles where it should have
 * two.
 */
export function penPathData(anchors: PenAnchor[], closed = false): string {
  const a = anchors.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (a.length < 2) return '';
  const n2s = (v: number) => n2(v);
  let d = 'M ' + n2s(a[0].x) + ' ' + n2s(a[0].y);
  const seg = (p: PenAnchor, q: PenAnchor) => {
    const straight = !p.hx && !p.hy && !q.hx && !q.hy;
    if (straight) return ' L ' + n2s(q.x) + ' ' + n2s(q.y);
    return ' C ' + n2s(p.x + p.hx) + ' ' + n2s(p.y + p.hy)
      + ' ' + n2s(q.x - q.hx) + ' ' + n2s(q.y - q.hy)
      + ' ' + n2s(q.x) + ' ' + n2s(q.y);
  };
  for (let i = 1; i < a.length; i++) d += seg(a[i - 1], a[i]);
  if (closed && a.length > 2) d += seg(a[a.length - 1], a[0]) + ' Z';
  return d;
}

/**
 * Should a freehand stroke close? Only when the user came back to where they
 * started — a deliberate loop, not a stroke that happens to end nearby. The
 * threshold is generous in view units (the canvas is 56 wide) because a pointer
 * drag on a 280px canvas is coarse.
 */
export function shouldCloseStroke(pts: Pt[], tol = 2.5): boolean {
  if (pts.length < 4) return false;
  const a = pts[0], b = pts[pts.length - 1];
  return Math.hypot(a.x - b.x, a.y - b.y) <= tol;
}
