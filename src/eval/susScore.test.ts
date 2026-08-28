import { describe, it, expect } from 'vitest';
import {
  SUS_ITEMS_EN,
  SUS_ITEMS_LV,
  SUS_ITEM_COUNT,
  computeSusScore,
  susContribution,
} from './susScore';

describe('susScore', () => {
  it('has exactly 10 items in both languages', () => {
    expect(SUS_ITEMS_EN).toHaveLength(SUS_ITEM_COUNT);
    expect(SUS_ITEMS_LV).toHaveLength(SUS_ITEM_COUNT);
  });

  it('item 8 uses the "awkward" variant, not "cumbersome"', () => {
    // Finstad 2006: non-native English speakers stumble on "cumbersome";
    // Lewis 2018 presents the standard SUS with the substitution. This study's
    // participants are exactly that population, so the variant is load-bearing.
    expect(SUS_ITEMS_EN[7]).toContain('awkward');
    expect(SUS_ITEMS_EN[7]).not.toContain('cumbersome');
  });

  it('scores any uniform response pattern as exactly 50', () => {
    // Property of the alternating-polarity scoring rule — a cheap sanity pin
    // that catches an odd/even indexing slip immediately.
    for (const v of [1, 2, 3, 4, 5]) {
      expect(computeSusScore(Array(SUS_ITEM_COUNT).fill(v))).toBe(50);
    }
  });

  it('scores the best and worst possible patterns as 100 and 0', () => {
    const best = Array.from({ length: SUS_ITEM_COUNT }, (_, i) => (i % 2 === 0 ? 5 : 1));
    const worst = Array.from({ length: SUS_ITEM_COUNT }, (_, i) => (i % 2 === 0 ? 1 : 5));
    expect(computeSusScore(best)).toBe(100);
    expect(computeSusScore(worst)).toBe(0);
  });

  it('scores a known mixed pattern correctly', () => {
    // Odd items 4 → contribution 3 each; even items 2 → contribution 3 each.
    // 10 × 3 = 30 → × 2.5 = 75.
    const responses = Array.from({ length: SUS_ITEM_COUNT }, (_, i) => (i % 2 === 0 ? 4 : 2));
    expect(computeSusScore(responses)).toBe(75);
  });

  it('per-item contributions follow Brooke\'s rule', () => {
    expect(susContribution(0, 5)).toBe(4); // odd item, positive wording
    expect(susContribution(0, 1)).toBe(0);
    expect(susContribution(1, 5)).toBe(0); // even item, negative wording
    expect(susContribution(1, 1)).toBe(4);
  });

  it('rejects incomplete or out-of-range response sets', () => {
    expect(computeSusScore([])).toBeNull();
    expect(computeSusScore(Array(9).fill(3))).toBeNull();
    expect(computeSusScore(Array(11).fill(3))).toBeNull();
    expect(computeSusScore([...Array(9).fill(3), 0])).toBeNull();
    expect(computeSusScore([...Array(9).fill(3), 6])).toBeNull();
    expect(computeSusScore([...Array(9).fill(3), 2.5])).toBeNull();
    expect(computeSusScore([...Array(9).fill(3), NaN])).toBeNull();
  });

  it('always lands on a multiple of 2.5 within 0–100', () => {
    // A handful of arbitrary-but-fixed patterns (no randomness in tests).
    const patterns = [
      [1, 2, 3, 4, 5, 1, 2, 3, 4, 5],
      [5, 5, 1, 1, 3, 3, 2, 4, 4, 2],
      [2, 3, 4, 5, 1, 2, 3, 4, 5, 1],
    ];
    for (const p of patterns) {
      const s = computeSusScore(p);
      expect(s).not.toBeNull();
      expect(s! % 2.5).toBe(0);
      expect(s!).toBeGreaterThanOrEqual(0);
      expect(s!).toBeLessThanOrEqual(100);
    }
  });
});
