/**
 * Asset tiles are spaced by their SILHOUETTE — frame plus sockets — not by
 * their frame alone (owner, 2026-09-11: "the spacing in assets between nodes
 * is not even").
 *
 * Every tile's frame sat the same distance from its neighbours (12.2–12.9 px,
 * measured), yet the gap the eye reads runs from the outermost thing drawn,
 * and sockets straddle the frame: a node with inputs has dots sticking out on
 * its left, the colour swatch's perimeter socket is drawn 1.5x (the swatch is
 * counter-scaled, CARD_COLOR_SCALE), and the Output's preview socket is twice
 * a normal socket. So the visible gaps ran from 3.5 to 10.3 px. Each tile's
 * padding now absorbs how far its own sockets reach, published as
 * `--fs-sock-l` / `--fs-sock-r` and read by `.node-preview-card`'s padding.
 *
 * Measured rather than restated per node type: the overhang depends on the
 * socket token, the card's cost scale, the swatch counter-scale and each
 * node's own socket insets — a CSS table of those would be one more copy of
 * geometry that lives elsewhere, and a tile added tomorrow would silently be
 * missing from it. The values are in the tile's OWN CSS px (screen px divided
 * by the tile's rendered scale), so they do not change with the strip's zoom
 * and the bar's grip never has to re-measure them.
 */

export interface Span {
  left: number;
  right: number;
}

/** How far `sockets` reach past `frame` on each side, in the tile's own px. */
export function socketOverhang(frame: Span, sockets: readonly Span[], scale: number): Span {
  if (!(scale > 0) || !Number.isFinite(scale)) return { left: 0, right: 0 };
  let l = frame.left;
  let r = frame.right;
  for (const s of sockets) {
    if (!(s.right > s.left)) continue; // unrendered
    if (s.left < l) l = s.left;
    if (s.right > r) r = s.right;
  }
  const px = (v: number) => Math.round((v / scale) * 100) / 100;
  return { left: px(frame.left - l), right: px(r - frame.right) };
}

/** The tile's visible frame — the node shell, or the swatch for a colour tile. */
const FRAME_SELECTOR = '.node-preview-card__node, .node-base, .output-node, .color-node';
const SOCKET_SELECTOR = '.react-flow__handle, .output-node__preview-socket';

/**
 * Measure every tile under `root`, then write — all reads before any write, so
 * the pass costs one layout rather than one per tile.
 */
export function applyTileSilhouettes(root: ParentNode): void {
  const plan: [HTMLElement, Span][] = [];
  for (const card of Array.from(root.querySelectorAll<HTMLElement>('.node-preview-card'))) {
    const frameEl = card.querySelector<HTMLElement>(FRAME_SELECTOR);
    if (!frameEl || card.offsetWidth === 0) continue;
    const scale = card.getBoundingClientRect().width / card.offsetWidth;
    const sockets = Array.from(card.querySelectorAll<HTMLElement>(SOCKET_SELECTOR), (s) => s.getBoundingClientRect());
    plan.push([card, socketOverhang(frameEl.getBoundingClientRect(), sockets, scale)]);
  }
  for (const [card, o] of plan) {
    card.style.setProperty('--fs-sock-l', `${o.left}px`);
    card.style.setProperty('--fs-sock-r', `${o.right}px`);
  }
}
