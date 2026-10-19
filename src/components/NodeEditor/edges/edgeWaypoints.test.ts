import { beforeEach, describe, expect, it } from 'vitest';
import { useAppStore } from '@/store/useAppStore';
import { HISTORY_IDLE, makeEdge } from '@/test-utils';
import { removeEdgeWaypoint, waypointIndexAt } from './edgeWaypoints';

describe('waypointIndexAt', () => {
  const pts = [
    { x: 0, y: 0 },
    { x: 20, y: 0 },
  ];
  it('finds the point under the pointer', () => {
    expect(waypointIndexAt(pts, { x: 19, y: 2 }, 9)).toBe(1);
  });
  it('is -1 off every point, and for no points', () => {
    expect(waypointIndexAt(pts, { x: 10, y: 30 }, 9)).toBe(-1);
    expect(waypointIndexAt([], { x: 0, y: 0 }, 9)).toBe(-1);
  });
  it('takes the nearer of two overlapping points', () => {
    expect(waypointIndexAt(pts, { x: 12, y: 0 }, 20)).toBe(1);
  });
});

describe('removeEdgeWaypoint', () => {
  const edge = { ...makeEdge('a', 'out', 'b', 'in'), data: { dataType: 'float' as const, waypoints: [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }] } };
  beforeEach(() => {
    useAppStore.setState({ edges: [edge], past: [], future: [], ...HISTORY_IDLE });
  });

  it('drops exactly that point as one undo entry', () => {
    removeEdgeWaypoint(edge.id, 1);
    const got = useAppStore.getState();
    expect(got.edges[0].data?.waypoints).toEqual([{ x: 1, y: 1 }, { x: 3, y: 3 }]);
    expect(got.past.length).toBe(1);
  });

  it('is a no-op for an index out of range or a missing edge', () => {
    removeEdgeWaypoint(edge.id, 3);
    removeEdgeWaypoint(edge.id, -1);
    removeEdgeWaypoint('nope', 0);
    const got = useAppStore.getState();
    expect(got.edges[0].data?.waypoints).toHaveLength(3);
    expect(got.past.length).toBe(0);
  });
});
