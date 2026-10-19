import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Position } from '@xyflow/react';
import {
  bezierControlOffset,
  cardinalControlPoint,
  radialControlPoint,
  distancePointToCubicBezier,
  catmullRomToBeziers,
  splinePath,
  insertWaypointOrdered,
  distancePointToSpline,
  edgeBezier,
  bezierMarkAt,
  arrowMarks,
  chevronPath,
  visibleArcMidpoint,
  ribbonHalfWidth,
  ribbonStrokeWidth,
  RIBBON_GAP,
  ARROW_SPACING,
  ARROW_MIN_ARC,
  ARROW_MAX,
  type BezierSegment,
} from './bezierGeometry';
import * as geometry from './bezierGeometry';

describe('bezierControlOffset', () => {
  it('is half the forward distance', () => {
    expect(bezierControlOffset(200)).toBe(100);
    expect(bezierControlOffset(0)).toBe(0);
  });

  it('ramps by sqrt for a backward endpoint', () => {
    // curvature (0.25) * 25 * sqrt(100) = 6.25 * 10 = 62.5
    expect(bezierControlOffset(-100)).toBeCloseTo(62.5, 5);
  });
});

describe('cardinalControlPoint', () => {
  it('mirrors React Flow for a Right→Left edge (both controls at the x-midpoint)', () => {
    const sx = 0, sy = 0, tx = 400, ty = 120;
    const [c1x, c1y] = cardinalControlPoint(Position.Right, sx, sy, tx, ty);
    const [c2x, c2y] = cardinalControlPoint(Position.Left, tx, ty, sx, sy);
    expect([c1x, c1y]).toEqual([200, 0]); // sx + 0.5*(tx-sx), sy
    expect([c2x, c2y]).toEqual([200, 120]); // tx - 0.5*(tx-sx), ty
  });
});

describe('radialControlPoint', () => {
  it('projects the forward offset onto the radial exit vector', () => {
    // radial pointing straight right; target 200px right → offset 0.5*200 = 100
    const [cx, cy] = radialControlPoint(0, 0, 1, 0, 200, 0);
    expect([cx, cy]).toEqual([100, 0]);
  });

  it('applies the 16px floor when the target sits beside/behind the socket', () => {
    // radial points right but target is at the same x → forward offset 0 → floor 16
    const [cx, cy] = radialControlPoint(0, 0, 1, 0, 0, 50);
    expect([cx, cy]).toEqual([16, 0]);
  });

  it('honors a diagonal radial direction', () => {
    const inv = 1 / Math.SQRT2;
    const [cx, cy] = radialControlPoint(0, 0, inv, inv, 100, 100);
    // forward offset = 0.5 * ((100)*inv + (100)*inv) = 0.5 * (200*inv) ≈ 70.71
    const k = 0.5 * (100 * inv + 100 * inv);
    expect(cx).toBeCloseTo(inv * k, 5);
    expect(cy).toBeCloseTo(inv * k, 5);
  });
});

describe('distancePointToCubicBezier', () => {
  // A degenerate-but-realistic edge: a straight Right→Left hop whose whole path
  // lies on y=0 between x=0 and x=2000, so EVERY (x, 0) with x in [0,2000] is
  // exactly on the curve.
  const sx = 0, sy = 0, tx = 2000, ty = 0;
  const [c1x, c1y] = cardinalControlPoint(Position.Right, sx, sy, tx, ty);
  const [c2x, c2y] = cardinalControlPoint(Position.Left, tx, ty, sx, sy);
  const dist = (px: number, py: number) =>
    distancePointToCubicBezier(sx, sy, c1x, c1y, c2x, c2y, tx, ty, px, py);

  it('reports ~0 for a point sitting ON the middle of a long edge', () => {
    // The regression: the old fixed 21-sample scan reported ~40px here because
    // the query x fell between two coarse samples. This must now be ~0.
    expect(dist(1060, 0)).toBeLessThan(0.5);
    expect(dist(937, 0)).toBeLessThan(0.5);
  });

  it('recovers a small perpendicular offset from the curve', () => {
    expect(dist(1060, 5)).toBeGreaterThan(4.5);
    expect(dist(1060, 5)).toBeLessThan(5.5);
  });

  it('reports ~0 at the endpoints', () => {
    expect(dist(0, 0)).toBeLessThan(0.5);
    expect(dist(2000, 0)).toBeLessThan(0.5);
  });

  it('reports a large distance for a point well away from the curve', () => {
    expect(dist(1000, 400)).toBeGreaterThan(300);
  });
});

