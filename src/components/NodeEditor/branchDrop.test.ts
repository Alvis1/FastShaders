/**
 * A Branch dragged onto an INPUT (owner, 2026-11-24: "a branch dragged over
 * an input branches to that input, keeping the drag's start location"):
 * which input the dot is over (branchDrop.ts `branchDropSocket`), the
 * refusals (`branchDropRefusal`), and the store half
 * (branchActions.ts `dropBranchOnInput`): ONE undo entry, no move left in
 * history, and a refusal that just puts the Branch back.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AppNode } from '@/types';
import { HISTORY_IDLE, makeKnot, makeNode, makeTunnelIn, makeTunnelOut } from '@/test-utils';
import { cancelPendingGraphSave, useAppStore } from '@/store/useAppStore';
import { makeTypedEdge } from '@/utils/edgeUtils';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { graphToCode } from '@/engine/graphToCode';
import { connectNodes } from './edgeInsert';
import { branchDropRefusal, branchDropSocket, type InputSocket } from './branchDrop';
import { dropBranchOnInput, type BranchConnection } from './branchActions';

const P = (x: number, y: number) => ({ x, y });
const read = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf8');
const at = (n: AppNode, x: number, y: number) => ({ ...n, position: P(x, y) }) as AppNode;
const pairs = () => useAppStore.getState().edges.map((e) => `${e.source}.${e.sourceHandle}>${e.target}.${e.targetHandle}`);
/** The canvas's commit, as the store test can run it (NodeEditor hands in
 *  `applyConnection`, whose core this is). */
const commit = (c: BranchConnection) => connectNodes(c.source, c.sourceHandle, c.target, c.targetHandle);

describe('branchDropSocket — the input the dot is over', () => {
  const sockets: InputSocket[] = [
    { nodeId: 'k', handleId: 'in', x: 0, y: 0 },
    { nodeId: 'a', handleId: 'x', x: 30, y: 0 },
    { nodeId: 'b', handleId: 'y', x: 12, y: 5 },
    { nodeId: 'c', handleId: 'z', x: 100, y: 0 },
  ];

  it('the nearest socket of ANOTHER node within the radius', () => {
    expect(branchDropSocket(P(0, 0), sockets, 'k', 40, [])).toEqual(sockets[2]);
    expect(branchDropSocket(P(28, 0), sockets, 'k', 40, [])).toEqual(sockets[1]);
    // Nothing within reach: a plain move.
    expect(branchDropSocket(P(300, 300), sockets, 'k', 40, [])).toBeNull();
    // Never the Branch's own input.
    expect(branchDropSocket(P(0, 0), [sockets[0]], 'k', 40, [])).toBeNull();
  });

  it('tests the DISTANCE first: a socket out of reach never pays the edge scan (it runs every drag frame)', () => {
    let scans = 0;
    const edges = [makeTypedEdge('k', 'out', 'a', 'x')];
    const counted = Object.assign([...edges], {
      some(this: typeof edges, f: Parameters<typeof edges.some>[0]) {
        scans++;
        return Array.prototype.some.call(this, f);
      },
    });
    const far: InputSocket[] = Array.from({ length: 500 }, (_, i) => ({ nodeId: `n${i}`, handleId: 'x', x: 1000 + i, y: 0 }));
    expect(branchDropSocket(P(0, 0), [...far, sockets[2]], 'k', 40, counted)).toEqual(sockets[2]);
    // The one socket within reach is the one scanned (the first cut scanned 501).
    expect(scans).toBe(1);
  });

  it('never an input this Branch already feeds: moving up to its own consumer is a plain move', () => {
    const fed = [makeTypedEdge('k', 'out', 'b', 'y')];
    expect(branchDropSocket(P(0, 0), sockets, 'k', 40, fed)).toEqual(sockets[1]);
    expect(branchDropSocket(P(12, 5), [sockets[2]], 'k', 40, fed)).toBeNull();
  });
});

