/**
 * THE TRUSTED-SIDE glTF MODEL READER — the second documented exception to
 * "model bytes are never parsed on the trusted side" (`previewMesh.ts` states
 * the rule; its two length-capped JSON-header readers are the first).
 *
 * WHY IT EXISTS. "Build a shader from the model's materials" has to know the
 * model's materials, textures and images on the side that builds the graph, and
 * the Output node has to know which glTF material index a loaded mesh carries
 * (index sections, their dormancy, the loader-0.6 mirror keys). Neither can be
 * answered from inside the sandbox without trusting what it reports back.
 *
 * WHAT IT READS. The JSON (through the shared deny-list reviver, with a length
 * cap: the GLB container caps its JSON chunk at 16 MiB, a `.gltf` is at most
 * MESH_MAX_BYTES of text); materials (factors, the five core texture slots
 * with the sanitized `textureInfo` `gltfTextureValues` takes, alpha mode,
 * double-sidedness, unlit, emissive strength, the `KHR_materials_*` list and
 * the textures those extensions reference); samplers; textures, resolving the
 * `EXT_texture_webp` / `EXT_texture_avif` / `KHR_texture_basisu` source
 * indirection in GLTFLoader's plugin order; images, as views of a bufferView or
 * strictly decoded `data:` URIs, classified by their SNIFFED format; primitive
 * attribute KEYS (TANGENT, COLOR_0, NORMAL, TEXCOORD_n); the model signature;
 * and the default scene's mesh → material mapping with the loader's predicted
 * mesh names (`gltfNaming.ts`).
 *
 * WHAT IT NEVER DOES. Build geometry, read accessor data, decode a picture,
 * resolve or request a URI (an image or buffer outside the file is REPORTED as
 * `external`), touch the network or a decoder, import three, or run in the
 * preview sandbox. Image bytes go only to the dropped-image pipeline.
 *
 * HOW IT READS. Every array is count-capped (GLTF_READ_CAPS) before it is
 * walked; every index is checked (`Number.isSafeInteger`, in range) and every
 * bufferView bounds-checked against the real buffer bytes; every read is a
 * plain or own-property access with a `typeof` check, never `in` on file data.
 * It is STRICTER than GLTFLoader on purpose: a second parent, a cycle, a bad
 * reference in an unused material, a truthy non-string name — the loader either
 * throws on those or re-parents unpredictably, and a refusal here only
 * withdraws the build, never the model-only drop. `readGltfModel` never throws.
 *
 * ITS OUTPUT IS TRANSIENT. A `GltfModelReport` holds views into the dropped
 * file (image bytes, the BIN chunk) and the parsed document. It must never
 * enter the store, undo history, the autosave, IndexedDB or a postMessage —
 * `gltfPreviewFacts` is the one adapter whose result may be kept, and it holds
 * only strings and numbers.
 */

import { safeJsonReviver } from './safeJson';
import {
  decodeDataUri,
  parseGlbContainer,
  readImageDimensions,
  sniffImageFormat,
  type SniffedImageFormat,
} from './glbContainer';
import {
  GLB_READ_MAX_BYTES,
  MESH_MAX_BYTES,
  inspectParsedGltf,
  type GltfCompressionReport,
} from './gltfCompression';
import { MAX_INVENTORY_MESHES, isUsableMeshName } from './meshInventory';
import { predictSceneMeshes, type GltfSceneGraph, type PredictedMesh } from './gltfNaming';
import {
  SIGNATURE_MATERIALS_MAX,
  SIGNATURE_NAME_MAX,
  SIGNATURE_TOTAL_CHARS_MAX,
  type ModelSignature,
} from '@/engine/materialPartsContract';

/* ── caps and types ──────────────────────────────────────────────────────── */

/** Most entries per array (`primitives`, `joints` and `channels` are SUMMED
 *  over their parents; `channels` also counts each animation's samplers).
 *  Exceeding one is `too-complex`, never a silent truncation. */
export const GLTF_READ_CAPS = {
  nodes: 65536,
  meshes: 65536,
  primitives: 262144,
  accessors: 1048576,
  bufferViews: 1048576,
  buffers: 256,
  materials: SIGNATURE_MATERIALS_MAX,
  textures: 4096,
  images: 4096,
  samplers: 4096,
  scenes: 256,
  skins: 4096,
  joints: 262144,
  animations: 4096,
  channels: 1048576,
  cameras: 4096,
  lights: 4096,
  extensionNames: 256,
  /** Mesh objects the default scene would hold (instances counted): the
   *  naming's output. One mesh instanced by every node would otherwise make a
   *  small file predict billions of names. */
  sceneMeshes: 262144,
} as const;

/** Largest single image the reader hands out; a bigger one is `too-large`. */
export const GLTF_IMAGE_MAX_BYTES = 64 * 1024 * 1024;

export type GltfReadRefusalReason = 'too-large' | 'unreadable' | 'too-complex' | 'external-data' | 'invalid-model';

/** `detail` is a machine code (`glb:chunk-order`, `cap:nodes`,
 *  `ref:nodes[3].mesh`, `name:meshes[2]`, `cycle`, `parents:node 5`, …) for
 *  logs and tests — never shown to a user. */
export interface GltfReadRefusal {
  reason: GltfReadRefusalReason;
  detail: string;
}

export type GltfSlot = 'baseColor' | 'metallicRoughness' | 'normal' | 'occlusion' | 'emissive';

/** A glTF `textureInfo`, rebuilt FRESH from checked fields: what
 *  `gltfTextureValues` (utils/imageUvMapping.ts) takes as-is. */
export interface GltfTextureInfo {
  index: number;
  texCoord?: number;
  extensions?: {
    KHR_texture_transform: {
      offset?: [number, number];
      rotation?: number;
      scale?: [number, number];
      texCoord?: number;
    };
  };
}

export interface GltfSlotRef {
  slot: GltfSlot;
  texture: number;
  textureInfo: GltfTextureInfo;
  /** normalTexture.scale (finite, |v| ≤ 1e6, default 1). */
  scale?: number;
  /** occlusionTexture.strength (clamped to [0, 1], default 1). */
  strength?: number;
}

/** How the default scene uses a material (instances counted). */
export interface GltfMaterialUsage {
  primitives: number;
  withTangents: number;
  withVertexColors: number;
  withoutNormals: number;
  /** The TEXCOORD_n present on EVERY using primitive, ascending. */
  uvSets: number[];
}

