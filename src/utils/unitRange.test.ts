import { describe, it, expect } from 'vitest';
import { hasUnitRangeFlag, isUnitRange, unitWave } from './unitRange';

describe('unitRange flag', () => {
  it('only sin and cos carry it', () => {
    expect(hasUnitRangeFlag('sin')).toBe(true);
    expect(hasUnitRangeFlag('cos')).toBe(true);
    expect(hasUnitRangeFlag('abs')).toBe(false);
    expect(hasUnitRangeFlag(undefined)).toBe(false);
  });

  it('is an exact identity read: absent and every coercible form stay raw', () => {
    expect(isUnitRange('sin', undefined)).toBe(false);
    expect(isUnitRange('sin', {})).toBe(false);
    for (const v of [0, '0', null, true, '', [], [1], 0.9999, 2]) {
      expect(isUnitRange('sin', { unit: v })).toBe(false);
    }
    expect(isUnitRange('sin', { unit: 1 })).toBe(true);
    expect(isUnitRange('cos', { unit: '1' })).toBe(true);
    expect(isUnitRange('abs', { unit: 1 })).toBe(false);
  });

  it('unitWave maps −1…1 onto 0…1', () => {
    const f = unitWave(Math.sin, true);
    expect(f(0)).toBeCloseTo(0.5);
    expect(f(Math.PI / 2)).toBeCloseTo(1);
    expect(f(-Math.PI / 2)).toBeCloseTo(0);
    expect(unitWave(Math.sin, false)).toBe(Math.sin);
  });
});
