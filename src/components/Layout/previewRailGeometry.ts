/**
 * The PREVIEW RAIL: where each Output's wire meets the canvas's right edge.
 *
 * The decorative Output→preview wires are drawn inside `.react-flow`, which
 * `.node-editor__canvas` clips (`overflow: hidden`) — so they never actually
 * reached the preview, they were cut off at the seam while appearing to aim at
 * the 3D view's centre. The rail is what they aim at now: one socket per
 * contributing Output down that edge, so the wire visibly ENDS somewhere.
 *
 * PURE and side-free, so `PreviewRail` and PreviewLink's own endpoint
 * resolution ask the same function — the socket the wire ends on and the socket
 * the rail draws cannot be at two different heights.
 *
 * Positions are a FRACTION of the pane's height, not pixels: the canvas is
 * user-resizable from both the column seam and the window, so any fixed offset
 * would only hold at one size.
 */

/** How much of the pane's height the rail may occupy, centred. Short of the
 *  full height so the first and last sockets clear the canvas's own corners —
 *  the cost pill sits top-right and the import note drops in below it. */
export const RAIL_SPAN = 0.62;

/** The smallest gap between two sockets, as a fraction of pane height. Below
 *  this the rail stops spreading and starts CENTRING on its midpoint, so a
 *  16-material import gets a tight readable column rather than a rail whose
 *  sockets touch. Chosen against the 20px socket: at a 600px pane, 0.045 is
 *  27px, i.e. a 7px gap between discs. */
export const RAIL_MIN_STEP = 0.045;

/**
 * The vertical position of socket `i` of `count`, as a fraction of pane height.
 *
 * ONE socket sits at the middle — that is where the single wire of an ordinary
 * one-Output shader has always pointed, so the common case does not move.
 */
export function railFraction(index: number, count: number): number {
  if (count <= 1) return 0.5;
  const spread = Math.min(RAIL_SPAN, RAIL_MIN_STEP * (count - 1));
  return 0.5 - spread / 2 + (spread / Math.max(1, count - 1)) * index;
}

/** Every fraction for a rail of `count` sockets, in order. */
export function railFractions(count: number): number[] {
  return Array.from({ length: count }, (_, i) => railFraction(i, count));
}

/**
 * The client-space Y of socket `i` inside a pane whose box is `top`/`height` —
 * what PreviewLink aims each wire at, so it lands on the disc the rail drew.
 * Rounded, because these become CSS pixels and a half-pixel socket blurs its
 * own rim.
 */
export function railY(top: number, height: number, index: number, count: number): number {
  return Math.round(top + height * railFraction(index, count));
}

/**
 * How far inside the pane's right edge a rail socket's CENTRE sits.
 *
 * The rail is offset by half a socket so the disc straddles the edge and reads
 * as meeting the seam — so its centre is exactly ON the edge, and a wire aimed
 * there would end under the clip. One socket radius in puts the wire's end on
 * the visible half. `--handle-size` is 10px desktop / 12px coarse; the wire is
 * decorative and a pixel either way is invisible, so this does not read the
 * token at runtime the way `nodeRisePx` had to.
 */
export const RAIL_INSET = 10;
