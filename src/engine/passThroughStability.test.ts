import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type { AppEdge, AppNode } from '@/types';
import { HISTORY_IDLE, makeEdge, makeKnot, makeNode, makeTunnelIn, makeTunnelOut } from '@/test-utils';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NODE_REGISTRY, effectiveInputs } from '@/registry/nodeRegistry';
import { graphToCode } from './graphToCode';
import { codeToGraph } from './codeToGraph';
import { feedsAnOutputIds, panelCodegen } from './panelCode';
import { planExportGraph, pruneToConnected } from './exportGraph';
import {
  evaluateEdgeRange,
  evaluateEdgeSource,
  evaluateNodeOutput,
  getDrawnTargetEdges,
  getTargetEdges,
  getUnwrappedEdge,
} from './cpuEvaluator';
import { computeGraphCost, computeReachableCost } from '@/utils/nodeCost';
import { unwrapCollapsedGroupEdges, unwrapGroupsOnly } from '@/utils/edgeUtils';
import { isPassThroughNode, isTunnelOut } from '@/utils/passThrough';
import { activeSink } from '@/utils/sdfPartition';
import { pairResyncNodes } from '@/utils/resyncPairing';
import {
  carryPanelHidden,
  inOldOrder,
  panelCarryIds,
  panelFeederResolver,
  restoreMutedOutWires,
  restorePassThroughOutWires,
} from '@/utils/panelCarry';
import { cancelPendingGraphSave, useAppStore } from '@/store/useAppStore';

/**
 * A Branch or Portal computes NOTHING (utils/passThrough.ts): a graph whose
 * direct wires are replaced by Branch chains and Portal pairs must emit the
 * same TSL, show the same wire values, cost the same and feed the same Outputs
 * — and the paths that write a graph back (EXPORT's prune, an Apply, a clone)
 * must keep the pass-throughs rather than cut the wires through them.
 */

type Graph = { nodes: AppNode[]; edges: AppEdge[] };

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Node types the generator draws from — scalars, vectors, multi-socket
 *  sources (Split, Fresnel, Color Ramp, To HSL) and an int, so handles and
 *  the int promotion ride the wires too. */
const TYPES = [
  'float', 'int', 'time', 'uv', 'positionGeometry', 'color', 'add', 'sub', 'mul', 'sin', 'cos', 'mix',
  'smoothstep', 'fract', 'split', 'normalize', 'length', 'clamp', 'abs', 'dot', 'fresnel', 'colorRamp',
  'toHsl', 'select', 'greaterThan', 'append', 'vec2', 'vec3',
];
const OUTPUT_CHANNELS = ['color', 'emissive', 'roughness', 'opacity', 'position'];

function randomGraph(r: () => number): Graph {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const nodes: AppNode[] = [];
  const edges: AppEdge[] = [];
  const count = 3 + Math.floor(r() * 9);
  for (let i = 0; i < count; i++) {
    const type = pick(TYPES);
    const values: Record<string, string | number> =
      type === 'float' ? { value: Math.round(r() * 400 - 200) / 100 } : type === 'int' ? { value: Math.floor(r() * 7) - 3 } : {};
    const id = `n${i}`;
    nodes.push(makeNode(id, type, values));
    const def = NODE_REGISTRY.get(type)!;
    for (const port of def.inputs) {
      if (i === 0 || r() < 0.35) continue;
      const src = nodes[Math.floor(r() * i)];
      const outs = NODE_REGISTRY.get(src.data.registryType as string)!.outputs;
      if (outs.length === 0) continue;
      edges.push(makeEdge(src.id, pick(outs).id, id, port.id));
    }
  }
  nodes.push(makeNode('out', 'output'));
  for (const ch of OUTPUT_CHANNELS) {
    if (r() < 0.4) continue;
    const src = pick(nodes.slice(0, -1));
    const outs = NODE_REGISTRY.get(src.data.registryType as string)!.outputs;
    edges.push(makeEdge(src.id, pick(outs).id, 'out', ch));
  }
  return { nodes, edges };
}

