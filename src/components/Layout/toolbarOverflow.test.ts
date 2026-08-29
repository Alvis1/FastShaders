import { describe, it, expect } from 'vitest';
import {
  foldOverflow,
  OVERFLOW_INITIAL,
  OVERFLOW_SLOP_PX,
  type OverflowState,
} from './toolbarOverflow';

/** Drive a sequence of window widths through the fold, modelling a bar whose
 *  expanded layout needs `natural` px and whose collapsed one needs `folded`. */
function run(widths: number[], natural: number, folded: number): OverflowState[] {
  let s = OVERFLOW_INITIAL;
  const out: OverflowState[] = [];
  for (const w of widths) {
    const need = s.collapsed ? folded : natural;
    s = foldOverflow(s, { clientWidth: w, scrollWidth: Math.max(w, need) });
    out.push(s);
  }
  return out;
}

describe('foldOverflow', () => {
  it('stays expanded while the bar fits', () => {
    const s = foldOverflow(OVERFLOW_INITIAL, { clientWidth: 1200, scrollWidth: 1200 });
    expect(s).toBe(OVERFLOW_INITIAL); // same object → React bails out
  });

  it('collapses once the content overflows, remembering the width it needed', () => {
    const s = foldOverflow(OVERFLOW_INITIAL, { clientWidth: 700, scrollWidth: 980 });
    expect(s.collapsed).toBe(true);
    expect(s.expandAt).toBe(980 + OVERFLOW_SLOP_PX);
  });

  it('does NOT flicker: collapsing removes the overflow but does not re-expand', () => {
    // The defect this module exists for. Expanded needs 980; collapsed needs
    // 700. At a 720px window the collapsed bar fits comfortably, and a naive
    // "expand while it fits" rule would expand → overflow → collapse → …
    const seq = run([720, 720, 720, 720, 720, 720], 980, 700);
    expect(seq.map((s) => s.collapsed)).toEqual([true, true, true, true, true, true]);
  });

  it('expands again only once there is room for the FULL bar', () => {
    const seq = run([720, 900, 970, 985, 1100], 980, 700);
    expect(seq.map((s) => s.collapsed)).toEqual([true, true, true, false, false]);
  });

  it('is stable across a slow drag back and forth through the threshold', () => {
    const widths: number[] = [];
    for (let w = 1100; w >= 700; w -= 20) widths.push(w);
    for (let w = 700; w <= 1100; w += 20) widths.push(w);
    const seq = run(widths, 980, 700);
    // Exactly one collapse and one expansion — no chatter at the boundary.
    let flips = 0;
    for (let i = 1; i < seq.length; i++) if (seq[i].collapsed !== seq[i - 1].collapsed) flips++;
    expect(flips).toBe(2);
  });

  it('forgets the remembered width when it expands', () => {
    // Otherwise a bar that grew a button (a language switch relabels every
    // chip) would re-use a stale, too-small threshold and sit expanded while
    // overflowing.
    const s = foldOverflow({ collapsed: true, expandAt: 900 }, { clientWidth: 950, scrollWidth: 700 });
    expect(s).toEqual({ collapsed: false, expandAt: Infinity });
  });

  it('ignores a zero-width measurement instead of collapsing on it', () => {
    // A detached or hidden element measures 0/0. Collapsing there would strand
    // the bar collapsed at Infinity once it was shown again.
    const s = foldOverflow(OVERFLOW_INITIAL, { clientWidth: 0, scrollWidth: 0 });
    expect(s).toBe(OVERFLOW_INITIAL);
    const c: OverflowState = { collapsed: true, expandAt: 900 };
    expect(foldOverflow(c, { clientWidth: 0, scrollWidth: 0 })).toBe(c);
  });

  it('tolerates a single pixel of sub-pixel rounding either way', () => {
    // scrollWidth may exceed clientWidth by a fraction at a size that really
    // does fit; a 1px allowance keeps that from reading as overflow.
    expect(foldOverflow(OVERFLOW_INITIAL, { clientWidth: 800, scrollWidth: 801 }).collapsed).toBe(false);
    expect(foldOverflow(OVERFLOW_INITIAL, { clientWidth: 800, scrollWidth: 802 }).collapsed).toBe(true);
  });
});
