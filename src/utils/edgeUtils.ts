import { useAppStore } from '@/store/useAppStore';

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
