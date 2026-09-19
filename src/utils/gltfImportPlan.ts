/**
 * The GLB import's PURE decisions (GLB Phase 5 Step 8): which materials the
 * builder builds, what it builds from each one, how each extracted texture is
 * stored, and the ONE texture-size estimator the dialog (Step 9) and the
 * builder share.
 *
 * Reduced from the P5b draft (integration plan §3.10–§3.12): it reads the glTF
 * reader's already-sanitized report (`GltfModelReport`, utils/gltfReader.ts),
 * never raw JSON, so there is no second material reader here. What is left:
 *
 *   - `planBuiltMaterials` — the requested materials the build really makes
 *     sections for (THE buildable set, capped at MAX_INDEX_MATERIALS; the
 *     rest keep their authored materials);
 *   - the SLOT CLASSES — which of a material's texture slots are built (never
 *     occlusion; emissive only when it can shine), how an image serving
 *     several slots is stored (normal > metallic-roughness > colour), and the
 *     encode class a slot asks `encodeImageFile` for (`glbSlotPolicy` in the
 *     import-free leaf glbImportLimits.ts is the ONE table of sizes and bpp);
 *   - `normalGreenFlipFor` — the green flip a tangent-less primitive needs;
 *   - `linearToSrgbHex` — a glTF factor (linear) as the sRGB hex a Color node
 *     stores (`color(0x…)` decodes it back to linear);
 *   - `unsupportedFeaturesOf` — what a material asks for that FastShaders has
 *     no channel for, in the closed `GltfFeatureId` vocabulary (the import
 *     report prints labels for these ids and nothing else: no file-supplied
 *     text ever reaches the note);
 *   - `encodeRequests` — the images the build encodes, each once;
 *   - `plannedTextureDims` / `estimateTextureChars` — THE estimator.
 *
 * Every input is adversarial (it came out of a dropped file), so every read
 * here is of the reader's checked fields, and every number that leaves is a
 * finite integer.
 */
import {
  buildableMaterialIndices,
  type GltfImage,
  type GltfMaterial,
  type GltfModelReport,
  type GltfSlotRef,
} from './gltfReader';
import { glbSlotPolicy, type GlbSlot } from './glbImportLimits';
import { MAX_IMAGE_ENCODED_CHARS, MAX_SOURCE_PIXELS } from './imageNode';
import { isLosslessWebpBytes } from './imageCodec';
import { UNTRUSTED_TEXTURE_SIDE } from './textureMemory';
import { MAX_INDEX_MATERIALS } from '@/engine/materialPartsContract';
import { orderFeatures, type GltfFeatureId } from './gltfFeatures';

// The closed vocabulary lives in the import-free leaf gltfFeatures.ts (the
// note's copy reaches it from the store's side); re-exported here, where the
// builder decides the features.
export { GLTF_FEATURE_IDS, isGltfFeatureId, orderFeatures, type GltfFeatureId } from './gltfFeatures';

/* ── which materials ─────────────────────────────────────────────────────── */

/**
 * The materials a build makes sections for: the REQUESTED indices that are
 * buildable (`buildableMaterialIndices` — used by a default-scene triangle
 * primitive, THE set N11 counts), each once, ascending, capped at
 * `MAX_INDEX_MATERIALS` (the editor's own section cap). The lowest indices
 * are built; `keptAuthored` counts the buildable requests past the cap, which
 * keep the materials the model was authored with (the report says so).
 * Anything else in `requested` — junk, duplicates, an unused material — is
 * ignored.
 */
export function planBuiltMaterials(
  m: GltfModelReport,
  requested: readonly unknown[],
): { sectioned: number[]; keptAuthored: number } {
  const buildable = new Set(buildableMaterialIndices(m));
  const wanted = new Set<number>();
  if (Array.isArray(requested)) {
    for (const v of requested) if (typeof v === 'number' && buildable.has(v)) wanted.add(v);
  }
  const all = [...wanted].sort((a, b) => a - b);
  const sectioned = all.slice(0, MAX_INDEX_MATERIALS);
  return { sectioned, keptAuthored: all.length - sectioned.length };
}

/* ── the feature vocabulary ──────────────────────────────────────────────── */

/** The material extensions the builder does not import, by glTF name. A `Map`:
 *  the key is a string out of the file. `KHR_materials_emissive_strength` is
 *  absent on purpose — it IS imported (a Float × node). */
