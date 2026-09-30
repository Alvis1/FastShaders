import type { InternalNode } from '@xyflow/react';
import { useAppStore } from '@/store/useAppStore';
import { insertWaypointOrdered } from './bezierGeometry';

const center = (n: InternalNode) => ({
  x: n.internals.positionAbsolute.x + (n.measured?.width ?? 120) / 2,
  y: n.internals.positionAbsolute.y + (n.measured?.height ?? 40) / 2,
});

/**
 * Add a routing waypoint to the LIVE edge at flow point `p`, ordered along the
 * wire (node centres stand in for its endpoints), as ONE undo entry. A no-op
 * when the edge or either of its nodes is gone.
 */
export function addEdgeWaypoint(
  edgeId: string,
  p: { x: number; y: number },
  getInternalNode: (id: string) => InternalNode | undefined,
): void {
  const store = useAppStore.getState();
  const edge = store.edges.find((e) => e.id === edgeId);
  const src = edge && getInternalNode(edge.source);
  const tgt = edge && getInternalNode(edge.target);
  if (!edge || !src || !tgt) return;
  const wps = (edge.data?.waypoints ?? []) as { x: number; y: number }[];
  store.setEdgeWaypoints(edgeId, insertWaypointOrdered(center(src), center(tgt), wps, p), { history: true });
}
