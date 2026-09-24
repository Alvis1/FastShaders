import { describe, it, expect } from 'vitest';
import { makeEdge, makeNode } from '@/test-utils';
import { ADD_GAP, addAnchor, planShaderGroup } from './shaderGroupImport';
import type { AppNode } from '@/types';

/** A node at a position, optionally inside a parent. */
function at(id: string, type: string, x: number, y: number, parentId?: string): AppNode {
  const n = makeNode(id, type) as AppNode & { parentId?: string };
  n.position = { x, y };
  if (parentId) n.parentId = parentId;
  return n;
}

function group(id: string, x: number, y: number): AppNode {
  return {
    id,
    type: 'group',
    position: { x, y },
    width: 300,
    height: 200,
    data: { registryType: 'group', label: id, color: '#123456', width: 300, height: 200 },
  } as unknown as AppNode;
}

/** Deterministic colour pick, so nothing here depends on Math.random. */
const rand = () => 0;

describe('planShaderGroup: the sinks are dropped', () => {
  it('leaves out every Output and the edges that fed it — "not attached to output"', () => {
    const incoming = {
      nodes: [at('n1', 'noise', 0, 0), at('out', 'output', 400, 0)],
      edges: [makeEdge('n1', 'out', 'out', 'color')],
    };
    const plan = planShaderGroup(incoming, [], 'waves', { rand })!;
    expect(plan).not.toBeNull();
    expect(plan.members.map((m) => m.data.registryType)).toEqual(['noise']);
    expect(plan.edges).toHaveLength(0);
    expect(plan.droppedSinks).toBe(1);
  });

  it('drops a Raymarch Output too — a driving one suppresses every plain Output', () => {
    const incoming = {
      nodes: [at('sdf', 'sdfSphere', 0, 0), at('rm', 'raymarchOutput', 400, 0)],
      edges: [makeEdge('sdf', 'out', 'rm', 'field')],
    };
    const plan = planShaderGroup(incoming, [], 'march', { rand })!;
    expect(plan.members.map((m) => m.data.registryType)).toEqual(['sdfSphere']);
    expect(plan.droppedSinks).toBe(1);
  });

  it('answers null for a file with nothing but an Output, so no empty frame lands', () => {
    const incoming = { nodes: [at('out', 'output', 0, 0)], edges: [] };
    expect(planShaderGroup(incoming, [], 'empty', { rand })).toBeNull();
  });

  it('keeps every wire BETWEEN surviving nodes', () => {
    const incoming = {
      nodes: [at('a', 'uv', 0, 0), at('b', 'noise', 200, 0), at('out', 'output', 400, 0)],
      edges: [makeEdge('a', 'out', 'b', 'pos'), makeEdge('b', 'out', 'out', 'color')],
    };
    const plan = planShaderGroup(incoming, [], 'chain', { rand })!;
    expect(plan.edges).toHaveLength(1);
    const ids = new Map(plan.members.map((m) => [m.data.label, m.id]));
    expect(plan.edges[0].source).toBe(ids.get('a'));
    expect(plan.edges[0].target).toBe(ids.get('b'));
    // Re-ided onto the fresh node ids, never carrying the file's own edge id.
    expect(plan.edges[0].id).toContain(ids.get('a')!);
  });
});

describe('planShaderGroup: fresh ids', () => {
  it('re-mints every id, so a file exported from THIS shader cannot collide', () => {
    const live = [at('n1', 'noise', 0, 0)];
    const incoming = { nodes: [at('n1', 'uv', 0, 0)], edges: [] };
    const plan = planShaderGroup(incoming, live, 'same-ids', { rand })!;
    expect(plan.members[0].id).not.toBe('n1');
    expect(plan.group.id).not.toBe('n1');
  });

  it('clears `selected`, so an add never arrives selected over the live selection', () => {
    const n = at('a', 'uv', 0, 0) as AppNode & { selected?: boolean };
    n.selected = true;
    const plan = planShaderGroup({ nodes: [n], edges: [] }, [], 'sel', { rand })!;
    expect((plan.members[0] as { selected?: boolean }).selected).toBe(false);
  });
});

describe('planShaderGroup: the singleton is redirected, not duplicated', () => {
  it('folds an arriving Sound node onto the live one and re-points its wires', () => {
    const live = [at('live-sound', 'soundNode', 0, 0)];
    const incoming = {
      nodes: [at('their-sound', 'soundNode', 0, 0), at('mul', 'multiply', 200, 0)],
      edges: [makeEdge('their-sound', 'level', 'mul', 'a')],
    };
    const plan = planShaderGroup(incoming, live, 'sound', { rand })!;
    // One member only — the Sound node did not arrive a second time.
    expect(plan.members.map((m) => m.data.registryType)).toEqual(['multiply']);
    expect(plan.redirectedSingletons).toBe(1);
    // …and the wire it fed now comes out of the node already on the canvas.
    expect(plan.edges).toHaveLength(1);
    expect(plan.edges[0].source).toBe('live-sound');
    expect(plan.edges[0].target).toBe(plan.members[0].id);
  });

  it('keeps the arriving Sound node when the canvas has none', () => {
    const incoming = { nodes: [at('their-sound', 'soundNode', 0, 0)], edges: [] };
    const plan = planShaderGroup(incoming, [], 'sound', { rand })!;
    expect(plan.members).toHaveLength(1);
    expect(plan.redirectedSingletons).toBe(0);
  });

  it('never mints a self-edge out of a fold', () => {
    const live = [at('live-sound', 'soundNode', 0, 0)];
    const incoming = {
      nodes: [at('s1', 'soundNode', 0, 0), at('n', 'noise', 0, 0)],
      // A hand-edited file wiring one Sound node to another: both ends fold.
      edges: [makeEdge('s1', 'level', 's1', 'gain')],
    };
    const plan = planShaderGroup(incoming, live, 'self', { rand })!;
    expect(plan.edges).toHaveLength(0);
  });

  it('never wires an arriving node INTO the live singleton', () => {
    // The file's Float drives its Sound gain. Folded, that wire would re-drive
    // the LIVE node's gain — Add re-wiring the user's shader.
    const live = [at('live-sound', 'soundNode', 0, 0)];
    const incoming = {
      nodes: [at('s1', 'soundNode', 0, 0), at('f', 'float', 0, 0), at('mul', 'multiply', 200, 0)],
      edges: [makeEdge('f', 'out', 's1', 'gain'), makeEdge('s1', 'level', 'mul', 'a')],
    };
    const plan = planShaderGroup(incoming, live, 'gain', { rand })!;
    expect(plan.edges.some((e) => e.target === 'live-sound')).toBe(false);
    expect(plan.edges.map((e) => e.source)).toEqual(['live-sound']);
  });
});

