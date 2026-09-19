import { resolveObjectURL } from 'node:buffer';
import vm from 'node:vm';
import { crc32, deflateSync } from 'node:zlib';
import { vi } from 'vitest';
import type { AppNode, AppEdge } from '@/types';
import { encodeDataUri } from '@/utils/glbContainer';
import { fnv1a32Hex } from '@/utils/payloadDigest';
import { FS_EXTRAS_KEY, FS_EXTRAS_VERSION, FS_MODULE_MIME, FS_SCENE_MARKER } from '@/engine/glbShaderContract';

/**
 * Build a minimal AppNode for tests. Only the parts the engine reads (`id`,
 * `type`, `data.registryType`, `data.values`) are populated; we cast through
 * `unknown` to skip React Flow's full Node generic constraints. `type` mirrors
 * the production convention — `'output'` for the output node, `'shader'`
 * otherwise — so graphToCode's output-detection branch works in tests.
 */
export function makeNode(
  id: string,
  registryType: string,
  values: Record<string, string | number> = {},
): AppNode {
  return {
    id,
    type: registryType === 'output' ? 'output' : 'shader',
    position: { x: 0, y: 0 },
    data: { registryType, label: id, cost: 0, values },
  } as unknown as AppNode;
}

/**
 * Build a minimal AppEdge for tests. Matches the shape `TypedEdge` expects:
 * deterministic id, typed edge, `dataType: 'any'` payload.
 */
export function makeEdge(
  source: string,
  sourceHandle: string,
  target: string,
  targetHandle: string,
): AppEdge {
  return {
    id: `e-${source}-${sourceHandle}-${target}-${targetHandle}`,
    source,
    sourceHandle,
    target,
    targetHandle,
    type: 'typed',
    data: { dataType: 'any' },
  } as unknown as AppEdge;
}

/* ── glTF / GLB fixtures (the ONE set) ───────────────────────────────────── */

/*
 * Hand-built model bytes for the suites that read glTF on the trusted side
 * (the GLB container, the glTF reader and writer, the section builder, the
 * import dialog) and for the loader suites. Pure and three-free: a suite that
 * needs the REAL GLTFLoader builds its documents with `src/gltfTestFixtures.ts`,
 * whose container half is this `makeGlb`. Every builder returns fresh bytes, so
 * a test may corrupt its copy freely.
 */

// Arithmetic, never `(n + 3) & ~3`: a bitwise operator coerces through ToInt32,
// so that spelling returns a NEGATIVE length from 2**31 up. Harmless at fixture
// sizes, but it is the shape that made the repacker u32 overflow guard dead code.
const pad4 = (n: number) => Math.ceil(n / 4) * 4;

/**
 * A hand-built GLB (the research doc's §11 recipe): the 12-byte header (magic
 * 0x46546C67, version 2, total length), the JSON chunk (type 0x4E4F534A, padded
 * with 0x20 to 4 bytes) and, only when `bin` is given, the BIN chunk (type
 * 0x004E4942, padded with 0x00). An empty `bin` still writes a BIN chunk of
 * length 0.
 *
 * `doc` is stringified with JSON.stringify — unless it is `{ jsonText }`, whose
 * string goes into the JSON chunk VERBATIM, so a fuzz case can hand the reader
 * text that is not JSON at all.
 */
export function makeGlb(doc: object | { jsonText: string }, bin?: Uint8Array): Uint8Array<ArrayBuffer> {
  const raw = (doc as { jsonText?: unknown }).jsonText;
  const text = new TextEncoder().encode(typeof raw === 'string' ? raw : JSON.stringify(doc));
  const jsonLen = pad4(text.length);
  const binLen = bin ? pad4(bin.length) : 0;
  const total = 12 + 8 + jsonLen + (bin ? 8 + binLen : 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); // 'glTF'
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonLen, true);
  dv.setUint32(16, 0x4e4f534a, true); // 'JSON'
  out.fill(0x20, 20, 20 + jsonLen);
  out.set(text, 20);
  if (bin) {
    const at = 20 + jsonLen;
    dv.setUint32(at, binLen, true);
    dv.setUint32(at + 4, 0x004e4942, true); // 'BIN\0'
    out.set(bin, at + 8); // the zero padding is already there
  }
  return out;
}

/** A triangle: 36 bytes of float32 POSITION, (0,0,0) (1,0,0) (0,1,0) —
 *  bufferView 0 / accessor 0 of `gltfPrimitiveDoc`. Copy it, never mutate it. */
export const TRIANGLE_POSITIONS: Uint8Array = new Uint8Array(
  new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer,
);

/**
 * The glTF document around TRIANGLE_POSITIONS: `asset` 2.0, `buffers[0]` (36
 * bytes), `bufferViews[0]` and `accessors[0]` (a float VEC3 × 3 with min/max).
 * `extra` is spread over it, so a key it names REPLACES the base's — a fixture
 * that appends image bytes passes its own `buffers`/`bufferViews` (keeping
 * entry 0). Pair it with `makeGlb(doc, TRIANGLE_POSITIONS)`.
 */