/**
 * The same graph with direct wires replaced by Branch chains and Portal pairs.
 * The CONSUMER-side wire takes the old wire's array index (topological-sort
 * ties follow edge order); the wires into pass-throughs go to the end, and
 * the pass-through nodes land at random places in the node array. A Portal is
 * reused for a socket it already carries — another exit, or the same exit
 * fanning out. Returns the consumer wire standing for each original.
 */
function withPassThroughs(g: Graph, r: () => number): Graph & { standIn: Map<string, AppEdge> } {
  const nodes = [...g.nodes];
  const edges: AppEdge[] = [];
  const feeding: AppEdge[] = [];
  const standIn = new Map<string, AppEdge>();
  const portals = new Map<string, { inId: string; exits: string[] }>();
  let k = 0;
  const insert = (n: AppNode) => nodes.splice(Math.floor(r() * (nodes.length + 1)), 0, n);
  const throughKnots = (from: { id: string; handle: string }): { id: string; handle: string } => {
    let cur = from;
    const chain = 1 + Math.floor(r() * 3);
    for (let i = 0; i < chain; i++) {
      const id = `k${k++}`;
      insert(makeKnot(id));
      feeding.push(makeEdge(cur.id, cur.handle, id, 'in'));
      cur = { id, handle: 'out' };
    }
    return cur;
  };
  for (const e of g.edges) {
    const mode = Math.floor(r() * 4);
    let from = { id: e.source, handle: e.sourceHandle ?? 'out' };
    if (mode === 0) {
      edges.push(e);
      standIn.set(e.id, e);
      continue;
    }
    if (mode === 1 || mode === 3) from = throughKnots(from);
    if (mode >= 2) {
      const key = `${from.id}\0${from.handle}`;
      let portal = portals.get(key);
      if (!portal) {
        portal = { inId: `p${k++}`, exits: [] };
        insert(makeTunnelIn(portal.inId, `portal ${portals.size + 1}`));
        feeding.push(makeEdge(from.id, from.handle, portal.inId, 'in'));
        portals.set(key, portal);
      }
      let exit = portal.exits.length > 0 && r() < 0.5 ? pick(portal.exits, r) : null;
      if (!exit) {
        exit = `x${k++}`;
        insert(makeTunnelOut(exit, portal.inId));
        portal.exits.push(exit);
      }
      from = { id: exit, handle: 'out' };
    }
    const wire = makeEdge(from.id, from.handle, e.target, e.targetHandle ?? 'in');
    edges.push(wire);
    standIn.set(e.id, wire);
  }
  return { nodes, edges: [...edges, ...feeding], standIn };
}
const pick = <T,>(xs: readonly T[], r: () => number): T => xs[Math.floor(r() * xs.length)];

const realIds = (ids: ReadonlySet<string> | null, nodes: AppNode[]) => {
  if (!ids) return null;
  const pass = new Set(nodes.filter(isPassThroughNode).map((n) => n.id));
  return [...ids].filter((id) => !pass.has(id)).sort();
};

