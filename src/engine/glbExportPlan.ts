/**
 * The single-GLB export's PLAN (Phase 7 Step 3): which glTF texture slots the
 * repacker (utils/glbRepack.ts) writes, which payloads ride in the file, and
 * the module's `fs-asset:` keys. Pure over the graph; it never reads the
 * store.
 *
 * PROVENANCE IS DERIVED, NOT STORED. A glTF slot (material i, slot S) is
 * written iff exactly ONE Image node
 *   - carries the glTF orientation (`readImageUvMapping`),
 *   - reaches a channel of the EMITTING index section of material i
 *     (`planIndexParts` — emission's own first-claim list, so a shadowed
 *     duplicate never maps),
 *   - through its canonical socket (color←out, opacity←alpha, roughness←g,
 *     metalness←b, normal←out, emissive←out),
 *   - over `mul` and `split` nodes only (the builder's factor and
 *     vertex-colour multiplies, and the Split that takes COLOR_0's alpha for
 *     a non-opaque material's opacity — engine/gltfSectionBuilder.ts; opacity
 *     shares the baseColor slot, so that Split is walked for it).
 * Two candidates are `ambiguous`; a channel fed by anything ELSE (a noise, a
 * mix, an image through a non-canonical socket) with no candidate is
 * `rewired`. Both leave the slot empty. A chain of only the builder's factor
 * leaves (Color, Float, Vertex Color, a converted property) is not a texture
 * slot at all and reports nothing. Material FACTORS are never written back:
 * the module carries the authored look, the file keeps the model's.
 *
 * The texture's placement is rebuilt from the node's stored values: `texCoord`
 * from `uvSet`, KHR_texture_transform from the `xf*` keys composed with the
 * Flip / Tile / Offset settings (`composeKhrTextureTransform`, exact when the
 * Khronos reference form can hold it, else the xf part alone and a
 * `uv-approximated` note), and the sampler from `readImageTextureSpec`.
 */
import { unwrapCollapsedGroupEdges } from '@/utils/edgeUtils';
import { drivingMarchOutput } from '@/utils/sdfPartition';
import {
  channelHandle,
  findDefaultOutput,
  outputMaterials,
  planIndexParts,
  readModelSignature,
} from '@/utils/outputMaterials';
import { modelSignatureMatches, type ModelSignature } from './materialPartsContract';
import { gltfUvMatrix, readImageUvMapping } from '@/utils/imageUvMapping';
import { readImageTextureSpec } from '@/utils/imageTextureSpec';
import { decodeDataUri, sniffImageFormat } from '@/utils/glbContainer';
import { isLosslessWebpBytes } from '@/utils/imageCodec';
import { HARD_MAX_IMAGE_ENCODED_CHARS } from '@/utils/imageNode';
import { IMAGE_ASSET_KEY_RE } from './glbShaderContract';
import { IMAGE_PLACEHOLDER_RE, imageAssetFor } from './imageAssets';
import {
  GLTF_WRITABLE_SLOTS,
  samplerFor,
  type GltfWritableSlot,
  type KhrTextureTransform,
  type RepackAsset,
  type RepackPayload,
  type RepackSlot,
} from '@/utils/glbRepack';
import { getNodeValues, type AppEdge, type AppNode } from '@/types';

export type GlbSlotProblemReason = 'ambiguous' | 'rewired' | 'not-gltf-oriented' | 'invalid-payload';
export type GlbSlotNote = 'uv-approximated' | 'uv-wired';

export interface GlbSlotProblem {
  material: number;
  slot: GltfWritableSlot;
  reason: GlbSlotProblemReason;
}

