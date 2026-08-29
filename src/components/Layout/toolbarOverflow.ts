/**
 * The collapse decision behind the toolbar's overflow (☰) menu.
 *
 * The naive rule — "collapse while the bar overflows" — cannot work, and the
 * reason is worth stating because it is the whole design: collapsing REMOVES
 * the overflow, so on the very next measurement the bar fits and wants to
 * expand, which re-creates the overflow. That is an infinite flicker at
 * ResizeObserver rate, not an edge case.
 *
 * So the collapse has to remember how much room the expanded bar actually
 * needed and only expand again once there is at least that much. That number
 * is knowable exactly once: at the instant of collapsing, when the expanded
 * layout is still on screen and `scrollWidth` is its natural width.
 *
 * Pure and unit-tested because nothing about a flicker loop fails loudly — it
 * just looks broken, on window sizes nobody happens to be using.
 */

export interface OverflowState {
  collapsed: boolean;
  /**
   * Available width at or above which the expanded bar is known to fit, or
   * Infinity while that is unknown (never collapsed yet). Only ever written at
   * the moment of collapsing, from the still-expanded measurement.
   */
  expandAt: number;
}

export const OVERFLOW_INITIAL: OverflowState = { collapsed: false, expandAt: Infinity };

/**
 * Slack, in px, required beyond the remembered natural width before expanding
 * again. Sub-pixel layout rounding means `clientWidth` can come back a hair
 * under the `scrollWidth` that produced it even at an identical window size,
 * and without a margin that one pixel is enough to re-collapse immediately.
 */
export const OVERFLOW_SLOP_PX = 2;

/**
 * Fold one measurement into the state. Returns the SAME object when nothing
 * changed, so a caller can `setState` unconditionally and let React bail out —
 * this runs on every ResizeObserver callback, i.e. once per frame of a window
 * drag.
 *
 * `scrollWidth` is only meaningful while EXPANDED (collapsed, it describes the
 * collapsed layout), which is why it is read in one branch only.
 */
export function foldOverflow(
  state: OverflowState,
  measurement: { clientWidth: number; scrollWidth: number },
): OverflowState {
  const { clientWidth, scrollWidth } = measurement;
  // A detached or display:none element measures 0 — no information, and
  // collapsing on it would strand the bar collapsed once it came back.
  if (clientWidth <= 0) return state;

  if (!state.collapsed) {
    if (scrollWidth <= clientWidth + 1) return state; // fits; nothing to do
    return { collapsed: true, expandAt: scrollWidth + OVERFLOW_SLOP_PX };
  }
  if (clientWidth >= state.expandAt) return { collapsed: false, expandAt: Infinity };
  return state;
}
