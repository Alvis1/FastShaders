/**
 * The GLB import's SECTION BUILDER (GLB Phase 5 Step 8): a model's PBR
 * materials, as the trusted-side reader reports them (`GltfModelReport`,
 * utils/gltfReader.ts), become ONE OUTPUT NODE PER BUILT MATERIAL — each bound
 * to its glTF material INDEX and wired through the BARE channel handles — plus
 * the untargeted default beside them and the Texture, constant and multiply
 * nodes that feed them.
 *
 * PURE and node-tested: it takes the reader's report and the already-encoded
 * images (utils/gltfTextureEncode.ts) and returns nodes, edges and a small
 * report. It reads no bytes, decodes nothing and never touches the store.
 *
 * What one glTF material becomes (integration plan §5 Q4/Q12/Q13, P5b):
 *   - the DEFAULT Output stays untargeted and empty; glTF material 0 is an
 *     added index node like every other, so an unclaimed mesh keeps its
 *     authored look on 0.8 and on a signature mismatch alike;
 *   - ONE Texture node per (image, sampler, colour space, glTF mapping values
 *     incl. the green flip) — `gltfTextureNodeKey` — shared across sections;
 *   - a factor beside a texture is a Color / Float node multiplied in only
 *     when it is not the identity; a factor with no texture is a STORED
 *     channel value, only when it differs from the material default the
 *     Output already assumes (roughness 1, metalness 0, colour white);
 *   - COLOR_0 multiplies a Vertex Color node in, its alpha (a Split's `w`)
 *     into a non-opaque material's opacity too (glTF 3.9.2); BLEND is `transparent` with
 *     `depthWrite: false` (GLTFLoader's choice); MASK is `alphaTest` clamped
 *     to 0.99 (three discards on `alpha <= alphaTest`, so 1 erases all);
 *     `doubleSided` is `side: 'double'`; emissive strength is a Float ×;
 *   - the normal map's green flip follows the material's tangent-less
 *     primitives (`normalGreenFlipFor`);
 *   - occlusion, `normalTexture.scale`, clearcoat and the other PBR
 *     extensions are REPORTED, never imported (`unsupportedFeaturesOf`).
 *
 * Every input is adversarial (it came out of a dropped file). Nothing here
 * emits a string from the model except the signature names (the reader's
 * checked list, re-sanitised) and the mirror mesh names (`isUsableMeshName`,
 * through `mirrorNamesByMaterial`); an Image node's file name is the reader's
 * `gltfImageFileName`. Node ids are minted here from glTF indices, so the
 * same model builds the same graph twice (the snapshot tests rest on it) —
 * including the per-material Output ids (`gi_output_m<gltfIndex>`).
 */
import { NODE_REGISTRY, getFlowNodeType } from '@/registry/nodeRegistry';
import { getCost } from '@/utils/costTable';
import { imageNodeCost } from '@/utils/nodeCost';
import { makeImageNodeFromEncode } from '@/utils/imageNode';
import { makeTypedEdge } from '@/utils/edgeUtils';
import { MAX_MODEL_MESHES, UNFOLD_DY, sanitizeModelMeshes } from '@/utils/outputMaterials';
import { OUTPUT_DEFAULT_EXPOSED } from '@/utils/exposedPorts';
import { gltfSamplerValues, gltfTextureValues } from '@/utils/imageUvMapping';
import { isUsableMeshName } from '@/utils/meshInventory';
import {
  slotColorSpace,
  type GltfMaterial,
  type GltfModelReport,
  type GltfSlot,
  type GltfSlotRef,
} from '@/utils/gltfReader';
import {
  emissiveIsUnused,
  linearToSrgbHex,
  normalGreenFlipFor,
  orderFeatures,
  unsupportedFeaturesOf,
  type GltfFeatureId,
} from '@/utils/gltfImportPlan';
import type { GltfEncodedImage } from '@/utils/gltfTextureEncode';
import { sanitizeModelSignature } from './materialPartsContract';
import { autoLayout } from './layoutEngine';
import type { AppNode, AppEdge, MaterialSettings, NodeDefinition, TSLDataType } from '@/types';

