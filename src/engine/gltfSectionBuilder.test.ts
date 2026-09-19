/**
 * The GLB import's section builder (Phase 5 Step 8): a model's materials
 * become ONE Output with an index section per built material, fed by shared
 * Texture nodes, constants and multiplies. Structure pins over the three
 * fixture shapes, a graphToCode snapshot per shape, the sanitizer's
 * idempotence, and the apply∘apply round trip (the graph must not grow).
 */
import { describe, it, expect } from 'vitest';
import { buildGltfSectionGraph, gltfTextureNodeKey, SECTION_PORT_ORDER } from './gltfSectionBuilder';
import { graphToCode } from './graphToCode';
import { codeToGraph } from './codeToGraph';
import { encodeRequests } from '@/utils/gltfImportPlan';
import { encodeGltfImages, type GltfEncodedImage } from '@/utils/gltfTextureEncode';
import { getNodeValues, type AppEdge, type AppNode } from '@/types';
import { outputMaterials, parseChannelHandle, sanitizeOutputMaterials, sanitizeOutputMaterialsReport } from '@/utils/outputMaterials';
import { OUTPUT_DEFAULT_EXPOSED } from '@/utils/exposedPorts';
import { aiGlb, allSlotsGlb, blenderGlb, fakeEncoder, fakeStash, readOk, scanGlb } from './gltfImportFixtures';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import type { GltfModelReport } from '@/utils/gltfReader';

async function encodeAll(m: GltfModelReport, materials: number[]): Promise<Map<number, GltfEncodedImage>> {
  const { requests } = encodeRequests(m, materials);
  const r = await encodeGltfImages(m, requests, {
    modelName: 'model.glb',
    maxDim: null,
    deviceMaxDim: 2048,
    ignoreLimits: false,
    budgetChars: Infinity,
    encode: fakeEncoder([]),
    stash: fakeStash(),
  });
  return r.encoded;
}

async function build(bytes: Uint8Array, materials?: number[]) {
  const m = readOk(bytes);
  const mats = materials ?? m.materials.filter((x) => x.usage.primitives > 0).map((x) => x.index);
  const encoded = await encodeAll(m, mats);
  const built = buildGltfSectionGraph(m, { materials: mats, encoded });
  const out = built.nodes.find((n) => n.data.registryType === 'output')!;
  return { m, built, out, encoded };
}

const dataOf = (n: AppNode) => n.data as Record<string, unknown>;
const byType = (nodes: AppNode[], t: string) => nodes.filter((n) => n.data.registryType === t);
const edgesInto = (edges: AppEdge[], target: string, handle: string) =>
  edges.filter((e) => e.target === target && e.targetHandle === handle);

/** The node an Output channel is fed by, following ONE hop. */
function feederOf(nodes: AppNode[], edges: AppEdge[], outId: string, handle: string): AppNode | undefined {
  const e = edgesInto(edges, outId, handle)[0];
  return e ? nodes.find((n) => n.id === e.source) : undefined;
}

/** A structural summary: type, values, plus every edge as text. */
function summary(nodes: AppNode[], edges: AppEdge[]): string {
  const idOf = new Map(nodes.map((n, i) => [n.id, `${n.data.registryType}#${i}`]));
  const lines: string[] = [];
  for (const n of nodes) {
    const v = { ...getNodeValues(n) };
    if (typeof v.imageB64 === 'string') v.imageB64 = `<${v.imageB64.length} chars>`;
    lines.push(`${idOf.get(n.id)} ${JSON.stringify(v)}`);
    if (n.data.registryType === 'output') {
      const d = dataOf(n);
      lines.push(`  materials=${JSON.stringify(d.materials)}`);
      lines.push(`  modelSignature=${JSON.stringify(d.modelSignature)} modelMeshes=${JSON.stringify(d.modelMeshes)}`);
    }
  }
  for (const e of edges) lines.push(`${idOf.get(e.source)}.${e.sourceHandle} -> ${idOf.get(e.target)}.${e.targetHandle} (${(e.data as { dataType?: string })?.dataType})`);
  return lines.join('\n');
}

