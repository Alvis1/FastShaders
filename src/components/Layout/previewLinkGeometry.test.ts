import { describe, it, expect } from 'vitest';
import { linkPath, rectCenter, type RectLike } from './previewLinkGeometry';

const rect = (left: number, top: number, right: number, bottom: number): RectLike => ({
  left, top, right, bottom,
});

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
  });
});
