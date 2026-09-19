import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { makeNode, makeEdge } from '@/test-utils';
import { graphToCode } from '@/engine/graphToCode';
import { buildShaderModule } from '@/engine/tslCodeProcessor';
import { contributingOutputs, materialPartsMirrorPlanAcross } from '@/utils/outputMaterials';
import { buildGltfSectionGraph } from '@/engine/gltfSectionBuilder';
import { encodeRequests } from '@/utils/gltfImportPlan';
import { encodeGltfImages } from '@/utils/gltfTextureEncode';
import { blenderGlb, fakeEncoder, fakeStash, readOk } from '@/engine/gltfImportFixtures';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import type { AppNode, AppEdge } from '@/types';
import {
  previewGraph,
  previewableOutputs,
  resolveNodePreview,
  PREVIEW_OUTPUT_ID,
  PREVIEW_CHANNEL,
} from './nodePreview';

/**
 * Preview mode (utils/nodePreview.ts): one node's output routed to the
 * Output's Color for the 3D view only. These pin the DERIVED graph — every
 * other sink input dropped, the Output cleaned, one route added — against the
 * real codegen, plus the source-level wiring nothing else would catch.
 */

const gen = (nodes: AppNode[], edges: AppEdge[]) => graphToCode(nodes, edges, NODE_REGISTRY);
const returnBlock = (code: string) => code.slice(code.lastIndexOf('return'));
/** Codegen's Color-only shape is the bare `return <expr>;` (no channel object);
 *  with any other channel present it is `{ color: <expr>, … }`. A vec2 source
 *  is widened to `vec3(ref)` by codegen's own rule on either path. */
const colorOnly = (varName: string) => new RegExp(`(color: |return )vec3\\(${varName}\\)`);
const data = (n: AppNode) => n.data as Record<string, unknown>;

describe('previewableOutputs', () => {
  it('offers the registry outputs, a Data node’s columns, and nothing for a sink', () => {
    expect(previewableOutputs(makeNode('u', 'uv')).map((p) => p.id)).toEqual(['out']);
    expect(previewableOutputs(makeNode('h', 'toHsl')).map((p) => p.id)).toEqual(['out', 'h', 's', 'l']);
    const dn = makeNode('d', 'dataNode');
    data(dn).dynamicOutputs = [
      { id: 'col0', label: 'temp', dataType: 'float' },
      { id: 'col1', label: 'wind', dataType: 'float' },
    ];
    expect(previewableOutputs(dn).map((p) => p.id)).toEqual(['col0', 'col1']);
    expect(previewableOutputs(makeNode('o', 'output'))).toEqual([]);
    const rm = { ...makeNode('rm', 'raymarchOutput'), type: 'raymarchOutput' } as AppNode;
    expect(previewableOutputs(rm)).toEqual([]);
    const group = { ...makeNode('g', 'group'), type: 'group' } as AppNode;
    expect(previewableOutputs(group)).toEqual([]);
  });
});

describe('resolveNodePreview', () => {
  it('keeps a live target and drops one whose node or socket is gone', () => {
    const nodes = [makeNode('u', 'uv'), makeNode('o', 'output')];
    expect(resolveNodePreview(nodes, { nodeId: 'u', handleId: 'out' })).toEqual({ nodeId: 'u', handleId: 'out' });
    expect(resolveNodePreview(nodes, { nodeId: 'gone', handleId: 'out' })).toBeNull();
    expect(resolveNodePreview(nodes, { nodeId: 'u', handleId: 'col3' })).toBeNull();
    expect(resolveNodePreview(nodes, null)).toBeNull();
  });
});

