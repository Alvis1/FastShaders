import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  gripClearance, maxBarHeightForCross, maxCrossForBarHeight,
  GRIP_BOTTOM_MARGIN, CROSS_MIN_TOP_RATIO,
} from './splitClearance';

/** The desktop token values — `--fs-grip-h` resolves to 39px at --ctl-size 28. */
const DESKTOP = { gripH: 39, seam: 2, border: 2 };
/** A coarse pointer bumps --fs-seam to 6 while the grip's OUTLINE stays at 2. */
const COARSE = { gripH: 41, seam: 6, border: 2 };

describe('gripClearance', () => {
  it('is the tab plus its margin when seam and outline agree', () => {
    expect(gripClearance(DESKTOP)).toBe(39 + GRIP_BOTTOM_MARGIN);
  });

  /**
   * The half-thickness term only does anything when the seam and the grip's
   * outline differ, which is exactly the coarse-pointer case `.fs-grip--v`
   * documents — the outline deliberately does NOT take the touch bump, so the
   * tab's border is centred in the thicker line rather than top-aligned to it.
   */
  it('takes the centring correction on a coarse pointer', () => {
    expect(gripClearance(COARSE)).toBe(41 + GRIP_BOTTOM_MARGIN + 2);
  });
});

describe('the one inequality, both ways round', () => {
  const span = 899;
  const clearance = gripClearance(DESKTOP);

  it('reproduces the measured stock layout', () => {
    // Measured in Chromium at 1600x950: span 899, cross 0.4, bar 295px. The
    // grip sat ON its seam, so the bar must have been under the ceiling.
    expect(maxBarHeightForCross(0.4, span, clearance)).toBeCloseTo(496.4, 1);
    expect(295).toBeLessThan(maxBarHeightForCross(0.4, span, clearance));
  });

  it('reproduces the measured DETACHED case', () => {
    // Same session, corner grip dragged to the bottom: cross 0.8894 with the
    // bar still 295px. The ceiling falls below it, which is precisely when the
    // CSS clamp used to strand the grip 239px from its own line.
    expect(maxBarHeightForCross(0.8894, span, clearance)).toBeLessThan(295);
  });

  /** The two directions must agree about where the wall is, or each pusher
   *  would shove the other and the pair would oscillate. */
  it('is a true inverse', () => {
    for (const cross of [0.25, 0.4, 0.6, 0.85, 0.95]) {
      const bar = maxBarHeightForCross(cross, span, clearance);
      expect(maxCrossForBarHeight(bar, span, clearance)).toBeCloseTo(cross, 10);
    }
  });

  it('lets a taller bar only sit under a higher seam', () => {
    expect(maxCrossForBarHeight(400, span, clearance))
      .toBeLessThan(maxCrossForBarHeight(100, span, clearance));
  });

  it('answers "no constraint" rather than NaN before the layout is measured', () => {
    // A zero span reaches this on the very first frame; dividing by it would
    // poison the ratio and React Flow would be handed NaN.
    expect(maxCrossForBarHeight(200, 0, clearance)).toBe(1);
  });

  it('can demand more room than the column has, and says so with a negative', () => {
    // Callers floor this against the bar's own minimum; the point is that it
    // must not silently clamp to 0 and pretend a zero-height bar fits.
    expect(maxBarHeightForCross(0.99, 100, clearance)).toBeLessThan(0);
  });
});

/**
 * `GRIP_BOTTOM_MARGIN` and `CROSS_MIN_TOP_RATIO` are each stated twice — once
 * here for the JS pushes and once in the CSS/store clamps that back them up.
 * Nothing fails loudly when they drift: the grip simply starts detaching again
 * at the very end of travel, which is the bug this module exists to remove.
 */
describe('the numbers the CSS backstop also states', () => {
  const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

  it('matches the 4px in .fs-grip--v\'s top: min() clamp', () => {
    const css = read('styles/controls.css');
    const clamp = css.slice(css.indexOf('.fs-grip--v'));
    // The DECLARATION, not just the number: `.fs-grip--v`'s comment block is
    // full of historical px values, and a bare `- 4px` search would happily
    // match one of those and pass while the real clamp had drifted.
    expect(clamp).toContain(`var(--fs-grip-h) / 2 - ${GRIP_BOTTOM_MARGIN}px`);
  });

  it('matches the store\'s persisted preview floor', () => {
    const store = read('store/useAppStore.ts');
    expect(store).toContain(`RIGHT_SPLIT_MIN = ${CROSS_MIN_TOP_RATIO}`);
  });

  /** SplitPane must not keep a second copy of the ratio it used to own. */
  it('is the only definition of the preview floor outside the store', () => {
    const split = read('components/Layout/SplitPane.tsx');
    expect(split).not.toMatch(/const\s+CROSS_MIN_TOP_RATIO\s*=/);
    expect(split).toContain("from '@/utils/splitClearance'");
  });
});
