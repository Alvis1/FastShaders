/**
 * MUTE — Blender's M (owner, 2026-11-13). A muted node stays on the canvas,
 * keeps its wires, its values and its variable NAME, and the shader runs as if
 * it were not there: every wire LEAVING it is read from the node's
 * PASS-THROUGH input instead — the upstream of that input, through any chain
 * of muted nodes — and a muted node with nothing wired in passes nothing, so
 * its consumers read their own unwired values. M again unmutes it; nothing was
 * lost.
 *
 * The flag is `data.muted`, read STRICTLY (`=== true`): node data arrives from
 * `.fastshader` files and the autosave, so `'yes'`, `1` and an object all read
 * as unmuted, and an absent key (every graph made before this) is unmuted,
 * which keeps every older graph byte-identical. Only `true` is ever written;
 * unmuting writes `undefined`, which no file keeps.
 *
 * A SINK (Output, SDF Output, Splat Output), a group frame and a note cannot
 * be muted — they pass nothing — so a flag on one is ignored here (a file can
 * carry it; nothing reads it).
 *
 * The PASS-THROUGH input is a node's main input for a bypass: Mix and Select
 * pass A (never the factor or the condition), Smoothstep passes X, every other
 * node its FIRST input. When that one is unwired the next wired input in the
 * registry's port order passes instead (then any other wired socket, in wire
 * order), so muting a node in a chain always keeps the chain flowing.
 *
 * ONE rule for every reader that must agree with the shader: graphToCode
 * (emission), cpuEvaluator (wire values), the cost walk (`pricedEdges`), the
 * code panel's scope (`feedsAnOutputIds`) and its Apply carry
 * (`restoreMutedOutWires`). The same pass-through also decides where Alt+drag
 * reconnects a node pulled out of its chain (`detachEdges`).
 *
 * Pure: no store, no DOM. Callers hand in UNWRAPPED edges where the graph is
 * read semantically (a collapsed group's boundary edges name its pill).
 */
import type { AppEdge, AppNode } from '@/types';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { isSinkNode } from '@/utils/sdfPartition';
import { generateEdgeId } from '@/utils/idGenerator';

/** The node data key. */
export const MUTED_KEY = 'muted';

/** A node type that may never be muted: it passes nothing, or is no node. */
function unmutable(node: AppNode): boolean {
  return node.type === 'group' || node.type === 'note' || isSinkNode(node);
}

/** Can M mute this node? Everything that computes a value can. */
export function canMuteNode(node: AppNode): boolean {
  return !unmutable(node);
}

/** Is this node muted? Only the literal `true` counts, and never on a sink. */
export function isMutedNode(node: AppNode): boolean {
  return (node.data as Record<string, unknown>)[MUTED_KEY] === true && !unmutable(node);
}

/** The muted node ids, or null when none is (the common case: every reader
 *  then takes its unchanged path, by identity). */
export function mutedNodeIds(nodes: readonly AppNode[]): Set<string> | null {
  let out: Set<string> | null = null;
  for (const n of nodes) if (isMutedNode(n)) (out ??= new Set()).add(n.id);
  return out;
}

/**
 * The canvas mark's key (components/NodeEditor/MutedMarks.tsx): the ids of
 * the muted nodes React Flow DRAWS (not `hidden` inside a collapsed group),
 * one per line — a node id holds no line break (`isSelectorSafeId`). Empty
 * when none is; a string, so a store selector can return it.
 */
export function mutedMarkKey(nodes: readonly AppNode[]): string {
  let key = '';
  for (const n of nodes) {
    if (n.hidden || !isMutedNode(n)) continue;
    key = key ? `${key}\n${n.id}` : n.id;
  }
  return key;
}

/** Types whose bypass input is NOT their first: the blended or chosen value,
 *  never the factor or the condition. A `Map`: a node type is adversarial. */
const PASS_INPUT_OVERRIDES: ReadonlyMap<string, string> = new Map([
  ['mix', 'a'],
  ['select', 'a'],
  ['smoothstep', 'x'],
]);

/** A node's input ids in pass-through preference order: the pass input, then
 *  the rest of the registry's port order. Exported for the test. */
export function passInputOrder(registryType: unknown): string[] {
  const def = typeof registryType === 'string' ? NODE_REGISTRY.get(registryType) : undefined;
  if (!def) return [];
  const ids = def.inputs.map((p) => p.id);
  const first = PASS_INPUT_OVERRIDES.get(def.type);
  if (first === undefined || !ids.includes(first)) return ids;
  return [first, ...ids.filter((id) => id !== first)];
}

/** Where one node's output is taken from when it is bypassed. */
export interface PassSource {
  source: string;
  sourceHandle: string | null | undefined;
}

