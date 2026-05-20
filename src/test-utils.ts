import type { AppNode, AppEdge } from '@/types';

/**
 * Build a minimal AppNode for tests. Only the parts the engine reads (`id`,
 * `type`, `data.registryType`, `data.values`) are populated; we cast through
 * `unknown` to skip React Flow's full Node generic constraints. `type` mirrors
 * the production convention — `'output'` for the output node, `'shader'`
 * otherwise — so graphToCode's output-detection branch works in tests.
 */
export function makeNode(
  id: string,
  registryType: string,
  values: Record<string, string | number> = {},
): AppNode {
  return {
    id,
    type: registryType === 'output' ? 'output' : 'shader',
    position: { x: 0, y: 0 },
    data: { registryType, label: id, cost: 0, values },
  } as unknown as AppNode;
}

/**
 * Build a minimal AppEdge for tests. Matches the shape `TypedEdge` expects:
 * deterministic id, typed edge, `dataType: 'any'` payload.
 */
export function makeEdge(
  source: string,
  sourceHandle: string,
  target: string,
  targetHandle: string,
): AppEdge {
  return {
    id: `e-${source}-${sourceHandle}-${target}-${targetHandle}`,
    source,
    sourceHandle,
    target,
    targetHandle,
    type: 'typed',
    data: { dataType: 'any' },
  } as unknown as AppEdge;
}
