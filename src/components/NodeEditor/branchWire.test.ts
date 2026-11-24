/**
 * The Branch gestures (docs/dev/canvas-interaction.md, "Branch"): putting a
 * Branch into a wire on its drawn curve — a double-click on the wire, or the
 * Add-node menu's Branch row — the array index the split writes, the one
 * connect a Branch refuses, and taking a Branch back out by Delete / X /
 * double-click. Routing points were removed (owner, 2026-11-24): nothing here
 * carries or splits one any more.
 */
import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { Position, type InternalNode } from '@xyflow/react';
import type { AppNode } from '@/types';
import { HISTORY_IDLE, makeKnot, makeNode } from '@/test-utils';
import { cancelPendingGraphSave, useAppStore } from '@/store/useAppStore';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { graphToCode } from '@/engine/graphToCode';
import { bridgeEdgesAcrossDeletedNodes, makeTypedEdge, unwrapCollapsedGroupEdges } from '@/utils/edgeUtils';
import { edgeBezier, nearestOnSegments } from './edges/bezierGeometry';
import { branchRefusal, feedsFedKnot, makeKnotNode, splitEdgeWithKnot } from './branchWire';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { branchIntoWireAt, finishReconnect, removeBranch, startReconnect } from './branchActions';
import { branchSpotOnWire, type GetInternalNode } from './edgeHit';
import { KNOT_SIZE } from './nodes/passThroughGeometry';
import { branchMatchesQuery, branchNameMatchesQuery, BRANCH_DESCRIPTION, BRANCH_TOOLTIP } from './branchSearch';

const P = (x: number, y: number) => ({ x, y });
const read = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf8');

describe('the nearest point of the drawn curve', () => {
  it('is ON the curve', () => {
    const segs = [edgeBezier(0, 0, Position.Right, 100, 0, Position.Left)];
    const hit = nearestOnSegments(segs, 40, 30)!;
    expect(hit.y).toBeCloseTo(0, 6);
    expect(hit.x).toBeCloseTo(40, 1);
    expect(nearestOnSegments([], 0, 0)).toBeNull();
  });
});

describe('splitEdgeWithKnot — the array index', () => {
  const a = makeTypedEdge('s', 'out', 't', 'a');
  const b = makeTypedEdge('u', 'out', 't', 'b');
  const c = makeTypedEdge('s', 'out', 'v', 'x');

  it('writes the consumer side at the OLD index, the feed right after it', () => {
    const out = splitEdgeWithKnot([b, a, c], a.id, 'k')!;
    expect(out.map((e) => `${e.source}>${e.target}`)).toEqual(['u>t', 'k>t', 's>k', 's>v']);
    expect(out[1]).toMatchObject({ sourceHandle: 'out', targetHandle: 'a', data: { dataType: 'any' } });
    expect(out[2]).toMatchObject({ sourceHandle: 'out', targetHandle: 'in', data: { dataType: 'any' } });
    expect(splitEdgeWithKnot([b], a.id, 'k')).toBeNull();
  });

  it('folded through the Branch, the edge list reads exactly as before', () => {
    const nodes = [makeNode('s', 'float'), makeNode('u', 'float'), makeNode('t', 'add'), makeNode('v', 'sin'), makeKnot('k')];
    const out = splitEdgeWithKnot([b, a, c], a.id, 'k')!;
    const folded = unwrapCollapsedGroupEdges(nodes, out);
    expect(folded.map((e) => [e.source, e.sourceHandle, e.target, e.targetHandle])).toEqual(
      [b, a, c].map((e) => [e.source, e.sourceHandle, e.target, e.targetHandle]),
    );
  });
});

