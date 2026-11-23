/**
 * The Portal's refusals on EVERY connect path, and the ends hidden in a
 * collapsed group (docs/dev/canvas-interaction.md, "Portal"): the step-3
 * review and browser QA. Each case was a way round a rule the wire path
 * already kept — a drag-connect replacing a fed entrance's feed, a refused
 * reconnect deleting its wire, a splice or a pill socket closing a loop only
 * the hidden link makes, a dropped shader bringing a duplicate name, and a
 * hidden entrance selected or renamed where nothing shows it.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AppNode, GroupNodeData } from '@/types';
import { HISTORY_IDLE, makeNode, makeTunnelIn, makeTunnelOut } from '@/test-utils';
import { cancelPendingGraphSave, useAppStore } from '@/store/useAppStore';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { makeTypedEdge } from '@/utils/edgeUtils';
import { isTunnelIn, isTunnelOut } from '@/utils/passThrough';
import { planShaderGroup } from '@/engine/shaderGroupImport';
import { connectableInputs, planDragConnect, type ConnectHandle, type DragConnectEndpoints } from './dragConnect';
import { finishReconnect, startReconnect } from './branchActions';
import { spliceNodeIntoEdge } from './edgeInsert';
import {
  closesHiddenLoop,
  exitIntoMakesLoop,
  portalRenameRefusal,
  portalTraceIds,
  portalTraceKey,
  spliceClosesHiddenLoop,
} from './portalWire';
import { glideToPortalPartner, portalOutRefusal, selectWholePortal } from './portalActions';

const read = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf8');
const def = (type: string) => NODE_REGISTRY.get(type)!;
const selected = () => useAppStore.getState().nodes.filter((n) => n.selected).map((n) => n.id).sort();

const resetStore = () => {
  cancelPendingGraphSave();
  useAppStore.setState({ nodes: [], edges: [], past: [], future: [], ...HISTORY_IDLE });
};

beforeEach(() => {
  resetStore();
  // Group collapse defers its rewire a frame; run it at once.
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});
afterAll(resetStore);

describe('F1: a drag-connect never replaces a fed Portal In\'s feed', () => {
  const h = (id: string, cy: number, extra: Partial<ConnectHandle> = {}): ConnectHandle => ({ id, cx: 0, cy, ...extra });
  // The fed entrance E dragged with its centre on an Add H to its right.
  const ep = (draggedInputs: ConnectHandle[]): DragConnectEndpoints => ({
    draggedId: 'E',
    hoverId: 'H',
    draggedCenterX: 0,
    hoverCenterX: 100,
    draggedCenterY: 0,
    hoverCenterY: 0,
    hoverHeight: 60,
    draggedInputs,
    draggedOutputs: [],
    hoverInputs: [h('a', -10, { primary: true, spare: true }), h('b', 10, { spare: true })],
    hoverOutputs: [h('out', 0)],
  });

  it('the planner would replace it (the hazard) — its fed input is left out, so it does not', () => {
    const fed = [h('in', 0, { occupied: true, primary: true })];
    expect(planDragConnect(ep(fed), [])).toMatchObject({ source: 'H', target: 'E', targetHandle: 'in' });
    expect(connectableInputs(fed, true)).toEqual([]);
    expect(planDragConnect(ep(connectableInputs(fed, true)), [])).toBeNull();
  });

  it('an UNFED entrance still takes a drag-connect, and nothing else changes', () => {
    const unfed = [h('in', 0, { primary: true })];
    expect(connectableInputs(unfed, true)).toBe(unfed);
    const shader = [h('a', 0, { occupied: true, primary: true })];
    expect(connectableInputs(shader, false)).toBe(shader);
  });

  it('is applied to every mounted target list, and re-checked at the drop', () => {
    const editor = read('NodeEditor.tsx');
    expect(editor).toContain("return kind === 'target' ? connectableInputs(handles, isTunnelIn(node)) : handles;");
    expect(editor).toContain('feedsFedKnot(store.nodes, store.edges, connectPlan.target, null, connectPlan.targetHandle)');
  });
});

/** a → E ; O (of E) → m.a ; m → Output.color */
const hiddenLoopGraph = () => {
  useAppStore.setState({
    nodes: [makeNode('a', 'add'), makeTunnelIn('E', 'p'), makeTunnelOut('O', 'E', 'p'), makeNode('m', 'mul'), makeNode('out', 'output')],
    edges: [
      makeTypedEdge('a', 'out', 'E', 'in'),
      makeTypedEdge('O', 'out', 'm', 'a'),
      makeTypedEdge('m', 'out', 'out', 'color'),
    ],
  });
};

