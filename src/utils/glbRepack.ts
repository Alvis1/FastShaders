/**
 * THE SINGLE-GLB REPACKER (Phase 7 Step 3): the loaded preview model, the
 * optimised textures the shader uses, the shader MODULE and the
 * FASTSHADERS_PROJECT_V1 block, written as ONE `.glb`.
 *
 * The format it writes is engine/glbShaderContract.ts, stated there once:
 * root `extras.fastshaders = { v: 1, assets, module, project }`, a pointer-free
 * marker on the default scene, the module and the project block as plain BIN
 * bufferViews. The readers are utils/glbShaderExtras.ts (the editor), podest's
 * twin and loader 0.8.
 *
 * WHAT IT IS. One pure function of its input (`repackGlb`), plus the size of
 * the same file without writing it (`measureGlbRepack`) — both from ONE
 * private layout, so the size the pre-flight shows cannot drift from the file
 * (the exportBundle rule) — and `prepareRepackBase`, which turns a model into
 * the base the layout appends to. It is DETERMINISTIC: no clock, no random,
 * no Map-order dependence; order comes from the slots (sorted here) and the
 * asset list (module-text order), and the `assets` keys are sorted.
 *
 * WHAT IT NEVER DOES. Decode a picture, execute or parse the module or the
 * project text, fetch, touch the store, the DOM or three. Every string it
 * writes into the glTF JSON comes from a closed vocabulary (extension names,
 * MIME types, the extras keys), a validated number, an ASCII-whitelisted image
 * name, a placeholder key matching IMAGE_ASSET_KEY_RE, or the caller's
 * `generator` (whitelisted too). The module and project texts ride as opaque
 * BIN bytes, so their content cannot reach the container's structure
 * (glbRepackHostile.test.ts fuzzes that).
 *
 * LAYOUT. Everything is appended at TAILS, never inserted: the base BIN is
 * kept verbatim, then (each at a 4-aligned offset) per written texture its
 * payload image immediately followed by its PNG/JPEG fallback, the payloads
 * only the module uses, the module, the project. New bufferViews, images,
 * samplers (reused when an identical plain one exists) and textures go at the
 * END of their arrays. That is what makes export → restore → export stable:
 * the amended strip (utils/gltfStrip.ts) turns the previous export's entries
 * into placeholders and `truncateDeadTail` pops them, because they are
 * exactly the tail.
 *
 * TEXTURES. A written WebP payload is `EXT_texture_webp`'s source with its
 * PNG/JPEG copy as the core `source` (`extensionsUsed` only); without a copy,
 * or in the owner-gated 'required' mode, the extension is REQUIRED. three r184
 * always loads the WebP (GLTFLoader's GLTFTextureWebPExtension has no
 * fallback path), so the copy serves only viewers that ignore the extension.
 * A PNG/JPEG payload is a plain core source. Each distinct payload is written
 * ONCE, as its exact canonical bytes, and is BOTH the texture image and the
 * module asset (`assets[key]`); a fallback is never an asset.
 */
import { buildGlbContainer, GLB_JSON_MAX_BYTES, PLACEHOLDER_PNG_DATA_URI, sniffImageFormat } from './glbContainer';
import { GLTF_IMAGE_MAX_BYTES, GLTF_READ_CAPS, readGltfModel, type GltfModelReport } from './gltfReader';
import { MESHOPT_EXTENSIONS, STRIP_WALK_BUDGET, planTextureStrip, stripGltfTextures } from './gltfStrip';
import { fnv1a32Hex } from './payloadDigest';
import { KTX2_MIME } from './ktx2Encoder';
import { modelSignatureMatches } from '@/engine/materialPartsContract';
import {
  FS_EMBED_ASSET_BYTES_MAX,
  FS_EMBED_ASSETS_MAX,
  FS_EMBED_TOTAL_BYTES_MAX,
  FS_EXTRAS_KEY,
  FS_EXTRAS_VERSION,
  FS_MODULE_MAX_BYTES,
  FS_MODULE_MIME,
  FS_PROJECT_BEGIN,
  FS_PROJECT_END,
  FS_PROJECT_MAX_BYTES,
  FS_SCENE_MARKER,
  IMAGE_ASSET_KEY_RE,
  isPlainObject,
  readFsGlbPointers,
  type FsGlbExtrasWritten,
} from '@/engine/glbShaderContract';

/* ── public types ────────────────────────────────────────────────────────── */

export type GlbWebpMode = 'fallback' | 'required';
export type GltfWritableSlot = 'baseColor' | 'metallicRoughness' | 'normal' | 'emissive';
export const GLTF_WRITABLE_SLOTS: readonly GltfWritableSlot[] = ['baseColor', 'metallicRoughness', 'normal', 'emissive'];

export interface GlbSamplerSpec {
  magFilter: 9728 | 9729;
  minFilter: 9728 | 9729 | 9984 | 9987;
  wrapS: 33071 | 10497;
  wrapT: 33071 | 10497;
}

/** A KHR_texture_transform in the Khronos reference form; absent fields are defaults. */
export interface KhrTextureTransform {
  offset?: [number, number];
  rotation?: number;
  scale?: [number, number];
}

export interface RepackSlot {
  /** glTF material index (must be one of `indexMaterials`). */
  material: number;
  slot: GltfWritableSlot;
  /** The canonical `data:` src of the payload (a `payloads` key). */
  src: string;
  texCoord: 0 | 1 | 2 | 3;
  transform: KhrTextureTransform | null;
  sampler: GlbSamplerSpec;
  /** The image's name hint (`safeImageName` is applied). */
  name: string;
}

export interface RepackPayload {
  mime: 'image/png' | 'image/jpeg' | 'image/webp';
  bytes: Uint8Array;
  lossless: boolean;
}

export interface RepackFallback {
  mime: 'image/png' | 'image/jpeg';
  bytes: Uint8Array;
}

/** One `assets` entry: a placeholder key and the payload it resolves to. */
export interface RepackAsset {
  key: string;
  src: string;
  /** Name hint for an image only the module uses. */
  name?: string;
}

