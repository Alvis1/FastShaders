/**
 * `edge.data` is adversarial and visual-only (the `dataType` tint, routing
 * waypoints): the engine never reads it, while TypedEdge dereferences it during
 * RENDER with no error boundary. Sanitized on all three restore paths, like
 * `sanitizeDrawings`. Reasoning: docs/dev/canvas-interaction.md → Edge interactions.
 */

import type { AppEdge, TSLDataType } from '@/types';

/** Routing points per edge. The UI adds them one double-click at a time and a
 *  hand-routed wire uses a handful, so this is generous by an order of
 *  magnitude while still bounding the per-render spline build and the one
 *  <circle> per point EdgeWaypointHandles mounts. */
export const MAX_WAYPOINTS_PER_EDGE = 64;

/** Flow-coordinate clamp — the same bound board ink uses. */
const COORD_LIMIT = 1e6;

/** The whole vocabulary of `edge.data`. Collapse state rides `edge.className`,
 *  not `data`, so nothing else is ever written; anything else in an imported
 *  file is payload we would structuredClone into every history snapshot and
 *  JSON.stringify into every 300 ms autosave for nothing. Keep in sync with
 *  `TypedEdgeData` (types/node.types.ts) — its index signature means TS will
 *  not flag a new key for you. */
const ALLOWED_DATA_KEYS: ReadonlySet<string> = new Set(['dataType', 'waypoints']);

/** Written as a Record over the union so adding a TSLDataType fails to compile
 *  here instead of silently degrading every edge's tint to 'any'. */
const DATA_TYPE_TABLE: Record<TSLDataType, true> = {
  float: true, int: true, vec2: true, vec3: true, vec4: true, color: true, any: true,
};
const VALID_DATA_TYPES: ReadonlySet<string> = new Set(Object.keys(DATA_TYPE_TABLE));

/** One finite, in-bounds coordinate or `null` if unusable. Same shape as
 *  drawings.ts's `cleanCoord` — note JSON.parse turns `1e999` into Infinity,
 *  which is exactly the value that produces an invalid, invisible path `d`. */
function cleanCoord(n: unknown): number | null {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v)) return null;
  return Math.max(-COORD_LIMIT, Math.min(COORD_LIMIT, v));
}

/**
 * Returns the ORIGINAL array when every point is already valid and in budget
 * (so a clean edge keeps its `data` identity), a bounded copy when anything
 * needed fixing, or `undefined` for "no routing" — which is what
 * `setEdgeWaypoints` itself stores for an empty list.
 */
function cleanWaypoints(raw: unknown): Array<{ x: number; y: number }> | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return undefined;
  let pristine = raw.length <= MAX_WAYPOINTS_PER_EDGE;
  const clean: Array<{ x: number; y: number }> = [];
  for (const w of raw) {
    if (clean.length >= MAX_WAYPOINTS_PER_EDGE) break;
    if (!w || typeof w !== 'object' || Array.isArray(w)) { pristine = false; continue; }
    const rec = w as Record<string, unknown>;
    const x = cleanCoord(rec.x);
    const y = cleanCoord(rec.y);
    if (x === null || y === null) { pristine = false; continue; }
    // Coerced, clamped, or carrying smuggled extra keys — rebuild rather than
    // pass the caller's object through.
    if (x !== rec.x || y !== rec.y || Object.keys(rec).length !== 2) pristine = false;
    clean.push({ x, y });
  }
  if (clean.length === 0) return undefined;
  return pristine ? (raw as Array<{ x: number; y: number }>) : clean;
}

/**
 * Bound the visual `data` payload of a restored edge list. Returns the SAME
 * array when clean: the autosave subscriber and `selectionOnlyGraphChange`
 * compare edges by `data` reference.
 * A non-object ELEMENT is DROPPED, never passed through: reading `.data` off a
 * null throws inside `loadGraph`'s try, which boots the DEMO graph, which the
 * autosave then writes over the user's `fs:graph`.
 */
export function sanitizeEdgeExtras(edges: AppEdge[]): AppEdge[] {
  let changed = false;
  const out: AppEdge[] = [];
  for (const e of edges) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) {
      changed = true;
      continue;
    }
    const raw = (e as { data?: unknown }).data;
    if (raw === undefined || raw === null) { out.push(e); continue; }
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      changed = true;
      out.push({ ...e, data: { dataType: 'any' } } as AppEdge);
      continue;
    }
    const src = raw as Record<string, unknown>;
    const dataType = VALID_DATA_TYPES.has(src.dataType as string)
      ? (src.dataType as TSLDataType)
      : 'any';
    const waypoints = cleanWaypoints(src.waypoints);
    if (
      dataType === src.dataType &&
      waypoints === src.waypoints &&
      Object.keys(src).every((k) => ALLOWED_DATA_KEYS.has(k))
    ) {
      out.push(e);
      continue;
    }
    changed = true;
    const next: Record<string, unknown> = { dataType };
    if (waypoints) next.waypoints = waypoints;
    out.push({ ...e, data: next } as AppEdge);
  }
  return changed ? out : edges;
}
