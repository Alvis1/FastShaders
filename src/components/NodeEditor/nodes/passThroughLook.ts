/**
 * What the Branch and Portal cards DRAW (KnotNode.tsx, TunnelNode.tsx): the
 * three facts each card reads off the store — the TYPE colour
 * of the value it carries, a Portal In's exit count and a Portal Out's live
 * entrance name. Pure: the store hands these `nodes`/`edges`, so a node test
 * can pin them (passThroughLook.test.ts). The sizes are the leaf
 * passThroughGeometry.ts.
 *
 * Every reader is shaped for a zustand SELECTOR, which runs on EVERY store
 * notify (each drag frame): each returns a PRIMITIVE, so an unchanged answer
 * re-renders nothing, and the counts and name walk the nodes without
 * allocating. The type colour needs a resolver, so it is computed ONCE per
 * graph version for every pass-through together (a single-entry memo on the
 * `nodes`/`edges` identities) and each card then reads its own entry.
 *
 * Data is adversarial: `link`/`label` are read only through utils/passThrough.ts'
 * readers, and a data type read off a node (a Data node's `dynamicOutputs`) is
 * kept only when it is one of the seven TSL type names — `TYPE_COLORS['constructor']`
 * would hand React a function for a colour.
 */
import type { AppEdge, AppNode, TSLDataType } from '@/types';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { getEdgeOutputShape } from '@/engine/cpuEvaluator';
import { unwrapGroupsOnly } from '@/utils/edgeUtils';
import {
  isTunnelIn,
  passThroughSources,
  tunnelLabelOf,
  tunnelLinkOf,
  type PassThroughSource,
} from '@/utils/passThrough';

const TSL_TYPES: ReadonlySet<string> = new Set(['float', 'int', 'vec2', 'vec3', 'vec4', 'color', 'any']);
const TYPE_BY_WIDTH: readonly TSLDataType[] = ['any', 'float', 'vec2', 'vec3', 'vec4'];

/**
 * The DECLARED type of the socket `handle` on `node`: a Data node's per-instance
 * `dynamicOutputs` first, then the registry port — the same order the
 * evaluator's `portShapeForHandle` reads. Null when nothing declares it.
 */
function declaredOutputType(node: AppNode, handle: string | null | undefined): TSLDataType | null {
  const id = handle ?? 'out';
  const data = node.data as { dynamicOutputs?: unknown; registryType?: unknown };
  if (Array.isArray(data.dynamicOutputs)) {
    for (const o of data.dynamicOutputs as unknown[]) {
      if (typeof o !== 'object' || o === null) continue;
      const port = o as { id?: unknown; dataType?: unknown };
      if (port.id !== id) continue;
      return typeof port.dataType === 'string' && TSL_TYPES.has(port.dataType)
        ? (port.dataType as TSLDataType)
        : null;
    }
  }
  const def = typeof data.registryType === 'string' ? NODE_REGISTRY.get(data.registryType) : undefined;
  const port = def?.outputs.find((p) => p.id === id);
  return port ? port.dataType : null;
}

/**
 * The type the value arriving at a pass-through has: the source socket's
 * declared type, and where that says only `any` (an Add, a Mix…) the width the
 * evaluator infers for the wire — 1 to 4 channels read float, vec2, vec3,
 * vec4 — so a Branch after an Add of two colours shows vec3, as its wire does.
 */
function sourceType(src: PassThroughSource, byId: ReadonlyMap<string, AppNode>, nodes: AppNode[], edges: AppEdge[]): TSLDataType {
  const node = byId.get(src.source);
  const declared = node ? declaredOutputType(node, src.sourceHandle) : null;
  if (declared && declared !== 'any') return declared;
  const width = getEdgeOutputShape(src, nodes, edges);
  return TYPE_BY_WIDTH[width] ?? 'any';
}

let typeMemo: { nodes: AppNode[]; edges: AppEdge[]; types: Map<string, TSLDataType | null> } | null = null;

/**
 * Every pass-through's resolved type, by node id; null where nothing reaches
 * it (an unfed Branch or Portal, a Portal Out that dangles or whose entrance is
 * unfed, a cycle). One resolver walk per graph version, shared by every card.
 */
export function passThroughTypes(nodes: AppNode[], edges: AppEdge[]): ReadonlyMap<string, TSLDataType | null> {
  if (typeMemo && typeMemo.nodes === nodes && typeMemo.edges === edges) return typeMemo.types;
  const types = new Map<string, TSLDataType | null>();
  const sources = passThroughSources(nodes, unwrapGroupsOnly(nodes, edges));
  if (sources.size > 0) {
    const byId = new Map<string, AppNode>();
    for (const n of nodes) if (!byId.has(n.id)) byId.set(n.id, n);
    for (const [id, src] of sources) types.set(id, src ? sourceType(src, byId, nodes, edges) : null);
  }
  typeMemo = { nodes, edges, types };
  return types;
}

/** One pass-through's resolved type (null = nothing reaches it): a store selector. */
export function passThroughTypeOf(nodes: AppNode[], edges: AppEdge[], id: string): TSLDataType | null {
  return passThroughTypes(nodes, edges).get(id) ?? null;
}

/** How many Portal Outs are linked to the entrance `entranceId`. Allocation-free. */
export function tunnelExitCount(nodes: readonly AppNode[], entranceId: string): number {
  let k = 0;
  for (const n of nodes) if (tunnelLinkOf(n) === entranceId) k++;
  return k;
}

/**
 * The CURRENT name of the Portal In `link` names, or null when the exit
 * DANGLES (no link, or it names no node, or a node that is not a Portal In).
 * The first node holding the id decides, as `tunnelEntrance` does.
 */
export function liveEntranceLabel(nodes: readonly AppNode[], link: string | null): string | null {
  if (link === null) return null;
  for (const n of nodes) if (n.id === link) return isTunnelIn(n) ? tunnelLabelOf(n) : null;
  return null;
}

/**
 * The exit count as the entrance prints it: "→N", or '' at exactly one exit
 * (the ordinary case says nothing). Zero prints, muted (TunnelNode).
 */
export function exitCountText(count: number): string {
  return count === 1 ? '' : `→${count}`;
}
