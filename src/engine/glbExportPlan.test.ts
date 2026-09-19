/**
 * The single-GLB export plan (engine/glbExportPlan.ts): which glTF texture
 * slots a graph writes, derived — never stored — from the builder's own
 * wiring shape, plus the module's asset keys and the composed texture
 * transform. Includes the Phase 5 follow-up pin (integration §2c): every
 * channel a REAL builder section wires reaches its Texture node over `mul`
 * nodes only, on its canonical socket, so a builder change that inserts
 * anything else fails here instead of silently emptying every slot.
 */
import { describe, it, expect } from 'vitest';
import {
  GLB_CHANNEL_SLOTS,
  GLB_SLOT_WALK_MAX,
  composeKhrTextureTransform,
  planGlbExport,
  type GlbExportPlan,
} from './glbExportPlan';
import { FS_ASSET_KEY_RE, IMAGE_ASSET_KEY_RE } from './glbShaderContract';
import { imageAssetFor } from './imageAssets';
import { IMAGE_CHANNEL_COMPONENTS } from '@/utils/imageChannels';
import { gltfUvMatrix } from '@/utils/imageUvMapping';
import { samplerFor } from '@/utils/glbRepack';
import { buildGltfSectionGraph } from './gltfSectionBuilder';
import { encodeRequests } from '@/utils/gltfImportPlan';
import { encodeGltfImages } from '@/utils/gltfTextureEncode';
import { blenderGlb, fakeEncoder, fakeStash, readOk } from './gltfImportFixtures';
import { canonicalSrc, fakeWebp, makeEdge, makeNode, makeRealPng } from '@/test-utils';
import type { AppEdge, AppNode } from '@/types';

const SIG = ['Body', 'Glass', 'Trim'];
const SIGNATURE = { materials: SIG };

const PNG_T = canonicalSrc('image/png', makeRealPng(2, 2, [200, 10, 10, 255]));
const PNG_N = canonicalSrc('image/png', makeRealPng(2, 2, [128, 128, 255, 255]));
const PNG_MR = canonicalSrc('image/png', makeRealPng(2, 2, [0, 200, 100, 255]));
const WEBP_E = canonicalSrc('image/webp', fakeWebp(4, 4, false));

function out(materials: unknown[], extra: Record<string, unknown> = {}): AppNode {
  const n = makeNode('out', 'output');
  Object.assign(n.data as Record<string, unknown>, { materials, modelSignature: { materials: SIG }, ...extra });
  return n;
}

function tex(id: string, src: string, extra: Record<string, string | number> = {}): AppNode {
  return makeNode(id, 'imageNode', { imageB64: src, width: 2, height: 2, fileName: `${id}.png`, orientation: 'gltf', ...extra });
}

const c = (id: string) => makeNode(id, 'color', { hex: '#808080' });
const f = (id: string) => makeNode(id, 'float', { value: 0.5 });
const mul = (id: string) => makeNode(id, 'mul');

function plan(nodes: AppNode[], edges: AppEdge[], moduleText = '', sig = SIGNATURE): GlbExportPlan {
  const r = planGlbExport(nodes, edges, moduleText, sig);
  if (!r.ok) throw new Error('plan refused: ' + r.reason);
  return r.plan;
}

/** The builder's shapes: section 1 = glTF 0, section 2 = glTF 1. */
function builderGraph() {
  const nodes = [
    out([{ gltfMaterialIndex: 0 }, { gltfMaterialIndex: 1 }]),
    tex('T', PNG_T),
    c('col'),
    makeNode('vc', 'vertexColor'),
    mul('m1'),
    mul('m2'),
    f('alpha'),
    mul('m3'),
    tex('N', PNG_N, { colorSpace: 'data' }),
    tex('MR', PNG_MR, { colorSpace: 'data', filter: 'nearest' }),
    f('rough'),
    mul('m4'),
    tex('E', WEBP_E),
    c('ecol'),
    f('strength'),
    mul('m5'),
    mul('m6'),
  ];
  const edges = [
    makeEdge('T', 'out', 'm1', 'a'),
    makeEdge('col', 'out', 'm1', 'b'),
    makeEdge('m1', 'out', 'm2', 'a'),
    makeEdge('vc', 'out', 'm2', 'b'),
    makeEdge('m2', 'out', 'out', 'm1:color'),
    makeEdge('T', 'alpha', 'm3', 'a'),
    makeEdge('alpha', 'out', 'm3', 'b'),
    makeEdge('m3', 'out', 'out', 'm1:opacity'),
    makeEdge('N', 'out', 'out', 'm1:normal'),
    makeEdge('MR', 'g', 'm4', 'a'),
    makeEdge('rough', 'out', 'm4', 'b'),
    makeEdge('m4', 'out', 'out', 'm2:roughness'),
    makeEdge('MR', 'b', 'out', 'm2:metalness'),
    makeEdge('E', 'out', 'm5', 'a'),
    makeEdge('ecol', 'out', 'm5', 'b'),
    makeEdge('m5', 'out', 'm6', 'a'),
    makeEdge('strength', 'out', 'm6', 'b'),
    makeEdge('m6', 'out', 'out', 'm2:emissive'),
  ];
  return { nodes, edges };
}

