/**
 * Publishes the asset bar's live height to the chrome that has to stay clear of
 * it (the corner grip's position clamp — see the `min()` on `.fs-grip--v` in
 * styles/controls.css).
 *
 * Why a registry instead of a CSS variable on `:root`: `--fs-asset-bar-h` is an
 * INHERITED custom property, so setting it on the document element invalidates
 * the computed style of everything that could inherit it — the whole document,
 * which here also holds React Flow's graph and a Monaco instance. During a
 * resize drag that write happens every frame. Registering the handful of real
 * consumers turns a document-wide invalidation into a one-element write.
 *
 * (`@property { inherits: false }` would kill the propagation but also stop the
 * value reaching the grip at all, and the writer and reader live in different
 * subtrees — so there is no cheaper common ancestor to scope it to.)
 *
 * Same module-level publisher shape as tileDrag.ts, and the same reason: two
 * components that must share a value per-frame without a React render between
 * them.
 */

const VAR = '--fs-asset-bar-h';

const consumers = new Set<HTMLElement>();
let currentPx = 0;

function apply(el: HTMLElement): void {
  el.style.setProperty(VAR, `${Math.round(currentPx)}px`);
}

/**
 * Start receiving the height on `el`. Returns the deregister call; the element
 * is seeded immediately so a late mount doesn't wait for the next resize.
 */
export function registerAssetBarHeightConsumer(el: HTMLElement): () => void {
  consumers.add(el);
  apply(el);
  return () => {
    consumers.delete(el);
    el.style.removeProperty(VAR);
  };
}

/** Publish a new height. Safe to call per frame — it writes N elements, N ≈ 1. */
export function setAssetBarHeight(px: number): void {
  currentPx = px;
  for (const el of consumers) apply(el);
}