describe('F2: a reconnect released on a socket that closes a hidden loop KEEPS its wire', () => {
  it('m → Output dragged by its Output end onto a\'s input: kept, no undo entry spent', () => {
    hiddenLoopGraph();
    const before = useAppStore.getState();
    const wire = before.edges.find((e) => e.source === 'm')!;
    expect(closesHiddenLoop(before.nodes, before.edges, 'm', 'a', 'out', 'a')).toBe(true);
    const mark = startReconnect(wire.id);
    const outcome = finishReconnect(mark, false, {
      isValid: false,
      toHandle: { nodeId: 'a', id: 'a', type: 'target' },
      fromHandle: { type: 'source' },
    });
    const after = useAppStore.getState();
    expect(outcome).toBe('kept');
    expect(after.edges).toBe(before.edges);
    expect(after.past).toBe(before.past);
  });

  it('a release on a socket of the fixed end\'s OWN kind (React Flow\'s refusal) still disconnects', () => {
    hiddenLoopGraph();
    const wire = useAppStore.getState().edges.find((e) => e.source === 'm')!;
    const outcome = finishReconnect(startReconnect(wire.id), false, {
      isValid: false,
      toHandle: { nodeId: 'a', id: 'out', type: 'source' },
      fromHandle: { type: 'source' },
    });
    expect(outcome).toBe('removed');
  });
});

describe('F3: dropping a node on a wire never closes a hidden loop', () => {
  it('m dropped on its own entrance\'s feed wire is refused, and the drag preview says so first', () => {
    useAppStore.setState({
      nodes: [makeNode('a', 'float'), makeTunnelIn('E', 'p'), makeTunnelOut('O', 'E', 'p'), makeNode('m', 'mul'), makeNode('out', 'output')],
      edges: [
        makeTypedEdge('a', 'out', 'E', 'in'),
        makeTypedEdge('O', 'out', 'm', 'a'),
        makeTypedEdge('m', 'out', 'out', 'color'),
      ],
    });
    const before = useAppStore.getState();
    const feed = before.edges.find((e) => e.target === 'E')!;
    expect(spliceClosesHiddenLoop(before.nodes, before.edges, 'm', feed.id)).toBe(true);
    expect(spliceNodeIntoEdge('m', def('mul'), feed.id)).toBe(false);
    expect(useAppStore.getState().edges).toBe(before.edges);
    // A fresh node on the same wire closes nothing.
    expect(spliceClosesHiddenLoop(before.nodes, before.edges, 'z', feed.id)).toBe(false);
    expect(read('NodeEditor.tsx')).toContain('spliceClosesHiddenLoop(store.nodes, store.edges, draggedNode.id, near)');
  });
});

describe('F4: a hidden loop made through a collapsed pill\'s socket is refused', () => {
  /** f → X.x, X → E (outside), O an exit of E; X (and a loose y) grouped and collapsed. */
  const pillGraph = () => {
    useAppStore.setState({
      nodes: [makeNode('f', 'float'), makeNode('X', 'sin'), makeNode('y', 'float'), makeTunnelIn('E', 'p'), makeTunnelOut('O', 'E', 'p')],
      edges: [makeTypedEdge('f', 'out', 'X', 'x'), makeTypedEdge('X', 'out', 'E', 'in')],
    });
    const gid = useAppStore.getState().groupSelection(['X', 'y'])!;
    useAppStore.getState().toggleGroupCollapsed(gid);
    const group = useAppStore.getState().nodes.find((n) => n.id === gid)!;
    const socket = (group.data as GroupNodeData).collapsedInputs!.find((s) => s.originalNodeId === 'X')!;
    return { gid, socketId: socket.socketId };
  };

  it('O → the pill\'s input for X.x reads as O → X.x', () => {
    const { gid, socketId } = pillGraph();
    const { nodes, edges } = useAppStore.getState();
    expect(closesHiddenLoop(nodes, edges, 'O', gid, 'out', socketId)).toBe(true);
    expect(exitIntoMakesLoop(nodes, edges, 'E', gid, socketId)).toBe(true);
    expect(portalOutRefusal('E', { nodeId: gid, handleId: socketId })).toBe('loop');
    // f → the same socket closes nothing.
    expect(closesHiddenLoop(nodes, edges, 'f', gid, 'out', socketId)).toBe(false);
  });
});

