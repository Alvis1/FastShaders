/**
 * Document-level chrome for an in-flight pointer drag (splitter, asset bar,
 * and the node canvas's own connection drags).
 *
 * Shared so every drag suppresses selection the SAME way. Setting
 * `user-select: none` on <body> is not enough: panes that declare their own
 * user-select (Monaco, inputs, the node cards) win over an inherited value, so
 * dragging across them still painted selection highlights — which read as a
 * rendering glitch. The class below overrides them app-wide for the duration
 * of the gesture instead.
 *
 * That `user-select: none` on the pressed element is not a defence either, and
 * the engines disagree about it — which is why a gesture starting INSIDE a
 * React Flow node still needs this. MEASURED 2026-09-18, dragging a wire off a
 * socket across the canvas: Chrome 152 seeds no selection at all (the anchor
 * sits under `.react-flow__node`'s `user-select: none`), while WebKit 26.5
 * anchors at the nearest selectable position and paints **38 selection
 * rectangles** over the nodes and chrome the pointer crosses — the owner's
 * "strange browser selections (partial) highlight", reported from macOS. A
 * grip drag on the same page paints none, because it arms this.
 */

const DRAG_CLASS = 'fs-dragging';

/** Cursors a gesture may pin; `null` = suppress selection only (see below). */
export type DragCursor = 'col-resize' | 'row-resize' | 'move';

let activeDrags = 0;

/**
 * Pin the cursor for the whole document and kill text selection.
 *
 * `cursor` may be null for a gesture that owns no cursor of its own — a
 * connection drag keeps React Flow's — and then the document cursor is left
 * exactly as it was. The refcount is shared either way, so a cursor-less
 * gesture overlapping a grip drag cannot strip that grip's cursor: only the
 * LAST end call clears anything, and clearing a cursor nobody set is a no-op.
 *
 * Returns the matching end call for THIS gesture — idempotent, so callers can
 * fire it from pointerup, pointercancel, AND unmount without bookkeeping. The
 * document state is refcounted across gestures: two simultaneous captured
 * drags (multi-touch — one finger per grip) each hold their own token, and the
 * chrome only clears when the LAST one ends, so the first finger lifting can't
 * restore text selection under the second mid-gesture.
 */
export function beginDragChrome(cursor: DragCursor | null): () => void {
  activeDrags++;
  if (cursor) document.body.style.cursor = cursor;
  document.documentElement.classList.add(DRAG_CLASS);
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    activeDrags--;
    if (activeDrags === 0) {
      document.body.style.cursor = '';
      document.documentElement.classList.remove(DRAG_CLASS);
    }
  };
}
