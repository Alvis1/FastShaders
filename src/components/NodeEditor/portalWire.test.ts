/**
 * The Portal gestures (docs/dev/canvas-interaction.md, "Portal"): Make portal
 * (placement along the DRAWN wire, the array index, the routing points each
 * end keeps, the name), naming and paste renaming, rename, turn back into
 * wires, delete, the hidden-loop refusal, the trace's ghost lines and the
 * keyboard hop through the hidden link — the pure half (portalWire.ts,
 * utils/portalNames.ts, portalSearch.ts) and the store half (portalActions.ts).
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { Position, type InternalNode } from '@xyflow/react';
import type { AppEdge, AppNode } from '@/types';
import { HISTORY_IDLE, makeKnot, makeNode, makeTunnelIn, makeTunnelOut } from '@/test-utils';
import { cancelPendingGraphSave, useAppStore } from '@/store/useAppStore';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { graphToCode } from '@/engine/graphToCode';
import { autoLayout } from '@/engine/layoutEngine';
import { bridgeEdgesAcrossDeletedNodes, makeTypedEdge, unwrapCollapsedGroupEdges } from '@/utils/edgeUtils';
import { MAX_WAYPOINTS_PER_EDGE } from '@/utils/edgeExtras';
import { topologyEdges, tunnelEntrance } from '@/utils/passThrough';
import {
  PORTAL_NAME_MAX,
  cleanPortalName,
  nextUnnamedPortal,
  renameCopiedEntrances,
  uniquePortalName,
} from '@/utils/portalNames';
import { COLLAPSED_MEMBER_CLASS } from '@/utils/groupFrame';
import type { BezierSegment } from './edges/bezierGeometry';
import { feedsFedKnot } from './branchWire';
import type { GetInternalNode } from './edgeHit';
import { traverseGraph } from './keyboardNav';
import { TUNNEL_SIZE } from './nodes/passThroughGeometry';
import {
  PORTAL_GAP,
  closesHiddenLoop,
  exitIntoMakesLoop,
  ghostLines,
  ghostPath,
  makePortalRefusal,
  portalSourceName,
  portalSpots,
  portalWaypointHalves,
  relinkedExitNodes,
  renamedPortalNodes,
  splitEdgeWithPortal,
  tracedEntrances,
  unportalPlan,
  unportalRefusal,
} from './portalWire';
import {
  addPortalIn,
  addPortalOut,
  makePortal,
  portalOutRefusal,
  relinkExit,
  renamePortal,
  selectWholePortal,
  turnPortalBackIntoWires,
} from './portalActions';
import {
  PORTAL_IN_DESCRIPTION,
  PORTAL_IN_TOOLTIP,
  filterPortalsByName,
  parsePortalList,
  portalListKey,
  portalMatchesQuery,
  portalNameMatchesQuery,
} from './portalSearch';

const P = (x: number, y: number) => ({ x, y });
const at = (n: AppNode, x: number, y: number) => ({ ...n, position: P(x, y) }) as AppNode;
const routed = (e: AppEdge, waypoints: { x: number; y: number }[]): AppEdge => ({
  ...e,
  data: { ...(e.data ?? { dataType: 'any' }), waypoints },
});
const pairs = (edges: readonly AppEdge[]) => edges.map((e) => `${e.source}>${e.target}`);
/** A straight cubic from (x0, y) to (x1, y). */
const line = (x0: number, x1: number, y = 0): BezierSegment => [
  x0, y, x0 + (x1 - x0) / 3, y, x0 + (2 * (x1 - x0)) / 3, y, x1, y,
];

/** A React Flow internal node at (x, y), 100×30, with the named handles. */
function fakeNode(id: string, x: number, y: number, target = 'in', source = 'out'): InternalNode {
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
        source: [{ id: source, type: 'source', nodeId: id, x: 100, y: 10, width: 0, height: 10, position: Position.Right }],
        target: [{ id: target, type: 'target', nodeId: id, x: 0, y: 10, width: 0, height: 10, position: Position.Left }],
      },
    },
  } as unknown as InternalNode;
}

