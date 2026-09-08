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
import { spliceNodeIntoEdge } from './edgeInsert';

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
