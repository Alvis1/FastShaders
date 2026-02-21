import type { AppNode } from '@/types';

/** Walk upstream from a given node to check if a Time node is an ancestor. */
export function hasTimeUpstream(
  nodeId: string,
  nodes: AppNode[],
  edges: { source: string; target: string }[],
): boolean {
  const visited = new Set<string>();
  const queue = [nodeId];
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    const node = nodes.find((n) => n.id === current);
    if (node && node.data.registryType === 'time') return true;
    for (const edge of edges) {
      if (edge.target === current && !visited.has(edge.source)) {
        queue.push(edge.source);
      }
    }
  }
  return false;
}
