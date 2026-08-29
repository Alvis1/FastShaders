import type { AppNode, AppEdge } from '@/types';
import { outputNodes } from '@/utils/outputMaterials';
import { getNodeValues } from '@/types';
import { NODE_REGISTRY, effectiveInputs } from '@/registry/nodeRegistry';
import { getCost } from '@/utils/costTable';

/**
 * GPU cost READERS that need the node graph — the per-instance price and the
 * reachable-subtree total.
 *
 * The TABLE itself (the authored prices, the measured override, the sanitizer)
 * lives in `costTable.ts`, deliberately: this module sits in an import cycle
 * (outputMaterials -> exposedPorts -> edgeUtils -> useAppStore -> back here),
 * and the store calls the table's functions during its own module
 * initialisation. Read costTable.ts's header before moving anything back —
 * that split is what stopped the test suite failing at random.
 *
 * Re-exported here so every existing consumer keeps one import site for
 * "costs", and because `getCost`/`getBaseCosts` read naturally beside
 * `nodeCostPoints`.
 */
export {
  MAX_NODE_COST,
  sanitizeCostMap,
  setCostOverrides,
  getCost,
  getBaseCosts,
} from '@/utils/costTable';

/**
 * GPU cost points for a node instance.
 *
 * A `chainable` (variadic) arithmetic node scales with its operand count: an
 * N-operand op performs N−1 operations, so its cost is `base × (N−1)`. A plain
 * 2-operand node is therefore unchanged (base × 1). Every other node type is the
 * flat registry cost.
 *
 * Operand count is the *semantic* count (`effectiveInputs(..., false)`) — wired
 * operands plus any interior identity gaps, excluding the empty grow socket —
 * so the price tracks exactly what graphToCode emits. Reads the ACTIVE table so
 * a measured override reprices every node without touching stored snapshots.
 */
export function nodeCostPoints(node: AppNode, edges: AppEdge[]): number {
  const type = node.data.registryType;
  if (!type) return 0;
  const base = getCost(type);
  const def = NODE_REGISTRY.get(type);
  if (!def?.chainable) return base;
  const connected = edges
    .filter((e) => e.target === node.id && typeof e.targetHandle === 'string')
    .map((e) => e.targetHandle as string);
  const operands = effectiveInputs(def, connected, false, Object.keys(getNodeValues(node))).length;
  return base * Math.max(1, operands - 1);
}

/**
 * Sum the GPU cost of every node reachable (backward) from an Output node —
 * the number the CostBar shows. Reverse-BFS over an incoming-edge adjacency map
 * (O(V+E)). Callers MUST hand in edges already run through
 * `unwrapCollapsedGroupEdges` — collapsing a group must never change the
 * budget, so the walk reaches the real members either way. The group container
 * itself has no `registryType`, so `nodeCostPoints` prices it at 0 and only the
 * members are counted. Returns 0 when there's no Output node.
 *
 * EVERY Output seeds the walk. Per-mesh materials live inside the one Output
 * now, so its chains — the default's and every added material's — are all
 * reachable from that single seed; the multi-seed form stays as the defensive
 * case for a graph that reaches here before `foldExtraOutputs` has run.
 *
 * A node feeding two materials is counted ONCE (the `visited` set), so the
 * total is a lower bound on true multi-pipeline cost: the GPU compiles the
 * shared node into every material that uses it. Real per-part pricing needs a
 * ShaderCarousel calibration entry and is still to come.
 *
 * Shared by useSyncEngine (runs per graph change) and the store's device
 * selection (activating a cost profile changes the table, not the graph, so the
 * `[nodes, edges]` effect wouldn't otherwise re-fire).
 */
export function computeReachableCost(nodes: AppNode[], edges: AppEdge[]): number {
  const outputs = outputNodes(nodes);
  if (outputs.length === 0) return 0;
  return sumReachable(nodes, edges, outputs.map((n) => n.id), new Set(outputs.map((n) => n.id)));
}

/** Reverse-BFS from `seeds`, summing everything reached except the Outputs. */
function sumReachable(
  nodes: AppNode[],
  edges: AppEdge[],
  seeds: string[],
  outputIds: Set<string>,
): number {
  const incoming = new Map<string, string[]>();
  for (const e of edges) {
    const list = incoming.get(e.target);
    if (list) list.push(e.source);
    else incoming.set(e.target, [e.source]);
  }
  const visited = new Set<string>();
  const queue = [...seeds];
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head];
    if (visited.has(id)) continue;
    visited.add(id);
    const sources = incoming.get(id);
    if (sources) {
      for (const src of sources) if (!visited.has(src)) queue.push(src);
    }
  }

  let total = 0;
  for (const node of nodes) {
    // Every Output is excluded, not just the seeds: an Output is a sink, not a
    // priced operation, and with per-mesh materials there are several.
    if (!visited.has(node.id) || outputIds.has(node.id)) continue;
    // No collapsed-group branch: `data.cost` was a snapshot taken at collapse
    // time over ALL members with no reachability filter, so collapsing a group
    // that held a dead-end branch inflated the budget, a group saved before the
    // field existed reported 0, and a library group carried a price from
    // whatever cost table was active when it was saved. Group containers price
    // at 0 here (no registryType) and their members are walked normally.
    total += nodeCostPoints(node, edges);
  }
  return total;
}