export interface RepackInput {
  /** The prepared base (`prepareRepackBase`). */
  base: GltfModelReport;
  /** glTF indices of the EMITTING index sections. */
  indexMaterials: readonly number[];
  slots: readonly RepackSlot[];
  /** canonical src → bytes, keyed by the FULL string. */
  payloads: ReadonlyMap<string, RepackPayload>;
  /** canonical src (a WebP payload a slot uses) → its PNG/JPEG copy; null or absent = none. */
  fallbacks: ReadonlyMap<string, RepackFallback | null>;
  /** The module text, placeholders KEPT. */
  moduleText: string;
  /** Every `assets` entry, module-text order first; every written payload must have one. */
  moduleAssets: readonly RepackAsset[];
  /** `embedProjectState('', project).trim()` — the marker block. */
  projectText: string;
  webpMode: GlbWebpMode;
  /**
   * OPTIONAL KTX2 copies (Phase 8), keyed by the WRITTEN texture index — the
   * index this call assigns, so only a texture the pass creates can take one.
   * Each becomes an EXTRA `KHR_texture_basisu` source beside the texture's
   * own image; the core `source` is never replaced and the extension is never
   * REQUIRED. An absent or empty map writes byte-identically to before.
   */
  ktx2Sources?: ReadonlyMap<number, Uint8Array>;
  /** `asset.generator`, e.g. "FastShaders 0.3.33"; absent = the base's is kept. */
  generator?: string;
}

export type RepackRefusalReason =
  | 'unreadable'
  | 'too-complex'
  | 'too-many-assets'
  | 'asset-too-large'
  | 'module-too-large'
  | 'project-too-large'
  | 'unsupported-buffer-extension'
  | 'model-mismatch'
  | 'bad-input';

/** `detail` is a machine code for logs and tests, never shown to a user. */
export interface RepackRefusal {
  reason: RepackRefusalReason;
  detail: string;
}

export interface GlbRepackSize {
  /** The file's exact length. */
  totalBytes: number;
  /** The JSON chunk's UTF-8 length, unpadded. */
  jsonBytes: number;
  /** The base BIN (after a `.gltf` merge). */
  baseBinBytes: number;
  /** Distinct payload images a texture uses. */
  textureImageBytes: number;
  /** Their PNG/JPEG copies. */
  fallbackBytes: number;
  /** Payload images only the module uses. */
  assetOnlyImageBytes: number;
  moduleBytes: number;
  projectBytes: number;
  textureCount: number;
  fallbackCount: number;
  /** WebP payloads a texture uses that have no copy in 'fallback' mode. */
  fallbackMissing: number;
  /** The KTX2 copies written beside the textures (0 without `ktx2Sources`). */
  ktx2Bytes: number;
  ktx2Count: number;
  /** `EXT_texture_webp` lands in `extensionsRequired`. */
  webpRequired: boolean;
}

export interface GlbRepackReport {
  size: GlbRepackSize;
  slotsWritten: number;
  texturesWritten: number;
  imagesWritten: number;
  samplersAdded: number;
  /** The root `extras` was not a plain object and was replaced. */
  extrasReplaced: boolean;
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

type Obj = Record<string, unknown>;
type Result<T> = { ok: true; value: T } | { ok: false; refusal: RepackRefusal };

class Refused {
  constructor(readonly refusal: RepackRefusal) {}
}

function refuse(reason: RepackRefusalReason, detail: string): never {
  throw new Refused({ reason, detail });
}

const ceil4 = (n: number) => Math.ceil(n / 4) * 4;
const pad4 = (n: number) => (n + 3) & ~3;
const isSafeNonNeg = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

function own(o: Obj, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(o, key) ? o[key] : undefined;
}

const MESHOPT: ReadonlySet<string> = new Set(MESHOPT_EXTENSIONS);
const MAX_TRANSFORM = 1e6;
const GENERATOR_RE = /^FastShaders [0-9A-Za-z.+-]{1,64}$/;
const MIME_FORMAT: ReadonlyMap<string, string> = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpeg'],
  ['image/webp', 'webp'],
]);
const SAMPLER_KEYS = ['magFilter', 'minFilter', 'wrapS', 'wrapT'] as const;
/** The extension that names the KTX2 copies (their MIME is the encoder seam's). */
export const KTX2_EXTENSION = 'KHR_texture_basisu';

/** Byte-for-byte equality (the KTX2 copies are de-duplicated by CONTENT). */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** The sampler a Texture node's settings imply (the node's own emission rules:
 *  a data map is unmipmapped, a colour image trilinear). */
export function samplerFor(spec: { colorSpace: 'color' | 'data'; nearest: boolean; repeat: boolean }): GlbSamplerSpec {
  const wrap = spec.repeat ? 10497 : 33071;
  return {
    magFilter: spec.nearest ? 9728 : 9729,
    minFilter: spec.colorSpace === 'data' ? (spec.nearest ? 9728 : 9729) : spec.nearest ? 9984 : 9987,
    wrapS: wrap,
    wrapT: wrap,
  };
}

/** An image name the JSON may carry: ASCII `[A-Za-z0-9._ -]`, every other run
 *  one space, spaces collapsed, trimmed, at most 48 characters; '' = omit. */