describe('branchRefusal', () => {
  const nodes: AppNode[] = [makeNode('s', 'float'), makeNode('m', 'sin'), makeNode('t', 'add')];
  const sm = makeTypedEdge('s', 'out', 'm', 'x');

  it('lets a Branch into any visible wire', () => {
    expect(branchRefusal(nodes, [sm], sm.id)).toBeNull();
  });

  it('refuses a missing or hidden wire, and a collapsed pill', () => {
    expect(branchRefusal(nodes, [sm], 'nope')).toBe('missing');
    expect(branchRefusal(nodes, [{ ...sm, hidden: true }], sm.id)).toBe('hidden');
    const g = { id: 'g', type: 'group', position: P(0, 0), data: { label: 'g' } } as unknown as AppNode;
    const pill = makeTypedEdge('g', 'gout:0', 't', 'a');
    expect(branchRefusal([...nodes, g], [pill], pill.id)).toBe('group');
  });
});

describe('feedsFedKnot — a fed Branch refuses a second feed, never replaces it', () => {
  const nodes = [makeNode('a', 'float'), makeNode('b', 'float'), makeNode('t', 'sin'), makeKnot('k')];
  const feed = makeTypedEdge('a', 'out', 'k', 'in');
  const fan = makeTypedEdge('k', 'out', 't', 'x');

  it('an UNFED Branch takes a wire into its input', () => {
    expect(feedsFedKnot(nodes, [fan], 'k')).toBe(false);
  });

  it('a FED Branch refuses one', () => {
    expect(feedsFedKnot(nodes, [feed, fan], 'k')).toBe(true);
  });

  it('a reconnect may drop the Branch\'s own feed back on it', () => {
    expect(feedsFedKnot(nodes, [feed, fan], 'k', feed.id)).toBe(false);
  });

  it('asks nothing of any other target: an ordinary input keeps its replace rule', () => {
    expect(feedsFedKnot(nodes, [makeTypedEdge('a', 'out', 't', 'x')], 't')).toBe(false);
    expect(feedsFedKnot(nodes, [feed], null)).toBe(false);
    expect(feedsFedKnot(nodes, [feed], 'gone')).toBe(false);
  });

  it('is the canvas\'s isValidConnection, and the reconnect\'s wire is remembered', () => {
    const src = read('NodeEditor.tsx');
    expect(src).toContain('isValidConnection={isValidConnection}');
    // Through the ONE refusal the reconnect release shares (portalWire.ts).
    expect(src).toContain('!connectionRefused(nodes, edges, connection, reconnectingEdgeRef.current)');
    expect(read('portalWire.ts')).toContain('feedsFedKnot(nodes, edges, c.target, ignoreEdgeId, c.targetHandle)');
    expect(src).toContain('reconnectingEdgeRef.current = edge.id;');
  });
});

/** A fake React Flow internal node: a 100×30 box at (x, y) with an `in`
 *  socket on its left edge and an `out` socket on its right. */
function fakeNode(id: string, x: number, y: number): InternalNode {
  return {
    id,
    type: 'shader',
    position: P(x, y),
    data: {},
    measured: { width: 100, height: 30 },
    internals: {
      positionAbsolute: P(x, y),
      z: 0,
      userNode: {} as never,
      handleBounds: {
        source: [{ id: 'out', type: 'source', nodeId: id, x: 100, y: 10, width: 0, height: 10, position: Position.Right }],
        target: [{ id: 'in', type: 'target', nodeId: id, x: 0, y: 10, width: 0, height: 10, position: Position.Left }],
      },
    },
  } as unknown as InternalNode;
}

