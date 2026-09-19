/**
 * Fixtures for the GLB import builder's suites (Phase 5 Step 8): three
 * hand-built GLBs in the shapes the research doc names — Blender-style,
 * scan-style and AI-style — plus a deterministic FAKE encoder, so the
 * builder's decisions run under node against a canvas that does not exist.
 *
 * A non-test module imported only by tests (the shaderloaderHarness.ts
 * precedent). The containers come from the ONE fixture set in test-utils.
 */
import { TRIANGLE_POSITIONS, jpegHeaderBytes, makeGlb, makeRealPng, pngHeaderBytes } from '@/test-utils';
import { readGltfModel, type GltfModelReport } from '@/utils/gltfReader';
import type { EncodeImageFn } from '@/utils/gltfTextureEncode';
import { MAX_IMAGE_ENCODED_CHARS, MAX_SOURCE_PIXELS } from '@/utils/imageNode';

type Doc = Record<string, unknown>;

const pad4 = (n: number) => (n + 3) & ~3;

/** bufferView 0 is the triangle, 1, 2, … the blobs (4-aligned). */
export function withBlobs(extra: Doc, blobs: Uint8Array[]): { doc: Doc; bin: Uint8Array } {
  const views: Doc[] = [{ buffer: 0, byteOffset: 0, byteLength: 36 }];
  let len = 36;
  for (const b of blobs) {
    const off = pad4(len);
    views.push({ buffer: 0, byteOffset: off, byteLength: b.length });
    len = off + b.length;
  }
  const bin = new Uint8Array(pad4(len));
  bin.set(TRIANGLE_POSITIONS);
  blobs.forEach((b, i) => bin.set(b, views[i + 1].byteOffset as number));
  return {
    doc: {
      asset: { version: '2.0' },
      buffers: [{ byteLength: bin.length }],
      bufferViews: views,
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
      ...extra,
    },
    bin,
  };
}

export function glbOf(extra: Doc, blobs: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const { doc, bin } = withBlobs(extra, blobs);
  return makeGlb(doc, bin);
}

export function readOk(bytes: Uint8Array, kind: 'glb' | 'gltf' = 'glb'): GltfModelReport {
  const r = readGltfModel(bytes, kind);
  if (!r.ok) throw new Error('refused: ' + JSON.stringify(r.refusal));
  return r.model;
}

/* ── the three model shapes ──────────────────────────────────────────────── */

/** Real, decodable PNGs (the reader sniffs the header; the fake encoder never
 *  decodes, but a real PNG keeps the fixtures honest for the strip tests). */
export const PNG_COLOR = makeRealPng(4, 4, [200, 120, 40, 255]);
export const PNG_ORM = makeRealPng(4, 2, [255, 128, 0, 255]);
export const PNG_NORMAL = makeRealPng(2, 2, [128, 128, 255, 255]);
export const PNG_EMISSIVE = makeRealPng(2, 2, [255, 255, 255, 255]);
/** A JPEG header only (node has no JPEG encoder; the fake encoder reads the
 *  header's dimensions from the reader, never the pixels). */
export const JPEG_COLOR = jpegHeaderBytes(1920, 1080);
/** A header-only PNG past the 64 MP decode guard (N10). */
export const PNG_HUGE = pngHeaderBytes(8193, 8193);

const LATVIAN_NAME = String.fromCharCode(0x0136, 0x0065, 0x0072, 0x006d, 0x0065, 0x006e, 0x0069, 0x0073); // Ķermenis

/**
 * BLENDER-STYLE: `Material.001` (base colour PNG, ORM PNG shared by
 * metallicRoughness AND occlusion, normal PNG, doubleSided, roughness 0.8),
 * `Material.002` (BLEND, base colour factor grey at alpha 0.5, the SAME ORM
 * texture, emissive factor + strength), a Latvian-named third material with
 * factors only; a two-primitive mesh `Cube` on a node named `Cube` (a Group
 * plus `Cube_1`/`Cube_2` in the loader), no TANGENT anywhere, COLOR_0 on the
 * second primitive, `KHR_texture_transform` on the base colour slot.
 */
