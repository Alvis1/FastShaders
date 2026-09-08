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
 *
 * The token is NOT the whole answer, though, and that is the one way this read
 * could still drift from what the screen does: a CUSTOM PROPERTY always
 * resolves, whatever the engine can render, while the movement it feeds is the
 * standalone `translate` property (NodeBase.css / ColorNode / NoteNode /
 * GroupNode / OutputNode) — Chromium 104, Firefox 72, Safari 14.1. On an engine
 * below that the card does not move and `--fs-node-rise` still reads -3px, so
 * every wire on a hovered node would step off its socket alone: exactly the
 * "looks like a rendering bug" failure this comment warns about, inverted. The
 * capability probe is therefore part of the read, not a separate concern —
 * asking the engine whether the CSS half applies is the only thing that keeps
 * "the CSS is the source of truth" true. (The affected band is narrow — those
 * Chromium versions also drop the `:has()` grip rules and take CostBar's
 * `color-mix` fallback — but a wrong answer here is silent, and 0 is right.)
 */
export function nodeRisePx(): number {
  if (cachedRise !== null) return cachedRise;
  try {
    // Cacheable permanently: engine support cannot change within a session.
    if (!CSS.supports('translate', '1px')) {
      cachedRise = 0;
      return 0;
    }
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