export interface BuildSectionsOptions {
  /** The glTF material indices to build, ascending (`planBuiltMaterials`). */
  readonly materials: readonly number[];
  /** glTF image index → its encode; an absent image leaves its slot factor-only. */
  readonly encoded: ReadonlyMap<number, GltfEncodedImage>;
}

export interface GltfBuildReport {
  /** Index sections built — one Output NODE each. */
  sections: number;
  /** Unique Texture nodes. */
  textureNodes: number;
  /** Texture nodes wired into two or more sections. */
  sharedTextureNodes: number;
  /** What the built materials asked for that was not imported, in the closed
   *  order, each once. */
  notImported: GltfFeatureId[];
}

/** The Output's channels, in the on-node order an added section lists them. */
const PORT_ORDER = ['color', 'emissive', 'roughness', 'metalness', 'opacity', 'normal', 'position'] as const;

const WHITE = '#ffffff';

/** A wired output: node id + handle, with the port's declared type. */
interface Ref {
  readonly id: string;
  readonly handle: string;
  readonly dataType: TSLDataType;
}

function def(type: string): NodeDefinition {
  const d = NODE_REGISTRY.get(type);
  if (!d) throw new Error(`gltfSectionBuilder: no registry definition for "${type}"`);
  return d;
}

function portType(d: NodeDefinition, handle: string): TSLDataType {
  return d.outputs.find((p) => p.id === handle)?.dataType ?? 'any';
}

/**
 * THE layout order of the built graph: every feeder takes the key of the
 * EARLIEST Output socket it reaches — the section first, then the channel's own
 * ROW on the node (`def('output').inputs` order, which is what the Output
 * renders) — so reading the graph top to bottom follows the sockets the wires
 * land on. Without it the vertical order is dagre's, which knows nothing about
 * handles: measured on a one-material model with all four texture slots, the
 * feeders stacked Roughness, Color, Metalness, Normal, Emissive against rows
 * reading Color, Emissive, Roughness, Metalness, Normal — every wire crossed
 * (owner, 2026-09-18).
 *
 * The section comes from `outputRank` — the TARGET NODE's `emitOrder` — and
 * never from the handle. Since the Output split every material wears the BARE
 * channel ids, so the old `parseChannelHandle(...).index * 100` term is 0 for
 * every wire in the graph and the key collapses to the channel alone: nothing
 * fails, the layout simply INTERLEAVES every material's feeders by channel,
 * which is the exact tangle this function was written to fix.
 *
 * A node feeding two sections (a shared ORM texture) belongs to the FIRST,
 * which is the one place it can be; its second wire still crosses, inherently.
 * Sockets are walked in key order and each upstream node is claimed once, so
 * the result is deterministic and independent of build order. A node reaching
 * no Output socket gets no key and keeps dagre's order, after the keyed ones.
 */
function feederOrder(
  outputRank: ReadonlyMap<string, number>,
  edges: readonly AppEdge[],
  channelRank: ReadonlyMap<string, number>,
): Map<string, number> {
  const sources = new Map<string, string[]>();
  for (const e of edges) {
    const list = sources.get(e.target);
    if (list) list.push(e.source);
    else sources.set(e.target, [e.source]);
  }
  const keyed = edges
    .filter((e) => outputRank.has(e.target))
    .map((e) => {
      // 100 > every channel rank, so the section always outranks the channel.
      const key = outputRank.get(e.target)! * 100 + (channelRank.get(e.targetHandle ?? '') ?? 99);
      return { src: e.source, key };
    })
    .sort((a, b) => a.key - b.key);
  const order = new Map<string, number>();
  for (const { src, key } of keyed) {
    const stack = [src];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (order.has(id)) continue;
      order.set(id, key);
      for (const s of sources.get(id) ?? []) stack.push(s);
    }
  }
  return order;
}

/** The sorted `k=v` join of a values map — the stable half of a node key. */
function stableValues(v: Record<string, string | number>): string {
  return Object.keys(v)
    .sort()
    .map((k) => `${k}=${String(v[k])}`)
    .join(',');
}

/**
 * The Texture-node FAN-OUT key of one texture use: image | sampler | colour
 * space | the mapping values `gltfTextureValues` derives (texCoord, the
 * KHR_texture_transform, the green flip) | the sampler values. Two uses with
 * equal keys share ONE node. Null when the texture has no extractable image.
 * The dialog's texture facts use the same function, so what it counts is
 * what the builder makes.
 */
