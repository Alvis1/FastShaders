/**
 * THE MISSED DROP: a file let go anywhere the app does not handle must be a
 * no-op, never a navigation.
 *
 * An unhandled file drop belongs to the BROWSER, and the browsers disagree
 * about what to do with it: Chromium opens the file — the tab navigates to it
 * and the unsaved graph is gone — while WebKit ignores it. That is the whole
 * of the owner's report of 2026-09-19 ("why does the drag drop work only in
 * safari — in chrome it opens a separate tab"): the aim was the same on both,
 * only the browser's answer to a miss differed.
 *
 * The app handles drops on FOUR regions (the canvas, the 3D preview and its
 * sandboxed iframe, the code panel, the cost bar), and they all pair
 * `dragover` + `drop` correctly. The toolbar, the asset browser, the pane
 * seams and every gap between them were left to the browser — MEASURED in
 * Chrome, not inferred. A window-level guard turns all of them into the same
 * no-op WebKit was already giving, which is what made the bug invisible on the
 * owner's machine.
 *
 * `public/podest.html` has carried this guard since it learned the same
 * lesson; the editor never got it.
 *
 * TWO THINGS IT MUST NOT DO:
 *
 * 1. It must not touch INTERNAL drags. Palette tiles, saved groups, presets
 *    and texture cards are HTML5 drags carrying their own `dataTransfer`
 *    types, and `preventDefault` on their `dragover` would make the whole
 *    window a valid drop target for them — the canvas' own handlers decide
 *    where a tile may land. So the guard fires only when the payload is
 *    FILES, the same test the preview iframe's forwarder uses.
 * 2. It must not pre-empt the real drop zones. It listens in the BUBBLE phase
 *    on `window`, so every element handler has already run by the time it
 *    sees the event; calling `preventDefault` after they did is a no-op, and
 *    `preventDefault` never stops propagation, so nothing downstream is lost.
 */

/** Whether a drag carries files (rather than a palette tile or a text selection). */
export function isFileDrag(e: DragEvent): boolean {
  const types = e.dataTransfer?.types;
  if (!types) return false;
  // A DOMStringList in some engines, an array in others — `indexOf` spans both.
  return Array.prototype.indexOf.call(types, 'Files') !== -1;
}

/**
 * Swallow file drags the app did not claim. Returns the detach function.
 *
 * Both events are needed and for different reasons: without `dragover` the
 * browser never offers the drop at all, and without `drop` it performs its
 * own default on the one that lands.
 */
export function installFileDropGuard(target: Window = window): () => void {
  const swallow = (e: Event) => {
    if (!isFileDrag(e as DragEvent)) return;
    e.preventDefault();
  };
  target.addEventListener('dragover', swallow);
  target.addEventListener('drop', swallow);
  return () => {
    target.removeEventListener('dragover', swallow);
    target.removeEventListener('drop', swallow);
  };
}
