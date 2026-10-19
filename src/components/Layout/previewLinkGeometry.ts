/**
 * Pure screen-space geometry for the symbolic Output→preview link (PreviewLink).
 * Kept separate from the React component so the curve math is unit-testable in
 * the node test env (no DOM). All coordinates are viewport/client pixels.
 */

import {
  ARROW_FLARE,
  ARROW_MIN_ARC,
  ARROW_SPACING,
  arrowMarks,
  bezierControlOffset,
  chevronPath,
  distancePointToCubicBezier,
  ribbonHalfWidth,
} from '@/components/NodeEditor/edges/bezierGeometry';

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

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * The two cubic control points the link curve bends through. The control-handle
 * reach is the canvas wires' own (`bezierControlOffset`, React Flow's forward
 * rule): half the horizontal span, so a wire leaving the Output's socket
 * rightward is drawn exactly as a canvas wire into a left-side input would be.
 * NO floor: the reach used to floor at 40, which overshot every wire with less
 * than ~40px to cover — an Output parked beside the rail drew a little loop
 * there, and its chevron sat on the loop. A near-vertical link is a straight
 * segment, as a canvas wire between aligned sockets is. Handles follow the sign
 * of the span (where the canvas swings a backward wire round in a loop), so an
 * Output panned off past the rail still enters it plainly.
 *
 * Split out of `linkPath` so the RENDERED curve and the HIT TEST read the same
 * numbers — the rule `edges/bezierGeometry.ts` already states for TypedEdge and
 * `findNearestEdge`. If the two drifted, a wire could highlight where it cannot
 * be clicked, or answer a click where nothing is drawn.
 */
export function linkControlPoints(start: Pt, end: Pt): { c1: Pt; c2: Pt } {
  const dx = end.x - start.x;
  const reach = bezierControlOffset(Math.abs(dx));
  const dir = dx >= 0 ? 1 : -1;
  return {
    c1: { x: start.x + reach * dir, y: start.y },
    c2: { x: end.x - reach * dir, y: end.y },
  };
}

/**
 * Cubic-bezier SVG `d` linking two screen-space points with horizontal
 * ease-in/ease-out control handles — the same S-curve shape React Flow uses
 * for its edges, so the symbolic Output→preview wire reads as a natural
 * continuation of the graph's own edges.
 */
export function linkPath(start: Pt, end: Pt): string {
  const { c1, c2 } = linkControlPoints(start, end);
  return (
    `M ${round2(start.x)} ${round2(start.y)} ` +
    `C ${round2(c1.x)} ${round2(c1.y)} ${round2(c2.x)} ${round2(c2.y)} ` +
    `${round2(end.x)} ${round2(end.y)}`
  );
}

/**
 * Half the height of a STILL wire's chevron, screen px: the wire's own
 * half-width (2.25 of PreviewLink.css's 4.5px stroke) plus the arms' 4.75px
 * reach past it. The canvas sizes its chevrons the same way (`ribbonHalfWidth
 * + ARROW_FLARE`); this wire is three times as heavy as a canvas one at zoom 1,
 * so its chevrons are larger to match.
 */
export const LINK_ARROW_HALF = 7;

/** The canvas's "too short for a chevron" arc, scaled with the chevron: a
 *  canvas chevron is `ribbonHalfWidth(1) + ARROW_FLARE` (3.5) high, this one
 *  twice that, so the unscaled 36 left a lone chevron filling an Output parked
 *  ~40px from the rail. */
export const LINK_ARROW_MIN_ARC = ARROW_MIN_ARC * LINK_ARROW_HALF / (ribbonHalfWidth(1) + ARROW_FLARE);