describe('planShaderGroup: the frame', () => {
  it('takes the FILE name as its label', () => {
    const plan = planShaderGroup({ nodes: [at('a', 'uv', 0, 0)], edges: [] }, [], 'lo_udens', { rand })!;
    expect((plan.group.data as { label: string }).label).toBe('lo_udens');
  });

  it('parents every root member to the frame, with no `extent`', () => {
    const incoming = { nodes: [at('a', 'uv', 0, 0), at('b', 'noise', 200, 40)], edges: [] };
    const plan = planShaderGroup(incoming, [], 'f', { rand })!;
    for (const m of plan.members) {
      expect(m.parentId).toBe(plan.group.id);
      // Members must stay draggable OUT of a frame — never `extent: 'parent'`.
      expect('extent' in m).toBe(false);
    }
  });

  it('is big enough to hold what it frames', () => {
    const incoming = { nodes: [at('a', 'uv', 0, 0), at('b', 'noise', 300, 200)], edges: [] };
    const plan = planShaderGroup(incoming, [], 'f', { rand })!;
    const w = (plan.group as { width?: number }).width!;
    const h = (plan.group as { height?: number }).height!;
    for (const m of plan.members) {
      expect(m.position.x).toBeGreaterThanOrEqual(0);
      expect(m.position.y).toBeGreaterThanOrEqual(0);
      expect(m.position.x).toBeLessThan(w);
      expect(m.position.y).toBeLessThan(h);
    }
    // The frame mirrors its size into `data` as well as onto the node — one
    // home, two readers (React Flow and GroupNode).
    expect((plan.group.data as { width: number }).width).toBe(w);
    expect((plan.group.data as { height: number }).height).toBe(h);
  });

  it('parks clear to the RIGHT of the live graph', () => {
    const live = [at('a', 'uv', 0, 0), at('b', 'noise', 500, 0)];
    const plan = planShaderGroup({ nodes: [at('x', 'uv', 0, 0)], edges: [] }, live, 'f', { rand })!;
    expect(plan.group.position.x).toBeGreaterThanOrEqual(500 + ADD_GAP);
  });

  it('anchors at the flow origin on an empty canvas', () => {
    expect(addAnchor([])).toEqual({ x: 0, y: 0 });
  });

  it('measures the live box from ROOT nodes only — a child position is relative', () => {
    const live = [group('g', 0, 0), at('inner', 'uv', 9000, 0, 'g')];
    // The child's 9000 is inside `g`, so it must not push the anchor out there.
    expect(addAnchor(live).x).toBeLessThan(9000);
  });
});

describe('planShaderGroup: nesting survives', () => {
  it('keeps a group the dropped file carried, and emits parents before children', () => {
    const incoming = {
      nodes: [at('outer', 'uv', 0, 0), group('g', 100, 0), at('inner', 'noise', 20, 20, 'g')],
      edges: [],
    };
    const plan = planShaderGroup(incoming, [], 'f', { rand })!;
    const order = plan.members.map((m) => m.data.label);
    // React Flow requires a parent BEFORE its children in the array.
    expect(order.indexOf('g')).toBeLessThan(order.indexOf('inner'));
    const g = plan.members.find((m) => m.data.label === 'g')!;
    const inner = plan.members.find((m) => m.data.label === 'inner')!;
    expect(inner.parentId).toBe(g.id);
    // A child's position is relative to its parent — untouched by the move.
    expect(inner.position).toEqual({ x: 20, y: 20 });
    // …while the inner group, a root of the arriving set, joins the frame.
    expect(g.parentId).toBe(plan.group.id);
  });

  it('re-roots a child whose parent was a dropped Output', () => {
    const incoming = {
      nodes: [at('out', 'output', 0, 0), at('orphan', 'uv', 30, 30, 'out')],
      edges: [],
    };
    const plan = planShaderGroup(incoming, [], 'f', { rand })!;
    expect(plan.members).toHaveLength(1);
    expect(plan.members[0].parentId).toBe(plan.group.id);
  });

  it('re-roots a child whose parent names nothing in the file', () => {
    const incoming = { nodes: [at('a', 'uv', 0, 0, 'ghost')], edges: [] };
    const plan = planShaderGroup(incoming, [], 'f', { rand })!;
    expect(plan.members[0].parentId).toBe(plan.group.id);
  });

  it('does not hang on a parent cycle a hand-edited file could carry', () => {
    const a = at('a', 'uv', 0, 0, 'b');
    const b = at('b', 'noise', 0, 0, 'a');
    const plan = planShaderGroup({ nodes: [a, b], edges: [] }, [], 'f', { rand })!;
    expect(plan.members).toHaveLength(2);
  });
});
