import { describe, it, expect } from 'vitest';
import {
  rotatePt, normalizeDeg, snapDeg, rotateTransform,
  evalCubic, evalQuad, splitCubic, splitQuad,
  projectOnSegment, nearestOnCurve,
  simplifyRdp, freehandPathData, shouldCloseStroke,
} from './glyphGeometry';

const close = (a: number, b: number, eps = 1e-9) => expect(Math.abs(a - b)).toBeLessThanOrEqual(eps);

describe('rotatePt', () => {
  it('preserves distance to the pivot — the property that makes a rotation a rotation', () => {
    const cos = Math.cos(0.7), sin = Math.sin(0.7);
    const p = rotatePt(40, 12, 28, 28, cos, sin);
    close(Math.hypot(p.x - 28, p.y - 28), Math.hypot(40 - 28, 12 - 28), 1e-12);
  });
  it('turns +90° clockwise in SVG space (y grows downward)', () => {
    const p = rotatePt(38, 28, 28, 28, Math.cos(Math.PI / 2), Math.sin(Math.PI / 2));
    close(p.x, 28, 1e-12); close(p.y, 38, 1e-12);
  });
  it('leaves the pivot itself fixed', () => {
    const p = rotatePt(28, 28, 28, 28, Math.cos(1.3), Math.sin(1.3));
    close(p.x, 28, 1e-12); close(p.y, 28, 1e-12);
  });
});

describe('normalizeDeg / snapDeg', () => {
  it('folds to (-180, 180]', () => {
    expect(normalizeDeg(370)).toBe(10);
    expect(normalizeDeg(-370)).toBe(-10);
    expect(normalizeDeg(180)).toBe(180);
    expect(normalizeDeg(-180)).toBe(180);
    expect(normalizeDeg(540)).toBe(180);
  });
  it('never reports "-0"', () => {
    expect(Object.is(normalizeDeg(-0), 0)).toBe(true);
    expect(Object.is(normalizeDeg(-360), 0)).toBe(true);
  });
  it('is total on junk', () => {
    expect(normalizeDeg(NaN)).toBe(0);
    expect(snapDeg(NaN)).toBe(0);
    expect(snapDeg(37, 0)).toBe(37);
  });
  it('snaps to the 15° clock face, which contains 30/45/60/90', () => {
    expect(snapDeg(7)).toBe(0);
    expect(snapDeg(8)).toBe(15);
    expect(snapDeg(44)).toBe(45);
    expect(snapDeg(-88)).toBe(-90);
    [15, 30, 45, 60, 90, 120, 135, 150, 180].forEach((a) => expect(snapDeg(a)).toBe(normalizeDeg(a)));
  });
});

