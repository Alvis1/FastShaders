import type { AppNode, AppEdge } from '@/types';
import { getNodeValues } from '@/types';
import { NODE_REGISTRY, effectiveInputs } from '@/registry/nodeRegistry';
import complexityData from '@/registry/complexity.json';

const COSTS = complexityData.costs as Record<string, number>;

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
 * so the price tracks exactly what graphToCode emits.
 */
export function nodeCostPoints(node: AppNode, edges: AppEdge[]): number {
  const type = node.data.registryType;
  if (!type) return 0;
  const base = COSTS[type] ?? 0;
  const def = NODE_REGISTRY.get(type);
  if (!def?.chainable) return base;
  const connected = edges
    .filter((e) => e.target === node.id && typeof e.targetHandle === 'string')
    .map((e) => e.targetHandle as string);
  const operands = effectiveInputs(def, connected, false, Object.keys(getNodeValues(node))).length;
  return base * Math.max(1, operands - 1);
}