export interface GltfMaterial {
  index: number;
  /** The RAW name — the signature value; '' when absent or not a string. */
  name: string;
  /** The name for display: no control characters, at most 64 characters. */
  displayName: string;
  baseColorFactor: [number, number, number, number];
  metallicFactor: number;
  roughnessFactor: number;
  emissiveFactor: [number, number, number];
  emissiveStrength: number;
  alphaMode: 'OPAQUE' | 'MASK' | 'BLEND';
  alphaCutoff: number;
  doubleSided: boolean;
  unlit: boolean;
  slots: GltfSlotRef[];
  /** Sorted, checked own keys of the material's `extensions`, at most 32. */
  extensions: string[];
  /** Textures referenced from inside a material EXTENSION (clearcoat, sheen, …)
   *  — the builder reads none of them, so they are reported, not built. */
  unsupportedTextures: { extension: string; key: string; texture: number }[];
  usage: GltfMaterialUsage;
}

export interface GltfSampler {
  magFilter: 9728 | 9729 | null;
  minFilter: 9728 | 9729 | 9984 | 9985 | 9986 | 9987 | null;
  wrapS: 33071 | 33648 | 10497;
  wrapT: 33071 | 33648 | 10497;
}

export type GltfTextureExtract =
  | { status: 'ok'; image: number }
  | { status: 'ktx2-only' | 'no-readable-source'; image: null };

export interface GltfTexture {
  index: number;
  /** Display rule, at most 64 characters (a file-name hint only). */
  name: string;
  sampler: number | null;
  sources: { core: number | null; webp: number | null; avif: number | null; basisu: number | null };
  extract: GltfTextureExtract;
}

export type GltfImageStatus = 'ok' | 'external' | 'unsupported-format' | 'damaged' | 'too-large' | 'compressed-view';

export interface GltfImage {
  index: number;
  status: GltfImageStatus;
  format: SniffedImageFormat;
  /** The SNIFFED type (never the declared one); null unless status is 'ok'. */
  mime: 'image/png' | 'image/jpeg' | 'image/webp' | null;
  declaredMime: string;
  /** A non-empty declared type that is not what the bytes are. Informational:
   *  extraction trusts the sniff. */
  mimeMismatch: boolean;
  byteLength: number;
  width: number | null;
  height: number | null;
  /** A VIEW into the dropped file (or a decoded `data:` URI); null unless the
   *  bytes were readable (status 'ok' or 'unsupported-format'). */
  bytes: Uint8Array | null;
  name: string;
}

export type GltfSceneMesh = PredictedMesh;

/** Non-fatal findings: a `texCoord` outside 0..31 was dropped ('texcoord'); a
 *  malformed `KHR_texture_transform` field was dropped ('texture-transform'). */
export type GltfReadWarning = 'texcoord' | 'texture-transform';

/** The writer's input (utils/gltfStrip.ts): the parsed document and the buffer
 *  bytes it references. `buffers[i]` is the data (the BIN chunk or a decoded
 *  `data:` URI) or 'fallback' for a meshopt fallback buffer, which has none. */
export interface GltfSource {
  doc: Record<string, unknown>;
  bin: Uint8Array | null;
  buffers: (Uint8Array | 'fallback')[];
}

export interface GltfModelReport {
  kind: 'glb' | 'gltf';
  byteLength: number;
  signature: ModelSignature;
  materials: GltfMaterial[];
  textures: GltfTexture[];
  images: GltfImage[];
  samplers: GltfSampler[];
  /** The default scene's Mesh objects, in traversal order (instances counted). */
  sceneMeshes: GltfSceneMesh[];
  /** Every predicted name is certain. */
  namingExact: boolean;
  /** Predicted name → the material indices of every default-scene mesh carrying
   *  it (ascending, the default material `null` last), and whether every such
   *  prediction is certain. A `Map`: the keys come from the file. */
  meshNameIndex: ReadonlyMap<string, { materials: readonly (number | null)[]; certain: boolean }>;
  extensionsUsed: string[];
  extensionsRequired: string[];
  compression: GltfCompressionReport;
  warnings: GltfReadWarning[];
  /** @internal the writer's input. */
  readonly source: GltfSource;
}

export type GltfReadResult = { ok: true; model: GltfModelReport } | { ok: false; refusal: GltfReadRefusal };

/* ── helpers ─────────────────────────────────────────────────────────────── */

class Refusal {
  constructor(
    readonly reason: GltfReadRefusalReason,
    readonly detail: string,
  ) {}
}

