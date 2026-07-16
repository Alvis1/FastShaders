import { describe, it, expect } from 'vitest';
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
} from './bezierGeometry';

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