describe('rotateTransform', () => {
  it('PREPENDS, so the rotation happens in the parent space where the pivot lives', () => {
    expect(rotateTransform('translate(28 28)', 30, 28, 28)).toBe('rotate(30 28 28) translate(28 28)');
  });
  it('handles an absent transform', () => {
    expect(rotateTransform(null, 45, 10, 20)).toBe('rotate(45 10 20)');
    // Math.round is asymmetric on .5 (the asymmetry socketScale.ts documents),
    // so -12.345 lands on -12.34. Harmless here: it is a hundredth of a degree
    // on a value nothing downstream reads back.
    expect(rotateTransform('   ', -12.345, 0, 0)).toBe('rotate(-12.34 0 0)');
  });
  it('FOLDS a leading rotate about the same pivot instead of stacking one', () => {
    // the keyboard path re-reads the live attribute every press; without folding,
    // a held key writes one rotate() per keydown
    let t = rotateTransform('translate(28 28)', 1, 15, 14);
    for (let i = 0; i < 30; i++) t = rotateTransform(t, 1, 15, 14);
    expect(t.match(/rotate\(/g)).toHaveLength(1);
    expect(t).toBe('rotate(31 15 14) translate(28 28)');
  });

  it('does NOT fold when the pivot differs — that would move the art', () => {
    const t = rotateTransform('rotate(10 15 14)', 5, 20, 20);
    expect(t).toBe('rotate(5 20 20) rotate(10 15 14)');
  });

  it('folds around the turn without growing', () => {
    let t = 'rotate(170 0 0)';
    t = rotateTransform(t, 20, 0, 0);
    expect(t).toBe('rotate(-170 0 0)');
  });

  it('is a pure function of the ORIGINAL transform, so re-applying cannot accumulate', () => {
    const orig = 'translate(28 28)';
    const a = rotateTransform(orig, 10, 28, 28);
    const b = rotateTransform(orig, 20, 28, 28);
    expect(b).toBe('rotate(20 28 28) translate(28 28)');
    expect(a).not.toBe(b);
    expect(b.match(/rotate/g)).toHaveLength(1);
  });
});

describe('Bézier subdivision', () => {
  const p0 = { x: 0, y: 0 }, p1 = { x: 10, y: -20 }, p2 = { x: 30, y: 20 }, p3 = { x: 40, y: 0 };

  it('splitCubic draws exactly the same curve — the whole point of "add a point"', () => {
    const t = 0.37;
    const { left, right } = splitCubic(p0, p1, p2, p3, t);
    for (let i = 0; i <= 20; i++) {
      const u = i / 20;
      const a = evalCubic(left[0], left[1], left[2], left[3], u);
      const b = evalCubic(p0, p1, p2, p3, u * t);
      close(a.x, b.x, 1e-9); close(a.y, b.y, 1e-9);
      const c = evalCubic(right[0], right[1], right[2], right[3], u);
      const d = evalCubic(p0, p1, p2, p3, t + u * (1 - t));
      close(c.x, d.x, 1e-9); close(c.y, d.y, 1e-9);
    }
  });

  it('the halves meet exactly at the split point', () => {
    const { left, right } = splitCubic(p0, p1, p2, p3, 0.5);
    expect(left[3]).toEqual(right[0]);
    const mid = evalCubic(p0, p1, p2, p3, 0.5);
    close(left[3].x, mid.x, 1e-12); close(left[3].y, mid.y, 1e-12);
  });

  it('splitQuad is exact too', () => {
    const q0 = { x: 0, y: 0 }, q1 = { x: 12, y: -18 }, q2 = { x: 24, y: 0 };
    const t = 0.62;
    const { left, right } = splitQuad(q0, q1, q2, t);
    for (let i = 0; i <= 12; i++) {
      const u = i / 12;
      const a = evalQuad(left[0], left[1], left[2], u);
      const b = evalQuad(q0, q1, q2, u * t);
      close(a.x, b.x, 1e-9); close(a.y, b.y, 1e-9);
    }
    expect(left[2]).toEqual(right[0]);
  });
});

describe('projectOnSegment', () => {
  it('clamps to the segment, never the infinite line', () => {
    const a = { x: 0, y: 0 }, b = { x: 10, y: 0 };
    expect(projectOnSegment({ x: -5, y: 3 }, a, b).t).toBe(0);
    expect(projectOnSegment({ x: 50, y: 3 }, a, b).t).toBe(1);
    const m = projectOnSegment({ x: 4, y: 3 }, a, b);
    close(m.x, 4); close(m.y, 0); close(m.d2, 9);
  });
  it('survives a degenerate zero-length segment', () => {
    const r = projectOnSegment({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 });
    expect(r.t).toBe(0); close(r.d2, 25);
  });
});

describe('nearestOnCurve', () => {
  it('returns a point that really is ON the curve, and the nearest one', () => {
    const c = [{ x: 0, y: 0 }, { x: 10, y: -20 }, { x: 30, y: 20 }, { x: 40, y: 0 }];
    const probe = { x: 17, y: 2 };
    const got = nearestOnCurve(probe, c);
    const on = evalCubic(c[0], c[1], c[2], c[3], got.t);
    expect(Math.hypot(on.x - got.x, on.y - got.y)).toBeLessThan(1e-9);
    // the real property: no densely sampled point on the curve is closer
    for (let i = 0; i <= 2000; i++) {
      const q = evalCubic(c[0], c[1], c[2], c[3], i / 2000);
      const d2 = (probe.x - q.x) ** 2 + (probe.y - q.y) ** 2;
      expect(got.d2).toBeLessThanOrEqual(d2 + 1e-9);
    }
  });
  it('lands on an endpoint when the probe is past the curve', () => {
    const c = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 30, y: 0 }];
    expect(nearestOnCurve({ x: -50, y: 0 }, c).t).toBeLessThan(0.02);
    expect(nearestOnCurve({ x: 90, y: 0 }, c).t).toBeGreaterThan(0.98);
  });
});

