import type { AppNode } from '@/types';
import type { AppEdge } from '@/types';
import { activeSink, hasActiveFlag, isSinkNode } from '@/utils/sdfPartition';
import { unwrapCollapsedGroupEdges } from '@/utils/edgeUtils';

/**
 * "Is node `id` the active sink?" as a store selector for the Output and
 * Raymarch Output components. A boolean, so a graph notify that does not move
 * the choice re-renders nothing — and CHEAP on the common path: while any sink
 * carries the flag the answer needs no edges at all, so the collapsed-group
 * unwrap (an allocation per notify, and React Flow notifies at refresh rate
 * during a drag) runs only for a document that never chose, where the
 * historical wiring rule decides.
 */
export function isActiveSinkSelector(id: string): (s: { nodes: AppNode[]; edges: AppEdge[] }) => boolean {
  return (s) => {
    for (const n of s.nodes) if (isSinkNode(n) && hasActiveFlag(n)) return n.id === id;
    return activeSink(s.nodes, unwrapCollapsedGroupEdges(s.nodes, s.edges))?.id === id;
  };
}
