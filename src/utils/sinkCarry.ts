import type { AppEdge, AppNode } from '@/types';
import { isSinkNode, isUntargetedOutput, isCustomSink } from '@/utils/sdfPartition';

/**
 * The resync's carry of PARKED sinks: a node that emits nothing is absent from
 * the code by construction, so it comes back here, with its incoming edges.
 * A TARGETED plain Output is carried only when the parse holds no plain Output
 * (`parseHasPlainOutput`); otherwise the parse rebuilds it and a carry would
 * duplicate it on every Apply. The caller runs this only when nothing is
 * unpositioned. `realOldEdges` must be UNWRAPPED; an edge whose source is not
 * in `survivingIds` is dropped.
 * See docs/dev/outputs-and-materials.md § Several output nodes.
 */
export function carryInactiveSinks(
  oldNodes: readonly AppNode[],
  realOldEdges: readonly AppEdge[],
  activeOldId: string | null,
  survivingIds: ReadonlySet<string>,
  parseHasPlainOutput: boolean,
): { nodes: AppNode[]; edges: AppEdge[] } {
  const nodes = oldNodes.filter(
    (n) => isSinkNode(n)
      && (isCustomSink(n) || isUntargetedOutput(n) || !parseHasPlainOutput)
      && n.id !== activeOldId
      && !survivingIds.has(n.id),
  );
  if (nodes.length === 0) return { nodes: [], edges: [] };
  const ids = new Set(nodes.map((n) => n.id));
  const edges = realOldEdges.filter((e) => ids.has(e.target) && survivingIds.has(e.source));
  return { nodes, edges };
}