export function blenderGlb(): Uint8Array<ArrayBuffer> {
  return glbOf(
    {
      extensionsUsed: ['KHR_texture_transform', 'KHR_materials_emissive_strength'],
      images: [
        { bufferView: 1, mimeType: 'image/png', name: 'BaseColor' },
        { bufferView: 2, mimeType: 'image/png', name: 'ORM' },
        { bufferView: 3, mimeType: 'image/png', name: 'Normal' },
      ],
      samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }],
      textures: [
        { source: 0, sampler: 0, name: 'BaseColorTex' },
        { source: 1, sampler: 0, name: 'ORMTex' },
        { source: 2, sampler: 0, name: 'NormalTex' },
      ],
      materials: [
        {
          name: 'Material.001',
          pbrMetallicRoughness: {
            baseColorTexture: {
              index: 0,
              extensions: { KHR_texture_transform: { offset: [0.25, 0], scale: [2, 2] } },
            },
            metallicRoughnessTexture: { index: 1 },
            roughnessFactor: 0.8,
          },
          normalTexture: { index: 2, scale: 0.5 },
          occlusionTexture: { index: 1, strength: 1 },
          doubleSided: true,
        },
        {
          name: 'Material.002',
          pbrMetallicRoughness: {
            baseColorFactor: [0.5, 0.5, 0.5, 0.5],
            metallicRoughnessTexture: { index: 1 },
            metallicFactor: 0,
          },
          emissiveFactor: [1, 0.5, 0.25],
          extensions: { KHR_materials_emissive_strength: { emissiveStrength: 2 } },
          alphaMode: 'BLEND',
        },
        {
          name: LATVIAN_NAME,
          pbrMetallicRoughness: { baseColorFactor: [0.2, 0.6, 0.1, 1], metallicFactor: 0.25, roughnessFactor: 0.4 },
          alphaMode: 'MASK',
          alphaCutoff: 1.2,
        },
      ],
      meshes: [
        {
          name: 'Cube',
          primitives: [
            { attributes: { POSITION: 0, TEXCOORD_0: 0 }, material: 0 },
            { attributes: { POSITION: 0, TEXCOORD_0: 0, COLOR_0: 0 }, material: 1 },
          ],
        },
        { name: 'Plate', primitives: [{ attributes: { POSITION: 0 }, material: 2 }] },
      ],
      nodes: [{ name: 'Cube', mesh: 0 }, { name: 'Plate', mesh: 1 }],
      scenes: [{ nodes: [0, 1] }],
      scene: 0,
    },
    [PNG_COLOR, PNG_ORM, PNG_NORMAL],
  );
}

/**
 * SCAN-STYLE: three materials, each with its own JPEG base colour (header
 * only, 1920×1080), PNG normal and ORM, TANGENT present, one mesh per
 * material named after it.
 */
export function scanGlb(): Uint8Array<ArrayBuffer> {
  const names = ['Body', 'Base', 'Trim'];
  return glbOf(
    {
      images: [
        { bufferView: 1, mimeType: 'image/jpeg', name: 'Body_diffuse' },
        { bufferView: 2, mimeType: 'image/png', name: 'Body_normal' },
        { bufferView: 3, mimeType: 'image/png', name: 'Body_orm' },
        { bufferView: 4, mimeType: 'image/jpeg', name: 'Base_diffuse' },
        { bufferView: 5, mimeType: 'image/jpeg', name: 'Trim_diffuse' },
      ],
      textures: [{ source: 0 }, { source: 1 }, { source: 2 }, { source: 3 }, { source: 4 }],
      materials: [
        {
          name: names[0],
          pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicRoughnessTexture: { index: 2 } },
          normalTexture: { index: 1 },
        },
        { name: names[1], pbrMetallicRoughness: { baseColorTexture: { index: 3 } } },
        { name: names[2], pbrMetallicRoughness: { baseColorTexture: { index: 4 }, roughnessFactor: 0.5 } },
      ],
      meshes: names.map((n, i) => ({
        name: `${n}_mesh`,
        primitives: [{ attributes: { POSITION: 0, TANGENT: 0, TEXCOORD_0: 0 }, material: i }],
      })),
      nodes: names.map((n, i) => ({ name: n, mesh: i })),
      scenes: [{ nodes: [0, 1, 2] }],
      scene: 0,
    },
    [JPEG_COLOR, PNG_NORMAL, PNG_ORM, JPEG_COLOR, JPEG_COLOR],
  );
}

/**
 * AI-STYLE (Tripo/Meshy shape): unnamed mesh and node, one material with a
 * JPEG base colour, PNG metallicRoughness and PNG normal (TANGENT present),
 * `texCoord: 1` on the metallicRoughness slot, an emissive texture whose
 * factor is 0 (the `emissiveUnused` report), `KHR_materials_emissive_strength`
 * and a clearcoat extension (reported, never imported); plus a second,
 * UNUSED material and a KTX2-only texture nothing reaches.
 */