const brief = (p: GlbExportPlan) => p.slots.map((s) => `${s.material}:${s.slot}`);

describe('builder-shaped chains map', () => {
  it('base colour (× colour × vertex colour, and alpha × float), normal, MR (g×, b), emissive (× ×)', () => {
    const { nodes, edges } = builderGraph();
    const p = plan(nodes, edges);
    expect(p.indexMaterials).toEqual([0, 1]);
    expect(brief(p)).toEqual(['0:baseColor', '0:normal', '1:metallicRoughness', '1:emissive']);
    expect(p.problems).toEqual([]);
    expect(p.notes).toEqual([]);
    const bySlot = new Map(p.slots.map((s) => [`${s.material}:${s.slot}`, s]));
    expect(bySlot.get('0:baseColor')!.src).toBe(PNG_T);
    expect(bySlot.get('0:normal')!.sampler).toEqual(samplerFor({ colorSpace: 'data', nearest: false, repeat: true }));
    expect(bySlot.get('1:metallicRoughness')!.sampler).toEqual(samplerFor({ colorSpace: 'data', nearest: true, repeat: true }));
    expect(bySlot.get('1:emissive')!.src).toBe(WEBP_E);
    expect(p.payloads.get(WEBP_E)!.mime).toBe('image/webp');
    expect(p.payloads.get(PNG_T)!.lossless).toBe(true);
    expect(p.payloadSizes.get(PNG_T)).toEqual({ width: 2, height: 2 });
  });

  it('the channel table is P4a\'s socket ids, and every writable slot is fed', () => {
    for (const [, [, socket]] of GLB_CHANNEL_SLOTS) {
      expect(socket === 'out' || IMAGE_CHANNEL_COMPONENTS.has(socket)).toBe(true);
    }
    expect([...GLB_CHANNEL_SLOTS.keys()]).toEqual(['color', 'opacity', 'roughness', 'metalness', 'normal', 'emissive']);
  });

  it('texCoord from uvSet; notes for a wired uv', () => {
    const { nodes, edges } = builderGraph();
    const T = nodes.find((n) => n.id === 'T')!;
    (T.data as { values: Record<string, unknown> }).values.uvSet = 1;
    const p = plan([...nodes, makeNode('uvn', 'uv')], [...edges, makeEdge('uvn', 'out', 'T', 'uv')]);
    expect(p.slots.find((s) => s.slot === 'baseColor')!.texCoord).toBe(1);
    expect(p.notes).toContainEqual({ material: 0, slot: 'baseColor', note: 'uv-wired' });
  });
});

