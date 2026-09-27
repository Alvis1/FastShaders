/**
 * A node SETTING stored as a flag in `values` — the Splat Output's `invert`,
 * `lit` and `replaceColor`. ONE rule for all of them, so they cannot drift:
 *
 *  - only an OWN key holding the literal `true` switches the setting on (node
 *    data is untrusted: `'true'`, `1` and an inherited key all read as off,
 *    exactly as the emitter counts them);
 *  - "off" DELETES the key, never writes `false`, so a node switched back off
 *    is byte-for-byte the node that was never touched (the absent-key rule).
 *
 * A zero-import LEAF: the emitter, the parser and the node's UI all read it.
 */

/** Is `key` an OWN property of `raw` holding the literal `true`? */
export function hasTrueFlag(raw: unknown, key: string): boolean {
  return (
    !!raw &&
    typeof raw === 'object' &&
    Object.prototype.hasOwnProperty.call(raw, key) &&
    (raw as Record<string, unknown>)[key] === true
  );
}

/** `values` with the flag switched: `key: true` added, or the key DELETED.
 *  A fresh object; the input is never mutated. */
export function withTrueFlag(values: Readonly<Record<string, unknown>>, key: string, on: boolean): Record<string, unknown> {
  const next: Record<string, unknown> = { ...values };
  if (on) next[key] = true;
  else delete next[key];
  return next;
}