describe('byte-stability: a pass-through computes nothing', () => {
  const T = 0.37;
  it.each(Array.from({ length: 60 }, (_, i) => i + 1))('random graph #%i', (seed) => {
    const r = rng(seed * 7919);
    const direct = randomGraph(r);
    const pt = withPassThroughs(direct, r);
    // Every seed here does replace something (the sweep is not vacuous).
    expect(pt.nodes.some(isPassThroughNode)).toBe(true);

    // The TSL text, byte for byte, and the names.
    const a = graphToCode(direct.nodes, direct.edges, NODE_REGISTRY);
    const b = graphToCode(pt.nodes, pt.edges, NODE_REGISTRY);
    expect(b.code).toBe(a.code);
    expect([...b.varNames].sort()).toEqual([...a.varNames].sort());
    expect(panelCodegen(pt.nodes, pt.edges, false).result.code).toBe(panelCodegen(direct.nodes, direct.edges, false).result.code);

    // Every wire value as the canvas reads it (TypedEdge: the unwrapped edge BY ID).
    for (const e of direct.edges) {
      const wire = pt.standIn.get(e.id)!;
      const un = getUnwrappedEdge(pt.nodes, pt.edges, wire.id);
      const before = evaluateEdgeSource(e, direct.nodes, direct.edges, T);
      if (!un) {
        // Only a wire the shader does not read either (e.g. a dead Split socket).
        expect(getUnwrappedEdge(direct.nodes, direct.edges, e.id)).toBeUndefined();
        continue;
      }
      expect(evaluateEdgeSource(un, pt.nodes, pt.edges, T)).toEqual(before);
      expect(evaluateEdgeRange(un, pt.nodes, pt.edges, T)).toEqual(evaluateEdgeRange(e, direct.nodes, direct.edges, T));
    }
    for (const n of direct.nodes) {
      expect(evaluateNodeOutput(n.id, pt.nodes, pt.edges, T)).toEqual(evaluateNodeOutput(n.id, direct.nodes, direct.edges, T));
    }

    // Cost: rendered and whole-canvas.
    expect(computeReachableCost(pt.nodes, unwrapCollapsedGroupEdges(pt.nodes, pt.edges))).toBe(
      computeReachableCost(direct.nodes, unwrapCollapsedGroupEdges(direct.nodes, direct.edges)),
    );
    expect(computeGraphCost(pt.nodes, unwrapCollapsedGroupEdges(pt.nodes, pt.edges))).toBe(
      computeGraphCost(direct.nodes, unwrapCollapsedGroupEdges(direct.nodes, direct.edges)),
    );

    // What feeds an Output, pass-throughs aside.
    expect(realIds(feedsAnOutputIds(pt.nodes, pt.edges), pt.nodes)).toEqual(realIds(feedsAnOutputIds(direct.nodes, direct.edges), direct.nodes));
    expect(realIds(feedsAnOutputIds(pt.nodes, pt.edges, { bypassMuted: true }), pt.nodes)).toEqual(
      realIds(feedsAnOutputIds(direct.nodes, direct.edges, { bypassMuted: true }), direct.nodes),
    );
  });
});

/** f → k → in1 ⇢ o1 → add.a, o1 → mul.b, add → mul.a → out, and an unwired cos. */
function portalBoard(): Graph {
  return {
    nodes: [
      makeNode('f', 'float', { value: 0.5 }),
      makeKnot('k'),
      makeTunnelIn('in1', 'f1'),
      makeTunnelOut('o1', 'in1'),
      makeNode('t', 'time'),
      makeNode('add', 'add'),
      makeNode('mul', 'mul'),
      makeNode('out', 'output'),
      makeNode('lone', 'cos'),
    ],
    edges: [
      makeEdge('f', 'out', 'k', 'in'),
      makeEdge('k', 'out', 'in1', 'in'),
      makeEdge('o1', 'out', 'add', 'a'),
      makeEdge('t', 'out', 'add', 'b'),
      makeEdge('add', 'out', 'mul', 'a'),
      makeEdge('o1', 'out', 'mul', 'b'),
      makeEdge('mul', 'out', 'out', 'color'),
    ],
  };
}

describe('EXPORT keeps the portal', () => {
  it('the pruned file holds every pass-through on the path, and its module is the in-app one', () => {
    const g = portalBoard();
    const code = panelCodegen(g.nodes, g.edges, false).result.code;
    const plan = planExportGraph({ ...g, code }, 'connected');
    expect(plan.omitted).toBe(1);
    expect(plan.nodes.map((n) => n.id)).toEqual(['f', 'k', 'in1', 'o1', 't', 'add', 'mul', 'out']);
    expect(plan.edges).toEqual(g.edges);
    expect(plan.code).toBe(code);
  });

  it('keeps an exit’s entrance even when nothing else reaches it, and drops a side branch', () => {
    const g = portalBoard();
    // A side branch off the Branch into the unwired cos: not part of the file.
    g.edges.push(makeEdge('k', 'out', 'lone', 'x'));
    const pruned = pruneToConnected(g.nodes, g.edges);
    expect(pruned.nodes.some((n) => n.id === 'in1')).toBe(true);
    expect(pruned.edges.some((e) => e.target === 'lone')).toBe(false);
    // An unconnected portal is left out whole.
    const extra = { nodes: [...g.nodes, makeTunnelIn('in2'), makeTunnelOut('o2', 'in2')], edges: [...g.edges] };
    const pruned2 = pruneToConnected(extra.nodes, extra.edges);
    expect(pruned2.nodes.some((n) => n.id === 'in2' || n.id === 'o2')).toBe(false);
  });
});