const resetStore = () => {
  cancelPendingGraphSave();
  useAppStore.setState({ nodes: [], edges: [], past: [], future: [], nodeVarNames: Object.create(null), ...HISTORY_IDLE });
};

describe('naming a portal (utils/portalNames.ts)', () => {
  it('is unique: a clash gets " 2", " 3" …, counting on from a number it already has', () => {
    expect(uniquePortalName('perlin1', new Set())).toBe('perlin1');
    expect(uniquePortalName('perlin1', new Set(['perlin1']))).toBe('perlin1 2');
    expect(uniquePortalName('perlin1', new Set(['perlin1', 'perlin1 2']))).toBe('perlin1 3');
    expect(uniquePortalName('perlin1 2', new Set(['perlin1', 'perlin1 2']))).toBe('perlin1 3');
    expect(uniquePortalName('a 9007199254740993', new Set(['a 9007199254740993']))).toBe('a 9007199254740993 2');
  });

  it('a portal with nothing to be named after is "portal 1", "portal 2" …', () => {
    expect(nextUnnamedPortal(new Set())).toBe('portal 1');
    expect(nextUnnamedPortal(new Set(['portal 1', 'portal 3']))).toBe('portal 2');
    expect(uniquePortalName('', new Set(['portal 1']))).toBe('portal 2');
  });

  it('a stored name is text: control characters gone, white space squeezed, capped by code point', () => {
    expect(cleanPortalName('  a\tb\nc d  ')).toBe('a b c d');
    expect(cleanPortalName({ toString: 1 })).toBe('');
    expect(cleanPortalName(Symbol('x'))).toBe('');
    expect(cleanPortalName(7)).toBe('7');
    const long = '🙂'.repeat(PORTAL_NAME_MAX + 5);
    expect(Array.from(cleanPortalName(long))).toHaveLength(PORTAL_NAME_MAX);
    expect(cleanPortalName(long).endsWith('🙂')).toBe(true);
  });

  it('is named after what the canvas header shows, through a Branch, and never after a Portal', () => {
    const s = makeNode('s', 'float');
    const p = makeNode('p', 'property_float', { name: 'speed' });
    const k = makeKnot('k');
    const nodes = [s, p, k, makeKnot('k2')];
    const edges = [makeTypedEdge('s', 'out', 'k', 'in')];
    const names = { s: 'float1', p: 'speed_u' } as Record<string, string>;
    expect(portalSourceName(nodes, edges, names, 's')).toBe('float1');
    expect(portalSourceName(nodes, edges, names, 'p')).toBe('speed');
    expect(portalSourceName(nodes, edges, names, 'k')).toBe('float1');
    expect(portalSourceName(nodes, edges, names, 'k2')).toBe('');
    // An inherited key of the names map is no name.
    expect(portalSourceName([makeNode('constructor', 'float')], [], {}, 'constructor')).toBe('constructor');
  });
});

describe('paste and duplicate', () => {
  const live = [makeTunnelIn('in1', 'perlin1'), makeTunnelOut('out1', 'in1', 'perlin1')];

  it('an entrance alone becomes a NEW portal with a free name', () => {
    const clones = renameCopiedEntrances([makeTunnelIn('c1', 'perlin1')], live);
    expect(clones[0].data.label).toBe('perlin1 2');
  });

  it('an entrance with its exits: a new portal, the copied exits caching its new name', () => {
    const clones = renameCopiedEntrances(
      [makeTunnelIn('c1', 'perlin1'), makeTunnelOut('c2', 'c1', 'perlin1'), makeTunnelIn('c3', 'perlin1')],
      live,
    );
    expect(clones.map((n) => n.data.label)).toEqual(['perlin1 2', 'perlin1 2', 'perlin1 3']);
  });

  it('an exit alone stays an exit of the SAME portal, unchanged — the same array back', () => {
    const exitOnly = [makeTunnelOut('c2', 'in1', 'perlin1')];
    expect(renameCopiedEntrances(exitOnly, live)).toBe(exitOnly);
  });

  it('the paste, duplicate and saved-group paths all rename', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const editor = readFileSync(resolve(__dirname, 'NodeEditor.tsx'), 'utf8');
    expect(editor).toMatch(/renameCopiedEntrances\(remapTunnelLinks\(sourceNodes\.map[\s\S]*?idMap, 'keep'\), store\.nodes\)/);
    const store = readFileSync(resolve(__dirname, '../../store/useAppStore.ts'), 'utf8');
    expect(store).toMatch(/renameCopiedEntrances\(remapTunnelLinks\([\s\S]*?'keep-if-live', live\), live\)/);
  });
});

