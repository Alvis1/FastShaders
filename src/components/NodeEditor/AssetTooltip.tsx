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

  const hide = useCallback(() => {
    window.clearTimeout(timerRef.current);
    setAnchor(null);
  }, []);

  const onPointerEnter = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (!text || e.pointerType !== 'mouse') return;
      const el = e.currentTarget;
      window.clearTimeout(timerRef.current);
      // Measure at fire time, not enter time — the strip may scroll under the
      // pointer (wheel → scrollLeft) while the dwell timer runs.
      timerRef.current = window.setTimeout(() => {
        const r = el.getBoundingClientRect();
        if (r.width === 0) return; // tile unmounted mid-dwell
        setAnchor({ centerX: r.left + r.width / 2, top: r.top });
      }, SHOW_DELAY_MS);
    },
    [text],
  );

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  // Any scroll (including the strip's wheel→horizontal scroll) or wheel
  // (Ctrl/Cmd+wheel zooms the tiles without necessarily scrolling) invalidates
  // both a PENDING dwell timer (the tile under the stationary cursor may have
  // changed — browsers don't re-fire pointer boundary events for it) and a
  // visible tooltip (stale rect) — dismiss unconditionally. Listening for the
  // whole mount is fine: hide() while already hidden is a no-op setState.
  useEffect(() => {
    window.addEventListener('scroll', hide, { capture: true, passive: true });
    window.addEventListener('wheel', hide, { capture: true, passive: true });
    return () => {
      window.removeEventListener('scroll', hide, { capture: true });
      window.removeEventListener('wheel', hide, { capture: true });
    };
  }, [hide]);

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