describe('F5: a dropped shader\'s ADD never brings a duplicate portal name', () => {
  it('an arriving "sin1" beside a live "sin1" becomes "sin1 2", its exit caching it', () => {
    const plan = planShaderGroup(
      {
        nodes: [makeNode('f', 'float'), makeTunnelIn('in1', 'sin1'), makeTunnelOut('o1', 'in1', 'sin1')],
        edges: [makeTypedEdge('f', 'out', 'in1', 'in')],
      },
      [makeTunnelIn('liveIn', 'sin1')],
      'file',
      { anchor: { x: 0, y: 0 }, rand: () => 0.5 },
    )!;
    const label = (n: AppNode | undefined) => (n?.data as { label?: unknown } | undefined)?.label;
    expect(label(plan.members.find(isTunnelIn))).toBe('sin1 2');
    expect(label(plan.members.find(isTunnelOut))).toBe('sin1 2');
  });
});

describe('F6: two clicks inside a control on a portal card are the control\'s own', () => {
  it('the control check runs before the Branch and Portal double-click branches', () => {
    const editor = read('NodeEditor.tsx');
    const start = editor.indexOf('if (!isDoubleActivation(prev, node.id, t)) return;');
    const guard = editor.indexOf('if (el?.closest?.(PEEK_EXEMPT_SELECTOR)) return;', start);
    expect(guard).toBeGreaterThan(start);
    expect(guard).toBeLessThan(editor.indexOf('removeBranch(node.id);', start));
    expect(guard).toBeLessThan(editor.indexOf('glideToPortalPartner(node.id, fitView);', start));
  });
});

describe('QA F1 + F2: an entrance hidden in a collapsed group', () => {
  /** a → sin m → E ; O → oneMinus t → Output; m and E grouped and collapsed. */
  const hidden = () => {
    useAppStore.setState({
      nodes: [
        makeNode('a', 'float'), makeNode('m', 'sin'), makeTunnelIn('E', 'wave'), makeTunnelOut('O', 'E', 'wave'),
        makeNode('t', 'oneMinus'), makeNode('out', 'output'),
      ],
      edges: [
        makeTypedEdge('a', 'out', 'm', 'x'),
        makeTypedEdge('m', 'out', 'E', 'in'),
        makeTypedEdge('O', 'out', 't', 'x'),
        makeTypedEdge('t', 'out', 'out', 'color'),
      ],
    });
    const gid = useAppStore.getState().groupSelection(['m', 'E'])!;
    useAppStore.getState().toggleGroupCollapsed(gid);
    return gid;
  };

  it('double-click / Go to entrance selects the PILL, never the hidden entrance', () => {
    const gid = hidden();
    expect(glideToPortalPartner('O', () => undefined)).toBe(true);
    expect(selected()).toEqual([gid]);
  });

  it('Select whole portal selects the pill in the hidden entrance\'s place', () => {
    const gid = hidden();
    expect(selectWholePortal('O')).toBe(true);
    expect(selected()).toEqual([gid, 'O'].sort());
  });

  it('Rename is refused while the entrance is hidden, and offered once it is shown', () => {
    const gid = hidden();
    expect(portalRenameRefusal(useAppStore.getState().nodes, 'O')).toBe('collapsed');
    useAppStore.getState().toggleGroupCollapsed(gid);
    expect(portalRenameRefusal(useAppStore.getState().nodes, 'O')).toBeNull();
    expect(portalRenameRefusal([makeTunnelOut('X', 'gone', 'old')], 'X')).toBe('broken');
    expect(read('menus/PortalMenu.tsx')).toContain('portalRenameRefusal(s.nodes, nodeId)');
  });
});

describe('F8: the trace marks an adversarial id as itself', () => {
  it('a selected entrance "a,b" marks itself and its exit — never the nodes "a" and "b"', () => {
    const nodes = [
      { ...makeTunnelIn('a,b', 'p'), selected: true } as AppNode,
      makeTunnelOut('x', 'a,b', 'p'),
      makeNode('a', 'float'),
      makeNode('b', 'float'),
    ];
    expect(portalTraceIds(portalTraceKey(nodes, null))).toEqual(['a,b', 'x']);
    expect(portalTraceIds(portalTraceKey(nodes.map((n) => ({ ...n, selected: false }) as AppNode), null))).toEqual([]);
    const trace = read('PortalTrace.tsx');
    expect(trace).toContain('portalTraceIds(markKey)');
    expect(trace).not.toContain('/[\\n,]/');
  });
});
