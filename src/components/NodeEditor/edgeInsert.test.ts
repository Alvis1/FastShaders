/**
 * Splicing a node onto an existing wire.
 *
 * Two surfaces do it — dropping a node or a tile near a wire, and the edge
 * menu's **Insert node** — and they share one implementation precisely so a
 * node spliced by pointing at a wire and one spliced by picking from a list
 * cannot land on different ports under different rules. The port CHOICE is
 * pure and pinned in edgeSplice.test.ts; what is pinned here is the rewiring
 * and the two ways it must refuse.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { useAppStore } from '@/store/useAppStore';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { makeNode, makeEdge } from '@/test-utils';
import { effectiveExposedPorts } from '@/utils/exposedPorts';
import { connectNodes, connectDroppedWire, spliceNodeIntoEdge } from './edgeInsert';

const def = (type: string) => NODE_REGISTRY.get(type)!;

/** a → b, with `mul` sitting loose beside them. */
function seed() {
  useAppStore.setState({
    nodes: [makeNode('a', 'float'), makeNode('b', 'float'), makeNode('m', 'mul')],
    edges: [makeEdge('a', 'out', 'b', 'x')],
  });
}

describe('spliceNodeIntoEdge', () => {
  beforeEach(seed);

  it('rewires source → node → target and drops the original edge', () => {
    const edgeId = useAppStore.getState().edges[0].id;
    expect(spliceNodeIntoEdge('m', def('mul'), edgeId)).toBe(true);

    const edges = useAppStore.getState().edges;
    expect(edges.some((e) => e.id === edgeId), 'the spliced edge survived').toBe(false);
    expect(edges).toHaveLength(2);
    // In, on the first free input…
    expect(edges.find((e) => e.target === 'm')).toMatchObject({ source: 'a', sourceHandle: 'out', targetHandle: 'a' });
    // …and out, to where the wire was going.
    expect(edges.find((e) => e.source === 'm')).toMatchObject({ target: 'b', targetHandle: 'x' });
  });

  it('lands on the first FREE input, keeping what the node already has', () => {
    // A node half-wired before the splice must not lose that operand — the
    // defect edgeSplice.ts was written for.
    useAppStore.setState({
      edges: [...useAppStore.getState().edges, makeEdge('b', 'out', 'm', 'a')],
    });
    const edgeId = useAppStore.getState().edges[0].id;
    expect(spliceNodeIntoEdge('m', def('mul'), edgeId)).toBe(true);

    const into = useAppStore.getState().edges.filter((e) => e.target === 'm');
    expect(into.map((e) => e.targetHandle).sort()).toEqual(['a', 'b']);
    // The pre-existing operand is still on `a`, untouched; the splice took `b`.
    expect(into.find((e) => e.targetHandle === 'a')?.source, 'the existing operand was replaced').toBe('b');
    expect(into.find((e) => e.targetHandle === 'b')?.source, 'the splice did not take the free port').toBe('a');
  });

  it('REFUSES a node that cannot pass a signal on, and changes nothing', () => {
    // Both sinks declare `outputs: []`, and they are the node types a user is
    // most likely to reach for while pointing at a wire. Reading
    // `def.outputs[0].id` on one is a TypeError, so the guard lives in the
    // splice rather than at each call site, where a new caller can forget it.
    for (const sink of ['output', 'raymarchOutput']) {
      seed();
      const before = useAppStore.getState().edges;
      expect(def(sink).outputs, `${sink} has grown an output port`).toHaveLength(0);
      expect(spliceNodeIntoEdge('m', def(sink), before[0].id)).toBe(false);
      expect(useAppStore.getState().edges).toBe(before);
    }
  });

  it('refuses an edge that is no longer there', () => {
    const before = useAppStore.getState().edges;
    expect(spliceNodeIntoEdge('m', def('mul'), 'gone')).toBe(false);
    expect(useAppStore.getState().edges).toBe(before);
  });
});

describe('the two surfaces that splice (source pins)', () => {
  const read = (f: string) => readFileSync(new URL(f, import.meta.url), 'utf8');

  it('the edge menu offers Insert node, opening the search list for THAT edge', () => {
    const menu = read('./menus/EdgeContextMenu.tsx');
    expect(menu).toContain("t('Insert node', language)");
    // 'canvas' is the AddNodeMenu; the edge rides along in the existing
    // `edgeId` field, at the SAME point, so the node lands on the wire where
    // it was clicked.
    expect(menu).toContain("openContextMenu(x, y, 'canvas', undefined, edgeId)");
  });

  it('the Add menu splices inside the ONE history bracket that added the node', () => {
    const menu = read('./menus/AddNodeMenu.tsx');
    expect(menu).toContain('const spliceEdgeId = contextMenu.edgeId;');
    expect(menu).toContain('spliceNodeIntoEdge(newNodeId, def, spliceEdgeId)');
    // asOneHistoryEntry wraps the whole handler: the add and both wires undo
    // together, or one Cmd+Z leaves a node standing spliced-out mid-graph.
    const handler = menu.slice(menu.indexOf('const handleAddNode'), menu.indexOf('const handleGroupSelection'));
    expect(handler).toContain('asOneHistoryEntry');
    expect(handler.indexOf('spliceNodeIntoEdge')).toBeGreaterThan(handler.indexOf('addNode('));
  });

  it('the drag path shares it rather than keeping its own copy', () => {
    const editor = read('./NodeEditor.tsx');
    expect(editor).toContain('spliceNodeIntoEdge(nodeId, def, edgeId)');
    // The old inline body would drift: same two edges, its own port choice.
    expect(editor).not.toContain('const newEdge1 = makeTypedEdge(');
  });
});