export function aiGlb(): Uint8Array<ArrayBuffer> {
  return glbOf(
    {
      extensionsUsed: ['KHR_materials_emissive_strength', 'KHR_materials_clearcoat'],
      images: [
        { bufferView: 1, mimeType: 'image/jpeg' },
        { bufferView: 2, mimeType: 'image/png' },
        { bufferView: 3, mimeType: 'image/png' },
        { bufferView: 4, mimeType: 'image/png' },
      ],
      samplers: [{ wrapS: 33071, wrapT: 33071, magFilter: 9728 }],
      textures: [{ source: 0, sampler: 0 }, { source: 1 }, { source: 2 }, { source: 3 }],
      materials: [
        {
          pbrMetallicRoughness: {
            baseColorTexture: { index: 0 },
            metallicRoughnessTexture: { index: 1, texCoord: 1 },
            metallicFactor: 0.5,
          },
          normalTexture: { index: 2 },
          emissiveTexture: { index: 3 },
          emissiveFactor: [0, 0, 0],
          extensions: {
            KHR_materials_emissive_strength: { emissiveStrength: 3 },
            KHR_materials_clearcoat: { clearcoatFactor: 1 },
          },
        },
        { name: 'unused', pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1] } },
      ],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, TANGENT: 0, TEXCOORD_0: 0, TEXCOORD_1: 0 }, material: 0 }] }],
      nodes: [{ mesh: 0 }],
      scenes: [{ nodes: [0] }],
      scene: 0,
    },
    [JPEG_COLOR, PNG_ORM, PNG_NORMAL, PNG_EMISSIVE],
  );
}

/**
 * ONE material carrying ALL FOUR built texture slots, on ONE mesh — the
 * shortest model whose Output section wires five channels at once, so the
 * feeders' vertical order can be read against the node's rows without a shared
 * texture or a second section in the way (`feederOrder`, GLB owner fix
 * 2026-09-18). Both factors are non-default so each map arrives through a
 * Multiply, i.e. the chains have different lengths.
 */
export function allSlotsGlb(): Uint8Array<ArrayBuffer> {
  return glbOf(
    {
      images: [
        { bufferView: 1, mimeType: 'image/png', name: 'BaseColor' },
        { bufferView: 2, mimeType: 'image/png', name: 'ORM' },
        { bufferView: 3, mimeType: 'image/png', name: 'Normal' },
        { bufferView: 4, mimeType: 'image/png', name: 'Emissive' },
      ],
      textures: [{ source: 0 }, { source: 1 }, { source: 2 }, { source: 3 }],
      materials: [
        {
          name: 'Rich',
          pbrMetallicRoughness: {
            baseColorTexture: { index: 0 },
            metallicRoughnessTexture: { index: 1 },
            roughnessFactor: 0.8,
            metallicFactor: 0.4,
          },
          normalTexture: { index: 2 },
          emissiveTexture: { index: 3 },
          emissiveFactor: [1, 1, 1],
        },
      ],
      meshes: [{ name: 'Body', primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 0 }, material: 0 }] }],
      nodes: [{ name: 'Body', mesh: 0 }],
      scenes: [{ nodes: [0] }],
      scene: 0,
    },
    [PNG_COLOR, PNG_ORM, PNG_NORMAL, PNG_EMISSIVE],
  );
}

