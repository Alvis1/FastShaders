/**
 * Document-level chrome for an in-flight pointer drag (splitter, asset bar).
 *
 * Shared so every drag suppresses selection the SAME way. Setting
 * `user-select: none` on <body> is not enough: panes that declare their own
 * user-select (Monaco, inputs, the node cards) win over an inherited value, so
 * dragging across them still painted selection highlights — which read as a
 * rendering glitch. The class below overrides them app-wide for the duration
 * of the gesture instead.
 */

const DRAG_CLASS = 'fs-dragging';

let activeDrags = 0;

/**
 * Pin the cursor for the whole document and kill text selection.
 *
 * Returns the matching end call for THIS gesture — idempotent, so callers can
 * fire it from pointerup, pointercancel, AND unmount without bookkeeping. The
 * document state is refcounted across gestures: two simultaneous captured
 * drags (multi-touch — one finger per grip) each hold their own token, and the
 * chrome only clears when the LAST one ends, so the first finger lifting can't
 * restore text selection under the second mid-gesture.
 */
export function beginDragChrome(cursor: 'col-resize' | 'row-resize'): () => void {
  activeDrags++;
  document.body.style.cursor = cursor;
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