const EXTENSION_FEATURES: ReadonlyMap<string, GltfFeatureId> = new Map([
  ['KHR_materials_clearcoat', 'clearcoat'],
  ['KHR_materials_transmission', 'transmission'],
  ['KHR_materials_volume', 'volume'],
  ['KHR_materials_ior', 'ior'],
  ['KHR_materials_specular', 'specular'],
  ['KHR_materials_sheen', 'sheen'],
  ['KHR_materials_iridescence', 'iridescence'],
  ['KHR_materials_anisotropy', 'anisotropy'],
  ['KHR_materials_dispersion', 'dispersion'],
  ['KHR_materials_unlit', 'unlit'],
  ['KHR_materials_pbrSpecularGlossiness', 'specularGlossiness'],
]);

/**
 * What ONE material asks for that is reported rather than imported: its
 * unsupported extensions, unlit shading, an occlusion texture (the Output has
 * no ambient-occlusion channel) and a normal-map strength other than 1. The
 * texture- and settings-level features (wrap modes, texture coordinates, the
 * alpha cut-off clamp, a dark emissive texture, mixed tangents) are found by
 * the builder, which is where they are decided.
 */
export function unsupportedFeaturesOf(m: GltfMaterial): GltfFeatureId[] {
  const out: GltfFeatureId[] = [];
  for (const ext of m.extensions) {
    const id = EXTENSION_FEATURES.get(ext);
    if (id) out.push(id);
  }
  if (m.unlit) out.push('unlit');
  for (const s of m.slots) {
    if (s.slot === 'occlusion') out.push('occlusion');
    if (s.slot === 'normal' && typeof s.scale === 'number' && s.scale !== 1) out.push('normalScale');
  }
  return orderFeatures(out);
}

/* ── colour ──────────────────────────────────────────────────────────────── */

const clamp01 = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0;

/** One linear channel to its 8-bit sRGB encoding (the sRGB transfer curve). */
function srgb8(c: unknown): number {
  const l = clamp01(c);
  const s = l <= 0.0031308 ? 12.92 * l : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
  return Math.round(clamp01(s) * 255);
}

/**
 * A glTF colour factor (LINEAR, like every glTF colour factor) as the lowercase
 * `#rrggbb` a Color node stores. The node emits `color(0x…)`, which THREE.Color
 * decodes from sRGB back to linear, so the round trip is exact to 8 bits.
 * Non-finite or missing components read as 0 and everything clamps to [0, 1].
 */
export function linearToSrgbHex(rgb: readonly unknown[]): string {
  const hex = (c: unknown) => srgb8(c).toString(16).padStart(2, '0');
  const at = (i: number): unknown => (Array.isArray(rgb) ? rgb[i] : undefined);
  return `#${hex(at(0))}${hex(at(1))}${hex(at(2))}`;
}

/* ── tangents ────────────────────────────────────────────────────────────── */

/**
 * Whether a material's normal map needs GLTFLoader's green flip
 * (`normalScale.y *= -1` for a primitive without TANGENT; Phase 4's
 * `normalGreen: 'flip'`). A Texture node is ONE per (image, sampler, mapping),
 * while tangent presence is per PRIMITIVE, so a material whose primitives
 * disagree gets the majority's answer — tangent-less wins a tie — and is
 * reported (`mixed`, the `mixedTangents` feature).
 */
export function normalGreenFlipFor(m: GltfMaterial): { flip: boolean; mixed: boolean } {
  const total = Math.max(0, m.usage.primitives | 0);
  const withT = Math.min(total, Math.max(0, m.usage.withTangents | 0));
  const without = total - withT;
  return { flip: without > 0 && without >= withT, mixed: without > 0 && withT > 0 };
}

/* ── slot classes ────────────────────────────────────────────────────────── */

/** Whether an emissive slot can shine at all: a factor that rounds to black at
 *  8 bits, or a strength that is not positive, makes the texture dead weight
 *  (it is then neither encoded nor wired, and reported as `emissiveUnused`). */
export function emissiveIsUnused(m: GltfMaterial): boolean {
  return linearToSrgbHex(m.emissiveFactor) === '#000000' || !(m.emissiveStrength > 0);
}

/** The texture slots of a material the builder BUILDS, in the reader's order:
 *  never occlusion, and emissive only when it can shine. */
