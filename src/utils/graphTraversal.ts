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

/**
 * The set of every node a Time node feeds — the whole-graph answer that
 * `hasTimeUpstream` gives one node at a time.
 *
 * Same predicate, inverted direction. `hasTimeUpstream(id, …)` walks BACKWARD
 * from `id` hunting a Time ancestor, so it must rebuild a node map AND an
 * adjacency map on EVERY call; both are thrown away immediately, and at 150+
 * nodes that allocation is 97-99% of the call. Its callers are render-layer
 * zustand selectors that ask once per connected edge, per node card, per store
 * NOTIFY — and React Flow notifies at pointer (i.e. refresh) rate through a
 * drag — which made the per-frame cost O(E·(N+E)). Measured at 85-93% of all
 * per-notify selector work on a 150n/220e graph. ONE forward BFS from every
 * Time node answers every caller, and `getTimeUpstreamSet` (cpuEvaluator)
 * memoizes it on the shared per-graph ctx, so a drag pays for it once per
 * graph VERSION instead of once per edge per frame.
 *
 * `set.has(id)` is exactly `hasTimeUpstream(id, nodes, edges)`: the seeds are
 * the Time nodes themselves — so a Time node still reports true for itself —
 * and the walk adds everything reachable downstream of one. A graph with no
 * Time node in it returns early WITHOUT building the adjacency map, which the
 * backward walk could never do: it only short-circuits when it FINDS Time, so
 * a Time-free graph was its worst case (it walked each node's whole ancestor
 * closure) rather than its cheapest.
 *
 * Hand it the UNWRAPPED edges, never the raw store array — see
 * `getUnwrappedEdges`' contract in cpuEvaluator. Callers should prefer
 * `getTimeUpstreamSet`, which unwraps by construction.
 */
export function buildTimeUpstreamSet(
  nodes: AppNode[],
  edges: { source: string; target: string }[],
): Set<string> {
  const reached = new Set<string>();
  const queue: string[] = [];
  for (const n of nodes) {
    if (n.data.registryType === 'time') {
      reached.add(n.id);
      queue.push(n.id);
    }
  }
  if (queue.length === 0) return reached;

  const targetsBySource = new Map<string, string[]>();
  for (const edge of edges) {
    let list = targetsBySource.get(edge.source);
    if (!list) { list = []; targetsBySource.set(edge.source, list); }
    list.push(edge.target);
  }

  // `reached` doubles as the visited set, so a cyclic graph terminates — the
  // same guarantee the backward walk's `visited` gives. (topologicalSort only
  // WARNS on cycles, so a hand-edited .fastshader can reach here with one.)
  for (let head = 0; head < queue.length; head++) {
    for (const target of targetsBySource.get(queue[head]) ?? []) {
      if (!reached.has(target)) {
        reached.add(target);
        queue.push(target);
      }
    }
  }
  return reached;
}