describe('catmullRomToBeziers', () => {
  it('produces one segment per gap and passes through every point', () => {
    const pts: Array<[number, number]> = [[0, 0], [100, 50], [200, 0]];
    const segs = catmullRomToBeziers(pts);
    expect(segs).toHaveLength(2);
    // Each segment starts at pts[i] and ends at pts[i+1] (interpolating spline).
    expect([segs[0][0], segs[0][1]]).toEqual([0, 0]);
    expect([segs[0][6], segs[0][7]]).toEqual([100, 50]);
    expect([segs[1][0], segs[1][1]]).toEqual([100, 50]);
    expect([segs[1][6], segs[1][7]]).toEqual([200, 0]);
  });

  it('keeps a collinear point set on the straight line', () => {
    const segs = catmullRomToBeziers([[0, 0], [1000, 0], [2000, 0]]);
    // Every control-point y stays 0 → the spline never leaves the axis.
    for (const s of segs) {
      expect(s[3]).toBe(0); // c1y
      expect(s[5]).toBe(0); // c2y
    }
  });
});

describe('splinePath', () => {
  it('is empty for fewer than two points', () => {
    expect(splinePath([])).toBe('');
    expect(splinePath([[1, 2]])).toBe('');
  });

  it('emits an M then one C per segment', () => {
    const d = splinePath([[0, 0], [10, 10], [20, 0]]);
    expect(d.startsWith('M0,0')).toBe(true);
    expect((d.match(/C/g) ?? []).length).toBe(2);
  });
});

describe('insertWaypointOrdered', () => {
  const s = { x: 0, y: 0 };
  const t = { x: 100, y: 0 };

  it('adds the first waypoint into an empty list', () => {
    expect(insertWaypointOrdered(s, t, [], { x: 50, y: 10 })).toEqual([{ x: 50, y: 10 }]);
  });

  it('orders a new point BEFORE an existing one when it sits nearer the source', () => {
    const out = insertWaypointOrdered(s, t, [{ x: 50, y: 0 }], { x: 25, y: 5 });
    expect(out).toEqual([{ x: 25, y: 5 }, { x: 50, y: 0 }]);
  });

  it('orders a new point AFTER an existing one when it sits nearer the target', () => {
    const out = insertWaypointOrdered(s, t, [{ x: 50, y: 0 }], { x: 75, y: 5 });
    expect(out).toEqual([{ x: 50, y: 0 }, { x: 75, y: 5 }]);
  });

  it('does not mutate the input array', () => {
    const wps = [{ x: 50, y: 0 }];
    insertWaypointOrdered(s, t, wps, { x: 25, y: 5 });
    expect(wps).toEqual([{ x: 50, y: 0 }]);
  });
});

describe('distancePointToSpline', () => {
  const line: Array<[number, number]> = [[0, 0], [1000, 0], [2000, 0]];

  it('reports ~0 for a point on a collinear routed spline', () => {
    expect(distancePointToSpline(line, 500, 0)).toBeLessThan(0.5);
    expect(distancePointToSpline(line, 1500, 0)).toBeLessThan(0.5);
  });

  it('reports ~0 at a waypoint (waypoints are on the curve)', () => {
    expect(distancePointToSpline(line, 1000, 0)).toBeLessThan(0.5);
  });

  it('recovers a small perpendicular offset', () => {
    expect(distancePointToSpline(line, 500, 5)).toBeGreaterThan(4.5);
    expect(distancePointToSpline(line, 500, 5)).toBeLessThan(5.5);
  });

  it('reports a large distance far from the routed path', () => {
    expect(distancePointToSpline(line, 1000, 400)).toBeGreaterThan(300);
  });
});

/* ---------------- a STILL wire's direction chevrons ---------------- */