export function gltfPrimitiveDoc(extra: object = {}): Record<string, unknown> {
  return {
    asset: { version: '2.0' },
    buffers: [{ byteLength: 36 }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
    ...extra,
  };
}

function u32be(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const body = new Uint8Array(4 + data.length);
  for (let i = 0; i < 4; i++) body[i] = type.charCodeAt(i);
  body.set(data, 4);
  const out = new Uint8Array(12 + data.length);
  out.set(u32be(data.length), 0);
  out.set(body, 4);
  out.set(u32be(crc32(body)), 8 + data.length);
  return out;
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function ihdr(w: number, h: number): Uint8Array {
  // RGBA8, deflate, adaptive filtering, no interlace.
  return pngChunk('IHDR', new Uint8Array([...u32be(w), ...u32be(h), 8, 6, 0, 0, 0]));
}

function checkDim(what: string, v: number, min: number, max: number): void {
  if (!Number.isInteger(v) || v < min || v > max) {
    throw new RangeError(`${what}: ${v} is not an integer in ${min}..${max}`);
  }
}

/**
 * The PNG signature and a real IHDR chunk (RGBA8, a true CRC) for `w` × `h`,
 * then `pad` zero bytes of filler — enough for a header-reading dimension probe
 * (IHDR at offset 12, width/height u32BE at 16/20), never decodable (no IDAT).
 * Any u32 is encodable, 0 included, so a test can probe a reader's own bounds.
 */
export function pngHeaderBytes(w: number, h: number, pad = 0): Uint8Array<ArrayBuffer> {
  checkDim('pngHeaderBytes width', w, 0, 0xffffffff);
  checkDim('pngHeaderBytes height', h, 0, 0xffffffff);
  return concatBytes([PNG_SIGNATURE, ihdr(w, h), new Uint8Array(pad)]);
}

/**
 * A REAL, decodable PNG: RGBA8, one unfiltered scanline per row, the pixels
 * deflated with zlib and every chunk carrying its true CRC. `rgba` is either
 * one RGBA colour (4 numbers, every pixel) or `w * h * 4` bytes, row-major.
 */
export function makeRealPng(w: number, h: number, rgba: ArrayLike<number>): Uint8Array<ArrayBuffer> {
  checkDim('makeRealPng width', w, 1, 0x7fffffff);
  checkDim('makeRealPng height', h, 1, 0x7fffffff);
  const oneColour = rgba.length === 4;
  if (!oneColour && rgba.length !== w * h * 4) {
    throw new RangeError(`makeRealPng: rgba has ${rgba.length} values, want 4 or ${w * h * 4}`);
  }
  const stride = 1 + w * 4;
  const raw = new Uint8Array(stride * h); // filter byte 0 (None) opens every row
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const src = oneColour ? 0 : (y * w + x) * 4;
      const dst = y * stride + 1 + x * 4;
      for (let c = 0; c < 4; c++) raw[dst + c] = rgba[src + c] & 0xff;
    }
  }
  return concatBytes([
    PNG_SIGNATURE,
    ihdr(w, h),
    pngChunk('IDAT', new Uint8Array(deflateSync(raw))),
    pngChunk('IEND', new Uint8Array(0)),
  ]);
}

/**
 * A JPEG up to its frame header: SOI, then `app1Bytes` of APP1 payload (split
 * into as many APP1 segments as 64 KiB segments need, so a test can push the
 * SOF past a reader's scan window), then a baseline SOF0 (8-bit, 3 components)
 * with height u16BE at SOF+5 and width at SOF+7, then EOI. Never decodable.
 */
export function jpegHeaderBytes(w: number, h: number, app1Bytes = 0): Uint8Array<ArrayBuffer> {
  checkDim('jpegHeaderBytes width', w, 0, 0xffff);
  checkDim('jpegHeaderBytes height', h, 0, 0xffff);
  checkDim('jpegHeaderBytes app1Bytes', app1Bytes, 0, 0x7fffffff);
  const parts: Uint8Array[] = [new Uint8Array([0xff, 0xd8])];
  const SEGMENT_PAYLOAD_MAX = 0xffff - 2; // the length field counts itself
  for (let left = app1Bytes; left > 0; left -= SEGMENT_PAYLOAD_MAX) {
    const n = Math.min(left, SEGMENT_PAYLOAD_MAX);
    const seg = new Uint8Array(4 + n);
    seg.set([0xff, 0xe1, ((n + 2) >> 8) & 0xff, (n + 2) & 0xff], 0);
    parts.push(seg);
  }
  parts.push(new Uint8Array([
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (h >> 8) & 0xff, h & 0xff, (w >> 8) & 0xff, w & 0xff,
    0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  ]));
  parts.push(new Uint8Array([0xff, 0xd9]));
  return concatBytes(parts);
}

