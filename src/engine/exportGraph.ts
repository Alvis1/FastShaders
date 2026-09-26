/**
 * WHAT an export carries: every node on the canvas, or only the ones that feed
 * an Output — the EXPORT popover's "Include unconnected nodes" row, unticked by
 * default, so a download is the shader as it renders rather than the whole
 * scratch board (and an unwired Image node's payload no longer rides along).
 *
 * Only the EXPORT button honours that row. NEW's "Export Current" promises
 * "the whole project embedded — carry on where you left off", the desktop
 * Work-folder Save IS the document, and the study package is research data, so
 * those three always pass `'whole'` — a save that silently dropped nodes would
 * be data loss, not tidiness.
 *
 * Pure: no store, no DOM. `engine/exportShader.ts` reads the store and hands
 * the result to every builder (module, project block, image files, the
 * single-GLB plan), so one click prunes once and every part of the file agrees.
 */
import type { AppEdge, AppNode, GroupNodeData } from '@/types';
import { isSinkNode } from '@/utils/sdfPartition';
import { unwrapCollapsedGroupEdges } from '@/utils/edgeUtils';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { graphToCode } from './graphToCode';

export type ExportScope = 'connected' | 'whole';

/**
 * Rewrites a map keyed by EMITTED uniform name (`fs:previewUniformValues`,
 * `fs:previewUniformBounds`) for a pruned module. A property's emitted name is
 * its stored name unless another property already claimed it (`colorA2`), so
 * leaving out the node that held `colorA` hands the bare name to the survivor —
 * and the tuned value keyed `colorA` would land on the wrong slider.
 */
export interface UniformKeyRemap {
  /** Emitted names of properties that were left out. */
  drop: ReadonlySet<string>;
  /** Full-graph emitted name → the name the pruned module gives the same node. */
  rename: ReadonlyMap<string, string>;
}

/** What one export is built from. */
export interface ExportGraph {
  nodes: AppNode[];
  edges: AppEdge[];
  /** The module source: the code panel's text, or the pruned graph's codegen. */
  code: string;
  /** Nodes left out, group frames not counted. 0 = the canvas as it is, BY IDENTITY. */
  omitted: number;
  uniformKeys: UniformKeyRemap | null;
}

const isFrame = (n: AppNode): boolean => n.type === 'group';
const isNote = (n: AppNode): boolean => n.type === 'note';

/**
 * The ids a `'connected'` export keeps, or null when there is nothing to anchor
 * a prune to (no Output of any kind — keep everything rather than export an
 * empty file).
 *
 *  - every SINK (plain, Raymarch and Splat Output, parked or driving) and every
 *    node upstream of one, walked on the UNWRAPPED edges so collapse state
 *    cannot change the answer (a collapsed group's boundary edges point at its
 *    synthetic sockets);
 *  - every group frame holding a kept node, up the whole parent chain;
 *  - a COLLAPSED kept group whole: its `collapsedInputs`/`collapsedOutputs`
 *    name member ids, so dropping a member would leave a socket pointing at a
 *    node the file no longer has;
 *  - notes are annotations, not nodes a wire can reach: a note on the board is
 *    kept, a note inside a group goes with that group.
 *
 * Parent chains come from file data, so every walk is capped (a `parentId`
 * cycle must not hang the export).
 */
export function connectedExportIds(nodes: readonly AppNode[], edges: readonly AppEdge[]): Set<string> | null {
  const byId = new Map<string, AppNode>();
  for (const n of nodes) byId.set(n.id, n);
  const sinks = nodes.filter((n) => !isFrame(n) && !isNote(n) && isSinkNode(n));
  if (sinks.length === 0) return null;

  const feeders = new Map<string, string[]>();
  for (const e of unwrapCollapsedGroupEdges(nodes as AppNode[], edges as AppEdge[])) {
    const list = feeders.get(e.target);
    if (list) list.push(e.source);
    else feeders.set(e.target, [e.source]);
  }
  const keep = new Set<string>();
  const stack = sinks.map((n) => n.id);
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (keep.has(id)) continue;
    keep.add(id);
    for (const s of feeders.get(id) ?? []) if (!keep.has(s) && byId.has(s)) stack.push(s);
  }

  const parentOf = (n: AppNode): AppNode | undefined =>
    typeof n.parentId === 'string' ? byId.get(n.parentId) : undefined;
  const cap = nodes.length;
  for (const id of [...keep]) {
    let p = parentOf(byId.get(id)!);
    for (let hops = 0; p && hops < cap && !keep.has(p.id); hops++) {
      keep.add(p.id);
      p = parentOf(p);
    }
  }

  const children = new Map<string, AppNode[]>();
  for (const n of nodes) {
    if (typeof n.parentId !== 'string') continue;
    const list = children.get(n.parentId);
    if (list) list.push(n);
    else children.set(n.parentId, [n]);
  }
  for (const n of nodes) {
    if (!isFrame(n) || !keep.has(n.id) || (n.data as GroupNodeData).collapsed !== true) continue;
    const inside = [...(children.get(n.id) ?? [])];
    while (inside.length > 0) {
      const m = inside.pop()!;
      if (keep.has(m.id)) continue;
      keep.add(m.id);
      inside.push(...(children.get(m.id) ?? []));
    }
  }

  for (const n of nodes) {
    if (!isNote(n) || keep.has(n.id)) continue;
    const parent = parentOf(n);
    if (!parent || keep.has(parent.id)) keep.add(n.id);
  }
  return keep;
}

