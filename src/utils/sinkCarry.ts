import type { AppEdge, AppNode } from '@/types';
import { isSinkNode } from '@/utils/sdfPartition';

/**
 * The code→graph resync's carry of INACTIVE OUTPUT NODES (utils/sdfPartition.ts
 * `activeSink`): only the active sink is emitted, so an inactive Output or
 * Raymarch Output is absent from the code BY CONSTRUCTION — never deleted by
 * the user, since it was never in the text — and the parse cannot rebuild it.
 * The same argument as the orphaned-property carry in useSyncEngine, plus one
 * step that carry never needs: the node's incoming edges come back with it.
 *
 * Pure so apply∘apply stability is an executable test rather than a source
 * pin. `survivingIds` are the ids in the resync's final node list — a matched
 * feeder keeps its OLD id, so a carried edge can name it verbatim; an edge
 * whose source did not survive (deleted from the code) is dropped, mirroring
 * the group block's dangling-parentId rule. `realOldEdges` must be the
 * UNWRAPPED old edges (a feeder inside a collapsed group).
 */
export function carryInactiveSinks(
  oldNodes: readonly AppNode[],
  realOldEdges: readonly AppEdge[],
  activeOldId: string | null,
  survivingIds: ReadonlySet<string>,
): { nodes: AppNode[]; edges: AppEdge[] } {
  const nodes = oldNodes.filter((n) => isSinkNode(n) && n.id !== activeOldId && !survivingIds.has(n.id));
  if (nodes.length === 0) return { nodes: [], edges: [] };
  const ids = new Set(nodes.map((n) => n.id));
  const edges = realOldEdges.filter((e) => ids.has(e.target) && survivingIds.has(e.source));
  return { nodes, edges };
}
