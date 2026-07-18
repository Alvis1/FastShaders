import type { AppNode } from '@/types';
import { getNodeValues } from '@/types';
import { NODE_REGISTRY, getFlowNodeType } from '@/registry/nodeRegistry';
import complexityData from '@/registry/complexity.json';

const COSTS = complexityData.costs as Record<string, number>;

/**
 * Constant ↔ uniform conversion pairs (Node Settings menu → "Convert to …").
 * float and color each convert IN PLACE to their named-uniform counterpart —
 * same node id, same position, same outgoing edges (all four defs share the
 * single `out` output handle, so edges stay valid).
 */
const TO_UNIFORM: Record<string, string> = {
  float: 'property_float',
  color: 'property_color',
};
const TO_CONSTANT: Record<string, string> = {
  property_float: 'float',
  property_color: 'color',
};

export function uniformTypeFor(registryType: string): string | null {
  return TO_UNIFORM[registryType] ?? null;
}

export function constantTypeFor(registryType: string): string | null {
  return TO_CONSTANT[registryType] ?? null;
}

/**
 * First free auto-name for a converted uniform: `property1/2/…` for floats,
 * `color1/2/…` for colours — max existing suffix + 1, scanned across EVERY
 * node carrying a name so two property kinds can't mint the same identifier
 * (property names share one variable namespace in the generated code).
 */
export function nextPropertyName(prefix: string, nodes: AppNode[]): string {
  let maxNum = 0;
  for (const n of nodes) {
    const name = String(getNodeValues(n)?.name ?? '');
    const m = name.match(new RegExp(`^${prefix}(\\d+)$`));
    if (m) maxNum = Math.max(maxNum, Number(m[1]));
  }
  return `${prefix}${maxNum + 1}`;
}

/**
 * Rebuild `node` as `targetType`, carrying the payload value across:
 * float.value ↔ property_float.value, color.hex ↔ property_color.hex.
 * Uniform targets gain an auto-generated `name`; constant targets drop it.
 * Returns null when the target def doesn't exist (never in practice).
 *
 * The flow `type` is re-derived via getFlowNodeType — a Color node renders as
 * the swatch ColorNode ('color') while Property (color) is a standard square
 * card ('shader'), so conversion changes the React Flow node type too.
 */
export function convertPropertyNode(
  node: AppNode,
  targetType: string,
  allNodes: AppNode[],
): AppNode | null {
  const def = NODE_REGISTRY.get(targetType);
  if (!def) return null;
  const old = getNodeValues(node);
  const values: Record<string, string | number> = {};
  if (targetType === 'property_float' || targetType === 'float') {
    values.value = Number(old.value ?? def.defaultValues?.value ?? 0);
  } else {
    values.hex = String(old.hex ?? def.defaultValues?.hex ?? '#ff0000');
  }
  if (targetType.startsWith('property_')) {
    values.name = nextPropertyName(targetType === 'property_color' ? 'color' : 'property', allNodes);
  }
  return {
    ...node,
    type: getFlowNodeType(def),
    data: {
      ...node.data,
      registryType: targetType,
      label: def.label,
      cost: COSTS[targetType] ?? 0,
      values,
    },
  } as AppNode;
}
