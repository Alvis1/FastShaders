import { describe, it, expect } from 'vitest';
import { makeNode, makeEdge } from '@/test-utils';
import { getTimeUpstreamSet, getNodeById, getTargetEdges } from '@/engine/cpuEvaluator';
import { hasTimeUpstream } from '@/utils/graphTraversal';
import type { AppNode, AppEdge, BoundarySocket } from '@/types';

/**
 * `getTimeUpstreamSet` replaced a per-node `hasTimeUpstream` call that ran once
 * per connected edge, per node card, per store NOTIFY — and React Flow
 * notifies at pointer (refresh) rate through a drag, so that was O(E·(N+E))
 * every frame, measured at 85-93% of all per-notify selector work on a
 * 150n/220e graph.
 *
 * Two properties carry the whole change, and neither is visible in the
 * component sources:
 *
 *  1. MEMOIZATION — the set must survive a position-only drag frame (or the
 *     rewrite buys nothing) and must NOT survive a semantic change (or a card
 *     keeps ticking after its Time feeder is cut).
 *  2. UNWRAPPING — it walks the ctx's own edge array, so a Time feeder inside a
 *     collapsed group stays visible. Two call sites (EdgeInfoCard, PreviewNode)
 *     were passing the RAW store array and had this bug live.
 */

function makeGroup(
  id: string,
  opts: {
    collapsed?: boolean;
    collapsedInputs?: Partial<BoundarySocket>[];
    collapsedOutputs?: Partial<BoundarySocket>[];
  } = {},
): AppNode {
  return {
    id,
    type: 'group',
    position: { x: 0, y: 0 },
    data: { label: id, ...opts },
  } as unknown as AppNode;
}

/** What React Flow's applyNodeChanges does for a position change: fresh array,
 *  fresh node object for the dragged one, SAME `data` reference, edges array
 *  untouched. This is the shape `sameGraphSemantics` is built to recognise. */
function dragFrame(nodes: AppNode[], id: string, x: number): AppNode[] {
  return nodes.map((n) =>
    n.id === id ? ({ ...n, position: { x, y: 0 } } as AppNode) : n,
  );
}

describe('getTimeUpstreamSet — memoization across a drag', () => {
  it('returns the SAME set object across position-only frames', () => {
    const nodes = [makeNode('time1', 'time'), makeNode('mul1', 'mul', { a: 0, b: 2 })];
    const edges = [makeEdge('time1', 'out', 'mul1', 'a')];

    const first = getTimeUpstreamSet(nodes, edges);
    expect(first.has('mul1')).toBe(true);

    // 5 simulated pointermove frames — each mints a new `nodes` array.
    let cur = nodes;
    for (let i = 1; i <= 5; i++) {
      cur = dragFrame(cur, 'mul1', i * 10);
      expect(getTimeUpstreamSet(cur, edges)).toBe(first);
    }
  });

  it('rebuilds when a wire is cut (the card must stop ticking)', () => {
    const nodes = [makeNode('time1', 'time'), makeNode('mul1', 'mul', { a: 0, b: 2 })];
    const edges = [makeEdge('time1', 'out', 'mul1', 'a')];
    expect(getTimeUpstreamSet(nodes, edges).has('mul1')).toBe(true);

    // Edge topology change → new ctx → fresh set.
    expect(getTimeUpstreamSet(nodes, []).has('mul1')).toBe(false);
  });

  it('rebuilds when a Time node is added (the card must start ticking)', () => {
    const mul1 = makeNode('mul1', 'mul', { a: 0, b: 2 });
    const float1 = makeNode('f1', 'float', { value: 1 });
    const edgesBefore = [makeEdge('f1', 'out', 'mul1', 'a')];
    expect(getTimeUpstreamSet([float1, mul1], edgesBefore).has('mul1')).toBe(false);

    const time1 = makeNode('time1', 'time');
    const edgesAfter = [makeEdge('time1', 'out', 'mul1', 'a')];
    expect(getTimeUpstreamSet([float1, mul1, time1], edgesAfter).has('mul1')).toBe(true);
  });

  it('rebuilds when a node BECOMES a Time node (registryType lives in `data`)', () => {
    // The invalidation argument in one case: `sameGraphSemantics` compares
    // `data` by reference, and registryType is inside it — so retyping a node
    // cannot be mistaken for a drag frame.
    const a = makeNode('n1', 'float', { value: 1 });
    const b = makeNode('n2', 'mul', { a: 0, b: 2 });
    const edges = [makeEdge('n1', 'out', 'n2', 'a')];
    expect(getTimeUpstreamSet([a, b], edges).has('n2')).toBe(false);

    const retyped = { ...a, data: { ...a.data, registryType: 'time' } } as AppNode;
    expect(getTimeUpstreamSet([retyped, b], edges).has('n2')).toBe(true);
  });
});

describe('getTimeUpstreamSet — walks the UNWRAPPED graph', () => {
  it('sees a Time feeder that sits INSIDE a collapsed group', () => {
    // The live bug at EdgeInfoCard.tsx / PreviewNode.tsx: both handed the RAW
    // store array to hasTimeUpstream, which drops every wire crossing the
    // frame's boundary — the chip froze and the noise thumbnail went static on
    // a genuinely animated input.
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

    const feeder = getTargetEdges(nodes, edges, 'sin1').find((e) => e.targetHandle === 'x')!;
    expect(feeder.source).toBe('mul1');

    // THE REGRESSION, stated both ways: the raw walk says no…
    expect(hasTimeUpstream(feeder.source, nodes, edges)).toBe(false);
    // …the shared accessor says yes, because it never takes the array from the
    // caller in the first place.
    expect(getTimeUpstreamSet(nodes, edges).has(feeder.source)).toBe(true);
  });

  it('is identical to the raw walk when nothing is collapsed (the ordinary graph)', () => {
    const nodes = [makeNode('time1', 'time'), makeNode('sin1', 'sin', { x: 0 })];
    const edges = [makeEdge('time1', 'out', 'sin1', 'x')];
    const set = getTimeUpstreamSet(nodes, edges);
    for (const id of ['time1', 'sin1']) {
      expect(set.has(id)).toBe(hasTimeUpstream(id, nodes, edges));
    }
  });
});

describe('getNodeById', () => {
  it('resolves through the shared index and agrees with a linear scan', () => {
    const nodes = [makeNode('a', 'add'), makeNode('t', 'time'), makeNode('m', 'mul')];
    const edges: AppEdge[] = [];
    for (const id of ['a', 't', 'm', 'missing']) {
      expect(getNodeById(nodes, edges, id)).toBe(nodes.find((n) => n.id === id));
    }
  });
});