describe('branchSpotOnWire — where a Branch goes on one wire', () => {
  const nodes = new Map([['s', fakeNode('s', 0, 0)], ['t', fakeNode('t', 500, 0)]]);
  const get: GetInternalNode = (id) => nodes.get(id);
  // s.out at (100, 15) → t.in at (500, 15): a level wire along y = 15.
  const wire = makeTypedEdge('s', 'out', 't', 'in');

  it('the nearest point of the drawn curve', () => {
    const hit = branchSpotOnWire(wire, P(300, 20), get)!;
    expect(hit.y).toBeCloseTo(15, 0);
    expect(hit.x).toBeCloseTo(300, -1);
  });

  it('a wire that is not DRAWN is no spot: hidden, or into an unmounted socket', () => {
    expect(branchSpotOnWire({ ...wire, hidden: true }, P(300, 15), get)).toBeNull();
    const o = fakeNode('o', 600, 0);
    (o.internals.handleBounds as { target: unknown[] }).target = [
      { id: 'color', type: 'target', nodeId: 'o', x: 0, y: 10, width: 0, height: 10, position: Position.Left },
    ];
    const both = new Map([['s', fakeNode('s', 0, 0)], ['o', o]]);
    expect(branchSpotOnWire(makeTypedEdge('s', 'out', 'o', 'roughness'), P(302, 15), (id) => both.get(id))).toBeNull();
  });
});

describe('the delete splice', () => {
  it('a deleted Branch hands each wire it fed back to the trunk\'s source, at its own index', () => {
    const trunk = makeTypedEdge('s', 'out', 'k', 'in');
    const toT = makeTypedEdge('k', 'out', 't', 'x');
    const toU = makeTypedEdge('k', 'out', 'u', 'x');
    const out = bridgeEdgesAcrossDeletedNodes([toT, trunk, toU], new Set(['k']));
    expect(out.map((e) => `${e.source}>${e.target}`)).toEqual(['s>t', 's>u']);
    expect(out[0].data).toEqual({ dataType: 'any' });
  });

  it('through a CHAIN of Branches the wire reaches the first live source', () => {
    const out = bridgeEdgesAcrossDeletedNodes(
      [makeTypedEdge('s', 'out', 'k1', 'in'), makeTypedEdge('k1', 'out', 'k2', 'in'), makeTypedEdge('k2', 'out', 't', 'x')],
      new Set(['k1', 'k2']),
    );
    expect(out.map((e) => `${e.source}>${e.target}`)).toEqual(['s>t']);
  });

  it('every delete path goes through the one splice', () => {
    expect(read('NodeEditor.tsx')).toMatch(/bridgeEdgesAcrossDeletedNodes\(\s*currentEdges as AppEdge\[\],\s*selectedNodeIds,\s*\)/);
    const store = read('../../store/useAppStore.ts');
    expect(store).toContain('bridgeEdgesAcrossDeletedNodes(state.edges, new Set([nodeId]))');
    expect(store).toContain('bridgeEdgesAcrossDeletedNodes(state.edges, toRemove)');
  });
});