function refuse(reason: GltfReadRefusalReason, detail: string): never {
  throw new Refusal(reason, detail);
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** An OWN property, or undefined — for keys that come from the file (an
 *  extension name, a camera type), where a plain lookup could reach
 *  Object.prototype. */
function own(o: Obj, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(o, key) ? o[key] : undefined;
}

const isIndex = (v: unknown, length: number): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v < length;

/** An optional index: undefined → null; anything but a valid index refuses. */
function optIndex(v: unknown, length: number, detail: string): number | null {
  if (v === undefined) return null;
  if (!isIndex(v, length)) refuse('invalid-model', detail);
  return v;
}

function reqIndex(v: unknown, length: number, detail: string): number {
  if (!isIndex(v, length)) refuse('invalid-model', detail);
  return v;
}

const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/* eslint-disable no-control-regex */
/** C0, C1 and the two line terminators — meshInventory's rule. */
const UNSAFE_CHARS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;
/* eslint-enable no-control-regex */

/** Cut to `max` UTF-16 units without splitting a surrogate pair. */
function capString(s: string, max: number): string {
  if (s.length <= max) return s;
  const code = s.charCodeAt(max - 1);
  return s.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

/** The display rule: a string with no control characters, capped; else ''. */
function displayString(v: unknown, max: number): string {
  if (typeof v !== 'string' || UNSAFE_CHARS.test(v)) return '';
  return capString(v, max);
}

/** A glTF name the loader will read: a string, or absent/falsy (→ ''). A
 *  truthy non-string makes `sanitizeNodeName` throw inside GLTFLoader. */
function loaderName(v: unknown, detail: string): string {
  if (!v) return '';
  if (typeof v !== 'string') refuse('invalid-model', detail);
  return v;
}

/** A top-level array: absent → []; otherwise an array (length checked BEFORE
 *  the walk) of plain objects. */
function topArray(doc: Obj, key: keyof typeof GLTF_READ_CAPS): Obj[] {
  const v = doc[key];
  if (v === undefined) return [];
  if (!Array.isArray(v)) refuse('invalid-model', 'shape:' + key);
  if (v.length > GLTF_READ_CAPS[key]) refuse('too-complex', 'cap:' + key);
  for (let i = 0; i < v.length; i++) if (!isObj(v[i])) refuse('invalid-model', `shape:${key}[${i}]`);
  return v as Obj[];
}

/** A summed budget over nested arrays. */
function spend(budget: { left: number }, n: number, cap: string): void {
  budget.left -= n;
  if (budget.left < 0) refuse('too-complex', 'cap:' + cap);
}

/** A nested array of plain objects (`primitives`, `channels`, …). With a
 *  budget, its LENGTH is charged before a single element is walked. */
function subArray(v: unknown, detail: string, budget?: { left: number; cap: string }): Obj[] {
  if (!Array.isArray(v)) refuse('invalid-model', detail);
  if (budget) spend(budget, v.length, budget.cap);
  for (let i = 0; i < v.length; i++) if (!isObj(v[i])) refuse('invalid-model', `${detail}[${i}]`);
  return v as Obj[];
}

/** An extension-name list: absent → []; else at most 256 entries, keeping the
 *  checked strings (≤ 128 characters, no control characters). */
function extensionList(doc: Obj, key: 'extensionsUsed' | 'extensionsRequired'): string[] {
  const v = doc[key];
  if (v === undefined) return [];
  if (!Array.isArray(v)) refuse('invalid-model', 'shape:' + key);
  if (v.length > GLTF_READ_CAPS.extensionNames) refuse('too-complex', 'cap:extensionNames');
  const out: string[] = [];
  for (const e of v) if (typeof e === 'string' && e.length <= 128 && !UNSAFE_CHARS.test(e) && !out.includes(e)) out.push(e);
  return out;
}

const MESHOPT_EXTENSIONS = ['EXT_meshopt_compression', 'KHR_meshopt_compression'] as const;

/** The meshopt extension objects present on a buffer or bufferView. */
function meshoptExtensions(o: Obj): Obj[] {
  const exts = o.extensions;
  if (!isObj(exts)) return [];
  const out: Obj[] = [];
  for (const name of MESHOPT_EXTENSIONS) {
    const e = own(exts, name);
    if (isObj(e)) out.push(e);
  }
  return out;
}

const EXTRACTABLE: Readonly<Record<string, 'image/png' | 'image/jpeg' | 'image/webp'>> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};
const SNIFFED_MIME: Readonly<Record<SniffedImageFormat, string | null>> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  ktx2: 'image/ktx2',
  avif: 'image/avif',
  unknown: null,
};

const MAG_FILTERS: ReadonlySet<number> = new Set([9728, 9729]);
const MIN_FILTERS: ReadonlySet<number> = new Set([9728, 9729, 9984, 9985, 9986, 9987]);
const WRAPS: ReadonlySet<number> = new Set([33071, 33648, 10497]);
const LIGHT_TYPES: ReadonlySet<unknown> = new Set(['directional', 'point', 'spot']);
const CAMERA_TYPES: ReadonlySet<unknown> = new Set(['perspective', 'orthographic']);
const TEXCOORD_RE = /^TEXCOORD_([0-7])$/;
const TRANSFORM_MAX = 1e6;
/** How far `unsupportedTextures` looks inside a material extension, and how
 *  much it may visit and report per material. */
const EXT_WALK_DEPTH = 4;
const EXT_WALK_BUDGET = 512;
const EXT_TEXTURES_MAX = 64;

/* ── the reader ──────────────────────────────────────────────────────────── */

/**
 * Read a glTF model, or say why not. Never throws: every failure — hostile
 * structure, an input over the caps, even an unforeseen internal error (detail
 * `internal`, which the fuzz suite asserts never happens) — is a refusal.
 */
export function readGltfModel(bytes: Uint8Array, kind: 'glb' | 'gltf'): GltfReadResult {
  try {
    if (!(bytes instanceof Uint8Array) || (kind !== 'glb' && kind !== 'gltf')) refuse('unreadable', 'input');
    return { ok: true, model: read(bytes, kind) };
  } catch (e) {
    if (e instanceof Refusal) return { ok: false, refusal: { reason: e.reason, detail: e.detail } };
    return { ok: false, refusal: { reason: 'unreadable', detail: 'internal' } };
  }
}

interface ViewInfo {
  buffer: number;
  offset: number;
  length: number;
  /** A meshopt-compressed view, or one on a fallback buffer: no plain bytes. */
  compressed: boolean;
}

interface PrimFacts {
  material: number | null;
  mode: number;
  tangents: boolean;
  vertexColors: boolean;
  normals: boolean;
  uvSets: number[];
}

