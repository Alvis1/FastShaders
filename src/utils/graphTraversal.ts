import type { AppNode } from '@/types';

/** Walk upstream from a given node to check if a Time node is an ancestor. */
export function hasTimeUpstream(
  nodeId: string,
  nodes: AppNode[],
  edges: { source: string; target: string }[],
): boolean {
  const nodeMap = new Map<string, AppNode>();
  for (const n of nodes) nodeMap.set(n.id, n);

  // Adjacency built once up front — the old per-step edge scan made the BFS
  // O(V·E) on what is a per-node check during codegen.
  const sourcesByTarget = new Map<string, string[]>();
  for (const edge of edges) {
    let list = sourcesByTarget.get(edge.target);
    if (!list) { list = []; sourcesByTarget.set(edge.target, list); }
    list.push(edge.source);
  }

  const visited = new Set<string>();
  const queue = [nodeId];
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head];
    if (visited.has(current)) continue;
    visited.add(current);
    const node = nodeMap.get(current);
    if (node && node.data.registryType === 'time') return true;
    for (const source of sourcesByTarget.get(current) ?? []) {
      if (!visited.has(source)) queue.push(source);
    }
  }
  return false;
}
