/**
 * The bake's graph edit (utils/bakeCommit.ts) and the store's ONE commit
 * (`commitBake`): the Image takes over the wires that carried the socket out of
 * the selection, a stored range reads back through Multiply + Add, the
 * originals park unwired in a collapsed group, all in ONE undo entry.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cancelPendingGraphSave, useAppStore } from '@/store/useAppStore';
import { HISTORY_IDLE, makeEdge, makeNode } from '@/test-utils';
import { getNodeValues, type AppEdge, type AppNode, type ShaderNodeData } from '@/types';
import { unwrapCollapsedGroupEdges } from './edgeUtils';
import { planBakeCommit, type BakeCommitSocket, type BakedPicture } from './bakeCommit';

const picture = (remap: BakedPicture['remap'] = null): BakedPicture => ({
  data: {
    registryType: 'imageNode',
    label: 'Image',
    cost: 5,
    values: { imageB64: 'data:image/png;base64,AAAA', width: 256, height: 256, fileName: 'baked.png', colorSpace: 'data' },
  } as ShaderNodeData,
  remap,
});

let next = 0;
const newId = () => `n${++next}`;
const cost = () => 1;
const look = { label: 'Baked P', color: '#334455' };

function at(id: string, type: string, x = 0, y = 0, values: Record<string, string | number> = {}): AppNode {
  const n = makeNode(id, type, values);
  n.position = { x, y };
  return n;
}

/** uv → perlin → mul → Output.color, perlin also → Output.roughness. */
function chain(): { nodes: AppNode[]; edges: AppEdge[] } {
  return {
    nodes: [at('u', 'uv', 0, 0), at('p', 'perlin', 200, 0), at('m', 'mul', 400, 0), at('o', 'output', 600, 0)],
    edges: [
      makeEdge('u', 'out', 'p', 'pos'),
      makeEdge('p', 'out', 'm', 'a'),
      makeEdge('m', 'out', 'o', 'color'),
      makeEdge('p', 'out', 'o', 'roughness'),
    ],
  };
}

const scalar = (remap: BakedPicture['remap'] = null): BakeCommitSocket => ({
  socket: { nodeId: 'p', handleId: 'out' },
  shape: 1,
  picture: picture(remap),
  alpha: null,
});

beforeEach(() => {
  next = 0;
});

