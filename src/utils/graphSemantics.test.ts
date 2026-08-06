import { describe, it, expect } from 'vitest';
import { makeNode, makeEdge } from '@/test-utils';
import { sameGraphSemantics, selectionOnlyGraphChange } from './graphSemantics';
import type { AppNode, AppEdge } from '@/types';

/** A note node — pure annotation, no registry def, ignored by the engines. */
function makeNote(id: string): AppNode {
  return {
    id,
    type: 'note',
    position: { x: 0, y: 0 },
    data: { label: id, text: 'hello' },
  } as unknown as AppNode;
}

function makeGroup(id: string, collapsed: boolean): AppNode {
  return {
    id,
    type: 'group',
    position: { x: 0, y: 0 },
    data: { label: id, collapsed },
  } as unknown as AppNode;
}

/** The shape applyNodeChanges produces for a position/select change: node
 *  spread into a fresh object, `data` reference reused. */
function movedCopy(n: AppNode): AppNode {
  return { ...n, position: { x: 99, y: 99 } } as AppNode;
}
function selectedCopy(n: AppNode): AppNode {
  return { ...n, selected: true } as AppNode;
}
function dataEditedCopy(n: AppNode): AppNode {
  return { ...n, data: { ...n.data } } as AppNode;
}

const baseNodes = [makeNode('a', 'color', { hex: '#ff0000' }), makeNode('out1', 'output')];
const baseEdges = [makeEdge('a', 'out', 'out1', 'color')];

describe('sameGraphSemantics', () => {
  it('same references are inert', () => {
    expect(sameGraphSemantics(baseNodes, baseNodes, baseEdges, baseEdges)).toBe(true);
  });

  it('position-only change is inert', () => {
    const next = [movedCopy(baseNodes[0]), baseNodes[1]];
    expect(sameGraphSemantics(baseNodes, next, baseEdges, baseEdges)).toBe(true);
  });

  it('selection-only change is inert', () => {
    const next = baseNodes.map(selectedCopy);
    expect(sameGraphSemantics(baseNodes, next, baseEdges, [...baseEdges])).toBe(true);
  });

  it('node data change is semantic', () => {
    const next = [dataEditedCopy(baseNodes[0]), baseNodes[1]];
    expect(sameGraphSemantics(baseNodes, next, baseEdges, baseEdges)).toBe(false);
  });

  it('note-node data change is inert (annotations are engine-invisible)', () => {
    const prev = [...baseNodes, makeNote('n1')];
    const next = [prev[0], prev[1], dataEditedCopy(prev[2])];
    expect(sameGraphSemantics(prev, next, baseEdges, baseEdges)).toBe(true);
  });

  it('group-node data change is semantic (collapse rewrites boundary edges)', () => {
    const prev = [...baseNodes, makeGroup('g1', false)];
    const next = [prev[0], prev[1], dataEditedCopy(prev[2])];
    expect(sameGraphSemantics(prev, next, baseEdges, baseEdges)).toBe(false);
  });

  it('added / removed / reordered nodes are semantic', () => {
    expect(sameGraphSemantics(baseNodes, [baseNodes[0]], baseEdges, baseEdges)).toBe(false);
    expect(
      sameGraphSemantics(baseNodes, [...baseNodes, makeNode('b', 'add')], baseEdges, baseEdges),
    ).toBe(false);
    expect(
      sameGraphSemantics(baseNodes, [baseNodes[1], baseNodes[0]], baseEdges, baseEdges),
    ).toBe(false);
  });

  it('edge endpoint change is semantic; waypoint-only rewrite is inert', () => {
    const rerouted = [makeEdge('a', 'out', 'out1', 'position')];
    expect(sameGraphSemantics(baseNodes, baseNodes, baseEdges, rerouted)).toBe(false);

    const withWaypoints = [
      {
        ...baseEdges[0],
        data: { ...(baseEdges[0].data ?? { dataType: 'any' }), waypoints: [{ x: 1, y: 2 }] },
      } as AppEdge,
    ];
    expect(sameGraphSemantics(baseNodes, baseNodes, baseEdges, withWaypoints)).toBe(true);
  });

  it('added edge is semantic', () => {
    const next = [...baseEdges, makeEdge('a', 'out', 'out1', 'position')];
    expect(sameGraphSemantics(baseNodes, baseNodes, baseEdges, next)).toBe(false);
  });
});

describe('selectionOnlyGraphChange', () => {
  it('selection toggles on nodes and edges are skippable', () => {
    const nextNodes = baseNodes.map(selectedCopy);
    const nextEdges = baseEdges.map((e) => ({ ...e, selected: true }) as AppEdge);
    expect(selectionOnlyGraphChange(baseNodes, nextNodes, baseEdges, nextEdges)).toBe(true);
  });

  it('position changes must save', () => {
    const next = [movedCopy(baseNodes[0]), baseNodes[1]];
    expect(selectionOnlyGraphChange(baseNodes, next, baseEdges, baseEdges)).toBe(false);
  });

  it('data changes must save — including notes', () => {
    const prev = [...baseNodes, makeNote('n1')];
    const next = [prev[0], prev[1], dataEditedCopy(prev[2])];
    expect(selectionOnlyGraphChange(prev, next, baseEdges, baseEdges)).toBe(false);
  });

  it('waypoint edits must save', () => {
    const withWaypoints = [
      {
        ...baseEdges[0],
        data: { ...(baseEdges[0].data ?? { dataType: 'any' }), waypoints: [{ x: 1, y: 2 }] },
      } as AppEdge,
    ];
    expect(selectionOnlyGraphChange(baseNodes, baseNodes, baseEdges, withWaypoints)).toBe(false);
  });

  it('membership changes must save', () => {
    const next = [{ ...baseNodes[0], parentId: 'g1' } as AppNode, baseNodes[1]];
    expect(selectionOnlyGraphChange(baseNodes, next, baseEdges, baseEdges)).toBe(false);
  });

  it('explicit width/height resizes must save (note/group corner resize)', () => {
    const next = [{ ...baseNodes[0], width: 320, height: 180 } as AppNode, baseNodes[1]];
    expect(selectionOnlyGraphChange(baseNodes, next, baseEdges, baseEdges)).toBe(false);
  });

  it('measured-size updates alone are skippable', () => {
    const next = [
      { ...baseNodes[0], measured: { width: 120, height: 80 } } as AppNode,
      baseNodes[1],
    ];
    expect(selectionOnlyGraphChange(baseNodes, next, baseEdges, baseEdges)).toBe(true);
  });
});
