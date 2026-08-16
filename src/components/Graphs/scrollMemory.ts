/**
 * Scroll-offset memory for node-editor.html's overview table (GraphsPage).
 *
 * The page's one scrollport is `.gp__tablewrap` and the table runs to ~82 rows
 * — taller still now that the Graph column draws its tiles at canvas scale — so
 * the dominant workflow (edit a description near the bottom → Save → the /__nd
 * write reloads the page through HMR) used to dump the user back at row 1 every
 * time. This module is the pure half of remembering where they were.
 *
 * Pure so it can be TESTED: vitest runs under `node` with no jsdom, so the DOM
 * effect that drives this cannot be covered, but the parse/clamp can — and that
 * is exactly where the untrusted input lands. localStorage is writable by
 * anything at this origin (the same trust level `sanitizeDrawings` /
 * `sanitizeEdgeExtras` reason about), so every field is VALIDATED, never
 * coerced: `Number('')` is 0 and `Number('١٢')` is 12, and a silent 0 here is a
 * scroll position, not a crash, which is the kind of bug nobody reports.
 *
 * Storage is localStorage, not sessionStorage: this page is routinely opened in
 * a FRESH TAB (from the app's toolbar, or by pasting the URL), where a session
 * store carries nothing — "remembered" would silently mean "sometimes". It is
 * also the app's only persistence convention (`fs:` keys via readPersisted).
 *
 * The value is `"<top>,<left>"` rather than JSON on purpose: two integers need
 * no object, and a comma pair has no prototype-pollution surface at all, so it
 * needs neither `JSON.parse` nor the shared deny-list reviver.
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

/**
 * Digits only, so an empty field, whitespace, a sign, an exponent, a hex
 * literal or a non-ASCII digit is a REJECTION rather than a silent number.
 * `\d` without the `u` flag is exactly [0-9], which is what makes the
 * Arabic-Indic case (`Number('١٢') === 12`) fall out for free.
 */
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

/**
 * Integers only — sub-pixel offsets are noise, and rounding is what keeps the
 * serialized form inside MAX_RAW. Non-finite input serializes to 0 rather than
 * writing "NaN", which the parser would reject on the way back in (so a bad
 * write can never poison a later read either way).
 */
export function serializeScrollPos(p: ScrollPos): string {
  const c = (v: number) =>
    Number.isFinite(v) ? Math.min(MAX_SCROLL_PX, Math.max(0, Math.round(v))) : 0;
  return `${c(p.top)},${c(p.left)}`;
}

/**
 * Clamp to the scrollport's live extents. The browser clamps a scrollTop write
 * anyway; doing it here is what makes the restore loop's "did it land?" test
 * meaningful — the loop retries while the table is still growing, and without
 * an explicit target it could not tell a clamp from an arrival.
 */
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
  /** The offset this event is measured against: what the restore last WROTE,
   *  read back after the write — or, once a forced clamp has been followed,
   *  where that clamp left the port (the caller re-fingerprints it; see
   *  `isForcedClamp`). `null` if the restore never wrote one. */
  restoreWrote: ScrollPos | null;
  /** Where the port is now, as observed by a `scroll` event. */
  now: ScrollPos;
  /** The port's live extents at that same moment — `scrollHeight - clientHeight`
   *  and `scrollWidth - clientWidth`. This is what tells a movement the BROWSER
   *  was forced into apart from one the user chose; see `isForcedClamp`. */
  max: ScrollPos;
}