describe('the store gestures', () => {
  const s = makeNode('s', 'float', { value: 0.5 });
  const t = makeNode('t', 'sin');
  const u = makeNode('u', 'add');
  const output = makeNode('o', 'output');
  const wire = makeTypedEdge('s', 'out', 't', 'x');
  const tOut = makeTypedEdge('t', 'out', 'o', 'color');
  const uOut = makeTypedEdge('u', 'out', 'o', 'emissive');
  // s.out at (100, 15) → t.x at (500, 15).
  const internals = new Map([['s', fakeNode('s', 0, 0)], ['t', fakeNode('t', 500, 0)]]);
  (internals.get('t')!.internals.handleBounds as { target: { id: string }[] }).target[0].id = 'x';
  const get: GetInternalNode = (id) => internals.get(id);

  beforeEach(() => {
    cancelPendingGraphSave();
    useAppStore.setState({ nodes: [s, t, u, output], edges: [tOut, wire, uOut], past: [], future: [], ...HISTORY_IDLE });
  });
  afterAll(() => {
    cancelPendingGraphSave();
    useAppStore.setState({ nodes: [], edges: [], past: [], future: [], ...HISTORY_IDLE });
  });

  const code = () => {
    const st = useAppStore.getState();
    return graphToCode(st.nodes, st.edges, NODE_REGISTRY).code;
  };

  it('a double-click on a wire is ONE undo entry, keeps the array index and the code, and undo is exact', () => {
    const before = useAppStore.getState();
    const codeBefore = code();
    const knot = branchIntoWireAt(wire.id, P(300, 40), get)!;
    expect(knot).toBeTruthy();
    const after = useAppStore.getState();
    expect(after.past).toHaveLength(1);
    // On the drawn curve, nearest the double-click.
    const k = after.nodes.find((n) => n.id === knot)!;
    expect(k.position.y + KNOT_SIZE / 2).toBeCloseTo(15, 0);
    expect(k.position.x + KNOT_SIZE / 2).toBeCloseTo(300, -1);
    // The consumer side at the old wire's array index (1), the feed after it.
    expect(after.edges.map((e) => `${e.source}>${e.target}`)).toEqual(['t>o', `${knot}>t`, `s>${knot}`, 'u>o']);
    expect(code()).toBe(codeBefore);
    useAppStore.getState().undo();
    expect(useAppStore.getState().nodes).toEqual(before.nodes);
    expect(useAppStore.getState().edges).toEqual(before.edges);
  });

  it('a wire it cannot take changes nothing and spends no entry', () => {
    expect(branchIntoWireAt('gone', P(300, 15), get)).toBeNull();
    expect(branchIntoWireAt(tOut.id, P(300, 15), get)).toBeNull(); // not drawn: no internals for o
    expect(useAppStore.getState().past).toHaveLength(0);
  });

  it('double-click removes the Branch in ONE entry: every wire out fed from the trunk, at its own index', () => {
    const knot = branchIntoWireAt(wire.id, P(300, 15), get)!;
    // A second wire out, made by connecting TO the Branch from u's input.
    useAppStore.setState({ edges: [...useAppStore.getState().edges, makeTypedEdge(knot, 'out', 'u', 'a')] });
    const pastBefore = useAppStore.getState().past.length;
    expect(removeBranch(knot)).toBe(true);
    const st = useAppStore.getState();
    expect(st.past).toHaveLength(pastBefore + 1);
    expect(st.nodes.some((n) => n.id === knot)).toBe(false);
    expect(st.edges.map((e) => `${e.source}>${e.target}`)).toEqual(['t>o', 's>t', 'u>o', 's>u']);
    expect(code()).toBe(graphToCode(st.nodes, st.edges, NODE_REGISTRY).code);
    // Undo restores the Branch and both its wires exactly.
    const withBranch = st.past[st.past.length - 1];
    useAppStore.getState().undo();
    expect(useAppStore.getState().edges).toEqual(withBranch.edges);
  });

  it('an UNFED Branch removed takes its wires out with it; removeBranch refuses any other node', () => {
    useAppStore.setState({
      nodes: [...useAppStore.getState().nodes, makeKnotNode('lone', P(0, 0))],
      edges: [...useAppStore.getState().edges, makeTypedEdge('lone', 'out', 'u', 'b')],
    });
    expect(removeBranch('s')).toBe(false);
    expect(removeBranch('lone')).toBe(true);
    expect(useAppStore.getState().edges.some((e) => e.source === 'lone')).toBe(false);
  });
});