/** The panel's text and scope, as the graph→code pass writes them. */
function panel(g: Graph) {
  const { result, emitted } = panelCodegen(g.nodes, g.edges, false);
  return { code: result.code, emitted, names: emitted ? result.varNames : null };
}

/** doCodeSync's pairing and carry, in its order (cf. panelCarry.test.ts), with
 *  the group-only view and the pass-through twin. */
function apply(old: Graph, code: string, scope: ReturnType<typeof panel>): Graph {
  const parsed = codeToGraph(code);
  expect(parsed.errors.filter((e) => e.severity !== 'warning')).toEqual([]);
  const realOldEdges = unwrapCollapsedGroupEdges(old.nodes, old.edges);
  const groupOldEdges = unwrapGroupsOnly(old.nodes, old.edges);
  const carriedIds = panelCarryIds(old.nodes, scope.emitted);
  const names = scope.emitted !== null ? scope.names : null;
  const pairing = pairResyncNodes(old.nodes, parsed.nodes, activeSink(old.nodes, realOldEdges)?.id ?? null, carriedIds, names);
  const idMap = new Map<string, string>();
  const positioned: AppNode[] = [];
  for (const { node, match } of pairing.paired) {
    idMap.set(node.id, match.id);
    positioned.push({ ...node, id: match.id, position: { ...match.position } } as AppNode);
  }
  const unpositioned = [...pairing.unpaired];
  const parsedEdges = parsed.edges.map((e) => {
    const source = idMap.get(e.source) ?? e.source;
    const target = idMap.get(e.target) ?? e.target;
    return { ...e, source, target, id: `e-${source}-${e.sourceHandle ?? 'out'}-${target}-${e.targetHandle ?? 'out'}` };
  });
  const all = [...positioned, ...unpositioned];
  const feederOf = panelFeederResolver(old.nodes, all, names);
  const hidden = carryPanelHidden(old.nodes, groupOldEdges, carriedIds, feederOf, unpositioned.length > 0);
  let edges = restoreMutedOutWires(old.nodes, groupOldEdges, realOldEdges, carriedIds, feederOf, all, [...parsedEdges, ...hidden.edges], unpositioned.length > 0);
  edges = restorePassThroughOutWires(old.nodes, groupOldEdges, realOldEdges, carriedIds, feederOf, all, edges, unpositioned.length > 0);
  let nodes = [...all, ...hidden.nodes];
  if (scope.emitted !== null) nodes = inOldOrder(nodes, old.nodes);
  return { nodes, edges };
}

const tuple = (e: AppEdge) => `${e.source}.${e.sourceHandle} → ${e.target}.${e.targetHandle}`;
const wires = (g: Graph) => g.edges.map(tuple).sort();
const oneWirePerSocket = (g: Graph) => {
  const sockets = g.edges.map((e) => `${e.target}\0${e.targetHandle}`);
  expect(new Set(sockets).size).toBe(sockets.length);
};