describe('previewGraph', () => {
  it('routes the previewed socket to Color and drops every other input of the Output', () => {
    const out = makeNode('out', 'output');
    const a = makeNode('a', 'float', { value: 0.2 });
    const b = makeNode('b', 'float', { value: 0.7 });
    const c = makeNode('c', 'uv');
    const nodes = [out, a, b, c];
    const edges = [makeEdge('a', 'out', 'out', 'color'), makeEdge('b', 'out', 'out', 'roughness')];

    const real = gen(nodes, edges).code;
    expect(returnBlock(real)).toMatch(/roughness:/);

    const pg = previewGraph(nodes, edges, { nodeId: 'c', handleId: 'out' });
    expect(pg.edges).toHaveLength(1);
    expect(pg.edges[0]).toMatchObject({ source: 'c', sourceHandle: 'out', target: 'out', targetHandle: PREVIEW_CHANNEL });

    const res = gen(pg.nodes, pg.edges);
    const ret = returnBlock(res.code);
    expect(ret).not.toMatch(/roughness:/);
    // The previewed node feeds Color — and nothing else does.
    expect(ret).toMatch(colorOnly(res.varNames.get('c')!));
    expect(ret).not.toContain(res.varNames.get('a')!);

    // Inputs untouched: the store's arrays are never mutated.
    expect(nodes).toHaveLength(4);
    expect(edges).toHaveLength(2);
    expect(edges.map((e) => e.target)).toEqual(['out', 'out']);
  });

  it('strips the Output’s stored channel values and added materials, keeps its material settings', () => {
    const out = makeNode('out', 'output', { roughness: 0.3, emissive: '#ff0000' });
    data(out).exposedPorts = ['color', 'roughness', 'emissive'];
    data(out).materialSettings = { side: 'double' };
    data(out).materials = [{ meshTargets: ['Body'] }];
    const c = makeNode('c', 'uv');
    const nodes = [out, c];

    const real = returnBlock(gen(nodes, []).code);
    expect(real).toMatch(/roughness: float\(0\.3\)/);
    expect(real).toMatch(/emissive: color\(0xff0000\)/);

    const pg = previewGraph(nodes, [], { nodeId: 'c', handleId: 'out' });
    const cleaned = pg.nodes.find((n) => n.id === 'out')!;
    expect(data(cleaned).values).toBeUndefined();
    expect(data(cleaned).materials).toBeUndefined();
    expect(data(cleaned).materialSettings).toEqual({ side: 'double' });
    expect(data(cleaned).activeOutput).toBe(true);
    const ret = returnBlock(gen(pg.nodes, pg.edges).code);
    expect(ret).not.toMatch(/roughness:/);
    expect(ret).not.toMatch(/emissive:/);
    expect(ret).not.toMatch(/parts:/);
  });

  it('synthesizes an Output when the graph has none, so the view still renders the node', () => {
    const nodes = [makeNode('a', 'float', { value: 0.5 }), makeNode('c', 'uv')];
    const pg = previewGraph(nodes, [], { nodeId: 'c', handleId: 'out' });
    expect(pg.nodes.some((n) => n.id === PREVIEW_OUTPUT_ID)).toBe(true);
    expect(pg.edges[0].target).toBe(PREVIEW_OUTPUT_ID);
    const res = gen(pg.nodes, pg.edges);
    expect(returnBlock(res.code)).toMatch(colorOnly(res.varNames.get('c')!));
    // The synthesized node never reaches the input arrays.
    expect(nodes).toHaveLength(2);
  });

  it('targets the FLAGGED Output among several, DROPS every other plain Output, and clears a Raymarch flag', () => {
    const out1 = makeNode('out1', 'output');
    const out2 = makeNode('out2', 'output');
    data(out2).activeOutput = true;
    const rm = { ...makeNode('rm', 'raymarchOutput'), type: 'raymarchOutput' } as AppNode;
    data(rm).activeOutput = true;
    const c = makeNode('c', 'uv');
    const edges = [makeEdge('c', 'out', 'out1', 'color')];
    const pg = previewGraph([out1, out2, rm, c], edges, { nodeId: 'c', handleId: 'out' });
    expect(pg.edges).toHaveLength(1);
    expect(pg.edges[0].target).toBe('out2');
    expect(data(pg.nodes.find((n) => n.id === 'out2')!).activeOutput).toBe(true);
    // The other plain Output is GONE, not merely emptied: left standing it
    // would go on emitting its own `parts` entry beside the previewed socket.
    expect(pg.nodes.some((n) => n.id === 'out1')).toBe(false);
    // A Raymarch Output stays and only loses its flag — unwired AND unflagged,
    // it cannot drive, and removing it would be a bigger rewrite than needed.
    expect(data(pg.nodes.find((n) => n.id === 'rm')!).activeOutput).toBeUndefined();
  });

  it('silences a DRIVING Raymarch Output: its wires drop and the plain Output emits', () => {
    const rm = { ...makeNode('rm', 'raymarchOutput'), type: 'raymarchOutput' } as AppNode;
    const out = makeNode('out', 'output');
    const f = makeNode('f', 'float', { value: 0.4 });
    const c = makeNode('c', 'uv');
    const nodes = [out, rm, f, c];
    const edges = [makeEdge('f', 'out', 'rm', 'field')];
    expect(gen(nodes, edges).code).toMatch(/Loop\(/);

    const pg = previewGraph(nodes, edges, { nodeId: 'c', handleId: 'out' });
    expect(pg.edges.map((e) => e.target)).toEqual(['out']);
    const res = gen(pg.nodes, pg.edges);
    expect(res.code).not.toMatch(/Loop\(/);
    expect(returnBlock(res.code)).toMatch(colorOnly(res.varNames.get('c')!));
  });

  /**
   * THE multi-Output case, and the reason rule 2 removes rather than cleans.
   *
   * One Output node per material is the ORDINARY shape of any GLB-imported
   * document, and a targeted Output emits its own `materialParts` / `parts`
   * entry no matter how thoroughly the anchor is cleaned. Cleaning one node
   * therefore landed the previewed socket on whatever meshes that node shaded
   * while every other material carried on painting the model — the previewed
   * socket invisible on most of it, with nothing on screen to explain why.
   *
   * The document is built by the REAL importer (`buildGltfSectionGraph` over a
   * real fixture GLB), never hand-assembled to what I believe the split shape
   * is: a fixture written to my own idea of it can pass while production emits
   * something else.
   */
  it('a multi-material GLB document previews on the WHOLE model: one Output, no parts table', async () => {
    const m = readOk(blenderGlb());
    const materials = m.materials.filter((x) => x.usage.primitives > 0).map((x) => x.index);
    const { requests } = encodeRequests(m, materials);
    const { encoded } = await encodeGltfImages(m, requests, {
      modelName: 'model.glb',
      maxDim: null,
      deviceMaxDim: 2048,
      ignoreLimits: false,
      budgetChars: Infinity,
      encode: fakeEncoder([]),
      stash: fakeStash(),
    });
    const built = buildGltfSectionGraph(m, { materials, encoded });
    const probe = makeNode('probe', 'uv');
    const nodes = [...built.nodes, probe];

    // The document really is multi-Output and really does emit a table — the
    // vacuity guard, so the assertions below cannot pass over an empty case.
    const outs = (ns: AppNode[]) => ns.filter((n) => n.data.registryType === 'output');
    expect(outs(nodes).length).toBeGreaterThan(1);
    const before = gen(nodes, built.edges).code;
    expect(before).toMatch(/materialParts: \{/);
    expect(before).toContain('modelSignature: { materials: [');

    const pg = previewGraph(nodes, built.edges, { nodeId: 'probe', handleId: 'out' });
    expect(outs(pg.nodes)).toHaveLength(1);
    const res = gen(pg.nodes, pg.edges);
    expect(returnBlock(res.code)).toMatch(colorOnly(res.varNames.get('probe')!));
    // Nothing else paints: no per-material table of either kind, and no
    // signature, so every mesh takes the previewed socket.
    expect(res.code).not.toMatch(/materialParts: \{/);
    expect(res.code).not.toMatch(/\bparts: \{/);
    expect(res.code).not.toContain('modelSignature');

    // …and in the MODULE the preview actually runs. ShaderPreview builds it
    // from `previewCode` but hands it a mirror plan derived from the REAL
    // store nodes, so the loader-0.6 mirrors are the one way per-mesh `parts`
    // could come back behind the derived graph's back. They cannot: a mirror
    // is emitted only for an index that emitted a BODY (tslCodeProcessor's
    // `indexBodies` gate), and the preview code declares no index at all.
    const mirror = materialPartsMirrorPlanAcross(contributingOutputs(nodes));
    expect(mirror.length).toBeGreaterThan(0); // the plan is real, so this is not vacuous
    const module = buildShaderModule(res.code, { materialPartsMirror: mirror });
    expect(module).not.toMatch(/\bparts: \{/);
    expect(module).not.toContain('materialPartsMirror');

    // The store's arrays are untouched, as for every other rewrite here.
    expect(outs(nodes).length).toBeGreaterThan(1);
  });

  it('name-targeted Outputs drop too, so a `parts` document previews on the whole model', () => {
    const def = makeNode('def', 'output');
    const body = makeNode('body', 'output');
    data(body).meshTargets = ['Body'];
    data(body).emitOrder = 1;
    const glass = makeNode('glass', 'output');
    data(glass).meshTargets = ['Glass'];
    data(glass).emitOrder = 2;
    const red = makeNode('red', 'color', { hex: '#ff0000' });
    const c = makeNode('c', 'uv');
    const nodes = [def, body, glass, red, c];
    const edges = [makeEdge('red', 'out', 'body', 'color'), makeEdge('red', 'out', 'glass', 'color')];

    expect(gen(nodes, edges).code).toMatch(/\bparts: \{/);

    const pg = previewGraph(nodes, edges, { nodeId: 'c', handleId: 'out' });
    expect(pg.nodes.filter((n) => n.data.registryType === 'output')).toHaveLength(1);
    const res = gen(pg.nodes, pg.edges);
    expect(res.code).not.toMatch(/\bparts: \{/);
    expect(returnBlock(res.code)).toMatch(colorOnly(res.varNames.get('c')!));
  });

  it('routes through a collapsed group’s boundary socket by unwrapping first', () => {
    const out = makeNode('out', 'output');
    const a = makeNode('a', 'float', { value: 0.2 });
    const c = makeNode('c', 'uv');
    const group = {
      ...makeNode('g', 'group'),
      type: 'group',
      data: {
        collapsed: true,
        collapsedOutputs: [{ socketId: 'gout', originalNodeId: 'a', originalHandleId: 'out' }],
        collapsedInputs: [],
      },
    } as unknown as AppNode;
    // The VISUAL boundary edge: the collapsed group feeds Color on `a`'s behalf.
    const boundary = makeEdge('g', 'gout', 'out', 'color');
    const pg = previewGraph([out, a, c, group], [boundary], { nodeId: 'c', handleId: 'out' });
    expect(pg.edges).toHaveLength(1);
    expect(pg.edges[0].source).toBe('c');
  });
});

describe('preview mode wiring (source pins)', () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const editor = read('../components/NodeEditor/NodeEditor.tsx');
  const engine = read('../hooks/useSyncEngine.ts');
  const menu = read('../components/NodeEditor/menus/menuShared.tsx');

  it('⌘/Ctrl+click is Preview mode, so those keys left the multi-select set (Shift stays)', () => {
    expect(editor).toMatch(/const MULTI_SELECT_KEYS = \['Shift'\];/);
    expect(editor).toMatch(/if \(e\.metaKey \|\| e\.ctrlKey\) \{\s*\n\s*lastActivationRef\.current = null;/);
  });

  it('the outside-press closer is CAPTURE-phase pointerdown, exempting the keep selector and the middle button', () => {
    const i = editor.indexOf('const onPointerDown = (e: PointerEvent) => {\n      if (e.button === 1) return;');
    expect(i).toBeGreaterThan(-1);
    const block = editor.slice(i, i + 900);
    expect(block).toContain('PREVIEW_KEEP_SELECTOR');
    expect(block).toContain("document.addEventListener('pointerdown', onPointerDown, true)");
  });

  it('the route line is mounted and the canvas carries fs-previewing', () => {
    expect(editor).toContain('<PreviewRoute />');
    expect(editor).toContain("previewSrcId ? ' fs-previewing' : ''");
  });

  it('the sync engine emits previewCode from the derived graph and ends the mode on a code→graph pass', () => {
    expect(engine).toContain("setCode(result.code, 'graph', previewText)");
    expect(engine).toMatch(/previewGraph\(nodes, edges, live\)/);
    const sync = engine.slice(engine.indexOf('const doCodeSync'), engine.indexOf('isDirectAssignmentCode(codeStr)'));
    expect(sync).toContain('setNodePreview(null)');
  });

  it('every per-node settings menu gets the row through the shared footer', () => {
    expect(menu).toContain('previewableOutputs(node)');
    expect(menu).toContain("t('Stop preview', language)");
  });
});
