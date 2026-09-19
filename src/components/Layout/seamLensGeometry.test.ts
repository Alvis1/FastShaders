import { describe, it, expect } from 'vitest';
import { SEAM_LENS, lensPaths, lensAlong } from './seamLensGeometry';

/** Every coordinate pair in a path, in order. */
const points = (d: string): Array<[number, number]> =>
  Array.from(d.matchAll(/(-?[\d.]+),(-?[\d.]+)/g), (m) => [Number(m[1]), Number(m[2])]);

describe('seam lens geometry', () => {
  it('leaves a real white gap around the grip line at the desktop seam width', () => {
    // 2 × half minus the 2px seam is the gap; the 2px grip line sits inside it
    // and must leave white on both sides, or the bulge reads as a thick line.
    const gap = 2 * SEAM_LENS.half - 2;
    expect(gap - 2).toBeGreaterThanOrEqual(4);
    expect(SEAM_LENS.gripRun).toBeLessThan(SEAM_LENS.run);
    // Room for half of the COARSE seam's stroke, which is the widest one.
    expect(SEAM_LENS.overscan).toBeGreaterThanOrEqual(3);
    // The ring is a joint, not a fatter bulge, and its stripe stays inside it.
    expect(SEAM_LENS.ringR).toBeGreaterThan(SEAM_LENS.half);
    expect(SEAM_LENS.ringGrip + 2).toBeLessThan(SEAM_LENS.ringR);
  });

  for (const orientation of ['v', 'h'] as const) {
    const along = orientation === 'v' ? 1 : 0;
    const across = 1 - along;

    describe(`orientation ${orientation}`, () => {
      const p = lensPaths(orientation);
      const pts = points(p.outline);

      it('starts and ends ON the seam line, at the bulge\'s two tips', () => {
        const first = pts[0];
        const last = pts[pts.length - 1];
        expect(first[across]).toBe(0);
        expect(last[across]).toBe(0);
        expect(first[along]).toBe(-SEAM_LENS.run);
        expect(last[along]).toBe(-SEAM_LENS.run);
      });

      it('meets the seam tangentially — the first control point sits on the line', () => {
        // The split strokes rejoin the single line without a corner only if
        // the tangent at each tip runs ALONG the seam, i.e. the first control
        // point after the tip shares the tip's across-coordinate.
        expect(pts[1][across]).toBe(0);
        expect(pts[1][along]).toBe(-SEAM_LENS.run / 2);
      });

      it('reaches ±half at the pointer, symmetrically', () => {
        const extremes = pts.map((q) => q[across]);
        expect(Math.max(...extremes)).toBe(SEAM_LENS.half);
        expect(Math.min(...extremes)).toBe(-SEAM_LENS.half);
        const widest = pts.filter((q) => Math.abs(q[across]) === SEAM_LENS.half && q[along] === 0);
        expect(widest).toHaveLength(2);
      });

      it('draws the grip line down the middle, shorter than the bulge', () => {
        const g = points(p.grip);
        expect(g).toHaveLength(2);
        expect(g[0][across]).toBe(0);
        expect(g[1][across]).toBe(0);
        expect(Math.abs(g[0][along])).toBe(SEAM_LENS.gripRun);
      });

      it('draws the junction ring as a circle on the crossing, stripe along the seam', () => {
        const r = SEAM_LENS.ringR;
        expect(p.ring).toContain(`A ${r} ${r} 0 1 0`);
        const ends = points(p.ring);
        // Both arc endpoints sit on the seam line, ±r along it.
        for (const q of ends) {
          expect(q[across]).toBe(0);
          expect(Math.abs(q[along])).toBe(r);
        }
        const g = points(p.ringGrip);
        expect(g[0][across]).toBe(0);
        expect(g[1][across]).toBe(0);
        expect(Math.abs(g[0][along])).toBe(SEAM_LENS.ringGrip);
      });

      it('has a box that contains the stroke with the origin at the centre', () => {
        const [x, y, w, h] = p.viewBox.split(' ').map(Number);
        expect(w).toBe(p.width);
        expect(h).toBe(p.height);
        expect(x).toBe(-w / 2);
        expect(y).toBe(-h / 2);
        const acrossSize = orientation === 'v' ? w : h;
        const alongSize = orientation === 'v' ? h : w;
        expect(acrossSize).toBe(2 * (Math.max(SEAM_LENS.half, SEAM_LENS.ringR) + SEAM_LENS.overscan));
        expect(alongSize).toBe(2 * (SEAM_LENS.run + SEAM_LENS.overscan));
      });
    });
  }

  it('is the same construction turned, not two hand-mirrored strings', () => {
    const v = points(lensPaths('v').outline);
    const h = points(lensPaths('h').outline);
    expect(v.map(([x, y]) => [y, x])).toEqual(h);
  });
});

describe('lensAlong', () => {
  const box = { top: 100, left: 40, width: 300, height: 700 };

  it('measures along the seam axis from its start', () => {
    expect(lensAlong('v', box, 999, 350)).toBe(250);
    expect(lensAlong('h', box, 190, 999)).toBe(150);
  });

  it('clamps a captured pointer that has left the seam\'s extent onto the line', () => {
    expect(lensAlong('v', box, 0, 20)).toBe(0);
    expect(lensAlong('v', box, 0, 5000)).toBe(700);
    expect(lensAlong('h', box, -50, 0)).toBe(0);
    expect(lensAlong('h', box, 5000, 0)).toBe(300);
  });

  it('answers 0 for an unmeasured box rather than NaN', () => {
    expect(lensAlong('v', { top: 0, left: 0, width: 0, height: 0 }, 10, 10)).toBe(0);
  });
});