describe('problems', () => {
  const base = () => builderGraph();

  it('two different images into one slot, via mul → ambiguous', () => {
    const { nodes, edges } = base();
    const p = plan(
      [...nodes, tex('T2', PNG_N)],
      edges.map((e) => (e.source === 'col' ? makeEdge('T2', 'out', 'm1', 'b') : e)),
    );
    expect(p.problems).toContainEqual({ material: 0, slot: 'baseColor', reason: 'ambiguous' });
    expect(brief(p)).not.toContain('0:baseColor');
  });

  it('colour from one image, opacity from another → ambiguous', () => {
    const { nodes, edges } = base();
    const p = plan(
      [...nodes, tex('T2', PNG_N)],
      edges.map((e) => (e.source === 'T' && e.sourceHandle === 'alpha' ? makeEdge('T2', 'alpha', 'm3', 'a') : e)),
    );
    expect(p.problems).toContainEqual({ material: 0, slot: 'baseColor', reason: 'ambiguous' });
  });

  it('a noise into colour → rewired; an image through mix → rewired', () => {
    const { nodes, edges } = base();
    const noise = plan(
      [...nodes, makeNode('nz', 'perlin')],
      edges.filter((e) => e.targetHandle !== 'm1:opacity').map((e) => (e.targetHandle === 'm1:color' ? makeEdge('nz', 'out', 'out', 'm1:color') : e)),
    );
    expect(noise.problems).toContainEqual({ material: 0, slot: 'baseColor', reason: 'rewired' });
    const mixed = plan(
      [...nodes, makeNode('mx', 'mix')],
      [
        ...edges.filter((e) => e.targetHandle !== 'm1:normal'),
        makeEdge('N', 'out', 'mx', 'a'),
        makeEdge('mx', 'out', 'out', 'm1:normal'),
      ],
    );
    expect(mixed.problems).toContainEqual({ material: 0, slot: 'normal', reason: 'rewired' });
  });

  it("the builder's COLOR_0 alpha Split is walked; a Split of an IMAGE is rewired", () => {
    // A non-opaque painted material wires `vertexColor.w` into opacity, which
    // shares the baseColor slot — so the Split is on that slot's chain. It is a
    // factor leaf's take, not a texture (gltfSectionBuilder's `wOf`).
    const nodes = [out([{ gltfMaterialIndex: 0 }]), makeNode('vc', 'vertexColor'), makeNode('sp', 'split'), c('col'), mul('m')];
    const edges = [
      makeEdge('col', 'out', 'm', 'a'),
      makeEdge('vc', 'out', 'm', 'b'),
      makeEdge('m', 'out', 'out', 'm1:color'),
      makeEdge('vc', 'out', 'sp', 'a'),
      makeEdge('sp', 'w', 'out', 'm1:opacity'),
    ];
    expect(plan(nodes, edges).problems).toEqual([]);
    // An IMAGE reached through a Split feeds one channel of itself, never the
    // canonical socket: that is a rewire, not a slot.
    const img = plan(
      [...nodes.filter((n) => n.id !== 'vc'), tex('T', PNG_T), makeNode('vc', 'vertexColor')],
      [...edges.filter((e) => e.target !== 'sp'), makeEdge('T', 'out', 'sp', 'a')],
    );
    expect(img.problems).toContainEqual({ material: 0, slot: 'baseColor', reason: 'rewired' });
    expect(img.slots).toEqual([]);
    // Even on the socket that WOULD be canonical: the edge into the Split says
    // `out`, but what reaches the channel is one component of that sample.
    const viaColor = plan(
      [out([{ gltfMaterialIndex: 0 }]), tex('T', PNG_T), makeNode('sp', 'split')],
      [makeEdge('T', 'out', 'sp', 'a'), makeEdge('sp', 'x', 'out', 'm1:color')],
    );
    expect(viaColor.problems).toEqual([{ material: 0, slot: 'baseColor', reason: 'rewired' }]);
    expect(viaColor.slots).toEqual([]);
  });

  it('a factor-only chain (colour × vertex colour) is not a texture slot and reports nothing', () => {
    const nodes = [out([{ gltfMaterialIndex: 0 }]), c('col'), makeNode('vc', 'vertexColor'), mul('m')];
    const edges = [makeEdge('col', 'out', 'm', 'a'), makeEdge('vc', 'out', 'm', 'b'), makeEdge('m', 'out', 'out', 'm1:color')];
    const p = plan(nodes, edges);
    expect(p.slots).toEqual([]);
    expect(p.problems).toEqual([]);
  });

  it('an image through a non-canonical socket (R into roughness) → rewired', () => {
    const { nodes, edges } = base();
    const p = plan(nodes, edges.map((e) => (e.sourceHandle === 'g' ? makeEdge('MR', 'r', 'm4', 'a') : e)));
    // metalness still reaches MR.b, so the slot has its one candidate…
    expect(brief(p)).toContain('1:metallicRoughness');
    // …while a slot fed ONLY that way is rewired.
    const only = plan(
      nodes,
      edges.filter((e) => e.targetHandle !== 'm2:metalness').map((e) => (e.sourceHandle === 'g' ? makeEdge('MR', 'r', 'm4', 'a') : e)),
    );
    expect(only.problems).toContainEqual({ material: 1, slot: 'metallicRoughness', reason: 'rewired' });
  });

  it("an 'app'-oriented image → not-gltf-oriented; an invalid payload → invalid-payload", () => {
    const { nodes, edges } = base();
    const T = nodes.find((n) => n.id === 'T')!;
    delete (T.data as { values: Record<string, unknown> }).values.orientation;
    expect(plan(nodes, edges).problems).toContainEqual({ material: 0, slot: 'baseColor', reason: 'not-gltf-oriented' });
    const b = base();
    const N = b.nodes.find((n) => n.id === 'N')!;
    (N.data as { values: Record<string, unknown> }).values.imageB64 = 'data:image/png;base64,AAAA';
    expect(plan(b.nodes, b.edges).problems).toContainEqual({ material: 0, slot: 'normal', reason: 'invalid-payload' });
  });
});

