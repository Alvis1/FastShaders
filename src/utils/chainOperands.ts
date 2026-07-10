import type { AppNode, AppEdge } from '@/types';
import { getNodeValues } from '@/types';
import { NODE_REGISTRY, MAX_CHAIN_OPERANDS, chainPortId, chainPortIndex } from '@/registry/nodeRegistry';
import { generateEdgeId } from '@/utils/idGenerator';

/**
 * Compact the operand list of grown chainable (variadic arithmetic) nodes after
 * a disconnect: slots that are neither wired nor holding a typed value are
 * removed and everything below shifts up, so the node's rows always read
 * `operand, operand, …, trailing box` with no dead gaps.
 *
 * Operand POSITION is semantic for sub/div (`sub(0, b, c) ≠ sub(b, c)`), so
 * this rewrites the actual edges (targetHandle + id) and remaps stored values —
 * a render-only compaction would show one expression and emit another.
 *
 * Rules:
 * - Only applies to nodes grown past the two base ports (highest wired/valued
 *   operand index ≥ 2). A plain 2-op node keeps classic behavior: disconnecting
 *   one input never makes the other jump sockets.
 * - Members of a collapsed group are skipped: collapse rewires boundary edges to
 *   synthetic group sockets, so a member can legitimately have gap operands that
 *   the expand mapping (originalHandleId) will restore — compacting them would
 *   corrupt that mapping.
 * - Idempotent, and returns the SAME array references when nothing changed, so
 *   callers can set state unconditionally without churning renders/sync.
 */
export function normalizeChainOperands(
  nodes: AppNode[],
  edges: AppEdge[],
): { nodes: AppNode[]; edges: AppEdge[]; changed: boolean } {
  // Nodes hidden inside a collapsed group (any collapsed ancestor).
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const inCollapsedGroup = (n: AppNode): boolean => {
    let cur: AppNode | undefined = n;
    for (let hops = 0; cur?.parentId && hops < 100; hops++) {
      cur = byId.get(cur.parentId);
      if (cur?.type === 'group' && (cur.data as { collapsed?: boolean }).collapsed) return true;
    }
    return false;
  };

  let edgesOut = edges;
  let nodesOut = nodes;
  let changed = false;

  for (const node of nodes) {
    const def = NODE_REGISTRY.get(node.data.registryType);
    if (!def?.chainable || inCollapsedGroup(node)) continue;

    const values = getNodeValues(node);
    const operandEdges = new Map<number, AppEdge>();
    for (const e of edgesOut) {
      if (e.target !== node.id || typeof e.targetHandle !== 'string') continue;
      const i = chainPortIndex(e.targetHandle);
      if (i >= 0 && i < MAX_CHAIN_OPERANDS) operandEdges.set(i, e);
    }
    const valuedIdx = new Set<number>();
    for (const k of Object.keys(values)) {
      const i = chainPortIndex(k);
      if (i >= 0 && i < MAX_CHAIN_OPERANDS) valuedIdx.add(i);
    }

    const highest = Math.max(
      ...[...operandEdges.keys()], ...[...valuedIdx], -1,
    );
    // Not grown past the base ports — classic 2-op node, leave untouched.
    if (highest < def.inputs.length) continue;

    // Kept slots in order: wired, or carrying a typed value.
    const kept: number[] = [];
    for (let i = 0; i <= highest; i++) {
      if (operandEdges.has(i) || valuedIdx.has(i)) kept.push(i);
    }
    // Already consecutive from 0 → nothing to compact.
    if (kept.every((src, j) => src === j)) continue;

    // Remap edges and values of the shifted slots.
    const edgeRemap = new Map<string, string>(); // old edge id → new handle
    const newValues: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(values)) {
      if (chainPortIndex(k) < 0) newValues[k] = v; // non-operand keys unchanged
    }
    kept.forEach((src, j) => {
      const dst = chainPortId(j);
      const e = operandEdges.get(src);
      if (e) edgeRemap.set(e.id, dst);
      const vk = chainPortId(src);
      if (vk in values) newValues[dst] = values[vk];
    });

    if (edgeRemap.size > 0) {
      edgesOut = edgesOut.map((e) => {
        const dst = edgeRemap.get(e.id);
        if (!dst || dst === e.targetHandle) return e;
        return {
          ...e,
          targetHandle: dst,
          id: generateEdgeId(e.source, e.sourceHandle ?? 'out', e.target, dst),
        };
      });
    }
    nodesOut = nodesOut.map((n) =>
      n.id === node.id ? ({ ...n, data: { ...n.data, values: newValues } } as AppNode) : n,
    );
    changed = true;
  }

  return { nodes: nodesOut, edges: edgesOut, changed };
}