describe('where Make portal puts the two ends', () => {
  it(`${PORTAL_GAP} flow px along the drawn wire from each socket`, () => {
    const spots = portalSpots([line(0, 500)])!;
    expect(spots.inAt.x).toBeCloseTo(PORTAL_GAP, 0);
    expect(spots.outAt.x).toBeCloseTo(500 - PORTAL_GAP, 0);
    expect(spots.inAt.y).toBeCloseTo(0, 6);
  });

  it('a short wire: a third of the way from each end', () => {
    const spots = portalSpots([line(0, 90)])!;
    expect(spots.inAt.x).toBeCloseTo(30, 0);
    expect(spots.outAt.x).toBeCloseTo(60, 0);
  });

  it('measures ALONG the curve: on a routed wire the arc, not the chord', () => {
    // Up 100, then right 400: 60 along lands on the first, vertical, leg.
    const segs = [[0, 0, 0, -33, 0, -67, 0, -100] as BezierSegment, line(0, 400, -100)];
    const spots = portalSpots(segs)!;
    expect(spots.inSeg).toBe(0);
    expect(spots.inAt.x).toBeCloseTo(0, 4);
    expect(spots.inAt.y).toBeCloseTo(-60, 0);
    expect(spots.outSeg).toBe(1);
    expect(spots.outAt.x).toBeCloseTo(340, 0);
  });

  it('refuses no curve or a non-finite one', () => {
    expect(portalSpots([])).toBeNull();
    expect(portalSpots([[0, 0, NaN, 0, 1, 0, 2, 0]])).toBeNull();
  });

  it('the routing points next to each end stay with it, the middle ones go', () => {
    const wps = [P(1, 0), P(2, 0), P(3, 0), P(4, 0)];
    // Entrance on segment 1 (after point 0), exit on segment 4 (after point 3).
    expect(portalWaypointHalves(wps, 1, 4)).toEqual({ before: [P(1, 0)], after: [] });
    expect(portalWaypointHalves(wps, 0, 3)).toEqual({ before: [], after: [P(4, 0)] });
    expect(portalWaypointHalves(wps, 2, 2)).toEqual({ before: [P(1, 0), P(2, 0)], after: [P(3, 0), P(4, 0)] });
  });

  it('the split writes exit → target at the OLD wire\'s index and source → entrance right after', () => {
    const edges = [makeTypedEdge('a', 'out', 'o', 'color'), makeTypedEdge('s', 'out', 't', 'x'), makeTypedEdge('b', 'out', 'o', 'emissive')];
    const out = splitEdgeWithPortal(edges, edges[1].id, 'IN', 'OUT', [P(1, 1)], [P(2, 2)])!;
    expect(pairs(out)).toEqual(['a>o', 'OUT>t', 's>IN', 'b>o']);
    expect(out[1]).toMatchObject({ sourceHandle: 'out', targetHandle: 'x', data: { waypoints: [P(2, 2)] } });
    expect(out[2]).toMatchObject({ sourceHandle: 'out', targetHandle: 'in', data: { waypoints: [P(1, 1)] } });
    expect(splitEdgeWithPortal(edges, 'gone', 'IN', 'OUT', [], [])).toBeNull();
  });

  it('refuses a wire that already goes into a Portal In or out of a Portal Out', () => {
    const nodes = [makeNode('s', 'float'), makeTunnelIn('i'), makeTunnelOut('x', 'i'), makeNode('t', 'sin')];
    const into = makeTypedEdge('s', 'out', 'i', 'in');
    const outOf = makeTypedEdge('x', 'out', 't', 'x');
    const plain = makeTypedEdge('s', 'out', 't', 'x');
    expect(makePortalRefusal(nodes, [into, outOf, plain], into.id)).toBe('portal');
    expect(makePortalRefusal(nodes, [into, outOf, plain], outOf.id)).toBe('portal');
    expect(makePortalRefusal(nodes, [into, outOf, plain], plain.id)).toBeNull();
    expect(makePortalRefusal(nodes, [], 'gone')).toBe('missing');
  });
});

