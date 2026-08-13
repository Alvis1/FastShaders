import { describe, it, expect } from 'vitest';
import { CLOCK_SIZE, CLOCK_R, clockTicks, clockHandAngle } from './clockFace';

describe('clockTicks', () => {
  it('emits 12 radial marks just inside the rim', () => {
    const ticks = clockTicks();
    expect(ticks).toHaveLength(12);
    const c = CLOCK_SIZE / 2;
    for (const t of ticks) {
      const inner = Math.hypot(t.x1 - c, t.y1 - c);
      const outer = Math.hypot(t.x2 - c, t.y2 - c);
      expect(inner).toBeCloseTo(CLOCK_R - 4, 6);
      expect(outer).toBeCloseTo(CLOCK_R - 1, 6);
    }
  });

  it('puts the first mark at 12 o\'clock', () => {
    const [first] = clockTicks();
    expect(first.x1).toBeCloseTo(CLOCK_SIZE / 2, 6);
    expect(first.y1).toBeLessThan(CLOCK_SIZE / 2);
  });
});

describe('clockHandAngle', () => {
  it('sweeps once per 60 seconds from 12 o\'clock', () => {
    expect(clockHandAngle(0)).toBe(0);
    expect(clockHandAngle(15)).toBe(90);
    expect(clockHandAngle(30)).toBe(180);
    expect(clockHandAngle(60)).toBe(0);
    expect(clockHandAngle(75)).toBe(90);
  });

  it('normalizes the negative phases a negative speed integrates to', () => {
    // −15 s = the 45 s position, visually 15 s "before" 12 o'clock.
    expect(clockHandAngle(-15)).toBe(270);
    expect(clockHandAngle(-60)).toBe(0);
  });

  it('degrades a non-finite phase to 0 instead of an invalid transform', () => {
    expect(clockHandAngle(Number.NaN)).toBe(0);
    expect(clockHandAngle(Infinity)).toBe(0);
  });
});
