/**
 * The Branch gestures (docs/dev/canvas-interaction.md, "Branch"): putting a
 * Branch into a wire at a routing point or on the drawn curve — only ever
 * from a right-click menu — the array index the split writes, the one connect
 * a Branch refuses, and taking a Branch back out by Delete / X / double-click
 * (the trunk's routing points joined onto each wire it fed).
 */
import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { Position, type InternalNode } from '@xyflow/react';
import type { AppEdge, AppNode } from '@/types';
import { HISTORY_IDLE, makeKnot, makeNode } from '@/test-utils';
import { cancelPendingGraphSave, useAppStore } from '@/store/useAppStore';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { graphToCode } from '@/engine/graphToCode';
import { bridgeEdgesAcrossDeletedNodes, joinWaypoints, makeTypedEdge, unwrapCollapsedGroupEdges } from '@/utils/edgeUtils';
import { MAX_WAYPOINTS_PER_EDGE } from '@/utils/edgeExtras';
import { catmullRomToBeziers, nearestOnSegments } from './edges/bezierGeometry';
import {
  branchRefusal,
  feedsFedKnot,
  makeKnotNode,
  splitEdgeWithKnot,
  splitWaypointsAtIndex,
  splitWaypointsAtSegment,
} from './branchWire';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { branchIntoWireAt, finishReconnect, promoteWaypoint, removeBranch, startReconnect } from './branchActions';
import { branchSpotOnWire, type GetInternalNode } from './edgeHit';
import { KNOT_SIZE } from './nodes/passThroughGeometry';
import { branchMatchesQuery, branchNameMatchesQuery, BRANCH_DESCRIPTION, BRANCH_TOOLTIP } from './branchSearch';

const P = (x: number, y: number) => ({ x, y });
const routed = (e: AppEdge, waypoints: { x: number; y: number }[]): AppEdge => ({
  ...e,
  data: { ...(e.data ?? { dataType: 'any' }), waypoints },
});
const read = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf8');

