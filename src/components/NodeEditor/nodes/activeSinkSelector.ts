import type { AppNode } from '@/types';
import type { AppEdge } from '@/types';
import { activeSink, hasActiveFlag, isCustomSink, isSinkNode, isSplatOutput, isUntargetedOutput } from '@/utils/sdfPartition';
import { findDefaultOutput } from '@/utils/outputMaterials';
import { getUnwrappedEdges } from '@/engine/cpuEvaluator';

/**
 * WHICH sink is active, once per (nodes, edges) pair.
 *
 * Every Output and Raymarch Output card asks, and the answer is a property of
 * the SET — so a 16-material GLB import ran this ~17 times per store notify,
 * i.e. per drag frame. Worse on the common path than it reads: the flag
 * shortcut only fires once someone has CLICKED a preview socket, and an
 * import-built document has never been clicked, so all seventeen fell through
 * to `activeSink` — each allocating the whole unwrapped edge array.
 *
 * Two fixes, both needed. The single-entry memo (the `defaultContributesMemo`
 * idiom) collapses the seventeen scans to one per notify; and the unwrap goes
 * through `getUnwrappedEdges`, the ctx-memoized form PreviewLink already uses,
 * which reuses one array across a drag frame instead of minting one per call.
 */
let activeMemo: { nodes: readonly AppNode[]; edges: readonly AppEdge[]; id: string | null } | null = null;
export function activeSinkId(nodes: AppNode[], edges: AppEdge[]): string | null {
  if (activeMemo && activeMemo.nodes === nodes && activeMemo.edges === edges) return activeMemo.id;
  let id: string | null = null;
  // The flag shortcut uses `activeSink`'s OWN eligibility rule: a flag on a
  // TARGETED plain Output cannot be honoured (it is skipped, and the next
  // flagged or wired sink wins). Breaking on the first flag of any kind made
  // this memo name that node while `activeSink` named another — reachable
  // in-session by ticking a mesh on the flagged Output, until the next restore
  // normalizes the flag away.
  for (const n of nodes) {
    if (isSinkNode(n) && hasActiveFlag(n) && (isCustomSink(n) || isUntargetedOutput(n))) { id = n.id; break; }
  }
  if (id === null) id = activeSink(nodes, getUnwrappedEdges(nodes, edges))?.id ?? null;
  activeMemo = { nodes, edges, id };
  return id;
}

/**
 * "Is node `id` the active sink?" as a store selector for the Output and
 * Raymarch Output components. A boolean, so a graph notify that does not move
 * the choice re-renders nothing.
 */
export function isActiveSinkSelector(id: string): (s: { nodes: AppNode[]; edges: AppEdge[] }) => boolean {
  return (s) => activeSinkId(s.nodes, s.edges) === id;
}

/**
 * The node Preview mode's route line ENDS on — exactly `previewTargetId`
 * (utils/nodePreview.ts, which `previewGraph` follows), answered from the memo
 * above instead of a second election. PreviewRoute is always mounted and asks
 * on every store notify while the mode is on; `previewTargetId` unwraps the
 * edges and re-runs `activeSink` each time, while the Output cards have
 * already paid for this exact (nodes, edges) pair.
 *
 * A canvas with no Splat Output keeps the pre-splat path — `findDefaultOutput`
 * alone, never the election. `nodePreview.test.ts` pins the two answers equal
 * over every shape the election distinguishes. The utils module does not
 * import this one: the memo belongs to the render layer.
 */
export function previewRouteTargetId(nodes: AppNode[], edges: AppEdge[]): string | null {
  if (!nodes.some(isSplatOutput)) return findDefaultOutput(nodes)?.id ?? null;
  const id = activeSinkId(nodes, edges);
  if (id !== null) {
    for (const n of nodes) if (n.id === id) { if (isSplatOutput(n)) return id; break; }
  }
  return findDefaultOutput(nodes)?.id ?? null;
}