describe('Apply carries the pass-throughs', () => {
  it('an unchanged Apply leaves the graph as it was', () => {
    const g = portalBoard();
    const p = panel(g);
    expect(p.emitted && [...p.emitted].some((id) => isPassThroughNode(g.nodes.find((n) => n.id === id)))).toBe(false);
    const after = apply(g, p.code, p);
    expect(after.nodes.map((n) => n.id).sort()).toEqual(g.nodes.map((n) => n.id).sort());
    for (const n of g.nodes.filter(isPassThroughNode)) expect(after.nodes.find((m) => m.id === n.id)).toEqual(n);
    expect(wires(after)).toEqual(wires(g));
    expect(after.edges.map((e) => e.id).sort()).toEqual(g.edges.map((e) => e.id).sort());
    oneWirePerSocket(after);
    expect(panel(after).code).toBe(p.code);
  });

  it('a text rewire keeps the text’s wire and drops the exit’s, never two wires into one input', () => {
    const g = portalBoard();
    const p = panel(g);
    const f = p.names?.get('f');
    expect(f).toBeTruthy();
    // add's A read the float through the portal; read a literal instead.
    const edited = p.code.replace(new RegExp(`add\\(${f}\\b`), 'add(float(2)');
    expect(edited).not.toBe(p.code);
    const after = apply(g, edited, p);
    expect(after.edges.some((e) => e.source === 'o1' && e.target === 'add')).toBe(false);
    expect(after.edges.some((e) => e.source === 'o1' && e.target === 'mul')).toBe(true);
    oneWirePerSocket(after);
  });

  it('a broken exit comes back only to a socket the text leaves unwired', () => {
    const g = portalBoard();
    g.nodes.push(makeTunnelOut('broken', 'gone'), makeNode('s', 'sin'));
    g.edges.push(makeEdge('broken', 'out', 's', 'x'), makeEdge('s', 'out', 'out', 'emissive'));
    const p = panel(g);
    const after = apply(g, p.code, p);
    expect(wires(after)).toEqual(wires(g));
    oneWirePerSocket(after);
  });

  // A MUTED node feeding a pass-through: folded, the Branch's / Portal Out's
  // wire OUT names the muted node, so the muted twin must leave it to the
  // pass-through twin rather than put back a direct wire from the muted node.
  it.each(['branch', 'portal'] as const)('an unchanged Apply keeps a %s fed by a MUTED node', (kind) => {
    const sin = makeNode('m', 'sin');
    const m = { ...sin, data: { ...sin.data, muted: true } } as AppNode;
    const g: Graph =
      kind === 'branch'
        ? {
            nodes: [makeNode('f', 'float', { value: 0.5 }), m, makeKnot('k'), makeNode('mul', 'mul'), makeNode('out', 'output')],
            edges: [
              makeEdge('f', 'out', 'm', 'x'),
              makeEdge('m', 'out', 'k', 'in'),
              makeEdge('k', 'out', 'mul', 'a'),
              makeEdge('mul', 'out', 'out', 'color'),
            ],
          }
        : {
            nodes: [
              makeNode('f', 'float', { value: 0.5 }),
              m,
              makeTunnelIn('in1', 'p'),
              makeTunnelOut('o1', 'in1'),
              makeNode('mul', 'mul'),
              makeNode('out', 'output'),
            ],
            edges: [
              makeEdge('f', 'out', 'm', 'x'),
              makeEdge('m', 'out', 'in1', 'in'),
              makeEdge('o1', 'out', 'mul', 'a'),
              makeEdge('mul', 'out', 'out', 'color'),
            ],
          };
    const p = panel(g);
    const after = apply(g, p.code, p);
    expect(wires(after)).toEqual(wires(g));
    oneWirePerSocket(after);
    expect(panel(after).code).toBe(p.code);
  });

  it('a graph with NO sink keeps its pass-throughs and their wires', () => {
    const g: Graph = {
      nodes: [makeNode('f', 'float', { value: 0.5 }), makeKnot('k'), makeTunnelIn('in1'), makeTunnelOut('o1', 'in1'), makeNode('s', 'sin')],
      edges: [makeEdge('f', 'out', 'k', 'in'), makeEdge('k', 'out', 'in1', 'in'), makeEdge('o1', 'out', 's', 'x')],
    };
    const p = panel(g);
    expect(p.emitted).not.toBeNull();
    expect([...p.emitted!].sort()).toEqual(['f', 's']);
    const after = apply(g, p.code, p);
    expect(after.nodes.filter(isPassThroughNode).map((n) => n.id).sort()).toEqual(['in1', 'k', 'o1']);
    // The parse of a sink-less text adds the Output its `return` describes (as
    // it does with no pass-through); every wire of the old graph is back.
    const old = new Set(g.nodes.map((n) => n.id));
    expect(wires({ nodes: [], edges: after.edges.filter((e) => old.has(e.source) && old.has(e.target)) })).toEqual(wires(g));
    oneWirePerSocket(after);
  });
});

