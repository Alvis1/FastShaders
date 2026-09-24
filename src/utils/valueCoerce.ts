/**
 * COERCING AN UNTRUSTED `values` ENTRY — the guards, in ONE place.
 *
 * A node's `values` map is typed `Record<string, string | number>` and that
 * type is a LIE at runtime: `rawNodeValues` (types/node.types.ts) only checks
 * that the thing is an object, and the map arrives verbatim from a
 * `.fastshader`, `fs:graph` or `fs:savedGroups` — all three adversarial by the
 * project's own rule. No sanitizer coerces the entries: `sanitizeImageNodes`
 * deliberately leaves a NON-STRING payload in place (its test is
 * `typeof url === 'string'`, so anything else falls through untouched), and
 * `width`/`height` are seen by no sanitizer at all.
 *
 * WHY THIS IS NOT DEFENSIVE TIDINESS. `String(v)` and `Number(v)` both run
 * ToPrimitive, which THROWS on a value whose `toString`/`valueOf` are not
 * callable:
 *
 *     String({ toString: 1 })   // TypeError: Cannot convert object to primitive value
 *     Number({ toString: 1 })   // the same
 *     Number(Symbol('x'))       // TypeError: Cannot convert a Symbol value to a number
 *
 * `{"imageB64": {"toString": 1}}` in a shared shader is four characters of
 * JSON. Thrown from a React render body — or from `graphToCode`, which the
 * sync engine runs inside one — it reaches a tree with NO error boundary
 * anywhere in this app, so React unmounts the root and the screen goes blank.
 * The graph is already in the store by then, and the 300 ms autosave is a
 * `useAppStore.subscribe` OUTSIDE React, so it writes the poisoned graph back
 * to `fs:graph` and the app blanks again on every reload. Measured 2026-09-19:
 * one tampered key, app unusable until localStorage is cleared by hand.
 *
 * A LEAF that imports nothing — the engine, the utils and the node components
 * all read it, and a module in that position must never sit inside the store's
 * import cycle (the costTable lesson).
 *
 * TWO SHAPES, and picking the wrong one is how a fix becomes a regression:
 *
 *  - {@link valueStr} / {@link valueNum} are DROP-INS for `String()` /
 *    `Number()`. They change NOTHING for any value that does not throw —
 *    `Number(null)` is still 0, `Number('')` is still 0, `String(1)` is still
 *    '1' — because those coercions are load-bearing and pinned (the Image
 *    node's `repeat` reads `null` and `''` as CLAMP, against a
 *    `historicalReads` reference in `imageTextureSpec.test.ts`). They only
 *    replace the throw with a fallback.
 *  - {@link plainStr} is STRICTER on purpose, for the places where a
 *    non-primitive means "absent" anyway AND coercing it would be waste: a
 *    million-element array coerces WITHOUT throwing and would build a
 *    multi-megabyte string every time it is read.
 *
 * None of them says what a value SHOULD be: a caller that needs a default
 * still writes `?? 'color'`, and a caller that validates a range still
 * validates it. They only make the coercion itself unable to throw.
 */

/**
 * `String(v)`, except that a value ToPrimitive cannot convert yields '' rather
 * than throwing. `null` and `undefined` yield '' too, matching the `String(v ??
 * '')` form every call site used before this existed.
 */
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
 * `Number(v)`, except that a value ToPrimitive cannot convert yields `NaN`
 * rather than throwing.
 *
 * NaN and not 0: every caller already tests the result (`Number.isInteger`,
 * `Number.isFinite`, a range check) and NaN fails all of them, while 0 is a
 * value some of them ACCEPT. Everything `Number()` handles without throwing is
 * passed straight to it, so `null` → 0 and `''` → 0 still hold.
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
 * A `values` entry that is ALREADY a string or a number, as a string — '' for
 * everything else, with no coercion attempted.
 *
 * Use it where a non-primitive is meaningless to the caller anyway and the
 * coercion would be pure cost: the Image node's handle re-measure key reads
 * five entries on every render of every Image node, and `String([…1e6
 * numbers])` there would build a multi-megabyte string twice a frame — no
 * throw, no crash, just a tab that stops responding.
 */
export function plainStr(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
}
