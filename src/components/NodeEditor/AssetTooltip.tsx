import { useState, useRef, useCallback, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import './AssetTooltip.css';

/** Hover dwell before the tooltip appears. */
const SHOW_DELAY_MS = 350;
/** Gap between the tile's top edge and the tooltip. */
const ANCHOR_GAP = 6;
/** Minimum clearance from the viewport edges when clamping. */
const EDGE_MARGIN = 8;

interface Anchor {
  /** Horizontal center of the tile (viewport px). */
  centerX: number;
  /** Top edge of the tile (viewport px). */
  top: number;
}

/**
 * The one tile whose tooltip is pending or visible, and the ONE pair of window
 * listeners that dismisses it — not one pair per tile.
 *
 * `useAssetTooltip` runs once per TILE, and the strip renders every filtered
 * definition with no windowing: 77 cards on the default tab, ~110 with the
 * optional categories switched on. Subscribing from the hook's own effect
 * therefore put 150+ CAPTURE-phase listeners on `window`, and capture listeners
 * run before the canvas's own handler — so every wheel event over the node
 * canvas (the primary zoom control, 60-120 events/s on a trackpad) fanned out
 * to 77 `hide()` closures to dismiss a tooltip that at most ONE of them could
 * own. The per-tile reasoning ("hide() while already hidden is a no-op
 * setState") was true and missed the multiplier.
 *
 * Only one tile can be dwelling or open at a time — the pointer is over one
 * tile — so the module holds that tile's `hide` and subscribes only while it
 * exists. At rest there are no listeners at all. Same shape as TypedHandle's
 * `activeTapClear`.
 */
let activeHide: (() => void) | null = null;

function dismissActive() {
  activeHide?.();
}

/** Adopt (or release) the one tile whose tooltip is pending or visible. */
function setActiveHide(hide: (() => void) | null) {
  if (activeHide === hide) return;
  // A second tile arming without the first's pointerleave (the strip can scroll
  // out from under a stationary pointer, and browsers don't re-fire pointer
  // boundary events for that) would otherwise strand the first tile's dwell
  // timer — it would fire and show a tooltip for a tile nobody is over. This
  // re-enters through the released tile's own hide(), which lands on the branch
  // below and clears `activeHide` before we set ours.
  if (activeHide && hide) activeHide();
  if (hide && !activeHide) {
    window.addEventListener('scroll', dismissActive, { capture: true, passive: true });
    window.addEventListener('wheel', dismissActive, { capture: true, passive: true });
  } else if (!hide && activeHide) {
    window.removeEventListener('scroll', dismissActive, { capture: true });
    window.removeEventListener('wheel', dismissActive, { capture: true });
  }
  activeHide = hide;
}

/**
 * Hover tooltip for asset-bar tiles. Rendered through a body portal with
 * `position: fixed` — the content browser clips overflow, so an in-flow
 * tooltip could never escape the strip — and placed ABOVE the anchor (the
 * asset bar sits at the bottom edge of the app).
 *
 * Spread `tooltipHandlers` onto the tile element and render `tooltip` next to
 * its children. Mouse-only: touch/pen never hover, and tap-drags shouldn't
 * flash tooltips. The hide handlers run in the capture phase so they compose
 * with the tiles' own drag/pointer handlers.
 */
export function useAssetTooltip(text: string | undefined) {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const timerRef = useRef<number | undefined>(undefined);
  const boxRef = useRef<HTMLDivElement>(null);

  // Annotated so the self-reference below isn't a circular type inference.
  const hide: () => void = useCallback(() => {
    window.clearTimeout(timerRef.current);
    // Nothing left to dismiss for this tile, so drop the subscription with it.
    if (activeHide === hide) setActiveHide(null);
    setAnchor(null);
  }, []);

  const onPointerEnter = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (!text || e.pointerType !== 'mouse') return;
      const el = e.currentTarget;
      window.clearTimeout(timerRef.current);
      // Any scroll (including the strip's wheel→horizontal scroll) or wheel
      // (Ctrl/Cmd+wheel zooms the tiles without necessarily scrolling)
      // invalidates both a PENDING dwell timer (the tile under the stationary
      // cursor may have changed — browsers don't re-fire pointer boundary
      // events for it) and a visible tooltip (stale rect). Subscribe for the
      // dwell rather than for the whole mount: this hook runs once per tile,
      // and the strip has ~77 of them (see setActiveHide).
      setActiveHide(hide);
      // Measure at fire time, not enter time — the strip may scroll under the
      // pointer (wheel → scrollLeft) while the dwell timer runs.
      timerRef.current = window.setTimeout(() => {
        const r = el.getBoundingClientRect();
        if (r.width === 0) return; // tile unmounted mid-dwell
        setAnchor({ centerX: r.left + r.width / 2, top: r.top });
      }, SHOW_DELAY_MS);
    },
    [text, hide],
  );

  useEffect(
    () => () => {
      window.clearTimeout(timerRef.current);
      // A tile unmounted mid-dwell (a search keystroke refilters the strip)
      // must not leave the module pointing at a dead component — the listeners
      // would then survive with nothing able to release them.
      if (activeHide === hide) setActiveHide(null);
    },
    [hide],
  );

  // Clamp horizontally after layout (the width isn't known until the text
  // renders), then reveal.
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box || !anchor) return;
    const half = box.offsetWidth / 2;
    const centerX = Math.min(
      Math.max(anchor.centerX, EDGE_MARGIN + half),
      window.innerWidth - EDGE_MARGIN - half,
    );
    box.style.left = `${centerX}px`;
    box.style.visibility = 'visible';
  }, [anchor]);

  const tooltip =
    anchor && text
      ? createPortal(
          <div
            ref={boxRef}
            className="asset-tooltip"
            role="tooltip"
            style={{
              left: anchor.centerX,
              bottom: window.innerHeight - anchor.top + ANCHOR_GAP,
              visibility: 'hidden',
            }}
          >
            {text}
          </div>,
          document.body,
        )
      : null;

  return {
    tooltip,
    tooltipHandlers: {
      onPointerEnter,
      onPointerLeave: hide,
      onPointerDownCapture: hide,
      onDragStartCapture: hide,
    },
  };
}
