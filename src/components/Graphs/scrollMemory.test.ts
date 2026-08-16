import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  SCROLL_KEY,
  MAX_SCROLL_PX,
  parseScrollPos,
  serializeScrollPos,
  clampScrollPos,
  rowSetKey,
  shouldOpenSaveGate,
  isForcedClamp,
  type RowSetState,
  type SaveGateState,
  type ScrollPos,
} from './scrollMemory';

/**
 * The stored scroll offset is ordinary localStorage — writable by anything at
 * this origin — and GraphsPage feeds it straight into `el.scrollTop`. Nothing
 * here can crash a page on its own, which is precisely why it would go
 * unvalidated: the failure mode is a silently wrong number (`Number('')` is 0,
 * `Number('١٢')` is 12), and a scroll position that is quietly wrong reads as
 * the feature not working rather than as a bug worth reporting.
 */

describe('scrollMemory', () => {
  it('keeps the key on the app-wide fs: namespace', () => {
    expect(SCROLL_KEY).toBe('fs:nodeEditorScroll');
  });

  it('round-trips a real offset', () => {
    const raw = serializeScrollPos({ top: 1234, left: 56 });
    expect(raw).toBe('1234,56');
    expect(parseScrollPos(raw)).toEqual({ top: 1234, left: 56 });
  });

  it('round-trips the origin', () => {
    expect(parseScrollPos(serializeScrollPos({ top: 0, left: 0 }))).toEqual({ top: 0, left: 0 });
  });

  it.each([
    ['nothing stored', null],
    ['empty', ''],
    ['one field', '12'],
    ['three fields', '1,2,3'],
    ['blank fields', '  ,  '],
    ['letters', 'abc,0'],
    ['negative', '-5,0'],
    ['negative left', '0,-5'],
    // Number() would happily take all four of these.
    ['exponent', '1e3,0'],
    ['NaN', 'NaN,0'],
    ['Infinity', 'Infinity,0'],
    ['hex', '0x10,0'],
    ['float', '12.5,0'],
    ['padded', ' 12,0'],
    ['plus sign', '+12,0'],
    // Arabic-Indic digits: Number('١٢') === 12, so a Number()-based check would
    // accept these. `\d` (no /u flag) is [0-9] and rejects them.
    ['arabic-indic digits', '١٢,0'],
    ['over MAX_SCROLL_PX', '99999999,0'],
    ['semicolon separator', '10;20'],
  ] as const)('rejects %s', (_label, raw) => {
    expect(parseScrollPos(raw)).toBeNull();
  });

  it('refuses an over-long blob before splitting it', () => {
    expect(parseScrollPos('1'.repeat(41))).toBeNull();
    expect(parseScrollPos(`${'9'.repeat(30)},${'9'.repeat(30)}`)).toBeNull();
  });

  it('accepts the largest representable offset', () => {
    expect(parseScrollPos(`${MAX_SCROLL_PX},0`)).toEqual({ top: MAX_SCROLL_PX, left: 0 });
  });

  it('serializes non-finite and negative input to a parseable zero', () => {
    expect(serializeScrollPos({ top: -3, left: Number.NaN })).toBe('0,0');
    // Infinity is NOT finite, so it takes the 0 branch rather than the clamp —
    // "the top of the table" is the honest reading of a broken offset.
    expect(serializeScrollPos({ top: Number.POSITIVE_INFINITY, left: 0 })).toBe('0,0');
    // A finite over-large offset IS clamped, so it stays parseable.
    expect(serializeScrollPos({ top: 5e8, left: 0 })).toBe(`${MAX_SCROLL_PX},0`);
    // Whatever we write must survive our own parser, or a bad write would
    // silently disable the feature until the key is cleared by hand.
    expect(parseScrollPos(serializeScrollPos({ top: -3, left: Number.NaN }))).toEqual({ top: 0, left: 0 });
  });

  it('rounds to integers', () => {
    expect(serializeScrollPos({ top: 1.6, left: 2.4 })).toBe('2,2');
  });

  it('clamps to the live extents', () => {
    expect(clampScrollPos({ top: 9e9, left: 0 }, 500, 0)).toEqual({ top: 500, left: 0 });
    expect(clampScrollPos({ top: 120, left: 40 }, 500, 300)).toEqual({ top: 120, left: 40 });
  });

  it('treats a scrollport with no overflow as extent 0, never negative', () => {
    // scrollHeight - clientHeight goes NEGATIVE mid-mount (sub-pixel layout, or
    // an unmeasured table), and a negative target would scroll the port to a
    // negative offset the browser then clamps — indistinguishable from "landed".
    expect(clampScrollPos({ top: 300, left: 300 }, -12, -4)).toEqual({ top: 0, left: 0 });
  });
});

