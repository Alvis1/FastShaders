/**
 * The Branch and Portal cards' sizes (KnotNode.tsx, TunnelNode.tsx), in flow
 * px. A LEAF, so the layout engine reads the same numbers the cards draw at
 * without importing a component (soundGeometry.ts is its twin for the Sound
 * node). The cards apply them inline; PassThroughNode.css states none of them.
 */

/** The Branch: a solid square this many flow px on a side (border included). */
export const KNOT_SIZE = 12;

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