export function gltfTextureNodeKey(
  m: GltfModelReport,
  ref: GltfSlotRef,
  colorSpace: 'color' | 'data',
  normalGreenFlip: boolean,
): string | null {
  const tex = Number.isInteger(ref.texture) ? m.textures[ref.texture] : undefined;
  if (!tex || tex.extract.status !== 'ok') return null;
  const mv = gltfTextureValues(ref.textureInfo, { normalGreenFlip }).values;
  const sv = gltfSamplerValues(tex.sampler === null ? undefined : m.samplers[tex.sampler]).values;
  return `${tex.extract.image}|${tex.sampler ?? -1}|${colorSpace}|${stableValues(mv)}|${stableValues(sv)}`;
}

/** The material of glTF index `i`, or undefined. The reader lists every
 *  material in order, so the position is the index; checked, not assumed. */
function materialAt(m: GltfModelReport, i: number): GltfMaterial | undefined {
  if (!Number.isInteger(i) || i < 0) return undefined;
  const direct = m.materials[i];
  if (direct && direct.index === i) return direct;
  return m.materials.find((mat) => mat.index === i);
}

/**
 * Build the Output node and its feeders for `o.materials`. Returns the laid
 * out graph and the build report. A model whose signature the contract
 * sanitizer refuses (the reader already refuses it, so this is defensive)
 * builds NO sections and reports `signatureTooLarge`.
 */