/**
 * For every node in `through`, where its output is read from while it is
 * bypassed: the source of its pass-through wire, followed upstream through
 * any other node in `through`; null when the chain dead-ends (nothing wired
 * in, or a cycle). A socket reads its FIRST wire, as codegen does.
 */
export function passSources(
  nodes: readonly AppNode[],
  edges: readonly AppEdge[],
  through: ReadonlySet<string>,
): Map<string, PassSource | null> {
  const typeOf = new Map<string, unknown>();
  for (const n of nodes) if (through.has(n.id) && !typeOf.has(n.id)) typeOf.set(n.id, n.data.registryType);
  // The first wire into each socket of each bypassed node, in wire order.
  const into = new Map<string, Map<string, AppEdge>>();
  for (const e of edges) {
    if (!through.has(e.target)) continue;
    let sockets = into.get(e.target);
    if (!sockets) into.set(e.target, (sockets = new Map()));
    const h = typeof e.targetHandle === 'string' ? e.targetHandle : '';
    if (!sockets.has(h)) sockets.set(h, e);
  }
  const passWire = (id: string): AppEdge | null => {
    const sockets = into.get(id);
    if (!sockets) return null;
    for (const h of passInputOrder(typeOf.get(id))) {
      const e = sockets.get(h);
      if (e) return e;
    }
    const first = sockets.values().next();
    return first.done ? null : first.value;
  };

  const out = new Map<string, PassSource | null>();
  const resolve = (id: string, visiting: Set<string>): PassSource | null => {
    const known = out.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return null; // a cycle through bypassed nodes passes nothing
    visiting.add(id);
    const wire = passWire(id);
    let res: PassSource | null = null;
    if (wire) {
      res = through.has(wire.source)
        ? resolve(wire.source, visiting)
        : { source: wire.source, sourceHandle: wire.sourceHandle };
    }
    visiting.delete(id);
    out.set(id, res);
    return res;
  };
  for (const id of through) resolve(id, new Set());
  return out;
}

/** `e` re-sourced onto `via`, under the id the new endpoints mint. */
function resourced(e: AppEdge, via: PassSource): AppEdge {
  return {
    ...e,
    source: via.source,
    sourceHandle: via.sourceHandle,
    id: generateEdgeId(via.source, via.sourceHandle ?? 'out', e.target, e.targetHandle ?? 'in'),
  };
}

/**
 * The edges as the SHADER reads them: every wire leaving a muted node is
 * re-sourced onto its pass-through (or dropped when there is none), in its own
 * array position so "a socket reads its first wire" is unchanged. Wires INTO a
 * muted node stay — its card still shows what it computes, and graphToCode
 * leaves the node out of the module itself. By IDENTITY when nothing is muted.
 */
export function bypassMutedEdges(
  nodes: readonly AppNode[],
  edges: AppEdge[],
  muted: ReadonlySet<string> | null = mutedNodeIds(nodes),
): AppEdge[] {
  if (!muted || muted.size === 0) return edges;
  const pass = passSources(nodes, edges, muted);
  const out: AppEdge[] = [];
  for (const e of edges) {
    if (muted.has(e.target) || !muted.has(e.source)) {
      out.push(e);
      continue;
    }
    const via = pass.get(e.source);
    if (via) out.push(resourced(e, via));
  }
  return out;
}

/**
 * Alt+drag: pull `ids` out of the chains they sit in (Blender's "move and
 * detach links"). Every wire between a pulled node and one that stays is
 * removed, and each wire that LEFT the pulled set is reconnected from that
 * node's pass-through — the same rule as a mute, so the chain closes up behind
 * it exactly as muting it would have. Wires between two pulled nodes stay.
 * By identity when no wire crosses the set's boundary.
 */
export function detachEdges(
  nodes: readonly AppNode[],
  edges: AppEdge[],
  ids: ReadonlySet<string>,
): AppEdge[] {
  if (!edges.some((e) => ids.has(e.source) !== ids.has(e.target))) return edges;
  const pass = passSources(nodes, edges, ids);
  const taken = new Set<string>();
  const out: AppEdge[] = [];
  const socket = (e: AppEdge) => `${e.target}\0${e.targetHandle ?? ''}`;
  for (const e of edges) {
    const fromIn = ids.has(e.source);
    const toIn = ids.has(e.target);
    if (fromIn === toIn) {
      out.push(e);
      taken.add(socket(e));
      continue;
    }
    if (toIn) continue; // a wire into the pulled set: gone with it
    const via = pass.get(e.source);
    if (!via || taken.has(socket(e))) continue;
    taken.add(socket(e));
    out.push(resourced(e, via));
  }
  return out;
}