describe('planBakeCommit', () => {
  it('moves every wire that carried the socket out onto the Image’s R, and parks the chain', () => {
    const g = chain();
    const plan = planBakeCommit(g.nodes, g.edges, ['p'], [scalar()], newId, cost, look)!;
    const img = plan.nodes.find((n) => n.id === plan.imageIds[0])!;
    expect(img.data.registryType).toBe('imageNode');
    expect(img.position).toEqual({ x: 200, y: 0 });
    const into = (t: string, h: string) => plan.edges.find((e) => e.target === t && e.targetHandle === h);
    expect(into('m', 'a')).toMatchObject({ source: img.id, sourceHandle: 'r' });
    expect(into('o', 'roughness')).toMatchObject({ source: img.id, sourceHandle: 'r' });
    // The UV node fed only the Perlin, so it parks with it; the wire between them stays.
    expect(into('p', 'pos')).toMatchObject({ source: 'u' });
    const frame = plan.nodes.find((n) => n.id === plan.parkGroupId)!;
    expect(frame.type).toBe('group');
    expect(plan.nodes.filter((n) => n.parentId === frame.id).map((n) => n.id).sort()).toEqual(['p', 'u']);
    expect(plan.parked).toBe(2);
    // The frame precedes its members.
    const idx = (id: string) => plan.nodes.findIndex((n) => n.id === id);
    expect(idx(frame.id)).toBeLessThan(idx('u'));
    // Nothing parked feeds anything outside the frame.
    const parked = new Set(['p', 'u']);
    expect(plan.edges.filter((e) => parked.has(e.source) && !parked.has(e.target))).toEqual([]);
  });

  it('a feeder still used elsewhere stays where it is', () => {
    const g = chain();
    g.nodes.push(at('x', 'mul', 400, 200));
    g.edges.push(makeEdge('u', 'out', 'x', 'a'));
    const plan = planBakeCommit(g.nodes, g.edges, ['p'], [scalar()], newId, cost, look)!;
    expect(plan.nodes.find((n) => n.id === 'u')!.parentId).toBeUndefined();
    expect(plan.parked).toBe(1);
  });

  it('a stored range reads back through Multiply by the span and Add of its low end', () => {
    const g = chain();
    const plan = planBakeCommit(g.nodes, g.edges, ['p'], [scalar({ scale: 2, offset: -1 })], newId, cost, look)!;
    const added = plan.nodes.filter((n) => plan.addedIds.includes(n.id));
    const mul = added.find((n) => n.data.registryType === 'mul')!;
    const add = added.find((n) => n.data.registryType === 'add')!;
    expect(getNodeValues(mul).b).toBe(2);
    expect(getNodeValues(add).b).toBe(-1);
    expect(plan.edges.find((e) => e.target === mul.id && e.targetHandle === 'a')).toMatchObject({ source: plan.imageIds[0], sourceHandle: 'r' });
    expect(plan.edges.find((e) => e.target === 'o' && e.targetHandle === 'roughness')).toMatchObject({ source: add.id, sourceHandle: 'out' });
  });

  it('a vec2 is rebuilt from R and G, a vec4 from the Color and a second Image’s R', () => {
    const g = chain();
    const v2 = planBakeCommit(g.nodes, g.edges, ['p'], [{ ...scalar(), shape: 2 }], newId, cost, look)!;
    const vec2 = v2.nodes.find((n) => v2.addedIds.includes(n.id) && n.data.registryType === 'vec2')!;
    expect(v2.edges.filter((e) => e.target === vec2.id).map((e) => [e.sourceHandle, e.targetHandle]).sort()).toEqual([['g', 'y'], ['r', 'x']]);
    expect(v2.edges.find((e) => e.target === 'o' && e.targetHandle === 'roughness')!.source).toBe(vec2.id);

    const v4 = planBakeCommit(g.nodes, g.edges, ['p'], [{ ...scalar(), shape: 4, alpha: picture() }], newId, cost, look)!;
    expect(v4.imageIds).toHaveLength(2);
    const app = v4.nodes.find((n) => v4.addedIds.includes(n.id) && n.data.registryType === 'append')!;
    expect(v4.edges.find((e) => e.target === app.id && e.targetHandle === 'a')).toMatchObject({ source: v4.imageIds[0], sourceHandle: 'out' });
    expect(v4.edges.find((e) => e.target === app.id && e.targetHandle === 'b')).toMatchObject({ source: v4.imageIds[1], sourceHandle: 'r' });
  });

  it('a frame selected WITH its members parks as itself, never inside a second frame', () => {
    const g = chain();
    const frame = { id: 'g', type: 'group', position: { x: 100, y: 100 }, width: 400, height: 200, data: { registryType: 'group', label: 'G', width: 400, height: 200 } } as unknown as AppNode;
    const nodes = [frame, ...g.nodes.map((n) => (n.id === 'u' || n.id === 'p' ? ({ ...n, parentId: 'g' } as AppNode) : n))];
    const plan = planBakeCommit(nodes, g.edges, ['g', 'u', 'p'], [scalar()], newId, cost, look)!;
    expect(plan.parkGroupId).toBe('g');
    expect(plan.nodes.filter((n) => n.type === 'group')).toHaveLength(1);
    expect(plan.parked).toBe(2);
  });

  it('a selected group parks as itself, and the Image sits outside it', () => {
    const g = chain();
    const frame = { id: 'g', type: 'group', position: { x: 100, y: 100 }, width: 400, height: 200, data: { registryType: 'group', label: 'G', width: 400, height: 200 } } as unknown as AppNode;
    const nodes = [frame, ...g.nodes.map((n) => (n.id === 'u' || n.id === 'p' ? ({ ...n, parentId: 'g' } as AppNode) : n))];
    const plan = planBakeCommit(nodes, g.edges, ['g'], [scalar()], newId, cost, look)!;
    expect(plan.parkGroupId).toBe('g');
    const img = plan.nodes.find((n) => n.id === plan.imageIds[0])!;
    expect(img.parentId).toBeUndefined();
    expect(img.position).toEqual({ x: 300, y: 100 }); // the Perlin's ABSOLUTE spot
  });
});

afterAll(() => cancelPendingGraphSave());

