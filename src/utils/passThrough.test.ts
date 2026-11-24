import { describe, it, expect } from 'vitest';
import type { AppEdge, AppNode } from '@/types';
import { getNodeValues } from '@/types';
import { makeEdge, makeKnot, makeNode, makeTunnelIn, makeTunnelOut } from '@/test-utils';
import {
  foldPassThroughEdges,
  isKnot,
  isPassThroughNode,
  isTunnelIn,
  isTunnelOut,
  passThroughConsumers,
  passThroughSource,
  remapTunnelLinks,
  resolvePassThroughEndpoint,
  topologyEdges,
  tunnelEntrance,
  tunnelExits,
  tunnelLabelOf,
  tunnelLinkOf,
} from './passThrough';
import { unwrapCollapsedGroupEdges, unwrapGroupsOnly } from './edgeUtils';
import { canMuteNode, isMutedNode } from './nodeMute';
import { sanitizeGraphShape, sanitizeTunnelLinks } from './graphShape';
import { parseStoredGraph } from '@/store/useAppStore';
import { wouldCreateCycle } from '@/components/NodeEditor/dragConnect';
import {
  getEdgeOutputShape,
  getFoldedWireSource,
  getLiveUpstreamSet,
  getUnwrappedEdge,
} from '@/engine/cpuEvaluator';
import { graphToCode } from '@/engine/graphToCode';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { previewGraph, previewableOutputs } from './nodePreview';
import { bakeSockets, expandBakeSelection } from './bakePlan';
import { planShaderGroup } from '@/engine/shaderGroupImport';

/**
 * The Branch / Portal FOLD (utils/passThrough.ts): every engine reads straight
 * through the three pass-through flow types, and the few sites that must see
 * the wires as drawn read the group-only view or `topologyEdges`.
 */

const tuple = (e: AppEdge) => `${e.source}.${e.sourceHandle} → ${e.target}.${e.targetHandle}`;
const group = (id: string, extra: Record<string, unknown>): AppNode =>
  ({
    id,
    type: 'group',
    position: { x: 0, y: 0 },
    data: { registryType: 'group', label: id, color: '#888888', width: 200, height: 100, ...extra },
  }) as unknown as AppNode;
const mute = (n: AppNode): AppNode => ({ ...n, data: { ...n.data, muted: true } }) as AppNode;

describe('predicates and readers', () => {
  it('names the three flow types, and nothing else', () => {
    expect(isKnot(makeKnot('k'))).toBe(true);
    expect(isTunnelIn(makeTunnelIn('i'))).toBe(true);
    expect(isTunnelOut(makeTunnelOut('o', 'i'))).toBe(true);
    for (const n of [makeKnot('k'), makeTunnelIn('i'), makeTunnelOut('o', 'i')]) expect(isPassThroughNode(n)).toBe(true);
    // The type is the FLOW type: a registryType alone is no pass-through.
    expect(isPassThroughNode(makeNode('s', 'knot'))).toBe(false);
    expect(isPassThroughNode(makeNode('a', 'add'))).toBe(false);
    expect(isPassThroughNode(null)).toBe(false);
  });

  it('reads link and label without coercing', () => {
    expect(tunnelLinkOf(makeTunnelOut('o', 'in1'))).toBe('in1');
    for (const bad of [5, null, {}, { toString: 1 }, '', 'a"b', 'x\\y', ['in1']]) {
      expect(tunnelLinkOf(makeTunnelOut('o', bad))).toBeNull();
    }
    expect(tunnelLinkOf(makeTunnelIn('i'))).toBeNull();
    expect(tunnelLabelOf(makeTunnelIn('i', 'glow'))).toBe('glow');
    expect(tunnelLabelOf({ data: { label: 7 } })).toBe('7');
    expect(tunnelLabelOf({ data: { label: { toString: 1 } } })).toBe('');
    expect(tunnelLabelOf({ data: null })).toBe('');
  });

  it('entrance and exit lookups validate the link at read time', () => {
    const nodes = [makeTunnelIn('in1'), makeTunnelOut('o1', 'in1'), makeTunnelOut('o2', 'in1'), makeTunnelOut('o3', 'o1'), makeNode('a', 'add')];
    expect(tunnelEntrance(nodes, nodes[1])?.id).toBe('in1');
    expect(tunnelEntrance(nodes, nodes[3])).toBeNull(); // a link to another exit
    expect(tunnelEntrance(nodes, makeTunnelOut('o4', 'a'))).toBeNull(); // to a shader node
    expect(tunnelEntrance(nodes, makeTunnelOut('o5', 'gone'))).toBeNull();
    expect(tunnelExits(nodes, 'in1').map((n) => n.id)).toEqual(['o1', 'o2']);
  });

  it('a pass-through has no values and cannot be muted', () => {
    for (const n of [makeKnot('k'), makeTunnelIn('i'), makeTunnelOut('o', 'i')]) {
      const forged = { ...n, data: { ...n.data, values: { a: 1 }, muted: true } } as AppNode;
      expect(getNodeValues(forged)).toEqual({});
      expect(canMuteNode(forged)).toBe(false);
      expect(isMutedNode(forged)).toBe(false);
    }
  });
});