/**
 * The mount restore chases the table's final height across several frames, so
 * the row set can change UNDER it — every filter control lives outside the
 * scrollport, and a chip click mid-chase turns 82 rows into 8. The restore arms
 * itself with this key and abandons the chase the moment it stops matching; if
 * the key missed a change, the deferred font pass would re-clamp the old offset
 * against the new extent and yank the user to the bottom of a list they never
 * scrolled — and the save gate, open by then, would persist it.
 */
describe('rowSetKey', () => {
  const base: RowSetState = {
    count: 82,
    query: '',
    cats: [],
    hiddenOnly: false,
    sortKey: 'category',
    sortAsc: true,
  };

  it('is stable for an unchanged table', () => {
    expect(rowSetKey(base)).toBe(rowSetKey({ ...base }));
  });

  it('ignores the order the categories were picked in', () => {
    // `activeCats` is a Set spread into an array; re-picking the same two chips
    // in the other order is the SAME table and must not abandon a restore.
    expect(rowSetKey({ ...base, cats: ['math', 'noise'] })).toBe(
      rowSetKey({ ...base, cats: ['noise', 'math'] }),
    );
  });

  it.each([
    // A filter that happens to keep the row count: only the filter fields see it.
    ['a different category filter', { cats: ['math'] }],
    ['a second category', { cats: ['math', 'noise'] }],
    ['the hidden-only toggle', { hiddenOnly: true }],
    ['the sort column', { sortKey: 'name' }],
    ['the sort direction', { sortAsc: false }],
    ['the search box', { query: 'noise' }],
    // ...and a row set changed by an EDIT (typing in a description while a
    // query is active re-filters), which no filter field would report.
    ['the row count alone', { count: 8 }],
  ] as const)('changes with %s', (_label, patch) => {
    expect(rowSetKey({ ...base, ...patch })).not.toBe(rowSetKey(base));
  });

  it('cannot be forged by a query carrying the field separator', () => {
    // `query` is user text and can hold ANY character, the separator included
    // (a paste, or a stray key). Because the two free-form fields are
    // LENGTH-PREFIXED, typed text can never shift a field boundary and make two
    // different tables produce one key — which is what stops a filter change
    // from slipping past the restore's guard.
    const SEP = '\u0001';
    expect(rowSetKey({ ...base, cats: ['a'], query: 'b' })).not.toBe(
      rowSetKey({ ...base, cats: [], query: `a${SEP}b` }),
    );
    expect(rowSetKey({ ...base, query: `x${SEP}y` })).not.toBe(
      rowSetKey({ ...base, query: `x${SEP}${SEP}y` }),
    );
    // ...and separator-laden text is still STABLE for an unchanged table, or one
    // paste into the search box would abandon every restore that followed it.
    expect(rowSetKey({ ...base, query: `x${SEP}y` })).toBe(
      rowSetKey({ ...base, query: `x${SEP}y` }),
    );
  });
});

/**
 * "The chase is over" and "we have a position worth storing" are different
 * facts, and conflating them is what walks the remembered row toward the top.
 * Only ONE of the ways the chase ends means it landed; the others (out of frame
 * budget, the row set changed under it, any abort gesture) leave the port on
 * whatever the browser clamped the write to while the 82 rows were still
 * growing — and pressing Cmd+R is itself an abort gesture, so the user's own
 * repeated refresh is the fastest way to hit them.
 */
