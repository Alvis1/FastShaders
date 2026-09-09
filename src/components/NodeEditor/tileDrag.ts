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
  | { kind: 'texture'; id: string }
  | { kind: 'preset'; id: string };

export interface TileDropEventDetail {
  payload: TilePayload;
  clientX: number;
  clientY: number;
  /** True for click/Enter activation (dropTileAtCanvasCenter) — a plain add
   *  aimed near the canvas centre, with none of the drag-preview semantics. */
  activate?: boolean;
}

/** Custom-event name dispatched on `.node-editor__canvas` when a touch drag drops on it. */
export const TILE_DROP_EVENT = 'fs-tile-drop';

/** Fired on `.node-editor__canvas` for every touch-drag move over it (detail:
 *  TileDropEventDetail) — powers the live drag-connect / drop-on-edge preview.
 *  HTML5 mouse drags use NodeEditor's onDragOver instead. */
export const TILE_DRAG_MOVE_EVENT = 'fs-tile-drag-move';

/** Fired on `.node-editor__canvas` when a tile drag ends any way other than
 *  dropping on it (touch cleanup, HTML5 dragend after a cancel/outside drop,
 *  the finger wandering off the canvas) so drag previews get torn down. */
export const TILE_DRAG_END_EVENT = 'fs-tile-drag-end';

const MOVE_THRESHOLD_PX = 6;

/**
 * Click/Enter adds land at the canvas centre, so pressing a tile twice used to
 * drop the second node exactly on top of the first — indistinguishable from
 * nothing having happened, which is how a repeated add reads as broken. Each
 * activation is therefore scattered a little off the centre.
 *
 * SCREEN pixels, applied before `screenToFlowPosition`, so the visible gap is
 * the same at every zoom — a flow-space offset would be invisible when zoomed
 * out and a shove when zoomed in, and what matters here is only that the cards
 * do not sit on each other on screen.
 *
 * The ring is deliberately small: this is "so you can see there are two", not
 * a layout. Its outer radius stays inside a node's own footprint, so a
 * scattered add is still recognisably aimed at the middle of the view.
 */
export const SCATTER_MIN_PX = 24;
export const SCATTER_MAX_PX = 56;

/**
 * Turns advanced between consecutive activations — the golden angle (1 − 1/φ).
 *
 * A plain random angle repeats: two of a handful of rolls landing within a few
 * degrees is ordinary, and that is precisely the stacked pair this exists to
 * prevent. Stepping by the golden angle instead spreads every added node from
 * every earlier one, not just from the last, and it is still ≥ a quarter turn
 * from the previous one even after the jitter below — so two consecutive
 * offsets are always at least `√2 · SCATTER_MIN_PX` apart (~34px).
 */
const SCATTER_TURN = 0.3819660112501051;
/** Random slack on each step, so the ring reads as scattered, not as a dial. */
const SCATTER_JITTER_TURN = 0.06;

/** Where the last activation landed on the ring, in turns. Module state: this
 *  is a purely visual sequence, so it belongs nowhere near the graph. */
let scatterAngle: number | null = null;

/**
 * The next offset from the canvas centre, in screen px. Exported for tests —
 * `rand` is injectable, and `resetTileScatter` puts the sequence back to its
 * unstarted state so one test cannot see the previous one's angle.
 */
export function nextTileScatter(rand: () => number = Math.random): { dx: number; dy: number } {
  const step = SCATTER_TURN + (rand() * 2 - 1) * SCATTER_JITTER_TURN;
  const turns = scatterAngle === null ? rand() : scatterAngle + step;
  scatterAngle = turns - Math.floor(turns);
  const radius = SCATTER_MIN_PX + rand() * (SCATTER_MAX_PX - SCATTER_MIN_PX);
  const theta = scatterAngle * Math.PI * 2;
  return { dx: Math.cos(theta) * radius, dy: Math.sin(theta) * radius };
}

/** Test-only: forget the previous activation's angle. */
export function resetTileScatter(): void {
  scatterAngle = null;
}

/**
 * HTML5 dnd hides the drag payload until drop (`dataTransfer.getData` returns
 * '' during dragover by spec), so tiles ALSO record their payload here on
 * dragstart — this is what lets NodeEditor.onDragOver plan a drag-connect
 * preview for the node type in flight. Cleared on dragend.
 */
let html5TilePayload: TilePayload | null = null;

export function setHtml5TileDrag(payload: TilePayload): void {
  html5TilePayload = payload;
}

export function getHtml5TileDrag(): TilePayload | null {
  return html5TilePayload;
}

/** dragend hook for palette tiles: forget the payload and tell the canvas to
 *  drop any live previews (covers cancelled drags — Esc, drop outside). */
export function endHtml5TileDrag(): void {
  html5TilePayload = null;
  dispatchTileDragEnd();
}

function dispatchTileDragEnd(): void {
  document
    .querySelector('.node-editor__canvas')
    ?.dispatchEvent(new CustomEvent(TILE_DRAG_END_EVENT, { bubbles: false }));
}

/**
 * Add a tile's content without dragging, aimed NEAR the centre of the canvas
 * (scattered — see nextTileScatter).
 * Dispatches the same `fs-tile-drop` event the touch path uses, so placement
 * (including drop-on-edge splicing) stays a single implementation.
 * No-ops when the canvas isn't mounted.
 */
export function dropTileAtCanvasCenter(payload: TilePayload): void {
  const canvas = document.querySelector<HTMLElement>('.node-editor__canvas');
  if (!canvas) return;
  const r = canvas.getBoundingClientRect();
  // Scattered off the exact centre so repeated presses stack visibly rather
  // than landing on one another — see nextTileScatter.
  const { dx, dy } = nextTileScatter();
  const detail: TileDropEventDetail = {
    payload,
    clientX: r.left + r.width / 2 + dx,
    clientY: r.top + r.height / 2 + dy,
    activate: true,
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
// One touch tile drag at a time: NodeEditor's preview state (and the plan a
// drop commits) is single-gesture, so a second finger starting a concurrent
// drag could hand its plan to the OTHER finger's drop. Later starts are
// ignored until the active gesture's cleanup.
let touchDragActive = false;

export function startTileDrag(
  startEvent: PointerEvent,
  payload: TilePayload,
  ghostHtml: string,
): void {
  if (touchDragActive) return;
  touchDragActive = true;
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
    touchDragActive = false;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    if (ghost?.parentNode) ghost.parentNode.removeChild(ghost);
    ghost = null;
    // Runs AFTER onUp's drop dispatch (synchronous), so a landed drop has
    // already captured its preview before this teardown broadcast.
    dispatchTileDragEnd();
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
    // Stream the position to the canvas for the live drag-connect /
    // drop-on-edge preview (the ghost is pointer-events: none, so
    // elementFromPoint sees through it). Off-canvas → previews torn down.
    const canvas = document
      .elementFromPoint(e.clientX, e.clientY)
      ?.closest('.node-editor__canvas');
    if (canvas) {
      const detail: TileDropEventDetail = { payload, clientX: e.clientX, clientY: e.clientY };
      canvas.dispatchEvent(new CustomEvent(TILE_DRAG_MOVE_EVENT, { detail, bubbles: false }));
    } else {
      dispatchTileDragEnd();
    }
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