function read(bytes: Uint8Array, kind: 'glb' | 'gltf'): GltfModelReport {
  // 1. Size, from the length alone.
  if (bytes.length > (kind === 'glb' ? GLB_READ_MAX_BYTES : MESH_MAX_BYTES)) refuse('too-large', 'size');

  // 2. Container.
  let text: string;
  let bin: Uint8Array | null = null;
  if (kind === 'glb') {
    const c = parseGlbContainer(bytes);
    if (!c.ok) refuse('unreadable', 'glb:' + c.error);
    text = c.chunks.json;
    bin = c.chunks.bin;
  } else {
    text = new TextDecoder().decode(bytes);
  }

  // 3. JSON (a deeply nested document can overflow the reviver's recursion;
  //    that is caught here as unreadable).
  let parsed: unknown;
  try {
    parsed = JSON.parse(text, safeJsonReviver);
  } catch {
    refuse('unreadable', 'json');
  }
  if (!isObj(parsed)) refuse('unreadable', 'json');
  const doc = parsed;

  // 4. Asset: glTF 2.x. Also refused when the version's FIRST character is
  //    below 2 — GLTFLoader's own test (`version[0] < 2`), so '10.0' is out.
  const asset = doc.asset;
  const version = isObj(asset) ? asset.version : undefined;
  if (typeof version !== 'string' || !/^[0-9]/.test(version) || parseInt(version, 10) < 2 || Number(version[0]) < 2) {
    refuse('invalid-model', 'asset');
  }

  // 5. Shapes and counts of every top-level array.
  const buffersDef = topArray(doc, 'buffers');
  const viewsDef = topArray(doc, 'bufferViews');
  const accessorsDef = topArray(doc, 'accessors');
  const imagesDef = topArray(doc, 'images');
  const samplersDef = topArray(doc, 'samplers');
  const texturesDef = topArray(doc, 'textures');
  const materialsDef = topArray(doc, 'materials');
  const meshesDef = topArray(doc, 'meshes');
  const nodesDef = topArray(doc, 'nodes');
  const scenesDef = topArray(doc, 'scenes');
  const skinsDef = topArray(doc, 'skins');
  const animationsDef = topArray(doc, 'animations');
  const camerasDef = topArray(doc, 'cameras');
  const extensionsUsed = extensionList(doc, 'extensionsUsed');
  const extensionsRequired = extensionList(doc, 'extensionsRequired');
  const lightsDef = readLightDefs(doc);

  // 6. Buffers.
  const buffers: (Uint8Array | 'fallback')[] = [];
  let remaining = GLB_READ_MAX_BYTES;
  for (let i = 0; i < buffersDef.length; i++) {
    const b = buffersDef[i];
    const uri = b.uri;
    const fallback = meshoptExtensions(b).some((e) => e.fallback === true);
    if (uri === undefined) {
      if (kind === 'glb' && i === 0 && bin) buffers.push(bin);
      else if (fallback) buffers.push('fallback');
      else refuse('invalid-model', `buffer:${i}`);
    } else if (typeof uri !== 'string') {
      refuse('invalid-model', `buffer:${i}`);
    } else if (/^data:/i.test(uri)) {
      const r = decodeDataUri(uri, 'buffer', remaining);
      if (!r.ok) refuse('unreadable', `buffer:${i}`);
      remaining -= r.bytes.length;
      buffers.push(r.bytes);
    } else {
      refuse('external-data', `buffer:${i}`);
    }
  }

  // 7. bufferViews, bounds-checked against the real bytes.
  const views: ViewInfo[] = [];
  for (let i = 0; i < viewsDef.length; i++) {
    const v = viewsDef[i];
    const detail = `ref:bufferViews[${i}]`;
    const buffer = reqIndex(v.buffer, buffers.length, detail);
    const offset = v.byteOffset === undefined ? 0 : v.byteOffset;
    const length = v.byteLength;
    if (!isIndex(offset, Number.MAX_SAFE_INTEGER) || typeof length !== 'number' || !Number.isSafeInteger(length) || length < 1) {
      refuse('invalid-model', detail);
    }
    const data = buffers[buffer];
    if (data !== 'fallback' && offset + length > data.length) refuse('invalid-model', detail);
    const meshopt = meshoptExtensions(v);
    if (data === 'fallback' && meshopt.length === 0) refuse('invalid-model', detail);
    for (const e of meshopt) {
      const mb = reqIndex(e.buffer, buffers.length, detail + '.meshopt');
      const mo = e.byteOffset === undefined ? 0 : e.byteOffset;
      const ml = e.byteLength;
      const mdata = buffers[mb];
      if (
        mdata === 'fallback' ||
        !isIndex(mo, Number.MAX_SAFE_INTEGER) ||
        typeof ml !== 'number' ||
        !Number.isSafeInteger(ml) ||
        ml < 1 ||
        mo + ml > mdata.length
      ) {
        refuse('invalid-model', detail + '.meshopt');
      }
    }
    views.push({ buffer, offset, length, compressed: meshopt.length > 0 || data === 'fallback' });
  }

  // 8. Accessors: only their bufferView references are read.
  for (let i = 0; i < accessorsDef.length; i++) {
    const a = accessorsDef[i];
    optIndex(a.bufferView, views.length, `ref:accessors[${i}].bufferView`);
    if (a.sparse !== undefined) {
      const s = a.sparse;
      const detail = `ref:accessors[${i}].sparse`;
      if (!isObj(s) || !isObj(s.indices) || !isObj(s.values)) refuse('invalid-model', detail);
      reqIndex(s.indices.bufferView, views.length, detail);
      reqIndex(s.values.bufferView, views.length, detail);
    }
  }

  // 9. Images.
  const images = imagesDef.map((im, i) => readImage(im, i, views, buffers));

  // 10. Samplers.
  const samplers: GltfSampler[] = samplersDef.map((s) => ({
    magFilter: MAG_FILTERS.has(s.magFilter as number) ? (s.magFilter as GltfSampler['magFilter']) : null,
    minFilter: MIN_FILTERS.has(s.minFilter as number) ? (s.minFilter as GltfSampler['minFilter']) : null,
    wrapS: WRAPS.has(s.wrapS as number) ? (s.wrapS as GltfSampler['wrapS']) : 10497,
    wrapT: WRAPS.has(s.wrapT as number) ? (s.wrapT as GltfSampler['wrapT']) : 10497,
  }));

  // 11. Textures.
  const textures = texturesDef.map((t, i) => readTexture(t, i, images, samplers.length));

  // 12. Materials, and the signature's two bounds right away.
  const warnings = new Set<GltfReadWarning>();
  const transformListed = extensionsUsed.includes('KHR_texture_transform');
  const materials = materialsDef.map((m, i) => readMaterial(m, i, textures.length, transformListed, warnings));
  let signatureChars = 0;
  for (const m of materials) {
    if (m.name.length > SIGNATURE_NAME_MAX) refuse('too-complex', 'signature-name');
    signatureChars += m.name.length;
  }
  if (signatureChars > SIGNATURE_TOTAL_CHARS_MAX) refuse('too-complex', 'signature-total');

  // 13. Meshes.
  const primitiveBudget = { left: GLTF_READ_CAPS.primitives, cap: 'primitives' };
  const meshes = meshesDef.map((m, i) => readMesh(m, i, materials.length, accessorsDef.length, views.length, primitiveBudget));

  // 14. Cameras, lights, nodes, scenes, skins, animations.
  const cameras = camerasDef.map((c, i) => {
    const name = loaderName(c.name, `name:cameras[${i}]`);
    if (!CAMERA_TYPES.has(c.type)) refuse('invalid-model', `camera:${i}`);
    // GLTFLoader tests the parameters for TRUTHINESS (`if (!params)`).
    return { name, hasParams: !!own(c, c.type as string) };
  });
  const lights = lightsDef.map((l, i) => {
    if (!LIGHT_TYPES.has(l.type)) refuse('invalid-model', `light:${i}`);
    return { name: loaderName(l.name, `name:lights[${i}]`) };
  });

  const nodeCount = nodesDef.length;
  const parentOf = new Int32Array(nodeCount).fill(-1);
  const nodes: GltfSceneGraph['nodes'] = nodesDef.map((n, i) => {
    const name = loaderName(n.name, `name:nodes[${i}]`);
    const children: number[] = [];
    if (n.children !== undefined) {
      if (!Array.isArray(n.children)) refuse('invalid-model', `ref:nodes[${i}].children`);
      for (const c of n.children) {
        const child = reqIndex(c, nodeCount, `ref:nodes[${i}].children`);
        if (child === i) refuse('invalid-model', `ref:nodes[${i}].children`);
        if (parentOf[child] === i) refuse('invalid-model', `ref:nodes[${i}].children`);
        if (parentOf[child] !== -1) refuse('invalid-model', `parents:node ${child}`);
        parentOf[child] = i;
        children.push(child);
      }
    }
    const mesh = optIndex(n.mesh, meshes.length, `ref:nodes[${i}].mesh`);
    const camera = optIndex(n.camera, cameras.length, `ref:nodes[${i}].camera`);
    // The loader throws on a node whose camera has no parameters
    // (`loadCamera` returns nothing, and the node chains `.then` on it).
    if (camera !== null && !cameras[camera].hasParams) refuse('invalid-model', `camera:${camera}`);
    const skin = optIndex(n.skin, skinsDef.length, `ref:nodes[${i}].skin`);
    let light: number | null = null;
    const exts = n.extensions;
    if (isObj(exts)) {
      const lp = own(exts, 'KHR_lights_punctual');
      if (isObj(lp) && lp.light !== undefined) light = reqIndex(lp.light, lights.length, `ref:nodes[${i}].light`);
    }
    return { name, children, mesh, camera, skin, light };
  });

  const scenes = scenesDef.map((s, i) => {
    const name = loaderName(s.name, `name:scenes[${i}]`);
    const roots: number[] = [];
    if (s.nodes !== undefined) {
      if (!Array.isArray(s.nodes)) refuse('invalid-model', `ref:scenes[${i}].nodes`);
      const seen = new Set<number>();
      for (const r of s.nodes) {
        const root = reqIndex(r, nodeCount, `ref:scenes[${i}].nodes`);
        if (seen.has(root)) refuse('invalid-model', `ref:scenes[${i}].nodes`);
        seen.add(root);
        roots.push(root);
      }
    }
    return { name, nodes: roots };
  });
  const sceneIndex = doc.scene === undefined ? 0 : doc.scene;
  if (!isIndex(sceneIndex, scenes.length)) refuse('invalid-model', 'no-scene');

  const jointBudget = { left: GLTF_READ_CAPS.joints };
  const skins = skinsDef.map((s, i) => {
    const joints = s.joints;
    if (!Array.isArray(joints)) refuse('invalid-model', `ref:skins[${i}].joints`);
    spend(jointBudget, joints.length, 'joints');
    optIndex(s.inverseBindMatrices, accessorsDef.length, `ref:skins[${i}].inverseBindMatrices`);
    optIndex(s.skeleton, nodeCount, `ref:skins[${i}].skeleton`);
    return { joints: joints.map((j) => reqIndex(j, nodeCount, `ref:skins[${i}].joints`)) };
  });

  const channelBudget = { left: GLTF_READ_CAPS.channels, cap: 'channels' };
  const animationTargets: number[] = [];
  for (let a = 0; a < animationsDef.length; a++) {
    const anim = animationsDef[a];
    const channels = subArray(anim.channels, `shape:animations[${a}].channels`, channelBudget);
    const samplers = subArray(anim.samplers, `shape:animations[${a}].samplers`, channelBudget);
    samplers.forEach((s, k) => {
      reqIndex(s.input, accessorsDef.length, `ref:animations[${a}].samplers[${k}]`);
      reqIndex(s.output, accessorsDef.length, `ref:animations[${a}].samplers[${k}]`);
    });
    channels.forEach((c, k) => {
      reqIndex(c.sampler, samplers.length, `ref:animations[${a}].channels[${k}].sampler`);
      const target = c.target;
      if (!isObj(target)) refuse('invalid-model', `ref:animations[${a}].channels[${k}].target`);
      const node = optIndex(target.node, nodeCount, `ref:animations[${a}].channels[${k}].target`);
      if (node !== null) animationTargets.push(node);
    });
  }

  // 15. The tree: a single parent each (checked above), no cycle, and no
  //     scene root that is someone's child.
  for (const s of scenes) for (const r of s.nodes) if (parentOf[r] !== -1) refuse('invalid-model', `scene-root:${r}`);
  const state = new Uint8Array(nodeCount); // 0 unvisited, 1 on the walk, 2 done
  const walk: number[] = [];
  for (let n = 0; n < nodeCount; n++) {
    let cur = n;
    walk.length = 0;
    while (cur !== -1 && state[cur] === 0) {
      state[cur] = 1;
      walk.push(cur);
      cur = parentOf[cur];
    }
    if (cur !== -1 && state[cur] === 1) refuse('invalid-model', 'cycle');
    for (const w of walk) state[w] = 2;
  }

  // 16. Naming, once the default scene's Mesh count is known to be bounded
  //     (each node sits in the tree once, so this walk is O(nodes)).
  let sceneMeshCount = 0;
  const walkStack = scenes[sceneIndex].nodes.slice();
  while (walkStack.length > 0) {
    const n = walkStack.pop()!;
    const mesh = nodes[n].mesh;
    if (mesh !== null) sceneMeshCount += meshes[mesh].prims.length;
    for (const c of nodes[n].children) walkStack.push(c);
  }
  if (sceneMeshCount > GLTF_READ_CAPS.sceneMeshes) refuse('too-complex', 'cap:sceneMeshes');
  const graph: GltfSceneGraph = {
    nodes,
    meshes: meshes.map((m) => ({
      name: m.name,
      primitives: m.prims.map((p) => ({ material: p.material, mode: p.mode, tangents: p.tangents, vertexColors: p.vertexColors })),
    })),
    scenes,
    defaultScene: sceneIndex,
    skins,
    animationTargets,
    cameras,
    lights,
  };
  const predicted = predictSceneMeshes(graph);

  // 17. Usage over the default scene's Mesh primitives, instances counted.
  const uvSeen: (number[] | null)[] = materials.map(() => null);
  for (const sm of predicted.meshes) {
    if (sm.material === null) continue;
    const prim = meshes[sm.mesh].prims[sm.primitive];
    const u = materials[sm.material].usage;
    u.primitives++;
    if (prim.tangents) u.withTangents++;
    if (prim.vertexColors) u.withVertexColors++;
    if (!prim.normals) u.withoutNormals++;
    const prev = uvSeen[sm.material];
    uvSeen[sm.material] = prev === null ? prim.uvSets.slice() : prev.filter((s) => prim.uvSets.includes(s));
  }
  materials.forEach((m, i) => (m.usage.uvSets = uvSeen[i] ?? []));

  // meshNameIndex, in first-appearance order.
  const nameIndex = new Map<string, { materials: (number | null)[]; certain: boolean }>();
  for (const sm of predicted.meshes) {
    const e = nameIndex.get(sm.name);
    if (!e) nameIndex.set(sm.name, { materials: [sm.material], certain: sm.certain });
    else {
      if (!e.materials.includes(sm.material)) e.materials.push(sm.material);
      e.certain = e.certain && sm.certain;
    }
  }
  for (const e of nameIndex.values()) {
    e.materials.sort((a, b) => (a === null ? 1 : b === null ? -1 : a - b));
  }

  // 18 + 19. Signature, lists, compression.
  return {
    kind,
    byteLength: bytes.length,
    signature: { materials: materials.map((m) => m.name) },
    materials,
    textures,
    images,
    samplers,
    sceneMeshes: predicted.meshes,
    namingExact: predicted.exact,
    meshNameIndex: nameIndex,
    extensionsUsed,
    extensionsRequired,
    compression: inspectParsedGltf(doc),
    warnings: [...warnings],
    source: { doc, bin, buffers },
  };
}