export interface GlbExportPlan {
  /** glTF indices of the emitting index sections, ascending. */
  indexMaterials: number[];
  /** Sorted (material ascending, GLTF_WRITABLE_SLOTS order). */
  slots: RepackSlot[];
  notes: { material: number; slot: GltfWritableSlot; note: GlbSlotNote }[];
  problems: GlbSlotProblem[];
  /** The module's keys in first-occurrence order, then one key per slot payload the module does not name. */
  moduleAssets: RepackAsset[];
  /** Every distinct payload the slots and assets use, keyed by the FULL canonical src. */
  payloads: Map<string, RepackPayload>;
  /** canonical src → the stored pixel size of the first node holding it (the fallback encoder's canvas). */
  payloadSizes: Map<string, { width: number; height: number }>;
}

/** Most nodes one channel's upstream walk visits. */
export const GLB_SLOT_WALK_MAX = 64;

/** Output channel → [the glTF slot it belongs to, the Texture socket the builder wires]. */
export const GLB_CHANNEL_SLOTS: ReadonlyMap<string, readonly [GltfWritableSlot, string]> = new Map<
  string,
  readonly [GltfWritableSlot, string]
>([
  ['color', ['baseColor', 'out']],
  ['opacity', ['baseColor', 'alpha']],
  ['roughness', ['metallicRoughness', 'g']],
  ['metalness', ['metallicRoughness', 'b']],
  ['normal', ['normal', 'out']],
  ['emissive', ['emissive', 'out']],
]);

/** Leaves a builder-shaped factor chain is made of: never a texture, never "rewired". */
const FACTOR_LEAF_TYPES: ReadonlySet<string> = new Set([
  'color',
  'float',
  'vertexColor',
  'property_color',
  'property_float',
]);

const MIME_FORMAT: ReadonlyMap<string, string> = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpeg'],
  ['image/webp', 'webp'],
]);

/* ── the texture transform ───────────────────────────────────────────────── */

const MAX_MAGNITUDE = 1e6;

function snap(x: number): number {
  if (Math.abs(x) < 1e-12) return 0;
  const r = Math.round(x);
  if (Math.abs(x - r) < 1e-12) return r === 0 ? 0 : r;
  return x === 0 ? 0 : x;
}

/** The codegen's own read: `Number()`, a non-finite value is the default. */
function numVal(values: Readonly<Record<string, unknown>>, key: string, dflt: number): number {
  const v = Number(values[key]);
  return Number.isFinite(v) ? v : dflt;
}

function transformOf(offset: [number, number], rotation: number, scale: [number, number]): KhrTextureTransform | null {
  const t: KhrTextureTransform = {};
  if (offset[0] !== 0 || offset[1] !== 0) t.offset = [snap(offset[0]), snap(offset[1])];
  if (rotation !== 0) t.rotation = snap(rotation);
  if (scale[0] !== 1 || scale[1] !== 1) t.scale = [snap(scale[0]), snap(scale[1])];
  return Object.keys(t).length > 0 ? t : null;
}

/**
 * The node's glTF texture transform (the `xf*` keys) composed with its Flip,
 * Tile and Offset settings as ONE KHR_texture_transform in the Khronos
 * reference form (scale, then rotation about the UV origin, then offset —
 * utils/imageUvMapping.ts `gltfUvMatrix`). The shader's uv pipeline is
 * transform → mirror → tile → offset (graphToCode's image branch, glTF
 * orientation), so the composed map is `A·uv + b` with
 * `A = diag(kx·dmx, ky·dmy)·M` and `b = (kx·(dmx·tx + emx) + ox, …)`.
 *
 * `exact` is false — and the xf part alone is returned — when a Tile/Offset
 * socket is WIRED (a value the file cannot hold), when a number is out of
 * bounds, or when A is not of the reference form (a rotation under a
 * non-uniform tile). A diagonal A is written as signed scales with no
 * rotation. Null = the identity.
 */
