/**
 * The `values` coercion guards (2026-09-19).
 *
 * A node's `values` map is typed `Record<string, string | number>` and that
 * type is a runtime LIE — it arrives verbatim from a `.fastshader`, `fs:graph`
 * or `fs:savedGroups`, and `rawNodeValues` only checks that it is an object.
 * `String(v)` and `Number(v)` run ToPrimitive, which THROWS on a value whose
 * `toString`/`valueOf` are not callable. Thrown from a render body or from
 * `graphToCode` (which the sync engine runs inside one), with no error
 * boundary anywhere in this app, that blanks the whole screen — and the
 * autosave is a store subscription OUTSIDE React, so the poisoned graph is
 * written back and every reload blanks again.
 *
 * Two properties, and the second is what makes this a fix rather than a
 * regression:
 *   1. NOTHING throws, for any input;
 *   2. `valueStr`/`valueNum` agree with `String`/`Number` on every input that
 *      does NOT throw. Those coercions are load-bearing and pinned elsewhere —
 *      `imageTextureSpec.test.ts` requires `repeat: null` and `repeat: ''` to
 *      read as CLAMP, i.e. `Number(null) === 0`.
 */
import { describe, it, expect } from 'vitest';
import { valueStr, valueNum, plainStr } from './valueCoerce';

/** Objects whose ToPrimitive THROWS on BOTH coercions — the whole reason this
 *  module exists. */
const THROWING_OBJECTS: unknown[] = [
  { toString: 1 },
  { toString: null },
  { toString: 1, valueOf: 1 },
  { valueOf: {}, toString: {} },
  Object.create(null),
];

/** Symbols are the other half, and they are ASYMMETRIC: `String(sym)` is legal
 *  (a deliberate spec carve-out), while `Number(sym)` and — what every caller
 *  here actually does — `${sym}` both throw. */
const THROWING_SYMBOLS: unknown[] = [Symbol('x'), Symbol.iterator];

const THROWING: unknown[] = [...THROWING_OBJECTS, ...THROWING_SYMBOLS];

/** Everything else a tampered file can carry. These must keep their exact
 *  `String()`/`Number()` behaviour. */
const BENIGN: unknown[] = [
  undefined, null, '', ' ', '0', '1', '0.5', 'x', 'data',
  0, 1, -1, 0.4, 0.5, NaN, Infinity, -Infinity,
  true, false,
  [], [1], [1, 2], {}, { a: 1 },
  new Date(0), /re/, () => 1,
  '__proto__', 'constructor', 'toString',
];

describe('nothing throws, whatever the file carries', () => {
  it('the throwing set really does throw without the guard', () => {
    // If this ever stops throwing the guards are no longer earning their place
    // — and the tests below would pass vacuously.
    for (const v of THROWING_OBJECTS) {
      expect(() => String(v as string), 'String').toThrow(TypeError);
      expect(() => Number(v as number), 'Number').toThrow(TypeError);
    }
    for (const v of THROWING_SYMBOLS) {
      // The carve-out: String() is fine, the two forms callers use are not.
      expect(() => String(v as string), 'String(symbol)').not.toThrow();
      expect(() => Number(v as number), 'Number(symbol)').toThrow(TypeError);
      expect(() => `${v as string}`, 'template(symbol)').toThrow(TypeError);
    }
  });

  it('valueStr / valueNum / plainStr never throw', () => {
    for (const v of [...THROWING, ...BENIGN]) {
      expect(() => valueStr(v)).not.toThrow();
      expect(() => valueNum(v)).not.toThrow();
      expect(() => plainStr(v)).not.toThrow();
    }
  });

  it('and their results are always the declared type', () => {
    for (const v of [...THROWING, ...BENIGN]) {
      expect(typeof valueStr(v)).toBe('string');
      expect(typeof plainStr(v)).toBe('string');
      expect(typeof valueNum(v)).toBe('number');
    }
  });

  it('a throwing value degrades to the empty string / NaN', () => {
    for (const v of THROWING) {
      expect(valueStr(v)).toBe('');
      expect(plainStr(v)).toBe('');
      expect(valueNum(v)).toBeNaN();
    }
  });

  it('the result is safe to INTERPOLATE, which is what every caller does', () => {
    // `String(symbol)` is legal but `${symbol}` throws — the guards must make
    // the two agree, because callers build template literals.
    for (const v of [...THROWING, ...BENIGN]) {
      expect(() => `${valueStr(v)}${valueNum(v)}${plainStr(v)}`).not.toThrow();
    }
  });
});

describe('the drop-ins change NOTHING that did not throw', () => {
  it('valueStr matches String(v ?? "") on every benign value', () => {
    for (const v of BENIGN) {
      expect(valueStr(v), String(typeof v)).toBe(String(v ?? ''));
    }
  });

  it('valueNum matches Number(v) on every benign value', () => {
    for (const v of BENIGN) {
      const expected = Number(v as number);
      const got = valueNum(v);
      if (Number.isNaN(expected)) expect(got, String(v)).toBeNaN();
      else expect(got, String(v)).toBe(expected);
    }
  });

  it('keeps the coercions other modules PIN', () => {
    // imageTextureSpec reads `repeat` as clamp for null / '' / 0 — i.e. the
    // `Number()` zero, not a NaN. Changing this silently flips every Image
    // node with a stored `repeat: null` from clamp to repeat.
    expect(valueNum(null)).toBe(0);
    expect(valueNum('')).toBe(0);
    expect(valueNum(' ')).toBe(0);
    expect(valueNum(false)).toBe(0);
    expect(valueNum(true)).toBe(1);
    expect(valueNum([])).toBe(0);
    expect(valueNum(['7'])).toBe(7);
    expect(valueNum(undefined)).toBeNaN();
    expect(valueNum('x')).toBeNaN();
    expect(valueNum({})).toBeNaN();
    // …and the string side's `?? ''` default.
    expect(valueStr(null)).toBe('');
    expect(valueStr(undefined)).toBe('');
    expect(valueStr(0)).toBe('0');
    expect(valueStr(false)).toBe('false');
  });
});

describe('plainStr is the STRICTER one, on purpose', () => {
  it('passes strings and numbers through and refuses everything else', () => {
    expect(plainStr('a')).toBe('a');
    expect(plainStr('')).toBe('');
    expect(plainStr(12)).toBe('12');
    expect(plainStr(0)).toBe('0');
    expect(plainStr(NaN)).toBe('NaN');
    for (const v of [null, undefined, true, false, [], [1], {}, () => 1, new Date(0)]) {
      expect(plainStr(v), String(typeof v)).toBe('');
    }
  });

  it('refuses a huge array WITHOUT coercing it', () => {
    // The quiet variant: this coerces without throwing, and `valueStr` would
    // faithfully build the multi-megabyte string. `plainStr` is what the Image
    // node's per-render re-measure key uses precisely so it cannot.
    const huge = new Array(200_000).fill(7);
    expect(plainStr(huge)).toBe('');
    expect(valueStr(huge).length).toBeGreaterThan(100_000);
  });
});
