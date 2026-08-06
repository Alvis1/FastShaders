import { describe, it, expect } from 'vitest';
import {
  minMax,
  normalize01,
  capToWidth,
  buildPhaseRamp,
  columnStats,
  planNormalize,
  isNormalizeMode,
  NORMALIZE_MODES,
  ZSCORE_SIGMAS,
} from './dataViz';

describe('minMax', () => {
  it('finds the extent', () => {
    expect(minMax([3, -1, 7, 2])).toEqual({ min: -1, max: 7 });
  });
  it('falls back to [0,1] on a non-finite/empty input', () => {
    expect(minMax([])).toEqual({ min: 0, max: 1 });
  });
});

describe('normalize01', () => {
  it('maps to [0,1] across the range, clamped', () => {
    const out = normalize01([0, 5, 10], { min: 0, max: 10 });
    expect(Array.from(out)).toEqual([0, 0.5, 1]);
  });
  it('maps a flat column to all zeros (no spurious gradient)', () => {
    const out = normalize01([4, 4, 4], { min: 4, max: 4 });
    expect(Array.from(out)).toEqual([0, 0, 0]);
  });
});

describe('capToWidth', () => {
  it('returns a copy when already within budget', () => {
    const out = capToWidth([1, 2, 3], 8);
    expect(Array.from(out)).toEqual([1, 2, 3]);
  });
  it('mean-downsamples a long column to the cap', () => {
    const long = Array.from({ length: 1000 }, (_, i) => i);
    const out = capToWidth(long, 100);
    expect(out.length).toBe(100);
    // First bucket averages samples 0..9 → 4.5
    expect(out[0]).toBeCloseTo(4.5, 5);
    // Monotonic input stays monotonic after bucket-mean.
    for (let i = 1; i < out.length; i++) expect(out[i]).toBeGreaterThan(out[i - 1]);
  });
});

describe('buildPhaseRamp', () => {
  it('is monotonic non-decreasing and spans [0,1]', () => {
    const norm = [0.1, 0.9, 0.2, 0.7, 0.5];
    const { phase01, totalCycles } = buildPhaseRamp(norm, 40, 1.5);
    expect(phase01[0]).toBe(0);
    expect(phase01[phase01.length - 1]).toBeLessThan(1); // last entry is phase BEFORE final step
    for (let i = 1; i < phase01.length; i++) {
      expect(phase01[i]).toBeGreaterThanOrEqual(phase01[i - 1]);
    }
    expect(totalCycles).toBeGreaterThan(0);
  });

  it('produces ≈ baseCycles total stripes when gain = 0', () => {
    const norm = new Float32Array(1000).fill(0.5);
    const { totalCycles } = buildPhaseRamp(norm, 80, 0);
    expect(totalCycles).toBeCloseTo(80, 5);
  });

  it('denser regions accumulate phase faster (gain > 0)', () => {
    // Low-value first half, high-value second half → second half should gain
    // more phase per sample.
    const norm = [...Array(500).fill(0), ...Array(500).fill(1)];
    const { phase01 } = buildPhaseRamp(norm, 50, 2);
    const firstHalf = phase01[500] - phase01[0];
    const secondHalf = phase01[999] - phase01[500];
    expect(secondHalf).toBeGreaterThan(firstHalf);
  });

  it('handles an empty column', () => {
    const { phase01, totalCycles } = buildPhaseRamp([], 40, 1);
    expect(phase01.length).toBe(0);
    expect(totalCycles).toBe(0);
  });
});

describe('columnStats', () => {
  it('reports extent, mean, population sd and the robust percentiles', () => {
    const s = columnStats([1, 2, 3, 4, 5]);
    expect(s.min).toBe(1);
    expect(s.max).toBe(5);
    expect(s.count).toBe(5);
    expect(s.mean).toBe(3);
    // Population sd (÷N): sqrt(10/5) = sqrt 2. Using the sample sd (÷N−1) here
    // would widen every z-score domain by ~12% on a 5-row column.
    expect(s.sd).toBeCloseTo(Math.SQRT2, 10);
    expect(s.p2).toBe(1);
    expect(s.p98).toBe(5);
  });

  it('skips non-finite cells rather than poisoning mean and sd', () => {
    const s = columnStats([1, NaN, 3, Infinity]);
    expect(s.count).toBe(2);
    expect(s.mean).toBe(2);
    expect(Number.isFinite(s.sd)).toBe(true);
  });

  it('is total on an empty column', () => {
    expect(columnStats([])).toEqual({ min: 0, max: 1, count: 0, mean: 0, sd: 0, p2: 0, p98: 1 });
  });

  it('percentiles resist a single extreme outlier', () => {
    // The reason `robust` exists: one bad row otherwise squashes 99 good ones
    // into the first texel of the ramp.
    const col = [...Array(99).fill(0).map((_, i) => i / 98), 1e6];
    const s = columnStats(col);
    expect(s.max).toBe(1e6);
    expect(s.p98).toBeLessThanOrEqual(1);
  });
});

