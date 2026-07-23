import { describe, it, expect } from 'vitest';
import { linkPath, pointInRect, rectCenter, type RectLike } from './previewLinkGeometry';

const rect = (left: number, top: number, right: number, bottom: number): RectLike => ({
  left, top, right, bottom,
});

describe('previewLinkGeometry', () => {
  describe('rectCenter', () => {
    it('returns the midpoint of a rect', () => {
      expect(rectCenter(rect(10, 20, 30, 60))).toEqual({ x: 20, y: 40 });
    });
  });

  describe('pointInRect', () => {
    const r = rect(0, 0, 100, 100);
    it('accepts an interior point', () => {
      expect(pointInRect({ x: 50, y: 50 }, r)).toBe(true);
    });
    it('rejects a point outside', () => {
      expect(pointInRect({ x: 150, y: 50 }, r)).toBe(false);
    });
    it('accepts a just-outside point within the margin', () => {
      expect(pointInRect({ x: 103, y: 50 }, r, 4)).toBe(true);
      expect(pointInRect({ x: 105, y: 50 }, r, 4)).toBe(false);
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