describe('connectNodes — the one connect rule', () => {
  beforeEach(seed);

  it('replaces an existing wire on the same input rather than stacking one', () => {
    // Inputs are single-connection. Two edges into one handle is a graph the
    // renderer draws and codegen resolves arbitrarily.
    useAppStore.setState({ edges: [makeEdge('a', 'out', 'm', 'a')] });
    connectNodes('b', 'out', 'm', 'a');
    const into = useAppStore.getState().edges.filter((e) => e.target === 'm' && e.targetHandle === 'a');
    expect(into).toHaveLength(1);
    expect(into[0].source).toBe('b');
  });

  it('exposes a hidden parameter socket it lands on', () => {
    // An edge to an unexposed port names a handle that never mounts: React Flow
    // draws nothing while the store keeps the edge and codegen still reads it.
    useAppStore.setState({
      nodes: [makeNode('a', 'float'), makeNode('img', 'imageNode')],
      edges: [],
    });
    expect(effectiveExposedPorts(useAppStore.getState().nodes[1])).not.toContain('uv');
    connectNodes('a', 'out', 'img', 'uv');
    expect(effectiveExposedPorts(useAppStore.getState().nodes[1])).toContain('uv');
  });
});

describe('connectDroppedWire — which way the wire goes', () => {
  beforeEach(seed);

  const pin = (handleType: 'source' | 'target', handleId: string) =>
    ({ nodeId: 'a', handleId, handleType }) as const;

  it('feeds the new node when the wire came from an OUTPUT', () => {
    expect(connectDroppedWire(pin('source', 'out'), 'm', def('mul'))).toBe(true);
    const edges = useAppStore.getState().edges.filter((e) => e.target === 'm');
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ source: 'a', sourceHandle: 'out', targetHandle: 'a' });
  });

  it('is FED BY the new node when the wire came from an INPUT', () => {
    // The half that was missing. Getting it backwards instead would author an
    // edge out of an input — React Flow renders that as nothing at all while
    // the store keeps it and codegen still reads it, so it fails invisibly.
    useAppStore.setState({ edges: [] });
    expect(connectDroppedWire(pin('target', 'x'), 'm', def('mul'))).toBe(true);
    const edges = useAppStore.getState().edges;
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ source: 'm', sourceHandle: 'out', target: 'a', targetHandle: 'x' });
  });

  it('refuses, without wiring, when the chosen node has no port for that end', () => {
    // A constant dragged out of an output has nothing to receive the signal;
    // a sink dragged out of an input has nothing to give. Both still ADD the
    // node where the menu was opened — only the wire is skipped.
    useAppStore.setState({ edges: [] });
    expect(def('float').inputs).toHaveLength(0);
    expect(connectDroppedWire(pin('source', 'out'), 'm', def('float'))).toBe(false);
    expect(def('output').outputs).toHaveLength(0);
    expect(connectDroppedWire(pin('target', 'x'), 'm', def('output'))).toBe(false);
    expect(useAppStore.getState().edges).toHaveLength(0);
  });

  it('replaces what the input already had, through the shared rule', () => {
    useAppStore.setState({ edges: [makeEdge('b', 'out', 'a', 'x')] });
    connectDroppedWire(pin('target', 'x'), 'm', def('mul'));
    const into = useAppStore.getState().edges.filter((e) => e.target === 'a' && e.targetHandle === 'x');
    expect(into).toHaveLength(1);
    expect(into[0].source).toBe('m');
  });
});

describe('the wire-drop menu (source pins)', () => {
  const read = (f: string) => readFileSync(new URL(f, import.meta.url), 'utf8');

  it('tracks BOTH ends of a wire, not just the output', () => {
    const editor = read('./NodeEditor.tsx');
    expect(editor).toContain("(params.handleType === 'source' || params.handleType === 'target')");
    // The pin was discarded here for a target handle, three functions before
    // anything could have used it — so the menu opened and added a loose node.
    expect(editor).not.toContain("if (params.handleType === 'source' && params.nodeId");
    expect(editor).toContain('handleType: params.handleType,');
  });

  it('carries the side through the menu state and into the connect', () => {
    expect(read('./menus/AddNodeMenu.tsx')).toContain('sourceNodeId && sourceHandleId && sourceHandleType');
    expect(read('./menus/AddNodeMenu.tsx')).toContain('connectDroppedWire(');
    // The stub wire measures and colours from its own side: React Flow keeps
    // the two in separate handleBounds buckets, so reading `source` for an
    // input pin finds nothing and the wire silently does not draw.
    const stub = read('./menus/ConnectionStub.tsx');
    expect(stub).toContain("sourceHandleType === 'target' ? bounds?.target : bounds?.source");
    expect(stub).toContain("sourceHandleType === 'target' ? def?.inputs : def?.outputs");
  });

  it('leaves applyConnection as the only place that adds the extras', () => {
    const editor = read('./NodeEditor.tsx');
    // The single-input filter now lives in connectNodes, shared with the menu.
    expect(editor).toContain('connectNodes(');
    expect(editor).not.toContain('// Enforce single-input: remove any existing edge');
    // …while the telemetry and the image→normal flip stay with the caller.
    // The EVENT NAME, not the call: `evalHooks.test.ts` sweeps all of src/ for
    // telemetry calls outside its reviewed chokepoint list, and it counts a
    // spelling of the call in a test file too (measured — this assertion was
    // written the obvious way first and reported this file as an offender).
    expect(editor).toContain("'edge-connect'");
  });
});