/** A model whose only material carries one 8193×8193 PNG (N10). */
export function hugeTextureGlb(): Uint8Array<ArrayBuffer> {
  return glbOf(
    {
      images: [{ bufferView: 1, mimeType: 'image/png', name: 'Huge' }],
      textures: [{ source: 0 }],
      materials: [{ name: 'Big', pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
      meshes: [{ name: 'M', primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
      nodes: [{ mesh: 0 }],
      scenes: [{ nodes: [0] }],
      scene: 0,
    },
    [PNG_HUGE],
  );
}

/** `n` materials, each with its own base colour PNG and its own mesh. */
export function manyMaterialsGlb(n: number): Uint8Array<ArrayBuffer> {
  const blobs = Array.from({ length: n }, (_, i) => makeRealPng(2, 2, [i * 10, 20, 30, 255]));
  return glbOf(
    {
      images: blobs.map((_, i) => ({ bufferView: i + 1, mimeType: 'image/png' })),
      textures: blobs.map((_, i) => ({ source: i })),
      materials: blobs.map((_, i) => ({ name: `Mat${i}`, pbrMetallicRoughness: { baseColorTexture: { index: i } } })),
      meshes: blobs.map((_, i) => ({ name: `Mesh${i}`, primitives: [{ attributes: { POSITION: 0 }, material: i }] })),
      nodes: blobs.map((_, i) => ({ mesh: i })),
      scenes: [{ nodes: blobs.map((_, i) => i) }],
      scene: 0,
    },
    blobs,
  );
}

/* ── the fake encoder ────────────────────────────────────────────────────── */

export interface FakeEncodeCall {
  name: string;
  ignoreLimits: boolean;
  deviceMaxDim: number;
  maxDim: number | undefined;
  preferLossless: boolean | undefined;
  losslessOnly: boolean | undefined;
  allowHugeSource: boolean | undefined;
  sourceDims: { width: number; height: number } | undefined;
}

export interface FakeEncoderOptions {
  /** Bytes per pixel of a lossy encode (default 0.25) and a lossless one (1). */
  lossyBytesPerPixel?: number;
  losslessBytesPerPixel?: number;
  /** Names (display file names) the encoder refuses, with the reason. */
  refuse?: Record<string, 'load' | 'pixels' | 'too-large'>;
}

function base64Of(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/**
 * A deterministic stand-in for `encodeImageFile`: the source size is the
 * header's (`sourceDims`, else 64×64), fitted to the tightest cap (the device
 * cap, relaxed to 2048 under ignore-limits, and the slot's `maxDim`), no
 * power-of-two snap, a WebP payload whose byte count follows the requested
 * class, `decodeDownscaled` past the 64 MP guard. Every call is recorded.
 */
export function fakeEncoder(calls: FakeEncodeCall[], o: FakeEncoderOptions = {}): EncodeImageFn {
  const lossyBpp = o.lossyBytesPerPixel ?? 0.25;
  const losslessBpp = o.losslessBytesPerPixel ?? 1;
  return async (file, ignoreLimits, deviceMaxDim, _mode, opts) => {
    calls.push({
      name: file.name,
      ignoreLimits,
      deviceMaxDim,
      maxDim: opts.maxDim,
      preferLossless: opts.preferLossless,
      losslessOnly: opts.losslessOnly,
      allowHugeSource: opts.allowHugeSource,
      sourceDims: opts.sourceDims,
    });
    const refused = o.refuse?.[file.name];
    if (refused) return { ok: false, reason: refused };
    const sw = opts.sourceDims?.width ?? 64;
    const sh = opts.sourceDims?.height ?? 64;
    const huge = sw * sh > MAX_SOURCE_PIXELS;
    if (huge && !opts.allowHugeSource && !ignoreLimits) return { ok: false, reason: 'pixels', width: sw, height: sh };
    const devCap = ignoreLimits ? Math.max(deviceMaxDim, 2048) : deviceMaxDim;
    const cap = Math.min(devCap, opts.maxDim ?? Infinity);
    const s = Math.min(1, cap / Math.max(sw, sh));
    const w = Math.max(1, Math.floor(sw * s));
    const h = Math.max(1, Math.floor(sh * s));
    const lossless = opts.losslessOnly === true || opts.preferLossless === true;
    const n = Math.max(3, Math.ceil(w * h * (lossless ? losslessBpp : lossyBpp)));
    const bytes = new Uint8Array(n);
    for (let i = 0; i < n; i++) bytes[i] = (i * 31 + w * 7 + h * 13) & 0xff;
    return {
      ok: true,
      dataUrl: `data:image/webp;base64,${base64Of(bytes)}`,
      mime: 'image/webp',
      webpAvailable: true,
      width: w,
      height: h,
      sourceWidth: sw,
      sourceHeight: sh,
      potApplied: false,
      preferLossless: opts.preferLossless === true || opts.losslessOnly === true,
      lossless,
      budgetScaled: false,
      losslessDropped: (opts.preferLossless === true || opts.losslessOnly === true) && !lossless,
      // The per-image budget the real encoder reports: read off the platform
      // table (Phase 6), never a literal — platformCaps.test.ts sweeps for one.
      budgetChars: MAX_IMAGE_ENCODED_CHARS,
      decodeDownscaled: huge && opts.allowHugeSource === true,
    };
  };
}

/** A stash that never touches IndexedDB: a fixed id per payload length. */
export function fakeStash(): (p: { dataUrl: string }) => string | null {
  return (p) => `0123456789abcdef${p.dataUrl.length.toString(16).padStart(8, '0')}`;
}
