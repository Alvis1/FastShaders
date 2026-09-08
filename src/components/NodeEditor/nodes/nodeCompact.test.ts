/**
 * The compact-body maths behind the toolbar's "Node graphics" switch.
 *
 * Pure, so the two rules that make the switch safe are pinned as arithmetic
 * rather than left to a screenshot: it may only ever SHRINK a node, and it may
 * never pull a socket off the card.
 */
import { describe, it, expect } from 'vitest';
import { COMPACT_MIN_BODY, SOCKET_CLEARANCE, VALUE_CELL_PX, socketFloor, compactOpBodyHeight } from './nodeCompact';

describe('socketFloor', () => {
  it('fits a socket at its authored offset, plus the dot itself', () => {
    // Offsets are px from the body CENTRE, so ±12.5 spans 25 and the dot needs
    // its own diameter on top.
    expect(socketFloor([-12.5, 12.5])).toBe(25 + SOCKET_CLEARANCE);
    // …and `extra` shares that band rather than stacking on it. Summing them
    // reserves the dot twice, which at the classic operator geometry produces a
    // floor one pixel ABOVE the natural height — compaction silently cancelled.
    expect(socketFloor([-12.5, 12.5], 14)).toBe(25 + 14);
    expect(socketFloor([-12.5, 12.5], 4)).toBe(25 + SOCKET_CLEARANCE);
  });

  it('measures from the FARTHEST socket, whichever side it is on', () => {
    expect(socketFloor([-20, 4])).toBe(socketFloor([20, 4]));
    expect(socketFloor([-20, 4])).toBeGreaterThan(socketFloor([-12, 4]));
  });

  it('uses the coarse-pointer handle size, so a touch socket stays whole', () => {
    // --handle-size is 10px on a desktop pointer and 12 on a coarse one. Taking
    // the smaller would leave the dot half outside the card on a tablet.
    expect(SOCKET_CLEARANCE).toBe(12);
  });

  it('never goes below the minimum, and ignores junk offsets', () => {
    expect(socketFloor([])).toBe(COMPACT_MIN_BODY);
    expect(socketFloor([0])).toBe(COMPACT_MIN_BODY);
    // customGlyphs.ts is hand-editable source; NaN must not become the height.
    expect(socketFloor([NaN, Infinity, 6])).toBe(Math.round(12 + SOCKET_CLEARANCE));
  });
});

describe('compactOpBodyHeight', () => {
  it('shrinks the classic 52px operator body', () => {
    const h = compactOpBodyHeight(52, [-12.5, 12.5, 0]);
    // 25px of socket span + the 14px value cell drawn at that height.
    expect(h).toBe(39);
    // …but still clears the sockets and the value cells drawn at their height.
    expect(h).toBeGreaterThanOrEqual(socketFloor([-12.5, 12.5]));
  });

  it('NEVER grows a node — the invariant the whole switch rests on', () => {
    // Socket offsets are authored in px against the height the node had at the
    // time, and the designer's protection for a shrink (proportional rescale)
    // lives at authoring time. A render-time override that could also GROW
    // would move ports in a direction nothing checks.
    for (const natural of [28, 32, 40, 52, 60, 80]) {
      for (const offs of [[0], [-12.5, 12.5], [-30, 30], [-4, 4, 20]]) {
        expect(compactOpBodyHeight(natural, offs)).toBeLessThanOrEqual(natural);
      }
    }
  });

  it('grows the reserve with the node\'s own text scale', () => {
    // The value cell is `calc(12px * --node-text-scale)`, and a design may set
    // that multiplier as high as 2.5. A fixed cell height would clip the number
    // at the border on exactly those nodes.
    const plain = compactOpBodyHeight(90, [-12.5, 12.5], VALUE_CELL_PX);
    const large = compactOpBodyHeight(90, [-12.5, 12.5], Math.round(VALUE_CELL_PX * 2.5));
    expect(large).toBeGreaterThan(plain);
    expect(large).toBe(25 + 35);
  });

  it('leaves a node already tighter than its sockets exactly as it was', () => {
    // An author may shrink a node below its content deliberately; the switch
    // has nothing to reclaim there and must not touch it.
    expect(compactOpBodyHeight(30, [-20, 20])).toBe(30);
  });
});
