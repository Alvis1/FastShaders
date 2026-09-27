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
  previewTargetId,
} from './nodePreview';
import { activeSink, drivingSplatOutput } from './sdfPartition';
import { previewRouteTargetId, isActiveSinkSelector } from '@/components/NodeEditor/nodes/activeSinkSelector';

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

/**
 * A SPLAT document. While a Splat Output is the active sink the preview shows
 * a Gaussian-splat scene, which only a module returning `splat` can shade — a
 * plain Output there would preview the node on nothing. So the route ends on
 * THAT Splat Output's Color socket, the node cleaned and flagged at its own id.
 */
describe('previewGraph on a splat document', () => {
  const splatNode = (values: Record<string, unknown> = {}, id = 'sp'): AppNode => {
    const n = { ...makeNode(id, 'splatOutput'), type: 'splatOutput' } as AppNode;
    return { ...n, data: { ...n.data, values } } as AppNode;
  };
  /** pos → sdCircle → Cut (so the splat DRIVES, unflagged), a plain Output
   *  beside it, and a probe: length(positionLocal). */
  const doc = (values: Record<string, unknown> = {}) => {
    const nodes = [
      makeNode('out', 'output'),
      makeNode('pos', 'positionLocal'),
      makeNode('sd', 'sdCircle'),
      makeNode('len', 'length'),
      splatNode(values),
    ];
    const edges = [
      makeEdge('pos', 'out', 'sd', 'p'),
      makeEdge('sd', 'out', 'sp', 'cut'),
      makeEdge('pos', 'out', 'len', 'v'),
    ];
    return { nodes, edges };
  };

  it('offers nothing to preview on the sink itself', () => {
    expect(previewableOutputs(splatNode())).toEqual([]);
  });

  it('routes to the ACTIVE Splat Output’s Color, drops every plain Output and every other sink edge', () => {
    const { nodes, edges } = doc();
    expect(drivingSplatOutput(nodes, edges)?.id).toBe('sp'); // the vacuity guard
    expect(gen(nodes, edges).code).toContain('return { splat: { shape: sp1Shape } };');

    const pg = previewGraph(nodes, edges, { nodeId: 'len', handleId: 'out' });
    // One route, into the splat's own Color socket; the Cut wire is gone.
    const route = pg.edges.filter((e) => e.target === 'sp');
    expect(route).toHaveLength(1);
    expect(route[0]).toMatchObject({ source: 'len', sourceHandle: 'out', target: 'sp', targetHandle: PREVIEW_CHANNEL });
    expect(pg.edges.some((e) => e.targetHandle === 'cut')).toBe(false);
    // The plain Output is GONE — it could not shade a splat scene anyway.
    expect(pg.nodes.some((n) => n.id === 'out')).toBe(false);
    expect(pg.nodes.some((n) => n.id === PREVIEW_OUTPUT_ID)).toBe(false);
    // The splat is the flagged sink of the derived graph, at its own id.
    expect(activeSink(pg.nodes, pg.edges)?.id).toBe('sp');

    const res = gen(pg.nodes, pg.edges);
    // Every splat painted with the probe, evaluated at its centre `p`; no cut,
    // no move, no stored values.
    expect(res.code).toContain('return { splat: { shade: sp1Shade } };');
    expect(res.code).toContain(`return vec4(vec3(${res.varNames.get('len')!}), 1);`);
    expect(res.code).toMatch(/const sp1Shade = Fn\(\(\[p, pw, n, c\]\) => \{\n\s+const positionLocal1 = p;/);
    expect(res.code).not.toContain('sp1Shape');

    // The store's arrays are never mutated.
    expect(nodes).toHaveLength(5);
    expect(edges.map((e) => e.targetHandle)).toEqual(['p', 'cut', 'v']);
  });

  it('cleans the splat: its swatch, Opacity, Invert, Feather and Size do not survive — and it REPLACES, so the value shows', () => {
    const { nodes, edges } = doc({ color: '#ff0000', opacity: 0.3, invert: true, feather: 0.2, size: 2 });
    const before = gen(nodes, edges).code;
    expect(before).toContain('invert: true');
    expect(before).toContain('color(0xff0000)');

    const pg = previewGraph(nodes, edges, { nodeId: 'len', handleId: 'out' });
    const cleaned = pg.nodes.find((n) => n.id === 'sp')!;
    // Only `replaceColor`: previewing a node means seeing ITS value, not the
    // splat's captured colour tinted by it (utils/splatColor.ts).
    expect(data(cleaned).values).toEqual({ replaceColor: true });
    // A LIT splat stays lit behind an IDENTITY light, so a previewed Normal
    // chain reads the surface normal the real shader reads, unshaded.
    const lit = doc({ lit: true, lightX: -1, lightColor: '#ff0000', ambient: '#102030' });
    const litPg = previewGraph(lit.nodes, lit.edges, { nodeId: 'len', handleId: 'out' });
    expect(data(litPg.nodes.find((n) => n.id === 'sp')!).values).toEqual({ replaceColor: true, lit: true, lightColor: '#000000', ambient: '#ffffff' });
    const litCode = gen(litPg.nodes, litPg.edges).code;
    expect(litCode).toContain('lit: true');
    expect(litCode).toContain('add(mul(color(0x000000), max(dot(n, normalize(add(vec3(0.6, 0.8, 0.5), 1e-9))), 0)), color(0xffffff))');
    expect(data(cleaned).activeOutput).toBe(true);
    expect(data(cleaned).registryType).toBe('splatOutput');
    expect(cleaned.type).toBe('splatOutput');
    const code = gen(pg.nodes, pg.edges).code;
    expect(code).toContain('return { splat: { shade: sp1Shade } };');
    for (const gone of ['invert', 'feather', 'size:', '0xff0000', '0.3']) expect(code, gone).not.toContain(gone);
  });

  it('previewTargetId names the splat while it drives, the Output otherwise, null with neither', () => {
    const { nodes, edges } = doc();
    expect(previewTargetId(nodes, edges)).toBe('sp');
    // Unwire the splat: it no longer drives, the plain Output does.
    expect(previewTargetId(nodes, edges.filter((e) => e.targetHandle !== 'cut'))).toBe('out');
    // A FLAGGED plain Output outranks a wired splat.
    const flaggedOut = nodes.map((n) => (n.id === 'out' ? { ...n, data: { ...n.data, activeOutput: true } } as AppNode : n));
    expect(previewTargetId(flaggedOut, edges)).toBe('out');
    expect(previewTargetId([makeNode('u', 'uv')], [])).toBeNull();
    // …and it is exactly the node previewGraph routes to, in every case above.
    for (const [ns, es] of [[nodes, edges], [flaggedOut, edges]] as const) {
      const pg = previewGraph(ns as AppNode[], es as AppEdge[], { nodeId: 'len', handleId: 'out' });
      const routed = pg.edges.find((e) => e.source === 'len' && e.targetHandle === PREVIEW_CHANNEL)!;
      expect(routed.target).toBe(previewTargetId(ns as AppNode[], es as AppEdge[]));
    }
  });

  it('a feeder inside a collapsed group still makes the splat the target', () => {
    const { nodes } = doc();
    const group = {
      ...makeNode('g', 'group'),
      type: 'group',
      data: {
        collapsed: true,
        collapsedOutputs: [{ socketId: 'gout', originalNodeId: 'sd', originalHandleId: 'out' }],
        collapsedInputs: [],
      },
    } as unknown as AppNode;
    const edges = [makeEdge('pos', 'out', 'sd', 'p'), makeEdge('g', 'gout', 'sp', 'cut')];
    expect(previewTargetId([...nodes, group], edges)).toBe('sp');
  });

  it('a Raymarch Output driving a splat document keeps today’s treatment: the plain Output anchors', () => {
    const { nodes, edges } = doc();
    const rm = { ...makeNode('rm', 'raymarchOutput'), type: 'raymarchOutput' } as AppNode;
    data(rm).activeOutput = true;
    const f = makeNode('f', 'float', { value: 0.4 });
    const all = [...nodes, rm, f];
    const withMarch = [...edges, makeEdge('f', 'out', 'rm', 'field')];
    expect(previewTargetId(all, withMarch)).toBe('out');

    const pg = previewGraph(all, withMarch, { nodeId: 'len', handleId: 'out' });
    expect(pg.edges.filter((e) => e.targetHandle === PREVIEW_CHANNEL).map((e) => e.target)).toEqual(['out']);
    expect(data(pg.nodes.find((n) => n.id === 'rm')!).activeOutput).toBeUndefined();
    const code = gen(pg.nodes, pg.edges).code;
    expect(code).not.toMatch(/Loop\(/);
    expect(code).not.toContain('splat:');
  });
});

describe('the route line’s selector (previewRouteTargetId) — the memoised twin of previewTargetId', () => {
  const splatNode = (id = 'sp', over: Record<string, unknown> = {}): AppNode => {
    const n = { ...makeNode(id, 'splatOutput'), type: 'splatOutput' } as AppNode;
    return { ...n, data: { ...n.data, ...over } } as AppNode;
  };
  const withData = (n: AppNode, over: Record<string, unknown>) => ({ ...n, data: { ...n.data, ...over } }) as AppNode;
  const cut = makeEdge('sd', 'out', 'sp', 'cut');
  const base = [makeNode('out', 'output'), makeNode('pos', 'positionLocal'), makeNode('sd', 'sdCircle'), makeNode('len', 'length')];
  const baseEdges = [makeEdge('pos', 'out', 'sd', 'p'), makeEdge('pos', 'out', 'len', 'v')];
  const collapsed = {
    ...makeNode('g', 'group'),
    type: 'group',
    data: {
      collapsed: true,
      collapsedOutputs: [{ socketId: 'gout', originalNodeId: 'sd', originalHandleId: 'out' }],
      collapsedInputs: [],
    },
  } as unknown as AppNode;
  const rm = { ...makeNode('rm', 'raymarchOutput'), type: 'raymarchOutput' } as AppNode;

  /** Every shape the election distinguishes, splat or not. */
  const cases: Array<[string, AppNode[], AppEdge[]]> = [
    ['no sink at all', [makeNode('u', 'uv')], []],
    ['a plain Output only', base, baseEdges],
    ['an unwired, unflagged splat', [...base, splatNode()], baseEdges],
    ['a splat driving through Cut', [...base, splatNode()], [...baseEdges, cut]],
    ['a flagged splat, unwired', [...base, splatNode('sp', { activeOutput: true })], baseEdges],
    ['a flagged plain Output beside a driving splat',
      [withData(base[0], { activeOutput: true }), ...base.slice(1), splatNode()], [...baseEdges, cut]],
    // A flag on a TARGETED Output cannot be honoured (activeSink skips it), so
    // the wired splat still drives. Reachable in-session: ticking a mesh on the
    // flagged Output leaves the flag until the next restore normalizes it.
    ['a flagged TARGETED Output beside a driving splat',
      [withData(base[0], { activeOutput: true, meshTargets: ['Body'] }), makeNode('out2', 'output'), ...base.slice(1), splatNode()],
      [...baseEdges, cut]],
    ['a feeder inside a collapsed group', [...base, splatNode(), collapsed],
      [makeEdge('pos', 'out', 'sd', 'p'), makeEdge('g', 'gout', 'sp', 'cut')]],
    ['a flagged Raymarch Output on a splat document',
      [...base, splatNode(), withData(rm, { activeOutput: true }), makeNode('f', 'float', { value: 0.4 })],
      [...baseEdges, cut, makeEdge('f', 'out', 'rm', 'field')]],
    ['two splats, the second one flagged', [...base, splatNode(), splatNode('sp2', { activeOutput: true })], [...baseEdges, cut]],
  ];

  it.each(cases)('agrees with previewTargetId — %s', (_label, nodes, edges) => {
    expect(previewRouteTargetId(nodes, edges)).toBe(previewTargetId(nodes, edges));
  });

  it('the memo the Output cards read names the same sink as activeSink — a flag on a TARGETED Output is not honoured', () => {
    for (const [label, nodes, edges] of cases) {
      const truth = activeSink(nodes, edges)?.id ?? null;
      for (const n of nodes) {
        expect(isActiveSinkSelector(n.id)({ nodes, edges }), `${label}: ${n.id}`).toBe(n.id === truth);
      }
    }
  });

  it('the vacuity guard: the cases really do name the splat, the Output and nothing', () => {
    const named = new Set(cases.map(([, n, e]) => previewTargetId(n, e)));
    expect(named).toEqual(new Set([null, 'out', 'sp', 'sp2']));
  });

  it('reuses the active-sink memo the Output cards fill: a notify that asked them touches no edge', () => {
    // The always-mounted route line runs this on EVERY store notify while the
    // mode is on. previewTargetId repeats the whole election, unwrapping the
    // edges each time; the selector must answer from the (nodes, edges) memo.
    const nodes = [...base, splatNode()];
    let touched = 0;
    const edges = new Proxy([...baseEdges, cut], {
      get(t, p, r) {
        touched++;
        const v = Reflect.get(t, p, r);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    }) as AppEdge[];
    // The cards' ask fills the memo for this exact pair.
    expect(isActiveSinkSelector('sp')({ nodes, edges })).toBe(true);
    touched = 0;
    expect(previewRouteTargetId(nodes, edges)).toBe('sp');
    expect(touched).toBe(0);
    // …whereas the unmemoised form walks them every time.
    expect(previewTargetId(nodes, edges)).toBe('sp');
    expect(touched).toBeGreaterThan(0);
  });

  it('with no Splat Output on the canvas it never asks the election at all (the old cheap path)', () => {
    let touched = 0;
    const edges = new Proxy([...baseEdges], {
      get(t, p, r) {
        touched++;
        return Reflect.get(t, p, r);
      },
    }) as AppEdge[];
    expect(previewRouteTargetId(base, edges)).toBe('out');
    expect(touched).toBe(0);
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

  it('the route line ends on the node previewGraph routes to, through the MEMOISED selector (never a second reading)', () => {
    // previewRouteTargetId is pinned equal to previewTargetId above; the route
    // line is always mounted, so it must ask the memoised form, not repeat the
    // election per notify.
    const route = read('../components/NodeEditor/PreviewRoute.tsx');
    expect(route).toContain('s.nodePreview ? previewRouteTargetId(s.nodes, s.edges) : null');
    expect(route).not.toContain('previewTargetId(');
    expect(route).not.toContain('findDefaultOutput');
    expect(route).not.toContain('unwrapCollapsedGroupEdges');
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
