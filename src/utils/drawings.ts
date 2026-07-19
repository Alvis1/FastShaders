/**
 * Board drawing layer — data model + pure helpers.
 *
 * Freehand ink annotations on the node-editor canvas, like notes and edge
 * waypoints: VISUAL-ONLY, never part of the shader graph. Strokes live in their
 * own zustand slice (`drawings`), ride the graph autosave + project embed, and
 * are invisible to graphToCode / cpuEvaluator / the sync engine.
 *
 * The one semantic that shapes this module: overlapping strokes drawn at the
 * SAME opacity must NOT compound (darken) where they cross. That is achieved at
 * render time by grouping same-opacity strokes under one SVG `<g opacity>`
 * isolation buffer (see DrawingLayer). Two consequences pinned here:
 *   1. opacity is QUANTIZED (`OPACITY_STEP`) so "same opacity" is exact and the
 *      number of isolation buffers stays bounded (the group count is the GPU
 *      cost driver — see the frame-time profiler).
 *   2. per-stroke alpha is FORBIDDEN in `color` (6-digit hex only): an 8-digit
 *      hex would smuggle alpha past the group-opacity isolation and reintroduce
 *      compounding.
 */

export interface DrawStroke {
  id: string;
  /** `#rrggbb` — 6-digit hex only; alpha lives on `opacity`, never here. */
  color: string;
  /** (0, 1], quantized to `OPACITY_STEP`. The isolation-group key. */
  opacity: number;
  /** Stroke width in FLOW units — ink scales with zoom like nodes and edges. */
  width: number;
  /** Flat `[x0,y0,x1,y1,…]` in flow coords — compact for JSON + history clones. */
  points: number[];
}

/** Caps (adversarial `.fastshader`/localStorage input is bounded to these). */
export const MAX_STROKES = 400;
export const MAX_POINTS_PER_STROKE = 500; // points, i.e. 1000 numbers
export const MAX_TOTAL_POINTS = 40_000;
export const OPACITY_STEP = 0.05; // 20 possible isolation groups
export const MIN_STROKE_WIDTH = 0.5;
export const MAX_STROKE_WIDTH = 200; // flow units
const COORD_LIMIT = 1e6;
const HEX6 = /^#[0-9a-fA-F]{6}$/;

/** Clamp + quantize an opacity to a valid isolation-group key in [step, 1]. */
export function quantizeOpacity(o: number): number {
  const clamped = Math.min(1, Math.max(OPACITY_STEP, Number.isFinite(o) ? o : 1));
  // round to the step, then to 2 decimals so keys are exact (0.15, not 0.1500001)
  return Math.round(Math.round(clamped / OPACITY_STEP) * OPACITY_STEP * 100) / 100;
}

/** True for a literal 6-digit hex color (no alpha channel). */
export function isValidStrokeColor(c: unknown): c is string {
  return typeof c === 'string' && HEX6.test(c);
}

/** One finite, in-bounds coordinate or `null` if unusable. */
function cleanCoord(n: unknown): number | null {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v)) return null;
  return Math.max(-COORD_LIMIT, Math.min(COORD_LIMIT, v));
}

/**
 * Bound an untrusted drawings array to the caps and value rules. Drops strokes
 * that can't be salvaged (bad color, < 2 usable points), truncates over-long
 * strokes, and enforces the stroke- and total-point ceilings. Pure; returns a
 * fresh array of fresh strokes.
 */
export function sanitizeDrawings(input: unknown): DrawStroke[] {
  if (!Array.isArray(input)) return [];
  const out: DrawStroke[] = [];
  let totalPoints = 0;

  for (const raw of input) {
    if (out.length >= MAX_STROKES) break;
    if (!raw || typeof raw !== 'object') continue;
    const s = raw as Record<string, unknown>;

    if (!isValidStrokeColor(s.color)) continue;

    // Flatten + clean the point coordinates, capping this stroke's length.
    const src = Array.isArray(s.points) ? s.points : [];
    const pts: number[] = [];
    const maxNums = MAX_POINTS_PER_STROKE * 2;
    for (let i = 0; i + 1 < src.length && pts.length < maxNums; i += 2) {
      const x = cleanCoord(src[i]);
      const y = cleanCoord(src[i + 1]);
      if (x === null || y === null) continue;
      pts.push(x, y);
    }
    if (pts.length < 4) continue; // need >= 2 points to draw a line

    // Enforce the global point budget — truncate the stroke that crosses it,
    // then stop taking further strokes.
    if (totalPoints + pts.length > MAX_TOTAL_POINTS * 2) {
      const room = MAX_TOTAL_POINTS * 2 - totalPoints;
      if (room < 4) break;
      pts.length = room - (room % 2);
    }
    totalPoints += pts.length;

    const width =
      Math.max(MIN_STROKE_WIDTH, Math.min(MAX_STROKE_WIDTH, Number(s.width) || 3));

    out.push({
      id: typeof s.id === 'string' && s.id ? s.id : `stroke_${out.length}_${pts.length}`,
      color: (s.color as string).toLowerCase(),
      opacity: quantizeOpacity(Number(s.opacity)),
      width,
      points: pts,
    });
  }
  return out;
}

export interface OpacityGroup {
  opacity: number;
  strokes: DrawStroke[];
}

/**
 * Partition strokes into per-opacity groups for isolation-buffer rendering.
 * Groups are ordered by the recency of their newest stroke (a group whose ink
 * was most recently added renders on top) — cross-opacity draw order is the
 * normal compositing the requirement permits, so any stable order is correct;
 * recency-on-top is the least surprising. Strokes keep insertion order within a
 * group. Fully-opaque strokes (opacity === 1) still get a group, but that group
 * needs no real isolation buffer (α=1 composites trivially).
 */
export function groupByOpacity(drawings: DrawStroke[]): OpacityGroup[] {
  const byOpacity = new Map<number, DrawStroke[]>();
  const newestIndex = new Map<number, number>();
  drawings.forEach((s, i) => {
    let arr = byOpacity.get(s.opacity);
    if (!arr) { arr = []; byOpacity.set(s.opacity, arr); }
    arr.push(s);
    newestIndex.set(s.opacity, i);
  });
  return Array.from(byOpacity.entries())
    .map(([opacity, strokes]) => ({ opacity, strokes }))
    .sort((a, b) => (newestIndex.get(a.opacity)! - newestIndex.get(b.opacity)!));
}

/** Flat `[x,y,…]` → `[[x,y],…]` for the shared spline helpers. */
export function strokePointPairs(points: number[]): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i + 1 < points.length; i += 2) pairs.push([points[i], points[i + 1]]);
  return pairs;
}

/** Axis-aligned bounds of a stroke (flow coords), for a cheap eraser prefilter. */
export function strokeBounds(points: number[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i + 1 < points.length; i += 2) {
    const x = points[i], y = points[i + 1];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}