/** A straight segment written as a cubic (controls at the thirds). */
const straight = (x0: number, y0: number, x1: number, y1: number): BezierSegment => [
  x0, y0, x0 + (x1 - x0) / 3, y0 + (y1 - y0) / 3, x0 + (2 * (x1 - x0)) / 3, y0 + (2 * (y1 - y0)) / 3, x1, y1,
];

describe('edgeBezier — the one curve the renderer, the hit test and the chevrons share', () => {
  it('is cardinal at both ends for an ordinary edge (React Flow\'s controls)', () => {
    const seg = edgeBezier(0, 0, Position.Right, 400, 120, Position.Left);
    expect(seg).toEqual([
      0, 0,
      ...cardinalControlPoint(Position.Right, 0, 0, 400, 120),
      ...cardinalControlPoint(Position.Left, 400, 120, 0, 0),
      400, 120,
    ]);
  });

  it('takes a unit RADIAL exit for a color-circle source', () => {
    const seg = edgeBezier(0, 0, [0, 1], 300, 200, Position.Left);
    expect(seg.slice(2, 4)).toEqual(radialControlPoint(0, 0, 0, 1, 300, 200));
    expect(seg.slice(4, 6)).toEqual(cardinalControlPoint(Position.Left, 300, 200, 0, 0));
  });

  it('the drop-on-edge hit test and the chevrons CALL it rather than re-deriving the controls (source pins)', () => {
    // The env is node and both callers are .tsx, so the guard reads source:
    // a hit test that picks its own control points can drift from what draws,
    // and then what highlights is no longer what snaps.
    const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
    const editor = read('../NodeEditor.tsx');
    const hit = editor.slice(editor.indexOf('function findNearestEdge('), editor.indexOf('function findContainingGroup('));
    expect(hit).toContain('edgeBezier(s.x, s.y, exit, t.x, t.y, t.position)');
    expect(hit).not.toMatch(/\b(?:cardinal|radial)ControlPoint\(/);
    expect(read('./TypedEdge.tsx')).toContain('edgeBezier(sourceX, sourceY, radial ?? sourcePosition, targetX, targetY, targetPosition)');
  });
});

describe('arrowMarks', () => {
  it('puts ONE chevron on the midpoint of a short wire, pointing source → target', () => {
    const marks = arrowMarks([straight(0, 0, 100, 0)]);
    expect(marks).toHaveLength(1);
    expect(marks[0].x).toBeCloseTo(50, 1);
    expect(marks[0].y).toBeCloseTo(0, 6);
    expect(marks[0].ux).toBeCloseTo(1, 6);
    expect(marks[0].uy).toBeCloseTo(0, 6);
  });

  it('points backwards on a wire drawn right-to-left — direction is the PARAMETER\'s, not the screen\'s', () => {
    const [m] = arrowMarks([straight(200, 0, 100, 0)]);
    expect(m.ux).toBeCloseTo(-1, 6);
  });

  it('ALWAYS draws one on a canvas wire, however short (owner, 2026-10-17)', () => {
    for (const len of [ARROW_MIN_ARC - 1, 10, 1, 0.01]) {
      const marks = arrowMarks([straight(0, 0, len, 0)]);
      expect(marks, `len ${len}`).toHaveLength(1);
      expect(marks[0].x, `len ${len}`).toBeCloseTo(len / 2, 3);
      expect(marks[0].ux, `len ${len}`).toBeCloseTo(1, 6);
    }
  });

  it('a ZERO-length wire still gets one, pointing source → target (+x), never a dot', () => {
    const [m] = arrowMarks([[5, 7, 5, 7, 5, 7, 5, 7]]);
    expect(m).toEqual({ x: 5, y: 7, ux: 1, uy: 0 });
    expect(chevronPath([m], 4)).not.toBe('');
  });

  it('a caller-given minimum (the preview link) still draws none below it', () => {
    expect(arrowMarks([straight(0, 0, ARROW_MIN_ARC - 1, 0)], ARROW_SPACING, ARROW_MIN_ARC)).toEqual([]);
    expect(arrowMarks([straight(0, 0, ARROW_MIN_ARC + 1, 0)], ARROW_SPACING, ARROW_MIN_ARC)).toHaveLength(1);
  });

  it('never throws on a non-finite endpoint', () => {
    expect(arrowMarks([straight(0, 0, Number.NaN, 0)])).toEqual([]);
    expect(arrowMarks([straight(0, 0, Infinity, 0)])).toEqual([]);
    expect(arrowMarks([])).toEqual([]);
  });

  it('keeps an ODD count, so the middle one always sits on the midpoint', () => {
    for (const len of [40, 150, 259, 261, 400, 700, 1300, 2600]) {
      const marks = arrowMarks([straight(0, 0, len, 0)]);
      expect(marks.length % 2, `len ${len}`).toBe(1);
      expect(marks[(marks.length - 1) / 2].x, `len ${len}`).toBeCloseTo(len / 2, 0);
    }
  });

  it('spaces them about ARROW_SPACING apart, evenly along the ARC LENGTH', () => {
    for (const len of [400, 700, 1300, 2600]) {
      const marks = arrowMarks([straight(0, 0, len, 0)]);
      const gap = len / marks.length;
      expect(gap, `len ${len}`).toBeGreaterThan(ARROW_SPACING * 0.66);
      expect(gap, `len ${len}`).toBeLessThan(ARROW_SPACING * 2);
      for (let i = 1; i < marks.length; i++) {
        expect(marks[i].x - marks[i - 1].x).toBeCloseTo(gap, 0);
      }
    }
  });

  it('measures arc, not parameter: a curve whose speed varies still gets even spacing', () => {
    // A backward-exit S-curve: the parameter crawls through the bends and races
    // along the straight, so equal-t marks would bunch up.
    const seg = edgeBezier(0, 0, Position.Right, -300, 500, Position.Left);
    const marks = arrowMarks([seg], 60);
    expect(marks.length).toBeGreaterThanOrEqual(5);
    const steps = marks.slice(1).map((m, i) => Math.hypot(m.x - marks[i].x, m.y - marks[i].y));
    const lo = Math.min(...steps), hi = Math.max(...steps);
    // Chords under-read arcs on the bends, so allow a little slack.
    expect(hi / lo).toBeLessThan(1.35);
  });

  it('walks a waypoint spline across its segment seams', () => {
    const segs = [straight(0, 0, 300, 0), straight(300, 0, 300, 300)];
    const marks = arrowMarks(segs, 100);
    // 600 px of arc at ~100 px → an odd count, the middle one on the seam corner.
    expect(marks.length % 2).toBe(1);
    const mid = marks[(marks.length - 1) / 2];
    expect(mid.x).toBeCloseTo(300, 0);
    expect(mid.y).toBeCloseTo(0, 0);
    // Marks past the seam follow the SECOND segment downwards.
    const last = marks[marks.length - 1];
    expect(last.x).toBeCloseTo(300, 3);
    expect(last.uy).toBeCloseTo(1, 3);
  });

  it('caps the count at ARROW_MAX however long the wire — a hostile length is a hang otherwise', () => {
    // Restored node positions need only be FINITE and waypoints may span
    // ±1e6, so a `.fastshader` can make ONE wire astronomically long. Uncapped,
    // a node at x = 1e12 asked a single render for ~8e9 chevrons.
    expect(ARROW_MAX % 2).toBe(1);
    for (const len of [1e5, 1e6, 1e12, 1e300]) {
      const t0 = performance.now();
      const marks = arrowMarks([straight(0, 0, len, 0)]);
      expect(marks, `len ${len}`).toHaveLength(ARROW_MAX);
      // Still evenly spread, the middle one still on the midpoint.
      expect(marks[(ARROW_MAX - 1) / 2].x / len, `len ${len}`).toBeCloseTo(0.5, 6);
      expect(performance.now() - t0, `len ${len}`).toBeLessThan(250);
    }
    // 64 waypoints zig-zagging across the whole sanitized box (edgeExtras).
    const pts: Array<[number, number]> = [[0, 0]];
    for (let i = 0; i < 64; i++) pts.push(i % 2 ? [1e6, -1e6] : [-1e6, 1e6]);
    pts.push([0, 0]);
    expect(arrowMarks(catmullRomToBeziers(pts))).toHaveLength(ARROW_MAX);
    // A degenerate spacing lands on the cap or on nothing — never in the loop.
    expect(arrowMarks([straight(0, 0, 400, 0)], 0)).toHaveLength(ARROW_MAX);
    expect(arrowMarks([straight(0, 0, 400, 0)], Number.NaN)).toEqual([]);
  });

  it('falls back to the chord where the derivative vanishes', () => {
    const seg: BezierSegment = [0, 0, 0, 0, 100, 0, 100, 0];
    expect(bezierMarkAt(seg, 0).ux).toBeCloseTo(1, 6);
  });
});

describe('chevronPath', () => {
  it('writes every chevron as one subpath of ONE path — the element count does not grow with them', () => {
    const marks = arrowMarks([straight(0, 0, 800, 0)]);
    const d = chevronPath(marks, 4);
    expect(d.match(/M/g)).toHaveLength(marks.length);
    expect(d.match(/L/g)).toHaveLength(marks.length * 2);
    expect(chevronPath([], 4)).toBe('');
  });

  it('opens BEHIND the mark and points AHEAD of it along the tangent', () => {
    const d = chevronPath([{ x: 10, y: 20, ux: 1, uy: 0 }], 4, 6);
    // arm (7, 24) → tip (13, 20) → arm (7, 16)
    expect(d).toBe('M7,24L13,20L7,16');
  });
});

describe('ribbon geometry', () => {
  it('half-width covers the outer line\'s own stroke', () => {
    expect(ribbonHalfWidth(1)).toBeCloseTo(ribbonStrokeWidth(1) / 2, 9);
    expect(ribbonHalfWidth(4)).toBeCloseTo(1.5 * RIBBON_GAP + ribbonStrokeWidth(4) / 2, 9);
    for (let c = 2; c <= 4; c++) expect(ribbonHalfWidth(c)).toBeGreaterThan(ribbonHalfWidth(c - 1));
  });

  it('retires the ribbon dash — it never rendered (React Flow\'s CSS dash beat the attribute)', () => {
    expect('RIBBON_DASH' in geometry).toBe(false);
  });
});

describe('visibleArcMidpoint — the value chip sits mid-wire AS SEEN', () => {
  // A straight wire 0 → 1000 along y = 0, drawn as a cubic.
  const line: BezierSegment = [0, 0, 333, 0, 667, 0, 1000, 0];
  const close = (p: [number, number] | null, x: number, y = 0) => {
    expect(p).not.toBeNull();
    expect(p![0]).toBeCloseTo(x, 0);
    expect(p![1]).toBeCloseTo(y, 0);
  };

  it('a wire wholly on screen gets its plain arc midpoint', () => {
    close(visibleArcMidpoint([line], { x0: -100, y0: -100, x1: 2000, y1: 100 }), 500);
    close(visibleArcMidpoint([line], null), 500);
  });

  it('a wire running off-screen anchors in the middle of the VISIBLE stretch', () => {
    // Only x ∈ [600, 1000] on screen → middle at 800.
    close(visibleArcMidpoint([line], { x0: 600, y0: -50, x1: 1400, y1: 50 }), 800);
    // Both ends off-screen → middle of the window.
    close(visibleArcMidpoint([line], { x0: 100, y0: -50, x1: 300, y1: 50 }), 200);
  });

  it('a wire that leaves and comes back lands ON a visible stretch', () => {
    // A V: down to (500, 500) and back up; the view shows only the top band.
    const v = catmullRomToBeziers([[0, 0], [500, 500], [1000, 0]]);
    const m = visibleArcMidpoint(v, { x0: -10, y0: -10, x1: 1010, y1: 100 });
    expect(m).not.toBeNull();
    expect(m![1]).toBeLessThanOrEqual(100.001);
  });

  it('null when nothing is on screen, for a non-finite chain, or an empty one', () => {
    expect(visibleArcMidpoint([line], { x0: 0, y0: 500, x1: 1000, y1: 900 })).toBeNull();
    expect(visibleArcMidpoint([[0, 0, NaN, 0, 1, 0, 2, 0]], null)).toBeNull();
    expect(visibleArcMidpoint([], null)).toBeNull();
  });

  it('an unmeasured (empty) view clips nothing', () => {
    close(visibleArcMidpoint([line], { x0: 0, y0: 0, x1: 0, y1: 0 }), 500);
  });
});