export function safeImageName(v: unknown): string {
  if (typeof v !== 'string') return '';
  return v
    .slice(0, 4096)
    .replace(/[^A-Za-z0-9._ -]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim()
    .slice(0, 48)
    .trim();
}

/** Any `extensions` on a buffer or bufferView outside meshopt (or not an object). */
function hasForeignBufferExtension(doc: Obj): boolean {
  for (const key of ['buffers', 'bufferViews']) {
    const list = own(doc, key);
    if (!Array.isArray(list)) continue;
    for (const o of list) {
      if (!isPlainObject(o) || !Object.prototype.hasOwnProperty.call(o, 'extensions')) continue;
      const exts = o.extensions;
      if (!isPlainObject(exts)) return true;
      if (Object.keys(exts).some((k) => !MESHOPT.has(k))) return true;
    }
  }
  return false;
}

/**
 * Remove `extras.fastshaders` from `o`, and an `extras` object left EMPTY
 * (the strip's own drop leaves `{}` behind). A repack re-creates `extras` at
 * the end of the object, so a base without the empty one serialises the same
 * key order whichever path (a repack's output, or a strip of it) it came from.
 */
function dropFsExtras(o: Obj): void {
  const extras = own(o, 'extras');
  if (!isPlainObject(extras)) return;
  if (Object.prototype.hasOwnProperty.call(extras, FS_EXTRAS_KEY)) delete extras[FS_EXTRAS_KEY];
  if (Object.keys(extras).length === 0) delete o.extras;
}

/* ── truncateDeadTail ────────────────────────────────────────────────────── */

const isExactly = (o: unknown, keys: readonly string[]): o is Obj => {
  if (!isPlainObject(o)) return false;
  const k = Object.keys(o);
  return k.length === keys.length && keys.every((x) => Object.prototype.hasOwnProperty.call(o, x));
};

/**
 * Pop the strip's dead placeholders off the TAILS of `textures`, `images` and
 * `bufferViews`, in that order, and delete an array it empties. Index-safe:
 * only an entry nothing references goes, and only from the end.
 *   1. a texture that is exactly `{ source: <int> }` (or `{}`) no
 *      `texture` / `*Texture` object's `index` names;
 *   2. an image that is exactly `{ uri: PLACEHOLDER_PNG_DATA_URI }` no remaining
 *      texture names (its core `source` or any `extensions.*.source`);
 *   3. a bufferView that is exactly `{ buffer, byteOffset: 0, byteLength: 1 }`
 *      no `bufferView` integer anywhere names (images, accessors, extensions,
 *      the `extras.fastshaders` pointers).
 * The reference scan is conservative and bounded by STRIP_WALK_BUDGET; over
 * it, nothing is popped. Mutates `doc`.
 */
export function truncateDeadTail(doc: Record<string, unknown>): void {
  let left = STRIP_WALK_BUDGET;
  const spend = () => {
    if (--left < 0) throw new Refused({ reason: 'too-complex', detail: 'truncate-budget' });
  };
  const texRefs = new Set<number>();
  const viewRefs = new Set<number>();
  const collect = (root: unknown, skipTop: ReadonlySet<string>) => {
    const stack: unknown[] = [];
    if (isPlainObject(root)) {
      for (const k of Object.keys(root)) {
        spend();
        if (!skipTop.has(k)) stack.push(root[k]);
      }
    }
    while (stack.length > 0) {
      const o = stack.pop();
      if (Array.isArray(o)) {
        for (const v of o) {
          spend();
          if (typeof v === 'object' && v !== null) stack.push(v);
        }
        continue;
      }
      if (!isPlainObject(o)) continue;
      for (const k of Object.keys(o)) {
        spend();
        const v = o[k];
        if ((k === 'texture' || k.endsWith('Texture')) && isPlainObject(v) && isSafeNonNeg(v.index)) texRefs.add(v.index);
        else if (k === 'bufferView' && isSafeNonNeg(v)) viewRefs.add(v);
        if (typeof v === 'object' && v !== null) stack.push(v);
      }
    }
  };
  try {
    // Everything but the arrays being decided about (accessors are scanned flat).
    collect(doc, new Set(['textures', 'images', 'bufferViews', 'buffers', 'accessors']));
    const accessors = own(doc, 'accessors');
    if (Array.isArray(accessors)) {
      for (const a of accessors) {
        spend();
        if (!isPlainObject(a)) continue;
        if (isSafeNonNeg(a.bufferView)) viewRefs.add(a.bufferView);
        const sparse = a.sparse;
        if (!isPlainObject(sparse)) continue;
        for (const part of ['indices', 'values']) {
          const p = sparse[part];
          if (isPlainObject(p) && isSafeNonNeg(p.bufferView)) viewRefs.add(p.bufferView);
        }
      }
    }
  } catch (e) {
    if (e instanceof Refused) return;
    throw e;
  }

  // 1. Textures.
  const textures = own(doc, 'textures');
  if (Array.isArray(textures)) {
    while (textures.length > 0) {
      const i = textures.length - 1;
      const t = textures[i];
      const dead = isExactly(t, []) || (isExactly(t, ['source']) && isSafeNonNeg(t.source));
      if (!dead || texRefs.has(i)) break;
      textures.pop();
    }
    if (textures.length === 0) delete doc.textures;
  }

  // 2. Images, against the textures that remain.
  const imgRefs = new Set<number>();
  const remaining = own(doc, 'textures');
  if (Array.isArray(remaining)) {
    for (const t of remaining) {
      if (!isPlainObject(t)) continue;
      if (isSafeNonNeg(t.source)) imgRefs.add(t.source);
      const exts = t.extensions;
      if (!isPlainObject(exts)) continue;
      for (const k of Object.keys(exts)) {
        const e = exts[k];
        if (isPlainObject(e) && isSafeNonNeg(e.source)) imgRefs.add(e.source);
      }
    }
  }
  const images = own(doc, 'images');
  if (Array.isArray(images)) {
    while (images.length > 0) {
      const i = images.length - 1;
      const img = images[i];
      if (!isExactly(img, ['uri']) || img.uri !== PLACEHOLDER_PNG_DATA_URI || imgRefs.has(i)) break;
      images.pop();
    }
    if (images.length === 0) delete doc.images;
    else for (const img of images) if (isPlainObject(img) && isSafeNonNeg(img.bufferView)) viewRefs.add(img.bufferView);
  }

  // 3. bufferViews.
  const views = own(doc, 'bufferViews');
  if (Array.isArray(views)) {
    while (views.length > 0) {
      const i = views.length - 1;
      const v = views[i];
      const dead =
        isExactly(v, ['buffer', 'byteOffset', 'byteLength']) &&
        isSafeNonNeg(v.buffer) &&
        v.byteOffset === 0 &&
        v.byteLength === 1;
      if (!dead || viewRefs.has(i)) break;
      views.pop();
    }
    if (views.length === 0) delete doc.bufferViews;
  }
}

/* ── prepareRepackBase ───────────────────────────────────────────────────── */

/**
 * The BIN cut to the end of the last byte range anything still reads on
 * buffer 0 (plain views and meshopt ranges). Only when no buffer or bufferView
 * carries an extension this file cannot see into — an unknown extension may
 * hold raw offsets past the views.
 */
function trimBin(doc: Obj, bin: Uint8Array): Uint8Array {
  let end = 0;
  const views = own(doc, 'bufferViews');
  if (Array.isArray(views)) {
    for (const v of views) {
      if (!isPlainObject(v)) continue;
      if (v.buffer === 0 && isSafeNonNeg(v.byteLength)) {
        const off = v.byteOffset === undefined ? 0 : v.byteOffset;
        if (isSafeNonNeg(off)) end = Math.max(end, off + v.byteLength);
      }
      const exts = v.extensions;
      if (!isPlainObject(exts)) continue;
      for (const name of MESHOPT_EXTENSIONS) {
        const e = own(exts, name);
        if (!isPlainObject(e) || e.buffer !== 0 || !isSafeNonNeg(e.byteLength)) continue;
        const off = e.byteOffset === undefined ? 0 : e.byteOffset;
        if (isSafeNonNeg(off)) end = Math.max(end, off + e.byteLength);
      }
    }
  }
  end = Math.min(end, bin.length);
  const buffers = own(doc, 'buffers');
  if (Array.isArray(buffers) && isPlainObject(buffers[0])) buffers[0].byteLength = end;
  return bin.subarray(0, end);
}

/**
 * The base a repack appends to: the model with the EMITTING index sections'
 * materials texture-stripped and any previous FastShaders payload reclaimed
 * (the amended strip), `extras.fastshaders` gone from the root and every scene,
 * the previous export's dead entries popped off the tails (`truncateDeadTail`)
 * and — when nothing forbids it — the BIN cut after the last live range. Its
 * signature equals the input's (else `unreadable`). Running it on its own
 * output changes nothing, and on a repack's output gives the base back, which
 * is the export → restore → export stability.
 */
export function prepareRepackBase(
  base: GltfModelReport,
  indexMaterials: readonly number[],
): { ok: true; model: GltfModelReport } | { ok: false; refusal: RepackRefusal } {
  try {
    const sig0 = base.signature;
    let model = base;
    const plan = planTextureStrip(base, indexMaterials);
    if (plan) {
      const s = stripGltfTextures(base, plan);
      const r = readGltfModel(s.bytes, s.kind);
      if (!r.ok) return { ok: false, refusal: { reason: 'unreadable', detail: 'strip-reread' } };
      model = r.model;
    }
    const doc = structuredClone(model.source.doc) as Obj;
    dropFsExtras(doc);
    const scenes = own(doc, 'scenes');
    if (Array.isArray(scenes)) for (const s of scenes) if (isPlainObject(s)) dropFsExtras(s);
    truncateDeadTail(doc);

    let bytes: Uint8Array;
    if (model.kind === 'glb') {
      let bin = model.source.bin;
      const buffers = own(doc, 'buffers');
      const binIsBuffer0 =
        bin !== null && Array.isArray(buffers) && isPlainObject(buffers[0]) && buffers[0].uri === undefined;
      if (bin && binIsBuffer0 && !hasForeignBufferExtension(doc)) bin = trimBin(doc, bin);
      bytes = buildGlbContainer(JSON.stringify(doc), bin);
    } else {
      bytes = new TextEncoder().encode(JSON.stringify(doc));
    }
    const r = readGltfModel(bytes, model.kind);
    if (!r.ok) return { ok: false, refusal: { reason: 'unreadable', detail: 'reread:' + r.refusal.detail } };
    if (!modelSignatureMatches(r.model.signature, sig0)) {
      return { ok: false, refusal: { reason: 'unreadable', detail: 'sig-changed' } };
    }
    return { ok: true, model: r.model };
  } catch {
    return { ok: false, refusal: { reason: 'unreadable', detail: 'internal' } };
  }
}

/* ── validation ──────────────────────────────────────────────────────────── */

const enc = new TextEncoder();
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

interface Validated {
  slots: RepackSlot[];
  moduleBytes: Uint8Array;
  projectBytes: Uint8Array;
  /** Distinct asset entries, input order. */
  assets: RepackAsset[];
}

/** A non-null, non-array object, without narrowing a typed value to `Obj`. */
const isRecord = (v: unknown): boolean => typeof v === 'object' && v !== null && !Array.isArray(v);

function finiteBounded(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_TRANSFORM;
}

function validPair(v: unknown): boolean {
  return Array.isArray(v) && v.length === 2 && finiteBounded(v[0]) && finiteBounded(v[1]);
}

function validTransform(t: unknown): boolean {
  if (t === null) return true;
  if (!isPlainObject(t)) return false;
  for (const k of Object.keys(t)) if (k !== 'offset' && k !== 'rotation' && k !== 'scale') return false;
  if (t.offset !== undefined && !validPair(t.offset)) return false;
  if (t.rotation !== undefined && !finiteBounded(t.rotation)) return false;
  if (t.scale !== undefined && !validPair(t.scale)) return false;
  return true;
}

function validSampler(s: unknown): s is GlbSamplerSpec {
  if (!isPlainObject(s)) return false;
  return (
    (s.magFilter === 9728 || s.magFilter === 9729) &&
    (s.minFilter === 9728 || s.minFilter === 9729 || s.minFilter === 9984 || s.minFilter === 9987) &&
    (s.wrapS === 33071 || s.wrapS === 10497) &&
    (s.wrapT === 33071 || s.wrapT === 10497)
  );
}

function validImageBytes(mime: unknown, bytes: unknown): boolean {
  if (typeof mime !== 'string' || !(bytes instanceof Uint8Array)) return false;
  const format = MIME_FORMAT.get(mime);
  return format !== undefined && bytes.length >= 1 && bytes.length <= GLTF_IMAGE_MAX_BYTES && sniffImageFormat(bytes) === format;
}

function validate(input: RepackInput): Validated {
  if (!isPlainObject(input) || !input.base || !isPlainObject(input.base.source?.doc)) refuse('bad-input', 'input');
  if (input.webpMode !== 'fallback' && input.webpMode !== 'required') refuse('bad-input', 'webp-mode');
  if (input.generator !== undefined && (typeof input.generator !== 'string' || !GENERATOR_RE.test(input.generator))) {
    refuse('bad-input', 'generator');
  }

  // The asset count first, before a byte is allocated.
  if (!Array.isArray(input.moduleAssets)) refuse('bad-input', 'assets');
  const assets: RepackAsset[] = [];
  const seenKeys = new Set<string>();
  for (const a of input.moduleAssets) {
    if (!isRecord(a) || typeof a.key !== 'string' || typeof a.src !== 'string') refuse('bad-input', 'asset');
    if (seenKeys.has(a.key)) continue;
    seenKeys.add(a.key);
    if (seenKeys.size > FS_EMBED_ASSETS_MAX) refuse('too-many-assets', `count:${input.moduleAssets.length}`);
    assets.push(a);
  }

  if (typeof input.moduleText !== 'string' || input.moduleText.length === 0) refuse('bad-input', 'module');
  if (input.moduleText.length > FS_MODULE_MAX_BYTES) refuse('module-too-large', 'chars');
  // A lone surrogate has no UTF-8 spelling: the encoder would write U+FFFD, so
  // the view would not read back as the text, and its fnv1a would not match.
  if (LONE_SURROGATE_RE.test(input.moduleText)) refuse('bad-input', 'module-not-well-formed');
  const moduleBytes = enc.encode(input.moduleText);
  if (moduleBytes.length > FS_MODULE_MAX_BYTES) refuse('module-too-large', 'bytes');
  if (typeof input.projectText !== 'string') refuse('bad-input', 'project');
  if (input.projectText.length > FS_PROJECT_MAX_BYTES) refuse('project-too-large', 'chars');
  if (!input.projectText.startsWith(FS_PROJECT_BEGIN) || !input.projectText.endsWith(FS_PROJECT_END)) {
    refuse('bad-input', 'project-block');
  }
  if (LONE_SURROGATE_RE.test(input.projectText)) refuse('bad-input', 'project-not-well-formed');
  const projectBytes = enc.encode(input.projectText);
  if (projectBytes.length > FS_PROJECT_MAX_BYTES) refuse('project-too-large', 'bytes');

  if (!(input.payloads instanceof Map) || !(input.fallbacks instanceof Map)) refuse('bad-input', 'maps');
  const payloadOk = new Set<string>();
  const checkPayload = (src: string) => {
    if (payloadOk.has(src)) return;
    const p = input.payloads.get(src);
    if (!p || !validImageBytes(p.mime, p.bytes) || typeof p.lossless !== 'boolean') refuse('bad-input', 'payload');
    payloadOk.add(src);
  };

  // Assets: keys, sources, per-asset and per-key-summed caps.
  let total = 0;
  for (const a of assets) {
    if (!IMAGE_ASSET_KEY_RE.test(a.key)) refuse('bad-input', 'asset-key');
    checkPayload(a.src);
    const len = (input.payloads.get(a.src) as RepackPayload).bytes.length;
    if (len > FS_EMBED_ASSET_BYTES_MAX) refuse('asset-too-large', `asset:${a.key}`);
    total += len;
    if (total > FS_EMBED_TOTAL_BYTES_MAX) refuse('asset-too-large', 'total');
    if (a.name !== undefined && typeof a.name !== 'string') refuse('bad-input', 'asset-name');
  }

  // Slots.
  if (!Array.isArray(input.slots) || !Array.isArray(input.indexMaterials)) refuse('bad-input', 'slots');
  const materialCount = input.base.materials.length;
  const indexSet = new Set<number>();
  for (const i of input.indexMaterials) {
    if (!Number.isSafeInteger(i) || i < 0 || i >= materialCount) refuse('bad-input', 'index-material');
    indexSet.add(i);
  }
  const seenSlot = new Set<string>();
  const covered = new Set(assets.map((a) => a.src));
  for (const s of input.slots) {
    if (!isRecord(s)) refuse('bad-input', 'slot');
    if (!Number.isSafeInteger(s.material) || s.material < 0 || s.material >= materialCount || !indexSet.has(s.material)) {
      refuse('bad-input', 'slot-material');
    }
    if (!GLTF_WRITABLE_SLOTS.includes(s.slot)) refuse('bad-input', 'slot-name');
    const k = `${s.material}:${s.slot}`;
    if (seenSlot.has(k)) refuse('bad-input', 'slot-duplicate');
    seenSlot.add(k);
    if (s.texCoord !== 0 && s.texCoord !== 1 && s.texCoord !== 2 && s.texCoord !== 3) refuse('bad-input', 'slot-texcoord');
    if (!validTransform(s.transform)) refuse('bad-input', 'slot-transform');
    if (!validSampler(s.sampler)) refuse('bad-input', 'slot-sampler');
    if (typeof s.src !== 'string') refuse('bad-input', 'slot-src');
    checkPayload(s.src);
    // Every written payload is also a module asset (the contract's "images once").
    if (!covered.has(s.src)) refuse('bad-input', 'payload-without-asset');
    const fb = input.fallbacks.get(s.src);
    if (fb !== undefined && fb !== null) {
      if ((fb.mime !== 'image/png' && fb.mime !== 'image/jpeg') || !validImageBytes(fb.mime, fb.bytes)) {
        refuse('bad-input', 'fallback');
      }
    }
  }

  const order = new Map(GLTF_WRITABLE_SLOTS.map((s, i) => [s, i]));
  const slots = [...input.slots].sort(
    (a, b) => a.material - b.material || (order.get(a.slot) as number) - (order.get(b.slot) as number),
  );
  return { slots, moduleBytes, projectBytes, assets };
}

/* ── the layout ──────────────────────────────────────────────────────────── */

interface Part {
  offset: number;
  bytes: Uint8Array;
}

/** Per written slot: the texture index this pass gave it, and its payload image.
 *  A measure hands these back so a caller can key `ktx2Sources` by texture. */
export interface RepackWritten {
  material: number;
  slot: GltfWritableSlot;
  texture: number;
  image: number;
}

interface Layout {
  json: string;
  jsonBytes: number;
  baseBin: Uint8Array;
  parts: Part[];
  end: number;
  size: GlbRepackSize;
  report: Omit<GlbRepackReport, 'size'>;
  /** For the postcondition: per written slot, its texture index and payload image. */
  written: RepackWritten[];
  assetKeys: string[];
}

/** The base's buffers as ONE BIN (Step 3). Mutates `doc`. */
function baseBuffers(doc: Obj, m: GltfModelReport): Uint8Array {
  const data = m.source.buffers;
  const defs = own(doc, 'buffers');
  const list = Array.isArray(defs) ? defs : [];
  if (list.length === 0) {
    doc.buffers = [{ byteLength: 0 }];
    return new Uint8Array(0);
  }
  const onlyBin =
    m.kind === 'glb' && m.source.bin !== null && data[0] === m.source.bin && data.slice(1).every((d) => d === 'fallback');
  if (onlyBin) return m.source.bin as Uint8Array;
  if (hasForeignBufferExtension(doc)) refuse('unsupported-buffer-extension', 'merge');

  // Every buffer with data, in index order, at a 4-aligned base of one BIN.
  const base = new Map<number, number>();
  const newIndex = new Map<number, number>();
  const kept: Obj[] = [];
  let cursor = 0;
  let nextFallback = 1;
  data.forEach((d, i) => {
    if (d instanceof Uint8Array) {
      const at = ceil4(cursor);
      base.set(i, at);
      newIndex.set(i, 0);
      cursor = at + d.length;
    } else {
      newIndex.set(i, nextFallback++);
      kept.push(list[i] as Obj);
    }
  });
  const bin = new Uint8Array(cursor);
  data.forEach((d, i) => {
    if (d instanceof Uint8Array) bin.set(d, base.get(i) as number);
  });
  const remap = (o: Obj) => {
    const b = o.buffer;
    if (!isSafeNonNeg(b) || !newIndex.has(b)) return;
    o.buffer = newIndex.get(b);
    const shift = base.get(b);
    if (shift) o.byteOffset = (isSafeNonNeg(o.byteOffset) ? o.byteOffset : 0) + shift;
  };
  const views = own(doc, 'bufferViews');
  if (Array.isArray(views)) {
    for (const v of views) {
      if (!isPlainObject(v)) continue;
      remap(v);
      const exts = v.extensions;
      if (!isPlainObject(exts)) continue;
      for (const name of MESHOPT_EXTENSIONS) {
        const e = own(exts, name);
        if (isPlainObject(e)) remap(e);
      }
    }
  }
  doc.buffers = [{ byteLength: cursor }, ...kept];
  return bin;
}

function ensureArray(doc: Obj, key: string): unknown[] {
  const v = own(doc, key);
  if (Array.isArray(v)) return v;
  const created: unknown[] = [];
  doc[key] = created;
  return created;
}

function sameSampler(o: unknown, s: GlbSamplerSpec): boolean {
  if (!isExactly(o, SAMPLER_KEYS)) return false;
  return SAMPLER_KEYS.every((k) => o[k] === s[k]);
}

function transformObject(t: KhrTextureTransform | null): Obj | null {
  if (!t) return null;
  const out: Obj = {};
  const z = (n: number) => (n === 0 ? 0 : n);
  if (t.offset && (t.offset[0] !== 0 || t.offset[1] !== 0)) out.offset = [z(t.offset[0]), z(t.offset[1])];
  if (t.rotation !== undefined && t.rotation !== 0) out.rotation = z(t.rotation);
  if (t.scale && (t.scale[0] !== 1 || t.scale[1] !== 1)) out.scale = [z(t.scale[0]), z(t.scale[1])];
  return Object.keys(out).length > 0 ? out : null;
}

function layoutGlbRepack(input: RepackInput): Layout {
  const v = validate(input);
  const m = input.base;
  const doc = structuredClone(m.source.doc) as Obj;
  const baseBin = baseBuffers(doc, m);

  // Parts, in order.
  const parts: Part[] = [];
  let cursor = ceil4(baseBin.length);
  const place = (bytes: Uint8Array): number => {
    parts.push({ offset: cursor, bytes });
    cursor = ceil4(cursor + bytes.length);
    return parts.length - 1;
  };

  const views = ensureArray(doc, 'bufferViews');
  const baseViewCount = views.length;
  const viewOfPart = (p: number) => baseViewCount + p;

  // Keys absent from the base are created samplers → images → textures. A
  // prepared cycle base keeps the previous export's (now unreferenced)
  // samplers but not its images or textures, so creating `samplers` FIRST is
  // what gives both the same key order.
  if (v.slots.length > 0) ensureArray(doc, 'samplers');
  const samplersList = (own(doc, 'samplers') as unknown[] | undefined) ?? [];
  const images = ensureArray(doc, 'images');
  const baseImageCount = images.length;

  interface ImageEntry { part: number; mime: string; name: string }
  const imageEntries: ImageEntry[] = [];
  const payloadImage = new Map<string, number>();
  const fallbackImage = new Map<string, number>();
  let textureImageBytes = 0;
  let fallbackBytes = 0;
  let assetOnlyImageBytes = 0;
  let fallbackMissing = 0;

  for (const s of v.slots) {
    if (payloadImage.has(s.src)) continue;
    const p = input.payloads.get(s.src) as RepackPayload;
    payloadImage.set(s.src, baseImageCount + imageEntries.length);
    imageEntries.push({ part: place(p.bytes), mime: p.mime, name: safeImageName(s.name) });
    textureImageBytes += p.bytes.length;
    if (p.mime === 'image/webp') {
      const fb = input.fallbacks.get(s.src) ?? null;
      if (input.webpMode === 'fallback') {
        if (fb) {
          fallbackImage.set(s.src, baseImageCount + imageEntries.length);
          imageEntries.push({ part: place(fb.bytes), mime: fb.mime, name: safeImageName(s.name) });
          fallbackBytes += fb.bytes.length;
        } else {
          fallbackMissing++;
        }
      }
    }
  }

  for (const a of v.assets) {
    if (payloadImage.has(a.src)) continue;
    const p = input.payloads.get(a.src) as RepackPayload;
    payloadImage.set(a.src, baseImageCount + imageEntries.length);
    imageEntries.push({ part: place(p.bytes), mime: p.mime, name: safeImageName(a.name ?? '') });
    assetOnlyImageBytes += p.bytes.length;
  }

  // Samplers + textures, in slot order.
  let samplersAdded = 0;
  const samplerIndex = (spec: GlbSamplerSpec): number => {
    const found = samplersList.findIndex((o) => sameSampler(o, spec));
    if (found >= 0) return found;
    samplersList.push({ magFilter: spec.magFilter, minFilter: spec.minFilter, wrapS: spec.wrapS, wrapT: spec.wrapT });
    samplersAdded++;
    return samplersList.length - 1;
  };

  let texturesList: unknown[] | null = null;
  const textureKey = new Map<string, number>();
  let usesWebp = false;
  let usesTransform = false;
  let webpRequired = false;
  let texturesWritten = 0;
  const written: Layout['written'] = [];

  for (const s of v.slots) {
    const sampler = samplerIndex(s.sampler);
    const key = `${s.src} ${s.sampler.magFilter} ${s.sampler.minFilter} ${s.sampler.wrapS} ${s.sampler.wrapT}`;
    let t = textureKey.get(key);
    if (t === undefined) {
      if (texturesList === null) texturesList = ensureArray(doc, 'textures');
      const p = input.payloads.get(s.src) as RepackPayload;
      const img = payloadImage.get(s.src) as number;
      let tex: Obj;
      if (p.mime === 'image/webp') {
        usesWebp = true;
        const fb = fallbackImage.get(s.src);
        if (fb !== undefined && input.webpMode === 'fallback') {
          tex = { sampler, source: fb, extensions: { EXT_texture_webp: { source: img } } };
        } else {
          tex = { sampler, extensions: { EXT_texture_webp: { source: img } } };
          webpRequired = true;
        }
      } else {
        tex = { sampler, source: img };
      }
      texturesList.push(tex);
      t = texturesList.length - 1;
      textureKey.set(key, t);
      texturesWritten++;
    }

    const materials = own(doc, 'materials');
    const mat = Array.isArray(materials) ? materials[s.material] : undefined;
    if (!isPlainObject(mat)) refuse('bad-input', 'material');
    const info: Obj = { index: t };
    if (s.texCoord > 0) info.texCoord = s.texCoord;
    const tf = transformObject(s.transform);
    if (tf) {
      info.extensions = { KHR_texture_transform: tf };
      usesTransform = true;
    }
    if (s.slot === 'baseColor' || s.slot === 'metallicRoughness') {
      let pbr = own(mat, 'pbrMetallicRoughness');
      if (!isPlainObject(pbr)) {
        pbr = {};
        mat.pbrMetallicRoughness = pbr;
      }
      (pbr as Obj)[s.slot === 'baseColor' ? 'baseColorTexture' : 'metallicRoughnessTexture'] = info;
    } else {
      mat[s.slot === 'normal' ? 'normalTexture' : 'emissiveTexture'] = info;
    }
    written.push({ material: s.material, slot: s.slot, texture: t, image: payloadImage.get(s.src) as number });
  }

  // KTX2 copies (Phase 8): an EXTRA `KHR_texture_basisu` source beside the
  // texture the pass above wrote, never in place of it — the core `source`
  // (and any EXT_texture_webp) is untouched, and the extension is never
  // REQUIRED, so a viewer without a transcoder still shows the picture.
  // Keyed by the WRITTEN texture index, so only a texture this pass created
  // can take one; identical bytes become ONE image (two slots that share a
  // payload and a sampler already share the texture, but two samplers over
  // one payload do not).
  let ktx2Bytes = 0;
  let ktx2Count = 0;
  let usesKtx2 = false;
  if (input.ktx2Sources && input.ktx2Sources.size > 0 && texturesList) {
    const mine = new Set(textureKey.values());
    const byBytes: { bytes: Uint8Array; image: number }[] = [];
    for (const t of [...input.ktx2Sources.keys()].sort((a, b) => a - b)) {
      if (!mine.has(t)) continue;
      const bytes = input.ktx2Sources.get(t);
      if (!(bytes instanceof Uint8Array) || bytes.length === 0) continue;
      let image = byBytes.find((e) => sameBytes(e.bytes, bytes))?.image;
      if (image === undefined) {
        image = baseImageCount + imageEntries.length;
        imageEntries.push({ part: place(bytes), mime: KTX2_MIME, name: '' });
        byBytes.push({ bytes, image });
        ktx2Bytes += bytes.length;
        ktx2Count++;
      }
      const tex = texturesList[t] as Obj;
      const ext = own(tex, 'extensions');
      const exts = isPlainObject(ext) ? ext : {};
      exts.KHR_texture_basisu = { source: image };
      tex.extensions = exts;
      usesKtx2 = true;
    }
  }

  const modulePart = place(v.moduleBytes);
  const projectPart = place(v.projectBytes);
  const end = parts[projectPart].offset + v.projectBytes.length;

  // bufferViews + images.
  for (const p of parts) views.push({ buffer: 0, byteOffset: p.offset, byteLength: p.bytes.length });
  for (const e of imageEntries) {
    const img: Obj = { bufferView: viewOfPart(e.part), mimeType: e.mime };
    if (e.name) img.name = e.name;
    images.push(img);
  }
  if (images.length === 0) delete doc.images;

  // Extension lists.
  const listPush = (key: string, name: string) => {
    const list = ensureArray(doc, key);
    if (!list.includes(name)) list.push(name);
  };
  if (usesWebp) listPush('extensionsUsed', 'EXT_texture_webp');
  // USED only, never REQUIRED: the fallback image is what a viewer without a
  // transcoder reads, and a required extension would make it refuse the file.
  if (usesKtx2) listPush('extensionsUsed', KTX2_EXTENSION);
  if (usesTransform) listPush('extensionsUsed', 'KHR_texture_transform');
  if (webpRequired) listPush('extensionsRequired', 'EXT_texture_webp');

  // asset.generator.
  if (input.generator !== undefined && isPlainObject(doc.asset)) doc.asset.generator = input.generator;

  // Root extras.
  const assetsSorted = v.assets
    .map((a) => [a.key, payloadImage.get(a.src) as number] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const fsWritten: FsGlbExtrasWritten = {
    v: FS_EXTRAS_VERSION,
    assets: Object.fromEntries(assetsSorted),
    module: { bufferView: viewOfPart(modulePart), mimeType: FS_MODULE_MIME, fnv1a: fnv1a32Hex(input.moduleText) },
    project: { bufferView: viewOfPart(projectPart) },
  };
  let extrasReplaced = false;
  const extras = own(doc, 'extras');
  if (isPlainObject(extras)) {
    delete extras[FS_EXTRAS_KEY];
    extras[FS_EXTRAS_KEY] = fsWritten;
  } else {
    if (extras !== undefined) {
      extrasReplaced = true;
      delete doc.extras;
    }
    doc.extras = { [FS_EXTRAS_KEY]: fsWritten };
  }

  // The default scene's pointer-free marker.
  const scenes = own(doc, 'scenes');
  const sceneIndex = doc.scene === undefined ? 0 : doc.scene;
  const scene = Array.isArray(scenes) && isSafeNonNeg(sceneIndex) ? scenes[sceneIndex] : undefined;
  if (isPlainObject(scene)) {
    const se = own(scene, 'extras');
    if (isPlainObject(se)) {
      delete se[FS_EXTRAS_KEY];
      se[FS_EXTRAS_KEY] = { ...FS_SCENE_MARKER };
    } else {
      delete scene.extras;
      scene.extras = { [FS_EXTRAS_KEY]: { ...FS_SCENE_MARKER } };
    }
  }

  // buffers[0] covers everything appended.
  (doc.buffers as Obj[])[0].byteLength = end;

  // Caps.
  const count = (k: string) => {
    const a = own(doc, k);
    return Array.isArray(a) ? a.length : 0;
  };
  if (count('images') > GLTF_READ_CAPS.images) refuse('too-complex', 'cap:images');
  if (count('textures') > GLTF_READ_CAPS.textures) refuse('too-complex', 'cap:textures');
  if (count('samplers') > GLTF_READ_CAPS.samplers) refuse('too-complex', 'cap:samplers');
  if (count('bufferViews') > GLTF_READ_CAPS.bufferViews) refuse('too-complex', 'cap:bufferViews');

  const json = JSON.stringify(doc);
  const jsonBytes = enc.encode(json).length;
  if (jsonBytes > GLB_JSON_MAX_BYTES) refuse('too-complex', 'json');
  const totalBytes = 12 + 8 + pad4(jsonBytes) + 8 + pad4(end);
  if (totalBytes > 0xffffffff) refuse('too-complex', 'total');

  return {
    json,
    jsonBytes,
    baseBin,
    parts,
    end,
    size: {
      totalBytes,
      jsonBytes,
      baseBinBytes: baseBin.length,
      textureImageBytes,
      fallbackBytes,
      assetOnlyImageBytes,
      moduleBytes: v.moduleBytes.length,
      projectBytes: v.projectBytes.length,
      textureCount: texturesWritten,
      fallbackCount: fallbackImage.size,
      fallbackMissing,
      ktx2Bytes,
      ktx2Count,
      webpRequired,
    },
    report: {
      slotsWritten: v.slots.length,
      texturesWritten,
      imagesWritten: imageEntries.length,
      samplersAdded,
      extrasReplaced,
    },
    written,
    assetKeys: assetsSorted.map((a) => a[0]),
  };
}

function run<T>(fn: () => T): Result<T> {
  try {
    return { ok: true, value: fn() };
  } catch (e) {
    if (e instanceof Refused) return { ok: false, refusal: e.refusal };
    throw e;
  }
}

/** The exact size of `repackGlb(input)`'s file, without writing it. */
export function measureGlbRepack(
  input: RepackInput,
): { ok: true; size: GlbRepackSize; written: RepackWritten[] } | { ok: false; refusal: RepackRefusal } {
  const r = run(() => layoutGlbRepack(input));
  return r.ok ? { ok: true, size: r.value.size, written: r.value.written } : r;
}

/**
 * Write the single `.glb`. A refusal is a RESULT; a throw is an internal
 * invariant failure (in development, the output must re-read with the base's
 * signature, every written slot must resolve to its texture and payload, and
 * the extras must name every asset key).
 */
export function repackGlb(
  input: RepackInput,
): { ok: true; bytes: Uint8Array<ArrayBuffer>; report: GlbRepackReport } | { ok: false; refusal: RepackRefusal } {
  const r = run(() => layoutGlbRepack(input));
  if (!r.ok) return r;
  const l = r.value;
  const bin = new Uint8Array(l.end);
  bin.set(l.baseBin, 0);
  for (const p of l.parts) bin.set(p.bytes, p.offset);
  const bytes = buildGlbContainer(l.json, bin);
  if (bytes.length !== l.size.totalBytes) throw new Error('glbRepack: the measured size does not match the file');

  if (import.meta.env?.DEV) {
    const again = readGltfModel(bytes, 'glb');
    if (!again.ok) throw new Error(`glbRepack: the output does not re-read (${again.refusal.detail})`);
    if (!modelSignatureMatches(again.model.signature, input.base.signature)) {
      throw new Error('glbRepack: the output changed the model signature');
    }
    for (const w of l.written) {
      const mat = again.model.materials[w.material];
      const slot = mat?.slots.find((s) => s.slot === w.slot);
      if (!slot || slot.texture !== w.texture) throw new Error('glbRepack: a written slot does not resolve');
      const tex = again.model.textures[w.texture];
      if (tex.extract.status !== 'ok' || tex.extract.image !== w.image) {
        throw new Error('glbRepack: a written texture does not extract its payload');
      }
    }
    const pointers = readFsGlbPointers(again.model.source.doc, {
      images: again.model.images.length,
      bufferViews: Array.isArray(again.model.source.doc.bufferViews) ? again.model.source.doc.bufferViews.length : 0,
    });
    if (!pointers || l.assetKeys.some((k) => !pointers.assets.has(k)) || !pointers.module || !pointers.project) {
      throw new Error('glbRepack: the extras do not read back');
    }
  }
  return { ok: true, bytes, report: { size: l.size, ...l.report } };
}