describe('sections and the signature', () => {
  it('a shadowed duplicate section never maps (the first claim wins)', () => {
    const nodes = [out([{ gltfMaterialIndex: 0 }, { gltfMaterialIndex: 0 }]), tex('T', PNG_T), tex('U', PNG_N)];
    const edges = [makeEdge('T', 'out', 'out', 'm1:color'), makeEdge('U', 'out', 'out', 'm2:color')];
    const p = plan(nodes, edges);
    expect(p.slots).toHaveLength(1);
    expect(p.slots[0].src).toBe(PNG_T);
  });

  it('a signature mismatch → model-mismatch; no index sections → no slots and no check', () => {
    const { nodes, edges } = builderGraph();
    expect(planGlbExport(nodes, edges, '', { materials: ['Other'] })).toEqual({ ok: false, reason: 'model-mismatch' });
    const plain = [makeNode('out', 'output'), tex('T', PNG_T)];
    const r = planGlbExport(plain, [makeEdge('T', 'out', 'out', 'color')], '', { materials: ['Other'] });
    expect(r.ok && r.plan.slots).toEqual([]);
    expect(r.ok && r.plan.indexMaterials).toEqual([]);
  });

  it('a collapsed group changes nothing (unwrapped edges)', () => {
    const { nodes, edges } = builderGraph();
    const group = {
      id: 'g',
      type: 'group',
      position: { x: 0, y: 0 },
      data: {
        collapsed: true,
        collapsedOutputs: [{ socketId: 's-color', originalNodeId: 'm2', originalHandleId: 'out' }],
        collapsedInputs: [],
      },
    } as unknown as AppNode;
    const collapsed = edges.map((e) => (e.targetHandle === 'm1:color' ? makeEdge('g', 's-color', 'out', 'm1:color') : e));
    expect(brief(plan([...nodes, group], collapsed))).toEqual(brief(plan(nodes, edges)));
  });

  it(`a hostile mul cycle and a ${GLB_SLOT_WALK_MAX + 36}-long chain terminate`, () => {
    const cyc = [out([{ gltfMaterialIndex: 0 }]), mul('a'), mul('b')];
    const cycEdges = [makeEdge('a', 'out', 'b', 'a'), makeEdge('b', 'out', 'a', 'a'), makeEdge('a', 'out', 'out', 'm1:color')];
    expect(plan(cyc, cycEdges).slots).toEqual([]);
    const n = GLB_SLOT_WALK_MAX + 36;
    const chain: AppNode[] = [out([{ gltfMaterialIndex: 0 }]), tex('T', PNG_T)];
    const chainEdges: AppEdge[] = [makeEdge('T', 'out', 'k0', 'a')];
    for (let i = 0; i < n; i++) {
      chain.push(mul(`k${i}`));
      if (i > 0) chainEdges.push(makeEdge(`k${i - 1}`, 'out', `k${i}`, 'a'));
    }
    chainEdges.push(makeEdge(`k${n - 1}`, 'out', 'out', 'm1:color'));
    expect(plan(chain, chainEdges).problems).toEqual([{ material: 0, slot: 'baseColor', reason: 'rewired' }]);
  });

  it('a candidate found BEFORE the budget never becomes the slot, in EITHER edge order', () => {
    // One `mul` fed by an image AND by a chain past the budget: the walk stack
    // is LIFO, so the edge ARRAY order decides which side is seen first. Both
    // orders must report `rewired` — writing the image it happened to reach
    // would bake one of two textures into baseColor for other viewers, and make
    // the exported bytes depend on edge order.
    const n = GLB_SLOT_WALK_MAX + 20;
    const build = (imageEdgeFirst: boolean) => {
      const nodes: AppNode[] = [out([{ gltfMaterialIndex: 0 }]), tex('A', PNG_T), tex('B', PNG_N), mul('root')];
      const image = makeEdge('A', 'out', 'root', 'a');
      const chain = makeEdge(`k${n - 1}`, 'out', 'root', 'b');
      const edges: AppEdge[] = [
        makeEdge('root', 'out', 'out', 'm1:color'),
        ...(imageEdgeFirst ? [image, chain] : [chain, image]),
      ];
      for (let i = 0; i < n; i++) {
        nodes.push(mul(`k${i}`));
        edges.push(i === 0 ? makeEdge('B', 'out', 'k0', 'a') : makeEdge(`k${i - 1}`, 'out', `k${i}`, 'a'));
      }
      const p = plan(nodes, edges);
      return { slots: p.slots, problems: p.problems };
    };
    expect(build(false)).toEqual({ slots: [], problems: [{ material: 0, slot: 'baseColor', reason: 'rewired' }] });
    expect(build(true)).toEqual(build(false));
  });
});

