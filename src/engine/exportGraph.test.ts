import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import type { AppEdge, AppNode } from '@/types';
import { useAppStore, cancelPendingGraphSave } from '@/store/useAppStore';
import { makeEdge, makeNode } from '@/test-utils';
import { readZip } from '@/utils/zipReader';
import { graphToCode } from './graphToCode';
import { extractProjectState } from './fastShadersProject';
import {
  connectedExportIds,
  planExportGraph,
  pruneToConnected,
  remapUniformKeys,
  unconnectedNodeCount,
} from './exportGraph';
import {
  announceExportDelivered,
  buildShaderBundle,
  buildShaderExportChecked,
  type GlbExportUi,
  type ShaderExport,
} from './exportShader';

/**
 * EXPORT carries only the nodes that feed an Output unless the popover's
 * "Include unconnected nodes" row is ticked (engine/exportGraph.ts). The pure
 * half is pinned first, then the real store + composer: what the FILE holds.
 */

const group = (id: string, extra: Record<string, unknown> = {}, parentId?: string): AppNode =>
  ({
    id,
    type: 'group',
    position: { x: 0, y: 0 },
    ...(parentId ? { parentId } : {}),
    data: { registryType: 'group', label: id, color: '#888888', width: 200, height: 100, ...extra },
  }) as unknown as AppNode;

const note = (id: string, parentId?: string): AppNode =>
  ({
    id,
    type: 'note',
    position: { x: 0, y: 0 },
    ...(parentId ? { parentId } : {}),
    data: { registryType: 'note', title: '', body: 'a note' },
  }) as unknown as AppNode;

const inside = (n: AppNode, parentId: string): AppNode => ({ ...n, parentId }) as AppNode;

/** f1 → add1 → out1, with a spare constant, a dead-end branch off the chain and a Sin viewer. */
function chain(): { nodes: AppNode[]; edges: AppEdge[] } {
  return {
    nodes: [
      makeNode('f1', 'float', { value: 0.5 }),
      makeNode('add1', 'add'),
      makeNode('out1', 'output'),
      makeNode('spare', 'float', { value: 3 }),
      makeNode('dead', 'multiply'),
    ],
    edges: [
      makeEdge('f1', 'out', 'add1', 'a'),
      makeEdge('add1', 'out', 'out1', 'color'),
      // Wired FROM the chain but into nothing: not upstream of any Output.
      makeEdge('add1', 'out', 'dead', 'a'),
    ],
  };
}

describe('connectedExportIds', () => {
  it('keeps every sink and everything upstream of one — nothing else', () => {
    const { nodes, edges } = chain();
    expect([...connectedExportIds(nodes, edges)!].sort()).toEqual(['add1', 'f1', 'out1']);
  });

  it('answers null when nothing anchors a prune (no Output at all)', () => {
    const nodes = [makeNode('f1', 'float'), makeNode('add1', 'add')];
    expect(connectedExportIds(nodes, [makeEdge('f1', 'out', 'add1', 'a')])).toBeNull();
    // …and the prune then keeps the SAME arrays.
    const r = pruneToConnected(nodes, []);
    expect(r.nodes).toBe(nodes);
    expect(r.omitted).toBe(0);
  });

  it('keeps an unwired Output: a sink is the anchor, wired or not', () => {
    const nodes = [makeNode('out1', 'output'), makeNode('f1', 'float')];
    expect([...connectedExportIds(nodes, [])!]).toEqual(['out1']);
  });

  it('keeps a group frame holding a kept node, up the whole parent chain, and drops an empty one', () => {
    const { nodes, edges } = chain();
    const all = [
      group('outer'),
      group('inner', {}, 'outer'),
      group('empty'),
      ...nodes.map((n) => (n.id === 'f1' ? inside(n, 'inner') : n.id === 'spare' ? inside(n, 'empty') : n)),
    ];
    const keep = connectedExportIds(all, edges)!;
    expect(keep.has('outer')).toBe(true);
    expect(keep.has('inner')).toBe(true);
    expect(keep.has('empty')).toBe(false);
    expect(keep.has('spare')).toBe(false);
  });

  it('keeps a COLLAPSED group whole: its sockets name member ids', () => {
    const { nodes, edges } = chain();
    const all = [
      group('g', { collapsed: true }),
      ...nodes.map((n) => (n.id === 'f1' || n.id === 'spare' ? inside(n, 'g') : n)),
    ];
    const keep = connectedExportIds(all, edges)!;
    expect(keep.has('g')).toBe(true);
    expect(keep.has('spare')).toBe(true); // unconnected, but inside the kept collapsed group
    expect(keep.has('dead')).toBe(false);
  });

  it('keeps a note on the board; a note inside a group goes with that group', () => {
    const { nodes, edges } = chain();
    const all = [
      group('kept'),
      group('gone'),
      note('free'),
      note('inKept', 'kept'),
      note('inGone', 'gone'),
      ...nodes.map((n) => (n.id === 'add1' ? inside(n, 'kept') : n.id === 'spare' ? inside(n, 'gone') : n)),
    ];
    const keep = connectedExportIds(all, edges)!;
    expect(keep.has('free')).toBe(true);
    expect(keep.has('inKept')).toBe(true);
    expect(keep.has('inGone')).toBe(false);
    expect(keep.has('gone')).toBe(false);
  });

  it('survives a parentId cycle from a hostile file', () => {
    const a = group('a', {}, 'b');
    const b = group('b', {}, 'a');
    const out = inside(makeNode('out1', 'output'), 'a');
    const keep = connectedExportIds([a, b, out], [])!;
    expect([...keep].sort()).toEqual(['a', 'b', 'out1']);
  });
});