describe('the store gestures', () => {
  const s = at(makeNode('s', 'float', { value: 0.5 }), 0, 0);
  const t = at(makeNode('t', 'sin'), 500, 0);
  const u = makeNode('u', 'add');
  const o = makeNode('o', 'output');
  const wire = routed(makeTypedEdge('s', 'out', 't', 'x'), [P(150, 15), P(300, 200), P(450, 15)]);
  const tOut = makeTypedEdge('t', 'out', 'o', 'color');
  const uOut = makeTypedEdge('u', 'out', 'o', 'emissive');
  const internals = new Map([['s', fakeNode('s', 0, 0)], ['t', fakeNode('t', 500, 0, 'x')]]);
  const get: GetInternalNode = (id) => internals.get(id);

  beforeEach(() => {
    resetStore();
    useAppStore.setState({ nodes: [s, t, u, o], edges: [tOut, wire, uOut], nodeVarNames: Object.assign(Object.create(null), { s: 'float1' }) });
  });
  afterAll(resetStore);

  const code = () => {
    const st = useAppStore.getState();
    return graphToCode(st.nodes, st.edges, NODE_REGISTRY).code;
  };

  it('Make portal: ONE undo entry, the code unchanged, undo restores the graph exactly', () => {
    const before = useAppStore.getState();
    const codeBefore = code();
    const made = makePortal(wire.id, get)!;
    expect(made).toBeTruthy();
    const st = useAppStore.getState();
    expect(st.past).toHaveLength(1);
    expect(pairs(st.edges)).toEqual(['t>o', `${made.outId}>t`, `s>${made.inId}`, 'u>o']);
    // Named after the source's generated name; the exit caches it.
    const inN = st.nodes.find((n) => n.id === made.inId)!;
    const outN = st.nodes.find((n) => n.id === made.outId)!;
    expect(inN.data.label).toBe('float1');
    expect(outN.data).toMatchObject({ link: made.inId, label: 'float1' });
    // The middle routing point (300, 200) went; the ones by each end stayed.
    expect(st.edges[2].data?.waypoints).toEqual([P(150, 15)]);
    expect(st.edges[1].data?.waypoints).toEqual([P(450, 15)]);
    // Each hole sits on the curve, centred where portalSpots put it.
    expect(inN.position.x + TUNNEL_SIZE / 2).toBeGreaterThan(100);
    expect(code()).toBe(codeBefore);
    useAppStore.getState().undo();
    expect(useAppStore.getState().nodes).toEqual(before.nodes);
    expect(useAppStore.getState().edges).toEqual(before.edges);
  });

  it('a second portal from the same source is named "float1 2"', () => {
    makePortal(wire.id, get);
    const id = addPortalIn(P(0, 0), { nodeId: 's', handleId: 'out' });
    expect(useAppStore.getState().nodes.find((n) => n.id === id)?.data.label).toBe('float1 2');
  });

  it('a refused or undrawn wire changes nothing and spends no entry', () => {
    expect(makePortal(wire.id, () => undefined)).toBeNull();
    expect(makePortal('gone', get)).toBeNull();
    expect(useAppStore.getState().past).toHaveLength(0);
  });

  it('Turn back into wires from either end: ONE entry, the code unchanged, the wire at its old index', () => {
    const made = makePortal(wire.id, get)!;
    // A second exit feeding u.a, so the portal fans out.
    const exit2 = addPortalOut(made.inId, P(0, 300), { nodeId: 'u', handleId: 'a' })!;
    const codeWith = code();
    const pastBefore = useAppStore.getState().past.length;
    expect(turnPortalBackIntoWires(exit2)).toBe(true);
    const st = useAppStore.getState();
    expect(st.past).toHaveLength(pastBefore + 1);
    expect(st.nodes.some((n) => n.type === 'tunnelIn' || n.type === 'tunnelOut')).toBe(false);
    expect(pairs(st.edges)).toEqual(['t>o', 's>t', 'u>o', 's>u']);
    // Source half then target half: the two kept points, nothing where the holes were.
    expect(st.edges[1].data?.waypoints).toEqual([P(150, 15), P(450, 15)]);
    expect(code()).toBe(codeWith);
  });

  it('an UNFED portal turned back simply loses its wires', () => {
    const inId = addPortalIn(P(0, 0));
    addPortalOut(inId, P(0, 0), { nodeId: 'u', handleId: 'b' });
    expect(turnPortalBackIntoWires(inId)).toBe(true);
    expect(pairs(useAppStore.getState().edges)).toEqual(['t>o', 's>t', 'u>o']);
  });

  it('rename: ONE entry, unique, every exit\'s cache in the same write; nothing for no change', () => {
    const made = makePortal(wire.id, get)!;
    const other = addPortalIn(P(0, 0));
    const pastBefore = useAppStore.getState().past.length;
    expect(renamePortal(made.inId, '  speed  ')).toBe(true);
    let st = useAppStore.getState();
    expect(st.past).toHaveLength(pastBefore + 1);
    expect(st.nodes.find((n) => n.id === made.inId)?.data.label).toBe('speed');
    expect(st.nodes.find((n) => n.id === made.outId)?.data.label).toBe('speed');
    expect(renamePortal(made.inId, 'speed')).toBe(false);
    expect(renamePortal(made.inId, '   ')).toBe(false);
    expect(renamePortal(other, 'speed')).toBe(true);
    st = useAppStore.getState();
    expect(st.nodes.find((n) => n.id === other)?.data.label).toBe('speed 2');
    expect(useAppStore.getState().past).toHaveLength(pastBefore + 2);
    // The name never reaches the code.
    const c = code();
    expect(c).not.toContain('speed');
  });

  it('Delete: an exit takes its wires; an entrance leaves its exits BROKEN, and undo restores it', () => {
    const made = makePortal(wire.id, get)!;
    const withPortal = useAppStore.getState();
    useAppStore.getState().removeNode(made.outId);
    expect(pairs(useAppStore.getState().edges)).toEqual(['t>o', `s>${made.inId}`, 'u>o']);
    useAppStore.getState().undo();
    // The sync engine clears this in the app; here the next edit needs it idle.
    useAppStore.setState({ ...HISTORY_IDLE });
    useAppStore.getState().removeNode(made.inId);
    const st = useAppStore.getState();
    const exit = st.nodes.find((n) => n.id === made.outId)!;
    expect(exit).toBeTruthy();
    expect(tunnelEntrance(st.nodes, exit)).toBeNull();
    expect(exit.data.label).toBe('float1');
    // The exit's wire stays drawn; folded, t reads its own unwired value.
    expect(pairs(st.edges)).toEqual(['t>o', `${made.outId}>t`, 'u>o']);
    expect(pairs(unwrapCollapsedGroupEdges(st.nodes, st.edges))).toEqual(['t>o', 'u>o']);
    useAppStore.getState().undo();
    expect(useAppStore.getState().nodes).toEqual(withPortal.nodes);
    expect(useAppStore.getState().edges).toEqual(withPortal.edges);
    // The keyboard Delete path is the same splice.
    expect(pairs(bridgeEdgesAcrossDeletedNodes(withPortal.edges, new Set([made.inId]), withPortal.nodes)))
      .toEqual(['t>o', `${made.outId}>t`, 'u>o']);
  });

  it('Connect to a portal… relinks a broken exit, caching the name, in ONE entry', () => {
    const made = makePortal(wire.id, get)!;
    const other = addPortalIn(P(0, 0), { nodeId: 'u', handleId: 'out' });
    useAppStore.getState().removeNode(made.inId);
    const pastBefore = useAppStore.getState().past.length;
    expect(relinkExit(made.outId, other)).toBe(true);
    const exit = useAppStore.getState().nodes.find((n) => n.id === made.outId)!;
    expect(exit.data).toMatchObject({ link: other, label: 'u' });
    expect(useAppStore.getState().past).toHaveLength(pastBefore + 1);
    expect(relinkExit(made.outId, other)).toBe(false);
  });

  it('Select whole portal selects the entrance and every exit', () => {
    const made = makePortal(wire.id, get)!;
    const exit2 = addPortalOut(made.inId, P(0, 0))!;
    expect(selectWholePortal(exit2)).toBe(true);
    const sel = useAppStore.getState().nodes.filter((n) => n.selected).map((n) => n.id).sort();
    expect(sel).toEqual([made.inId, made.outId, exit2].sort());
  });

  it('a Portal Out into an input upstream of its own entrance is REFUSED (a hidden loop)', () => {
    const made = makePortal(wire.id, get)!;
    // Feed the entrance from u instead: an exit into u's own input would then
    // be a loop that only the hidden link makes.
    useAppStore.setState({ edges: [...useAppStore.getState().edges.filter((e) => e.target !== made.inId), makeTypedEdge('u', 'out', made.inId, 'in')] });
    expect(portalOutRefusal(made.inId, { nodeId: 'u', handleId: 'a' })).toBe('loop');
    expect(addPortalOut(made.inId, P(0, 0), { nodeId: 'u', handleId: 'a' })).toBeNull();
    expect(portalOutRefusal(made.inId, { nodeId: 't', handleId: 'x' })).toBeNull();
  });

  it('a fed Portal In refuses a second feed, like a fed Branch', () => {
    const made = makePortal(wire.id, get)!;
    const { nodes, edges } = useAppStore.getState();
    expect(feedsFedKnot(nodes, edges, made.inId, null, 'in')).toBe(true);
    const lone = addPortalIn(P(0, 0));
    const st = useAppStore.getState();
    expect(feedsFedKnot(st.nodes, st.edges, lone, null, 'in')).toBe(false);
    expect(portalOutRefusal(made.inId, { nodeId: made.inId, handleId: 'in' })).not.toBeNull();
  });
});