describe('commitBake (the store)', () => {
  // A collapse rewires its pill a FRAME later; run that frame at once.
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  beforeEach(() => {
    const g = chain();
    useAppStore.setState({
      nodes: g.nodes,
      edges: g.edges,
      drawings: [],
      past: [],
      future: [],
      ...HISTORY_IDLE,
    });
  });

  it('is ONE undo entry, leaves the park frame collapsed, and undo restores the chain', () => {
    const before = useAppStore.getState();
    const plan = before.commitBake({ selectedIds: ['p'], sockets: [scalar()], layout: 'uv', size: 512 })!;
    expect(plan).not.toBeNull();
    const s = useAppStore.getState();
    expect(s.past).toHaveLength(1);
    expect(s.coalescingHistory).toBe(false);
    const frame = s.nodes.find((n) => n.id === plan.parkGroupId)!;
    expect((frame.data as { collapsed?: boolean }).collapsed).toBe(true);
    // Through the collapse, the Output still reads the Image.
    const real = unwrapCollapsedGroupEdges(s.nodes, s.edges);
    expect(real.find((e) => e.target === 'o' && e.targetHandle === 'roughness')!.source).toBe(plan.imageIds[0]);
    s.undo();
    const u = useAppStore.getState();
    expect(u.nodes.map((n) => n.id).sort()).toEqual(['m', 'o', 'p', 'u']);
    expect(u.edges.find((e) => e.target === 'o' && e.targetHandle === 'roughness')!.source).toBe('p');
  });

  it('a consumer inside a collapsed group is rewired through it and the group collapses again', () => {
    // Collapse a group holding the Multiply, then bake the Perlin feeding it.
    const st = useAppStore.getState();
    const gid = st.groupSelection(['m', 'o']);
    expect(gid).not.toBeNull();
    useAppStore.getState().toggleGroupCollapsed(gid!);
    useAppStore.setState({ past: [], future: [], ...HISTORY_IDLE });
    const plan = useAppStore.getState().commitBake({ selectedIds: ['p'], sockets: [scalar()], layout: 'uv', size: 512 })!;
    const s = useAppStore.getState();
    expect(s.past).toHaveLength(1);
    expect((s.nodes.find((n) => n.id === gid)!.data as { collapsed?: boolean }).collapsed).toBe(true);
    const real = unwrapCollapsedGroupEdges(s.nodes, s.edges);
    expect(real.find((e) => e.target === 'm' && e.targetHandle === 'a')!.source).toBe(plan.imageIds[0]);
  });

  it('a COLLAPSED group bakes as itself: its pill loses the output that now leaves the Image', () => {
    const gid = useAppStore.getState().groupSelection(['u', 'p'])!;
    useAppStore.getState().toggleGroupCollapsed(gid);
    useAppStore.setState({ past: [], future: [], ...HISTORY_IDLE });
    const pill = () => useAppStore.getState().nodes.find((n) => n.id === gid)!;
    expect((pill().data as { collapsedOutputs?: unknown[] }).collapsedOutputs).toHaveLength(1);
    const plan = useAppStore.getState().commitBake({ selectedIds: [gid], sockets: [scalar()], layout: 'uv', size: 512 })!;
    expect(plan.parkGroupId).toBe(gid);
    const s = useAppStore.getState();
    expect(s.past).toHaveLength(1);
    expect((pill().data as { collapsed?: boolean }).collapsed).toBe(true);
    expect((pill().data as { collapsedOutputs?: unknown[] }).collapsedOutputs).toEqual([]);
    const real = unwrapCollapsedGroupEdges(s.nodes, s.edges);
    expect(real.find((e) => e.target === 'm' && e.targetHandle === 'a')!.source).toBe(plan.imageIds[0]);
    expect(real.find((e) => e.target === 'o' && e.targetHandle === 'roughness')!.source).toBe(plan.imageIds[0]);
  });

  it('refuses (writes nothing) when a socket’s node is gone', () => {
    const r = useAppStore.getState().commitBake({
      selectedIds: ['gone'],
      sockets: [{ ...scalar(), socket: { nodeId: 'gone', handleId: 'out' } }],
      layout: 'uv',
      size: 512,
    });
    expect(r).toBeNull();
    expect(useAppStore.getState().past).toHaveLength(0);
  });
});