/**
 * A STILL wire's direction chevrons as ONE path `d`, by the canvas wires' own
 * rule (`arrowMarks` + `chevronPath`, the same calls TypedEdge makes): an odd
 * count ~`ARROW_SPACING` apart along the ARC so one sits on the midpoint, none
 * on a wire too short to carry one (`LINK_ARROW_MIN_ARC`), never more than
 * `ARROW_MAX` — and
 * so never one on the wire's END, where it meets its rail socket. Measured on
 * the curve `linkPath` draws (`linkControlPoints`), so a chevron cannot sit
 * off its wire. Screen px, like the wire itself: the spacing does not follow
 * the canvas zoom because the wire's weight does not.
 */
export function linkArrows(start: Pt, end: Pt): string {
  const { c1, c2 } = linkControlPoints(start, end);
  return chevronPath(
    arrowMarks(
      [[start.x, start.y, c1.x, c1.y, c2.x, c2.y, end.x, end.y]],
      ARROW_SPACING,
      LINK_ARROW_MIN_ARC,
    ),
    LINK_ARROW_HALF,
  );
}

/**
 * Distance in screen px from a point to the drawn link curve.
 *
 * This is the ONLY way the wire can be hit-tested, and the alternatives were
 * checked rather than assumed. `.preview-link` is a z-index -1 sibling of
 * `.react-flow__renderer`, which is itself a stacking context (z-index 4)
 * wrapping the hit-testable pane — so NO `pointer-events` value makes a
 * decorative wire receive a pointer event without lifting it above every node
 * card, which would then have it swallowing presses aimed at the graph. And
 * `isPointInStroke` is defeated by the wire's own `stroke-dasharray`, which
 * leaves gaps the pointer falls through. So the hit test is arithmetic on the
 * same control points the path is drawn from, run from a pointermove on the
 * canvas rather than from the element.
 */
export function distanceToLink(start: Pt, end: Pt, px: number, py: number): number {
  const { c1, c2 } = linkControlPoints(start, end);
  return distancePointToCubicBezier(
    start.x, start.y,
    c1.x, c1.y,
    c2.x, c2.y,
    end.x, end.y,
    px, py,
  );
}

/**
 * One drawn Output→preview wire, as the hit test sees it: the node it leaves,
 * the label it shows on hover, and its two CLIENT-space endpoints.
 *
 * Client space and not the SVG's local space, although that is what the `d`
 * attribute carries: PreviewLink subtracts the SVG's own bounding box before
 * writing the path, which is a RIGID TRANSLATION, so a distance measured
 * against client-space endpoints is the same number — and the pointer arrives
 * in client coordinates, so keeping them here costs the hit test no conversion
 * and cannot drift by a stale pane offset between frames.
 */
export interface LinkWire {
  id: string;
  label: string;
  start: Pt;
  end: Pt;
}

/**
 * How close (screen px) the pointer must come to a wire to hover or click it.
 *
 * `DROP_ON_EDGE_RADIUS`'s 12 — the app's established "close enough to a wire"
 * distance — and screen px with no zoom division, unlike that one: this wire is
 * drawn OUTSIDE React Flow's transformed viewport at a constant on-screen
 * thickness (4.5px), so it neither grows nor shrinks with the zoom and a flow-
 * space radius would be wrong at every zoom but 1.
 */
export const LINK_HIT_RADIUS = 12;

/**
 * The wire nearest (px, py) within `radius`, or null.
 *
 * NEAREST rather than first-within-radius: the wires converge on the rail's
 * short column of sockets, so crossings are the norm rather than the
 * exception, and picking by array order would light up whichever Output
 * happened to be earlier in emit order instead of the one under the pointer.
 */
export function pickLinkAt(
  wires: readonly LinkWire[],
  px: number,
  py: number,
  radius: number = LINK_HIT_RADIUS,
): { wire: LinkWire; distance: number } | null {
  let best: { wire: LinkWire; distance: number } | null = null;
  for (const wire of wires) {
    const distance = distanceToLink(wire.start, wire.end, px, py);
    if (distance > radius) continue;
    if (!best || distance < best.distance) best = { wire, distance };
  }
  return best;
}