/**
 * Did the port move only because the offset we put there stopped EXISTING?
 *
 * A scrollport cannot hold an offset past its own extent, so when the content
 * shrinks under a parked offset the browser clamps `scrollTop` down and fires a
 * `scroll` event that is indistinguishable, by position alone, from the user
 * scrolling up. That is not hypothetical here: the deferred `document.fonts`
 * pass exists precisely because the webfont subsets land late and re-measure
 * every row, and MEASURED on the built page (headless Chrome 1500x900) a table
 * that shrinks after the restore has landed clamps 10992 → 6143 and the old
 * gate persisted that over the good offset, with no input of any kind.
 *
 * The evidence that separates the two is the EXTENT, not the direction: a move
 * DOWNWARD (smaller offset) on an axis whose maximum has fallen below what we
 * wrote is forced — there was nowhere else for the port to be. A move upward,
 * or a move on an axis that could still hold our offset, is someone's choice.
 *
 * Deliberately NOT `now.top === max.top` (the clamp's exact resting place):
 * layout is still settling when the event arrives, and the extent read one tick
 * later was measured 105px taller than the offset the clamp had produced. The
 * `max < wrote` form needs no such coincidence.
 *
 * The caller RE-FINGERPRINTS `restoreWrote` to the clamped position when this
 * is true, which is what keeps the rule from swallowing the user: once the port
 * is where the browser forced it, the next movement is measured from there, so
 * a genuine scroll inside the now-shorter table opens the gate normally.
 *
 * Scroll ANCHORING — the browser's other unbidden adjustment, and the one that
 * actually bit — is not handled here and cannot be: it INCREASES the offset as
 * the rows above the viewport get taller, which is the exact shape of a user
 * scrolling down, and no extent can contradict it. It is turned off in CSS
 * instead (`overflow-anchor: none` on `.gp__tablewrap`), where the reason it
 * must stay off is documented.
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
 * May this `scroll` event's position be written back over the stored offset?
 *
 * The gate exists because "the chase is over" and "we have a position worth
 * storing" are DIFFERENT things, and conflating them ratchets the remembered
 * offset toward the top of the table. Four of the ways the chase ends — running
 * out of frame budget, a filter changing the row set under it, and any of the
 * abort gestures — leave the port on whatever the browser CLAMPED the write to
 * while the 82 rows were still growing. Persisting that clamp replaces a good
 * 4000 with a 600, so the next restore aims at 600, ends a little shorter
 * still, and the position walks upward one save-edit-reload cycle at a time —
 * exactly the symptom this module was written to remove.
 *
 * So the gate opens on EVIDENCE, of one of three kinds:
 *
 *  - Nothing was stored. There is nothing to lose, so anything is an
 *    improvement; without this a first visit could never record anything.
 *  - The chase is over and the restore never wrote anything, so nothing it did
 *    can be mistaken for the user's own position.
 *  - The port moved somewhere neither the restore nor the browser's own
 *    bookkeeping put it. The restore reads its own write back (so a `scroll`
 *    event echoing that write matches exactly, however many frames later it is
 *    dispatched), and `isForcedClamp` accounts for the one movement the browser
 *    imposes by itself — the clamp that follows the table getting shorter.
 *    What is left over is someone choosing a position.
 *
 * Landing on the target deliberately does NOT open it: the port is then at
 * precisely the value already in storage, so writing it back is a no-op.
 *
 * That last clause used to be the whole gate — "any post-chase mismatch is the
 * user" — and this comment claimed a protection the code did not have: a
 * shrink-clamp the user never caused reads as a mismatch, opens the gate, and
 * persists a clamped-short offset over the good one. MEASURED, with no input at
 * all: park at 10992, reload, the restore LANDS on 10992, then the table gets
 * shorter and 6143 is written to storage. `isForcedClamp` is that missing half.
 *
 * `chaseOver` is required before anything the restore did — or failed to do —
 * counts, so a stray reflow mid-chase cannot be read as user intent (it gates
 * the "never wrote" branch as well as the mismatch). It costs nothing: every
 * gesture that can scroll this page — wheel, touch, a scrollbar drag, a key —
 * fires one of the restore's document-level abort events FIRST, which ends the
 * chase synchronously, before the `scroll` event it produces.
 *
 * The consequence to know about: a shrink the USER caused (a category chip, a
 * search query) is suppressed by the same rule, so the stored offset survives
 * the filter instead of being replaced by the clamp. That is the better of the
 * two readings — the offset was recorded against the unfiltered table and is
 * still exactly right for it — and the moment the user scrolls the filtered
 * table themselves, that movement is measured from the clamped position and
 * saves normally.
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
 * A cheap identity for "which rows the table is showing".
 *
 * The mount restore is a multi-frame chase (rows keep growing until every
 * Graph cell has been measured), and a stored offset is only meaningful
 * against the table that PRODUCED it: if the user clicks a category chip
 * mid-chase, 82 rows can become 8, the browser clamps the offset to ~0, and
 * the user starts reading — at which point re-applying the offset against the
 * new extent is not a restore, it is a jump to the bottom of a list they never
 * scrolled. So the restore records this key when it arms and abandons itself
 * the moment it stops matching.
 *
 * `count` alone would miss a filter swap that happens to keep the same number
 * of rows; the filter/sort fields alone would miss a row set changed by an
 * EDIT (typing in a description while a search query is active re-filters).
 * Both together cover it, and both are already at hand each render.
 *
 * The two free-form fields are LENGTH-PREFIXED so no query can spell out
 * another state's key — the separator alone is not enough (`a` + `bc` and
 * `ab` + `c` would otherwise collide once a value contains one).
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
