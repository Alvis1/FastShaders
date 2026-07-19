import { describe, it, expect } from 'vitest';
import {
  sanitizeDrawings,
  quantizeOpacity,
  isValidStrokeColor,
  groupByOpacity,
  strokeBounds,
  strokePointPairs,
  MAX_STROKES,
  MAX_POINTS_PER_STROKE,
  MAX_TOTAL_POINTS,
  OPACITY_STEP,
  type DrawStroke,
} from './drawings';

function stroke(over: Partial<DrawStroke> = {}): DrawStroke {
  return { id: 's', color: '#ff8800', opacity: 0.5, width: 3, points: [0, 0, 10, 10], ...over };
}

describe('quantizeOpacity', () => {
  it('snaps to the step and clamps to [step, 1]', () => {
    expect(quantizeOpacity(0.52)).toBe(0.5);
    expect(quantizeOpacity(0.53)).toBe(0.55);
    expect(quantizeOpacity(0)).toBe(OPACITY_STEP);
    expect(quantizeOpacity(-1)).toBe(OPACITY_STEP);
    expect(quantizeOpacity(2)).toBe(1);
    expect(quantizeOpacity(1)).toBe(1);
  });
  it('returns exact 2-decimal keys (no float dust)', () => {
    // 0.15 must be exactly 0.15 so same-opacity strokes share a group key
    expect(quantizeOpacity(0.15)).toBe(0.15);
    expect(quantizeOpacity(0.150001)).toBe(0.15);
    expect(Number.isFinite(quantizeOpacity(NaN))).toBe(true);
  });
});

describe('isValidStrokeColor', () => {
  it('accepts 6-digit hex only, rejects alpha and junk', () => {
    expect(isValidStrokeColor('#ff8800')).toBe(true);
    expect(isValidStrokeColor('#FFF')).toBe(false);          // 3-digit
    expect(isValidStrokeColor('#ff8800aa')).toBe(false);     // 8-digit alpha smuggling
    expect(isValidStrokeColor('red')).toBe(false);
    expect(isValidStrokeColor(123)).toBe(false);
    expect(isValidStrokeColor(undefined)).toBe(false);
  });
});

describe('sanitizeDrawings', () => {
  it('passes a clean stroke through, lowercasing + quantizing', () => {
    const out = sanitizeDrawings([stroke({ color: '#AABBCC', opacity: 0.53 })]);
    expect(out).toHaveLength(1);
    expect(out[0].color).toBe('#aabbcc');
    expect(out[0].opacity).toBe(0.55);
  });

  it('rejects non-arrays and non-objects', () => {
    expect(sanitizeDrawings(null)).toEqual([]);
    expect(sanitizeDrawings('nope' as unknown)).toEqual([]);
    expect(sanitizeDrawings([null, 5, 'x'])).toEqual([]);
  });

  it('drops strokes with a bad color or too few points', () => {
    expect(sanitizeDrawings([stroke({ color: '#ff8800aa' })])).toEqual([]);
    expect(sanitizeDrawings([stroke({ points: [1, 2] })])).toEqual([]); // 1 point
    expect(sanitizeDrawings([stroke({ points: [] })])).toEqual([]);
  });

  it('drops non-finite / odd coords but keeps the salvageable pairs', () => {
    const out = sanitizeDrawings([stroke({ points: [0, 0, NaN, 5, 10, Infinity, 20, 20] })]);
    // pairs: (0,0) ok, (NaN,5) drop, (10,Inf) drop, (20,20) ok
    expect(out[0].points).toEqual([0, 0, 20, 20]);
  });

  it('clamps coordinates to +/- 1e6', () => {
    const out = sanitizeDrawings([stroke({ points: [0, 0, 1e9, -1e9] })]);
    expect(out[0].points).toEqual([0, 0, 1e6, -1e6]);
  });

  it('clamps width into range', () => {
    expect(sanitizeDrawings([stroke({ width: 0 })])[0].width).toBeGreaterThanOrEqual(0.5);
    expect(sanitizeDrawings([stroke({ width: 9999 })])[0].width).toBe(200);
    expect(sanitizeDrawings([stroke({ width: undefined as unknown as number })])[0].width).toBe(3);
  });

  it('truncates an over-long stroke to the per-stroke point cap', () => {
    const pts = Array.from({ length: (MAX_POINTS_PER_STROKE + 50) * 2 }, (_, i) => i);
    const out = sanitizeDrawings([stroke({ points: pts })]);
    expect(out[0].points.length).toBe(MAX_POINTS_PER_STROKE * 2);
  });

  it('caps the number of strokes', () => {
    const many = Array.from({ length: MAX_STROKES + 25 }, () => stroke());
    expect(sanitizeDrawings(many).length).toBe(MAX_STROKES);
  });

  it('enforces the global point budget', () => {
    // each stroke has MAX_POINTS_PER_STROKE points → budget hit before MAX_STROKES
    const pts = Array.from({ length: MAX_POINTS_PER_STROKE * 2 }, (_, i) => i % 1000);
    const many = Array.from({ length: MAX_STROKES }, () => stroke({ points: pts.slice() }));
    const out = sanitizeDrawings(many);
    const total = out.reduce((n, s) => n + s.points.length / 2, 0);
    expect(total).toBeLessThanOrEqual(MAX_TOTAL_POINTS);
  });
});

describe('groupByOpacity', () => {
  it('partitions by exact opacity and keeps insertion order within a group', () => {
    const a = stroke({ id: 'a', opacity: 0.5 });
    const b = stroke({ id: 'b', opacity: 1 });
    const c = stroke({ id: 'c', opacity: 0.5 });
    const groups = groupByOpacity([a, b, c]);
    const half = groups.find((g) => g.opacity === 0.5)!;
    expect(half.strokes.map((s) => s.id)).toEqual(['a', 'c']);
    expect(groups.find((g) => g.opacity === 1)!.strokes.map((s) => s.id)).toEqual(['b']);
  });

  it('orders groups by newest-stroke recency (most recent on top / last)', () => {
    // group 0.5 last touched at index 2; group 1 last touched at index 1
    const groups = groupByOpacity([
      stroke({ id: 'a', opacity: 0.5 }),
      stroke({ id: 'b', opacity: 1 }),
      stroke({ id: 'c', opacity: 0.5 }),
    ]);
    expect(groups.map((g) => g.opacity)).toEqual([1, 0.5]);
  });
});

describe('geometry helpers', () => {
  it('strokePointPairs converts flat to pairs, ignoring a dangling odd', () => {
    expect(strokePointPairs([1, 2, 3, 4, 5])).toEqual([[1, 2], [3, 4]]);
  });
  it('strokeBounds computes the AABB', () => {
    expect(strokeBounds([0, 0, 10, 5, -3, 8])).toEqual({ minX: -3, minY: 0, maxX: 10, maxY: 8 });
  });
});
