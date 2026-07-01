import { describe, it, expect } from 'vitest';
import { minMax, normalize01, capToWidth, buildPhaseRamp } from './dataViz';

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
