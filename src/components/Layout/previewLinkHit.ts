/**
 * The LIVE preview-wire registry: `PreviewLink` writes the drawn wires'
 * client-space endpoints here every animation frame, and NodeEditor's
 * `onPaneClick` reads them to decide whether a click landed on one.
 *
 * A module singleton rather than a prop, a context or a store field, because
 * the two halves of the gesture belong to different components and neither can
 * hold the other's state:
 *
 *  - the GEOMETRY is PreviewLink's. It is the only thing reading those rects,
 *    and it reads them per frame (pan, zoom, node drag, split-pane resize all
 *    land there), so it can be neither a prop nor store state without pushing a
 *    render per frame.
 *  - the CLICK has to be React Flow's own `onPaneClick`. That is the only
 *    signal which already knows a marquee did not just end, a connection is not
 *    in progress, and the press landed on the PANE rather than on a node card —
 *    so a wire running under a card is not clickable THERE, which is exactly
 *    right. Re-deriving any of that inside PreviewLink is the fragile
 *    duplication this avoids.
 *
 * Not store state for a second reason: which wire the pointer is near is not a
 * fact about the graph. It must never push through history, the autosave or a
 * shared file (the `hoveredNodeId` / label-peek rule).
 *
 * PreviewLink's effect cleanup clears it, so an unmounted canvas cannot leave
 * stale wires for a later click to hit.
 */
import { pickLinkAt, type LinkWire } from './previewLinkGeometry';

let live: readonly LinkWire[] = [];

/** PreviewLink's per-frame publish. Pass an empty list to clear. */
export function setLivePreviewWires(wires: readonly LinkWire[]): void {
  live = wires;
}

/** What is currently drawn — for tests and for anything that wants to look. */
export function livePreviewWires(): readonly LinkWire[] {
  return live;
}

/** The wire under a client-space point, or null. NodeEditor's pane click. */
export function pickLivePreviewWire(px: number, py: number) {
  return pickLinkAt(live, px, py);
}
