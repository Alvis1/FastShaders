/**
 * Scroll-offset memory for node-editor.html's overview table (GraphsPage): the
 * pure, tested half. Stored in localStorage as `"<top>,<left>"` and VALIDATED,
 * never coerced. Rules and measurements: docs/dev/storage-and-limits.md,
 * `fs:nodeEditorScroll`; pinned by scrollMemory.test.ts.
 */

export const SCROLL_KEY = 'fs:nodeEditorScroll';

export interface ScrollPos {
  top: number;
  left: number;
}

/** Longer than "99999999,99999999" — refuse to even split a planted blob. */
const MAX_RAW = 40;
/** No document is 10 million px tall; past this the value is nonsense, not a
 *  scroll position, and clamping it would hide that rather than reject it. */
export const MAX_SCROLL_PX = 1e7;

/** Digits only: an empty field, a sign, an exponent, hex or a non-ASCII digit is
 *  REJECTED, not a silent number (`\d` without the `u` flag is exactly [0-9]). */
const finiteOffset = (s: string): number | null => {
  if (!/^\d{1,8}$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 && n <= MAX_SCROLL_PX ? n : null;
};

/** `null` = nothing stored, or stored garbage. Never throws. */
export function parseScrollPos(raw: string | null): ScrollPos | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_RAW) return null;
  const parts = raw.split(',');
  if (parts.length !== 2) return null;
  const top = finiteOffset(parts[0]);
  const left = finiteOffset(parts[1]);
  return top === null || left === null ? null : { top, left };
}

/** Integers only, which keeps the form inside MAX_RAW; non-finite input writes
 *  0, never "NaN". */
export function serializeScrollPos(p: ScrollPos): string {
  const c = (v: number) =>
    Number.isFinite(v) ? Math.min(MAX_SCROLL_PX, Math.max(0, Math.round(v))) : 0;
  return `${c(p.top)},${c(p.left)}`;
}

/** Clamp to the scrollport's live extents, so the restore loop can tell a clamp
 *  from an arrival while the table is still growing. */
export function clampScrollPos(p: ScrollPos, maxTop: number, maxLeft: number): ScrollPos {
  return {
    top: Math.min(Math.max(0, p.top), Math.max(0, maxTop)),
    left: Math.min(Math.max(0, p.left), Math.max(0, maxLeft)),
  };
}

/** Where the scrollport is, plus what the restore last put there. */
export interface SaveGateState {
  /** Was there a valid stored offset at mount — i.e. is there anything to lose? */
  hadStored: boolean;
  /** Has the mount restore stopped driving the port (landed, aborted, gave up,
   *  or abandoned because the row set changed under it)? */
  chaseOver: boolean;
  /** What the restore last WROTE (read back), or where a followed forced clamp
   *  left the port. `null` if the restore never wrote one. */
  restoreWrote: ScrollPos | null;
  /** Where the port is now, as observed by a `scroll` event. */
  now: ScrollPos;
  /** The port's live extents at that moment (`scrollHeight - clientHeight`, …). */
  max: ScrollPos;
}

/**
 * Did the port move only because the offset we wrote stopped EXISTING (the table
 * got shorter)? Judged by EXTENT: a smaller offset on an axis whose maximum fell
 * below what we wrote (`max < wrote`, never `now === max`: layout is still
 * settling). The caller re-fingerprints `restoreWrote` when this is true.
 */
export function isForcedClamp(wrote: ScrollPos, now: ScrollPos, max: ScrollPos): boolean {
  const axis = (w: number, n: number, m: number) =>
    n === w ? 'same' : n < w && m < w ? 'forced' : 'chosen';
  const top = axis(wrote.top, now.top, max.top);
  const left = axis(wrote.left, now.left, max.left);
  if (top === 'chosen' || left === 'chosen') return false;
  return top === 'forced' || left === 'forced';
}

/**
 * May this `scroll` event's position overwrite the stored offset? Only on
 * EVIDENCE: nothing was stored; or the chase is over and either the restore never
 * wrote, or the port sits where neither the restore nor a forced clamp put it.
 * Landing on the target does not open it (the value is already stored).
 */
export function shouldOpenSaveGate(s: SaveGateState): boolean {
  if (!s.hadStored) return true;
  if (!s.chaseOver) return false;
  if (!s.restoreWrote) return true;
  if (s.now.top === s.restoreWrote.top && s.now.left === s.restoreWrote.left) return false;
  return !isForcedClamp(s.restoreWrote, s.now, s.max);
}

/** The filter/sort state that decides WHICH rows the table renders. */
export interface RowSetState {
  /** How many rows are rendered right now (`visible.length`). */
  count: number;
  /** The search box, verbatim. */
  query: string;
  /** Active category chips, in any order — a Set has none worth honouring. */
  cats: readonly string[];
  hiddenOnly: boolean;
  sortKey: string;
  sortAsc: boolean;
}

/** Not `,`/`|`: those are typeable, and `query` is user text. */
const ROW_SET_SEP = '\u0001';

/**
 * A cheap identity for "which rows the table is showing"; the mount restore
 * abandons itself when it stops matching. `count` catches a row set changed by
 * an EDIT, the filter/sort fields a swap that keeps the count, and the free-form
 * fields are LENGTH-PREFIXED so no query can spell another state's key.
 */
export function rowSetKey(s: RowSetState): string {
  const cats = [...s.cats].sort().join(',');
  return [
    s.count,
    s.hiddenOnly ? 1 : 0,
    s.sortAsc ? 1 : 0,
    s.sortKey,
    cats.length,
    cats,
    s.query.length,
    s.query,
  ].join(ROW_SET_SEP);
}