describe('pure refusals and rewrites', () => {
  // a → IN ; OUT → b → c
  const nodes = [makeNode('a', 'float'), makeTunnelIn('IN', 'p'), makeTunnelOut('OUT', 'IN', 'p'), makeNode('b', 'sin'), makeNode('c', 'add')];
  const edges = [makeTypedEdge('a', 'out', 'IN', 'in'), makeTypedEdge('OUT', 'out', 'b', 'x'), makeTypedEdge('b', 'out', 'c', 'a')];

  it('closesHiddenLoop: a wire from downstream of the exit back into the entrance\'s feeder', () => {
    // c → a closes a → IN ⇢ OUT → b → c → a, which only the link makes.
    expect(closesHiddenLoop(nodes, edges, 'c', 'a')).toBe(true);
    expect(closesHiddenLoop(nodes, edges, 'a', 'c')).toBe(false);
    const withFeed = [makeNode('f', 'sin'), ...nodes];
    const e2 = [makeTypedEdge('f', 'out', 'a', 'x'), ...edges];
    // c → f would close f → a → IN ⇢ OUT → b → c → f, hidden by the link.
    expect(closesHiddenLoop(withFeed, e2, 'c', 'f')).toBe(true);
    // A loop the drawn wires show keeps today's rule.
    expect(closesHiddenLoop(withFeed, e2, 'c', 'b')).toBe(false);
    // No Portal Out: nothing to ask.
    expect(closesHiddenLoop([makeNode('x', 'sin')], [], 'x', 'x')).toBe(false);
  });

  it('exitIntoMakesLoop: an exit of IN into the feeder of IN', () => {
    expect(exitIntoMakesLoop(nodes, edges, 'IN', 'a')).toBe(true);
    expect(exitIntoMakesLoop(nodes, edges, 'IN', 'c')).toBe(false);
  });

  it('renamedPortalNodes returns null for anything but a live entrance', () => {
    expect(renamedPortalNodes(nodes, 'OUT', 'x')).toBeNull();
    expect(renamedPortalNodes(nodes, 'nope', 'x')).toBeNull();
  });

  it('relinkedExitNodes refuses a link that would close a loop', () => {
    const broken = [...nodes, makeNode('d', 'sin'), makeTunnelOut('X2', 'gone', 'old')];
    const e = [...edges, makeTypedEdge('X2', 'out', 'd', 'x'), makeTypedEdge('d', 'out', 'a', 'x')];
    expect(relinkedExitNodes(broken, e, 'X2', 'IN')).toBeNull();
    const ok = relinkedExitNodes(broken, edges, 'X2', 'IN')!;
    expect(ok.find((n) => n.id === 'X2')?.data).toMatchObject({ link: 'IN', label: 'p' });
  });

  it('turn back refuses a broken exit and a portal inside a collapsed group', () => {
    expect(unportalRefusal([makeTunnelOut('X', 'gone')], 'X')).toBe('broken');
    const hidden = { ...makeTunnelOut('OUT', 'IN'), className: COLLAPSED_MEMBER_CLASS } as AppNode;
    expect(unportalRefusal([nodes[0], nodes[1], hidden], 'IN')).toBe('collapsed');
    expect(unportalPlan([makeTunnelOut('X', 'gone')], [], 'X')).toBeNull();
  });

  it('turn back caps the joined routing points', () => {
    const many = Array.from({ length: MAX_WAYPOINTS_PER_EDGE }, (_, i) => P(i, 0));
    const e = [routed(edges[0], many), routed(edges[1], [P(999, 9)]), edges[2]];
    const plan = unportalPlan(nodes, e, 'OUT')!;
    expect(plan.edges[0].data?.waypoints).toHaveLength(MAX_WAYPOINTS_PER_EDGE);
    expect(pairs(plan.edges)).toEqual(['a>b', 'b>c']);
    expect(plan.removeIds.sort()).toEqual(['IN', 'OUT']);
  });
});