export function composeKhrTextureTransform(
  values: Readonly<Record<string, unknown>>,
  wired: { tileX: boolean; tileY: boolean; offsetX: boolean; offsetY: boolean },
): { transform: KhrTextureTransform | null; exact: boolean } {
  const xf = readImageUvMapping(values).transform;
  const xfPart = xf ? transformOf([xf.offsetX, xf.offsetY], xf.rotation, [xf.scaleX, xf.scaleY]) : null;
  if (wired.tileX || wired.tileY || wired.offsetX || wired.offsetY) return { transform: xfPart, exact: false };

  const M = gltfUvMatrix(xf ?? { offsetX: 0, offsetY: 0, rotation: 0, scaleX: 1, scaleY: 1 });
  const flipX = numVal(values, 'flipX', 0) >= 0.5;
  const flipY = numVal(values, 'flipY', 0) >= 0.5;
  const dmx = flipX ? -1 : 1;
  const emx = flipX ? 1 : 0;
  const dmy = flipY ? -1 : 1;
  const emy = flipY ? 1 : 0;
  const kx = numVal(values, 'tileX', 1);
  const ky = numVal(values, 'tileY', 1);
  const ox = numVal(values, 'offsetX', 0);
  const oy = numVal(values, 'offsetY', 0);

  const a00 = snap(kx * dmx * M.m00);
  const a01 = snap(kx * dmx * M.m01);
  const a10 = snap(ky * dmy * M.m10);
  const a11 = snap(ky * dmy * M.m11);
  const bx = snap(kx * (dmx * M.tx + emx) + ox);
  const by = snap(ky * (dmy * M.ty + emy) + oy);
  const all = [a00, a01, a10, a11, bx, by];
  if (!all.every((n) => Number.isFinite(n) && Math.abs(n) <= MAX_MAGNITUDE)) return { transform: xfPart, exact: false };

  if (a01 === 0 && a10 === 0) return { transform: transformOf([bx, by], 0, [a00, a11]), exact: true };

  const sx = Math.hypot(a00, a10);
  if (sx < 1e-12) return { transform: xfPart, exact: false };
  const c = a00 / sx;
  const s = -a10 / sx;
  const sy = a01 * s + a11 * c;
  const exact = Math.abs(a01 - sy * s) + Math.abs(a11 - sy * c) <= 1e-9 * Math.max(1, Math.abs(sy));
  if (!exact) return { transform: xfPart, exact: false };
  return { transform: transformOf([bx, by], Math.atan2(snap(s), snap(c)), [sx, sy]), exact: true };
}

/* ── the plan ────────────────────────────────────────────────────────────── */

interface Asset {
  key: string;
  src: string;
  name: string;
  width: number;
  height: number;
}

function payloadOf(src: string): RepackPayload | null {
  const d = decodeDataUri(src, 'image', HARD_MAX_IMAGE_ENCODED_CHARS);
  if (!d.ok) return null;
  const format = MIME_FORMAT.get(d.mime);
  if (format === undefined || sniffImageFormat(d.bytes) !== format) return null;
  const mime = d.mime as RepackPayload['mime'];
  return {
    mime,
    bytes: d.bytes,
    lossless: mime === 'image/png' || (mime === 'image/webp' && isLosslessWebpBytes(d.bytes)),
  };
}

/**
 * Plan a single-GLB export over the graph. `moduleText` is the module the
 * file will carry (placeholders kept); `baseSignature` the loaded model's.
 * With index sections, the Output's signature must match the model
 * (`model-mismatch` otherwise) — without any, nothing is checked and no slot
 * is written (a model-only drop keeps its own textures).
 */
