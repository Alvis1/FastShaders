import { describe, it, expect, afterEach } from 'vitest';
import {
  POINT_BUDGET,
  toBudgetPoints,
  formatPoints,
  setDeviceBudget,
  getDeviceBudget,
  budgetPointsOf,
} from './budgetPoints';

/**
 * Every device's budget prints as 100 (utils/budgetPoints.ts): the table keeps
 * its own currency and every total is summed in it, and only the print divides
 * by the selected device's budget — rounded to 0.01, with a dot and a tooltip
 * when the rounding dropped something.
 */

describe('toBudgetPoints — a share of the device budget, budget = 100', () => {
  it('divides by the device budget in table points', () => {
    expect(POINT_BUDGET).toBe(100);
    expect(toBudgetPoints(200, 200)).toBe(100);
    expect(toBudgetPoints(35, 200)).toBe(17.5);
    expect(toBudgetPoints(1, 200)).toBe(0.5);
    expect(toBudgetPoints(35, 150)).toBeCloseTo(23.3333333, 6);
    expect(toBudgetPoints(0, 200)).toBe(0);
  });

  it('leaves the figure in table points for a junk budget instead of printing NaN or Infinity', () => {
    expect(toBudgetPoints(35, 0)).toBe(35);
    expect(toBudgetPoints(35, -200)).toBe(35);
    expect(toBudgetPoints(35, NaN)).toBe(35);
    expect(toBudgetPoints(35, Infinity)).toBe(35);
  });

  it('a total divided once is not the sum of rounded figures', () => {
    // Three nodes of 1/3 point under a 300-point device: the sum in table
    // points divides to exactly 1, where adding three printed 0.33s reads 0.99.
    expect(formatPoints(toBudgetPoints(1 + 1 + 1, 300))).toEqual({ text: '1', rounded: false, exact: '1' });
    expect(formatPoints(toBudgetPoints(1, 300))).toEqual({ text: '0.33', rounded: true, exact: '0.333333' });
  });
});

describe('formatPoints — two decimals, trailing zeros dropped, rounding marked', () => {
  it('prints an exact figure as it is, without the mark', () => {
    expect(formatPoints(17.5)).toEqual({ text: '17.5', rounded: false, exact: '17.5' });
    expect(formatPoints(4)).toEqual({ text: '4', rounded: false, exact: '4' });
    expect(formatPoints(0.25)).toEqual({ text: '0.25', rounded: false, exact: '0.25' });
    expect(formatPoints(0)).toEqual({ text: '0', rounded: false, exact: '0' });
  });

  it('marks a figure the 0.01 rounding changed and keeps six decimals for its tooltip', () => {
    expect(formatPoints(23.333333333)).toEqual({ text: '23.33', rounded: true, exact: '23.333333' });
    expect(formatPoints(2 / 3)).toEqual({ text: '0.67', rounded: true, exact: '0.666667' });
    expect(formatPoints(0.004)).toEqual({ text: '0', rounded: true, exact: '0.004' });
  });

  it('does not mark float noise', () => {
    expect(formatPoints(0.1 + 0.2)).toEqual({ text: '0.3', rounded: false, exact: '0.3' });
    expect(formatPoints((35 * 3 * 100) / 200)).toEqual({ text: '52.5', rounded: false, exact: '52.5' });
  });

  it('prints a dot whatever the locale, and 0 for a non-finite junk figure', () => {
    expect(formatPoints(1234.5).text).toBe('1234.5');
    expect(formatPoints(NaN)).toEqual({ text: '0', rounded: false, exact: '0' });
    expect(formatPoints(Infinity).text).toBe('0');
  });
});

describe('the selected device budget', () => {
  afterEach(() => setDeviceBudget(200));

  it('starts at the first headset budget and divides what budgetPointsOf prints', () => {
    expect(getDeviceBudget()).toBe(200);
    expect(budgetPointsOf(35)).toBe(17.5);
    setDeviceBudget(150);
    expect(getDeviceBudget()).toBe(150);
    expect(budgetPointsOf(150)).toBe(100);
  });

  it('ignores a junk budget rather than dividing by it', () => {
    setDeviceBudget(0);
    setDeviceBudget(-5);
    setDeviceBudget(NaN);
    setDeviceBudget(Infinity);
    expect(getDeviceBudget()).toBe(200);
  });
});
