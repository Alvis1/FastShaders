import { POINT_LIST_MAX_CHARS, formatUnit } from './pointListCodec';

/**
 * The plumbing the two LUT readers share — `readColorRamp` (utils/colorRamp.ts)
 * and `readRgbCurves` (utils/rgbCurves.ts): reading a property of an untrusted
 * `values` without coercing it, the bounded memo every surface's read goes
 * through (codegen, the CPU evaluator, the card art, the editors and the
 * price), and the editor ops' rounding. LEAF beside pointListCodec.ts.
 */

/** Reads a property of an untrusted `values` without coercing either side. */
export function field(values: unknown, key: string): unknown {
  return typeof values === 'object' && values !== null ? (values as Record<string, unknown>)[key] : undefined;
}

/**
 * The memo key of a reader's raw stored values — INJECTIVE, and built ONLY from strings: `String(v)` or a template
 * literal of `v` throws on `{toString:1}`, a Symbol or a throwing `Symbol.toPrimitive` — in render, where nothing
 * catches it.
 *
 * Every string is LENGTH-PREFIXED, so a key decodes back into exactly one tuple of values. Joining the bare text
 * with a separator did not: a `.fastshader` can hold the separator (U+0000) inside a value, so two different
 * crafted nodes shared a key and whichever was read second showed the first one's ramp — in the code, on the card
 * and in the price, flipping with the order the surfaces happened to read them.
 *
 * Two classes of value deliberately share a key, because each reads the same whatever it holds: a string over the
 * codec's cap (`splitRecords` refuses it before any split — default + rejected), so a multi-megabyte hostile value
 * costs a length read per call rather than a hash of the whole string; and a non-string, keyed by its `typeof`.
 */
export function memoKey(raws: readonly unknown[]): string {
  return raws
    .map((v) => (typeof v === 'string' ? (v.length > POINT_LIST_MAX_CHARS ? 'L' : `s${v.length}:${v}`) : `t${typeof v}`))
    .join('\u0000');
}

const MEMO_MAX = 64;

/** A reader's memo: `memoKey(raws)` → the reading `read()` makes of them, at most 64 entries, cleared whole when
 *  full. One per reader, so the two readers' entries never meet. */
export function readerMemo<T>(): (raws: readonly unknown[], read: () => T) => T {
  const memo = new Map<string, T>();
  return (raws, read) => {
    const key = memoKey(raws);
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    const out = read();
    if (memo.size >= MEMO_MAX) memo.clear();
    memo.set(key, out);
    return out;
  };
}

/** A unit coordinate as the canonical string will hold it, so an editor op's result survives the round trip. */
export const roundUnit = (n: number): number => Number(formatUnit(n));