describe('where a Branch is made, and what it never does', () => {
  beforeEach(() => {
    cancelPendingGraphSave();
    useAppStore.setState({ nodes: [], edges: [], past: [], future: [], ...HISTORY_IDLE });
  });
  afterAll(() => {
    cancelPendingGraphSave();
    useAppStore.setState({ nodes: [], edges: [], past: [], future: [], ...HISTORY_IDLE });
  });

  it('a Branch put into a wire between two members of one group becomes a member', () => {
    const g = { id: 'g', type: 'group', position: P(1000, 1000), data: { label: 'G' } } as unknown as AppNode;
    const s = { ...makeNode('s', 'float'), parentId: 'g', position: P(10, 10) } as AppNode;
    const t = { ...makeNode('t', 'sin'), parentId: 'g', position: P(300, 10) } as AppNode;
    const wire = makeTypedEdge('s', 'out', 't', 'in');
    // Absolute: s at (1010, 1010), t at (1300, 1010); the wire along y = 1025.
    const internals = new Map([['s', fakeNode('s', 1010, 1010)], ['t', fakeNode('t', 1300, 1010)]]);
    const get: GetInternalNode = (id) => internals.get(id);
    useAppStore.setState({ nodes: [g, s, t], edges: [wire] });
    const knot = branchIntoWireAt(wire.id, P(1200, 1025), get)!;
    const k = useAppStore.getState().nodes.find((n) => n.id === knot);
    expect(k?.parentId).toBe('g');
    // Placed relative to the group.
    expect(k!.position.y + KNOT_SIZE / 2).toBeCloseTo(25, 0);
    // A wire leaving the group: the Branch stays at the root.
    const u = { ...makeNode('u', 'sin'), position: P(2000, 1010) } as AppNode;
    internals.set('u', fakeNode('u', 2000, 1010));
    useAppStore.setState({ nodes: [g, s, u], edges: [makeTypedEdge('s', 'out', 'u', 'in')] });
    const k2 = branchIntoWireAt(useAppStore.getState().edges[0].id, P(1500, 1025), get)!;
    expect(useAppStore.getState().nodes.find((n) => n.id === k2)?.parentId).toBeUndefined();
  });

  it('a Branch never drag-connects as a node does, never splices into a wire it is dropped on, and never makes room', () => {
    const src = read('NodeEditor.tsx');
    // The drag preview handles a Branch apart, before drag-connect and the edge light.
    expect(src).toMatch(/if \(isKnot\(rfDragged\)\) \{[\s\S]*?updateBranchDrop\(rfDragged\.id\)[\s\S]*?return;\s*\}/);
    // No drag-connect target, never pushed by a make-room cascade.
    expect(src.match(/other\.type === 'note' \|\| isKnot\(other\)/g)).toHaveLength(1);
    expect(src).toContain("if (n.type === 'group' || n.type === 'note' || isKnot(n)) continue;");
    // Its own drop moves nothing else.
    expect(src).toContain('} else if (!isNote && !isKnot(freshDragged)) {');
    // Drop-on-edge needs a registry def, which a Branch never has.
    expect(src).toContain('if (!isNote && !overNodeBody && def && def.inputs.length > 0 && def.outputs.length > 0) {');
  });

  it('the gestures the owner removed stay removed', () => {
    const editor = read('NodeEditor.tsx');
    // A dragged wire released on a wire makes no Branch; routing points are gone.
    expect(editor).not.toMatch(/findBranchDrop|promoteWaypoint|addEdgeWaypoint/);
    // No Shift+drag gesture on the wire, and no routing-point handles.
    const edge = read('edges/TypedEdge.tsx');
    expect(edge).not.toMatch(/shiftKey|branchActions|EdgeWaypointHandles|waypoints/);
    // A dragged Branch is no splice candidate.
    expect(read('edgeInsert.ts')).not.toMatch(/isKnot|knot/i);
  });

  it('a double-click on a wire and the Add-node menu\'s Branch row are the ways in', () => {
    const editor = read('NodeEditor.tsx');
    expect(editor).toMatch(/const onEdgeDoubleClick = useCallback\([\s\S]*?connection\.inProgress\) return;[\s\S]*?branchIntoWireAt\(/);
    expect(editor).toContain('onEdgeDoubleClick={onEdgeDoubleClick}');
    expect(read('menus/AddNodeMenu.tsx')).toContain('branchIntoWireAt(spliceEdgeId, at, getInternalNode)');
    // The wire's menu has no routing-point rows.
    expect(read('menus/EdgeContextMenu.tsx')).not.toMatch(/t\('Add routing point'|t\('Remove routing point'|t\('Branch from here'/);
  });
});

describe('the Add-node row\'s words', () => {
  it('carries the Also: tail, kept out of the tooltip', () => {
    expect(BRANCH_DESCRIPTION).toMatch(/Also: reroute, split, fork, junction$/);
    expect(BRANCH_TOOLTIP).not.toMatch(/Also/);
  });
  it('is found by its name, its aliases and its Latvian name, diacritic-blind', () => {
    for (const q of ['branch', 'Bra', 'reroute', 'fork', 'junction', 'split', 'sazarojums', 'Sazar', 'add branch']) {
      expect(branchMatchesQuery(q), q).toBe(true);
    }
    for (const q of ['', 'b', 'noise', 'texture']) expect(branchMatchesQuery(q), q).toBe(false);
  });
  it('goes FIRST only for its own name, so an alias leaves Enter to a node match', () => {
    for (const q of ['bra', 'Branch', 'sazar', 'sazarojums']) expect(branchNameMatchesQuery(q), q).toBe(true);
    for (const q of ['b', 'split', 'fork', 'branches please']) expect(branchNameMatchesQuery(q), q).toBe(false);
  });
});

describe('Step 2 review fixes', () => {
  beforeEach(() => {
    cancelPendingGraphSave();
    useAppStore.setState({ nodes: [], edges: [], past: [], future: [], ...HISTORY_IDLE });
    // A collapse rewires its pill a FRAME later; run that frame at once.
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  afterAll(() => {
    cancelPendingGraphSave();
    useAppStore.setState({ nodes: [], edges: [], past: [], future: [], ...HISTORY_IDLE });
  });

  /** a → Branch k → t.x, with k and t grouped and the group collapsed. */
  const collapsedBranchGraph = () => {
    const a = makeNode('a', 'float');
    const b = makeNode('b', 'float');
    const t = makeNode('t', 'sin');
    const k = makeKnot('k');
    useAppStore.setState({
      nodes: [a, b, t, k],
      edges: [makeTypedEdge('a', 'out', 'k', 'in'), makeTypedEdge('k', 'out', 't', 'x')],
    });
    const gid = useAppStore.getState().groupSelection(['k', 't'])!;
    useAppStore.getState().toggleGroupCollapsed(gid);
    return gid;
  };

  it('F3: a fed Branch behind a collapsed pill\'s input socket refuses a second feed', () => {
    const gid = collapsedBranchGraph();
    const { nodes, edges } = useAppStore.getState();
    const trunk = edges.find((e) => e.target === gid)!;
    expect(trunk.targetHandle).toBe('__in_k_in');
    expect(feedsFedKnot(nodes, edges, gid, null, '__in_k_in')).toBe(true);
    // …the trunk itself may be dropped back where it was,
    expect(feedsFedKnot(nodes, edges, gid, trunk.id, '__in_k_in')).toBe(false);
    // …and a pill socket that is no Branch keeps the replace rule.
    expect(feedsFedKnot(nodes, edges, gid, null, '__in_t_x')).toBe(false);
    expect(feedsFedKnot(nodes, edges, gid, null, 'nonsense')).toBe(false);
    expect(read('portalWire.ts')).toContain('c.targetHandle');
  });

  it('F2 (QA): a Branch\'s exit on a collapsed pill is named after what it carries', () => {
    const n = makeNode('n', 'float');
    const sub = makeNode('sub', 'sub');
    const mix = makeNode('mix', 'mix');
    useAppStore.setState({
      nodes: [n, sub, mix, makeKnot('k')],
      edges: [
        makeTypedEdge('n', 'out', 'k', 'in'),
        makeTypedEdge('k', 'out', 'sub', 'a'),
        makeTypedEdge('k', 'out', 'mix', 't'),
      ],
    });
    const gid = useAppStore.getState().groupSelection(['n', 'k', 'sub'])!;
    useAppStore.getState().toggleGroupCollapsed(gid);
    const g = useAppStore.getState().nodes.find((x) => x.id === gid)!;
    const outs = (g.data as { collapsedOutputs: { originalNodeId: string; name?: string }[] }).collapsedOutputs;
    const branchExit = outs.find((s) => s.originalNodeId === 'k')!;
    expect(branchExit.name).toBe('n');
    // …and TYPED after what it carries, never `any` (a Branch has no port).
    expect((branchExit as { dataType?: string }).dataType).toBe('float');
  });

  it('a pill socket into a Branch is typed after what feeds it', () => {
    useAppStore.setState({
      nodes: [makeNode('v', 'vec3'), makeKnot('k'), makeNode('sub', 'sub')],
      edges: [makeTypedEdge('v', 'out', 'k', 'in'), makeTypedEdge('k', 'out', 'sub', 'a')],
    });
    const gid = useAppStore.getState().groupSelection(['k', 'sub'])!;
    useAppStore.getState().toggleGroupCollapsed(gid);
    const g = useAppStore.getState().nodes.find((x) => x.id === gid)!;
    const ins = (g.data as { collapsedInputs: { originalNodeId: string; dataType: string }[] }).collapsedInputs;
    expect(ins.find((s) => s.originalNodeId === 'k')?.dataType).toBe('vec3');
  });

  it('F1: a reconnect released on a FED Branch keeps the wire and spends no undo entry', () => {
    const s = makeNode('s', 'float');
    const o = makeNode('o', 'output');
    const wire = makeTypedEdge('s', 'out', 'o', 'color');
    const seeded = { nodes: [], edges: [], drawings: [], shaderPalettes: [] } as never;
    useAppStore.setState({
      nodes: [makeNode('a', 'float'), s, o, makeKnot('k')],
      edges: [makeTypedEdge('a', 'out', 'k', 'in'), wire],
      future: [seeded],
    });
    const before = useAppStore.getState();
    const mark = startReconnect(wire.id);
    expect(useAppStore.getState().past.length).toBe(1);
    const outcome = finishReconnect(mark, false, {
      isValid: false,
      toHandle: { nodeId: 'k', id: 'in', type: 'target' },
    });
    const after = useAppStore.getState();
    expect(outcome).toBe('kept');
    expect(after.edges).toBe(before.edges);
    expect(after.past).toBe(before.past);
    expect(after.future).toBe(before.future);
  });

  it('F1: released on empty canvas (or an ordinary refused socket) the reconnect still disconnects', () => {
    const wire = makeTypedEdge('s', 'out', 'o', 'color');
    useAppStore.setState({ nodes: [makeNode('s', 'float'), makeNode('o', 'output')], edges: [wire] });
    const mark = startReconnect(wire.id);
    expect(finishReconnect(mark, false, { isValid: null, toHandle: null })).toBe('removed');
    expect(useAppStore.getState().edges).toHaveLength(0);
    expect(useAppStore.getState().past.length).toBeGreaterThan(0);
    // A reconnect that connected touches nothing more here.
    useAppStore.setState({ edges: [wire] });
    expect(finishReconnect(startReconnect(wire.id), true, { isValid: true, toHandle: null })).toBe('connected');
    expect(useAppStore.getState().edges).toEqual([wire]);
    const editor = read('NodeEditor.tsx');
    expect(editor).toContain('startReconnect(edge.id)');
    expect(editor).toMatch(/finishReconnect\(\s*mark,\s*reconnectSuccessful\.current,\s*connectionState\s*\)/);
  });

  it('F7: Insert node > Branch is not offered on a wire it may not take', () => {
    const add = read('menus/AddNodeMenu.tsx');
    expect(add).toMatch(/branchRefusal\(s\.nodes, s\.edges, spliceEdgeId\) === null/);
    // The Wires section also holds the Portal rows, so it opens on either.
    expect(add).toMatch(/!query\.trim\(\) && \(branchOffered \|\|/);
    expect(add).toContain('{branchOffered && renderBranchRow()}');
  });
});