describe('branchDropRefusal', () => {
  const nodes = [makeNode('f', 'float'), makeKnot('k'), makeNode('s', 'sin'), makeNode('m', 'mul'), makeKnot('k2')];
  const edges = [
    makeTypedEdge('f', 'out', 'k', 'in'),
    makeTypedEdge('k', 'out', 's', 'x'),
    makeTypedEdge('s', 'out', 'm', 'a'),
    makeTypedEdge('f', 'out', 'k2', 'in'),
  ];

  it('lets the Branch into a free or an occupied ordinary input', () => {
    expect(branchDropRefusal(nodes, edges, 'k', { nodeId: 'm', handleId: 'b' })).toBeNull();
    // Occupied: the wire into it is REPLACED, the normal connect rule.
    expect(branchDropRefusal(nodes, edges, 'k', { nodeId: 'm', handleId: 'a' })).toBeNull();
  });

  it('refuses: a missing node, an input it already feeds, a fed Branch, and any loop', () => {
    expect(branchDropRefusal(nodes, edges, 'k', { nodeId: 'gone', handleId: 'x' })).toBe('missing');
    expect(branchDropRefusal(nodes, edges, 'k', { nodeId: 's', handleId: 'x' })).toBe('same');
    expect(branchDropRefusal(nodes, edges, 'k', { nodeId: 'k2', handleId: 'in' })).toBe('refused');
    // f feeds k: k into f's own input would be a loop.
    const withF = [makeNode('g', 'sin'), ...nodes];
    const loopEdges = [makeTypedEdge('g', 'out', 'f', 'x'), ...edges];
    expect(branchDropRefusal(withF, loopEdges, 'k', { nodeId: 'g', handleId: 'x' })).toBe('loop');
  });

  it('refuses a loop only a Portal\'s hidden link makes', () => {
    // f → IN ⇢ OUT → k ; k into f would close it through the link.
    const n = [makeNode('f', 'sin'), makeTunnelIn('IN'), makeTunnelOut('OUT', 'IN'), makeKnot('k')];
    const e = [makeTypedEdge('f', 'out', 'IN', 'in'), makeTypedEdge('OUT', 'out', 'k', 'in')];
    expect(branchDropRefusal(n, e, 'k', { nodeId: 'f', handleId: 'x' })).not.toBeNull();
  });
});

