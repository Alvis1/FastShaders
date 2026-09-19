import type { AppNode } from '@/types';
import type { AppEdge } from '@/types';
import { activeSink, hasActiveFlag, isSinkNode } from '@/utils/sdfPartition';
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
function activeSinkId(nodes: AppNode[], edges: AppEdge[]): string | null {
  if (activeMemo && activeMemo.nodes === nodes && activeMemo.edges === edges) return activeMemo.id;
  let id: string | null = null;
  for (const n of nodes) {
    if (isSinkNode(n) && hasActiveFlag(n)) { id = n.id; break; }
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