describe('shouldOpenSaveGate', () => {
  /** Mid-chase: the restore has written 600 of a stored 4000 and nothing else
   *  has touched the port. The table is 11000px worth of scrollable. */
  const clamped: SaveGateState = {
    hadStored: true,
    chaseOver: true,
    restoreWrote: { top: 600, left: 0 },
    now: { top: 600, left: 0 },
    max: { top: 11000, left: 0 },
  };

  it('opens when nothing was stored — there is nothing to lose', () => {
    // Without this a first visit could never record anything: no stored offset
    // means no restore, so no movement is ever attributable to it.
    expect(shouldOpenSaveGate({ ...clamped, hadStored: false })).toBe(true);
    expect(shouldOpenSaveGate({ ...clamped, hadStored: false, chaseOver: false })).toBe(true);
  });

  it('stays shut where the chase ended, however it ended', () => {
    // Budget exhaustion, a rowKey mismatch and every abort gesture all end the
    // chase with the port on a clamp. The old gate opened on all of them.
    expect(shouldOpenSaveGate(clamped)).toBe(false);
  });

  it('stays shut when the restore landed on its target', () => {
    // The port is at exactly the stored value, so a write back is a no-op.
    expect(
      shouldOpenSaveGate({
        hadStored: true,
        chaseOver: true,
        restoreWrote: { top: 4000, left: 0 },
        now: { top: 4000, left: 0 },
        max: { top: 11000, left: 0 },
      }),
    ).toBe(false);
  });

  it('opens when the port moved somewhere the restore did not put it', () => {
    expect(shouldOpenSaveGate({ ...clamped, now: { top: 620, left: 0 } })).toBe(true);
    // Horizontal counts too — the table scrolls sideways on a narrow window.
    expect(
      shouldOpenSaveGate({ ...clamped, now: { top: 600, left: 40 }, max: { top: 11000, left: 200 } }),
    ).toBe(true);
  });

  it('ignores movement while the chase is still driving the port', () => {
    // A reflow mid-chase is not user intent. Costs nothing: every gesture that
    // can scroll this page fires one of the restore's document-level abort
    // events FIRST, which ends the chase synchronously, before the scroll event
    // that gesture produces.
    expect(shouldOpenSaveGate({ ...clamped, chaseOver: false, now: { top: 620, left: 0 } })).toBe(
      false,
    );
  });

  it('opens on any movement once a chase that never wrote is over', () => {
    // No scrollport, or a restore that bailed before its first write: nothing
    // it wrote can be mistaken for the user's own position.
    expect(shouldOpenSaveGate({ ...clamped, restoreWrote: null })).toBe(true);
  });

  it('stays shut when the table shrank out from under a LANDED restore', () => {
    // The measured case, with no input of any kind: parked at 10992, the
    // restore lands there, then the table gets shorter and the browser clamps
    // the port to 6143 because 10992 no longer exists. The old gate read that
    // as the user scrolling and wrote 6143 over the good 10992.
    expect(
      shouldOpenSaveGate({
        hadStored: true,
        chaseOver: true,
        restoreWrote: { top: 10992, left: 0 },
        now: { top: 6143, left: 0 },
        max: { top: 6248, left: 0 },
      }),
    ).toBe(false);
  });

  it('still opens for a user scrolling UP after a landed restore', () => {
    // The naive form of the fix — "only open when the port moved DOWN the page"
    // — would suppress exactly this, and the user's own position would silently
    // stop being remembered. The extent is what distinguishes them: 2000 is not
    // forced, because the port could still hold 4000.
    expect(
      shouldOpenSaveGate({
        hadStored: true,
        chaseOver: true,
        restoreWrote: { top: 4000, left: 0 },
        now: { top: 2000, left: 0 },
        max: { top: 11000, left: 0 },
      }),
    ).toBe(true);
  });
});

/**
 * The one movement the browser makes on its own that this module can identify.
 * (Scroll ANCHORING is the other, and it deliberately is not here: it nudges
 * the offset DOWN the page as content above the viewport grows — the exact
 * shape of a user scrolling down — so it is turned off in CSS instead. The
 * pin for that lives at the bottom of this file.)
 */
