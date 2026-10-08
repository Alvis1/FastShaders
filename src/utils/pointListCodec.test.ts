import { describe, it, expect } from 'vitest';
import {
  unitToken,
  hexToken,
  wordToken,
  splitRecords,
  formatUnit,
  POINT_LIST_MAX_CHARS,
  POINT_LIST_MAX_RECORDS,
} from './pointListCodec';

/**
 * The point-list grammar is the whole injection story of Color Ramp / RGB
 * Curves: the stored string is adversarial, the emitted one is re-formatted
 * from the parse. These pin the TS half; lutHelpers.test.ts holds fsLut's
 * text to the same corpus.
 */
describe('unitToken', () => {
  it('accepts plain decimals and clamps above 1', () => {
    expect(unitToken('0')).toBe(0);
    expect(unitToken('1')).toBe(1);
    expect(unitToken('0.5')).toBe(0.5);
    expect(unitToken('.25')).toBe(0.25);
    expect(unitToken('5.')).toBe(1);
    expect(unitToken('007')).toBe(1);
    expect(unitToken('0.0001')).toBe(0.0001);
    expect(unitToken('123456789012')).toBe(1);
  });

  it('refuses everything Number() would also accept but the grammar does not', () => {
    for (const s of ['', '.', '..5', '1.2.3', '-0.5', '+0.5', '1e3', '1E-3', '0x10', 'Infinity', 'NaN', ' 1', '1 ', '\t1',
      '1 ', '١', '０', '1_0', '1234567890123', '0.5,', '#1']) {
      expect(unitToken(s), JSON.stringify(s)).toBeNull();
    }
  });
});

describe('hexToken', () => {
  it('accepts either case and lowercases', () => {
    expect(hexToken('#000000')).toBe('#000000');
    expect(hexToken('#FFaa09')).toBe('#ffaa09');
  });

  it('refuses the code points next to each accepted range, and control characters', () => {
    // '/' ':' '@' 'G' '`' 'g' — one past each end of 0-9, A-F, a-f.
    for (const ch of ['/', ':', '@', 'G', '`', 'g']) expect(hexToken('#' + ch.repeat(6)), ch).toBeNull();
    // `charCode | 32` would map U+0010–U+0019 onto '0'–'9' — the defect the explicit ranges exist for.
    for (let k = 0; k < 0x20; k++) expect(hexToken('#' + String.fromCharCode(k).repeat(6)), `U+${k.toString(16)}`).toBeNull();
    for (const s of ['000000', '#00000', '#0000000', '##00000', '#00 000', '#ＦＦＦＦＦＦ', '']) expect(hexToken(s), s).toBeNull();
  });
});

describe('wordToken', () => {
  it('is 1..12 lowercase ASCII letters', () => {
    expect(wordToken('auto')).toBe(true);
    expect(wordToken('a'.repeat(12))).toBe(true);
    for (const s of ['', 'a'.repeat(13), 'Auto', 'auto1', 'au-to', 'é', 'vector ']) expect(wordToken(s), s).toBe(false);
  });
});

describe('splitRecords', () => {
  it('splits on commas, trims each record and drops empty tokens', () => {
    expect(splitRecords('0 #000000 1, 1  #ffffff 1', 1, 32)).toEqual([['0', '#000000', '1'], ['1', '#ffffff', '1']]);
  });

  it('refuses non-strings without coercing them', () => {
    const poison = { toString() { throw new Error('coerced'); } };
    for (const v of [undefined, null, 0, 1, true, poison, Symbol('s'), ['0 0'], { length: 3 }]) {
      expect(() => splitRecords(v, 1, 32)).not.toThrow();
      expect(splitRecords(v, 1, 32)).toBeNull();
    }
  });

  it('checks the length BEFORE splitting, and the record count', () => {
    expect(splitRecords('', 1, 32)).toBeNull();
    expect(splitRecords('0'.repeat(POINT_LIST_MAX_CHARS + 1), 1, 32)).toBeNull();
    expect(splitRecords('0 0', 2, 32)).toBeNull();
    expect(splitRecords(Array(POINT_LIST_MAX_RECORDS + 1).fill('0 0').join(','), 2, POINT_LIST_MAX_RECORDS)).toBeNull();
    expect(splitRecords(Array(POINT_LIST_MAX_RECORDS).fill('0 0').join(','), 2, POINT_LIST_MAX_RECORDS)).toHaveLength(32);
  });
});

describe('formatUnit — the canonical writer', () => {
  it('clamps, rounds to 1e-4 and never writes an exponent', () => {
    expect(formatUnit(0)).toBe('0');
    expect(formatUnit(-0)).toBe('0');
    expect(formatUnit(-1)).toBe('0');
    expect(formatUnit(2)).toBe('1');
    expect(formatUnit(NaN)).toBe('0');
    expect(formatUnit(Infinity)).toBe('0');
    expect(formatUnit(-Infinity)).toBe('0');
    expect(formatUnit(0.00004)).toBe('0');
    expect(formatUnit(0.00005)).toBe('0.0001');
    expect(formatUnit(1e-7)).toBe('0');
    expect(formatUnit(0.12345678)).toBe('0.1235');
    expect(formatUnit(0.99996)).toBe('1');
  });

  it('is idempotent and re-parses through unitToken to the same number, over a dense sweep', () => {
    for (let i = 0; i <= 20000; i++) {
      const x = i / 20000 + (i % 7) * 1e-9;
      const s = formatUnit(x);
      expect(s).toMatch(/^[0-9.]{1,6}$/);
      const back = unitToken(s);
      expect(back, s).not.toBeNull();
      expect(formatUnit(back!), s).toBe(s);
      expect(Math.abs(back! - Math.min(1, x))).toBeLessThanOrEqual(5e-5 + 1e-12);
    }
  });
});