describe('pruneToConnected', () => {
  it('drops the unconnected nodes and every wire touching them; counts no group frame', () => {
    const { nodes, edges } = chain();
    const r = pruneToConnected([group('empty'), ...nodes], edges);
    expect(r.nodes.map((n) => n.id)).toEqual(['f1', 'add1', 'out1']);
    expect(r.edges.map((e) => e.target)).toEqual(['add1', 'out1']);
    expect(r.omitted).toBe(2); // spare + dead; the empty frame is not a node to the user
    expect(unconnectedNodeCount(nodes, edges)).toBe(2);
  });

  it('returns the SAME arrays when nothing is left out (byte-identical whole export)', () => {
    const nodes = [makeNode('f1', 'float'), makeNode('out1', 'output')];
    const edges = [makeEdge('f1', 'out', 'out1', 'color')];
    const r = pruneToConnected(nodes, edges);
    expect(r.nodes).toBe(nodes);
    expect(r.edges).toBe(edges);
  });
});

describe('planExportGraph', () => {
  it("'whole' is the store's own arrays and code", () => {
    const { nodes, edges } = chain();
    const code = graphToCode(nodes, edges).code;
    const g = planExportGraph({ nodes, edges, code }, 'whole');
    expect(g.nodes).toBe(nodes);
    expect(g.edges).toBe(edges);
    expect(g.code).toBe(code);
    expect(g.omitted).toBe(0);
  });

  it("'connected' regenerates the module from the pruned graph", () => {
    const { nodes, edges } = chain();
    const code = graphToCode(nodes, edges).code;
    const g = planExportGraph({ nodes, edges, code }, 'connected');
    expect(g.omitted).toBe(2);
    expect(g.code).toBe(graphToCode(g.nodes, g.edges).code);
    // The spare constant was emitted before, not now.
    expect(code).toContain('float(3)');
    expect(g.code).not.toContain('float(3)');
  });

  it('exports the whole canvas when the code panel is not the graph’s own code', () => {
    // Typed and not applied, an Apply codeToGraph could not fully walk, or a
    // direct-assignment script: regenerating would silently replace it.
    const { nodes, edges } = chain();
    const typed = graphToCode(nodes, edges).code + '\n// my edit\n';
    const g = planExportGraph({ nodes, edges, code: typed }, 'connected');
    expect(g.nodes).toBe(nodes);
    expect(g.code).toBe(typed);
    expect(g.omitted).toBe(0);
  });

  it('re-keys tuned uniforms when a left-out property freed the name a survivor takes', () => {
    // Two properties both named `speed`: the unconnected one claims `speed`,
    // the wired one is emitted as `speed2`. Pruned, the wired one IS `speed`.
    const nodes = [
      makeNode('pA', 'property_float', { name: 'speed', value: 1 }),
      makeNode('pB', 'property_float', { name: 'speed', value: 2 }),
      makeNode('out1', 'output'),
      makeNode('dead', 'multiply'),
    ];
    const edges = [makeEdge('pB', 'out', 'out1', 'roughness'), makeEdge('pA', 'out', 'dead', 'a')];
    const full = graphToCode(nodes, edges);
    expect(full.varNames.get('pA')).toBe('speed');
    expect(full.varNames.get('pB')).toBe('speed2');
    const g = planExportGraph({ nodes, edges, code: full.code }, 'connected');
    expect(g.code).toContain('const speed = uniform(');
    expect(g.code).not.toContain('speed2');
    expect(g.uniformKeys).not.toBeNull();
    // pA's tuning is dropped; pB's moves to the name the file now uses.
    expect({ ...remapUniformKeys({ speed: 0.1, speed2: 0.9, other: 5 }, g.uniformKeys) }).toEqual({ speed: 0.9, other: 5 });
  });
});