describe('isForcedClamp', () => {
  it('accepts a shrink the port could not hold', () => {
    expect(isForcedClamp({ top: 10992, left: 0 }, { top: 6143, left: 0 }, { top: 6248, left: 0 })).toBe(
      true,
    );
  });

  it('does not require the clamp to rest exactly on the new maximum', () => {
    // Layout is still settling when the event arrives: MEASURED, the extent read
    // one tick after the clamp was 105px TALLER than the offset the clamp had
    // produced. A `now.top === max.top` rule would have missed the real case.
    expect(isForcedClamp({ top: 900, left: 0 }, { top: 500, left: 0 }, { top: 600, left: 0 })).toBe(
      true,
    );
  });

  it('rejects a move the port could have held', () => {
    // Same downward direction, but 4000 still exists — so something CHOSE 2000.
    expect(isForcedClamp({ top: 4000, left: 0 }, { top: 2000, left: 0 }, { top: 9000, left: 0 })).toBe(
      false,
    );
  });

  it('rejects a move down the page', () => {
    // A shrink can never raise the offset, so this is always someone's choice —
    // including scroll anchoring's nudge, which is why that is a CSS problem.
    expect(isForcedClamp({ top: 4000, left: 0 }, { top: 4400, left: 0 }, { top: 4400, left: 0 })).toBe(
      false,
    );
  });

  it('rejects a standstill — there is nothing to explain', () => {
    expect(isForcedClamp({ top: 4000, left: 0 }, { top: 4000, left: 0 }, { top: 4000, left: 0 })).toBe(
      false,
    );
  });

  it('needs EVERY moved axis to be forced', () => {
    const wrote = { top: 4000, left: 300 };
    // Vertical forced, horizontal chosen → not a clamp.
    expect(isForcedClamp(wrote, { top: 900, left: 100 }, { top: 900, left: 900 })).toBe(false);
    // Both forced.
    expect(isForcedClamp(wrote, { top: 900, left: 100 }, { top: 950, left: 120 })).toBe(true);
    // Only the horizontal axis moved, and it was forced.
    expect(isForcedClamp(wrote, { top: 4000, left: 100 }, { top: 9000, left: 120 })).toBe(true);
  });
});

/**
 * The gate, exercised as the sequence the user actually reported: park at the
 * bottom, then reload again and again. Each reload restores, ends its chase
 * somewhere, and whatever leaves the page tries to flush.
 */
