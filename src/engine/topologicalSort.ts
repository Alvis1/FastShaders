import type { AppNode, AppEdge } from '@/types';

export function topologicalSort(nodes: AppNode[], edges: AppEdge[]): AppNode[] {
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const n of nodes) {
    inDegree.set(n.id, 0);
    adjacency.set(n.id, []);
  }

  for (const e of edges) {
    inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1);
    adjacency.get(e.source)?.push(e.target);
  }

  const queue = nodes
    .filter((n) => inDegree.get(n.id) === 0)
    .map((n) => n.id);
  const sorted: string[] = [];

  // Head-index walk instead of Array.shift(): shift() re-indexes the whole
  // queue per pop (O(V²) worst case), and this runs on every codegen pass.
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head];
    sorted.push(id);
    for (const neighbor of adjacency.get(id) ?? []) {
      const deg = (inDegree.get(neighbor) ?? 0) - 1;
      inDegree.set(neighbor, deg);
      if (deg === 0) queue.push(neighbor);
    }
  }

  if (sorted.length < nodes.length) {
    console.warn(
      `[topologicalSort] Cycle detected: ${nodes.length - sorted.length} node(s) excluded from sort.`
    );
  }

  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  return sorted.map((id) => nodeMap.get(id)).filter((n): n is AppNode => !!n);
}