describe('the trace', () => {
  const nodes = [
    { ...makeTunnelIn('IN', 'p'), selected: true } as AppNode,
    makeTunnelOut('O1', 'IN', 'p'),
    { ...makeTunnelOut('O2', 'IN', 'p'), className: COLLAPSED_MEMBER_CLASS } as AppNode,
    makeTunnelIn('IN2', 'q'),
    makeTunnelOut('O3', 'IN2', 'q'),
    makeTunnelOut('BROKEN', 'gone'),
  ];

  it('traces every selected or hovered end\'s entrance; a broken exit traces nothing', () => {
    expect(tracedEntrances(nodes, null)).toEqual(['IN']);
    expect(tracedEntrances(nodes, 'O3')).toEqual(['IN', 'IN2']);
    expect(tracedEntrances(nodes, 'BROKEN')).toEqual(['IN']);
    const none = tracedEntrances(nodes.map((n) => ({ ...n, selected: false }) as AppNode), null);
    expect(none).toHaveLength(0);
    expect(none).toBe(tracedEntrances([], null));
  });

  it('one ghost line per DRAWN exit, entrance centre to exit centre', () => {
    const centres: Record<string, { x: number; y: number }> = { IN: P(0, 0), O1: P(400, 100), O2: P(9, 9), O3: P(1, 1) };
    const lines = ghostLines(nodes, ['IN'], (id) => centres[id] ?? null);
    expect(lines).toEqual([{ entrance: 'IN', exit: 'O1', d: ghostPath(P(0, 0), P(400, 100)) }]);
    expect(ghostLines(nodes, ['IN'], () => null)).toEqual([]);
  });

  it('the ghost path leaves the entrance to the right and reaches the exit from the left', () => {
    expect(ghostPath(P(0, 0), P(400, 100))).toBe('M 0 0 C 200 0 200 100 400 100');
    // Close together: the tangents keep a minimum reach.
    expect(ghostPath(P(0, 0), P(10, 0))).toBe('M 0 0 C 40 0 -30 0 10 0');
  });
});