describe('foldPassThroughEdges', () => {
  it('returns the SAME array with no pass-through, and when no wire touches one', () => {
    const nodes = [makeNode('f', 'float'), makeNode('out', 'output')];
    const edges = [makeEdge('f', 'out', 'out', 'color')];
    expect(foldPassThroughEdges(nodes, edges)).toBe(edges);
    expect(unwrapCollapsedGroupEdges(nodes, edges)).toBe(edges);
    const withIdle = [...nodes, makeKnot('k'), makeTunnelIn('i'), makeTunnelOut('o', 'i')];
    expect(foldPassThroughEdges(withIdle, edges)).toBe(edges);
    expect(unwrapCollapsedGroupEdges(withIdle, edges)).toBe(edges);
  });

  it('reads a Branch through, keeping every edge id and the source HANDLE', () => {
    const nodes = [makeNode('fr', 'fresnel'), makeKnot('k'), makeNode('s', 'sin'), makeNode('c', 'cos')];
    const ks = makeEdge('k', 'out', 's', 'x');
    const kc = makeEdge('k', 'out', 'c', 'x');
    const edges = [makeEdge('fr', 'facing', 'k', 'in'), ks, kc];
    const folded = foldPassThroughEdges(nodes, edges);
    expect(folded.map(tuple)).toEqual(['fr.facing → s.x', 'fr.facing → c.x']);
    expect(folded.map((e) => e.id)).toEqual([ks.id, kc.id]);
    // Idempotent on its own output.
    expect(foldPassThroughEdges(nodes, folded)).toBe(folded);
    // The canvas's lookup by id finds the re-sourced wire.
    expect(getUnwrappedEdge(nodes, edges, ks.id)?.source).toBe('fr');
  });

  it('follows chains of Branches and Portals', () => {
    const nodes = [
      makeNode('t', 'time'),
      makeKnot('k1'),
      makeKnot('k2'),
      makeTunnelIn('in1'),
      makeTunnelOut('o1', 'in1'),
      makeKnot('k3'),
      makeNode('s', 'sin'),
    ];
    const edges = [
      makeEdge('t', 'out', 'k1', 'in'),
      makeEdge('k1', 'out', 'k2', 'in'),
      makeEdge('k2', 'out', 'in1', 'in'),
      makeEdge('o1', 'out', 'k3', 'in'),
      makeEdge('k3', 'out', 's', 'x'),
    ];
    expect(foldPassThroughEdges(nodes, edges).map(tuple)).toEqual(['t.out → s.x']);
    expect(passThroughSource(nodes, edges, 'k3')).toEqual({ source: 't', sourceHandle: 'out' });
    expect(passThroughSource(nodes, edges, 's')).toBeNull();
    expect(resolvePassThroughEndpoint(nodes, edges, 's', 'out')).toEqual({ source: 's', sourceHandle: 'out' });
    expect(resolvePassThroughEndpoint(nodes, edges, 'o1', 'out')).toEqual({ source: 't', sourceHandle: 'out' });
  });

  it('a wire INTO a pass-through carries its feeder, for the canvas to draw', () => {
    // Branch → Branch drew one black still channel: the fold drops the wire,
    // so TypedEdge looked its source up as the Branch itself.
    const nodes = [
      makeNode('t', 'time'),
      makeNode('v', 'vec3'),
      makeNode('m', 'mul'),
      makeKnot('k1'),
      makeKnot('k2'),
      makeKnot('k3'),
      makeTunnelIn('in1'),
      makeNode('s', 'sin'),
    ];
    const tv = makeEdge('t', 'out', 'm', 'a');
    const vm = makeEdge('v', 'out', 'm', 'b');
    const intoK1 = makeEdge('m', 'out', 'k1', 'in');
    const k1k2 = makeEdge('k1', 'out', 'k2', 'in');
    const k2in = makeEdge('k2', 'out', 'in1', 'in');
    const unfed = makeEdge('k3', 'out', 's', 'x');
    const edges = [tv, vm, intoK1, k1k2, k2in, unfed];
    for (const w of [intoK1, k1k2, k2in]) {
      expect(getUnwrappedEdge(nodes, edges, w.id)).toBeUndefined();
      const via = getFoldedWireSource(nodes, edges, w.id);
      expect(via).toEqual({ source: 'm', sourceHandle: 'out' });
      expect(getEdgeOutputShape(via!, nodes, edges)).toBe(3);
      expect(getLiveUpstreamSet(nodes, edges).has(via!.source)).toBe(true);
    }
    // A wire the fold keeps is not this helper's; an unfed chain carries nothing.
    expect(getFoldedWireSource(nodes, edges, tv.id)).toBeNull();
    expect(getFoldedWireSource(nodes, edges, unfed.id)).toBeNull();
    expect(getFoldedWireSource(nodes, [makeEdge('k3', 'out', 'k1', 'in')], 'nope')).toBeNull();
  });

  it('passThroughConsumers runs the resolver forward, as drawn', () => {
    const nodes = [
      makeNode('t', 'time'),
      makeKnot('k1'),
      makeKnot('k2'),
      makeTunnelIn('in1'),
      makeTunnelOut('o1', 'in1'),
      makeTunnelOut('o2', 'in1'),
      makeNode('s', 'sin'),
      makeNode('c', 'cos'),
      makeNode('a', 'add'),
      makeNode('f', 'float'),
    ];
    const edges = [
      makeEdge('t', 'out', 'k1', 'in'),
      makeEdge('k1', 'out', 's', 'x'),
      makeEdge('k1', 'out', 'k2', 'in'),
      makeEdge('k2', 'out', 'in1', 'in'),
      makeEdge('o1', 'out', 'c', 'x'),
      makeEdge('o2', 'out', 'a', 'a'),
    ];
    expect(passThroughConsumers(nodes, edges, 'k1').map(tuple).sort()).toEqual([
      'k1.out → s.x',
      'o1.out → c.x',
      'o2.out → a.a',
    ]);
    // A real node, and a Branch whose FIRST wire is another's: nothing.
    expect(passThroughConsumers(nodes, edges, 's')).toEqual([]);
    const second = [makeEdge('f', 'out', 'k2', 'in'), ...edges];
    expect(passThroughConsumers(nodes, second, 'k1').map(tuple)).toEqual(['k1.out → s.x']);
    // A cycle ends the walk.
    const loop = [makeEdge('k2', 'out', 'k1', 'in'), makeEdge('k1', 'out', 'k2', 'in')];
    expect(passThroughConsumers(nodes, loop, 'k1')).toEqual([]);
  });

  it('a Branch reads its FIRST incoming wire in array order', () => {
    const nodes = [makeNode('a', 'float'), makeNode('b', 'float'), makeKnot('k'), makeNode('s', 'sin')];
    const edges = [makeEdge('b', 'out', 'k', 'in'), makeEdge('a', 'out', 'k', 'in'), makeEdge('k', 'out', 's', 'x')];
    expect(foldPassThroughEdges(nodes, edges).map(tuple)).toEqual(['b.out → s.x']);
  });

  it('drops what cannot resolve: unfed, dangling, self- and invalid links, cycles', () => {
    const s = makeNode('s', 'sin');
    const cases: { nodes: AppNode[]; edges: AppEdge[] }[] = [
      { nodes: [makeKnot('k'), s], edges: [makeEdge('k', 'out', 's', 'x')] },
      { nodes: [makeTunnelIn('i'), makeTunnelOut('o', 'gone'), s], edges: [makeEdge('o', 'out', 's', 'x')] },
      { nodes: [makeTunnelOut('o', 'o'), s], edges: [makeEdge('o', 'out', 's', 'x')] },
      { nodes: [makeTunnelOut('o', 42), s], edges: [makeEdge('o', 'out', 's', 'x')] },
      { nodes: [makeTunnelOut('o', { toString: 1 }), s], edges: [makeEdge('o', 'out', 's', 'x')] },
      { nodes: [makeNode('a', 'add'), makeTunnelOut('o', 'a'), s], edges: [makeEdge('o', 'out', 's', 'x')] },
      { nodes: [makeTunnelOut('o1', 'o2'), makeTunnelOut('o2', 'o1'), s], edges: [makeEdge('o1', 'out', 's', 'x')] },
      {
        nodes: [makeKnot('k1'), makeKnot('k2'), s],
        edges: [makeEdge('k1', 'out', 'k2', 'in'), makeEdge('k2', 'out', 'k1', 'in'), makeEdge('k2', 'out', 's', 'x')],
      },
      {
        // A portal fed by its own exit.
        nodes: [makeTunnelIn('i'), makeTunnelOut('o', 'i'), makeKnot('k'), s],
        edges: [makeEdge('o', 'out', 'k', 'in'), makeEdge('k', 'out', 'i', 'in'), makeEdge('k', 'out', 's', 'x')],
      },
      // A wire out of a Portal In (no such socket: only a forged file has one).
      { nodes: [makeNode('f', 'float'), makeTunnelIn('i'), s], edges: [makeEdge('f', 'out', 'i', 'in'), makeEdge('i', 'out', 's', 'x')] },
    ];
    for (const c of cases) {
      expect(foldPassThroughEdges(c.nodes, c.edges)).toEqual([]);
      // …and the shader reads the socket unwired, exactly as with no wire.
      const out = makeNode('out', 'output');
      const lone = graphToCode([...c.nodes, out], [...c.edges, makeEdge('s', 'out', 'out', 'color')], NODE_REGISTRY).code;
      const real = c.nodes.filter((n) => !isPassThroughNode(n));
      const bare = graphToCode([...real, out], [makeEdge('s', 'out', 'out', 'color')], NODE_REGISTRY).code;
      expect(lone).toBe(bare);
    }
  });

  it('composes with collapsed groups on both sides', () => {
    // f → [g: k → in1] … o1 → [h: s] → out, both groups collapsed.
    const g = group('g', {
      collapsed: true,
      collapsedInputs: [{ socketId: 'gi', originalNodeId: 'k', originalHandleId: 'in' }],
    });
    const h = group('h', {
      collapsed: true,
      collapsedInputs: [{ socketId: 'hi', originalNodeId: 's', originalHandleId: 'x' }],
      collapsedOutputs: [{ socketId: 'ho', originalNodeId: 's', originalHandleId: 'out' }],
    });
    const inG = (n: AppNode) => ({ ...n, parentId: 'g' }) as AppNode;
    const inH = (n: AppNode) => ({ ...n, parentId: 'h' }) as AppNode;
    const nodes = [
      g,
      h,
      makeNode('f', 'float'),
      inG(makeKnot('k')),
      inG(makeTunnelIn('in1')),
      makeTunnelOut('o1', 'in1'),
      inH(makeNode('s', 'sin')),
      makeNode('out', 'output'),
    ];
    const edges = [
      makeEdge('f', 'out', 'g', 'gi'),
      makeEdge('k', 'out', 'in1', 'in'),
      makeEdge('o1', 'out', 'h', 'hi'),
      makeEdge('h', 'ho', 'out', 'color'),
    ];
    expect(unwrapGroupsOnly(nodes, edges).map(tuple)).toEqual([
      'f.out → k.in',
      'k.out → in1.in',
      'o1.out → s.x',
      's.out → out.color',
    ]);
    expect(unwrapCollapsedGroupEdges(nodes, edges).map(tuple)).toEqual(['f.out → s.x', 's.out → out.color']);
    // A pill socket naming an EXIT is folded too.
    const p = group('p', {
      collapsed: true,
      collapsedOutputs: [{ socketId: 'po', originalNodeId: 'o1', originalHandleId: 'out' }],
    });
    const nodes2 = [p, makeNode('f', 'float'), makeTunnelIn('in1'), { ...makeTunnelOut('o1', 'in1'), parentId: 'p' } as AppNode, makeNode('s', 'sin')];
    const edges2 = [makeEdge('f', 'out', 'in1', 'in'), makeEdge('p', 'po', 's', 'x')];
    expect(unwrapCollapsedGroupEdges(nodes2, edges2).map(tuple)).toEqual(['f.out → s.x']);
  });

  it('a muted node feeding an entrance passes its own input on to the portal', () => {
    const nodes = [
      makeNode('t', 'time'),
      mute(makeNode('m', 'sin')),
      makeTunnelIn('in1'),
      makeTunnelOut('o1', 'in1'),
      makeNode('c', 'cos'),
      makeNode('out', 'output'),
    ];
    const edges = [
      makeEdge('t', 'out', 'm', 'x'),
      makeEdge('m', 'out', 'in1', 'in'),
      makeEdge('o1', 'out', 'c', 'x'),
      makeEdge('c', 'out', 'out', 'color'),
    ];
    const direct = graphToCode(
      [makeNode('t', 'time'), makeNode('c', 'cos'), makeNode('out', 'output')],
      [makeEdge('t', 'out', 'c', 'x'), makeEdge('c', 'out', 'out', 'color')],
      NODE_REGISTRY,
    ).code;
    expect(graphToCode(nodes, edges, NODE_REGISTRY).code).toBe(direct);
  });
});

