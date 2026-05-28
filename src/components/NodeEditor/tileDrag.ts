/**
 * Touch/pen drag for ContentBrowser tiles. HTML5 drag-and-drop doesn't fire on
 * iOS Safari or most mobile browsers, so palette tiles are unusable without a
 * parallel path. This module owns that path: tiles call `startTileDrag` on
 * pointerdown (touch/pen only), we track the finger with a floating ghost, and
 * on pointerup we dispatch a `fs-tile-drop` CustomEvent on the canvas (or
 * cancel silently if the drop landed outside it). NodeEditor listens for that
 * event and reuses the same store actions the HTML5 onDrop path calls.
 *
 * Mouse drags keep using `draggable` + HTML5 DnD — that flow already handles
 * drop-on-edge highlighting and works fine on desktop.
 */

export type TilePayload =
  | { kind: 'node'; nodeType: string }
  | { kind: 'savedGroup'; id: string }
  | { kind: 'texture'; id: string };

export interface TileDropEventDetail {
  payload: TilePayload;
  clientX: number;
  clientY: number;
}

/** Custom-event name dispatched on `.node-editor__canvas` when a touch drag drops on it. */
export const TILE_DROP_EVENT = 'fs-tile-drop';

const MOVE_THRESHOLD_PX = 6;

/**
 * Begin a touch/pen drag from a tile. Returns immediately; window-level
 * listeners drive the rest of the gesture. Caller should only invoke this for
 * `pointerType === 'touch' | 'pen'`.
 */
export function startTileDrag(
  startEvent: PointerEvent,
  payload: TilePayload,
  ghostHtml: string,
): void {
  let dragging = false;
  let ghost: HTMLDivElement | null = null;
  const startX = startEvent.clientX;
  const startY = startEvent.clientY;
  const pointerId = startEvent.pointerId;

  const ensureGhost = (x: number, y: number) => {
    if (ghost) return;
    ghost = document.createElement('div');
    ghost.innerHTML = ghostHtml;
    Object.assign(ghost.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      transform: `translate(${x - 40}px, ${y - 40}px)`,
      pointerEvents: 'none',
      opacity: '0.75',
      zIndex: '10000',
      transition: 'none',
    } satisfies Partial<CSSStyleDeclaration>);
    document.body.appendChild(ghost);
  };

  const moveGhost = (x: number, y: number) => {
    if (ghost) ghost.style.transform = `translate(${x - 40}px, ${y - 40}px)`;
  };

  const cleanup = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    if (ghost?.parentNode) ghost.parentNode.removeChild(ghost);
    ghost = null;
  };

  const onMove = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!dragging && dx * dx + dy * dy < MOVE_THRESHOLD_PX * MOVE_THRESHOLD_PX) return;
    dragging = true;
    // Suppress page-scroll once we've committed to a drag.
    e.preventDefault();
    ensureGhost(e.clientX, e.clientY);
    moveGhost(e.clientX, e.clientY);
  };

  const onUp = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    try {
      if (!dragging) return;
      const canvas = document
        .elementFromPoint(e.clientX, e.clientY)
        ?.closest('.node-editor__canvas');
      if (!canvas) return;
      const detail: TileDropEventDetail = { payload, clientX: e.clientX, clientY: e.clientY };
      canvas.dispatchEvent(new CustomEvent(TILE_DROP_EVENT, { detail, bubbles: false }));
    } finally {
      cleanup();
    }
  };

  window.addEventListener('pointermove', onMove, { passive: false });
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}
