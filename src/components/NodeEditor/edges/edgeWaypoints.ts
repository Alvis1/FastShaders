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

/**
 * Index of the routing point of `points` (SCREEN coords) within `radius` px of
 * `at`, nearest first, or -1. Pure, so the context menu's "was this a click ON
 * a point?" test is unit-testable without React Flow.
 */
export function waypointIndexAt(
  points: readonly { x: number; y: number }[],
  at: { x: number; y: number },
  radius: number,
): number {
  let best = -1;
  let bestD = radius;
  points.forEach((p, i) => {
    const d = Math.hypot(p.x - at.x, p.y - at.y);
    if (d <= bestD) {
      best = i;
      bestD = d;
    }
  });
  return best;
}

/** Remove routing point `index` from the LIVE edge as ONE undo entry — the one
 *  path the point's double-click and the edge menu's "Remove routing point"
 *  share. A no-op for a missing edge or an index out of range. */
export function removeEdgeWaypoint(edgeId: string, index: number): void {
  const store = useAppStore.getState();
  const edge = store.edges.find((e) => e.id === edgeId);
  const wps = (edge?.data?.waypoints ?? []) as { x: number; y: number }[];
  if (!edge || index < 0 || index >= wps.length) return;
  store.setEdgeWaypoints(edgeId, wps.filter((_, i) => i !== index), { history: true });
}