describe('splitting a wire\'s routing points', () => {
  const wps = [P(1, 1), P(2, 2), P(3, 3), P(4, 4)];

  it('at a KNOWN point: before stays on the source half, after goes to the target half', () => {
    expect(splitWaypointsAtIndex(wps, 2)).toEqual({ at: P(3, 3), before: [P(1, 1), P(2, 2)], after: [P(4, 4)] });
    expect(splitWaypointsAtIndex(wps, 0)).toEqual({ at: P(1, 1), before: [], after: wps.slice(1) });
    expect(splitWaypointsAtIndex(wps, 3)).toEqual({ at: P(4, 4), before: wps.slice(0, 3), after: [] });
  });

  it('refuses an index that is not a point', () => {
    for (const k of [-1, 4, 1.5, Number.NaN]) expect(splitWaypointsAtIndex(wps, k)).toBeNull();
  });

  it('keeps a point lying right beside the split — nothing is dissolved', () => {
    // splitWaypointsAtNode would drop points within reach of a node; a Branch
    // sits exactly where the point was, and its neighbours stay.
    const close = [P(0, 0), P(1, 0), P(2, 0)];
    expect(splitWaypointsAtIndex(close, 1)).toEqual({ at: P(1, 0), before: [P(0, 0)], after: [P(2, 0)] });
  });

  it('on the drawn spline: the segment the nearest point lies on decides', () => {
    const source = P(0, 0);
    const target = P(400, 0);
    const route = [P(100, 100), P(200, 0), P(300, 100)];
    const segs = catmullRomToBeziers([[source.x, source.y], ...route.map((w) => [w.x, w.y] as [number, number]), [target.x, target.y]]);
    // Near the middle of the SECOND segment (100,100 → 200,0).
    const hit = nearestOnSegments(segs, 150, 50)!;
    expect(hit.seg).toBe(1);
    expect(hit.d).toBeLessThan(5);
    expect(splitWaypointsAtSegment(route, hit.seg)).toEqual({ before: [P(100, 100)], after: [P(200, 0), P(300, 100)] });
    // On the first segment, every point goes to the target half; on the last, to the source half.
    expect(splitWaypointsAtSegment(route, nearestOnSegments(segs, 30, 40)!.seg).before).toEqual([]);
    expect(splitWaypointsAtSegment(route, nearestOnSegments(segs, 360, 40)!.seg).after).toEqual([]);
  });

  it('the nearest point is ON the curve', () => {
    const segs = catmullRomToBeziers([[0, 0], [100, 0]]);
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
    const out = splitEdgeWithKnot([b, a, c], a.id, 'k', [P(1, 1)], [P(2, 2)])!;
    expect(out.map((e) => `${e.source}>${e.target}`)).toEqual(['u>t', 'k>t', 's>k', 's>v']);
    expect(out[1]).toMatchObject({ sourceHandle: 'out', targetHandle: 'a', data: { waypoints: [P(2, 2)] } });
    expect(out[2]).toMatchObject({ sourceHandle: 'out', targetHandle: 'in', data: { waypoints: [P(1, 1)] } });
    expect(splitEdgeWithKnot([b], a.id, 'k', [], [])).toBeNull();
  });

  it('folded through the Branch, the edge list reads exactly as before', () => {
    const nodes = [makeNode('s', 'float'), makeNode('u', 'float'), makeNode('t', 'add'), makeNode('v', 'sin'), makeKnot('k')];
    const out = splitEdgeWithKnot([b, a, c], a.id, 'k', [], [])!;
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
    expect(src).toContain('feedsFedKnot(nodes, edges, connection.target, reconnectingEdgeRef.current, connection.targetHandle)');
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

describe('branchSpotOnWire — Insert node > Branch on one wire', () => {
  const nodes = new Map([['s', fakeNode('s', 0, 0)], ['t', fakeNode('t', 500, 0)]]);
  const get: GetInternalNode = (id) => nodes.get(id);
  // s.out at (100, 15) → t.in at (500, 15): a level wire along y = 15.
  const wire = makeTypedEdge('s', 'out', 't', 'in');

  it('on the body: the nearest point of the drawn curve', () => {
    const hit = branchSpotOnWire(wire, P(300, 20), get, 9);
    if (hit?.kind !== 'body') throw new Error('body expected');
    expect(hit.at.y).toBeCloseTo(15, 0);
    expect(hit.at.x).toBeCloseTo(300, -1);
    expect(hit).toMatchObject({ before: [], after: [] });
  });

  it('a routing point under the menu wins over the body, and splits there', () => {
    const r = routed(wire, [P(200, 80), P(400, 80)]);
    expect(branchSpotOnWire(r, P(403, 83), get, 9)).toEqual({ kind: 'point', index: 1 });
    // Between the points, on the body: the segment from point 0 to point 1.
    expect(branchSpotOnWire(r, P(300, 80), get, 9)).toMatchObject({ kind: 'body', before: [P(200, 80)], after: [P(400, 80)] });
  });

  it('a wire that is not DRAWN is no spot: hidden, or into an unmounted socket', () => {
    expect(branchSpotOnWire({ ...wire, hidden: true }, P(300, 15), get, 9)).toBeNull();
    const o = fakeNode('o', 600, 0);
    (o.internals.handleBounds as { target: unknown[] }).target = [
      { id: 'color', type: 'target', nodeId: 'o', x: 0, y: 10, width: 0, height: 10, position: Position.Left },
    ];
    const both = new Map([['s', fakeNode('s', 0, 0)], ['o', o]]);
    const unlit = routed(makeTypedEdge('s', 'out', 'o', 'roughness'), [P(300, 200)]);
    expect(branchSpotOnWire(unlit, P(302, 201), (id) => both.get(id), 9)).toBeNull();
  });
});

describe('joinWaypoints and the delete splice', () => {
  it('joins the trunk\'s points then the wire\'s own, with NO point where the Branch was — capped', () => {
    expect(joinWaypoints([P(1, 1)], [P(3, 3)])).toEqual([P(1, 1), P(3, 3)]);
    expect(joinWaypoints([], [])).toEqual([]);
    const many = Array.from({ length: 50 }, (_, i) => P(i, i));
    const joined = joinWaypoints(many, many.map((w) => P(w.x + 100, w.y)));
    expect(joined).toHaveLength(MAX_WAYPOINTS_PER_EDGE);
    // The points nearest the SOURCE are kept.
    expect(joined[0]).toEqual(P(0, 0));
    expect(joined[50]).toEqual(P(100, 0));
  });

  it('a deleted Branch hands each wire back the trunk\'s points, then its own', () => {
    const k = { ...makeKnot('k'), position: P(200 - KNOT_SIZE / 2, 50 - KNOT_SIZE / 2) } as AppNode;
    const nodes = [makeNode('s', 'float'), makeNode('t', 'sin'), makeNode('u', 'cos'), k];
    const trunk = routed(makeTypedEdge('s', 'out', 'k', 'in'), [P(100, 0)]);
    const toT = routed(makeTypedEdge('k', 'out', 't', 'x'), [P(300, 0)]);
    const toU = makeTypedEdge('k', 'out', 'u', 'x');
    const out = bridgeEdgesAcrossDeletedNodes([toT, trunk, toU], new Set(['k']), nodes);
    expect(out.map((e) => `${e.source}>${e.target}`)).toEqual(['s>t', 's>u']);
    expect(out[0].data?.waypoints).toEqual([P(100, 0), P(300, 0)]);
    expect(out[1].data?.waypoints).toEqual([P(100, 0)]);
    // Without the nodes (every older caller) nothing about the drawing changes.
    expect(bridgeEdgesAcrossDeletedNodes([toT, trunk], new Set(['k']))[0].data?.waypoints).toEqual([P(300, 0)]);
  });

  it('a Branch with no routing points on either side leaves a wire with none', () => {
    const out = bridgeEdgesAcrossDeletedNodes(
      [makeTypedEdge('s', 'out', 'k', 'in'), makeTypedEdge('k', 'out', 't', 'x')],
      new Set(['k']),
      [makeNode('s', 'float'), makeNode('t', 'sin'), makeKnot('k')],
    );
    expect(out).toHaveLength(1);
    expect(out[0].data).toEqual({ dataType: 'any' });
  });

  it('through a CHAIN of Branches every trunk\'s points join, nearest the source first', () => {
    const nodes = [makeNode('s', 'float'), makeNode('t', 'sin'), makeKnot('k1'), makeKnot('k2')];
    const out = bridgeEdgesAcrossDeletedNodes(
      [
        routed(makeTypedEdge('s', 'out', 'k1', 'in'), [P(1, 0)]),
        routed(makeTypedEdge('k1', 'out', 'k2', 'in'), [P(2, 0)]),
        routed(makeTypedEdge('k2', 'out', 't', 'x'), [P(3, 0)]),
      ],
      new Set(['k1', 'k2']),
      nodes,
    );
    expect(out).toHaveLength(1);
    expect(out[0].data?.waypoints).toEqual([P(1, 0), P(2, 0), P(3, 0)]);
  });

  it('a chain through a deleted NON-Branch keeps the wire\'s own points only', () => {
    const out = bridgeEdgesAcrossDeletedNodes(
      [makeTypedEdge('s', 'out', 'm', 'x'), routed(makeTypedEdge('m', 'out', 't', 'x'), [P(5, 5)])],
      new Set(['m']),
      [makeNode('s', 'float'), makeNode('m', 'sin'), makeNode('t', 'cos')],
    );
    expect(out[0].data?.waypoints).toEqual([P(5, 5)]);
  });

  it('every delete path hands the splice the nodes', () => {
    expect(read('NodeEditor.tsx')).toMatch(/bridgeEdgesAcrossDeletedNodes\(\s*currentEdges as AppEdge\[\],\s*selectedNodeIds,\s*currentNodes,\s*\)/);
    const store = read('../../store/useAppStore.ts');
    expect(store).toContain('bridgeEdgesAcrossDeletedNodes(state.edges, new Set([nodeId]), state.nodes)');
    expect(store).toContain('bridgeEdgesAcrossDeletedNodes(state.edges, toRemove, state.nodes)');
  });
});

describe('the store gestures', () => {
  const s = makeNode('s', 'float', { value: 0.5 });
  const t = makeNode('t', 'sin');
  const u = makeNode('u', 'add');
  const output = makeNode('o', 'output');
  const wire = routed(makeTypedEdge('s', 'out', 't', 'x'), [P(100, 0), P(200, 50), P(300, 0)]);
  const tOut = makeTypedEdge('t', 'out', 'o', 'color');
  const uOut = makeTypedEdge('u', 'out', 'o', 'emissive');

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

  it('"Branch from here" is ONE undo entry, leaves the code alone, and undo restores the graph exactly', () => {
    const before = useAppStore.getState();
    const codeBefore = code();
    const knot = promoteWaypoint(wire.id, 1)!;
    expect(knot).toBeTruthy();
    const after = useAppStore.getState();
    expect(after.past).toHaveLength(1);
    expect(after.nodes.find((n) => n.id === knot)?.position).toEqual(P(200 - KNOT_SIZE / 2, 50 - KNOT_SIZE / 2));
    // The consumer side at the old wire's array index (1), the feed after it.
    expect(after.edges.map((e) => `${e.source}>${e.target}`)).toEqual(['t>o', `${knot}>t`, `s>${knot}`, 'u>o']);
    expect(after.edges[1].data?.waypoints).toEqual([P(300, 0)]);
    expect(after.edges[2].data?.waypoints).toEqual([P(100, 0)]);
    expect(code()).toBe(codeBefore);
    useAppStore.getState().undo();
    expect(useAppStore.getState().nodes).toEqual(before.nodes);
    expect(useAppStore.getState().edges).toEqual(before.edges);
  });

  it('a point that is not there promotes nothing and spends no entry', () => {
    expect(promoteWaypoint(wire.id, 7)).toBeNull();
    expect(promoteWaypoint('gone', 0)).toBeNull();
    expect(useAppStore.getState().past).toHaveLength(0);
  });

  it('double-click removes the Branch in ONE entry: every wire out fed from the trunk, at its own index', () => {
    const knot = promoteWaypoint(wire.id, 1)!;
    // A second wire out, made by connecting TO the Branch from u's input.
    useAppStore.setState({ edges: [...useAppStore.getState().edges, makeTypedEdge(knot, 'out', 'u', 'a')] });
    const pastBefore = useAppStore.getState().past.length;
    expect(removeBranch(knot)).toBe(true);
    const st = useAppStore.getState();
    expect(st.past).toHaveLength(pastBefore + 1);
    expect(st.nodes.some((n) => n.id === knot)).toBe(false);
    expect(st.edges.map((e) => `${e.source}>${e.target}`)).toEqual(['t>o', 's>t', 'u>o', 's>u']);
    // The promoted point is gone, as a double-clicked routing point is.
    expect(st.edges[1].data?.waypoints).toEqual([P(100, 0), P(300, 0)]);
    expect(st.edges[3].data?.waypoints).toEqual([P(100, 0)]);
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
  const at = (n: AppNode, x: number, y: number) => ({ ...n, position: P(x, y) }) as AppNode;
  const xs = (e: AppEdge | undefined) => ((e?.data?.waypoints ?? []) as { x: number }[]).map((w) => w.x);

  it('a Branch put into a wire between two members of one group becomes a member', () => {
    const g = { id: 'g', type: 'group', position: P(1000, 1000), data: { label: 'G' } } as unknown as AppNode;
    const s = { ...makeNode('s', 'float'), parentId: 'g', position: P(10, 10) } as AppNode;
    const t = { ...makeNode('t', 'sin'), parentId: 'g', position: P(300, 10) } as AppNode;
    const wire = routed(makeTypedEdge('s', 'out', 't', 'x'), [P(1200, 1060)]);
    useAppStore.setState({ nodes: [g, s, t], edges: [wire] });
    const knot = promoteWaypoint(wire.id, 0)!;
    const k = useAppStore.getState().nodes.find((n) => n.id === knot);
    expect(k?.parentId).toBe('g');
    expect(k?.position).toEqual(P(200 - KNOT_SIZE / 2, 60 - KNOT_SIZE / 2));
    // A wire leaving the group: the Branch stays at the root.
    useAppStore.setState({ nodes: [g, s, at(makeNode('u', 'sin'), 2000, 0)], edges: [routed(makeTypedEdge('s', 'out', 'u', 'x'), [P(1500, 1000)])] });
    const k2 = promoteWaypoint(useAppStore.getState().edges[0].id, 0)!;
    expect(useAppStore.getState().nodes.find((n) => n.id === k2)?.parentId).toBeUndefined();
  });

  describe('Insert node > Branch splits where the menu opened, by the drawn curve', () => {
    const internals = new Map([['s', fakeNode('s', 0, 0)], ['t', fakeNode('t', 500, 0)]]);
    const get: GetInternalNode = (id) => internals.get(id);
    const wire = routed(makeTypedEdge('s', 'out', 't', 'in'), [P(200, 80), P(400, 80)]);
    const seed = () => useAppStore.setState({ nodes: [makeNode('s', 'float'), makeNode('t', 'sin')], edges: [wire] });

    it('on the body: on the curve, every point kept, one entry', () => {
      seed();
      const knot = branchIntoWireAt(wire.id, P(300, 85), get, 1)!;
      const st = useAppStore.getState();
      expect(st.past).toHaveLength(1);
      expect(xs(st.edges.find((e) => e.target === knot))).toEqual([200]);
      expect(xs(st.edges.find((e) => e.source === knot))).toEqual([400]);
      const hit = branchSpotOnWire(wire, P(300, 85), get, 9);
      if (hit?.kind !== 'body') throw new Error('body expected');
      const k = st.nodes.find((n) => n.id === knot)!;
      expect(k.position).toEqual(P(hit.at.x - KNOT_SIZE / 2, hit.at.y - KNOT_SIZE / 2));
    });

    it('on a routing point (the edge menu\'s own on-point test): that point becomes the Branch', () => {
      seed();
      const knot = branchIntoWireAt(wire.id, P(404, 83), get, 1)!;
      const st = useAppStore.getState();
      expect(st.nodes.find((n) => n.id === knot)?.position).toEqual(P(400 - KNOT_SIZE / 2, 80 - KNOT_SIZE / 2));
      expect(xs(st.edges.find((e) => e.target === knot))).toEqual([200]);
      expect(xs(st.edges.find((e) => e.source === knot))).toEqual([]);
    });

    it('a wire it cannot take changes nothing and spends no entry', () => {
      seed();
      expect(branchIntoWireAt('gone', P(300, 85), get, 1)).toBeNull();
      expect(branchIntoWireAt(wire.id, P(300, 85), get, 0)).toBeNull();
      expect(useAppStore.getState().past).toHaveLength(0);
    });
  });

  it('a Branch never drag-connects, never splices into a wire it is dropped on, and never makes room', () => {
    const src = read('NodeEditor.tsx');
    // The drag preview returns before drag-connect and the edge light.
    expect(src).toContain("if (rfDragged.type === 'group' || rfDragged.type === 'note' || isKnot(rfDragged)) return;");
    // No drag-connect target, never pushed by a make-room cascade.
    expect(src.match(/other\.type === 'note' \|\| isKnot\(other\)/g)).toHaveLength(1);
    expect(src).toContain("if (n.type === 'group' || n.type === 'note' || isKnot(n)) continue;");
    // Its own drop moves nothing else.
    expect(src).toContain('} else if (!isNote && !isKnot(freshDragged)) {');
    // Drop-on-edge needs a registry def, which a Branch never has.
    expect(src).toContain('if (!isNote && !overNodeBody && def && def.inputs.length > 0 && def.outputs.length > 0) {');
  });

  it('the creation gestures the owner removed stay removed (2026-11-23: menus only)', () => {
    const editor = read('NodeEditor.tsx');
    // A dragged wire released on a wire or a routing point makes no Branch.
    expect(editor).not.toMatch(/branchDropFor|findBranchDrop|insertBranch|promoteWaypoint/);
    // Shift+drag on a routing point is no gesture.
    expect(read('edges/TypedEdge.tsx')).not.toMatch(/shiftKey|branchActions/);
    // A dragged Branch is no splice candidate.
    expect(read('edgeInsert.ts')).not.toMatch(/isKnot|knot/i);
  });

  it('the Branch row and "Branch from here" are the two menu ways in', () => {
    expect(read('menus/EdgeContextMenu.tsx')).toContain('promoteWaypoint(edgeId, pointIndex)');
    expect(read('menus/AddNodeMenu.tsx')).toContain('branchIntoWireAt(spliceEdgeId, at, getInternalNode, getViewport().zoom)');
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
    expect(read('NodeEditor.tsx')).toContain('connection.targetHandle');
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

  it('F7: "Branch from here" and Insert node > Branch are not offered on a wire they may not take', () => {
    expect(read('menus/EdgeContextMenu.tsx')).toMatch(/branchRefusal\(s\.nodes, s\.edges, edgeId\) === null/);
    const add = read('menus/AddNodeMenu.tsx');
    expect(add).toMatch(/branchRefusal\(s\.nodes, s\.edges, spliceEdgeId\) === null/);
    expect(add).toMatch(/!query\.trim\(\) && branchOffered/);
  });
});
