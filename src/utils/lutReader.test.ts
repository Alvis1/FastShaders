import { describe, it, expect } from 'vitest';
import { field, memoKey, readerMemo, roundUnit } from './lutReader';
import { POINT_LIST_MAX_CHARS } from './pointListCodec';

/**
 * utils/lutReader.ts — the plumbing the Color Ramp and RGB Curves readers
 * share. The memo key is the load-bearing part: every surface (codegen, the
 * CPU evaluator, the card art, the editors, the price) reads a LUT node through
 * the memo, so two different stored values sharing a key show one node's
 * reading on another — and a `.fastshader` chooses the stored values.
 */

/** What a reader can tell apart: an over-cap string reads the same whatever it holds (refused before any split),
 *  and so does every non-string of one `typeof`. Anything else must key apart. */
const readingClass = (v: unknown): string =>
  typeof v === 'string' ? (v.length > POINT_LIST_MAX_CHARS ? 'over-cap' : `string ${JSON.stringify(v)}`) : `typeof ${typeof v}`;

describe('memoKey — injective up to what a reader cannot tell apart', () => {
  it('exhaustive: every pair of values built from separator / prefix / digit fragments keys apart', () => {
    // The fragments the old `'s:' + v` / `'t:' + typeof v` parts joined by U+0000 were made of — the crafted
    // collisions were all spelled with them.
    const FRAG = ['\u0000', 's', 't', ':', '1', 'L', 'x'];
    const strings: string[] = [''];
    for (let len = 1; len <= 3; len++) {
      for (const prefix of strings.filter((s) => s.length === len - 1)) for (const f of FRAG) strings.push(prefix + f);
    }
    const values: unknown[] = [
      ...strings, 'undefined', 's1:x', 'tundefined', 'x'.repeat(POINT_LIST_MAX_CHARS), 'x'.repeat(POINT_LIST_MAX_CHARS + 1),
      'y'.repeat(POINT_LIST_MAX_CHARS + 7), undefined, null, 0, 1, true, {}, [], Symbol('s'),
    ];
    const seen = new Map<string, string>();
    let pairs = 0;
    for (const a of values) {
      for (const b of values) {
        const key = memoKey([a, b]);
        const cls = `${readingClass(a)} | ${readingClass(b)}`;
        const prev = seen.get(key);
        if (prev !== undefined) expect(prev, JSON.stringify(key)).toBe(cls);
        else seen.set(key, cls);
        pairs++;
      }
    }
    expect(pairs).toBeGreaterThan(100_000);
  });

  it('the crafted collisions of the NUL-joined key key apart now', () => {
    // Color Ramp: [stops, interp]; RGB Curves: [C, R, G, B, extend].
    expect(memoKey(['0 #ff0000 1\u0000s:q', undefined])).not.toBe(memoKey(['0 #ff0000 1', 'q\u0000t:undefined']));
    expect(memoKey(['0 0,1 0.5\u0000s:0 0.2,1 1', undefined, undefined, 'q', undefined]))
      .not.toBe(memoKey(['0 0,1 0.5', '0 0.2,1 1', undefined, undefined, 'q\u0000t:undefined']));
  });

  it('never coerces: a hostile toString, a Symbol and a throwing toPrimitive key by their typeof', () => {
    const hostile: unknown[] = [{ toString: 1 }, Symbol('s'), { [Symbol.toPrimitive]: () => { throw new Error('boom'); } }];
    for (const v of hostile) expect(() => memoKey([v])).not.toThrow();
    expect(memoKey([hostile[0]])).toBe(memoKey([null]));
  });

  it('an over-cap string is ONE key, read by its length alone', () => {
    expect(memoKey(['1'.repeat(2_000_000)])).toBe(memoKey(['2'.repeat(POINT_LIST_MAX_CHARS + 1)]));
    expect(memoKey(['1'.repeat(POINT_LIST_MAX_CHARS)])).not.toBe(memoKey(['2'.repeat(POINT_LIST_MAX_CHARS)]));
  });
});

describe('readerMemo / field / roundUnit', () => {
  it('readerMemo returns the cached reading for an equal key and reads anew past its bound', () => {
    const memo = readerMemo<{ n: number }>();
    let reads = 0;
    const read = (v: string) => memo([v], () => ({ n: ++reads }));
    const first = read('a');
    expect(read('a')).toBe(first);
    expect(reads).toBe(1);
    for (let i = 0; i < 64; i++) read(`k${i}`); // fills the bound and clears it
    expect(read('a')).not.toBe(first);
    // Two memos never share entries.
    expect(readerMemo<{ n: number }>()(['a'], () => ({ n: -1 })).n).toBe(-1);
  });

  it('field reads an untrusted values object without coercing either side', () => {
    expect(field({ stops: 'x' }, 'stops')).toBe('x');
    for (const v of [undefined, null, 5, 'stops', true]) expect(field(v, 'stops')).toBeUndefined();
    const hostile = { stops: { toString: 1 } };
    expect(field(hostile, 'stops')).toBe(hostile.stops);
  });

  it('roundUnit is what the canonical string holds', () => {
    expect([roundUnit(0.123456), roundUnit(-3), roundUnit(7), roundUnit(NaN)]).toEqual([0.1235, 0, 1, 0]);
  });
});