function readLightDefs(doc: Obj): Obj[] {
  const exts = doc.extensions;
  if (!isObj(exts)) return [];
  const lp = own(exts, 'KHR_lights_punctual');
  if (!isObj(lp) || lp.lights === undefined) return [];
  const lights = lp.lights;
  if (!Array.isArray(lights)) refuse('invalid-model', 'shape:lights');
  if (lights.length > GLTF_READ_CAPS.lights) refuse('too-complex', 'cap:lights');
  return subArray(lights, 'shape:lights');
}

function readImage(im: Obj, index: number, views: ViewInfo[], buffers: (Uint8Array | 'fallback')[]): GltfImage {
  const out: GltfImage = {
    index,
    status: 'damaged',
    format: 'unknown',
    mime: null,
    declaredMime: displayString(im.mimeType, 64),
    mimeMismatch: false,
    byteLength: 0,
    width: null,
    height: null,
    bytes: null,
    name: displayString(im.name, 64),
  };
  let bytes: Uint8Array | null = null;
  if (im.bufferView !== undefined) {
    const view = views[reqIndex(im.bufferView, views.length, `ref:images[${index}].bufferView`)];
    out.byteLength = view.length;
    if (view.compressed) {
      out.status = 'compressed-view';
      return out;
    }
    bytes = (buffers[view.buffer] as Uint8Array).subarray(view.offset, view.offset + view.length);
  } else if (typeof im.uri === 'string') {
    if (!/^data:/i.test(im.uri)) {
      out.status = 'external';
      return out;
    }
    const r = decodeDataUri(im.uri, 'image', GLTF_IMAGE_MAX_BYTES);
    if (!r.ok) {
      out.status = r.error === 'too-large' ? 'too-large' : 'damaged';
      return out;
    }
    bytes = r.bytes;
    out.byteLength = bytes.length;
  } else {
    return out;
  }
  if (bytes.length > GLTF_IMAGE_MAX_BYTES) {
    out.status = 'too-large';
    return out;
  }
  const format = sniffImageFormat(bytes);
  out.format = format;
  out.bytes = bytes;
  const sniffed = SNIFFED_MIME[format];
  out.mimeMismatch = out.declaredMime !== '' && out.declaredMime.toLowerCase() !== sniffed;
  const mime = own(EXTRACTABLE, format) as GltfImage['mime'] | undefined;
  if (mime) {
    out.status = 'ok';
    out.mime = mime;
    const d = readImageDimensions(bytes, format);
    if (d) {
      out.width = d.width;
      out.height = d.height;
    }
  } else {
    out.status = 'unsupported-format';
  }
  return out;
}

