import { describe, it, expect } from 'vitest';
import {
  distanceToLink,
  linkControlPoints,
  linkPath,
  pickLinkAt,
  rectCenter,
  LINK_HIT_RADIUS,
  type LinkWire,
  type RectLike,
} from './previewLinkGeometry';

const rect = (left: number, top: number, right: number, bottom: number): RectLike => ({
  left, top, right, bottom,
});

/**
 * Read the curve back out of the DRAWN `d`. The same-curve pin below must
 * sample what `linkPath` actually wrote, never what `linkControlPoints`
 * returns — sampling the control points would test the hit test against
 * itself and pass with the two describing different curves.
 */
const parsePath = (d: string) => {
  const n = d.replace('M', '').replace('C', '').trim().split(/\s+/).map(Number);
  return { sx: n[0], sy: n[1], c1x: n[2], c1y: n[3], c2x: n[4], c2y: n[5], ex: n[6], ey: n[7] };
};

const cubicAt = (a: number, b: number, c: number, d: number, t: number): number => {
  const mt = 1 - t;
  return mt * mt * mt * a + 3 * mt * mt * t * b + 3 * mt * t * t * c + t * t * t * d;
};

describe('previewLinkGeometry', () => {
  describe('rectCenter', () => {
    it('returns the midpoint of a rect', () => {
      expect(rectCenter(rect(10, 20, 30, 60))).toEqual({ x: 20, y: 40 });
    });
  });

  describe('off-pane start (the Output node panned out of view)', () => {
    // The wire is deliberately NOT hidden when the Output node leaves the
    // canvas pane (see PreviewLink); the pane clips it instead. So the curve
    // must stay well-formed for start points far outside the visible box.
    it('keeps a finite, correctly-anchored curve for a start far off-screen', () => {
      const d = linkPath({ x: -4000, y: -2500 }, { x: 900, y: 400 });
      expect(d.startsWith('M -4000 -2500')).toBe(true);
      expect(d.endsWith('900 400')).toBe(true);
      expect(d).not.toMatch(/NaN|Infinity/);
    });

    it('still bows toward the preview when the node is off-screen to the RIGHT', () => {
      // dx < 0: control handles must flip sign, or the curve doubles back.
      const d = linkPath({ x: 3000, y: 200 }, { x: 900, y: 400 });
      const nums = d.match(/-?\d+(\.\d+)?/g)!.map(Number);
      const [sx, , c1x] = nums;
      expect(c1x).toBeLessThan(sx);
      expect(d).not.toMatch(/NaN|Infinity/);
    });
  });

  describe('linkPath', () => {
    it('starts at the start point and ends at the end point', () => {
      const d = linkPath({ x: 100, y: 200 }, { x: 500, y: 400 });
      expect(d.startsWith('M 100 200 ')).toBe(true);
      expect(d.endsWith(' 500 400')).toBe(true);
      expect(d).toContain('C');
    });

    it('bows the control handles outward along the horizontal span', () => {
      // start left of end: c1x > start.x, c2x < end.x (parse the C command)
      const d = linkPath({ x: 100, y: 0 }, { x: 500, y: 0 });
      const nums = d.replace('M', '').replace('C', '').trim().split(/\s+/).map(Number);
      // M sx sy  C c1x c1y c2x c2y  ex ey
      const [sx, , c1x, , c2x, , ex] = nums;
      expect(c1x).toBeGreaterThan(sx);
      expect(c2x).toBeLessThan(ex);
    });

    it('keeps a minimum handle reach for near-vertical links', () => {
      // dx = 0 → reach floors at 40, so handles still push out from the line.
      const d = linkPath({ x: 300, y: 0 }, { x: 300, y: 400 });
      const nums = d.replace('M', '').replace('C', '').trim().split(/\s+/).map(Number);
      const [, , c1x] = nums;
      expect(c1x).toBe(340);
    });

    it('draws through the control points linkControlPoints reports', () => {
      // The two must not drift: the wire is hit-tested by arithmetic on these
      // control points, so a divergence makes it clickable where nothing is
      // drawn (and inert where it is).
      const start = { x: 120, y: 80 };
      const end = { x: 640, y: 420 };
      const { c1, c2 } = linkControlPoints(start, end);
      const p = parsePath(linkPath(start, end));
      expect([p.c1x, p.c1y, p.c2x, p.c2y]).toEqual([c1.x, c1.y, c2.x, c2.y]);
    });
  });

  describe('distanceToLink (the wire hit test)', () => {
    // The wire cannot be hit-tested by the DOM: `.preview-link` is a z-index -1
    // sibling of `.react-flow__renderer`, a stacking context wrapping the
    // hit-testable pane, so no pointer-events value reaches it without lifting
    // it over every node card; and isPointInStroke falls through the wire's own
    // stroke-dasharray gaps. So these numbers are the whole mechanism.

    it('reports ~0 for points sampled off the DRAWN path', () => {
      const start = { x: 120, y: 80 };
      const end = { x: 640, y: 420 };
      const p = parsePath(linkPath(start, end));

      let worst = 0;
      for (let i = 0; i <= 10; i++) {
        const t = i / 10;
        const x = cubicAt(p.sx, p.c1x, p.c2x, p.ex, t);
        const y = cubicAt(p.sy, p.c1y, p.c2y, p.ey, t);
        worst = Math.max(worst, distanceToLink(start, end, x, y));
      }
      // Sub-pixel: the path rounds to 2dp, and the solver refines past that.
      // A drifted control point would land this in the tens of px.
      expect(worst).toBeLessThan(0.5);
    });

    it('measures a real distance rather than always answering 0', () => {
      // A horizontal link is the exactly-known case: c1y = c2y = start.y, so
      // the curve IS the segment y=0, and a point 20px above the midpoint is
      // exactly 20px away.
      const start = { x: 0, y: 0 };
      const end = { x: 400, y: 0 };
      expect(distanceToLink(start, end, 200, 0)).toBeLessThan(0.5);
      expect(distanceToLink(start, end, 200, 20)).toBeCloseTo(20, 1);
      expect(distanceToLink(start, end, 200, -35)).toBeCloseTo(35, 1);
    });

    it('grows monotonically with the offset, so one hit radius is a real threshold', () => {
      const start = { x: 0, y: 0 };
      const end = { x: 400, y: 0 };
      const offsets = [0, 4, 8, 12, 24, 48, 96];
      const measured = offsets.map((o) => distanceToLink(start, end, 200, o));
      for (let i = 1; i < measured.length; i++) {
        expect(measured[i]).toBeGreaterThan(measured[i - 1]);
      }
    });

    it('stays finite for a start panned far off-screen', () => {
      // PreviewLink deliberately does not hide the wire when the Output node
      // leaves the pane; the pane clips it. The hit test must not blow up.
      const d = distanceToLink({ x: -4000, y: -2500 }, { x: 900, y: 400 }, 500, 300);
      expect(Number.isFinite(d)).toBe(true);
      expect(d).toBeGreaterThanOrEqual(0);
    });

    it('handles a near-vertical link, where the reach floors at 40', () => {
      const start = { x: 300, y: 0 };
      const end = { x: 300, y: 400 };
      const p = parsePath(linkPath(start, end));
      const x = cubicAt(p.sx, p.c1x, p.c2x, p.ex, 0.5);
      const y = cubicAt(p.sy, p.c1y, p.c2y, p.ey, 0.5);
      expect(distanceToLink(start, end, x, y)).toBeLessThan(0.5);

      // The bow is real, and it is NOT measurable at the midpoint: this
      // S-curve crosses its own chord at t=0.5 (symmetric handles), so the
      // midpoint sits exactly on the straight line. It has pushed ~11px off
      // by t=0.25, which is where a chord-based hit test would miss the wire.
      const x25 = cubicAt(p.sx, p.c1x, p.c2x, p.ex, 0.25);
      const y25 = cubicAt(p.sy, p.c1y, p.c2y, p.ey, 0.25);
      expect(x25).toBeGreaterThan(305);
      expect(distanceToLink(start, end, 300, y25)).toBeGreaterThan(3);
    });
  });

  describe('pickLinkAt (which wire the pointer is on)', () => {
    // Every wire ends at the same point — the preview's centre — so the wires
    // of a multi-material document FAN IN and cross each other constantly.
    // These are the numbers behind both the hover highlight and the pane
    // click, and they have to agree, or a wire lights up and answers about a
    // different node.
    const wire = (id: string, sy: number): LinkWire => ({
      id,
      label: id,
      start: { x: 0, y: sy },
      end: { x: 600, y: 300 },
    });
    const a = wire('a', 0);
    const b = wire('b', 300);
    const c = wire('c', 600);

    it('answers null with no wires, and null past the radius', () => {
      expect(pickLinkAt([], 0, 0)).toBeNull();
      // b is the exactly-known case: start and end share y=300, so the curve
      // IS the segment y=300 and the distance is the vertical offset.
      expect(pickLinkAt([b], 300, 300)?.wire.id).toBe('b');
      expect(pickLinkAt([b], 300, 300 + LINK_HIT_RADIUS - 1)?.wire.id).toBe('b');
      expect(pickLinkAt([b], 300, 300 + LINK_HIT_RADIUS + 1)).toBeNull();
    });

    it('the radius is a real threshold, swept', () => {
      // Monotone in the offset (distanceToLink's own pin), so one radius is a
      // clean in/out boundary rather than a band with holes in it.
      for (const off of [0, 3, 6, 9, 11, 12]) {
        expect(pickLinkAt([b], 300, 300 + off), `offset ${off}`).not.toBeNull();
      }
      for (const off of [13, 16, 24, 48, 200]) {
        expect(pickLinkAt([b], 300, 300 + off), `offset ${off}`).toBeNull();
      }
      // A caller may widen or narrow it; the default is LINK_HIT_RADIUS.
      expect(pickLinkAt([b], 300, 340, 50)?.wire.id).toBe('b');
      expect(pickLinkAt([b], 300, 304, 2)).toBeNull();
    });

    it('picks the NEAREST, not the first in the list', () => {
      // Two wires within the radius of one point: array order is emit order,
      // so first-wins would light up whichever Output happened to be earlier.
      const near = { x: 300, y: 300 };
      const da = distanceToLink(a.start, a.end, near.x, near.y);
      const db = distanceToLink(b.start, b.end, near.x, near.y);
      expect(db).toBeLessThan(da);
      expect(pickLinkAt([a, b], near.x, near.y)?.wire.id).toBe('b');
      expect(pickLinkAt([b, a], near.x, near.y)?.wire.id).toBe('b');
    });

    it('separates wires that fan in from different Output nodes', () => {
      const all = [a, b, c];
      // Close to each wire's own start, the answer is that wire.
      expect(pickLinkAt(all, 0, 0)?.wire.id).toBe('a');
      expect(pickLinkAt(all, 0, 300)?.wire.id).toBe('b');
      expect(pickLinkAt(all, 0, 600)?.wire.id).toBe('c');
      // And at the shared END every one of them is a hit — whichever comes
      // back, it is a wire really drawn through that point.
      const hit = pickLinkAt(all, 600, 300);
      expect(hit).not.toBeNull();
      expect(hit!.distance).toBeLessThan(1);
    });

    it('reports the index and the wire together, so a caller can paint one path', () => {
      const hit = pickLinkAt([a, b, c], 0, 600);
      expect(hit?.index).toBe(2);
      expect(hit?.wire).toBe(c);
    });
  });
});
