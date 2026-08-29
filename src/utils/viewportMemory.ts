/**
 * Remembers WHERE THE USER WAS LOOKING on the node canvas across a reload.
 *
 * Everything else about the session already survives a refresh — the graph, the
 * split ratios, the asset bar's height, the tab you were on — so coming back to
 * a canvas re-framed by `fitView` reads as the app having lost your place. This
 * stores React Flow's viewport (pan + zoom) and restores it at boot.
 *
 * ## The format is two integers and a zoom, NOT JSON
 *
 * `"<x>,<y>,<zoom>"` — the same reasoning as `fs:nodeEditorScroll`: three
 * numbers need no `JSON.parse`, so this read needs neither a reviver nor the
 * shared `safeJson` deny-list. It is VALIDATED rather than coerced, because
 * localStorage is writable by anything at this origin: `Number('')` is 0 and
 * `Number('١٢')` is 12, and a viewport that is quietly wrong reads as the
 * feature not working rather than as a bug anyone reports.
 *
 * ## The viewport belongs to the REMEMBERED GRAPH
 *
 * {@link readStoredViewport} takes the presence of the graph autosave as its
 * gate. A stored viewport with no stored graph means the graph key was cleared
 * (or this is a first-ever visit) and the canvas is about to show the built-in
 * demo — restoring a pan measured against a document that no longer exists
 * would open the app on empty canvas, which is the exact "did my work vanish?"
 * impression this feature exists to prevent. Falling back to `fitView` there is
 * both correct and what every previous version did.
 *
 * There is deliberately no attempt to go finer than that (per-shader viewports,
 * a graph digest): every path that REPLACES the graph — import, NEW, the
 * desktop Work folder — already runs `fitView`, and React Flow reports that
 * programmatic move through the same `onMoveEnd` this module records, so the
 * stored value re-aims itself without anyone having to remember to clear it.
 */

export const VIEWPORT_KEY = 'fs:viewport';

/** The graph autosave. Its presence is what makes a stored viewport meaningful. */
const GRAPH_KEY = 'fs:graph';

export interface StoredViewport {
  x: number;
  y: number;
  zoom: number;
}

/**
 * React Flow's own zoom bounds (`minZoom`/`maxZoom` on the ReactFlow element).
 * A stored zoom outside them would be clamped by React Flow on the first
 * interaction, so the restore would visibly jump the moment the user touched
 * the canvas — reject it up front instead.
 */
export const VIEWPORT_MIN_ZOOM = 0.1;
export const VIEWPORT_MAX_ZOOM = 3;

/**
 * Pan bound. A viewport this far out is not a place anyone navigated to; it is
 * either tampered input or a wild programmatic value, and restoring it shows
 * blank canvas. Generous enough that no real graph can reach it: at zoom 3 this
 * is still over three million flow units from the origin.
 */
const MAX_PAN = 1e7;

/** Length cap before any parsing — the same shape guard `parseScrollPos` uses. */
const MAX_RAW_LEN = 64;

/** Digits, one optional sign, one optional fraction. Deliberately no exponent,
 *  no whitespace, no unicode digits — this is the exact grammar we WRITE. */
const NUM_RE = /^-?\d+(\.\d+)?$/;

function parseNum(raw: string): number | null {
  if (!NUM_RE.test(raw)) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse a stored viewport string. Pure — exported for the tests, and so the
 * validation can be reasoned about without a DOM.
 *
 * Returns null for anything that is not exactly three in-range numbers.
 */
export function parseViewport(raw: string | null): StoredViewport | null {
  if (raw == null || raw.length === 0 || raw.length > MAX_RAW_LEN) return null;
  const parts = raw.split(',');
  if (parts.length !== 3) return null;
  const x = parseNum(parts[0]);
  const y = parseNum(parts[1]);
  const zoom = parseNum(parts[2]);
  if (x == null || y == null || zoom == null) return null;
  if (Math.abs(x) > MAX_PAN || Math.abs(y) > MAX_PAN) return null;
  if (zoom < VIEWPORT_MIN_ZOOM || zoom > VIEWPORT_MAX_ZOOM) return null;
  return { x, y, zoom };
}

/**
 * Serialize a viewport. Pan is rounded to whole pixels (sub-pixel pan is not
 * something anyone can perceive or aim for) and zoom kept to four decimals —
 * enough that a restored view is pixel-identical, short enough that the string
 * stays inside {@link MAX_RAW_LEN} at any pan.
 */
export function formatViewport(vp: StoredViewport): string {
  return `${Math.round(vp.x)},${Math.round(vp.y)},${Number(vp.zoom.toFixed(4))}`;
}

/**
 * The viewport to boot with, or null to let React Flow's `fitView` run.
 *
 * Read ONCE, during the first render of the canvas — before any effect can
 * write. Storage access is wrapped because Safari's private mode throws on
 * `localStorage` access rather than returning null.
 */
export function readStoredViewport(): StoredViewport | null {
  try {
    if (localStorage.getItem(GRAPH_KEY) == null) return null;
    return parseViewport(localStorage.getItem(VIEWPORT_KEY));
  } catch {
    return null;
  }
}

export function writeStoredViewport(vp: StoredViewport): void {
  if (!Number.isFinite(vp.x) || !Number.isFinite(vp.y) || !Number.isFinite(vp.zoom)) return;
  try {
    localStorage.setItem(VIEWPORT_KEY, formatViewport(vp));
  } catch {
    /* private mode / quota — the viewport is a convenience, never a failure */
  }
}