describe('moduleAssets', () => {
  it('module-text order, deduped, unknown keys skipped, then one key per slot payload the module does not name', () => {
    const { nodes, edges } = builderGraph();
    const keyOf = (id: string) => imageAssetFor(id, (nodes.find((n) => n.id === id)!.data as { values: Record<string, string | number> }).values)!.key;
    const moduleText = `x("fs-asset:${keyOf('E')}"); y("fs-asset:nope-00000000"); z("fs-asset:${keyOf('T')}"); w("fs-asset:${keyOf('E')}");`;
    const p = plan(nodes, edges, moduleText);
    expect(p.moduleAssets.map((a) => a.key)).toEqual([keyOf('E'), keyOf('T'), keyOf('N'), keyOf('MR')]);
    expect(p.moduleAssets.map((a) => a.src)).toEqual([WEBP_E, PNG_T, PNG_N, PNG_MR]);
    for (const a of p.moduleAssets) expect(a.key).toMatch(IMAGE_ASSET_KEY_RE);
  });

  it('IMAGE_ASSET_KEY_RE ⊂ FS_ASSET_KEY_RE for 1000 random and hostile node ids', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const hostile = ['__proto__', 'constructor', '"', '*/', '</script>', '', 'ā'.repeat(200), '-'.repeat(90)];
    for (let i = 0; i < 1000; i++) {
      const id =
        i < hostile.length
          ? hostile[i]
          : Array.from({ length: 1 + Math.floor(rnd() * 120) }, () => String.fromCharCode(Math.floor(rnd() * 0x3000))).join('');
      const a = imageAssetFor(id, { imageB64: PNG_T, width: 2, height: 2 })!;
      expect(a.key).toMatch(IMAGE_ASSET_KEY_RE);
      expect(a.key).toMatch(FS_ASSET_KEY_RE);
    }
  });
});

/* ── the composed transform ──────────────────────────────────────────────── */

const NO_WIRES = { tileX: false, tileY: false, offsetX: false, offsetY: false };

/** The shader's uv pipeline for a glTF-oriented node (graphToCode's image branch). */
function pipeline(values: Record<string, number>, u: number, v: number): [number, number] {
  const n = (k: string, d: number) => (Number.isFinite(Number(values[k])) ? Number(values[k]) : d);
  const M = gltfUvMatrix({
    offsetX: n('xfOffsetX', 0),
    offsetY: n('xfOffsetY', 0),
    rotation: n('xfRotation', 0),
    scaleX: n('xfScaleX', 1),
    scaleY: n('xfScaleY', 1),
  });
  let x = M.m00 * u + M.m01 * v + M.tx;
  let y = M.m10 * u + M.m11 * v + M.ty;
  if (n('flipX', 0) >= 0.5) x = 1 - x;
  if (n('flipY', 0) >= 0.5) y = 1 - y;
  x *= n('tileX', 1);
  y *= n('tileY', 1);
  return [x + n('offsetX', 0), y + n('offsetY', 0)];
}

function apply(t: ReturnType<typeof composeKhrTextureTransform>['transform'], u: number, v: number): [number, number] {
  const M = gltfUvMatrix({
    offsetX: t?.offset?.[0] ?? 0,
    offsetY: t?.offset?.[1] ?? 0,
    rotation: t?.rotation ?? 0,
    scaleX: t?.scale?.[0] ?? 1,
    scaleY: t?.scale?.[1] ?? 1,
  });
  return [M.m00 * u + M.m01 * v + M.tx, M.m10 * u + M.m11 * v + M.ty];
}