function readTexture(t: Obj, index: number, images: GltfImage[], samplerCount: number): GltfTexture {
  const detail = `ref:textures[${index}]`;
  const sampler = optIndex(t.sampler, samplerCount, detail + '.sampler');
  const core = optIndex(t.source, images.length, detail + '.source');
  const exts = isObj(t.extensions) ? t.extensions : null;
  const extSource = (name: string): number | null => {
    if (!exts) return null;
    const e = own(exts, name);
    if (e === undefined) return null;
    if (!isObj(e)) refuse('invalid-model', `${detail}.${name}`);
    return reqIndex(e.source, images.length, `${detail}.${name}`);
  };
  const webp = extSource('EXT_texture_webp');
  const avif = extSource('EXT_texture_avif');
  const basisu = extSource('KHR_texture_basisu');
  let extract: GltfTextureExtract = { status: basisu !== null ? 'ktx2-only' : 'no-readable-source', image: null };
  for (const c of [webp, avif, core]) {
    if (c !== null && images[c].status === 'ok') {
      extract = { status: 'ok', image: c };
      break;
    }
  }
  return { index, name: displayString(t.name, 64), sampler, sources: { core, webp, avif, basisu }, extract };
}

const boundedNum = (v: unknown): v is number => isFiniteNum(v) && Math.abs(v) <= TRANSFORM_MAX;

function pair(v: unknown): [number, number] | null {
  return Array.isArray(v) && v.length === 2 && boundedNum(v[0]) && boundedNum(v[1]) ? [v[0], v[1]] : null;
}

const isTexCoord = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 31;

