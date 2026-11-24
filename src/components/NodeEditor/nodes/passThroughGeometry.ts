/**
 * The Branch and Portal cards' sizes (KnotNode.tsx, TunnelNode.tsx), in flow
 * px. A LEAF, so the layout engine reads the same numbers the cards draw at
 * without importing a component (soundGeometry.ts is its twin for the Sound
 * node). The cards apply them inline; PassThroughNode.css states none of them.
 */

/**
 * The Branch's dot: its radius and stroke width in SCREEN px — the dot is
 * counter-scaled with the zoom, so it keeps one size on screen. Twice the
 * routing point's dot it was first drawn after (owner, 2026-11-23: "Branch =
 * routing point, visually like the dot but 2x bigger"); routing points
 * themselves were removed on 2026-11-24, and the Branch kept its size.
 */
export const KNOT_DOT_R = 10;
export const KNOT_DOT_STROKE = 3;

/**
 * The Branch's node box in FLOW px: the dot's outer diameter at zoom 1 (the
 * SVG stroke is centred on the radius, so it adds half its width on each
 * side). The box is fixed in flow space — what the layout engine reserves and
 * a marquee selects — while the dot drawn inside it keeps its screen size.
 */
export const KNOT_SIZE = 2 * KNOT_DOT_R + KNOT_DOT_STROKE;

/** A Portal end's hole: a disc this many flow px across (rim included). */
export const TUNNEL_SIZE = 32;

/** A Portal end's socket: a square this many flow px across, centred in the
 *  hole (PassThroughNode.css states the same number). React Flow anchors a
 *  wire at its left (Portal In) or right (Portal Out) edge, half of it from
 *  the hole's centre — which is how TypedEdge finds the centre its dive arcs
 *  around. */
export const TUNNEL_HANDLE = 20;

/**
 * What the layout engine reserves for a Portal end: the hole plus the name
 * label ABOVE it (one line of chrome text) and room for the label's ~12
 * characters, which overhang the hole on both sides. An over-estimate is the
 * safe side (layoutEngine.ts).
 */
export const TUNNEL_LAYOUT_W = 80;
export const TUNNEL_LAYOUT_H = TUNNEL_SIZE + 18;