describe('a card mounts every socket a wire is DRAWN into', () => {
  // The fold drops a wire from an unfed Branch or a broken Portal Out (the
  // shader reads the socket unwired), but an operand socket that is not
  // MOUNTED leaves that wire in the store drawing nothing.
  const board = (): Graph => ({
    nodes: [makeNode('f', 'float'), makeNode('g', 'float'), makeKnot('k'), makeTunnelOut('x', 'gone'), makeNode('add', 'add')],
    edges: [
      makeEdge('f', 'out', 'add', 'a'),
      makeEdge('g', 'out', 'add', 'b'),
      makeEdge('k', 'out', 'add', 'c'),
      makeEdge('x', 'out', 'add', 'd'),
    ],
  });

  it('the drawn list holds the folded-away wires; the folded one (labels, shader) does not', () => {
    const g = board();
    const handles = (es: AppEdge[]) => es.map((e) => e.targetHandle as string);
    expect(handles(getTargetEdges(g.nodes, g.edges, 'add'))).toEqual(['a', 'b']);
    const drawn = handles(getDrawnTargetEdges(g.nodes, g.edges, 'add'));
    expect(drawn).toEqual(['a', 'b', 'c', 'd']);
    // At rest (no trailing grow slot) every drawn operand still mounts.
    expect(effectiveInputs(NODE_REGISTRY.get('add')!, drawn, false).map((p) => p.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('is the folded array itself when no wire touches a pass-through', () => {
    const g = board();
    const direct = { nodes: g.nodes.filter((n) => !isPassThroughNode(n)), edges: g.edges.slice(0, 2) };
    expect(getDrawnTargetEdges(direct.nodes, direct.edges, 'add')).toBe(getTargetEdges(direct.nodes, direct.edges, 'add'));
  });

  it('ShaderNode mounts operand sockets from the drawn list', () => {
    const src = readFileSync(fileURLToPath(new URL('../components/NodeEditor/nodes/ShaderNode.tsx', import.meta.url)), 'utf8');
    const calls = [...src.matchAll(/effectiveInputs\(\s*effDef,\s*(\w+)/g)].map((m) => m[1]);
    expect(calls.length).toBeGreaterThan(0);
    expect(new Set(calls)).toEqual(new Set(['mountedHandleList']));
    expect(src).toMatch(/getDrawnTargetEdges\(allNodes, allEdges, id\)/);
  });
});

describe('a saved group re-links its exits only to a live Portal In', () => {
  beforeEach(() => {
    cancelPendingGraphSave();
    useAppStore.setState({ nodes: [], edges: [], past: [], future: [], savedGroups: [], ...HISTORY_IDLE });
  });
  afterAll(() => {
    cancelPendingGraphSave();
    useAppStore.setState({ nodes: [], edges: [], past: [], future: [], savedGroups: [] });
  });

  it('keeps a link to a live entrance, follows one that came along, clears the rest', () => {
    const frame = {
      id: 'g',
      type: 'group',
      position: { x: 0, y: 0 },
      width: 200,
      height: 120,
      data: { registryType: 'group', label: 'g', color: '#dde', width: 200, height: 120 },
    } as unknown as AppNode;
    const member = (n: AppNode) => ({ ...n, parentId: 'g' }) as AppNode;
    useAppStore.setState({
      nodes: [makeTunnelIn('liveIn')],
      savedGroups: [
        {
          id: 'sg',
          name: 'g',
          color: '#dde',
          nodes: [
            frame,
            member(makeTunnelIn('ownIn')),
            member(makeTunnelOut('a', 'liveIn')),
            member(makeTunnelOut('b', 'ownIn')),
            member(makeTunnelOut('c', 'deletedIn')),
          ],
          edges: [],
        },
      ],
    });
    useAppStore.getState().instantiateSavedGroup('sg', { x: 0, y: 0 });
    const nodes = useAppStore.getState().nodes;
    const ownCopy = nodes.find((n) => n.type === 'tunnelIn' && n.id !== 'liveIn')!;
    const exits = nodes.filter(isTunnelOut).map((n) => (n.data as Record<string, unknown>).link);
    expect(exits).toEqual(['liveIn', ownCopy.id, undefined]);
    expect(useAppStore.getState().past).toHaveLength(1);
  });
});
