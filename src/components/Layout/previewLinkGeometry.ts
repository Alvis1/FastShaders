/**
 * Pure screen-space geometry for the symbolic Output→preview link (PreviewLink).
 * Kept separate from the React component so the curve math is unit-testable in
 * the node test env (no DOM). All coordinates are viewport/client pixels.
 */

export interface Pt {
  x: number;
  y: number;
}

/** The x/y extent a `getBoundingClientRect()` exposes that we read. */
export interface RectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Center point of a rect. */
export function rectCenter(r: RectLike): Pt {
  return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 };
}

/** Is a point inside a rect, expanded by `margin` on every side? */
export function pointInRect(pt: Pt, r: RectLike, margin = 0): boolean {
  return (
    pt.x >= r.left - margin &&
    pt.x <= r.right + margin &&
    pt.y >= r.top - margin &&
    pt.y <= r.bottom + margin
  );
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Cubic-bezier SVG `d` linking two screen-space points with horizontal
 * ease-in/ease-out control handles — the same S-curve shape React Flow uses
 * for its edges, so the symbolic Output→preview wire reads as a natural
 * continuation of the graph's own edges. The control-handle reach is half the
 * horizontal span, floored so a near-vertical link still bows instead of
 * collapsing to a straight segment. Handles follow the sign of the span so the
 * curve stays sensible even if the preview ends up left of the Output node.
 */
export function linkPath(start: Pt, end: Pt): string {
  const dx = end.x - start.x;
  const reach = Math.max(40, Math.abs(dx) * 0.5);
  const dir = dx >= 0 ? 1 : -1;
  const c1x = start.x + reach * dir;
  const c2x = end.x - reach * dir;
  return (
    `M ${round2(start.x)} ${round2(start.y)} ` +
    `C ${round2(c1x)} ${round2(start.y)} ${round2(c2x)} ${round2(end.y)} ` +
    `${round2(end.x)} ${round2(end.y)}`
  );
}