/**
 * The graph a `'connected'` export carries. Returns the SAME arrays when
 * nothing is left out, so the whole-canvas case stays byte-identical. An edge
 * survives when both of its STORED endpoints do — sound because a collapsed
 * group is kept whole or dropped whole, so a wire on its synthetic socket
 * lives exactly when the member behind it does.
 */
export function pruneToConnected(
  nodes: AppNode[],
  edges: AppEdge[],
): { nodes: AppNode[]; edges: AppEdge[]; omitted: number } {
  const keep = connectedExportIds(nodes, edges);
  if (!keep) return { nodes, edges, omitted: 0 };
  const kept = nodes.filter((n) => keep.has(n.id));
  if (kept.length === nodes.length) return { nodes, edges, omitted: 0 };
  return {
    nodes: kept,
    edges: edges.filter((e) => keep.has(e.source) && keep.has(e.target)),
    omitted: nodes.filter((n) => !keep.has(n.id) && !isFrame(n)).length,
  };
}

/** How many nodes a `'connected'` export would leave out (the popover's count). */
export function unconnectedNodeCount(nodes: AppNode[], edges: AppEdge[]): number {
  return pruneToConnected(nodes, edges).omitted;
}

const isProperty = (n: AppNode): boolean =>
  n.data.registryType === 'property_float' || n.data.registryType === 'property_color';

function uniformKeyRemap(
  nodes: readonly AppNode[],
  keptIds: ReadonlySet<string>,
  fullNames: ReadonlyMap<string, string>,
  prunedNames: ReadonlyMap<string, string>,
): UniformKeyRemap | null {
  const drop = new Set<string>();
  const rename = new Map<string, string>();
  for (const n of nodes) {
    if (!isProperty(n)) continue;
    const from = fullNames.get(n.id);
    if (from === undefined) continue;
    if (!keptIds.has(n.id)) {
      drop.add(from);
      continue;
    }
    const to = prunedNames.get(n.id);
    if (to !== undefined && to !== from) rename.set(from, to);
  }
  return drop.size > 0 || rename.size > 0 ? { drop, rename } : null;
}

/**
 * `record` keyed for the pruned module. Built on a null-prototype object: the
 * keys are identifiers from file data, and `__proto__` is a valid one.
 */
export function remapUniformKeys<T>(
  record: Record<string, T> | undefined,
  remap: UniformKeyRemap | null,
): Record<string, T> | undefined {
  if (!record || !remap) return record;
  const out: Record<string, T> = Object.create(null);
  for (const k of Object.keys(record)) {
    if (remap.drop.has(k) || remap.rename.has(k)) continue;
    out[k] = record[k];
  }
  for (const [from, to] of remap.rename) {
    if (Object.prototype.hasOwnProperty.call(record, from)) out[to] = record[from];
  }
  return out;
}

/**
 * What one export is built from. `'whole'`, a canvas with nothing to leave
 * out, and every case that cannot be pruned honestly return the store's own
 * arrays and code unchanged.
 *
 * The pruned module is REGENERATED from the pruned graph, which is only the
 * same shader when the code panel holds exactly what the graph generates. Code
 * typed and not applied, an applied text codeToGraph could not fully walk (an
 * imperative block is skipped with a warning), or a direct-assignment script
 * whose graph is not the code at all would each be silently replaced, so any
 * difference exports the whole canvas with the panel's text, as today.
 */
export function planExportGraph(
  src: { nodes: AppNode[]; edges: AppEdge[]; code: string },
  scope: ExportScope,
): ExportGraph {
  const whole: ExportGraph = { nodes: src.nodes, edges: src.edges, code: src.code, omitted: 0, uniformKeys: null };
  if (scope !== 'connected') return whole;
  const pruned = pruneToConnected(src.nodes, src.edges);
  if (pruned.nodes === src.nodes) return whole;
  try {
    const full = graphToCode(src.nodes, src.edges, NODE_REGISTRY);
    if (full.code !== src.code) return whole;
    const part = graphToCode(pruned.nodes, pruned.edges, NODE_REGISTRY);
    const keptIds = new Set(pruned.nodes.map((n) => n.id));
    return {
      nodes: pruned.nodes,
      edges: pruned.edges,
      code: part.code,
      omitted: pruned.omitted,
      uniformKeys: uniformKeyRemap(src.nodes, keptIds, full.varNames, part.varNames),
    };
  } catch {
    return whole;
  }
}