function readMaterial(
  m: Obj,
  index: number,
  textureCount: number,
  transformListed: boolean,
  warnings: Set<GltfReadWarning>,
): GltfMaterial {
  const pbr = isObj(m.pbrMetallicRoughness) ? m.pbrMetallicRoughness : {};
  const exts = isObj(m.extensions) ? m.extensions : {};

  const bcf = pbr.baseColorFactor;
  const baseColorFactor: [number, number, number, number] =
    Array.isArray(bcf) && bcf.length === 4 && bcf.every(isFiniteNum)
      ? [clamp01(bcf[0]), clamp01(bcf[1]), clamp01(bcf[2]), clamp01(bcf[3])]
      : [1, 1, 1, 1];
  const ef = m.emissiveFactor;
  const emissiveFactor: [number, number, number] =
    Array.isArray(ef) && ef.length === 3 && ef.every(isFiniteNum) ? [clamp01(ef[0]), clamp01(ef[1]), clamp01(ef[2])] : [0, 0, 0];
  const strength = own(exts, 'KHR_materials_emissive_strength');
  const es = isObj(strength) ? strength.emissiveStrength : undefined;

  const slots: GltfSlotRef[] = [];
  const slot = (name: GltfSlot, raw: unknown) => {
    if (raw === undefined) return;
    const detail = `ref:materials[${index}].${name}`;
    if (!isObj(raw)) refuse('invalid-model', detail);
    const texture = reqIndex(raw.index, textureCount, detail);
    const textureInfo: GltfTextureInfo = { index: texture };
    if (raw.texCoord !== undefined) {
      if (isTexCoord(raw.texCoord)) textureInfo.texCoord = raw.texCoord;
      else warnings.add('texcoord');
    }
    // GLTFLoader honours KHR_texture_transform only when extensionsUsed lists it.
    const tx = transformListed && isObj(raw.extensions) ? own(raw.extensions, 'KHR_texture_transform') : undefined;
    if (isObj(tx)) {
      const t: NonNullable<GltfTextureInfo['extensions']>['KHR_texture_transform'] = {};
      if (tx.offset !== undefined) {
        const p = pair(tx.offset);
        if (p) t.offset = p;
        else warnings.add('texture-transform');
      }
      if (tx.rotation !== undefined) {
        if (boundedNum(tx.rotation)) t.rotation = tx.rotation;
        else warnings.add('texture-transform');
      }
      if (tx.scale !== undefined) {
        const p = pair(tx.scale);
        if (p) t.scale = p;
        else warnings.add('texture-transform');
      }
      if (tx.texCoord !== undefined) {
        if (isTexCoord(tx.texCoord)) t.texCoord = tx.texCoord;
        else warnings.add('texcoord');
      }
      if (Object.keys(t).length > 0) textureInfo.extensions = { KHR_texture_transform: t };
    }
    const ref: GltfSlotRef = { slot: name, texture, textureInfo };
    if (name === 'normal') ref.scale = boundedNum(raw.scale) ? raw.scale : 1;
    if (name === 'occlusion') ref.strength = isFiniteNum(raw.strength) ? clamp01(raw.strength) : 1;
    slots.push(ref);
  };
  slot('baseColor', pbr.baseColorTexture);
  slot('metallicRoughness', pbr.metallicRoughnessTexture);
  slot('normal', m.normalTexture);
  slot('occlusion', m.occlusionTexture);
  slot('emissive', m.emissiveTexture);

  const extensions = Object.keys(exts)
    .filter((k) => k.length > 0 && k.length <= 128 && !UNSAFE_CHARS.test(k))
    .sort()
    .slice(0, 32);

  return {
    index,
    name: typeof m.name === 'string' ? m.name : '',
    displayName: displayString(m.name, 64),
    baseColorFactor,
    metallicFactor: isFiniteNum(pbr.metallicFactor) ? clamp01(pbr.metallicFactor) : 1,
    roughnessFactor: isFiniteNum(pbr.roughnessFactor) ? clamp01(pbr.roughnessFactor) : 1,
    emissiveFactor,
    emissiveStrength: isFiniteNum(es) && es >= 0 ? Math.min(es, 1e6) : 1,
    alphaMode: m.alphaMode === 'MASK' || m.alphaMode === 'BLEND' ? m.alphaMode : 'OPAQUE',
    alphaCutoff: isFiniteNum(m.alphaCutoff) ? clamp01(m.alphaCutoff) : 0.5,
    doubleSided: m.doubleSided === true,
    unlit: isObj(own(exts, 'KHR_materials_unlit')),
    slots,
    extensions,
    unsupportedTextures: extensionTextures(exts, extensions, textureCount),
    usage: { primitives: 0, withTangents: 0, withVertexColors: 0, withoutNormals: 0, uvSets: [] },
  };
}

/** Every `<key>Texture` object with a valid `index` inside the material's
 *  extensions, depth ≤ 4, bounded in what it visits and reports. */
function extensionTextures(exts: Obj, names: string[], textureCount: number): GltfMaterial['unsupportedTextures'] {
  const out: GltfMaterial['unsupportedTextures'] = [];
  let budget = EXT_WALK_BUDGET;
  for (const extension of names) {
    const stack: { o: Obj; depth: number }[] = [];
    const root = own(exts, extension);
    if (isObj(root)) stack.push({ o: root, depth: 1 });
    while (stack.length > 0 && budget > 0 && out.length < EXT_TEXTURES_MAX) {
      const { o, depth } = stack.pop()!;
      for (const key of Object.keys(o)) {
        if (--budget <= 0 || out.length >= EXT_TEXTURES_MAX) break;
        const v = own(o, key);
        if (!isObj(v)) continue;
        if (key.endsWith('Texture') && isIndex(v.index, textureCount)) {
          out.push({ extension, key: capString(key, 128), texture: v.index });
        } else if (depth < EXT_WALK_DEPTH) {
          stack.push({ o: v, depth: depth + 1 });
        }
      }
    }
  }
  return out;
}

function readMesh(
  m: Obj,
  index: number,
  materialCount: number,
  accessorCount: number,
  viewCount: number,
  budget: { left: number; cap: string },
): { name: string; prims: PrimFacts[] } {
  const name = loaderName(m.name, `name:meshes[${index}]`);
  const prims = subArray(m.primitives, `shape:meshes[${index}].primitives`, budget);
  return {
    name,
    prims: prims.map((p, k) => {
      const detail = `ref:meshes[${index}].primitives[${k}]`;
      const attrs = p.attributes;
      if (!isObj(attrs)) refuse('invalid-model', detail + '.attributes');
      const keys = Object.keys(attrs);
      const uvSets: number[] = [];
      for (const key of keys) {
        reqIndex(attrs[key], accessorCount, detail + '.attributes');
        const uv = TEXCOORD_RE.exec(key);
        if (uv) uvSets.push(Number(uv[1]));
      }
      uvSets.sort((a, b) => a - b);
      optIndex(p.indices, accessorCount, detail + '.indices');
      if (p.targets !== undefined) {
        for (const t of subArray(p.targets, detail + '.targets')) {
          for (const key of Object.keys(t)) reqIndex(t[key], accessorCount, detail + '.targets');
        }
      }
      const mode = p.mode === undefined ? 4 : p.mode;
      if (typeof mode !== 'number' || !Number.isSafeInteger(mode) || mode < 0 || mode > 6) refuse('invalid-model', detail + '.mode');
      if (isObj(p.extensions)) {
        const draco = own(p.extensions, 'KHR_draco_mesh_compression');
        if (draco !== undefined) {
          if (!isObj(draco)) refuse('invalid-model', detail + '.draco');
          reqIndex(draco.bufferView, viewCount, detail + '.draco');
        }
      }
      return {
        material: optIndex(p.material, materialCount, detail + '.material'),
        mode,
        tangents: keys.includes('TANGENT'),
        vertexColors: keys.includes('COLOR_0'),
        normals: keys.includes('NORMAL'),
        uvSets,
      };
    }),
  };
}

