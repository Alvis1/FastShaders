/**
 * Proportional socket rescaling for the Node Designer's corner-resize gesture.
 *
 * WHY THIS EXISTS. A stored socket offset is px from the body/region centre,
 * and the RENDERER treats it as an absolute number — so growing a node's height
 * slides the socket cluster down with the centre but never spreads it: a Multiply
 * keeps its two inputs 24px apart whether the card is 57px or 417px tall, leaving
 * the frame ballooning around a small knot of ports (measured). Row-anchored
 * sockets are worse — they are in normal flow from the top, so extra height is
 * pure dead space below them.
 *
 * The fix is in the AUTHORING gesture, not the renderer: dragging the corner
 * rewrites the stored offsets so they keep their visual proportion. Nothing about
 * how a SAVED design renders changes, so all ~55 shipped designs stay
 * byte-identical on the canvas, in asset cards and in the overview until an
 * author deliberately grabs that node's corner. (A renderer-side reinterpretation
 * — px as a fraction of the current height — was measured to shift ~48 shipped
 * entries, e.g. Multiply's ±12 → ±14.9.)
 *
 * Pure and import-free so the vitest node env can cover it: `designerApp.ts` is
 * @ts-nocheck vanilla with no other automated coverage, and every correctness
 * property of this fix (symmetry, no-op at k=1, bound preservation) is arithmetic.
 */

/** Socket offsets snap to this grid, exactly as a manual socket drag does. */
export const SOCK_SNAP = 4;

/**
 * Snap SYMMETRICALLY about zero.
 *
 * `Math.round` is asymmetric on .5 — `Math.round(-4.5)` is −4 while
 * `Math.round(4.5)` is 5 — so the designer's own drag expression would turn
 * Multiply's `{a:-12, b:+12}` at h42→h63 into `{a:-16, b:+20}`: a symmetric
 * operator gone 4px lopsided. Twelve shipped entries hold an exactly symmetric
 * pair (the four arithmetic ops, the three comparisons, pow, distance, cross,
 * mod, append), and every one would break on its first resize. Rounding the
 * MAGNITUDE and re-applying the sign keeps ±n symmetric forever.
 */
export function symSnap(v: number): number {
  if (!Number.isFinite(v)) return 0;
  const s = v < 0 ? -1 : 1;
  return s * Math.round(Math.abs(v) / SOCK_SNAP) * SOCK_SNAP;
}

/**
 * The widest offset a socket may hold on a body of height `h`, on the snap grid.
 *
 * Deliberately LOOSE — half the body, not the designer's stricter
 * `(limH/2 − 5)` drag bound. The strict bound would be a regression the moment
 * anyone nudged a corner: `uv` is authored at `out: −52` on height 105, i.e. 8px
 * outside it, and would be yanked to −44. This bound leaves −52 untouched
 * (floor(52.5/4)*4 = 52) and only absorbs snap overshoot.
 */
export function clampToBody(off: number, h: number): number {
  const lim = Math.floor((h / 2) / SOCK_SNAP) * SOCK_SNAP;
  return Math.max(-lim, Math.min(lim, off));
}

/** The exact, UNSNAPPED products — the session-only shadow the designer keeps so
 *  repeated resizes don't random-walk off the grid they started on. */
export function scaleSocketOffsetsRaw(
  base: Record<string, number>,
  k: number,
): Record<string, number> {
  if (!Number.isFinite(k)) return { ...base };
  const out: Record<string, number> = {};
  for (const key of Object.keys(base)) out[key] = base[key] * k;
  return out;
}

/**
 * Rescale every offset in `base` (captured at height `h0`) for height `h1`.
 *
 * Always derived from the ORIGINAL `base`, never from the previous frame, so a
 * drag cannot accumulate rounding drift. Returns `base` untouched for a no-op
 * or a degenerate reference height — which is what keeps a width-only drag, and
 * an unauthored operator node's non-grid ±12.5 defaults, from being quantized
 * by a gesture that changed nothing.
 */
export function scaleSocketOffsets(
  base: Record<string, number>,
  h0: number,
  h1: number,
): Record<string, number> {
  if (!Number.isFinite(h0) || h0 <= 0 || !Number.isFinite(h1) || h1 === h0) return base;
  const k = h1 / h0;
  const out: Record<string, number> = {};
  for (const key of Object.keys(base)) {
    out[key] = clampToBody(symSnap(base[key] * k), h1);
  }
  return out;
}
