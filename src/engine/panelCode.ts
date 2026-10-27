/**
 * The code panel shows only the nodes that FEED AN OUTPUT (owner, 2026-10-27):
 * a chain wired to nothing stays on the canvas but is not in the TSL text, the
 * 3D preview or the module a save writes. The study keeps the whole panel
 * (`whole`, `isEvalMode()` at the one caller), so a running study measures
 * the editor it started with.
 *
 * The prune is an EMISSION scope (`graphToCode`'s `emitOnly`), never a pruned
 * graph: names are still claimed over the whole graph, so wiring or unwiring
 * an unrelated chain renames nothing — not a canvas header, not a tuned
 * uniform's key, not the Sound pump's names. EXPORT's own prune regenerates
 * from a pruned graph and re-keys the uniforms; that is the file's business,
 * not the live editor's.
 *
 * The Apply half — the nodes the text never held must survive a parse of it —
 * is `utils/panelCarry.ts`, keyed on the `emitted` set this returns (the
 * store's `codeEmitted`). Pure: no store, no DOM.
 */
import type { AppEdge, AppNode, GeneratedCode } from '@/types';
import { isSinkNode } from '@/utils/sdfPartition';
import { unwrapCollapsedGroupEdges } from '@/utils/edgeUtils';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { graphToCode } from './graphToCode';

/**
 * Every SINK (plain, Raymarch and Splat Output — parked ones too, whose
 * feeders the module still declares) and every node upstream of one, walked
 * on the UNWRAPPED edges so collapse state cannot change the answer. Null when
 * there is no sink at all: then nothing anchors a prune and the whole graph is
 * the answer, as on EXPORT.
 *
 * Frames and notes are never in it — they emit nothing. EXPORT's
 * `connectedExportIds` is this plus the expansions that keep a FILE intact
 * (frames up the parent chain, a collapsed group whole, board notes).
 */
export function feedsAnOutputIds(nodes: readonly AppNode[], edges: readonly AppEdge[]): Set<string> | null {
  const byId = new Map<string, AppNode>();
  for (const n of nodes) byId.set(n.id, n);
  const sinks = nodes.filter((n) => n.type !== 'group' && n.type !== 'note' && isSinkNode(n));
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
  return keep;
}

/**
 * The code panel's codegen. `whole` (a study session) is today's pass with
 * `emitted: null`; so is a graph with no sink. Otherwise the text holds only
 * `feedsAnOutputIds`, and `emitted` names them — what an Apply of this text
 * may legitimately rebuild, and everything else on the canvas it must carry.
 * `result.varNames` is always the WHOLE graph's map.
 */
export function panelCodegen(
  nodes: AppNode[],
  edges: AppEdge[],
  whole: boolean,
): { result: GeneratedCode; emitted: ReadonlySet<string> | null } {
  const ids = whole ? null : feedsAnOutputIds(nodes, edges);
  if (!ids) return { result: graphToCode(nodes, edges, NODE_REGISTRY), emitted: null };
  return { result: graphToCode(nodes, edges, NODE_REGISTRY, { emitOnly: ids }), emitted: ids };
}
