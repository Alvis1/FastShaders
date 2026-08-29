/**
 * The two dividers that share the canvas column PUSH each other instead of one
 * detaching from its own line.
 *
 * ## The geometry
 *
 * The corner grip is a tab on the COLUMN seam, anchored at the height of the
 * ROW seam on the other side (the 3D-preview / code split) so the horizontal
 * line runs unbroken across the corner — see `.fs-grip--v` in styles/controls.css.
 * But the tab hangs ~24px into the LEFT pane, where the asset bar lives, so the
 * two can collide.
 *
 * That collision used to be resolved by CLAMPING the grip's position: it slid up
 * its seam and sat stranded in the middle of the canvas, metres from the line it
 * is supposed to be part of (measured at a stock split: 239px away). A control
 * that detaches from the thing it controls reads as a rendering bug.
 *
 * It is resolved by MOVING THE OTHER DIVIDER instead: drag the corner grip down
 * and the asset bar gets shorter; drag the asset bar's grip up and the row seam
 * goes up with it. The CSS clamp stays as the final backstop — the asset bar has
 * a minimum height and the row seam has a minimum ratio, so at the very end of
 * travel something has to give — but in normal use it is never reached.
 *
 * ## The one inequality both sides share
 *
 * Let `span` be the height both columns share, `cross` the row split's ratio
 * (so the row seam's top edge is at `cross * span`) and `barH` the asset bar's
 * height (measured up from the bottom of the same span). The grip stays attached
 * exactly while
 *
 *     barH <= span * (1 - cross) - clearance
 *
 * where `clearance` is how much room the tab needs below its seam. Both
 * directions of the push are that one line rearranged, which is the point of
 * putting it here: the corner grip and the asset bar must agree about where the
 * boundary is, or each would shove the other and the pair would oscillate.
 */

/**
 * The gap the grip keeps between its own bottom edge and the asset bar. Mirrors
 * the `4px` literal in `.fs-grip--v`'s `top: min(…)` backstop — the two are the
 * same rule stated for the two different mechanisms (CSS clamps, JS pushes), so
 * they must move together.
 */
export const GRIP_BOTTOM_MARGIN = 4;

/**
 * The row split's floor — the 3D preview never drops below a quarter of the
 * column. Lives here rather than in SplitPane because BOTH pushers need it: the
 * asset bar has to know how far up it may shove the row seam before it must
 * stop growing instead, and a second copy of the number is how the two ends of
 * a push start disagreeing about where the wall is.
 */
export const CROSS_MIN_TOP_RATIO = 0.25;

/** Fallbacks for a DOM-less environment (the `node` test env) — the desktop
 *  token values, so the pure maths can be exercised without a browser. */
const FALLBACK_GRIP_H = 39;
const FALLBACK_SEAM = 2;
const FALLBACK_BORDER = 2;

export interface GripMetrics {
  /** The grip tab's rendered height (`--fs-grip-h`). */
  gripH: number;
  /** The divider's line thickness (`--fs-seam`). */
  seam: number;
  /** The grip's outline thickness (`--fs-grip-border`). */
  border: number;
}

/**
 * How far below the row seam the corner grip reaches, including the margin it
 * keeps off the asset bar.
 *
 * The `(seam - border) / 2` term is the same centring correction `.fs-grip--v`
 * applies to its own `top`: the grip's outline stays at the DESKTOP seam width
 * while the seam itself bumps on coarse pointers, so the tab's border is centred
 * in the thicker line rather than top-aligned to it. On a fine pointer the two
 * are equal and the term is exactly zero.
 */
export function gripClearance(m: GripMetrics): number {
  return m.gripH + GRIP_BOTTOM_MARGIN + (m.seam - m.border) / 2;
}

/** The tallest the asset bar may be while the corner grip stays on its seam. */
export function maxBarHeightForCross(cross: number, span: number, clearance: number): number {
  return span * (1 - cross) - clearance;
}

/** The lowest the row seam may sit while the corner grip clears the asset bar. */
export function maxCrossForBarHeight(barH: number, span: number, clearance: number): number {
  // A zero span means the layout has not been measured yet; there is no
  // constraint to express, and dividing by it would poison the ratio with NaN.
  if (!(span > 0)) return 1;
  return (span - barH - clearance) / span;
}

/**
 * Read the grip's live metrics off the DOM.
 *
 * `--fs-grip-h` is a `calc()` over other custom properties, so
 * `getPropertyValue` hands back the substituted expression rather than a number
 * — custom properties are not type-resolved without an `@property` registration.
 * The grip's own `offsetHeight` is the resolved value and cannot drift from what
 * is actually painted, so that is what is read. `--fs-seam` and
 * `--fs-grip-border` are plain token values and parse directly.
 */
export function readGripMetrics(grip: HTMLElement | null): GripMetrics {
  if (!grip) return { gripH: FALLBACK_GRIP_H, seam: FALLBACK_SEAM, border: FALLBACK_BORDER };
  const cs = getComputedStyle(grip);
  const num = (name: string, fallback: number) => {
    const v = parseFloat(cs.getPropertyValue(name));
    return Number.isFinite(v) ? v : fallback;
  };
  const h = grip.offsetHeight;
  return {
    gripH: h > 0 ? h : FALLBACK_GRIP_H,
    seam: num('--fs-seam', FALLBACK_SEAM),
    border: num('--fs-grip-border', FALLBACK_BORDER),
  };
}

/* ---------------------------------------------------------------------------
   The asset bar's push handle.

   Same module-level publisher shape (and the same justification) as
   utils/assetBarHeight.ts and tileDrag.ts: two components in different subtrees
   that must agree on a value at pointer rate, with no React render between them.

   `push` deliberately does NOT go through React state. The bar's height drives
   the tile strip's `zoom`, which is an INHERITED computed-style property — a
   state write per pointermove re-lays-out ~1,700 elements per frame, which is
   the frame-rate collapse ContentBrowser's own `paintHeight` exists to avoid.
   The pusher paints imperatively and calls `commit()` once, at pointerup.
   --------------------------------------------------------------------------- */

export interface AssetBarPushHandle {
  /** The bar's current height in px. */
  height(): number;
  /**
   * Paint a height imperatively. Returns the height actually ADOPTED — the bar
   * clamps to its own bounds, and the caller needs the real number to decide
   * whether it must clamp its own axis instead of pushing further.
   */
  push(px: number): number;
  /** Commit whatever was painted to React state. No-op if nothing was pushed. */
  commit(): void;
}

let handle: AssetBarPushHandle | null = null;

/** Registered by ContentBrowser for its lifetime. Returns the deregister call. */
export function registerAssetBarPush(h: AssetBarPushHandle): () => void {
  handle = h;
  return () => {
    if (handle === h) handle = null;
  };
}

export function assetBarPushHandle(): AssetBarPushHandle | null {
  return handle;
}

/**
 * The corner grip element, registered by the two-axis SplitPane.
 *
 * The asset bar pushes in the opposite direction and needs the same clearance
 * number, which is only knowable from the grip's rendered box. Registered rather
 * than found with a document-wide `querySelector`, so the coupling is one
 * explicit pair rather than a selector that silently matches nothing the day the
 * class name changes.
 */
let cornerGrip: HTMLElement | null = null;

export function registerCornerGrip(el: HTMLElement): () => void {
  cornerGrip = el;
  return () => {
    if (cornerGrip === el) cornerGrip = null;
  };
}

export function cornerGripElement(): HTMLElement | null {
  return cornerGrip;
}
