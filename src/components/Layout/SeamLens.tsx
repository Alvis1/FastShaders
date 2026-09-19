import { memo } from 'react';
import { lensAlong, lensPaths, type SeamOrientation } from './seamLensGeometry';

/**
 * The hover mark on a draggable seam — see seamLensGeometry.ts for what it is
 * and why. Rendered as the LAST child of the seam element it belongs to; the
 * host carries the `.fs-seam fs-seam--v|h` classes, and everything about the
 * lens's placement, opening and colour is CSS (`.fs-seam-lens` in
 * styles/controls.css): it is positioned by the `--fs-lens-at` custom property
 * `aimSeamLens` writes onto the host, opened by the host's `:hover` /
 * `.fs-seam--dragging`, and coloured by the host's `color`.
 *
 * Two marks share the one SVG: the BULGE (the line split open around the
 * pointer) and the RING (a circle with the same stripe, drawn at a junction
 * of two seams where a drag moves both). The host's `fs-seam--xy` class picks
 * which one is visible; both stay mounted so the swap is a cross-fade rather
 * than a remount.
 *
 * `pointer-events: none` (in the CSS) is load-bearing: the lens sits under the
 * pointer by construction, and a hittable lens would steal the very press it
 * invites from the seam beneath it.
 */
export const SeamLens = memo(function SeamLens({ orientation }: { orientation: SeamOrientation }) {
  const p = lensPaths(orientation);
  return (
    <svg
      className={`fs-seam-lens fs-seam-lens--${orientation}`}
      width={p.width}
      height={p.height}
      viewBox={p.viewBox}
      aria-hidden="true"
      focusable="false"
    >
      <g className="fs-seam-lens__bulge">
        <path className="fs-seam-lens__outline" d={p.outline} />
        <path className="fs-seam-lens__grip" d={p.grip} />
      </g>
      <g className="fs-seam-lens__ring">
        <path className="fs-seam-lens__outline" d={p.ring} />
        <path className="fs-seam-lens__grip" d={p.ringGrip} />
      </g>
    </svg>
  );
});

/**
 * Slide the host's lens to the pointer. One custom property on ONE element —
 * the host's subtree is the lens and a hit-zone pseudo-element, so the write
 * invalidates nothing else. Safe at pointer rate.
 */
export function aimSeamLens(
  host: HTMLElement,
  orientation: SeamOrientation,
  clientX: number,
  clientY: number,
): void {
  aimSeamLensAt(host, lensAlong(orientation, host.getBoundingClientRect(), clientX, clientY));
}

/** Put the lens at an explicit point along the seam (px from its start) — a
 *  junction snaps the ring onto the crossing rather than under the pointer. */
export function aimSeamLensAt(host: HTMLElement, alongPx: number): void {
  host.style.setProperty('--fs-lens-at', `${alongPx}px`);
}