describe('BLENDER: sections, sharing, factors, settings', () => {
  it('one Output; material 0 untargeted and empty; one index section per built material, ascending', async () => {
    const { built, out } = await build(blenderGlb());
    expect(byType(built.nodes, 'output')).toHaveLength(1);
    const d = dataOf(out);
    expect(d.values).toBeUndefined();
    expect(d.exposedPorts).toBeUndefined();
    const mats = outputMaterials(out);
    expect(mats.slice(1).map((m) => m.gltfMaterialIndex)).toEqual([0, 1, 2]);
    expect(mats.slice(1).every((m) => !('meshTargets' in m))).toBe(true);
    expect(d.modelSignature).toEqual({ materials: ['Material.001', 'Material.002', 'Ķermenis'] });
    expect(built.report).toMatchObject({ sections: 3, textureNodes: 3, sharedTextureNodes: 1 });
  });

  it('the ORM image is ONE Texture node feeding both sections (g → roughness, b → metalness)', async () => {
    const { built, out } = await build(blenderGlb());
    const images = byType(built.nodes, 'imageNode');
    expect(images).toHaveLength(3);
    const orm = images.find((n) => getNodeValues(n).fileName === 'ORM.png')!;
    expect(getNodeValues(orm).colorSpace).toBe('data');
    const targets = built.edges.filter((e) => e.source === orm.id).map((e) => `${e.sourceHandle}->${e.targetHandle}`).sort();
    // Material 0: roughness 0.8 → g × Float; metalness 1 → b direct.
    // Material 1: roughness 1 → g direct; metalness 0 → b × Float(0).
    expect(targets).toContain('b->m1:metalness');
    expect(targets).toContain('g->m2:roughness');
    const sections = new Set(
      built.edges.filter((e) => e.source === orm.id).map((e) => parseChannelHandle(e.targetHandle!).index),
    );
    expect(sections.size).toBeGreaterThanOrEqual(1);
    const mul = feederOf(built.nodes, built.edges, out.id, 'm1:roughness')!;
    expect(mul.data.registryType).toBe('mul');
    const floats = byType(built.nodes, 'float').map((n) => getNodeValues(n).value);
    expect(floats).toContain(0.8);
  });

  it('base colour: texture × nothing when the factor is white; the texture carries the KHR_texture_transform', async () => {
    const { built, out } = await build(blenderGlb());
    const feeder = feederOf(built.nodes, built.edges, out.id, 'm1:color')!;
    expect(feeder.data.registryType).toBe('imageNode');
    const v = getNodeValues(feeder);
    expect(v.orientation).toBe('gltf');
    expect(v.xfOffsetX).toBe(0.25);
    expect(v.xfScaleX).toBe(2);
    expect(v.colorSpace).toBe('color');
  });

  it('BLEND: transparent + depthWrite false; opacity WIRED as COLOR_0.w × Float(0.5) (no base texture, a painted primitive); the grey factor is WIRED (× vertex colour) and the ORM texture wires metalness', async () => {
    const { built, out } = await build(blenderGlb());
    const m2 = outputMaterials(out)[2];
    expect(m2.values).toBeUndefined();
    expect(m2.materialSettings).toEqual({ transparent: true, depthWrite: false });
    // COLOR_0's alpha multiplies the base alpha (glTF 3.9.2): the ONE Vertex
    // Color node feeds a Split whose `w` is multiplied by the factor's alpha.
    const feeder = feederOf(built.nodes, built.edges, out.id, 'm2:opacity')!;
    expect(feeder.data.registryType).toBe('mul');
    const ins = built.edges.filter((e) => e.target === feeder.id);
    const wEdge = ins.find((e) => e.sourceHandle === 'w')!;
    const split = built.nodes.find((n) => n.id === wEdge.source)!;
    expect(split.data.registryType).toBe('split');
    const vc = byType(built.nodes, 'vertexColor');
    expect(vc).toHaveLength(1);
    expect(built.edges.some((e) => e.source === vc[0].id && e.target === split.id && e.targetHandle === 'v')).toBe(true);
    const factor = built.nodes.find((n) => n.id === ins.find((e) => e !== wEdge)!.source)!;
    expect(factor.data.registryType).toBe('float');
    expect(getNodeValues(factor).value).toBe(0.5);
    expect(graphToCode(built.nodes, built.edges).code).toMatch(/const (mul\d+) = mul\(vertexColor1\.w, float\d+\);[\s\S]*"1": \{[^}]*opacity: \1,/);
    expect(m2.exposedPorts).toEqual(SECTION_PORT_ORDER.filter((c) => OUTPUT_DEFAULT_EXPOSED.includes(c) || ['color', 'emissive', 'metalness', 'opacity'].includes(c)));
  });

  it('vertex colours multiply into the base colour of the painted primitive\'s material', async () => {
    const { built, out } = await build(blenderGlb());
    // Material 1's colour chain: the grey factor... it has no texture, so the
    // Vertex Color × Color(grey) multiply feeds m2:color.
    const feeder = feederOf(built.nodes, built.edges, out.id, 'm2:color');
    expect(feeder?.data.registryType).toBe('mul');
    const vc = byType(built.nodes, 'vertexColor');
    expect(vc).toHaveLength(1);
    expect(built.edges.some((e) => e.source === vc[0].id && e.target === feeder!.id)).toBe(true);
  });

  it('emissive: Color(factor) × Float(strength) when there is no texture and the strength is not 1', async () => {
    const { built, out } = await build(blenderGlb());
    const feeder = feederOf(built.nodes, built.edges, out.id, 'm2:emissive')!;
    expect(feeder.data.registryType).toBe('mul');
    const ins = built.edges.filter((e) => e.target === feeder.id).map((e) => built.nodes.find((n) => n.id === e.source)!);
    expect(ins.map((n) => n.data.registryType).sort()).toEqual(['color', 'float']);
    expect(getNodeValues(ins.find((n) => n.data.registryType === 'float')!).value).toBe(2);
    expect(getNodeValues(ins.find((n) => n.data.registryType === 'color')!).hex).toBe('#ffbc89');
  });

  it('MASK with cutoff 1.2 clamps alphaTest to 0.99 and reports alphaCutoff; the Latvian material is factor-only', async () => {
    const { built, out } = await build(blenderGlb());
    const m3 = outputMaterials(out)[3];
    expect(m3.materialSettings).toEqual({ alphaTest: 0.99 });
    expect(m3.values).toEqual({ color: '#7ccb59', roughness: 0.4, metalness: 0.25 });
    expect(built.report.notImported).toEqual(['occlusion', 'normalScale', 'alphaCutoff']);
  });

  it('a tangent-less model\'s normal node carries the green flip; doubleSided is side double', async () => {
    const { built, out } = await build(blenderGlb());
    const n = feederOf(built.nodes, built.edges, out.id, 'm1:normal')!;
    expect(n.data.registryType).toBe('imageNode');
    expect(getNodeValues(n)).toMatchObject({ normalGreen: 'flip', colorSpace: 'data' });
    expect(outputMaterials(out)[1].materialSettings).toEqual({ side: 'double' });
  });

  it('mirror names: the certain single-material meshes of built materials, first appearance order', async () => {
    const { out } = await build(blenderGlb());
    // `Cube` is a two-primitive mesh → a Group named Cube with children
    // Cube_1 (material 0) and Cube_2 (material 1); Plate carries material 2.
    expect(dataOf(out).modelMeshes).toEqual([
      { name: 'Cube_1', material: 0 },
      { name: 'Cube_2', material: 1 },
      { name: 'Plate', material: 2 },
    ]);
  });

  it('a limit of one material builds one section, and mirrors only its meshes', async () => {
    const { built, out } = await build(blenderGlb(), [1]);
    expect(built.report.sections).toBe(1);
    expect(outputMaterials(out).slice(1).map((m) => m.gltfMaterialIndex)).toEqual([1]);
    expect(dataOf(out).modelMeshes).toEqual([{ name: 'Cube_2', material: 1 }]);
  });
});

