import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { makeNode, makeEdge } from '@/test-utils';
import {
  makeTypedEdge,
  bridgeEdgesAcrossDeletedNodes,
  removeEdgesForPort,
  unwrapCollapsedGroupEdges,
  restoreCollapsedEdges,
} from './edgeUtils';
import { graphToCode } from '@/engine/graphToCode';
import { getTargetEdges, getUnwrappedEdges, evaluateNodeScalar } from '@/engine/cpuEvaluator';
import { hasTimeUpstream } from '@/utils/graphTraversal';
import { useAppStore, setGraphPersistence, cancelPendingGraphSave } from '@/store/useAppStore';
import type { AppNode, AppEdge, BoundarySocket } from '@/types';

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

describe('makeTypedEdge', () => {
  it('derives the deterministic id and keeps raw handles', () => {
    const e = makeTypedEdge('a', 'out', 'b', 'in');
    expect(e.id).toBe('e-a-out-b-in');
    expect(e.type).toBe('typed');
    expect(e.data).toEqual({ dataType: 'any' });
  });

  it('falls back to out/in in the id but preserves null handles on the edge', () => {
    const e = makeTypedEdge('a', null, 'b', undefined);
    expect(e.id).toBe('e-a-out-b-in');
    expect(e.sourceHandle).toBeNull();
    expect(e.targetHandle).toBeUndefined();
  });
});

describe('bridgeEdgesAcrossDeletedNodes', () => {
  // X → A → B → C
  const chain = [
    makeEdge('x', 'out', 'a', 'in'),
    makeEdge('a', 'out', 'b', 'in'),
    makeEdge('b', 'out', 'c', 'in'),
  ];

  it('returns the input untouched for an empty delete set', () => {
    expect(bridgeEdgesAcrossDeletedNodes(chain, new Set())).toBe(chain);
  });

  it('bridges across one deleted node', () => {
    const out = bridgeEdgesAcrossDeletedNodes(chain, new Set(['a']));
    // A→B becomes X→B; the untouched B→C survives alongside it.
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ source: 'x', target: 'b', targetHandle: 'in' });
    expect(out[1]).toMatchObject({ source: 'b', target: 'c' });
  });

  it('bridges across a chain of deleted nodes', () => {
    const out = bridgeEdgesAcrossDeletedNodes(chain, new Set(['a', 'b']));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ source: 'x', target: 'c' });
  });

  it('drops edges whose target is deleted and dead-end sources', () => {
    // A has no upstream, so B→C cannot be bridged once A and B are gone… but
    // here delete only C: both A→B and X→A survive, B→C vanishes.
    const out = bridgeEdgesAcrossDeletedNodes(chain, new Set(['c']));
    expect(out).toHaveLength(2);
    // Now delete the chain head's feeder: A had upstream X; delete X → the
    // X→A edge dies (target alive but source dead with no upstream).
    const out2 = bridgeEdgesAcrossDeletedNodes(chain, new Set(['x']));
    expect(out2.map((e) => e.source)).toEqual(['a', 'b']);
  });

  it('keeps single-input semantics: first bridge to a port wins', () => {
    // Two feeders into the same port via a deleted middleman.
    const edges = [
      makeEdge('p', 'out', 'mid', 'a'),
      makeEdge('q', 'out', 'mid', 'b'),
      makeEdge('mid', 'out', 'dst', 'in'),
    ];
    const out = bridgeEdgesAcrossDeletedNodes(edges, new Set(['mid']));
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe('p');
    expect(out[0].target).toBe('dst');
  });
});

