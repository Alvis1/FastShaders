/**
 * Coercing an UNTRUSTED `values` entry without throwing: `String(v)` and
 * `Number(v)` run ToPrimitive, which throws on `{ toString: 1 }` or a symbol,
 * and nothing above a render catches it. `valueStr`/`valueNum` are DROP-INS
 * that differ only where the built-in would throw; `plainStr` is strict.
 * A LEAF with no dependencies (pinned by imageTextureSpec.test.ts).
 * See docs/dev/storage-and-limits.md.
 */

/** `String(v)` that yields '' instead of throwing; nullish is '' too. */
export function valueStr(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return '';
  // `String(symbol)` is legal, but a template literal on one throws — and
  // every caller here interpolates. '' keeps the two consistent.
  if (typeof v === 'symbol') return '';
  try {
    return String(v);
  } catch {
    return '';
  }
}

/**
 * `Number(v)` that yields NaN instead of throwing. NaN and not 0: callers test
 * the result (`isFinite`, a range check) and 0 is a value some of them ACCEPT.
 */
export function valueNum(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'symbol') return NaN;
  try {
    return Number(v);
  } catch {
    return NaN;
  }
}

/**
 * A string or number entry as a string, '' for everything else, with NO
 * coercion: a huge array coerces without throwing and would build megabytes of
 * string on every read (the Image node's per-render re-measure key).
 */
export function plainStr(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
}
