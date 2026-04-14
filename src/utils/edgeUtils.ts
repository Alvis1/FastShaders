import { useAppStore } from '@/store/useAppStore';
import type { AppEdge, AppNode, GroupNodeData } from '@/types';

/**
 * Remove all edges connected to a specific input port on a node.
 * Call this when hiding/unchecking an input port so dangling edges don't remain.
 */
export function removeEdgesForPort(nodeId: string, portId: string): void {
  const { edges, setEdges, pushHistory } = useAppStore.getState();
  const toRemove = edges.filter(
    (e) => e.target === nodeId && e.targetHandle === portId
  );
  if (toRemove.length > 0) {
    pushHistory();
    setEdges(edges.filter((e) => !(e.target === nodeId && e.targetHandle === portId)));
  }
}

/**
 * Translate boundary edges that touch a collapsed group's synthetic sockets
 * back to their original child endpoints, so compilation/evaluation engines
 * see the *logical* topology rather than the visual one.
 *
 * `toggleGroupCollapsed` rewrites every crossing edge at collapse time so the
 * wire visually lands on the group pill — the original child node + handle is
 * stashed in `groupData.collapsedInputs/Outputs[*].originalNodeId/HandleId`.
 * Without unwrapping, `graphToCode` and `cpuEvaluator` would try to look up a
 * var name on the group node (which has no registry entry) and silently fall
 * back to `0`, which is what made the iframe shader go black/gray as soon as
 * any boundary node fed into the output channels.
 *
 * Returns a new edge array with rewritten endpoints; non-boundary edges are
 * passed through unchanged.
 */
export function unwrapCollapsedGroupEdges(nodes: AppNode[], edges: AppEdge[]): AppEdge[] {
  // Build socketId → original endpoint maps, keyed per group so two collapsed
  // groups can't accidentally collide on the same synthetic socket id.
  const outMap = new Map<string, { nodeId: string; handleId: string }>();
  const inMap = new Map<string, { nodeId: string; handleId: string }>();
  let anyCollapsed = false;
  for (const n of nodes) {
    if (n.type !== 'group') continue;
    const data = n.data as GroupNodeData;
    if (!data.collapsed) continue;
    anyCollapsed = true;
    for (const s of data.collapsedOutputs ?? []) {
      outMap.set(`${n.id}\0${s.socketId}`, { nodeId: s.originalNodeId, handleId: s.originalHandleId });
    }
    for (const s of data.collapsedInputs ?? []) {
      inMap.set(`${n.id}\0${s.socketId}`, { nodeId: s.originalNodeId, handleId: s.originalHandleId });
    }
  }
  if (!anyCollapsed) return edges;

  // Track which group IDs are currently collapsed so we can drop edges that
  // still land on a synthetic socket we couldn't translate — happens with
  // legacy persisted groups where `collapsedInputs/Outputs` were never
  // populated. Without this filter graphToCode / cpuEvaluator would look up
  // a var name on the group container (not in `sorted`) and silently emit 0.
  const liveNodeIds = new Set(nodes.map((n) => n.id));
  const collapsedGroupIds = new Set<string>();
  for (const n of nodes) {
    if (n.type === 'group' && (n.data as GroupNodeData).collapsed) {
      collapsedGroupIds.add(n.id);
    }
  }

  const rewritten = edges.map((e) => {
    let { source, sourceHandle, target, targetHandle } = e;
    const outKey = `${source}\0${sourceHandle ?? ''}`;
    const outOrig = outMap.get(outKey);
    if (outOrig) {
      source = outOrig.nodeId;
      sourceHandle = outOrig.handleId;
    }
    const inKey = `${target}\0${targetHandle ?? ''}`;
    const inOrig = inMap.get(inKey);
    if (inOrig) {
      target = inOrig.nodeId;
      targetHandle = inOrig.handleId;
    }
    if (source === e.source && target === e.target && sourceHandle === e.sourceHandle && targetHandle === e.targetHandle) {
      return e;
    }
    return { ...e, source, sourceHandle, target, targetHandle };
  });

  return rewritten.filter((e) => {
    if (!liveNodeIds.has(e.source) || !liveNodeIds.has(e.target)) return false;
    // Drop edges that still point at a collapsed group's synthetic socket —
    // we couldn't translate them, so they'd otherwise be compiled as 0.
    if (collapsedGroupIds.has(e.source)) return false;
    if (collapsedGroupIds.has(e.target)) return false;
    return true;
  });
}