export function buildGltfSectionGraph(
  m: GltfModelReport,
  o: BuildSectionsOptions,
): { nodes: AppNode[]; edges: AppEdge[]; report: GltfBuildReport; signatureTooLarge: boolean } {
  const nodes: AppNode[] = [];
  const edges: AppEdge[] = [];
  const features = new Set<GltfFeatureId>();
  let serial = 0;

  const signature = sanitizeModelSignature({ materials: m.signature.materials.slice() });

  /* ── node factories ────────────────────────────────────────────────────── */

  const constant = (type: string, values: Record<string, string | number>, tag: string): Ref => {
    const d = def(type);
    const id = `gi_${tag}_${++serial}`;
    nodes.push({
      id,
      type: getFlowNodeType(d),
      position: { x: 0, y: 0 },
      data: { registryType: d.type, label: d.label, cost: getCost(d.type), values: { ...d.defaultValues, ...values } },
    } as AppNode);
    return { id, handle: 'out', dataType: portType(d, 'out') };
  };

  const wire = (from: Ref, to: string, toHandle: string): void => {
    edges.push(makeTypedEdge(from.id, from.handle, to, toHandle, from.dataType));
  };

  /** `a × b` as a Multiply node fed by both. */
  const mul = (a: Ref, b: Ref, tag: string): Ref => {
    const d = def('mul');
    const id = `gi_${tag}_mul_${++serial}`;
    nodes.push({
      id,
      type: getFlowNodeType(d),
      position: { x: 0, y: 0 },
      data: { registryType: d.type, label: d.label, cost: getCost(d.type), values: {} },
    } as AppNode);
    wire(a, id, 'a');
    wire(b, id, 'b');
    return { id, handle: 'out', dataType: 'any' };
  };

  /** A vector's `w` as a Split node fed by it. */
  const wOf = (v: Ref, tag: string): Ref => {
    const d = def('split');
    const id = `gi_${tag}_split_${++serial}`;
    nodes.push({
      id,
      type: getFlowNodeType(d),
      position: { x: 0, y: 0 },
      data: { registryType: d.type, label: d.label, cost: getCost(d.type), values: {} },
    } as AppNode);
    wire(v, id, 'v');
    return { id, handle: 'w', dataType: portType(d, 'w') };
  };

  // ONE Texture node per fan-out key; which sections each one feeds.
  const textureByKey = new Map<string, string>();
  const textureSections = new Map<string, Set<number>>();
  const imageDef = def('imageNode');

  const texNode = (
    ref: GltfSlotRef | undefined,
    slot: GltfSlot,
    normalGreenFlip: boolean,
    section: number,
  ): ((handle: 'out' | 'alpha' | 'r' | 'g' | 'b') => Ref) | null => {
    if (!ref) return null;
    const colorSpace = slotColorSpace(slot);
    const key = gltfTextureNodeKey(m, ref, colorSpace, normalGreenFlip);
    if (key === null) return null;
    const tex = m.textures[ref.texture];
    const enc = tex.extract.status === 'ok' ? o.encoded.get(tex.extract.image) : undefined;
    if (!enc) return null;
    let id = textureByKey.get(key);
    if (id === undefined) {
      const mv = gltfTextureValues(ref.textureInfo, { normalGreenFlip });
      const sv = gltfSamplerValues(tex.sampler === null ? undefined : m.samplers[tex.sampler]);
      for (const u of mv.unsupported) if (u === 'texCoord') features.add('texCoord');
      for (const u of sv.unsupported) features.add(u);
      const { width, height } = enc.payload;
      const data = makeImageNodeFromEncode(
        enc.payload,
        imageNodeCost(getCost('imageNode'), width, height),
        enc.fileName,
        enc.origin,
      );
      data.values = { ...data.values, ...sv.values, ...mv.values, colorSpace };
      id = `gi_img${tex.extract.image}_${++serial}`;
      nodes.push({ id, type: getFlowNodeType(imageDef), position: { x: 0, y: 0 }, data } as AppNode);
      textureByKey.set(key, id);
      textureSections.set(key, new Set());
    }
    textureSections.get(key)!.add(section);
    const nodeId = id;
    return (handle) => ({ id: nodeId, handle, dataType: portType(imageDef, handle) });
  };

  /* ── the sections ──────────────────────────────────────────────────────── */

  const outDef = def('output');
  /**
   * The UNTARGETED default, pushed FIRST so it is `outputs[0]` in array order
   * too, and rank 0 — `unfoldOutputMaterials` seeds material 0 the same way, so
   * a built document and a restored one describe their order identically.
   * It keeps the plain `gi_output` id it had while every material lived on it.
   */
  const outputId = 'gi_output';
  nodes.push({
    id: outputId,
    type: 'output',
    position: { x: 0, y: 0 },
    data: { registryType: 'output', label: outDef.label, cost: getCost('output'), emitOrder: 0 },
  } as AppNode);

  /** Every index node's id in build order, and its `emitOrder`. */
  const sectionNodes: AppNode[] = [];
  const outputRank = new Map<string, number>([[outputId, 0]]);
  const built: number[] = [];
  const requested = signature
    ? [...new Set(o.materials.filter((v): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0))].sort(
        (a, b) => a - b,
      )
    : [];

  for (const gi of requested) {
    const p = materialAt(m, gi);
    if (!p || gi >= signature!.materials.length) continue;
    // One Output NODE per built material, on the BARE channel handles, minted
    // BEFORE its feeders so the edges below can name it. Its rank is its
    // position in the ascending index order, which is what emission walks.
    const section = built.length + 1;
    const sectionId = `gi_output_m${gi}`;
    const sectionNode = {
      id: sectionId,
      type: 'output',
      position: { x: 0, y: 0 },
      data: {
        registryType: 'output',
        label: outDef.label,
        cost: getCost('output'),
        emitOrder: section,
        gltfMaterialIndex: gi,
        // Replicated on every index node, as `unfoldOutputMaterials` and
        // `sanitizeOutputMaterialsReport` replicate it: dormancy
        // (`indexSectionsAwake`) is decided per NODE.
        modelSignature: { materials: signature!.materials.slice() },
      },
    } as AppNode;
    // Wired on the BARE channel handles: one Output NODE is one material since
    // the split, so the namespaced handle builder is retired here and the section
    // node's own id is what every edge below names. Both used to be re-bound —
    // `outputId = sectionId` shadowed the DEFAULT's id for this whole loop body,
    // and `h` was left as an identity function. Harmless (no site in here wants
    // the default) but a trap: the two ids are read ~170 lines apart.
    const tag = `m${gi}`;
    const vals: Record<string, string | number> = {};
    const settings: MaterialSettings = {};
    const shown = new Set<string>();
    const slotRef = (s: GltfSlot) => p.slots.find((r) => r.slot === s);

    for (const f of unsupportedFeaturesOf(p)) features.add(f);

    // Colour: texture × factor (when not white) × vertex colour (when painted).
    const base = texNode(slotRef('baseColor'), 'baseColor', false, section);
    const hex = linearToSrgbHex(p.baseColorFactor);
    const painted = p.usage.withVertexColors > 0;
    let chain: Ref | null = base ? base('out') : null;
    let vc: Ref | null = null;
    if (chain && hex !== WHITE) chain = mul(chain, constant('color', { hex }, `${tag}_color`), tag);
    if (painted) {
      vc = constant('vertexColor', {}, `${tag}_vertex`);
      chain = chain ? mul(chain, vc, tag) : hex !== WHITE ? mul(vc, constant('color', { hex }, `${tag}_color`), tag) : vc;
    }
    if (chain) {
      wire(chain, sectionId, 'color');
      shown.add('color');
    } else if (hex !== WHITE) {
      vals.color = hex;
      shown.add('color');
    }

    // Opacity: only a non-opaque material reads its alpha at all. COLOR_0's
    // alpha multiplies it (glTF 3.9.2; three draws `colorNode × vertexColor()`
    // as a vec4), so a painted primitive's alpha is wired too — the colour
    // chain's `vec3()` widening drops that `w`. A VEC3 COLOR_0 reads w = 1.
    if (p.alphaMode !== 'OPAQUE') {
      const a = p.baseColorFactor[3];
      if (base) {
        let alpha: Ref = base('alpha');
        if (a !== 1) alpha = mul(alpha, constant('float', { value: a }, `${tag}_alpha`), tag);
        if (vc) alpha = mul(alpha, wOf(vc, tag), tag);
        wire(alpha, sectionId, 'opacity');
        shown.add('opacity');
      } else if (vc) {
        let alpha = wOf(vc, tag);
        if (a !== 1) alpha = mul(alpha, constant('float', { value: a }, `${tag}_alpha`), tag);
        wire(alpha, sectionId, 'opacity');
        shown.add('opacity');
      } else if (a !== 1) {
        vals.opacity = a;
        shown.add('opacity');
      }
      if (p.alphaMode === 'BLEND') {
        settings.transparent = true;
        settings.depthWrite = false;
      } else {
        settings.alphaTest = Math.min(p.alphaCutoff, 0.99);
        if (p.alphaCutoff > 0.99) features.add('alphaCutoff');
      }
    }

    // Roughness / metalness: the packed map's G and B, each × its factor.
    const mr = texNode(slotRef('metallicRoughness'), 'metallicRoughness', false, section);
    if (mr) {
      let rough: Ref = mr('g');
      if (p.roughnessFactor !== 1) rough = mul(rough, constant('float', { value: p.roughnessFactor }, `${tag}_rough`), tag);
      wire(rough, sectionId, 'roughness');
      shown.add('roughness');
      let metal: Ref = mr('b');
      if (p.metallicFactor !== 1) metal = mul(metal, constant('float', { value: p.metallicFactor }, `${tag}_metal`), tag);
      wire(metal, sectionId, 'metalness');
      shown.add('metalness');
    } else {
      if (p.roughnessFactor !== 1) {
        vals.roughness = p.roughnessFactor;
        shown.add('roughness');
      }
      if (p.metallicFactor !== 0) {
        vals.metalness = p.metallicFactor;
        shown.add('metalness');
      }
    }

    // Normal map, with the green flip its tangent-less primitives need.
    const { flip, mixed } = normalGreenFlipFor(p);
    const normal = texNode(slotRef('normal'), 'normal', flip, section);
    if (normal) {
      wire(normal('out'), sectionId, 'normal');
      shown.add('normal');
      if (mixed) features.add('mixedTangents');
    }

    // Emissive: skipped outright when it cannot shine.
    if (emissiveIsUnused(p)) {
      if (slotRef('emissive')) features.add('emissiveUnused');
    } else {
      const eh = linearToSrgbHex(p.emissiveFactor);
      const s = p.emissiveStrength;
      const em = texNode(slotRef('emissive'), 'emissive', false, section);
      if (em) {
        let e: Ref = em('out');
        if (eh !== WHITE) e = mul(e, constant('color', { hex: eh }, `${tag}_emissive`), tag);
        if (s !== 1) e = mul(e, constant('float', { value: s }, `${tag}_strength`), tag);
        wire(e, sectionId, 'emissive');
        shown.add('emissive');
      } else if (s === 1) {
        vals.emissive = eh;
        shown.add('emissive');
      } else {
        const e = mul(constant('color', { hex: eh }, `${tag}_emissive`), constant('float', { value: s }, `${tag}_strength`), tag);
        wire(e, sectionId, 'emissive');
        shown.add('emissive');
      }
    }

    if (p.doubleSided) settings.side = 'double';

    const sectionData = sectionNode.data as Record<string, unknown>;
    sectionData.exposedPorts = PORT_ORDER.filter((c) => OUTPUT_DEFAULT_EXPOSED.includes(c) || shown.has(c));
    if (Object.keys(vals).length > 0) sectionData.values = vals;
    if (Object.keys(settings).length > 0) sectionData.materialSettings = settings;
    nodes.push(sectionNode);
    sectionNodes.push(sectionNode);
    outputRank.set(sectionId, section);
    built.push(gi);
  }

  /* ── the loader-0.6 mirror source ──────────────────────────────────────── */

  // `modelMeshes` stays ONE WHOLE LIST on the LOWEST-ranked index node — the
  // first material built, which is the lowest glTF index — never split per
  // material: it is filled in first-SCENE-appearance order, which interleaves
  // materials, and `materialPartsMirrorPlanAcross` walks that stored order
  // straight into module TEXT, so regrouping it by material would silently
  // reorder the mirror keys of every already-distributed single-GLB export.
  // (`unfoldOutputMaterials` puts it in exactly the same place.)
  if (sectionNodes.length > 0 && signature) {
    // Every CERTAIN, usable predicted mesh name carried only by meshes of
    // exactly one BUILT material (P5a's rule; an uncertain name is never
    // mirrored).
    const builtSet = new Set(built);
    const meshes: { name: string; material: number }[] = [];
    for (const [name, e] of m.meshNameIndex) {
      if (meshes.length >= MAX_MODEL_MESHES) break;
      if (!e.certain || !isUsableMeshName(name) || e.materials.length !== 1) continue;
      const mat = e.materials[0];
      if (mat === null || !builtSet.has(mat)) continue;
      meshes.push({ name, material: mat });
    }
    const clean = sanitizeModelMeshes(meshes, signature.materials.length);
    if (clean) (sectionNodes[0].data as Record<string, unknown>).modelMeshes = clean;
  }

  let shared = 0;
  for (const s of textureSections.values()) if (s.size >= 2) shared++;

  // The channel's ROW on the node is `def.inputs` order (PIXEL_PORTS then
  // VERTEX_PORTS, which the registry's own order already spells), so the
  // feeders can be stacked in the order of the sockets they land on.
  const channelRank = new Map(outDef.inputs.map((p, i) => [p.id, i]));
  const laid = autoLayout(nodes, edges, 'LR', undefined, feederOrder(outputRank, edges, channelRank));

  /**
   * The DEFAULT Output is wired to NOTHING, so dagre has no reason to put it
   * anywhere in particular and drops it among the Texture nodes on the left —
   * an empty card in the middle of the feeders, which reads as junk rather than
   * as "the material every unclaimed mesh keeps". It is placed by hand instead:
   * the section nodes are all sinks, so they land in one column, and the default
   * goes one `UNFOLD_DY` above the topmost of them — the unfold's own pitch, so
   * a built column and a restored one are the same column. Whether that column
   * reads at all on a 16-material import is the canvas's question, not this
   * function's.
   */
  const laidSections = laid.filter((n) => outputRank.has(n.id) && n.id !== outputId);
  const defaultNode = laid.find((n) => n.id === outputId);
  if (defaultNode && laidSections.length > 0) {
    let top = laidSections[0];
    for (const n of laidSections) if (n.position.y < top.position.y) top = n;
    defaultNode.position = { x: top.position.x, y: top.position.y - UNFOLD_DY };
  }

  return {
    nodes: laid,
    edges,
    report: {
      sections: sectionNodes.length,
      textureNodes: textureByKey.size,
      sharedTextureNodes: shared,
      notImported: orderFeatures(features),
    },
    signatureTooLarge: signature === null,
  };
}

/** The on-node channel order an added section lists (exported for the tests). */
export const SECTION_PORT_ORDER: readonly string[] = PORT_ORDER;
