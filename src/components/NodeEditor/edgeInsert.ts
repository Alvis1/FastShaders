/**
 * Putting a node ONTO an existing edge — the store-touching half of the splice
 * that three surfaces now share: dropping a node or a palette tile near a wire,
 * and the edge menu's **Insert node**, which opens the search list and splices
 * whatever is chosen.
 *
 * The pure half — WHICH input port a spliced node lands on — stays in
 * `edgeSplice.ts`. This module is what needs the store, so it lives beside the
 * canvas rather than under `utils/`, and it deliberately imports nothing from
 * `NodeEditor.tsx`: that file imports the context menus, which import this, and
 * a cycle back would be a cycle evaluated during module init.
 */
import { useAppStore } from '@/store/useAppStore';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { effectiveExposedPorts, usesExposedPorts } from '@/utils/exposedPorts';
import { makeTypedEdge } from '@/utils/edgeUtils';
import { pickSpliceInputPort } from './edgeSplice';
import type { AppNode, AppEdge, NodeDefinition } from '@/types';
import { getNodeValues } from '@/types';

/**
 * Landing a connection on a drag-revealed (still hidden) parameter socket
 * makes the exposure permanent — otherwise the temporary handle unmounts when
 * the drag ends and the fresh edge points at nothing. Runs under the caller's
 * pushHistory (connect AND reconnect gestures), so the edge + exposure revert
 * as one undo step.
 */
export function exposeConnectedTarget(
  targetId: string,
  targetHandle: string | null | undefined,
): void {
  if (!targetHandle) return;
  const nodes = useAppStore.getState().nodes;
  const tgt = nodes.find((n) => n.id === targetId);
  if (!tgt || !usesExposedPorts(NODE_REGISTRY.get(tgt.data.registryType))) return;
  // The Output node's default-exposed channels are implicit (undefined
  // exposedPorts) — union from the EFFECTIVE list so exposing one new channel
  // can't hide the defaults.
  const current = effectiveExposedPorts(tgt);
  if (current.includes(targetHandle)) return;
  useAppStore.getState().setNodes(
    nodes.map((n) =>
      n.id === tgt.id
        ? { ...n, data: { ...n.data, exposedPorts: [...current, targetHandle] } }
        : n,
    ) as AppNode[],
  );
}

/**
 * Splice `nodeId` into the edge `edgeId`: source → node → original target, with
 * the original edge removed. Returns false and changes NOTHING when the node
 * cannot carry a signal through.
 *
 * Pushes no history of its own — every caller runs inside a bracket that
 * already snapshotted the pre-add state, so the add and the two wires are one
 * undo step (the rule the palette-tile and Add-menu paths both state).
 *
 * A def with NO OUTPUTS is refused rather than crashed on. Both sinks — the
 * Output and the Raymarch Output — declare `outputs: []`, so reading
 * `def.outputs[0].id` throws a TypeError on the one node type a user is most
 * likely to reach for while pointing at a wire. The drag paths happen to guard
 * this at their call site; putting it here means a new caller cannot forget.
 */
export function spliceNodeIntoEdge(
  nodeId: string,
  def: NodeDefinition,
  edgeId: string,
): boolean {
  const outputPort = def.outputs[0];
  if (!outputPort) return false;

  const store = useAppStore.getState();
  const edge = store.edges.find((e) => e.id === edgeId);
  if (!edge) return false;

  // Land on the node's first FREE input, not always its first (edgeSplice.ts):
  // splicing an already-wired node keeps what it has. Variadic folds grow a
  // fresh socket for this; a node with every socket taken falls back to the
  // first port, whose stale edge the filter below then replaces.
  const node = store.nodes.find((n) => n.id === nodeId);
  const connected = store.edges.flatMap((e) =>
    e.target === nodeId && e.targetHandle ? [e.targetHandle] : [],
  );
  const inputPortId = pickSpliceInputPort(
    def,
    connected,
    node ? Object.keys(getNodeValues(node)) : [],
  );
  if (!inputPortId) return false;

  const newEdge1 = makeTypedEdge(edge.source, edge.sourceHandle, nodeId, inputPortId);
  const newEdge2 = makeTypedEdge(nodeId, outputPort.id, edge.target, edge.targetHandle);

  store.setEdges(
    store.edges
      .filter((e) => e.id !== edge.id)
      // Inputs are single-connection. Only reachable once EVERY socket is taken
      // (pickSpliceInputPort's fallback) — drop that port's stale edge so it
      // can't end up double-fed.
      .filter((e) => !(e.target === nodeId && e.targetHandle === inputPortId))
      .concat(newEdge1, newEdge2) as AppEdge[],
  );
  // The chosen port may be a hidden param socket (Image/Sound): make the
  // exposure permanent, or the fresh edge points at a handle that never mounts.
  // Same rule — and the same helper — as a wire dropped on a revealed socket.
  exposeConnectedTarget(nodeId, inputPortId);
  return true;
}