describe('AI: texCoord, dead emissive, clearcoat, the sampler', () => {
  it('texCoord 1 → uvSet 1; emissive factor 0 → no emissive edge and emissiveUnused; clearcoat reported', async () => {
    const { built, out } = await build(aiGlb());
    const mr = feederOf(built.nodes, built.edges, out.id, 'm1:metalness')!;
    // metallicFactor 0.5 → MR.b × Float(0.5)
    expect(mr.data.registryType).toBe('mul');
    const image = built.nodes.find((n) => n.data.registryType === 'imageNode' && getNodeValues(n).uvSet === 1);
    expect(image).toBeDefined();
    expect(edgesInto(built.edges, out.id, 'm1:emissive')).toHaveLength(0);
    expect(built.report.notImported).toEqual(['clearcoat', 'emissiveUnused']);
    expect(built.report.textureNodes).toBe(3);
  });

  it('a clamp/nearest sampler lands on the base colour node as repeat 0 + nearest; tangents mean no flip', async () => {
    const { built, out } = await build(aiGlb());
    const base = feederOf(built.nodes, built.edges, out.id, 'm1:color')!;
    expect(getNodeValues(base)).toMatchObject({ repeat: 0, filter: 'nearest' });
    const normal = feederOf(built.nodes, built.edges, out.id, 'm1:normal')!;
    expect(getNodeValues(normal).normalGreen).toBeUndefined();
  });

  it('an unnamed mesh on an unnamed node mirrors under the loader\'s name', async () => {
    const { out } = await build(aiGlb());
    expect(dataOf(out).modelMeshes).toEqual([{ name: 'mesh_0', material: 0 }]);
  });
});