/**
 * A RIFF/WEBP file holding only the first chunk's header fields:
 *   - `'VP8 '` (lossy): start code 9D 01 2A at 23, 14-bit width/height u16LE
 *     at 26/28 (0..16383);
 *   - `'VP8L'` (lossless): signature 0x2F at 20, then (w−1) and (h−1) packed as
 *     14 bits each from byte 21 (1..16384);
 *   - `'VP8X'` (extended): canvas (w−1) and (h−1) as u24LE at 24/27
 *     (1..16777216).
 * Never decodable.
 */
export function webpHeaderBytes(kind: 'VP8 ' | 'VP8L' | 'VP8X', w: number, h: number): Uint8Array<ArrayBuffer> {
  let payload: Uint8Array;
  if (kind === 'VP8 ') {
    checkDim('webpHeaderBytes VP8 width', w, 0, 0x3fff);
    checkDim('webpHeaderBytes VP8 height', h, 0, 0x3fff);
    payload = new Uint8Array([0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, w & 0xff, (w >> 8) & 0x3f, h & 0xff, (h >> 8) & 0x3f]);
  } else if (kind === 'VP8L') {
    checkDim('webpHeaderBytes VP8L width', w, 1, 0x4000);
    checkDim('webpHeaderBytes VP8L height', h, 1, 0x4000);
    // 14 bits of w−1, 14 bits of h−1, alpha 0, version 0 — little-endian.
    const bits = (w - 1) + (h - 1) * 0x4000;
    payload = new Uint8Array([0x2f, bits & 0xff, (bits >>> 8) & 0xff, (bits >>> 16) & 0xff, (bits >>> 24) & 0xff]);
  } else {
    checkDim('webpHeaderBytes VP8X width', w, 1, 0x1000000);
    checkDim('webpHeaderBytes VP8X height', h, 1, 0x1000000);
    const cw = w - 1;
    const ch = h - 1;
    payload = new Uint8Array([
      0x00, 0x00, 0x00, 0x00,
      cw & 0xff, (cw >> 8) & 0xff, (cw >> 16) & 0xff,
      ch & 0xff, (ch >> 8) & 0xff, (ch >> 16) & 0xff,
    ]);
  }
  const chunkLen = payload.length;
  const riffSize = 4 + 8 + chunkLen + (chunkLen & 1);
  const out = new Uint8Array(8 + riffSize);
  const dv = new DataView(out.buffer);
  out.set([0x52, 0x49, 0x46, 0x46], 0); // 'RIFF'
  dv.setUint32(4, riffSize, true);
  out.set([0x57, 0x45, 0x42, 0x50], 8); // 'WEBP'
  for (let i = 0; i < 4; i++) out[12 + i] = kind.charCodeAt(i);
  dv.setUint32(16, chunkLen, true);
  out.set(payload, 20);
  return out;
}

/**
 * A KTX2 header for `w` × `h`: the 12-byte identifier, then the 48-byte header
 * fields (pixelWidth u32LE at 20, pixelHeight at 24, one face, one level,
 * vkFormat 0 as Basis files use) and an all-zero 32-byte index. No level data,
 * so never decodable.
 */