export function builtSlotRefs(m: GltfMaterial): (GltfSlotRef & { slot: GlbSlot })[] {
  const out: (GltfSlotRef & { slot: GlbSlot })[] = [];
  for (const s of m.slots) {
    if (glbSlotPolicy(s.slot) === null) continue;
    if (s.slot === 'emissive' && emissiveIsUnused(m)) continue;
    out.push(s as GltfSlotRef & { slot: GlbSlot });
  }
  return out;
}

/** An image serving several slots is stored for the most demanding one. */
const SLOT_RANK: Readonly<Record<GlbSlot, number>> = { normal: 3, metallicRoughness: 2, baseColor: 1, emissive: 1 };

export function dominantSlot(a: GlbSlot, b: GlbSlot): GlbSlot {
  return SLOT_RANK[b] > SLOT_RANK[a] ? b : a;
}

/** Whether an extracted image's SOURCE is lossless: a PNG, or a VP8L WebP (the
 *  container is read, never the declared MIME). */
export function imageSourceLossless(img: Pick<GltfImage, 'format' | 'bytes'>): boolean {
  if (img.format === 'png') return true;
  if (img.format === 'webp' && img.bytes) return isLosslessWebpBytes(img.bytes);
  return false;
}

export interface SlotEncodeClass {
  /** The slot's long-side cap (glbSlotPolicy). */
  readonly maxDim: number;
  /** A colour slot (stored lossy, mipmapped). */
  readonly colour: boolean;
  /** What `encodeImageFile`'s `preferLossless` is told. */
  readonly preferLossless: boolean;
  /** What its `losslessOnly` is told: a data map from a lossless source halves
   *  rather than going lossy. */
  readonly losslessOnly: boolean;
}

/**
 * How one image is encoded for its (dominant) slot — owner rule Q12: colour
 * lossy at up to 1024 px even from a PNG; a normal or metallic-roughness map
 * at up to 512 px, lossless-only from a lossless source and lossy from a lossy
 * one. Null for anything that is not a built slot.
 */
export function slotEncodeClass(slot: unknown, sourceLossless: boolean): SlotEncodeClass | null {
  const p = glbSlotPolicy(slot);
  if (!p) return null;
  const lossless = !p.colour && sourceLossless === true;
  return { maxDim: p.maxDim, colour: p.colour, preferLossless: lossless, losslessOnly: lossless };
}

/** Why a texture reached by a built slot has no image to encode: P5a's image
 *  statuses (never 'ok'), plus KTX2 with no fallback. `no-readable-source`
 *  (every source unusable, none of them KTX2) reads as `unsupported-format`. */
export type GltfTextureSkip =
  | 'external'
  | 'compressed-view'
  | 'unsupported-format'
  | 'damaged'
  | 'too-large'
  | 'ktx2-only';

export interface EncodeRequest {
  /** The glTF image index (unique across requests). */
  readonly image: number;
  /** The slot it is stored for (the most demanding one it serves). */
  readonly slot: GlbSlot;
}

export interface UnextractableTexture {
  readonly texture: number;
  /** The image the reason is about, when there is one (for its file name). */
  readonly image: number | null;
  readonly reason: GltfTextureSkip;
}

/**
 * The images the build must encode for `materials` (glTF indices), each once,
 * in first-use order, with the slot it is stored for — plus the textures a
 * built slot reaches that have no extractable image (reported as skipped,
 * each texture once). Pure; indices outside the report are ignored.
 */
export function encodeRequests(
  m: GltfModelReport,
  materials: readonly number[],
): { requests: EncodeRequest[]; unextractable: UnextractableTexture[] } {
  const order: number[] = [];
  const slotOf = new Map<number, GlbSlot>();
  const unextractable: UnextractableTexture[] = [];
  const skippedTextures = new Set<number>();
  for (const mi of materials) {
    const mat = Number.isInteger(mi) ? m.materials[mi] : undefined;
    if (!mat) continue;
    for (const ref of builtSlotRefs(mat)) {
      const tex = Number.isInteger(ref.texture) ? m.textures[ref.texture] : undefined;
      if (!tex) continue;
      if (tex.extract.status === 'ok') {
        const img = tex.extract.image;
        const prev = slotOf.get(img);
        if (prev === undefined) {
          order.push(img);
          slotOf.set(img, ref.slot);
        } else {
          slotOf.set(img, dominantSlot(prev, ref.slot));
        }
      } else if (!skippedTextures.has(tex.index)) {
        skippedTextures.add(tex.index);
        unextractable.push(textureSkip(m, tex.index));
      }
    }
  }
  return { requests: order.map((image) => ({ image, slot: slotOf.get(image)! })), unextractable };
}