describe('scroll memory across reloads', () => {
  /**
   * One visit, reduced to the decisions that matter. `reachable` is the tallest
   * offset the still-growing table allowed before the chase ended — the clamp.
   * Returns what is in storage when the page goes away.
   */
  function visit(
    stored: ScrollPos | null,
    script: { reachable: number; shrinksTo?: number; userScrollsTo?: number },
  ): ScrollPos | null {
    const want = stored;
    let canSave = !want;
    let restoreWrote: ScrollPos | null = null;
    let chaseOver = false;
    let pos: ScrollPos = { top: 0, left: 0 };
    let max: ScrollPos = { top: script.reachable, left: 0 };

    // Exactly GraphsPage's scroll handler: open the gate on evidence, and
    // otherwise FOLLOW a clamp the browser was forced into.
    const onScroll = (now: ScrollPos) => {
      if (!canSave) {
        if (shouldOpenSaveGate({ hadStored: !!want, chaseOver, restoreWrote, now, max })) {
          canSave = true;
        } else if (restoreWrote && chaseOver && isForcedClamp(restoreWrote, now, max)) {
          restoreWrote = now;
        }
      }
      pos = now;
    };

    if (want) {
      // The chase writes what the table allows and reads it back...
      restoreWrote = { top: Math.min(want.top, script.reachable), left: 0 };
      pos = restoreWrote;
    }
    // ...then ends: landed, out of budget, or aborted by the Cmd+R keydown.
    chaseOver = true;
    // The scroll event OUR OWN write produced arrives a frame later.
    if (restoreWrote) onScroll(restoreWrote);
    if (script.shrinksTo !== undefined) {
      // The table gets shorter (the late webfont swap re-measuring every row).
      // The browser clamps the port because the offset stopped existing — no
      // input of any kind is involved.
      max = { top: script.shrinksTo, left: 0 };
      if (pos.top > script.shrinksTo) onScroll({ top: script.shrinksTo, left: 0 });
    }
    if (script.userScrollsTo !== undefined) onScroll({ top: script.userScrollsTo, left: 0 });

    return canSave ? pos : stored; // pagehide → flush
  }

  it('records the first visit, where there is nothing to lose', () => {
    expect(visit(null, { reachable: 4000, userScrollsTo: 4000 })).toEqual({ top: 4000, left: 0 });
  });

  it('does not ratchet toward the top when reload after reload gives up short', () => {
    let stored = visit(null, { reachable: 4000, userScrollsTo: 4000 });
    for (let i = 0; i < 10; i += 1) {
      // Every reload runs out of frame budget (or is cut short by the next
      // Cmd+R) with the table only 600px tall. The old gate stored that 600,
      // the next restore aimed at 600, and the row walked to the top.
      stored = visit(stored, { reachable: 600 });
      expect(stored).toEqual({ top: 4000, left: 0 });
    }
  });

  it('still follows the user when they scroll somewhere new', () => {
    const stored = visit({ top: 4000, left: 0 }, { reachable: 600, userScrollsTo: 120 });
    expect(stored).toEqual({ top: 120, left: 0 });
  });

  it('keeps a landed restore exactly where it was', () => {
    expect(visit({ top: 4000, left: 0 }, { reachable: 9000 })).toEqual({ top: 4000, left: 0 });
  });

  it('does not ratchet when the table SHRINKS after every landing either', () => {
    // The other direction, and the one the module doc used to claim it handled
    // while the code did the opposite: land on 4000, the fonts swap, the table
    // can only hold 3000, the browser clamps. Nobody scrolled, so the stored
    // offset must survive — otherwise the next visit aims at 3000, shrinks to
    // 2200, and the remembered row walks toward the top exactly as it walked
    // toward the bottom under scroll anchoring.
    let stored: ScrollPos | null = { top: 4000, left: 0 };
    for (let i = 0; i < 10; i += 1) {
      stored = visit(stored, { reachable: 9000, shrinksTo: 3000 });
      expect(stored).toEqual({ top: 4000, left: 0 });
    }
  });

  it('still follows the user when they scroll INSIDE the shrunken table', () => {
    // The clamp is followed rather than ignored, so this movement is measured
    // from 3000 (where the port really is) and not from the 4000 the port can
    // no longer hold — without that it would be suppressed as another clamp and
    // the user's own position would silently stop being saved.
    expect(
      visit({ top: 4000, left: 0 }, { reachable: 9000, shrinksTo: 3000, userScrollsTo: 1200 }),
    ).toEqual({ top: 1200, left: 0 });
  });
});

/**
 * The CSS half of the same job, pinned in source because it is one declaration
 * with no visible effect until months later.
 *
 * `scrollMemory` owns this scrollport's offset across the growth window after
 * mount, and Chrome's scroll anchoring wants to own it too: every Graph cell is
 * zero-height until FitNodeHeading measures its replica, so the table grows by
 * ~600px a frame or two AFTER the restore has landed, and anchoring compensates
 * by pushing the offset down the page. MEASURED on the built page (headless
 * Chrome 1500x900, parked at 6000, reloaded 8x with no input at all):
 *
 *   6000 → 6376 → 6772 → 7201 → 7657 → 8153 → 8663 → 9173 → 9683
 *
 * — the top row walking 2-3 rows per refresh until it hits the bottom, because
 * the gate reads each nudge as the user scrolling. With `overflow-anchor: none`
 * all 8 reloads land on 6000 and the stored value stays "6000,0".
 *
 * No JS rule can replace it: the nudge moves the offset DOWN the page, which is
 * the exact shape of a user scrolling down (`isForcedClamp` covers only the
 * other direction, where the extent proves the move was forced).
 */
describe('GraphsPage.css', () => {
  it('turns scroll anchoring off on the scrollport this module drives', () => {
    const css = readFileSync(fileURLToPath(new URL('./GraphsPage.css', import.meta.url)), 'utf8');
    const block = css.slice(css.indexOf('.gp__tablewrap {'));
    expect(block.slice(0, block.indexOf('}'))).toMatch(/overflow-anchor:\s*none/);
  });
});
