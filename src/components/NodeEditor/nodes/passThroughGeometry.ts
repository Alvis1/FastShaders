/**
 * The Branch and Portal cards' sizes (KnotNode.tsx, TunnelNode.tsx), in flow
 * px. A LEAF, so the layout engine reads the same numbers the cards draw at
 * without importing a component (soundGeometry.ts is its twin for the Sound
 * node). The cards apply them inline; PassThroughNode.css states none of them.
 */

/** A ROUTING POINT's dot on a wire (TypedEdge's waypoint circle): its radius
 *  and stroke width in SCREEN px — the dot is counter-scaled with the zoom. */
export const WAYPOINT_DOT_R = 5;
export const WAYPOINT_DOT_STROKE = 1.5;

/**
 * The Branch is drawn as a routing point's dot at TWICE its size (owner,
 * 2026-11-23: "Branch = routing point, visually like the dot but 2x bigger"):
 * radius and stroke both doubled, in SCREEN px, at every zoom.
 */
export const KNOT_DOT_R = 2 * WAYPOINT_DOT_R;
export const KNOT_DOT_STROKE = 2 * WAYPOINT_DOT_STROKE;

/**
 * The Branch's node box in FLOW px: the dot's outer diameter at zoom 1 (the
 * SVG stroke is centred on the radius, so it adds half its width on each
 * side). The box is fixed in flow space — what the layout engine reserves and
 * a marquee selects — while the dot drawn inside it keeps its screen size.
 */
export const KNOT_SIZE = 2 * KNOT_DOT_R + KNOT_DOT_STROKE;

/** A Portal end's hole: a disc this many flow px across (rim included). */
export const TUNNEL_SIZE = 32;

/**
 * What the layout engine reserves for a Portal end: the hole plus the name
 * label ABOVE it (one line of chrome text) and room for the label's ~12
 * characters, which overhang the hole on both sides. An over-estimate is the
 * safe side (layoutEngine.ts).
 */
export const TUNNEL_LAYOUT_W = 80;
export const TUNNEL_LAYOUT_H = TUNNEL_SIZE + 18;