/**
 * The built graph is READ against the Output's rows, so its vertical order must
 * follow the sockets the wires land on. dagre knows nothing about handles (every
 * wire into a node is the same wire to it) and floats its longest chain to the
 * top of each rank, so the feeders used to stack Roughness, Color, Metalness,
 * Normal, Emissive against rows reading Color, Emissive, Roughness, Metalness,
 * Normal — every wire crossed (owner, 2026-09-18).
 */
describe('the feeders stack in the order of the sockets they land on', () => {
  /** The channel's ROW on the node — `def.inputs` order, what OutputNode draws. */
  const RANK = new Map(NODE_REGISTRY.get('output')!.inputs.map((p, i) => [p.id, i]));

  /**
   * Every DIRECT feeder of the Output that lands on exactly ONE socket, top to
   * bottom, as `(section, row)`. A feeder shared between channels (an ORM map
   * on roughness AND metalness, or one texture across two sections) is left
   * out: it has one place in the layout and several sockets, so its second wire
   * crosses whatever the order — the one inherent crossing, documented in
   * `feederOrder`.
   */
  function feedOrder(nodes: AppNode[], edges: AppEdge[], outId: string): [number, number][] {
    const count = new Map<string, number>();
    for (const e of edges) {
      if (e.target === outId) count.set(e.source, (count.get(e.source) ?? 0) + 1);
    }
    return edges
      .filter((e) => e.target === outId && count.get(e.source) === 1)
      .map((e) => {
        const { index, channel } = parseChannelHandle(String(e.targetHandle));
        return { y: nodes.find((n) => n.id === e.source)!.position.y, k: [index, RANK.get(channel)!] as [number, number] };
      })
      .sort((a, b) => a.y - b.y)
      .map((r) => r.k);
  }

  const ascending = (order: [number, number][]) =>
    order.every((k, i) => i === 0 || k[0] > order[i - 1][0] || (k[0] === order[i - 1][0] && k[1] > order[i - 1][1]));

  it('ALL SLOTS: Color, Emissive, Roughness, Metalness, Normal — exactly the rows', async () => {
    const { built, out } = await build(allSlotsGlb());
    expect(feedOrder(built.nodes, built.edges, out.id)).toEqual([
      [1, RANK.get('color')!],
      [1, RANK.get('emissive')!],
      [1, RANK.get('roughness')!],
      [1, RANK.get('metalness')!],
      [1, RANK.get('normal')!],
    ]);
  });

  for (const [name, bytes] of [['BLENDER', blenderGlb()], ['SCAN', scanGlb()], ['AI', aiGlb()]] as const) {
    it(`${name}: sections in order, rows in order inside each`, async () => {
      const { built, out } = await build(bytes);
      const order = feedOrder(built.nodes, built.edges, out.id);
      expect(order.length).toBeGreaterThan(1);
      expect(ascending(order), JSON.stringify(order)).toBe(true);
    });
  }
});

describe('the fan-out key', () => {
  it('differs by colour space, flip, mapping and sampler; equal uses share', () => {
    const m = readOk(blenderGlb());
    const base = m.materials[0].slots.find((s) => s.slot === 'baseColor')!;
    const orm = m.materials[0].slots.find((s) => s.slot === 'metallicRoughness')!;
    const orm2 = m.materials[1].slots.find((s) => s.slot === 'metallicRoughness')!;
    expect(gltfTextureNodeKey(m, orm, 'data', false)).toBe(gltfTextureNodeKey(m, orm2, 'data', false));
    expect(gltfTextureNodeKey(m, orm, 'data', false)).not.toBe(gltfTextureNodeKey(m, orm, 'color', false));
    expect(gltfTextureNodeKey(m, orm, 'data', false)).not.toBe(gltfTextureNodeKey(m, orm, 'data', true));
    expect(gltfTextureNodeKey(m, base, 'color', false)).not.toBe(gltfTextureNodeKey(m, orm, 'color', false));
    expect(gltfTextureNodeKey(m, { ...base, texture: 99 }, 'color', false)).toBeNull();
  });
});