describe('planNormalize', () => {
  const stats = columnStats([-2, -1, 0, 1, 4]);
  const manual = { lo: 10, hi: 20 };

  it('minmax spans the data', () => {
    expect(planNormalize('minmax', stats, manual)).toEqual({ kind: 'affine', lo: -2, hi: 4 });
  });

  it('robust spans the 2–98 percentiles', () => {
    expect(planNormalize('robust', stats, manual)).toEqual({
      kind: 'affine',
      lo: stats.p2,
      hi: stats.p98,
    });
  });

  it('symmetric puts zero at exactly the ramp centre', () => {
    // The property that makes a diverging colormap honest: the neutral colour
    // must sit on zero, not on the midpoint of an asymmetric range.
    const plan = planNormalize('symmetric', stats, manual);
    expect(plan).toEqual({ kind: 'affine', lo: -4, hi: 4 });
    if (plan.kind !== 'affine') throw new Error('unreachable');
    expect((0 - plan.lo) / (plan.hi - plan.lo)).toBe(0.5);
  });

  it('zscore spans ±3σ about the mean', () => {
    const plan = planNormalize('zscore', stats, manual);
    expect(plan).toEqual({
      kind: 'affine',
      lo: stats.mean - ZSCORE_SIGMAS * stats.sd,
      hi: stats.mean + ZSCORE_SIGMAS * stats.sd,
    });
  });

  it('manual uses the given domain and ignores the data', () => {
    expect(planNormalize('manual', stats, manual)).toEqual({ kind: 'affine', lo: 10, hi: 20 });
  });

  it('falls back to the manual domain when no column is traceable', () => {
    for (const mode of ['minmax', 'robust', 'zscore'] as const) {
      expect(planNormalize(mode, null, manual)).toEqual({ kind: 'affine', lo: 10, hi: 20 });
    }
  });

  it('never emits a zero-width or inverted domain', () => {
    // A zero span becomes a division by zero in the shader and paints the
    // surface with Infinity, so a flat column must widen instead.
    const flat = columnStats([7, 7, 7]);
    const plan = planNormalize('minmax', flat, manual);
    if (plan.kind !== 'affine') throw new Error('unreachable');
    expect(plan.hi - plan.lo).toBeGreaterThan(0);
    expect((7 - plan.lo) / (plan.hi - plan.lo)).toBeCloseTo(0.5, 10);

    const inverted = planNormalize('manual', null, { lo: 5, hi: 5 });
    if (inverted.kind !== 'affine') throw new Error('unreachable');
    expect(inverted.hi - inverted.lo).toBeGreaterThan(0);
  });

  it('log keeps a strictly positive domain even when the data touches zero', () => {
    const withZero = columnStats([0, 1, 10, 100]);
    const plan = planNormalize('log', withZero, manual);
    if (plan.kind !== 'log') throw new Error('expected a log plan');
    expect(plan.lo).toBeGreaterThan(0);
    expect(plan.hi).toBeGreaterThan(plan.lo);

    // All-negative data would have no log domain at all — it must still resolve.
    const negative = planNormalize('log', columnStats([-5, -1]), manual);
    if (negative.kind !== 'log') throw new Error('expected a log plan');
    expect(negative.lo).toBeGreaterThan(0);
    expect(negative.hi).toBeGreaterThan(negative.lo);
  });

  it('symlog is symmetric about zero with a positive linear threshold', () => {
    const plan = planNormalize('symlog', stats, manual);
    if (plan.kind !== 'symlog') throw new Error('expected a symlog plan');
    expect(plan.m).toBe(4);
    expect(plan.thresh).toBeGreaterThan(0);
    expect(plan.thresh).toBeLessThan(plan.m);

    // …and stays defined on an all-zero column.
    const zeros = planNormalize('symlog', columnStats([0, 0]), { lo: 0, hi: 0 });
    if (zeros.kind !== 'symlog') throw new Error('expected a symlog plan');
    expect(zeros.thresh).toBeGreaterThan(0);
    expect(zeros.m).toBeGreaterThan(0);
  });

  it('every declared mode produces a finite plan', () => {
    for (const mode of NORMALIZE_MODES) {
      const plan = planNormalize(mode, stats, manual);
      for (const v of Object.values(plan)) {
        if (typeof v === 'number') expect(Number.isFinite(v)).toBe(true);
      }
    }
  });
});

describe('isNormalizeMode', () => {
  it('accepts exactly the declared modes', () => {
    for (const mode of NORMALIZE_MODES) expect(isNormalizeMode(mode)).toBe(true);
    for (const bad of ['', 'linear', 'MINMAX', undefined, null, 0, {}]) {
      expect(isNormalizeMode(bad)).toBe(false);
    }
  });
});