describe('dropBranchOnInput — the store half', () => {
  const f = makeNode('f', 'float', { value: 0.5 });
  const k = at(makeKnot('k'), 400, 300);
  const s = makeNode('s', 'sin');
  const m = makeNode('m', 'mul');
  const o = makeNode('o', 'output');
  const start = P(100, 50);

  beforeEach(() => {
    cancelPendingGraphSave();
    // The Branch sits where the drag LEFT it (400, 300); it started at (100, 50).
    useAppStore.setState({
      nodes: [f, k, s, m, o],
      edges: [makeTypedEdge('f', 'out', 'k', 'in'), makeTypedEdge('k', 'out', 's', 'x'), makeTypedEdge('m', 'out', 'o', 'color')],
      past: [],
      future: [],
      ...HISTORY_IDLE,
    });
  });
  afterAll(() => {
    cancelPendingGraphSave();
    useAppStore.setState({ nodes: [], edges: [], past: [], future: [], ...HISTORY_IDLE });
  });

  const knotPos = () => useAppStore.getState().nodes.find((n) => n.id === 'k')!.position;

  it('connects Branch.out to the input, goes BACK, in ONE undo entry with no move in it', () => {
    expect(dropBranchOnInput('k', start, { nodeId: 'm', handleId: 'a' }, commit)).toBe('connected');
    const st = useAppStore.getState();
    expect(st.past).toHaveLength(1);
    expect(knotPos()).toEqual(start);
    expect(pairs()).toContain('k.out>m.a');
    // The entry holds the Branch at its START, without the wire: undo moves nothing.
    expect(st.past[0].nodes.find((n) => n.id === 'k')!.position).toEqual(start);
    useAppStore.getState().undo();
    expect(knotPos()).toEqual(start);
    expect(pairs()).not.toContain('k.out>m.a');
    // Redo brings the wire back, still with the Branch at its start.
    useAppStore.getState().redo();
    expect(pairs()).toContain('k.out>m.a');
    expect(knotPos()).toEqual(start);
  });

  it('the code is what a wire dragged from the Branch makes', () => {
    dropBranchOnInput('k', start, { nodeId: 'm', handleId: 'a' }, commit);
    const viaDrop = graphToCode(useAppStore.getState().nodes, useAppStore.getState().edges, NODE_REGISTRY).code;
    useAppStore.setState({
      edges: [makeTypedEdge('f', 'out', 'k', 'in'), makeTypedEdge('k', 'out', 's', 'x'), makeTypedEdge('m', 'out', 'o', 'color')],
    });
    connectNodes('k', 'out', 'm', 'a');
    expect(viaDrop).toBe(graphToCode(useAppStore.getState().nodes, useAppStore.getState().edges, NODE_REGISTRY).code);
  });

  it('a refusal just puts the Branch back: no wire, no undo entry', () => {
    const before = useAppStore.getState().edges;
    // An input it already feeds…
    expect(dropBranchOnInput('k', start, { nodeId: 's', handleId: 'x' }, commit)).toBe('same');
    // …and a loop (s is fed by k; k into f's input is no loop, but f is fed by nothing — use the trunk's source).
    useAppStore.setState({ nodes: [...useAppStore.getState().nodes, makeNode('g', 'sin')], edges: [...before, makeTypedEdge('g', 'out', 'f', 'x')] });
    const looped = useAppStore.getState().edges;
    expect(dropBranchOnInput('k', start, { nodeId: 'g', handleId: 'x' }, commit)).toBe('loop');
    expect(useAppStore.getState().edges).toBe(looped);
    expect(useAppStore.getState().past).toHaveLength(0);
    expect(knotPos()).toEqual(start);
  });

  it('refuses anything but a Branch, changing nothing', () => {
    expect(dropBranchOnInput('s', start, { nodeId: 'm', handleId: 'a' }, commit)).toBe('missing');
    expect(useAppStore.getState().past).toHaveLength(0);
  });

  it('is wired into the node drag: lit on the way, dropped through the ONE connect commit', () => {
    const editor = read('NodeEditor.tsx');
    expect(editor).toContain('branchDropSocket(center, sockets, knotId, CONNECTION_RADIUS, edges)');
    expect(editor).toContain("handleEl(node, 'target', cur.socket.handleId)?.classList.add('fs-connect-socket')");
    expect(editor).toContain('dropBranchOnInput(draggedNode.id, branchStart, branchDrop.socket, applyConnection)');
    // A Branch alone in the drag, and never after an Alt+drag cut its wires.
    expect(editor).toContain('if (draggedNodes.length === 1 && !altDetachRef.current?.pushed) updateBranchDrop(rfDragged.id);');
  });

  it('re-applies its marks EVERY frame, and keeps the dragged Branch above the raised target', () => {
    // The first cut returned early on an unchanged socket, so React's
    // className rewrite (a select/drag change) wiped the ring mid-hover; and
    // the target's `fs-connect-front` (z 10000) hid the dot being dropped.
    const editor = read('NodeEditor.tsx');
    expect(editor).toMatch(
      /prev\.socket\.nodeId === socket\.nodeId && prev\.socket\.handleId === socket\.handleId\) \{\s*markBranchDrop\(prev\);\s*return;/,
    );
    expect(editor).toContain('nodeEl(cur.knotId)?.classList.add(BRANCH_DROP_DRAGGED_CLASS);');
    const css = read('NodeEditor.css');
    expect(css).toMatch(/\.react-flow__node\.fs-connect-front \{\s*z-index: 10000 !important;/);
    expect(css).toMatch(/\.react-flow__node\.fs-branch-drop-dragged \{\s*z-index: 10001 !important;/);
  });
});
