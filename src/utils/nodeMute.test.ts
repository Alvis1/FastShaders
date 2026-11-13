import { describe, it, expect } from 'vitest';
import type { AppEdge, AppNode } from '@/types';
import { makeEdge, makeNode } from '@/test-utils';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { graphToCode } from '@/engine/graphToCode';
import { panelCodegen } from '@/engine/panelCode';
import { connectedExportIds } from '@/engine/exportGraph';
import { evaluateEdgeSource, evaluateNodeOutput, getEdgeOutputShape, getTargetEdges } from '@/engine/cpuEvaluator';
import { computeReachableCost } from './nodeCost';
import {
  bypassMutedEdges, canMuteNode, detachEdges, isMutedNode, mutedMarkKey, mutedNodeIds, passInputOrder,
} from './nodeMute';

/**
 * MUTE (utils/nodeMute.ts): a muted node stays on the canvas with its wires,
 * and every reader that must agree with the shader reads it as BYPASSED —
 * the module, the wire values, the price, the panel's scope.
 */

const tuple = (e: AppEdge) => `${e.source}.${e.sourceHandle} → ${e.target}.${e.targetHandle}`;
const muted = (n: AppNode, flag: unknown = true): AppNode => ({ ...n, data: { ...n.data, muted: flag } }) as AppNode;

/** f1 (0.5) → m.a, f2 (0.3) → m.b, m → out.color. */
function chain(mute: boolean): { nodes: AppNode[]; edges: AppEdge[] } {
  const m = makeNode('m', 'mul');
  return {
    nodes: [
      makeNode('f1', 'float', { value: 0.5 }),
      makeNode('f2', 'float', { value: 0.3 }),
      mute ? muted(m) : m,
      makeNode('out', 'output'),
    ],
    edges: [makeEdge('f1', 'out', 'm', 'a'), makeEdge('f2', 'out', 'm', 'b'), makeEdge('m', 'out', 'out', 'color')],
  };
}

/** The same graph with `m` deleted and its chain closed by hand: f1 → out.color. */
function spliced(): { nodes: AppNode[]; edges: AppEdge[] } {
  return {
    nodes: [makeNode('f1', 'float', { value: 0.5 }), makeNode('f2', 'float', { value: 0.3 }), makeNode('out', 'output')],
    edges: [makeEdge('f1', 'out', 'out', 'color')],
  };
}

describe('the flag', () => {
  it('only the literal true mutes, and never a sink, a frame or a note', () => {
    const n = makeNode('n', 'mul');
    expect(isMutedNode(muted(n))).toBe(true);
    for (const junk of ['true', 1, {}, [], null, false]) expect(isMutedNode(muted(n, junk)), String(junk)).toBe(false);
    expect(isMutedNode(n)).toBe(false);
    expect(isMutedNode(muted(makeNode('o', 'output')))).toBe(false);
    expect(canMuteNode(makeNode('o', 'output'))).toBe(false);
    const frame = { id: 'g', type: 'group', position: { x: 0, y: 0 }, data: { registryType: 'group', label: 'g', muted: true } } as unknown as AppNode;
    expect(isMutedNode(frame)).toBe(false);
    expect(canMuteNode(frame)).toBe(false);
    expect(canMuteNode(n)).toBe(true);
  });

  it('mutedNodeIds is null with nothing muted; the mark key skips hidden nodes', () => {
    expect(mutedNodeIds(chain(false).nodes)).toBeNull();
    expect([...(mutedNodeIds(chain(true).nodes) ?? [])]).toEqual(['m']);
    const a = muted(makeNode('a', 'mul'));
    const b = { ...muted(makeNode('b', 'add')), hidden: true } as AppNode;
    const c = muted(makeNode('c', 'sub'));
    expect(mutedMarkKey([a, b, c])).toBe('a\nc');
    expect(mutedMarkKey(chain(false).nodes)).toBe('');
  });
});

describe('the pass-through input', () => {
  it('is the first input, except Mix and Select (A) and Smoothstep (X)', () => {
    expect(passInputOrder('mul')[0]).toBe('a');
    expect(passInputOrder('mix')[0]).toBe('a');
    expect(passInputOrder('select')[0]).toBe('a');
    expect(passInputOrder('smoothstep')[0]).toBe('x');
    expect(passInputOrder('pow')[0]).toBe('base');
    // Every other input follows in port order.
    expect(passInputOrder('mix')).toEqual(['a', 'b', 't']);
    expect(passInputOrder('smoothstep')).toEqual(['x', 'edge0', 'edge1']);
    expect(passInputOrder('constructor')).toEqual([]);
    expect(passInputOrder(5)).toEqual([]);
  });
});