describe('resilience', () => {
  it('an image missing from `encoded` leaves its slot factor-only, and nothing throws', async () => {
    const m = readOk(scanGlb());
    const built = buildGltfSectionGraph(m, { materials: [0, 1, 2], encoded: new Map() });
    const out = built.nodes.find((n) => n.data.registryType === 'output')!;
    expect(byType(built.nodes, 'imageNode')).toHaveLength(0);
    expect(built.report).toMatchObject({ sections: 3, textureNodes: 0, sharedTextureNodes: 0 });
    // Trim: roughness 0.5 stored; every material: metalness 1 stored (glTF's default).
    expect(outputMaterials(out)[3].values).toEqual({ roughness: 0.5, metalness: 1 });
    expect(outputMaterials(out)[1].values).toEqual({ metalness: 1 });
  });

  it('junk in the material list is ignored; nothing built means no signature and no meshes', async () => {
    const m = readOk(scanGlb());
    const built = buildGltfSectionGraph(m, { materials: [7, -1, 1.5, 'x' as unknown as number], encoded: new Map() });
    const out = built.nodes.find((n) => n.data.registryType === 'output')!;
    expect(dataOf(out).materials).toBeUndefined();
    expect(dataOf(out).modelSignature).toBeUndefined();
    expect(dataOf(out).modelMeshes).toBeUndefined();
    expect(built.signatureTooLarge).toBe(false);
  });
});

describe('what the restore paths and the parse make of it', () => {
  for (const [name, bytes] of [['BLENDER', blenderGlb()], ['SCAN', scanGlb()], ['AI', aiGlb()]] as const) {
    it(`${name}: the built graph is already clean (sanitizeOutputMaterials returns the SAME array, trimmed 0)`, async () => {
      const { built } = await build(bytes);
      expect(sanitizeOutputMaterials(built.nodes)).toBe(built.nodes);
      const r = sanitizeOutputMaterialsReport(built.nodes);
      expect(r.trimmed).toBe(0);
      expect(r.nodes).toBe(built.nodes);
    });

    it(`${name}: graphToCode emits with no errors, and apply∘apply is byte-stable with no node growth`, async () => {
      const { built } = await build(bytes);
      const first = graphToCode(built.nodes, built.edges);
      expect(first.code).toContain('materialParts: {');
      expect(first.code).toContain('modelSignature: {');
      // Image nodes are ONE-WAY through codeToGraph (they drop on the first
      // Apply, by design), so the pin is over what the parse produces.
      const a = codeToGraph(first.code);
      expect(a.errors.filter((e) => e.severity !== 'warning')).toEqual([]);
      const second = graphToCode(a.nodes, a.edges).code;
      const b = codeToGraph(second);
      const third = graphToCode(b.nodes, b.edges).code;
      if (name === 'BLENDER') {
        // The tangent-less normal map emits Phase 4's flipped form,
        // `normalMap(imageN, vec2(1, -1))`, which the parse turns into an
        // `unknown` node named after the channel; the NEXT Apply renames its
        // `float(0)` fallback (`normalMap1` → `float5`) and it is stable from
        // there — a pre-existing one-way shape, pinned rather than hidden.
        expect(third.replace(/\bfloat5\b/g, 'normalMap1')).toBe(second);
        const c = codeToGraph(third);
        expect(graphToCode(c.nodes, c.edges).code).toBe(third);
      } else {
        expect(third).toBe(second);
      }
      expect(b.nodes.length).toBe(a.nodes.length);
      const outA = a.nodes.find((n) => n.data.registryType === 'output')!;
      const outB = b.nodes.find((n) => n.data.registryType === 'output')!;
      expect(outputMaterials(outB).slice(1).map((m) => m.gltfMaterialIndex)).toEqual(
        outputMaterials(outA).slice(1).map((m) => m.gltfMaterialIndex),
      );
    });

    it(`${name}: snapshot of the emitted code and the graph structure`, async () => {
      const { built } = await build(bytes);
      expect(graphToCode(built.nodes, built.edges).code).toMatchSnapshot();
      expect(summary(built.nodes, built.edges)).toMatchSnapshot();
    });
  }
});