function expectSameMap(values: Record<string, number>) {
  const r = composeKhrTextureTransform(values, NO_WIRES);
  expect(r.exact).toBe(true);
  for (const [u, v] of [[0, 0], [1, 0], [0, 1], [0.3, 0.7], [-2, 5]]) {
    const a = pipeline(values, u, v);
    const b = apply(r.transform, u, v);
    expect(Math.abs(a[0] - b[0])).toBeLessThan(1e-9);
    expect(Math.abs(a[1] - b[1])).toBeLessThan(1e-9);
  }
  return r;
}

describe('composeKhrTextureTransform', () => {
  it('identity → null', () => {
    expect(composeKhrTextureTransform({}, NO_WIRES)).toEqual({ transform: null, exact: true });
  });

  it('the xf alone round-trips (the gltfUvMatrix decomposition)', () => {
    const r = expectSameMap({ xfOffsetX: 0.25, xfOffsetY: -0.5, xfRotation: 0.4, xfScaleX: 2, xfScaleY: 2 });
    expect(r.transform!.offset).toEqual([0.25, -0.5]);
    expect(r.transform!.rotation).toBeCloseTo(0.4, 12);
    expect(r.transform!.scale).toEqual([2, 2]);
  });

  it('Flip X + tile 2×2 on a 30° rotation is exact', () => {
    expectSameMap({ xfRotation: Math.PI / 6, flipX: 1, tileX: 2, tileY: 2, offsetX: 0.1 });
  });

  it('a non-uniform tile under a rotation is NOT exact, and returns the xf part', () => {
    const r = composeKhrTextureTransform({ xfRotation: 0.5, tileX: 2, tileY: 3 }, NO_WIRES);
    expect(r).toEqual({ transform: { rotation: 0.5 }, exact: false });
  });

  it('a wired tile → the xf part, not exact', () => {
    expect(composeKhrTextureTransform({ xfScaleX: 3 }, { ...NO_WIRES, tileX: true })).toEqual({
      transform: { scale: [3, 1] },
      exact: false,
    });
  });

  it('snaps: a quarter turn gives clean numbers; mirrors are signed scales with no rotation', () => {
    const quarter = expectSameMap({ xfRotation: Math.PI / 2 });
    expect(quarter.transform!.rotation).toBeCloseTo(Math.PI / 2, 12);
    const flip = expectSameMap({ flipX: 1, flipY: 1 });
    expect(flip.transform).toEqual({ offset: [1, 1], scale: [-1, -1] });
    expectSameMap({ xfRotation: 1.1, xfScaleX: 2, xfScaleY: 2, flipY: 1, tileX: -3, tileY: -3, offsetY: 7 });
  });

  it('out-of-bounds numbers → the xf part, not exact', () => {
    expect(composeKhrTextureTransform({ tileX: 1e9 }, NO_WIRES)).toEqual({ transform: null, exact: false });
  });
});

/* ── the Phase 5 follow-up: a REAL builder section maps completely ───────── */

describe('the real section builder (integration §2c follow-up pin)', () => {
  it('every texture channel of a built section maps; no ambiguous, rewired or missing slot', async () => {
    const m = readOk(blenderGlb());
    const mats = m.materials.filter((x) => x.usage.primitives > 0).map((x) => x.index);
    const { requests } = encodeRequests(m, mats);
    const enc = await encodeGltfImages(m, requests, {
      modelName: 'model.glb',
      maxDim: null,
      deviceMaxDim: 2048,
      ignoreLimits: false,
      budgetChars: Infinity,
      encode: fakeEncoder([]),
      stash: fakeStash(),
    });
    const built = buildGltfSectionGraph(m, { materials: mats, encoded: enc.encoded });
    // The fake encoder writes bytes behind no image magic: give each Texture
    // node a real payload so the plan can accept it.
    let i = 0;
    for (const n of built.nodes) {
      if (n.data.registryType !== 'imageNode') continue;
      const v = (n.data as { values: Record<string, string | number> }).values;
      v.imageB64 = canonicalSrc('image/png', makeRealPng(2, 2, [i++ * 40, 1, 2, 255]));
      v.width = 2;
      v.height = 2;
    }
    const p = plan(built.nodes, built.edges, '', m.signature);
    expect(p.problems).toEqual([]);
    // Material.001: base colour, MR, normal; Material.002: MR (its factor-only
    // colour and emissive are no texture slot).
    expect(brief(p)).toEqual(['0:baseColor', '0:metallicRoughness', '0:normal', '1:metallicRoughness']);
    // Blender's transform survives: offset 0.25, scale 2.
    expect(p.slots[0].transform).toEqual({ offset: [0.25, 0], scale: [2, 2] });
  });
});
