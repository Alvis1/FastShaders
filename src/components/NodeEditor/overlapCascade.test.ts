import { describe, it, expect } from 'vitest';
import { resolveOverlapCascade, type CascadeBox } from './overlapCascade';

const box = (
  id: string,
  x: number,
  y: number,
  w = 100,
  h = 40,
  fixed?: boolean,
): CascadeBox => ({ id, x, y, w, h, ...(fixed !== undefined ? { fixed } : {}) });

function applyShifts(boxes: CascadeBox[], shifts: ReturnType<typeof resolveOverlapCascade>) {
  const byId = new Map(shifts.map((s) => [s.id, s]));
  return boxes.map((b) => {
    const s = byId.get(b.id);
    return s ? { ...b, x: b.x + s.dx, y: b.y + s.dy } : b;
  });
}

function anyOverlap(boxes: CascadeBox[]): boolean {
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (ox > 0 && oy > 0) return true;
    }
  }
  return false;
}

describe('resolveOverlapCascade', () => {
  it('returns nothing when nothing overlaps', () => {
    const boxes = [box('a', 0, 0, 100, 40, true), box('b', 200, 0), box('c', 0, 100)];
    expect(resolveOverlapCascade(boxes)).toEqual([]);
  });

  it('returns nothing when there are no fixed anchors', () => {
    expect(resolveOverlapCascade([box('a', 0, 0), box('b', 10, 10)])).toEqual([]);
  });

  it('never moves fixed boxes, even when they overlap each other', () => {
    const boxes = [box('a', 0, 0, 100, 40, true), box('b', 50, 0, 100, 40, true)];
    const shifts = resolveOverlapCascade(boxes);
    expect(shifts.find((s) => s.id === 'a')).toBeUndefined();
    expect(shifts.find((s) => s.id === 'b')).toBeUndefined();
  });

  it('pushes a single overlapping neighbor out along the cheapest axis plus the gap', () => {
    // b overlaps a's right edge by 10px — cheapest push is right.
    const boxes = [box('a', 0, 0, 100, 40, true), box('b', 90, 0)];
    const shifts = resolveOverlapCascade(boxes, 10);
    expect(shifts).toEqual([{ id: 'b', dx: 20, dy: 0 }]); // to x=110 = a.right + gap
  });

  it('prefers the vertical push when it is cheaper', () => {
    // b sits mostly atop a horizontally but only grazes vertically.
    const boxes = [box('a', 0, 0, 100, 40, true), box('b', 10, 35)];
    const shifts = resolveOverlapCascade(boxes, 10);
    expect(shifts).toEqual([{ id: 'b', dx: 0, dy: 15 }]); // to y=50 = a.bottom + gap
  });

  it('cascades: a pushed neighbor shoves the node behind it too', () => {
    // a fixed; b overlaps a; c sits right where b will be pushed.
    const boxes = [box('a', 0, 0, 100, 40, true), box('b', 90, 0), box('c', 115, 0)];
    const shifts = resolveOverlapCascade(boxes, 10);
    const final = applyShifts(boxes, shifts);
    expect(anyOverlap(final)).toBe(false);
    expect(shifts.map((s) => s.id).sort()).toEqual(['b', 'c']);
  });

  it('a box pushed onto an already-settled box gets micro-resolved clear of both', () => {
    // b overlaps fixed a on the right; fixed c occupies the spot b would be
    // pushed to, so b must end up clear of a AND c.
    const boxes = [
      box('a', 0, 0, 100, 40, true),
      box('c', 110, 0, 100, 40, true),
      box('b', 95, 5),
    ];
    const shifts = resolveOverlapCascade(boxes, 10);
    const final = applyShifts(boxes, shifts);
    expect(anyOverlap(final)).toBe(false);
  });

  it('terminates and separates a fully stacked pile', () => {
    const boxes: CascadeBox[] = [box('seed', 0, 0, 100, 40, true)];
    for (let i = 0; i < 10; i++) boxes.push(box(`n${i}`, 0, 0));
    const shifts = resolveOverlapCascade(boxes, 10);
    const final = applyShifts(boxes, shifts);
    // Every stacked box moved somewhere...
    expect(shifts.length).toBe(10);
    // ...and the seed never did.
    expect(shifts.find((s) => s.id === 'seed')).toBeUndefined();
    // Bounded micro-passes may leave residual contact in pathological piles,
    // but the common case fully separates — assert it does here.
    expect(anyOverlap(final)).toBe(false);
  });

  it('escapes the corridor between the two fixed anchors instead of ping-ponging', () => {
    // The geometry every connect snap creates: the pair sits a wire's length
    // apart with a wide mover straddling the gap. A greedy per-box push
    // bounces the mover between the anchors forever; the full-set escape
    // must land it clear of BOTH.
    const boxes = [
      box('a', 0, 0, 100, 300, true),
      box('b', 160, 0, 100, 300, true),
      box('c', 90, 0, 120, 300),
    ];
    const shifts = resolveOverlapCascade(boxes, 10);
    const final = applyShifts(boxes, shifts);
    expect(anyOverlap(final)).toBe(false);
    expect(shifts.map((s) => s.id)).toEqual(['c']);
  });

  it('leaves distant disconnected clusters untouched', () => {
    const boxes = [
      box('a', 0, 0, 100, 40, true),
      box('b', 90, 0),
      // far-away overlapping pair, not reachable from the anchors
      box('x', 1000, 1000),
      box('y', 1010, 1010),
    ];
    const shifts = resolveOverlapCascade(boxes, 10);
    expect(shifts.map((s) => s.id)).toEqual(['b']);
  });
});