describe('topologyEdges — the cycle and occupancy view', () => {
  const nodes = [
    makeNode('a', 'sin'),
    makeTunnelIn('in1'),
    makeTunnelOut('o1', 'in1'),
    makeTunnelOut('broken', 'nope'),
    makeKnot('k'),
    makeNode('b', 'cos'),
  ];
  const edges = [makeEdge('a', 'out', 'in1', 'in'), makeEdge('o1', 'out', 'k', 'in'), makeEdge('k', 'out', 'b', 'x')];

  it('adds one virtual entrance → exit edge per LIVE link, with no handle', () => {
    const topo = topologyEdges(nodes, edges);
    expect(topo.slice(0, edges.length)).toEqual(edges);
    const virtual = topo.slice(edges.length);
    expect(virtual.map((e) => [e.source, e.target, e.sourceHandle, e.targetHandle])).toEqual([['in1', 'o1', null, null]]);
    expect(edges.some((e) => e.id === virtual[0].id)).toBe(false);
    expect(topologyEdges([makeNode('a', 'sin')], edges)).toBe(edges);
  });

  it('refuses a cycle through a portal, which the folded view cannot see', () => {
    // Wiring b → a closes a → in1 ⇢ o1 → k → b → a.
    expect(wouldCreateCycle(topologyEdges(nodes, edges), 'b', 'a')).toBe(true);
    expect(wouldCreateCycle(topologyEdges(nodes, edges), 'b', 'k')).toBe(true);
    // The fold re-sources k → b onto a, so a cycle into the Branch is invisible there.
    expect(wouldCreateCycle(unwrapCollapsedGroupEdges(nodes, edges), 'b', 'k')).toBe(false);
  });

  it('keeps a Branch input OCCUPIED (the fold drops the wire into it)', () => {
    const occupied = (es: AppEdge[]) => es.some((e) => e.target === 'k' && e.targetHandle === 'in');
    expect(occupied(topologyEdges(nodes, edges))).toBe(true);
    expect(occupied(unwrapCollapsedGroupEdges(nodes, edges))).toBe(false);
  });
});