describe('bypassMutedEdges', () => {
  it('is the same array when nothing is muted', () => {
    const g = chain(false);
    expect(bypassMutedEdges(g.nodes, g.edges)).toBe(g.edges);
  });

  it('re-sources the wire leaving a muted node, in place; wires into it stay', () => {
    const g = chain(true);
    const out = bypassMutedEdges(g.nodes, g.edges);
    expect(out.map(tuple)).toEqual(['f1.out → m.a', 'f2.out → m.b', 'f1.out → out.color']);
    expect(out[2].id).not.toBe(g.edges[2].id);
  });

  it('Mix passes A even when the factor was wired first', () => {
    const nodes = [makeNode('a', 'float'), makeNode('t', 'float'), muted(makeNode('mx', 'mix')), makeNode('out', 'output')];
    const edges = [makeEdge('t', 'out', 'mx', 't'), makeEdge('a', 'out', 'mx', 'a'), makeEdge('mx', 'out', 'out', 'color')];
    expect(bypassMutedEdges(nodes, edges).map(tuple)).toContain('a.out → out.color');
  });

  it('an unwired pass input falls back to the next wired one, in port order', () => {
    const nodes = [makeNode('t', 'float'), makeNode('b', 'float'), muted(makeNode('mx', 'mix')), makeNode('out', 'output')];
    const edges = [makeEdge('t', 'out', 'mx', 't'), makeEdge('b', 'out', 'mx', 'b'), makeEdge('mx', 'out', 'out', 'color')];
    expect(bypassMutedEdges(nodes, edges).map(tuple)).toContain('b.out → out.color');
  });

  it('nothing wired in: the wires out are dropped (consumers read their own values)', () => {
    const nodes = [muted(makeNode('n', 'perlin')), makeNode('out', 'output')];
    const edges = [makeEdge('n', 'out', 'out', 'color')];
    expect(bypassMutedEdges(nodes, edges)).toEqual([]);
  });

  it('follows a chain of muted nodes, and a muted cycle passes nothing', () => {
    const nodes = [makeNode('f', 'float'), muted(makeNode('m1', 'abs')), muted(makeNode('m2', 'abs')), makeNode('out', 'output')];
    const edges = [makeEdge('f', 'out', 'm1', 'x'), makeEdge('m1', 'out', 'm2', 'x'), makeEdge('m2', 'out', 'out', 'color')];
    const def = NODE_REGISTRY.get('abs')!;
    const x = def.inputs[0].id;
    const fixed = edges.map((e) => (e.target === 'm1' || e.target === 'm2' ? { ...e, targetHandle: x } : e));
    expect(bypassMutedEdges(nodes, fixed).map(tuple)).toContain('f.out → out.color');
    const loop = [makeEdge('m2', 'out', 'm1', x), makeEdge('m1', 'out', 'm2', x), makeEdge('m2', 'out', 'out', 'color')];
    expect(bypassMutedEdges(nodes, loop).map(tuple)).toEqual(['m2.out → m1.' + x, 'm1.out → m2.' + x]);
  });
});

describe('detachEdges (Alt+drag)', () => {
  it('pulls a node out and closes the chain through its pass-through', () => {
    const g = chain(false);
    expect(detachEdges(g.nodes, g.edges, new Set(['m'])).map(tuple)).toEqual(['f1.out → out.color']);
  });

  it('keeps wires between two pulled nodes, and closes the chain across both', () => {
    const nodes = [makeNode('x', 'float'), makeNode('a', 'abs'), makeNode('b', 'fract'), makeNode('out', 'output')];
    const ax = NODE_REGISTRY.get('abs')!.inputs[0].id;
    const bx = NODE_REGISTRY.get('fract')!.inputs[0].id;
    const edges = [makeEdge('x', 'out', 'a', ax), makeEdge('a', 'out', 'b', bx), makeEdge('b', 'out', 'out', 'color')];
    expect(detachEdges(nodes, edges, new Set(['a', 'b'])).map(tuple)).toEqual([`a.out → b.${bx}`, 'x.out → out.color']);
  });

  it('is the same array when no wire crosses the pulled set', () => {
    const g = chain(false);
    const lone = [...g.nodes, makeNode('lone', 'perlin')];
    expect(detachEdges(lone, g.edges, new Set(['lone']))).toBe(g.edges);
  });
});