describe('remapUniformKeys', () => {
  it('is the identity without a remap, and builds a null-prototype map with one', () => {
    const rec = { a: 1 };
    expect(remapUniformKeys(rec, null)).toBe(rec);
    expect(remapUniformKeys(undefined, { drop: new Set(), rename: new Map() })).toBeUndefined();
    const out = remapUniformKeys({ __proto__x: 1, b: 2 }, { drop: new Set(['b']), rename: new Map() })!;
    expect(Object.getPrototypeOf(out)).toBeNull();
    expect(JSON.stringify(out)).toBe('{"__proto__x":1}');
  });
});

/** The composer over the REAL store: what the downloaded file holds. */
describe('buildShaderExportChecked scope (real store)', () => {
  const PNG = 'data:image/png;base64,AAAA';
  const nodes = () => [
    makeNode('f1', 'float', { value: 0.5 }),
    makeNode('out1', 'output'),
    makeNode('img', 'imageNode', { imageB64: PNG, width: 1, height: 1, fileName: 'tex.png', colorSpace: 'color' }),
    makeNode('spare', 'float', { value: 3 }),
  ];
  const edges = () => [makeEdge('f1', 'out', 'out1', 'roughness')];
  const idle: GlbExportUi = {
    begin: () => {},
    progress: () => {},
    failed: async () => 'cancel',
    tooLarge: async () => 'cancel',
    ready: async () => true,
    end: () => {},
  };
  const run = (scope?: 'connected' | 'whole') =>
    buildShaderExportChecked({ preflight: async () => 'cancel', glb: idle, delivery: 'write', ...(scope ? { scope } : {}) });
  const jsOf = async (e: ShaderExport): Promise<string> =>
    e.kind === 'glb' || e.kind === 'js'
      ? new TextDecoder().decode(e.bytes)
      : new TextDecoder().decode((await readZip(e.bytes)).find((x) => x.name.endsWith('.js'))!.data);

  beforeAll(() => {
    vi.stubGlobal('localStorage', undefined);
  });
  beforeEach(() => {
    cancelPendingGraphSave();
    const ns = nodes();
    const es = edges();
    useAppStore.setState({
      nodes: ns,
      edges: es,
      code: graphToCode(ns, es).code,
      drawings: [],
      shaderPalettes: [],
      shaderName: 'Scope',
      exportIncludeMesh: false,
      previewMesh: null,
      importNote: null,
    });
  });
  afterAll(() => {
    cancelPendingGraphSave();
    useAppStore.setState({ nodes: [], edges: [], code: '', drawings: [], shaderPalettes: [], importNote: null });
    vi.unstubAllGlobals();
  });

  it("'connected' ships neither the unwired nodes nor the unwired image, and counts them", async () => {
    const out = (await run('connected'))!;
    // The only image was unwired, so the zip collapses to a bare .js.
    expect(out.kind).toBe('js');
    expect(out.leftOut).toBe(2);
    const js = await jsOf(out);
    expect(js).not.toContain(PNG);
    const project = extractProjectState(js)!.project;
    expect(project.graph.nodes.map((n) => n.id)).toEqual(['f1', 'out1']);
  });

  it("'whole' (and an absent scope) is byte-identical to buildShaderBundle()", async () => {
    const ref = buildShaderBundle();
    expect(ref.kind).toBe('zip');
    for (const out of [(await run('whole'))!, (await run())!]) {
      expect(out.leftOut).toBeUndefined();
      expect(out.bytes).toEqual(ref.bytes);
    }
  });

  it('the delivery says what it left out, once', () => {
    announceExportDelivered({ ...buildShaderBundle(), leftOut: 2 });
    expect(useAppStore.getState().importNote?.lines).toEqual([{ kind: 'export-left-out', count: 2 }]);
    useAppStore.setState({ importNote: null });
    announceExportDelivered(buildShaderBundle());
    expect(useAppStore.getState().importNote).toBeNull();
  });
});