export function ktx2HeaderBytes(w: number, h: number): Uint8Array<ArrayBuffer> {
  checkDim('ktx2HeaderBytes width', w, 0, 0xffffffff);
  checkDim('ktx2HeaderBytes height', h, 0, 0xffffffff);
  const out = new Uint8Array(80);
  const dv = new DataView(out.buffer);
  out.set([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  dv.setUint32(12, 0, true); // vkFormat
  dv.setUint32(16, 1, true); // typeSize
  dv.setUint32(20, w, true);
  dv.setUint32(24, h, true);
  dv.setUint32(36, 1, true); // faceCount
  dv.setUint32(40, 1, true); // levelCount
  return out;
}

/* ── FastShaders single-GLB fixtures (Phase 7) ───────────────────────────── */

/*
 * Hand-built FastShaders GLBs for the writer, the trusted readers, the loader
 * and podest's twin — the ONE set, fed by engine/glbShaderContract.ts so a
 * fixture cannot drift from the schema it exercises. Tests never write GLBs
 * to disk. Three-free: a suite that needs the real GLTFLoader hands
 * `makeFastShadersGlb(…).buffer` to `parseAsync`.
 */

/** `parts` laid out 4-byte aligned and zero padded, as GLB practice wants. */
export function packBinViews(parts: readonly Uint8Array[]): {
  bin: Uint8Array<ArrayBuffer>;
  views: { byteOffset: number; byteLength: number }[];
} {
  const views: { byteOffset: number; byteLength: number }[] = [];
  let length = 0;
  for (const p of parts) {
    const byteOffset = pad4(length);
    views.push({ byteOffset, byteLength: p.length });
    length = byteOffset + p.length;
  }
  const bin = new Uint8Array(pad4(length));
  parts.forEach((p, i) => bin.set(p, views[i].byteOffset));
  return { bin, views };
}

/** `data:<mime>;base64,<canonical>` — the one spelling of a canonical src (glbContainer's encodeDataUri). */
export function canonicalSrc(mime: string, bytes: Uint8Array): string {
  return encodeDataUri(mime, bytes);
}

/** A RIFF/WEBP header for `w` × `h` (lossless = VP8L), zero-padded to at least 64 bytes. Never decodable. */
export function fakeWebp(w: number, h: number, lossless: boolean): Uint8Array<ArrayBuffer> {
  const head = webpHeaderBytes(lossless ? 'VP8L' : 'VP8 ', w, h);
  if (head.length >= 64) return head;
  const out = new Uint8Array(64);
  out.set(head);
  return out;
}

/** A comment line the default fixture module carries, so a test can assert its ABSENCE after a drop. */
export const FS_FIXTURE_MODULE_MARKER = '__FS_EMBEDDED_MARKER__';
/** The default module text of `makeFastShadersGlb`: a valid loader module with a default export. */
export const FS_FIXTURE_MODULE =
  `import { vec3 } from 'three/tsl';\n// ${FS_FIXTURE_MODULE_MARKER}\n` +
  'export default function () {\n  return { colorNode: vec3(1, 0, 0) };\n}\n';

export type FsFixtureAssetMime = 'image/png' | 'image/jpeg' | 'image/webp';
export interface FsFixtureView {
  byteLength: number;
  byteOffset: number;
  buffer: number;
  byteStride: number;
  target: number;
  extensions: object;
}

/**
 * What `makeFastShadersGlb` / `makeFastShadersGltfJson` build. Defaults give a
 * well-formed format-1 file: materials `['Body', 'Glass']`, one single-triangle
 * mesh + node per material (both named `Mesh<i>`), `FS_FIXTURE_MODULE` in a
 * BIN view with its true `fnv1a`, no project, no assets, the scene marker on
 * scene 0. Every `*Entry` / `*View` / `extras` field is a VERBATIM override
 * for malformed rows; `json` is the last-word mutation hook.
 *
 * BIN layout: the triangle (view 0), the assets in key order (views 1..n), the
 * module (view n+1, when on the BIN), the project (the next view). With
 * `moduleBuffer: 'data-uri' | 'external'` the module rides `buffers[1]`
 * instead and its view is appended LAST.
 */
export interface FsGlbFixture {
  materials?: string[];
  /** UTF-8 text or raw bytes; null → no `module` key and no module view. */
  module?: string | Uint8Array | null;
  /** The project view's text (usually `embedProjectState('', p).trim()`); null (default) → none. */
  project?: string | Uint8Array | null;
  /** Override `module.fnv1a` (null → omit the key); default = the module text's digest. */
  fnv1a?: string | null;
  /** Verbatim override of `extras.fastshaders.module`. */
  moduleEntry?: unknown;
  /** Verbatim override of `extras.fastshaders.project`. */
  projectEntry?: unknown;
  /** Keys spread over the module's bufferView def (a stride, a target, an extension, a wrong length…). */
  moduleView?: Partial<FsFixtureView>;
  projectView?: Partial<FsFixtureView>;
  /** Where the module bytes live: the BIN (default), a `data:` buffer, or an external URL nothing may fetch. */
  moduleBuffer?: 'bin' | 'data-uri' | 'external';
  /** Embedded images, written as bufferView images in key order. */
  assets?: Record<string, { mime: FsFixtureAssetMime; bytes: Uint8Array }>;
  /** Verbatim override of `extras.fastshaders.assets`. */
  assetsEntry?: unknown;
  /** Leave the `assets` key out (a module-only file). */
  omitAssets?: boolean;
  /** Also wire that asset's image as material 0's baseColorTexture. */
  textureFromAsset?: string;
  /** Verbatim override of `json.extras`; `omitExtras` leaves the root key out. */
  extras?: unknown;
  omitExtras?: boolean;
  /** Verbatim override of `scenes[0].extras`; `omitSceneExtras` leaves it out. */
  sceneExtras?: unknown;
  omitSceneExtras?: boolean;
  /** Mutate the finished document before it is serialised. */
  json?: (doc: Record<string, unknown>) => void;
}

function fsGlbParts(o: FsGlbFixture): { doc: Record<string, unknown>; bin: Uint8Array<ArrayBuffer> } {
  const materials = o.materials ?? ['Body', 'Glass'];
  const enc = new TextEncoder();
  const moduleSrc = o.module === undefined ? FS_FIXTURE_MODULE : o.module;
  const moduleBytes = moduleSrc === null ? null : typeof moduleSrc === 'string' ? enc.encode(moduleSrc) : moduleSrc;
  const projectSrc = o.project ?? null;
  const projectBytes = projectSrc === null ? null : typeof projectSrc === 'string' ? enc.encode(projectSrc) : projectSrc;
  const assets = o.assets ?? {};
  const assetKeys = Object.keys(assets);
  const moduleBuffer = o.moduleBuffer ?? 'bin';
  const moduleOnBin = moduleBytes !== null && moduleBuffer === 'bin';

  const parts: Uint8Array[] = [TRIANGLE_POSITIONS];
  for (const k of assetKeys) parts.push(assets[k].bytes);
  if (moduleOnBin) parts.push(moduleBytes as Uint8Array);
  if (projectBytes !== null) parts.push(projectBytes);
  const { bin, views } = packBinViews(parts);
  const bufferViews: Record<string, unknown>[] = views.map((v) => ({ buffer: 0, ...v }));
  const buffers: Record<string, unknown>[] = [{ byteLength: bin.length }];

  const images: Record<string, unknown>[] = [];
  const imageIndexOf = new Map<string, number>();
  assetKeys.forEach((k, i) => {
    images.push({ bufferView: 1 + i, mimeType: assets[k].mime });
    imageIndexOf.set(k, i);
  });
  let next = 1 + assetKeys.length;
  let moduleViewIndex: number | null = null;
  if (moduleOnBin) moduleViewIndex = next++;
  const projectViewIndex = projectBytes !== null ? next++ : null;
  if (moduleBytes !== null && !moduleOnBin) {
    buffers.push(
      moduleBuffer === 'data-uri'
        ? { byteLength: moduleBytes.length, uri: encodeDataUri('application/octet-stream', moduleBytes) }
        : { byteLength: moduleBytes.length, uri: 'https://blocked.test/module.bin' },
    );
    bufferViews.push({ buffer: 1, byteOffset: 0, byteLength: moduleBytes.length });
    moduleViewIndex = bufferViews.length - 1;
  }
  if (moduleViewIndex !== null && o.moduleView) {
    bufferViews[moduleViewIndex] = { ...bufferViews[moduleViewIndex], ...o.moduleView };
  }
  if (projectViewIndex !== null && o.projectView) {
    bufferViews[projectViewIndex] = { ...bufferViews[projectViewIndex], ...o.projectView };
  }

  const materialDefs: Record<string, unknown>[] = materials.map((name) => ({ name, pbrMetallicRoughness: {} }));
  const doc: Record<string, unknown> = {
    asset: { version: '2.0' },
    buffers,
    bufferViews,
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
    materials: materialDefs,
    meshes: materials.map((_, i) => ({ name: `Mesh${i}`, primitives: [{ attributes: { POSITION: 0 }, material: i }] })),
    nodes: materials.map((_, i) => ({ name: `Mesh${i}`, mesh: i })),
    scenes: [{ nodes: materials.map((_, i) => i) }],
    scene: 0,
  };
  if (images.length > 0) doc.images = images;
  if (o.textureFromAsset !== undefined) {
    const img = imageIndexOf.get(o.textureFromAsset);
    if (img === undefined) throw new Error(`textureFromAsset: no asset named ${o.textureFromAsset}`);
    doc.textures = [{ source: img }];
    (materialDefs[0].pbrMetallicRoughness as Record<string, unknown>).baseColorTexture = { index: 0 };
  }

  const assetsMap: Record<string, number> = {};
  for (const k of assetKeys) assetsMap[k] = imageIndexOf.get(k) as number;
  const fs: Record<string, unknown> = { v: FS_EXTRAS_VERSION };
  if (!o.omitAssets) fs.assets = o.assetsEntry !== undefined ? o.assetsEntry : assetsMap;
  if (o.moduleEntry !== undefined) {
    fs.module = o.moduleEntry;
  } else if (moduleViewIndex !== null) {
    const entry: Record<string, unknown> = { bufferView: moduleViewIndex, mimeType: FS_MODULE_MIME };
    const digest =
      o.fnv1a === undefined
        ? fnv1a32Hex(typeof moduleSrc === 'string' ? moduleSrc : new TextDecoder().decode(moduleBytes as Uint8Array))
        : o.fnv1a;
    if (digest !== null) entry.fnv1a = digest;
    fs.module = entry;
  }
  if (o.projectEntry !== undefined) fs.project = o.projectEntry;
  else if (projectViewIndex !== null) fs.project = { bufferView: projectViewIndex };
  if (!o.omitExtras) doc.extras = o.extras !== undefined ? o.extras : { [FS_EXTRAS_KEY]: fs };
  if (!o.omitSceneExtras) {
    (doc.scenes as Record<string, unknown>[])[0].extras =
      o.sceneExtras !== undefined ? o.sceneExtras : { [FS_EXTRAS_KEY]: { ...FS_SCENE_MARKER } };
  }
  o.json?.(doc);
  return { doc, bin };
}

/** A FastShaders `.glb` (see FsGlbFixture). */
export function makeFastShadersGlb(o: FsGlbFixture = {}): Uint8Array<ArrayBuffer> {
  const { doc, bin } = fsGlbParts(o);
  return makeGlb(doc, bin);
}

/**
 * The SAME document with every `"fastshaders"` key written as a JSON escape
 * (`"fastshaders"`) — the text sniff's adversary, and the reason the
 * readers answer `\u00` as well as the literal spelling. `JSON.parse` still
 * yields the key, so the document is byte-for-byte equivalent to a reader
 * that parses it. BOTH occurrences are escaped (root extras and the scene
 * marker): escaping only one leaves the literal sniff alive on the other.
 */
export function makeFastShadersGlbEscapedKey(o: FsGlbFixture = {}): Uint8Array<ArrayBuffer> {
  const { doc, bin } = fsGlbParts(o);
  // split/join, not `replaceAll` — the tsconfig lib is below ES2021.
  const jsonText = JSON.stringify(doc).split(`"${FS_EXTRAS_KEY}"`).join('"\\u0066astshaders"');
  return makeGlb({ jsonText }, bin);
}

/** The same document as an embedded `.gltf` text: the BIN inlined as a base64 `data:` buffer. */
export function makeFastShadersGltfJson(o: FsGlbFixture = {}): string {
  const { doc, bin } = fsGlbParts(o);
  (doc.buffers as Record<string, unknown>[])[0].uri = encodeDataUri('application/octet-stream', bin);
  return JSON.stringify(doc);
}

/**
 * The repacker's BASE: a plain model with one single-triangle mesh + node per
 * material (`Mesh<i>`), no FastShaders extras. `textured` gives each material
 * its own real 2×2 PNG baseColorTexture (something for the strip to remove);
 * `extraBufferExt` puts an unknown extension on buffer 0 (the strip's 'kept'
 * mode / the repacker's unsupported-buffer-extension refusal); `kind: 'gltf'`
 * returns the `.gltf` text with a `data:` buffer.
 */
export function repackBaseGlb(opts: {
  materials: string[];
  textured?: boolean;
  kind?: 'glb' | 'gltf';
  extraBufferExt?: string;
}): Uint8Array<ArrayBuffer> {
  const parts: Uint8Array[] = [TRIANGLE_POSITIONS];
  const images: Record<string, unknown>[] = [];
  const textures: Record<string, unknown>[] = [];
  const materials = opts.materials.map((name, i) => {
    const pbr: Record<string, unknown> = {};
    if (opts.textured) {
      parts.push(makeRealPng(2, 2, [(i * 37) & 255, (i * 91) & 255, 128, 255]));
      images.push({ bufferView: parts.length - 1, mimeType: 'image/png', name: `tex${i}` });
      textures.push({ source: images.length - 1 });
      pbr.baseColorTexture = { index: textures.length - 1 };
    }
    return { name, pbrMetallicRoughness: pbr };
  });
  const { bin, views } = packBinViews(parts);
  const buffer0: Record<string, unknown> = { byteLength: bin.length };
  if (opts.extraBufferExt) buffer0.extensions = { [opts.extraBufferExt]: {} };
  const doc = gltfPrimitiveDoc({
    buffers: [buffer0],
    bufferViews: views.map((v) => ({ buffer: 0, ...v })),
    materials,
    meshes: materials.map((_, i) => ({ name: `Mesh${i}`, primitives: [{ attributes: { POSITION: 0 }, material: i }] })),
    nodes: materials.map((_, i) => ({ name: `Mesh${i}`, mesh: i })),
    scenes: [{ nodes: materials.map((_, i) => i) }],
    scene: 0,
    ...(images.length > 0 ? { images, textures } : {}),
    ...(opts.extraBufferExt ? { extensionsUsed: [opts.extraBufferExt] } : {}),
  });
  if ((opts.kind ?? 'glb') === 'gltf') {
    (doc.buffers as Record<string, unknown>[])[0].uri = encodeDataUri('application/octet-stream', bin);
    return new TextEncoder().encode(JSON.stringify(doc)) as Uint8Array<ArrayBuffer>;
  }
  return makeGlb(doc, bin);
}

/* ── three's blob Workers, KTX2 fixtures ─────────────────────────────────── */

/**
 * Live counts for the Workers `installInProcessWorker()` has constructed.
 * `live` drops on `terminate()`.
 */
export interface InProcessWorkerStats {
  created: number;
  live: number;
}

type WorkerMessage = { data: unknown };
type WorkerListener = (e: WorkerMessage) => void;
type WorkerErrorListener = (e: { message: string; error: unknown }) => void;

/**
 * Node has no `Worker`. This stubs one that runs the REAL worker source —
 * three builds its KTX2Loader and DRACOLoader workers from a `blob:` URL of the
 * transcoder/decoder wrapper text — in a fresh `node:vm` context, and
 * structured-clones every message both ways (transfer lists honoured), as a
 * real worker's postMessage does. Both listener styles work on both sides:
 * `addEventListener('message')` (three's WorkerPool, the KTX2 worker) and
 * `onmessage` (DRACOLoader, the Draco wrapper). Worker → main messages land on
 * a macrotask; main → worker ones wait until the source has evaluated.
 *
 * It is a `vi.stubGlobal`, so the caller MUST `vi.unstubAllGlobals()` in an
 * afterEach (`isolate: false` shares a worker's globals between files).
 */
export function installInProcessWorker(): InProcessWorkerStats {
  const stats: InProcessWorkerStats = { created: 0, live: 0 };

  class InProcessWorker {
    onmessage: WorkerListener | null = null;
    onerror: WorkerErrorListener | null = null;
    private readonly messageListeners = new Set<WorkerListener>();
    private readonly errorListeners = new Set<WorkerErrorListener>();
    private dead = false;
    private readonly scope: Promise<Record<string, unknown> | null>;

    constructor(url: string | URL) {
      stats.created++;
      stats.live++;
      const href = String(url);
      const blob = resolveObjectURL(href);
      this.scope = (blob ? blob.text() : Promise.reject(new Error(`InProcessWorker: no blob at ${href}`)))
        .then((src) => {
          const inbox = new Set<WorkerListener>();
          const scope: Record<string, unknown> = {
            console,
            setTimeout,
            clearTimeout,
            performance,
            TextDecoder,
            TextEncoder,
            importScripts() {},
            location: { href },
            onmessage: null,
            addEventListener(type: string, f: WorkerListener) {
              if (type === 'message') inbox.add(f);
            },
            removeEventListener(type: string, f: WorkerListener) {
              if (type === 'message') inbox.delete(f);
            },
            postMessage: (data: unknown, transfer?: Transferable[]) => {
              const copy = structuredClone(data, { transfer: transfer ?? [] });
              setTimeout(() => this.toMain(copy), 0);
            },
            close() {},
          };
          Object.defineProperty(scope, '__fsInbox', { value: inbox });
          vm.createContext(scope);
          // `self` must be the context's GLOBAL (it carries the builtins a
          // worker reads as self.Float32Array), not the sandbox object.
          vm.runInContext('this.self = this;', scope);
          vm.runInContext(src, scope, { filename: href });
          return scope;
        })
        .catch((error: unknown) => {
          setTimeout(() => this.fail(error), 0);
          return null;
        });
    }

    addEventListener(type: string, f: WorkerListener | WorkerErrorListener): void {
      if (type === 'message') this.messageListeners.add(f as WorkerListener);
      else if (type === 'error') this.errorListeners.add(f as WorkerErrorListener);
    }

    removeEventListener(type: string, f: WorkerListener | WorkerErrorListener): void {
      if (type === 'message') this.messageListeners.delete(f as WorkerListener);
      else if (type === 'error') this.errorListeners.delete(f as WorkerErrorListener);
    }

    postMessage(data: unknown, transfer?: Transferable[]): void {
      const copy = structuredClone(data, { transfer: transfer ?? [] });
      void this.scope.then((s) => {
        if (this.dead || !s) return;
        const e = { data: copy };
        for (const f of s.__fsInbox as Set<WorkerListener>) f(e);
        if (typeof s.onmessage === 'function') (s.onmessage as WorkerListener)(e);
      });
    }

    terminate(): void {
      if (!this.dead) stats.live--;
      this.dead = true;
    }

    private toMain(data: unknown): void {
      if (this.dead) return;
      const e = { data };
      for (const f of this.messageListeners) f(e);
      this.onmessage?.(e);
    }

    private fail(error: unknown): void {
      if (this.dead) return;
      const e = { message: error instanceof Error ? error.message : String(error), error };
      for (const f of this.errorListeners) f(e);
      this.onerror?.(e);
    }
  }

  vi.stubGlobal('Worker', InProcessWorker);
  return stats;
}

/** What r184's `Renderer.hasFeature` throws before `init()` has resolved (sic). */
export const HAS_FEATURE_BEFORE_INIT =
  'Renderer: .hasFeature() called before the backend is initialized. Use "await renderer.init();" before before using this method.';

/** The WebGL extension KTX2Loader's classic branch asks for, per WebGPU feature name. */
const GL_EXTENSION_FOR = new Map<string, string>([
  ['texture-compression-astc', 'WEBGL_compressed_texture_astc'],
  ['texture-compression-etc1', 'WEBGL_compressed_texture_etc1'],
  ['texture-compression-etc2', 'WEBGL_compressed_texture_etc'],
  ['texture-compression-s3tc', 'WEBGL_compressed_texture_s3tc'],
  ['texture-compression-bc', 'EXT_texture_compression_bptc'],
  ['texture-compression-pvrtc', 'WEBGL_compressed_texture_pvrtc'],
]);

export interface FakeWebGpuRenderer {
  readonly isWebGPURenderer: true;
  /** How many times `init()` was CALLED (the promise itself is memoized). */
  readonly initCalls: number;
  readonly initialized: boolean;
  init(): Promise<FakeWebGpuRenderer>;
  hasFeature(name: string): boolean;
}

export interface FakeWebGlRenderer {
  readonly isWebGPURenderer: false;
  readonly extensions: { has(name: string): boolean; get(name: string): object | null };
}

/**
 * A renderer as far as `KTX2Loader.detectSupport` can see one.
 *
 * - WebGPU (default): r184's `Renderer` shape — `init()` is memoized like
 *   `_initPromise` and resolves after a macrotask, and `hasFeature` THROWS
 *   r184's own error until it has. That throw is the whole reason the loader
 *   cannot call `detectSupport` at install time.
 * - `{ webgpu: false }`: a classic WebGLRenderer, `extensions.has`. Pass the
 *   same WebGPU feature names; they map to the extension KTX2Loader asks for
 *   (a raw extension name works too).
 */
export function fakeRenderer(features: readonly string[], opts: { webgpu: false }): FakeWebGlRenderer;
export function fakeRenderer(features: readonly string[], opts?: { webgpu?: true }): FakeWebGpuRenderer;
export function fakeRenderer(
  features: readonly string[],
  opts: { webgpu?: boolean } = {},
): FakeWebGpuRenderer | FakeWebGlRenderer {
  if (opts.webgpu === false) {
    const has = (name: string) =>
      features.includes(name) || features.some((f) => GL_EXTENSION_FOR.get(f) === name);
    // KTX2Loader also reads the ASTC extension's profiles (for UASTC HDR).
    const get = (name: string) =>
      !has(name) ? null : name === 'WEBGL_compressed_texture_astc' ? { getSupportedProfiles: () => ['ldr'] } : {};
    return { isWebGPURenderer: false, extensions: { has, get } };
  }
  let initCalls = 0;
  let initialized = false;
  let pending: Promise<FakeWebGpuRenderer> | null = null;
  const renderer: FakeWebGpuRenderer = {
    isWebGPURenderer: true,
    get initCalls() {
      return initCalls;
    },
    get initialized() {
      return initialized;
    },
    init() {
      initCalls++;
      pending ??= new Promise((resolve) =>
        setTimeout(() => {
          initialized = true;
          resolve(renderer);
        }, 0),
      );
      return pending;
    },
    hasFeature(name: string) {
      if (!initialized) throw new Error(HAS_FEATURE_BEFORE_INIT);
      return features.includes(name);
    },
  };
  return renderer;
}

/**
 * A `.glb` holding one quad whose base colour texture carries KHR_texture_basisu
 * → `ktx2` (images[0], a bufferView). With `fallbackPng` the texture also has a
 * core `source` (images[1]); `required` lists the extension in
 * extensionsRequired. The SAME layout as scripts/gen-ktx2-fixture-glbs.mjs —
 * `ktx2Transcode.test.ts` checks this reproduces the committed GLBs byte for
 * byte — so a test can vary one field and keep the rest.
 */
export function makeKtx2Glb(opts: { ktx2: Uint8Array; fallbackPng?: Uint8Array; required: boolean }): ArrayBuffer {
  const { ktx2, fallbackPng, required } = opts;
  const positions = new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]);
  const uvs = new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]);
  const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
  const parts: Uint8Array[] = [
    new Uint8Array(positions.buffer),
    new Uint8Array(uvs.buffer),
    new Uint8Array(indices.buffer),
    ktx2,
    ...(fallbackPng ? [fallbackPng] : []),
  ];
  const views: Array<{ offset: number; length: number }> = [];
  let at = 0;
  for (const p of parts) {
    at = pad4(at);
    views.push({ offset: at, length: p.length });
    at += p.length;
  }
  const binLength = at;
  const bin = new Uint8Array(pad4(binLength));
  parts.forEach((p, i) => bin.set(p, views[i].offset));

  const bufferViews = views.map((v, i) => ({
    buffer: 0,
    byteOffset: v.offset,
    byteLength: v.length,
    ...(i === 0 || i === 1 ? { target: 34962 } : i === 2 ? { target: 34963 } : {}),
  }));
  const json = {
    asset: { version: '2.0', generator: 'FastShaders scripts/gen-ktx2-fixture-glbs.mjs' },
    extensionsUsed: ['KHR_texture_basisu'],
    ...(required ? { extensionsRequired: ['KHR_texture_basisu'] } : {}),
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'quad', mesh: 0 }],
    meshes: [{ name: 'quad', primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, material: 0 }] }],
    materials: [{ name: 'ktx2', pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0 } }],
    textures: [
      fallbackPng
        ? { source: 1, extensions: { KHR_texture_basisu: { source: 0 } } }
        : { extensions: { KHR_texture_basisu: { source: 0 } } },
    ],
    images: [
      { name: '2d_uastc', bufferView: 3, mimeType: 'image/ktx2' },
      ...(fallbackPng ? [{ name: 'magenta', bufferView: 4, mimeType: 'image/png' }] : []),
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [-0.5, -0.5, 0], max: [0.5, 0.5, 0] },
      { bufferView: 1, componentType: 5126, count: 4, type: 'VEC2' },
      { bufferView: 2, componentType: 5123, count: 6, type: 'SCALAR' },
    ],
    bufferViews,
    buffers: [{ byteLength: binLength }],
  };

  return makeGlb(json, bin).buffer;
}