describe('Cmd/Ctrl+Arrow follows the hidden link', () => {
  const nodes = [
    at(makeNode('a', 'float'), 0, 0),
    at(makeTunnelIn('IN', 'p'), 200, 0),
    at(makeTunnelOut('OUT', 'IN', 'p'), 900, 300),
    at(makeNode('b', 'sin'), 1100, 300),
  ];
  const edges = [makeTypedEdge('a', 'out', 'IN', 'in'), makeTypedEdge('OUT', 'out', 'b', 'x')];

  it('left from an exit reaches its entrance, right from an entrance its exit', () => {
    const topo = topologyEdges(nodes, edges);
    expect(traverseGraph(nodes, topo, 'OUT', 'left')).toBe('IN');
    expect(traverseGraph(nodes, topo, 'IN', 'right')).toBe('OUT');
    expect(traverseGraph(nodes, topo, 'OUT', 'right')).toBe('b');
  });

  it('useKeyboardNav walks the topology view', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    expect(readFileSync(resolve(__dirname, 'useKeyboardNav.ts'), 'utf8'))
      .toContain('traverseGraph(nodes, topologyEdges(nodes, edges), nodeId, dir)');
  });
});

describe('Organize keeps an exit beside what it feeds', () => {
  it('a Portal Out lands one column before its consumer, not in column 0', () => {
    // A long chain a → b1 … b5 → o, and a portal whose exit feeds o's other input.
    const chain = ['a', 'b1', 'b2', 'b3', 'b4', 'b5'];
    const nodes: AppNode[] = [
      ...chain.map((id) => makeNode(id, 'sin')),
      makeNode('o', 'add'),
      makeNode('src', 'float'),
      makeTunnelIn('IN', 'p'),
      makeTunnelOut('OUT', 'IN', 'p'),
    ];
    const edges = [
      ...chain.slice(1).map((id, i) => makeTypedEdge(chain[i], 'out', id, 'x')),
      makeTypedEdge('b5', 'out', 'o', 'a'),
      makeTypedEdge('src', 'out', 'IN', 'in'),
      makeTypedEdge('OUT', 'out', 'o', 'b'),
    ];
    const laid = new Map(autoLayout(nodes, edges).map((n) => [n.id, n.position]));
    const xOut = laid.get('OUT')!.x;
    const xB5 = laid.get('b5')!.x;
    const xA = laid.get('a')!.x;
    expect(xOut).toBeGreaterThan(xA + 200);
    expect(Math.abs(xOut - xB5)).toBeLessThan(150);
  });
});