export function planGlbExport(
  nodes: AppNode[],
  edges: AppEdge[],
  moduleText: string,
  baseSignature: ModelSignature,
): { ok: true; plan: GlbExportPlan } | { ok: false; reason: 'model-mismatch' } {
  const E = unwrapCollapsedGroupEdges(nodes, edges);
  const byId = new Map<string, AppNode>();
  for (const n of nodes) if (!byId.has(n.id)) byId.set(n.id, n);

  // Every Image node's asset (key → src, name, stored size), memoised per node.
  const assetOfNode = new Map<string, Asset | null>();
  const assetFor = (n: AppNode): Asset | null => {
    let a = assetOfNode.get(n.id);
    if (a !== undefined) return a;
    const v = getNodeValues(n);
    const asset = imageAssetFor(n.id, v);
    a = asset
      ? { key: asset.key, src: asset.src, name: String(v.fileName ?? ''), width: Number(v.width), height: Number(v.height) }
      : null;
    assetOfNode.set(n.id, a);
    return a;
  };

  // A march drives: the module is the march's, so no material slot maps.
  const out = drivingMarchOutput(nodes, E) ? null : findDefaultOutput(nodes);
  const signature = out ? readModelSignature(out.data) : null;
  const sections = out ? planIndexParts(outputMaterials(out), signature).entries : [];
  if (sections.length > 0 && !modelSignatureMatches({ materials: signature as string[] }, baseSignature)) {
    return { ok: false, reason: 'model-mismatch' };
  }
  const indexMaterials = [...new Set(sections.map((s) => s.gltfIndex))].sort((a, b) => a - b);

  // The single-input rule: the first edge into a (target, handle) wins.
  const inByTarget = new Map<string, AppEdge>();
  const intoNode = new Map<string, AppEdge[]>();
  for (const e of E) {
    const k = `${e.target}\u0000${e.targetHandle ?? ''}`;
    if (!inByTarget.has(k)) inByTarget.set(k, e);
    const list = intoNode.get(e.target);
    if (list) list.push(e);
    else intoNode.set(e.target, [e]);
  }
  const edgeInto = (target: string, handle: string) => inByTarget.get(`${target}\u0000${handle}`);

  const slots: RepackSlot[] = [];
  const notes: GlbExportPlan['notes'] = [];
  const problems: GlbSlotProblem[] = [];
  const slotNodes = new Map<string, AppNode>();

  for (const { gltfIndex, section } of sections) {
    const perSlot = new Map<GltfWritableSlot, { candidates: Set<string>; wired: boolean; foreign: boolean }>();
    for (const [channel, [slot, socket]] of GLB_CHANNEL_SLOTS) {
      let acc = perSlot.get(slot);
      if (!acc) {
        acc = { candidates: new Set(), wired: false, foreign: false };
        perSlot.set(slot, acc);
      }
      const first = out ? edgeInto(out.id, channelHandle(section, channel)) : undefined;
      if (!first) continue;
      acc.wired = true;
      const stack: AppEdge[] = [first];
      const visited = new Set<string>();
      while (stack.length > 0) {
        const e = stack.pop() as AppEdge;
        const src = byId.get(e.source);
        const type = src?.data.registryType;
        if (!src) {
          acc.foreign = true;
        } else if (type === 'imageNode') {
          // An image reached THROUGH a Split feeds one channel of itself, not
          // the canonical socket — never a candidate, always `rewired`.
          const throughSplit = byId.get(e.target)?.data.registryType === 'split';
          if (!throughSplit && (e.sourceHandle ?? 'out') === socket) acc.candidates.add(src.id);
          else acc.foreign = true;
        } else if (type === 'mul' || type === 'split') {
          if (visited.has(src.id)) continue;
          if (visited.size >= GLB_SLOT_WALK_MAX) {
            // Truncation is CONSERVATIVE, like every other refusal here: what
            // the walk did not reach may hold a second image, so a candidate
            // found before the cap must not become the slot. `foreign` alone is
            // read only when there are NO candidates, so without the clear the
            // stack's LIFO order decided the export — the same graph wrote a
            // texture or reported `rewired` depending on which edge came first
            // in the array.
            acc.candidates.clear();
            acc.foreign = true;
            break;
          }
          visited.add(src.id);
          for (const up of intoNode.get(src.id) ?? []) stack.push(up);
        } else if (!FACTOR_LEAF_TYPES.has(String(type))) {
          acc.foreign = true;
        }
      }
    }

    for (const slot of GLTF_WRITABLE_SLOTS) {
      const acc = perSlot.get(slot);
      if (!acc || !acc.wired) continue;
      if (acc.candidates.size === 0) {
        if (acc.foreign) problems.push({ material: gltfIndex, slot, reason: 'rewired' });
        continue;
      }
      if (acc.candidates.size > 1) {
        problems.push({ material: gltfIndex, slot, reason: 'ambiguous' });
        continue;
      }
      const n = byId.get([...acc.candidates][0]) as AppNode;
      const v = getNodeValues(n);
      const mapping = readImageUvMapping(v);
      if (mapping.orientation !== 'gltf') {
        problems.push({ material: gltfIndex, slot, reason: 'not-gltf-oriented' });
        continue;
      }
      const asset = assetFor(n);
      if (!asset || !payloadOf(asset.src)) {
        problems.push({ material: gltfIndex, slot, reason: 'invalid-payload' });
        continue;
      }
      const wired = {
        tileX: !!edgeInto(n.id, 'tileX'),
        tileY: !!edgeInto(n.id, 'tileY'),
        offsetX: !!edgeInto(n.id, 'offsetX'),
        offsetY: !!edgeInto(n.id, 'offsetY'),
      };
      const { transform, exact } = composeKhrTextureTransform(v, wired);
      if (!exact) notes.push({ material: gltfIndex, slot, note: 'uv-approximated' });
      if (edgeInto(n.id, 'uv') || edgeInto(n.id, 'dir')) notes.push({ material: gltfIndex, slot, note: 'uv-wired' });
      slots.push({
        material: gltfIndex,
        slot,
        src: asset.src,
        texCoord: mapping.uvSet,
        transform,
        sampler: samplerFor(readImageTextureSpec(v)),
        name: asset.name,
      });
      slotNodes.set(`${gltfIndex}:${slot}`, n);
    }
  }
  const order = new Map(GLTF_WRITABLE_SLOTS.map((s, i) => [s, i]));
  slots.sort((a, b) => a.material - b.material || (order.get(a.slot) as number) - (order.get(b.slot) as number));

  // The module's keys, first-occurrence order; a key no node holds stays verbatim.
  const byKey = new Map<string, Asset>();
  for (const n of nodes) {
    if (n.data.registryType !== 'imageNode') continue;
    const a = assetFor(n);
    if (a && !byKey.has(a.key)) byKey.set(a.key, a);
  }
  const payloads = new Map<string, RepackPayload>();
  const payloadSizes = new Map<string, { width: number; height: number }>();
  const addPayload = (a: Asset): boolean => {
    if (payloads.has(a.src)) return true;
    const p = payloadOf(a.src);
    if (!p) return false;
    payloads.set(a.src, p);
    payloadSizes.set(a.src, { width: a.width, height: a.height });
    return true;
  };
  const moduleAssets: RepackAsset[] = [];
  const seen = new Set<string>();
  for (const m of moduleText.matchAll(IMAGE_PLACEHOLDER_RE)) {
    const key = m[1];
    if (seen.has(key) || !IMAGE_ASSET_KEY_RE.test(key)) continue;
    const a = byKey.get(key);
    if (!a || !addPayload(a)) continue;
    seen.add(key);
    moduleAssets.push({ key, src: a.src, name: a.name });
  }
  // Every written payload is also an asset, so the project block can
  // reference it and a reader recover it — even when the module (un-applied
  // code-panel text, a sharer's payload) does not name it.
  const covered = new Set(moduleAssets.map((a) => a.src));
  for (const s of slots) {
    const n = slotNodes.get(`${s.material}:${s.slot}`) as AppNode;
    const a = assetFor(n) as Asset;
    addPayload(a);
    if (covered.has(s.src) || seen.has(a.key)) continue;
    seen.add(a.key);
    covered.add(s.src);
    moduleAssets.push({ key: a.key, src: a.src, name: a.name });
  }

  return {
    ok: true,
    plan: { indexMaterials, slots, notes, problems, moduleAssets, payloads, payloadSizes },
  };
}