describe('remapTunnelLinks — the clone matrix', () => {
  const live = [makeTunnelIn('in1'), makeNode('f', 'float')];
  const linkOf = (n: AppNode) => (n.data as Record<string, unknown>).link;

  it('keep (paste, duplicate): an exit alone stays on the live portal; both ends follow the copy', () => {
    const alone = [makeTunnelOut('o1', 'in1')];
    expect(remapTunnelLinks(alone, new Map([['o1', 'o1c']]), 'keep')).toBe(alone);
    const both = [makeTunnelIn('in1'), makeTunnelOut('o1', 'in1')];
    const out = remapTunnelLinks(both, new Map([['in1', 'in1c'], ['o1', 'o1c']]), 'keep');
    expect(linkOf(out[1])).toBe('in1c');
    expect(out[0]).toBe(both[0]);
    expect(linkOf(both[1])).toBe('in1'); // the source node is never mutated
  });

  it('keep-if-live (saved group): kept only while it names a live Portal In', () => {
    const nodes = [makeTunnelOut('a', 'in1'), makeTunnelOut('b', 'f'), makeTunnelOut('c', 'gone')];
    const out = remapTunnelLinks(nodes, new Map(), 'keep-if-live', live);
    expect(out.map(linkOf)).toEqual(['in1', undefined, undefined]);
    expect(out.map((n) => 'link' in (n.data as object))).toEqual([true, false, false]);
  });

  it('clear (shader ADD): a link not remapped is dropped, a remapped one follows', () => {
    const nodes = [makeTunnelIn('fileIn'), makeTunnelOut('a', 'fileIn'), makeTunnelOut('b', 'in1')];
    const out = remapTunnelLinks(nodes, new Map([['fileIn', 'newIn']]), 'clear');
    expect(out.map(linkOf)).toEqual([undefined, 'newIn', undefined]);
  });

  it('drops a malformed link in every mode', () => {
    for (const mode of ['keep', 'keep-if-live', 'clear'] as const) {
      const out = remapTunnelLinks([makeTunnelOut('o', { toString: 1 })], new Map(), mode, live);
      expect('link' in (out[0].data as object)).toBe(false);
    }
  });

  it('the shader ADD path clears a foreign link and re-links one that arrives with its entrance', () => {
    const plan = planShaderGroup(
      {
        nodes: [makeNode('f', 'float'), makeTunnelIn('in1'), makeTunnelOut('o1', 'in1'), makeTunnelOut('o2', 'liveIn')],
        edges: [makeEdge('f', 'out', 'in1', 'in')],
      },
      [makeTunnelIn('liveIn')],
      'file',
      { anchor: { x: 0, y: 0 }, rand: () => 0.5 },
    )!;
    const newIn = plan.members.find(isTunnelIn)!;
    const exits = plan.members.filter(isTunnelOut);
    expect(exits.map(linkOf)).toEqual([newIn.id, undefined]);
  });
});

