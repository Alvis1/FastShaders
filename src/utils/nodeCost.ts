import type { AppNode, AppEdge } from '@/types';
import { getNodeValues } from '@/types';
import { NODE_REGISTRY, effectiveInputs } from '@/registry/nodeRegistry';
import complexityData from '@/registry/complexity.json';

/**
 * The authored, build-time cost table — the source of truth shipped in the
 * bundle. `ACTIVE` is what every cost reader actually consults: it's `BASE`
 * until a measured-benchmark override is applied (drag a complexity patch onto
 * the cost bar → `setCostOverrides`), then it's `BASE` with the override keys
 * layered on top. Kept module-scope (a singleton) so all consumers — the CostBar
 * BFS, node badges, the asset-browser sort — see one table without prop-drilling.
 */
const BASE_COSTS = complexityData.costs as Record<string, number>;
let overrides: Record<string, number> = {};
let ACTIVE: Record<string, number> = BASE_COSTS;

/** Sane per-node cost ceiling. Real prices are ≤ ~1000; this only exists to
 *  stop an adversarial huge value from overflowing to Infinity downstream. */
export const MAX_NODE_COST = 1_000_000;

/** Keys the override is allowed to touch — only real node types already in the
 *  authored table. A dropped file is adversarial, so unknown keys are dropped
 *  rather than trusted, and values must be finite, non-negative, and clamped. */
export function sanitizeCostMap(map: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!map || typeof map !== 'object') return out;
  for (const [k, v] of Object.entries(map as Record<string, unknown>)) {
    if (!Object.prototype.hasOwnProperty.call(BASE_COSTS, k)) continue;
    // Accept only real numbers or numeric strings — never null/boolean/object,
    // which Number() would silently coerce to 0 and inject a free cost.
    let n: number;
    if (typeof v === 'number') n = v;
    else if (typeof v === 'string' && v.trim() !== '') n = Number(v);
    else continue;
    // Upper clamp: no single node price can plausibly exceed this. Without it a
    // crafted 1e308 cost overflows to Infinity once a chainable node multiplies
    // it (base × operands), corrupting the total and any exported complexity.json.
    if (Number.isFinite(n) && n >= 0) out[k] = Math.min(n, MAX_NODE_COST);
  }
  return out;
}

/**
 * Layer a measured override over the authored table (or clear it with an empty
 * map / null). Returns the sanitized override actually applied, so the caller
 * can persist exactly what took effect.
 */
export function setCostOverrides(map: Record<string, number> | null | undefined): Record<string, number> {
  overrides = sanitizeCostMap(map);
  ACTIVE = Object.keys(overrides).length ? { ...BASE_COSTS, ...overrides } : BASE_COSTS;
  return overrides;
}

/** Cost for one node type from the ACTIVE (override-aware) table. */
export function getCost(type: string | undefined): number {
  return type ? (ACTIVE[type] ?? 0) : 0;
}

/** The full ACTIVE table (base + any override). Read-only — do not mutate. */
export function getActiveCosts(): Record<string, number> { return ACTIVE; }
/** The authored table with no override applied. */
export function getBaseCosts(): Record<string, number> { return BASE_COSTS; }
/** The currently-applied override keys (empty when none). */
export function getCostOverrides(): Record<string, number> { return overrides; }

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
  const base = ACTIVE[type] ?? 0;
  const def = NODE_REGISTRY.get(type);
  if (!def?.chainable) return base;
  const connected = edges
    .filter((e) => e.target === node.id && typeof e.targetHandle === 'string')
    .map((e) => e.targetHandle as string);
  const operands = effectiveInputs(def, connected, false, Object.keys(getNodeValues(node))).length;
  return base * Math.max(1, operands - 1);
}

/**
 * Sum the GPU cost of every node reachable (backward) from the Output node —
 * the number the CostBar shows. Reverse-BFS over an incoming-edge adjacency map
 * (O(V+E)); a collapsed group contributes its cached `data.cost` (the group node
 * has no registry cost and its members are opaque to the walk). Returns 0 when
 * there's no Output node.
 *
 * Shared by useSyncEngine (runs per graph change) and the store's device
 * selection (activating a cost profile changes the table, not the graph, so the
 * `[nodes, edges]` effect wouldn't otherwise re-fire).
 */
export function computeReachableCost(nodes: AppNode[], edges: AppEdge[]): number {
  const outputNode = nodes.find((n) => n.data.registryType === 'output');
  if (!outputNode) return 0;

  const incoming = new Map<string, string[]>();
  for (const e of edges) {
    const list = incoming.get(e.target);
    if (list) list.push(e.source);
    else incoming.set(e.target, [e.source]);
  }
  const visited = new Set<string>();
  const queue = [outputNode.id];
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
    if (!visited.has(node.id) || node.id === outputNode.id) continue;
    if (node.type === 'group' && node.data.collapsed && node.data.cost) {
      total += node.data.cost;
    } else {
      total += nodeCostPoints(node, edges);
    }
  }
  return total;
}
