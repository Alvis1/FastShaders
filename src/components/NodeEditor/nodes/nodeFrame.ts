/**
 * The node frame's border WIDTH, as a CSS value.
 *
 * `NODE_DESIGN_REQUIREMENTS.md` fixes the border at 1.5px for every node and
 * makes it explicitly non-customizable per node — but each node component sets
 * its own `border` INLINE, because the colour is the node's category and is
 * only known in JS. An inline shorthand cannot be overridden from a stylesheet
 * without `!important`, so the width rides a custom property instead: this is
 * the one place the 1.5px lives, and CSS decides the multiplier.
 *
 * `--fs-node-border-scale` is 1 at rest and 2 while the node is SELECTED (or
 * while its settings menu is open — see NodeBase.css), so clicking a node
 * doubles its frame. The fallback matters: every surface that renders a node
 * OUTSIDE React Flow — asset tiles, the node-editor.html overview, the Node
 * Designer stage — has no wrapper publishing the property and must draw the
 * resting frame.
 *
 * Shells whose border is already in CSS (the colour swatch, notes, group
 * frames, the multi-channel stack layers) apply the same scale to their own
 * base width there; the rule is "selection doubles whatever this shell's border
 * is", not "selection sets 3px".
 */
export const NODE_BORDER_WIDTH = 'calc(1.5px * var(--fs-node-border-scale, 1))';

/** Fallback for `nodeRisePx` when there is no DOM to read (the `node` test env). */
const NODE_RISE_FALLBACK = -3;
let cachedRise: number | null = null;

/**
 * How far a LIFTED node moves, in flow px — the JS side of `--fs-node-rise`.
 *
 * `TypedEdge` needs this number: a lifted node's sockets move with its card,
 * but React Flow computes edge endpoints from node POSITIONS and knows nothing
 * about a CSS translate, so the wire would stay behind and read as unplugged.
 * The edge offsets its own endpoint by exactly this.
 *
 * READ from the token rather than duplicated as a literal, so the CSS and the
 * geometry cannot drift — one of them silently disagreeing would put every wire
 * a few px off its socket, which looks like a rendering bug rather than a
 * mismatched constant. Cached after the first successful read (the value is not
 * theme-dependent); a read that comes back empty is NOT cached, so an early
 * call before the stylesheet lands cannot freeze the fallback in.
 */
export function nodeRisePx(): number {
  if (cachedRise !== null) return cachedRise;
  try {
    const raw = getComputedStyle(document.documentElement)
      .getPropertyValue('--fs-node-rise')
      .trim();
    const n = parseFloat(raw);
    if (raw !== '' && Number.isFinite(n)) {
      cachedRise = n;
      return n;
    }
  } catch {
    /* no DOM — fall through */
  }
  return NODE_RISE_FALLBACK;
}
