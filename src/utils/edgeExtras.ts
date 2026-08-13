/**
 * Edge `data` is the one graph payload nothing validated — and it is the one
 * the engine never reads, which is exactly why it was missed. It carries only
 * visual state (the `dataType` tint and the user's routing waypoints), but it
 * rides every surface a shared `.fastshader` reaches: `buildProjectState`
 * embeds `state.edges` verbatim into the FASTSHADERS_PROJECT_V1 block,
 * `applyProjectToStore` assigns `project.graph.edges` straight into the store
 * — the block's element gate stops at `source`/`target` — and `loadGraph`
 * restores `fs:graph` without touching `edge.data` at all.
 *
 * The readers are NOT defensive. TypedEdge maps `waypoints` and dereferences
 * `w.x` during RENDER, and the app has no React error boundary anywhere, so
 * `waypoints: [null]` — or `waypoints: "abc"`, whose `.length` passes the
 * `hasWaypoints` gate — throws out of render and takes the whole tree down to
 * a blank page. The 300 ms autosave then persists the poison, so every reload
 * blanks again.
 *
 * Unbounded lists are the softer half, but measured: `splinePath` is O(N) and
 * runs once per channel plus once for the hit path (20 000 points → ~11 ms and
 * a 1.7 MB path `d`, each), `EdgeWaypointHandles` renders one <circle> per
 * point, and `findNearestEdge` re-measures the whole spline on every drag
 * pointermove. Non-finite coords are milder still — an invalid path `d`
 * renders as nothing, so the edge (and its hit area) simply disappears.
 *
 * Mirrors `sanitizeDrawings` (utils/drawings.ts) — the same class of
 * visual-only, file-carried, capped-on-read payload, same ±1e6 coordinate clamp.
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
 * Bound the visual `data` payload of an imported / restored edge list. Returns
 * the SAME array when nothing needed changing, so a clean graph keeps its
 * identity — the autosave subscriber and `selectionOnlyGraphChange`
 * (graphSemantics.ts) compare edges by `data` reference.
 *
 * A non-object ELEMENT is DROPPED, not passed through. Reading `.data` off a
 * null would throw inside `loadGraph`'s try, which returns null, which boots
 * the DEMO graph, which the 300 ms autosave then writes over the user's real
 * `fs:graph` — the exact unrecoverable outcome this sanitizer exists to
 * prevent. `fs:graph` has no element-shape gate (the project path has one) and
 * `autoExposeConnectedParamPorts` only walks edges inside its
 * `usesExposedPorts` branch, so a graph with no output/noise/image/time/mic
 * node reaches here with the null intact. A null edge is unrenderable anyway —
 * React Flow dereferences `e.id`.
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