describe('restore: a malformed link or label', () => {
  it('strips a non-string or selector-unsafe link and keeps the node; nothing else changes', () => {
    const good = makeTunnelOut('o1', 'in1', 'cache');
    const nodes = [makeTunnelIn('in1'), good, makeTunnelOut('o2', 5), makeTunnelOut('o3', 'a"b'), makeTunnelOut('o4', { toString: 1 })];
    const shape = sanitizeGraphShape<AppNode, AppEdge>(nodes, []);
    expect(shape.nodes.map((n) => n.id)).toEqual(['in1', 'o1', 'o2', 'o3', 'o4']);
    expect(shape.nodes[1]).toBe(good);
    expect(shape.nodes.slice(2).map((n) => 'link' in (n.data as object))).toEqual([false, false, false]);
    // By identity when nothing is malformed.
    const clean = [makeTunnelIn('in1'), good];
    expect(sanitizeGraphShape<AppNode, AppEdge>(clean, []).nodes).toBe(clean);
    expect(sanitizeTunnelLinks(clean)).toBe(clean);
  });

  it('an object label drops the node (the rule every node already has); a number label is kept', () => {
    const shape = sanitizeGraphShape<AppNode, AppEdge>(
      [
        { ...makeTunnelIn('in1'), data: { registryType: 'tunnelIn', label: { toString: 1 } } } as unknown as AppNode,
        makeTunnelIn('in2', 7 as unknown as string),
      ],
      [],
    );
    expect(shape.nodes.map((n) => n.id)).toEqual(['in2']);
  });

  it('the fs:graph restore keeps a broken exit, unwired, and renders its consumer as unwired', () => {
    const doc = {
      nodes: [makeNode('f', 'float', { value: 0.5 }), makeTunnelIn('in1'), makeTunnelOut('o1', ['in1']), makeNode('s', 'sin'), makeNode('out', 'output')],
      edges: [makeEdge('f', 'out', 'in1', 'in'), makeEdge('o1', 'out', 's', 'x'), makeEdge('s', 'out', 'out', 'color')],
    };
    const g = parseStoredGraph(JSON.parse(JSON.stringify(doc)))!;
    expect(g).not.toBeNull();
    const o1 = g.nodes.find((n) => n.id === 'o1')!;
    expect('link' in (o1.data as object)).toBe(false);
    expect(g.edges).toHaveLength(3);
    expect(unwrapCollapsedGroupEdges(g.nodes, g.edges).map(tuple)).toEqual(['s.out → out.color']);
  });
});

