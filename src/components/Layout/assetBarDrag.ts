/**
 * The asset bar's height, driven from OUTSIDE the bar — by the column seam's
 * junction with the bar's top edge (SplitPane.tsx), where a press drags the
 * column split and the bar's height together.
 *
 * Same module-level publisher shape (and the same justification) as tileDrag.ts:
 * two components in different subtrees that must agree on a value at pointer
 * rate, with no React render between them. `push` deliberately does NOT go
 * through React state — the bar's height drives the tile strip's inherited
 * `zoom`, and a state write per pointermove re-lays-out ~1,700 elements a
 * frame (see ContentBrowser's `paintHeight`, which is what `push` calls).
 * `commit` bakes the final value in once, at pointerup.
 *
 * This is a DELIBERATE drag, not the old push-each-other coupling (retired
 * 2026-09-16 with the grip tabs): nothing here moves the bar unless the user
 * has the junction under their pointer.
 */

export interface AssetBarDragHandle {
  /** Client-space y of the bar's top edge (the seam's centre-line). NaN while
   *  the bar is not mounted. */
  edgeY(): number;
  /** The bar's current height in px. */
  height(): number;
  /**
   * Paint a height imperatively. Returns the height actually ADOPTED — the bar
   * clamps to its own bounds.
   */
  push(px: number): number;
  /** Commit whatever was painted to React state. No-op if nothing was pushed. */
  commit(): void;
}

let handle: AssetBarDragHandle | null = null;

/** Registered by ContentBrowser for its lifetime. Returns the deregister call. */
export function registerAssetBarDrag(h: AssetBarDragHandle): () => void {
  handle = h;
  return () => {
    if (handle === h) handle = null;
  };
}

export function assetBarDragHandle(): AssetBarDragHandle | null {
  return handle;
}
