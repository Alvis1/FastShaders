/**
 * EDGE PORTS — sockets spread evenly along a node's border, centred on the
 * body, with no text beside them. THE one geometry, shared by the live node
 * (ShaderNode) and the static replica (NodeVisual), so the four surfaces that
 * draw a node cannot disagree about where its sockets are.
 *
 * WHY a node would want this instead of rows: a row exists to carry a VALUE
 * (a number box, an edge label) beside its socket. A node whose ports carry no
 * value — the Image node, whose tile/offset numbers live in the settings menu
 * and whose five outputs are one sample's channels — pays the full price of
 * the rows layout (a tall strip of empty rows BELOW the picture, sockets
 * hanging off the bottom corner) for nothing. Edge ports put the sockets where
 * the eye looks for them, beside the thing the node draws, and hand the naming
 * job back to the socket's own tooltip: hover, a touch tap, or the
 * double-click label pin (`fs-labels-shown`), which is the app-wide model
 * every other node already uses (NODE_DESIGN_REQUIREMENTS #8).
 *
 * A LEAF that imports nothing — ShaderNode, NodeVisual and the node tests all
 * read it, and the costTable lesson says a module in that position must never
 * sit inside an import cycle.
 *
 * The offsets are PX FROM THE BODY CENTRE, deliberately the same units and the
 * same `calc(50% ± Npx)` idiom the Node Designer's authored socket offsets use
 * (`customGlyphs.ts → sockets`). Two consequences worth knowing:
 *   1. a designer-authored offset can simply REPLACE a computed one, per
 *      socket, with no second convention to translate between;
 *   2. the pitch is a real px distance, so the sockets never crowd on a short
 *      card the way a percentage band does — which is exactly what an Image
 *      node with the 48px empty slot and five outputs would have done.
 */

/**
 * Vertical distance between two neighbouring edge ports, px.
 *
 * 14 is `.node-base__row`'s `min-height` (NodeBase.css): an edge-port column
 * is exactly as dense as the rows it replaces, so a node that switches layout
 * does not also change how far apart its sockets sit.
 */
export const EDGE_PORT_PITCH = 14;

/**
 * Where port `index` of `total` sits, in px from the body centre — negative
 * above, positive below, the whole column centred whatever `total` is.
 *
 * `total <= 1` is 0 (dead centre) rather than a special case elsewhere, so a
 * caller never has to branch.
 */
export function edgePortOffset(index: number, total: number): number {
  if (total <= 1) return 0;
  return (index - (total - 1) / 2) * EDGE_PORT_PITCH;
}

/**
 * The minimum height the port region needs so a column of `inputs` and a
 * column of `outputs` both stay inside the body.
 *
 * It is a FLOOR, never a height: a node whose content (an Image node's
 * thumbnail) is taller keeps its content height and the sockets simply spread
 * around the same centre. Counted from the node's FULL port lists rather than
 * from what happens to be drawn, so exposing a parameter — or a drag-reveal
 * mounting the hidden ones — never moves a socket that was already there.
 */
export function edgePortRailHeight(inputs: number, outputs: number): number {
  return Math.max(0, inputs, outputs) * EDGE_PORT_PITCH;
}

/**
 * The node types laid out this way. ONE set, read by both surfaces.
 *
 * The Image (Texture) node only. Its siblings are deliberately NOT here:
 *  - the Data node's outputs are its CSV column headers — USER DATA, and the
 *    only thing telling N identical float sockets apart. Rule #8's 8a
 *    exception exists for exactly that and still holds.
 *  - every other `input`-category node already has one socket authored to the
 *    body centre in the Node Designer (`customGlyphs.ts → sockets: {out: 0}`),
 *    which is this layout reached the authored way.
 */
export const EDGE_PORT_TYPES: ReadonlySet<string> = new Set<string>(['imageNode']);

/** True for a node whose sockets ride its border instead of its rows. */
export function usesEdgePorts(type: string | undefined): boolean {
  return typeof type === 'string' && EDGE_PORT_TYPES.has(type);
}