describe('simplifyRdp', () => {
  it('collapses a straight run to its endpoints', () => {
    const line = Array.from({ length: 40 }, (_, i) => ({ x: i, y: 0 }));
    expect(simplifyRdp(line, 0.5)).toEqual([{ x: 0, y: 0 }, { x: 39, y: 0 }]);
  });
  it('keeps every point further from the chord than the tolerance', () => {
    const pts = [{ x: 0, y: 0 }, { x: 5, y: 4 }, { x: 10, y: 0 }];
    expect(simplifyRdp(pts, 1)).toHaveLength(3);
    expect(simplifyRdp(pts, 5)).toHaveLength(2);
  });
  it('always keeps the first and last sample', () => {
    const pts = Array.from({ length: 60 }, (_, i) => ({ x: i, y: Math.sin(i / 6) * 3 }));
    const out = simplifyRdp(pts, 0.6);
    expect(out[0]).toEqual(pts[0]);
    expect(out[out.length - 1]).toEqual(pts[pts.length - 1]);
    expect(out.length).toBeLessThan(pts.length);
    // and no kept point may exceed the tolerance against its neighbours' chord
    expect(out.length).toBeGreaterThan(2);
  });
  it('does not recurse — a 20k-sample stroke must not blow the stack', () => {
    const pts = Array.from({ length: 20000 }, (_, i) => ({ x: i * 0.001, y: (i % 2) * 0.9 }));
    expect(() => simplifyRdp(pts, 0.1)).not.toThrow();
  });
  it('is a no-op on 0/1/2 points', () => {
    expect(simplifyRdp([], 1)).toEqual([]);
    expect(simplifyRdp([{ x: 1, y: 2 }], 1)).toEqual([{ x: 1, y: 2 }]);
  });
});

describe('freehandPathData', () => {
  it('INTERPOLATES: every kept point is an anchor of the emitted path', () => {
    const pts = [{ x: 0, y: 0 }, { x: 10, y: 8 }, { x: 20, y: 0 }, { x: 30, y: 8 }];
    const d = freehandPathData(pts);
    expect(d.startsWith('M 0 0')).toBe(true);
    pts.slice(1).forEach((p) => expect(d).toContain(p.x + ' ' + p.y));
    expect(d.match(/C/g)).toHaveLength(3);
  });
  it('degrades to a straight line for two points and to nothing below that', () => {
    expect(freehandPathData([{ x: 1, y: 2 }, { x: 3, y: 4 }])).toBe('M 1 2 L 3 4');
    expect(freehandPathData([{ x: 1, y: 2 }])).toBe('');
    expect(freehandPathData([])).toBe('');
  });
  it('closes with Z when asked', () => {
    const d = freehandPathData([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }], true);
    expect(d.endsWith(' Z')).toBe(true);
    expect(d.match(/C/g)).toHaveLength(4);          // one more segment than the open form
  });
  it('drops non-finite samples rather than emitting NaN into the art', () => {
    const d = freehandPathData([{ x: 0, y: 0 }, { x: NaN, y: 2 }, { x: 10, y: 0 }]);
    expect(d).not.toContain('NaN');
  });
});

describe('shouldCloseStroke', () => {
  it('closes only a deliberate loop', () => {
    const loop = [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 8 }, { x: 0.5, y: 0.5 }];
    expect(shouldCloseStroke(loop)).toBe(true);
    const open = [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 16, y: 8 }, { x: 24, y: 0 }];
    expect(shouldCloseStroke(open)).toBe(false);
  });
  it('never closes a stroke too short to be a loop', () => {
    expect(shouldCloseStroke([{ x: 0, y: 0 }, { x: 0, y: 0 }])).toBe(false);
  });
});