describe('Preview mode and bake read through', () => {
  const nodes = [
    makeNode('t', 'time'),
    makeKnot('k'),
    makeTunnelIn('in1'),
    makeTunnelOut('o1', 'in1'),
    makeNode('s', 'sin'),
    makeNode('out', 'output'),
  ];
  const edges = [
    makeEdge('t', 'out', 'k', 'in'),
    makeEdge('k', 'out', 'in1', 'in'),
    makeEdge('o1', 'out', 's', 'x'),
    makeEdge('s', 'out', 'out', 'color'),
  ];

  it('a Branch and a Portal Out offer their value; a Portal In offers nothing', () => {
    expect(previewableOutputs(makeKnot('k')).map((p) => p.id)).toEqual(['out']);
    expect(previewableOutputs(makeTunnelOut('o', 'i')).map((p) => p.id)).toEqual(['out']);
    expect(previewableOutputs(makeTunnelIn('i'))).toEqual([]);
  });

  it('previewing a Portal Out routes its RESOLVED source to the Output', () => {
    const viaExit = previewGraph(nodes, edges, { nodeId: 'o1', handleId: 'out' });
    const direct = previewGraph(nodes, edges, { nodeId: 't', handleId: 'out' });
    expect(graphToCode(viaExit.nodes, viaExit.edges, NODE_REGISTRY).code).toBe(
      graphToCode(direct.nodes, direct.edges, NODE_REGISTRY).code,
    );
    // An unfed Branch routes nothing: the Output reads its unwired Color.
    const unfed = previewGraph([...nodes, makeKnot('lone')], edges, { nodeId: 'lone', handleId: 'out' });
    expect(unfed.edges.some((e) => e.target === 'out')).toBe(false);
  });

  it('a bake never selects a pass-through and moves the wire INTO the portal, never out of it', () => {
    expect([...expandBakeSelection(nodes, ['t', 'k', 'in1', 'o1'])]).toEqual(['t']);
    const sockets = bakeSockets(nodes, edges, new Set(['t']));
    expect(sockets).toHaveLength(1);
    expect(sockets[0].consumers.map(tuple)).toEqual(['t.out → k.in']);
  });
});
