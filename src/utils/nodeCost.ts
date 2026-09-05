import type { AppNode, AppEdge } from '@/types';
import { getNodeValues } from '@/types';
import { NODE_REGISTRY, effectiveInputs } from '@/registry/nodeRegistry';
import { getCost } from '@/utils/costTable';
import { activeSink, isSinkNode, isMarchOutput, marchPartition } from '@/utils/sdfPartition';

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
 * The ACTIVE sink seeds the walk (`activeSink` — the flagged Output or
 * Raymarch Output, else the historical fallback): the total is the price of
 * what the shader actually RENDERS, and an inactive output's chain emits
 * nothing, so pricing it would put points on the meter that no headset ever
 * pays. `sinkCosts` prices every sink on its own for the badges, so two
 * alternative outputs can be compared before one is activated.
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
export function computeReachableCost(nodes: AppNode[], edges: AppEdge[], seed?: AppNode | null): number {
  const sink = seed === undefined ? activeSink(nodes, edges) : seed;
  if (!sink) return 0;
  const sinkIds = new Set(nodes.filter(isSinkNode).map((n) => n.id));
  let total = sumReachable(nodes, edges, [sink.id], sinkIds);
  // The Raymarch Output evaluates its per-step bodies once per ray STEP (the
  // Field also four more times for the gradient normal) and pays its own fixed
  // march overhead. Each body was counted once above; add the remaining
  // evaluations, using the SAME partition the emitter uses
  // (utils/sdfPartition.ts). The hit-shaded and direction scopes run once.
  if (isMarchOutput(sink)) {
    const march = sink;
    const raw = Number(getNodeValues(march).steps);
    const dflt = Number(NODE_REGISTRY.get(march.data.registryType)?.defaultValues?.steps ?? 64);
    const steps = Number.isFinite(raw) ? raw : dflt;
    const part = marchPartition(nodes, edges, march.id);
    // Occlusion taps the Field 5 more times at the hit, a soft shadow marches
    // it up to 24 more — both only when switched on (non-zero or wired).
    const on = (key: string): boolean => {
      const v = Number(getNodeValues(march)[key]);
      return (Number.isFinite(v) && v !== 0) || edges.some((e) => e.target === march.id && e.targetHandle === key);
    };
    const fieldExtra = steps + 4 - 1 + (on('ao') ? 5 : 0) + (on('shadow') ? 24 : 0);
    const extraEvals: Record<string, number> = { field: fieldExtra, density: steps - 1, glow: steps - 1 };
    for (const [handle, extra] of Object.entries(extraEvals)) {
      const set = part.scopes.get(handle);
      if (!set) continue;
      let body = 0;
      for (const n of nodes) if (set.has(n.id)) body += nodeCostPoints(n, edges);
      total += body * Math.max(0, extra);
    }
    total += getCost(march.data.registryType);
  }
  return total;
}

/**
 * Every sink's OWN price — what the shader would cost with THAT node active.
 * The active sink's entry equals `computeReachableCost(nodes, edges)`; the
 * badges on inactive outputs show theirs muted, so two candidate outputs can
 * be compared before clicking one. Keyed by node id.
 */
export function sinkCosts(nodes: AppNode[], edges: AppEdge[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const n of nodes) if (isSinkNode(n)) out.set(n.id, computeReachableCost(nodes, edges, n));
  return out;
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
