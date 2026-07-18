import { describe, it, expect, beforeEach } from 'vitest';
import { useAppStore } from '@/store/useAppStore';
import { makeNode, makeEdge } from '@/test-utils';
import type { AppNode } from '@/types';

/**
 * `organizeSelection` re-runs the top-aligned auto-layout on just the selected
 * subgraph (right-click a selection → Organize), anchored at the selection's
 * old top-left corner. Unselected nodes must never move.
 */

function sel(node: AppNode, x: number, y: number, parentId?: string): AppNode {
  return { ...node, selected: true, position: { x, y }, ...(parentId ? { parentId } : {}) } as AppNode;
}

function pos(id: string): { x: number; y: number } {
  const n = useAppStore.getState().nodes.find((x) => x.id === id);
  if (!n) throw new Error(`no node ${id}`);
  return n.position;
}

describe('organizeSelection', () => {
  beforeEach(() => {
    useAppStore.setState({
      nodes: [],
      edges: [],
      past: [],
      future: [],
      isUndoRedo: false,
      coalescingHistory: false,
    });
  });

  it('re-lays a selected chain onto one top baseline, anchored at the old top-left', () => {
    // A chain scattered diagonally; organize should flatten it.
    useAppStore.setState({
      nodes: [
        sel(makeNode('a', 'mul'), 100, 300),
        sel(makeNode('b', 'mul'), 250, 420),
        sel(makeNode('c', 'mul'), 400, 560),
      ],
      edges: [makeEdge('a', 'out', 'b', 'a'), makeEdge('b', 'out', 'c', 'a')],
    });
    useAppStore.getState().organizeSelection();
    const [pa, pb, pc] = [pos('a'), pos('b'), pos('c')];
    // Flat top baseline along the chain…
    expect(pb.y).toBeCloseTo(pa.y, 5);
    expect(pc.y).toBeCloseTo(pa.y, 5);
    // …flowing left-to-right…
    expect(pa.x).toBeLessThan(pb.x);
    expect(pb.x).toBeLessThan(pc.x);
    // …anchored at the selection's old top-left corner (min x 100, min y 300).
    expect(Math.min(pa.x, pb.x, pc.x)).toBeCloseTo(100, 5);
    expect(Math.min(pa.y, pb.y, pc.y)).toBeCloseTo(300, 5);
  });

  it('never moves unselected nodes', () => {
    useAppStore.setState({
      nodes: [
        sel(makeNode('a', 'mul'), 0, 0),
        sel(makeNode('b', 'mul'), 50, 200),
        { ...makeNode('idle', 'mul'), position: { x: 900, y: 900 } } as AppNode,
      ],
      edges: [makeEdge('a', 'out', 'b', 'a')],
    });
    useAppStore.getState().organizeSelection();
    expect(pos('idle')).toEqual({ x: 900, y: 900 });
  });

  it('is a no-op for fewer than two selected nodes', () => {
    useAppStore.setState({
      nodes: [sel(makeNode('a', 'mul'), 10, 20), { ...makeNode('b', 'mul'), position: { x: 5, y: 5 } } as AppNode],
      edges: [],
    });
    useAppStore.getState().organizeSelection();
    expect(pos('a')).toEqual({ x: 10, y: 20 });
    expect(useAppStore.getState().past).toHaveLength(0);
  });

  it('pushes exactly one history entry, undoable in one step', () => {
    useAppStore.setState({
      nodes: [sel(makeNode('a', 'mul'), 100, 300), sel(makeNode('b', 'mul'), 250, 420)],
      edges: [makeEdge('a', 'out', 'b', 'a')],
    });
    useAppStore.getState().organizeSelection();
    expect(useAppStore.getState().past).toHaveLength(1);
    useAppStore.getState().undo();
    expect(pos('a')).toEqual({ x: 100, y: 300 });
    expect(pos('b')).toEqual({ x: 250, y: 420 });
  });

  it('a selected group rides as one unit — members keep their relative offsets', () => {
    const group = {
      ...makeNode('g', 'group'),
      type: 'group',
      selected: true,
      position: { x: 500, y: 500 },
      width: 200,
      height: 150,
    } as AppNode;
    // Member selected along with its group (rubber-band selects both): it must
    // ride with the group, not be laid out twice.
    const member = { ...sel(makeNode('m', 'mul'), 30, 40, 'g') } as AppNode;
    const feeder = sel(makeNode('f', 'mul'), 0, 0);
    useAppStore.setState({
      nodes: [group, member, feeder],
      edges: [makeEdge('f', 'out', 'm', 'a')],
    });
    useAppStore.getState().organizeSelection();
    // Member's parent-relative position is untouched (it rode with the group).
    expect(pos('m')).toEqual({ x: 30, y: 40 });
    // Feeder sits left of the group (the edge f→m lifts to f→g for layout).
    const g = useAppStore.getState().nodes.find((n) => n.id === 'g')!;
    expect(pos('f').x).toBeLessThan(g.position.x);
  });

  it('members organized inside an unselected group stay parent-relative', () => {
    const group = {
      ...makeNode('g', 'group'),
      type: 'group',
      position: { x: 1000, y: 1000 },
      width: 400,
      height: 300,
    } as AppNode;
    useAppStore.setState({
      nodes: [group, sel(makeNode('a', 'mul'), 20, 30, 'g'), sel(makeNode('b', 'mul'), 60, 200, 'g')],
      edges: [makeEdge('a', 'out', 'b', 'a')],
    });
    useAppStore.getState().organizeSelection();
    const [pa, pb] = [pos('a'), pos('b')];
    // Still parent-relative (a member position near 20/30, not near 1020/1030),
    // anchored at the pair's old parent-relative top-left.
    expect(Math.min(pa.x, pb.x)).toBeCloseTo(20, 5);
    expect(Math.min(pa.y, pb.y)).toBeCloseTo(30, 5);
    expect(pa.y).toBeCloseTo(pb.y, 5); // chain shares the top baseline
    const parented = useAppStore
      .getState()
      .nodes.filter((n) => (n as { parentId?: string }).parentId === 'g');
    expect(parented).toHaveLength(2);
  });

  it('detaches a member the layout pushes outside its unselected group frame', () => {
    // A member of an UNSELECTED group, organized together with a node far
    // outside the group, gets laid out well beyond the group frame. Left
    // parented it would render outside the frame yet vanish (display:none) the
    // moment the group is collapsed — so it must detach.
    const group = {
      ...makeNode('g', 'group'),
      type: 'group',
      position: { x: 1000, y: 1000 },
      width: 400,
      height: 300,
    } as AppNode;
    useAppStore.setState({
      nodes: [group, sel(makeNode('m', 'mul'), 20, 30, 'g'), sel(makeNode('ext', 'mul'), 100, 100)],
      edges: [makeEdge('ext', 'out', 'm', 'a')],
    });
    useAppStore.getState().organizeSelection();
    const m = useAppStore.getState().nodes.find((n) => n.id === 'm')!;
    // No longer a member of g (would otherwise disappear on collapse).
    expect((m as { parentId?: string }).parentId).toBeUndefined();
    // And it landed nowhere near the group's frame (1000–1400 / 1000–1300).
    expect(pos('m').x).toBeLessThan(1000);
  });

  it('uses measured DOM boxes when present (tall node pushes its rank-mate down)', () => {
    const tall = {
      ...sel(makeNode('tall', 'mul'), 0, 0),
      measured: { width: 60, height: 300 },
    } as AppNode;
    const short = {
      ...sel(makeNode('short', 'mul'), 0, 100),
      measured: { width: 60, height: 40 },
    } as AppNode;
    const sink = sel(makeNode('sink', 'mul'), 200, 0);
    useAppStore.setState({
      nodes: [tall, short, sink],
      edges: [makeEdge('tall', 'out', 'sink', 'a'), makeEdge('short', 'out', 'sink', 'b')],
    });
    useAppStore.getState().organizeSelection();
    // tall + short share the first rank; whichever is above, the gap must fit
    // the upper node's REAL 300px (or 40px) measured height.
    const [pt, ps] = [pos('tall'), pos('short')];
    const [upper, upperH, lower] = pt.y <= ps.y ? [pt, 300, ps] : [ps, 40, pt];
    expect(lower.y).toBeGreaterThanOrEqual(upper.y + upperH);
  });
});