describe('the Add-node menu\'s portal rows', () => {
  it('names and words find the rows, in both languages, diacritic-blind', () => {
    expect(portalNameMatchesQuery('por')).toBe(true);
    expect(portalNameMatchesQuery('portala ieeja')).toBe(true);
    expect(portalNameMatchesQuery('p')).toBe(false);
    expect(portalMatchesQuery('tunnel')).toBe(true);
    expect(portalMatchesQuery('wireless')).toBe(true);
    expect(portalMatchesQuery('add variable')).toBe(true);
    expect(portalMatchesQuery('multiply')).toBe(false);
    expect(PORTAL_IN_DESCRIPTION).toContain('Also: tunnel, named reroute, send, receive, wireless, variable');
    expect(PORTAL_IN_TOOLTIP).not.toContain('Also:');
  });

  it('the live portals ride one string, read back sorted by name; filtered by folded name', () => {
    const key = portalListKey([makeTunnelIn('b', 'zeta'), makeNode('x', 'sin'), makeTunnelIn('a', 'Ātrums\n"x"')]);
    const list = parsePortalList(key);
    expect(list.map((p) => p.id)).toEqual(['a', 'b']);
    expect(list[0].name).toBe('Ātrums\n"x"');
    expect(filterPortalsByName(list, 'atr').map((p) => p.id)).toEqual(['a']);
    expect(filterPortalsByName(list, '').map((p) => p.id)).toEqual(['a', 'b']);
    expect(filterPortalsByName(list, 'portal').map((p) => p.id)).toEqual(['a', 'b']);
    expect(portalListKey([makeNode('x', 'sin')])).toBe('');
  });
});
