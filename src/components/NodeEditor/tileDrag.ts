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
 *
 * It also owns click/keyboard activation (`tileActivationProps`), which routes
 * through the same drop event so every way of adding a tile — mouse drag, touch
 * drag, click, Enter — ends up in one placement implementation.
 */

import type { KeyboardEvent } from 'react';

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
 * Add a tile's content without dragging, aimed at the centre of the canvas.
 * Dispatches the same `fs-tile-drop` event the touch path uses, so placement
 * (including drop-on-edge splicing) stays a single implementation.
 * No-ops when the canvas isn't mounted.
 */
export function dropTileAtCanvasCenter(payload: TilePayload): void {
  const canvas = document.querySelector<HTMLElement>('.node-editor__canvas');
  if (!canvas) return;
  const r = canvas.getBoundingClientRect();
  const detail: TileDropEventDetail = {
    payload,
    clientX: r.left + r.width / 2,
    clientY: r.top + r.height / 2,
  };
  canvas.dispatchEvent(new CustomEvent(TILE_DROP_EVENT, { detail, bubbles: false }));
}

/**
 * Props making a palette tile activatable by click and by keyboard. Tiles were
 * drag-only, which is fiddly on a trackpad and impossible for keyboard and
 * motor-impaired users — and it meant the two node catalogs disagreed about how
 * you add a thing (the right-click menu was click-to-add, the palette was not).
 */
export function tileActivationProps(payload: TilePayload, label: string) {
  const activate = () => dropTileAtCanvasCenter(payload);
  return {
    role: 'button',
    tabIndex: 0,
    'aria-label': label,
    onClick: activate,
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      activate();
    },
  };
}

/**
 * The user-adjustable tile zoom lives as an inline `zoom` style on
 * `.content-browser__items`; a body-appended drag ghost doesn't inherit it, so
 * ghost builders bake it into their wrapper (`style="zoom: …"`). Returns a
 * numeric string safe for HTML interpolation ('1' when unset/invalid).
 */
export function tileGhostZoom(tile: HTMLElement): string {
  const raw = tile
    .closest<HTMLElement>('.content-browser__items')
    ?.style.getPropertyValue('zoom');
  const z = parseFloat(raw ?? '');
  return Number.isFinite(z) && z > 0 ? String(z) : '1';
}

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