/* ── derived answers ─────────────────────────────────────────────────────── */

/** Materials used by at least one default-scene Mesh primitive (instances
 *  counted), ascending — THE set N11 counts and the builder builds. */
export function buildableMaterialIndices(m: GltfModelReport): number[] {
  return m.materials.filter((mat) => mat.usage.primitives > 0).map((mat) => mat.index);
}

/** baseColor and emissive are colour (sRGB); the other slots are data. */
export function slotColorSpace(slot: GltfSlot): 'color' | 'data' {
  return slot === 'baseColor' || slot === 'emissive' ? 'color' : 'data';
}

/** The materials and certainty behind one predicted mesh name, or null. */
export function meshNameMaterials(
  m: GltfModelReport,
  name: string,
): { materials: readonly (number | null)[]; certain: boolean } | null {
  return m.meshNameIndex.get(name) ?? null;
}

/**
 * The loader-0.6 MIRROR names per material index: names that are certain,
 * usable (`isUsableMeshName`) and carried only by meshes of exactly that one
 * material (never a second material, never the default). In first scene
 * appearance order. An uncertain name is never mirrored: on 0.6 it could paint
 * the wrong mesh.
 */
export function mirrorNamesByMaterial(m: GltfModelReport): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const [name, e] of m.meshNameIndex) {
    if (!e.certain || !isUsableMeshName(name) || e.materials.length !== 1) continue;
    const mat = e.materials[0];
    if (mat === null) continue;
    const list = out.get(mat);
    if (list) list.push(name);
    else out.set(mat, [name]);
  }
  return out;
}

const FILE_EXTENSION: Readonly<Record<string, string>> = { png: '.png', jpeg: '.jpg', webp: '.webp' };

/** A file-name stem: letters, digits, `.`, `_`, `-` only, no `..`, trimmed of
 *  leading/trailing `-`/`.`, at most 48 code points. */
function fileStem(s: string): string {
  const cleaned = s
    .replace(/[^\p{L}\p{N}._-]/gu, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[-.]+|[-.]+$/g, '');
  return Array.from(cleaned).slice(0, 48).join('').replace(/[-.]+$/, '');
}

/**
 * The display file name for an extracted image (it becomes the Image node's
 * `fileName`): the image's name, else a texture's, else `<model>-image-<i>`,
 * cleaned to a safe stem, with the SNIFFED format's extension.
 */
export function gltfImageFileName(m: GltfModelReport, image: number, modelName: string): string {
  const img = isIndex(image, m.images.length) ? m.images[image] : null;
  const tex =
    m.textures.find((t) => t.extract.image === image && t.name) ??
    m.textures.find((t) => t.name && (t.sources.core === image || t.sources.webp === image || t.sources.avif === image));
  const modelStem = fileStem(modelName.split(/[/\\]/).pop()!.replace(/\.[^./\\]+$/, '')) || 'model';
  const stem = fileStem(img?.name || tex?.name || `${modelStem}-image-${image}`) || `image-${image}`;
  const ext = img ? (own(FILE_EXTENSION, img.format) as string | undefined) : undefined;
  return stem + (ext ?? '.bin');
}

/* ── the preview facts adapter ───────────────────────────────────────────── */

/**
 * What a loaded glTF preview mesh may KEEP about its model (`PreviewMesh.gltf`,
 * once `createPreviewMesh` computes it): the signature and, per usable
 * predicted mesh name, the glTF material indices of its primitives (the
 * default material left out, a name with none left out, at most
 * MAX_INVENTORY_MESHES names) and whether the name is certain. Strings and
 * numbers only — no view into the file survives.
 */
export interface GltfPreviewFacts {
  signature: readonly string[];
  meshMaterials: ReadonlyMap<string, { materials: readonly number[]; certain: boolean }>;
}

/**
 * The facts AND, when the reader refused, WHY — from the SAME `readGltfModel`
 * call, never a second parse. `undefined` for OBJ (not a glTF). The reason is
 * what the single-GLB export's availability line says (`gltfReadRefusal` on
 * PreviewMesh): an `external-data` .gltf can never be packed, everything else
 * reads as "could not be read".
 */
export function gltfPreviewFactsOrRefusal(
  bytes: Uint8Array,
  kind: 'obj' | 'glb' | 'gltf',
): { facts: GltfPreviewFacts } | { refusal: GltfReadRefusalReason } | undefined {
  if (kind !== 'glb' && kind !== 'gltf') return undefined;
  const r = readGltfModel(bytes, kind);
  if (!r.ok) return { refusal: r.refusal.reason };
  const meshMaterials = new Map<string, { materials: readonly number[]; certain: boolean }>();
  for (const [name, e] of r.model.meshNameIndex) {
    if (meshMaterials.size >= MAX_INVENTORY_MESHES) break;
    if (!isUsableMeshName(name)) continue;
    const materials = e.materials.filter((mat): mat is number => mat !== null);
    if (materials.length > 0) meshMaterials.set(name, { materials, certain: e.certain });
  }
  return { facts: { signature: r.model.signature.materials.slice(), meshMaterials } };
}

/** The facts for a model's bytes: undefined for OBJ (not a glTF), null when
 *  the reader refuses the file. A thin wrapper over the pair above. */
export function gltfPreviewFacts(bytes: Uint8Array, kind: 'obj' | 'glb' | 'gltf'): GltfPreviewFacts | null | undefined {
  const r = gltfPreviewFactsOrRefusal(bytes, kind);
  if (r === undefined) return undefined;
  return 'facts' in r ? r.facts : null;
}