describe('graphToCode', () => {
  it('a muted node emits as if spliced out — and renames nothing', () => {
    const m = chain(true);
    const s = spliced();
    expect(panelCodegen(m.nodes, m.edges, false).result.code).toBe(panelCodegen(s.nodes, s.edges, false).result.code);
    expect(graphToCode(m.nodes, m.edges).code).toBe(graphToCode(s.nodes, s.edges).code);
    // The muted node keeps its variable NAME (its canvas header).
    const names = graphToCode(m.nodes, m.edges).varNames;
    expect(names.get('m')).toBe(graphToCode(chain(false).nodes, chain(false).edges).varNames.get('m'));
  });

  it('a junk flag, or one on a sink, changes no byte', () => {
    const plain = chain(false);
    const want = graphToCode(plain.nodes, plain.edges).code;
    for (const junk of ['true', 1, {}]) {
      const g = { ...plain, nodes: plain.nodes.map((n) => (n.id === 'm' ? muted(n, junk) : n)) };
      expect(graphToCode(g.nodes, g.edges).code, String(junk)).toBe(want);
    }
    const sink = { ...plain, nodes: plain.nodes.map((n) => (n.id === 'out' ? muted(n) : n)) };
    expect(graphToCode(sink.nodes, sink.edges).code).toBe(want);
    expect(panelCodegen(sink.nodes, sink.edges, false).emitted).toEqual(panelCodegen(plain.nodes, plain.edges, false).emitted);
  });

  it('muting a node between two of the same type swaps no names', () => {
    // a1 → m (muted add) → a2 → out: a1/a2 keep `add1`/`add3`, m keeps `add2`.
    const nodes = [makeNode('f', 'float'), makeNode('a1', 'add'), muted(makeNode('m', 'add')), makeNode('a2', 'add'), makeNode('out', 'output')];
    const edges = [
      makeEdge('f', 'out', 'a1', 'a'), makeEdge('a1', 'out', 'm', 'a'),
      makeEdge('m', 'out', 'a2', 'a'), makeEdge('a2', 'out', 'out', 'color'),
    ];
    const unmutedNodes = nodes.map((n) => (n.id === 'm' ? makeNode('m', 'add') : n));
    const before = graphToCode(unmutedNodes, edges).varNames;
    const after = graphToCode(nodes, edges).varNames;
    expect([...after]).toEqual([...before]);
    const code = graphToCode(nodes, edges).code;
    expect(code).not.toMatch(new RegExp(`const ${before.get('m')} =`));
    expect(code).toMatch(new RegExp(`${before.get('a1')}`));
  });
});

describe('the panel scope and EXPORT', () => {
  it('the panel leaves out the muted node and what feeds only it; EXPORT keeps both', () => {
    const g = chain(true);
    const { emitted } = panelCodegen(g.nodes, g.edges, false);
    expect([...(emitted ?? [])].sort()).toEqual(['f1', 'out']);
    // EXPORT walks the REAL wires: the muted node rides the file, or its
    // consumer's wire would be cut there.
    expect([...(connectedExportIds(g.nodes, g.edges) ?? [])].sort()).toEqual(['f1', 'f2', 'm', 'out']);
  });

  it('with no sink, the emitted set is every node but the muted (so an Apply carries it)', () => {
    const nodes = [makeNode('f', 'float'), muted(makeNode('m', 'mul'))];
    const edges = [makeEdge('f', 'out', 'm', 'a')];
    const { result, emitted } = panelCodegen(nodes, edges, false);
    expect([...(emitted ?? [])]).toEqual(['f']);
    expect(result.code).not.toMatch(/const mul1 =/);
    // …and with nothing muted it is still null, as before.
    expect(panelCodegen([makeNode('f', 'float')], [], false).emitted).toBeNull();
  });
});

describe('cpuEvaluator', () => {
  it('a wire out of a muted node carries the pass-through; the node’s own card does not change', () => {
    const g = chain(true);
    const wire = g.edges[2];
    expect(evaluateEdgeSource(wire, g.nodes, g.edges, 0)?.[0]).toBeCloseTo(0.5);
    expect(evaluateNodeOutput('m', g.nodes, g.edges, 0)?.[0]).toBeCloseTo(0.15);
    // The canvas still draws the real wire.
    expect(getTargetEdges(g.nodes, g.edges, 'out').map(tuple)).toEqual(['m.out → out.color']);
    expect(getEdgeOutputShape(wire, g.nodes, g.edges)).toBe(1);
  });

  it('a muted node passing nothing carries nothing on its wire', () => {
    const nodes = [muted(makeNode('n', 'float', { value: 2 })), makeNode('out', 'output')];
    const edges = [makeEdge('n', 'out', 'out', 'color')];
    expect(evaluateEdgeSource(edges[0], nodes, edges, 0)).toBeNull();
  });
});

describe('cost', () => {
  it('prices the muted graph as the spliced one', () => {
    const m = chain(true);
    const s = spliced();
    expect(computeReachableCost(m.nodes, m.edges)).toBe(computeReachableCost(s.nodes, s.edges));
    expect(computeReachableCost(m.nodes, m.edges)).toBeLessThan(
      computeReachableCost(chain(false).nodes, chain(false).edges),
    );
  });
});