describe('unwrapCollapsedGroupEdges', () => {
  const color1 = makeNode('color1', 'color', { hex: '#ff0000' });
  const out1 = makeNode('out1', 'output');

  it('is an identity pass-through when nothing is collapsed', () => {
    const nodes = [color1, out1, makeGroup('g1', { collapsed: false })];
    const edges = [makeEdge('color1', 'out', 'out1', 'color')];
    expect(unwrapCollapsedGroupEdges(nodes, edges)).toBe(edges);
  });

  it('rewrites boundary edges back to the real child endpoints', () => {
    const g1 = makeGroup('g1', {
      collapsed: true,
      collapsedOutputs: [{ socketId: 's-out', originalNodeId: 'color1', originalHandleId: 'out' }],
      collapsedInputs: [{ socketId: 's-in', originalNodeId: 'color1', originalHandleId: 'tint' }],
    });
    const feeder = makeNode('f1', 'float', { value: 1 });
    const nodes = [color1, out1, feeder, g1];
    const edges = [
      makeEdge('g1', 's-out', 'out1', 'color'), // group → downstream
      makeEdge('f1', 'out', 'g1', 's-in'), // upstream → group
    ];
    const unwrapped = unwrapCollapsedGroupEdges(nodes, edges);
    expect(unwrapped).toHaveLength(2);
    expect(unwrapped[0]).toMatchObject({ source: 'color1', sourceHandle: 'out', target: 'out1' });
    expect(unwrapped[1]).toMatchObject({ source: 'f1', target: 'color1', targetHandle: 'tint' });
  });

  it('drops untranslatable edges still landing on a collapsed group (legacy payloads)', () => {
    const g1 = makeGroup('g1', { collapsed: true }); // no socket maps recorded
    const nodes = [color1, out1, g1];
    const edges = [makeEdge('g1', 'ghost-socket', 'out1', 'color')];
    expect(unwrapCollapsedGroupEdges(nodes, edges)).toHaveLength(0);
  });

  it('collapse state never changes compiled output (the documented guarantee)', () => {
    const g1 = makeGroup('g1', {
      collapsed: true,
      collapsedOutputs: [{ socketId: 's-out', originalNodeId: 'color1', originalHandleId: 'out' }],
    });
    const logical = graphToCode([color1, out1], [makeEdge('color1', 'out', 'out1', 'color')]);
    const collapsed = graphToCode(
      [color1, out1, g1],
      [makeEdge('g1', 's-out', 'out1', 'color')],
    );
    expect(collapsed.code).toBe(logical.code);
  });

  // ── The card-layer contract MathPreviewNode's folded key depends on ──────
  // A node card that resolves its feeder through `getTargetEdges` (the
  // UNWRAPPED view) must ALSO walk the unwrapped edges in any follow-up graph
  // traversal. Mixing the two views is worse than using either one
  // consistently, and it is invisible to a component-free test suite — hence
  // these two pins.
  it('a node card must walk the UNWRAPPED edges after resolving a feeder through a collapsed group', () => {
    // Time (outside) -> Multiply (INSIDE a collapsed group) -> sin (outside).
    const g1 = makeGroup('g1', {
      collapsed: true,
      collapsedInputs: [{ socketId: 's-in', originalNodeId: 'mul1', originalHandleId: 'a' }],
      collapsedOutputs: [{ socketId: 's-out', originalNodeId: 'mul1', originalHandleId: 'out' }],
    });
    const mul1 = { ...makeNode('mul1', 'mul', { a: 0, b: 2 }), parentId: 'g1' } as AppNode;
    const time1 = makeNode('time1', 'time');
    const sin1 = makeNode('sin1', 'sin', { x: 0 });
    const nodes = [g1, time1, mul1, sin1];
    const edges = [makeEdge('time1', 'out', 'g1', 's-in'), makeEdge('g1', 's-out', 'sin1', 'x')];

    const e = getTargetEdges(nodes, edges, 'sin1').find((x) => x.targetHandle === 'x')!;
    expect(e.source).toBe('mul1');
    // THE TRAP: the raw array lost time1 -> mul1 (unwrap retargeted it at the
    // group, then dropped it), so a raw walk reports 'no time' and the card
    // would render its STATIC branch on a genuinely animated input.
    expect(hasTimeUpstream(e.source, nodes, edges)).toBe(false);
    expect(hasTimeUpstream(e.source, nodes, getUnwrappedEdges(nodes, edges))).toBe(true);
    // The evaluator already unwraps internally, so the rAF value is correct.
    expect(evaluateNodeScalar(e.source, nodes, edges, 1.5)).toBe(3);
  });

  it('resolves a collapsed feeder to the real producer (raw find reports the group id)', () => {
    const g1 = makeGroup('g1', {
      collapsed: true,
      collapsedOutputs: [{ socketId: 's-out', originalNodeId: 'time1', originalHandleId: 'out' }],
    });
    const time1 = { ...makeNode('time1', 'time'), parentId: 'g1' } as AppNode;
    const sin1 = makeNode('sin1', 'sin', { x: 0 });
    const nodes = [g1, time1, sin1];
    const edges = [makeEdge('g1', 's-out', 'sin1', 'x')];

    const raw = edges.find((x) => x.target === 'sin1' && x.targetHandle === 'x')!;
    expect(raw.source).toBe('g1');
    expect(evaluateNodeScalar(raw.source, nodes, edges, 1.5)).toBeNull();

    const un = getTargetEdges(nodes, edges, 'sin1').find((x) => x.targetHandle === 'x')!;
    expect(un.source).toBe('time1');
    expect(evaluateNodeScalar(un.source, nodes, edges, 1.5)).toBe(1.5);
  });

  it('with no collapsed group the unwrapped view IS the store array (the ordinary case is untouched)', () => {
    // Why the card's key can pair getTargetEdges with getUnwrappedEdges at no
    // behavioural cost in the overwhelmingly common graph: unwrap short-circuits
    // on `anyCollapsed`, returning the very same array `hasTimeUpstream` was
    // handed before this change.
    const time1 = makeNode('time1', 'time');
    const sin1 = makeNode('sin1', 'sin', { x: 0 });
    const nodes = [time1, sin1];
    const edges = [makeEdge('time1', 'out', 'sin1', 'x')];

    expect(unwrapCollapsedGroupEdges(nodes, edges)).toBe(edges);
    expect(getUnwrappedEdges(nodes, edges)).toBe(edges);
    expect(getTargetEdges(nodes, edges, 'sin1').find((x) => x.targetHandle === 'x')!.source).toBe('time1');
    expect(hasTimeUpstream('time1', nodes, getUnwrappedEdges(nodes, edges))).toBe(true);
  });
});

