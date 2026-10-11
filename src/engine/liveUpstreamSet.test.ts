import { describe, it, expect } from 'vitest';
import { makeNode, makeEdge } from '@/test-utils';
import { getLiveUpstreamSet, getTargetEdges, getTimeUpstreamSet } from '@/engine/cpuEvaluator';
import type { AppNode, AppEdge, BoundarySocket } from '@/types';

/**
 * `getLiveUpstreamSet` answers the canvas's "is this wire LIVE?" (TypedEdge,
 * PreviewLink): a live wire marches, a still one is drawn solid with direction
 * chevrons (owner, 2026-10-11: "marching only animated"). Live = changes on
 * its own: fed by a Time node or by the Sound node.
 *
 * It is asked by EVERY edge's selector on EVERY store notify, so it has the
 * same two obligations as getTimeUpstreamSet (timeUpstreamSet.test.ts):
 * memoized per graph version (a drag frame must not rebuild it) and walked on
 * the UNWRAPPED edges (a Time feeder inside a collapsed frame still counts).
 */

function makeGroup(
  id: string,
  opts: { collapsed?: boolean; collapsedInputs?: Partial<BoundarySocket>[]; collapsedOutputs?: Partial<BoundarySocket>[] } = {},
): AppNode {
  return { id, type: 'group', position: { x: 0, y: 0 }, data: { label: id, ...opts } } as unknown as AppNode;
}

describe('getLiveUpstreamSet', () => {
  it('holds everything downstream of a Time node, and nothing that is not', () => {
    const nodes = [
      makeNode('time1', 'time'),
      makeNode('sin1', 'sin', { x: 0 }),
      makeNode('f1', 'float', { value: 1 }),
      makeNode('mul1', 'mul', { a: 0, b: 2 }),
      makeNode('out1', 'output'),
    ];
    const edges = [
      makeEdge('time1', 'out', 'sin1', 'x'),
      makeEdge('sin1', 'out', 'mul1', 'a'),
      makeEdge('f1', 'out', 'mul1', 'b'),
      makeEdge('mul1', 'out', 'out1', 'color'),
    ];
    const live = getLiveUpstreamSet(nodes, edges);
    for (const id of ['time1', 'sin1', 'mul1', 'out1']) expect(live.has(id), id).toBe(true);
    // A constant feeding a live node is still a still wire.
    expect(live.has('f1')).toBe(false);
  });

  it('treats the Sound node as a live signal (the time set does not)', () => {
    const nodes = [makeNode('snd', 'soundNode'), makeNode('mul1', 'mul', { a: 0, b: 2 })];
    const edges = [makeEdge('snd', 'level', 'mul1', 'a')];
    expect(getLiveUpstreamSet(nodes, edges).has('mul1')).toBe(true);
    expect(getTimeUpstreamSet(nodes, edges).has('mul1')).toBe(false);
  });

  it('is empty for a graph with no live source — every wire on a static graph is still', () => {
    const nodes = [makeNode('f1', 'float', { value: 1 }), makeNode('out1', 'output')];
    const edges = [makeEdge('f1', 'out', 'out1', 'color')];
    expect(getLiveUpstreamSet(nodes, edges).size).toBe(0);
  });

  it('returns the SAME set across a position-only drag frame, and a fresh one after a cut', () => {
    const nodes = [makeNode('time1', 'time'), makeNode('mul1', 'mul', { a: 0, b: 2 })];
    const edges = [makeEdge('time1', 'out', 'mul1', 'a')];
    const first = getLiveUpstreamSet(nodes, edges);
    const dragged = nodes.map((n) => (n.id === 'mul1' ? ({ ...n, position: { x: 40, y: 0 } } as AppNode) : n));
    expect(getLiveUpstreamSet(dragged, edges)).toBe(first);
    expect(getLiveUpstreamSet(nodes, []).has('mul1')).toBe(false);
  });

  it('sees a Time feeder INSIDE a collapsed group (the unwrapped edge decides)', () => {
    const g1 = makeGroup('g1', {
      collapsed: true,
      collapsedInputs: [{ socketId: 's-in', originalNodeId: 'mul1', originalHandleId: 'a' }],
      collapsedOutputs: [{ socketId: 's-out', originalNodeId: 'mul1', originalHandleId: 'out' }],
    });
    const mul1 = { ...makeNode('mul1', 'mul', { a: 0, b: 2 }), parentId: 'g1' } as AppNode;
    const nodes = [g1, makeNode('time1', 'time'), mul1, makeNode('sin1', 'sin', { x: 0 })];
    const edges: AppEdge[] = [
      makeEdge('time1', 'out', 'g1', 's-in'),
      makeEdge('g1', 's-out', 'sin1', 'x'),
    ];
    // TypedEdge asks with the UNWRAPPED source — the real producer, never the frame.
    const feeder = getTargetEdges(nodes, edges, 'sin1').find((e) => e.targetHandle === 'x')!;
    expect(feeder.source).toBe('mul1');
    expect(getLiveUpstreamSet(nodes, edges).has(feeder.source)).toBe(true);
  });
});