/** Why one texture has no extractable image: KTX2 with no fallback, or the
 *  status of its first unusable source (webp → avif → core, GLTFLoader's
 *  order); an absent source reads as an unsupported format. */
function textureSkip(m: GltfModelReport, texture: number): UnextractableTexture {
  const tex = m.textures[texture];
  if (tex.extract.status === 'ktx2-only') return { texture, image: tex.sources.basisu, reason: 'ktx2-only' };
  for (const src of [tex.sources.webp, tex.sources.avif, tex.sources.core]) {
    if (src === null) continue;
    const img = m.images[src];
    if (img && img.status !== 'ok') return { texture, image: src, reason: img.status };
  }
  return { texture, image: tex.sources.core, reason: 'unsupported-format' };
}

/* ── THE estimator ───────────────────────────────────────────────────────── */

/** What one texture's size estimate needs: its slot, its header-read size
 *  (null when unreadable) and whether its source is lossless. */
export interface TextureEstimateInput {
  readonly slot: unknown;
  readonly width: number | null;
  readonly height: number | null;
  readonly sourceLossless: boolean;
}

/** A header-read dimension, or null: an integer in 1..16384 (the reader's own
 *  header cap) — everything else is untrusted. */
function validDim(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 16384 ? v : null;
}

/**
 * The size a texture will be STORED at, estimated before any decode: the
 * header size (`UNTRUSTED_TEXTURE_SIDE` when unreadable), scaled down past the
 * 64 MP decode guard as the N10 decode does, then fitted to the smallest of
 * the slot cap, the chosen import resolution (`maxDim`, null = none) and the
 * device cap. The power-of-two snap is ignored: this is an estimate. Null for
 * a slot that is not built.
 */
export function plannedTextureDims(
  t: TextureEstimateInput,
  maxDim: number | null,
  deviceMaxDim: number,
): { width: number; height: number } | null {
  const policy = glbSlotPolicy(t.slot);
  if (!policy) return null;
  let w = validDim(t.width) ?? UNTRUSTED_TEXTURE_SIDE;
  let h = validDim(t.height) ?? UNTRUSTED_TEXTURE_SIDE;
  if (w * h > MAX_SOURCE_PIXELS) {
    const k = Math.sqrt(MAX_SOURCE_PIXELS / (w * h));
    w = Math.max(1, Math.floor(w * k));
    h = Math.max(1, Math.floor(h * k));
  }
  const dev = Number.isInteger(deviceMaxDim) && deviceMaxDim >= 1 ? deviceMaxDim : UNTRUSTED_TEXTURE_SIDE;
  const res = typeof maxDim === 'number' && Number.isFinite(maxDim) && maxDim >= 1 ? Math.floor(maxDim) : Infinity;
  const cap = Math.min(policy.maxDim, res, dev);
  const s = Math.min(1, cap / Math.max(w, h));
  return { width: Math.max(1, Math.floor(w * s)), height: Math.max(1, Math.floor(h * s)) };
}

/**
 * The encoded `data:` URL length a texture will cost, estimated from the slot
 * table's bits per pixel: base64 of w·h·bpp/8 bytes plus the prefix, halved
 * (as the encoder's per-image retry halves) while it is over the per-image
 * budget. The bpp are the conservative, INFERRED figures of glbSlotPolicy —
 * an underestimate is the dangerous direction. 0 for a slot that is not built.
 */
export function estimateTextureChars(t: TextureEstimateInput, maxDim: number | null, deviceMaxDim: number): number {
  const dims = plannedTextureDims(t, maxDim, deviceMaxDim);
  const policy = glbSlotPolicy(t.slot);
  if (!dims || !policy) return 0;
  const bpp = policy.colour ? policy.lossyBpp : t.sourceLossless === true ? policy.losslessBpp : policy.lossyBpp;
  let { width: w, height: h } = dims;
  const charsAt = (a: number, b: number) => Math.ceil((a * b * bpp) / 6) + 32;
  let chars = charsAt(w, h);
  for (let guard = 0; guard < 32 && chars > MAX_IMAGE_ENCODED_CHARS && (w > 1 || h > 1); guard++) {
    w = Math.ceil(w / 2);
    h = Math.ceil(h / 2);
    chars = charsAt(w, h);
  }
  return chars;
}