describe('restoreCollapsedEdges', () => {
  it('restores boundary endpoints with regenerated ids and strips internal hide-classes', () => {
    const g1 = makeGroup('g1', {
      collapsed: true,
      collapsedOutputs: [{ socketId: 's-out', originalNodeId: 'm2', originalHandleId: 'out' }],
      collapsedInputs: [{ socketId: 's-in', originalNodeId: 'm1', originalHandleId: 'a' }],
    });
    const m1 = { ...makeNode('m1', 'add'), parentId: 'g1' } as AppNode;
    const m2 = { ...makeNode('m2', 'sin'), parentId: 'g1' } as AppNode;
    const out1 = makeNode('out1', 'output');
    const feeder = makeNode('f1', 'float');
    const nodes = [g1, m1, m2, out1, feeder];
    const internal = {
      ...makeEdge('m1', 'out', 'm2', 'in'),
      className: 'fs-collapsed-edge',
    } as AppEdge & { className?: string };
    const edges: AppEdge[] = [
      makeEdge('g1', 's-out', 'out1', 'color'),
      makeEdge('f1', 'out', 'g1', 's-in'),
      internal,
    ];

    const restored = restoreCollapsedEdges(edges, nodes, g1);
    const boundary = restored.find((e) => e.target === 'out1')!;
    expect(boundary).toMatchObject({ source: 'm2', sourceHandle: 'out' });
    expect(boundary.id).toBe('e-m2-out-out1-color');

    const inbound = restored.find((e) => e.source === 'f1')!;
    expect(inbound).toMatchObject({ target: 'm1', targetHandle: 'a' });

    const internalRestored = restored.find((e) => e.source === 'm1')!;
    expect((internalRestored as { className?: string }).className).toBeUndefined();
  });
});

describe('removeEdgesForPort', () => {
  // This block mutates the LIVE store; with `isolate: false` the module (and
  // its autosave subscriber) is shared with later files in the same worker —
  // disable persistence for the block and leave no armed timer behind.
  beforeAll(() => setGraphPersistence(false));
  afterAll(() => {
    cancelPendingGraphSave();
    useAppStore.setState({ nodes: [], edges: [], past: [], future: [] });
    setGraphPersistence(true);
  });

  beforeEach(() => {
    useAppStore.setState({
      nodes: [],
      edges: [
        makeEdge('a', 'out', 'b', 'x'),
        makeEdge('c', 'out', 'b', 'y'),
        makeEdge('a', 'out', 'd', 'x'),
      ],
      past: [],
      future: [],
      coalescingHistory: false,
      interactionDepth: 0,
      isUndoRedo: false,
    });
  });

  it("removes exactly the port's edges and records one history entry", () => {
    removeEdgesForPort('b', 'x');
    const { edges, past } = useAppStore.getState();
    expect(edges).toHaveLength(2);
    expect(edges.some((e) => e.target === 'b' && e.targetHandle === 'x')).toBe(false);
    expect(edges.some((e) => e.target === 'b' && e.targetHandle === 'y')).toBe(true);
    expect(edges.some((e) => e.target === 'd')).toBe(true);
    expect(past.length).toBe(1);
  });

  it('is a no-op (no history entry) when the port has no edges', () => {
    removeEdgesForPort('b', 'nope');
    const { edges, past } = useAppStore.getState();
    expect(edges).toHaveLength(3);
    expect(past.length).toBe(0);
  });
});
