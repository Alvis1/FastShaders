/**
 * `edge.data` is adversarial and visual-only (the `dataType` tint): the engine
 * never reads it, while TypedEdge dereferences it during RENDER with no error
 * boundary. Sanitized on all three restore paths, like `sanitizeDrawings`.
 * Reasoning: docs/dev/canvas-interaction.md → Edge interactions.
 *
 * Routing points were REMOVED (owner, 2026-11-24: "just remove the routing
 * points without replacing"). An older file's `data.waypoints` is simply
 * DROPPED here, on every restore path — no conversion, the wire draws as its
 * plain curve, and the code cannot change (no engine ever read them).
 */

import type { AppEdge, TSLDataType } from '@/types';

/** The whole vocabulary of `edge.data`. Collapse state rides `edge.className`,
 *  not `data`, so nothing else is ever written; anything else in an imported
 *  file (an older file's `waypoints` included) is payload we would
 *  structuredClone into every history snapshot and JSON.stringify into every
 *  300 ms autosave for nothing. Keep in sync with `TypedEdgeData`
 *  (types/node.types.ts) — its index signature means TS will not flag a new
 *  key for you. */
const ALLOWED_DATA_KEYS: ReadonlySet<string> = new Set(['dataType']);

/** Written as a Record over the union so adding a TSLDataType fails to compile
 *  here instead of silently degrading every edge's tint to 'any'. */
const DATA_TYPE_TABLE: Record<TSLDataType, true> = {
  float: true, int: true, vec2: true, vec3: true, vec4: true, color: true, any: true,
};
const VALID_DATA_TYPES: ReadonlySet<string> = new Set(Object.keys(DATA_TYPE_TABLE));

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
  for (let e of edges) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) {
      changed = true;
      continue;
    }
    // `className` is adversarial too: the app writes only a string (a
    // collapsed group's `fs-collapsed-edge`), and a number, a boolean or an
    // object there threw in a per-edge render selector (`.includes`) on
    // every boot. Any non-string one is stripped; a string stays as it is.
    const cls = (e as { className?: unknown }).className;
    if (cls !== undefined && typeof cls !== 'string') {
      const { className: _c, ...rest } = e as AppEdge & { className?: unknown };
      void _c;
      e = rest as AppEdge;
      changed = true;
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
    if (dataType === src.dataType && Object.keys(src).every((k) => ALLOWED_DATA_KEYS.has(k))) {
      out.push(e);
      continue;
    }
    changed = true;
    out.push({ ...e, data: { dataType } } as AppEdge);
  }
  return changed ? out : edges;
}
