/**
 * The trusted-side glTF model reader (`gltfReader.ts`). Every model byte here is
 * adversarial, so besides the rule-by-rule pins the whole suite runs with the
 * network and every decoder stubbed to THROW: `fetch`, `XMLHttpRequest`,
 * `Image`, `createImageBitmap` and `URL.createObjectURL`. A reader that touched
 * any of them would fail the test that did it (afterEach asserts none was
 * called). Stubs are undone with vi.unstubAllGlobals(); the suite runs
 * `isolate: false`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  GLTF_IMAGE_MAX_BYTES,
  buildableMaterialIndices,
  gltfImageFileName,
  gltfPreviewFacts,
  meshNameMaterials,
  mirrorNamesByMaterial,
  readGltfModel,
  slotColorSpace,
  type GltfModelReport,
  type GltfReadRefusal,
} from './gltfReader';
import { GLB_READ_MAX_BYTES, MESH_MAX_BYTES } from './gltfCompression';
import { encodeDataUri } from './glbContainer';
import { gltfTextureValues } from './imageUvMapping';
import { MAX_INVENTORY_MESHES } from './meshInventory';
import { modelSignatureMatches, sanitizeModelSignature } from '@/engine/materialPartsContract';
import {
  TRIANGLE_POSITIONS,
  gltfPrimitiveDoc,
  jpegHeaderBytes,
  ktx2HeaderBytes,
  makeGlb,
  makeRealPng,
  pngHeaderBytes,
  webpHeaderBytes,
} from '../test-utils';

/* ── the hostile environment ─────────────────────────────────────────────── */

const throwing = (what: string) => vi.fn(() => {
  throw new Error(`the reader touched ${what}`);
});
const NETWORK = {
  fetch: throwing('fetch'),
  XMLHttpRequest: throwing('XMLHttpRequest'),
  Image: throwing('Image'),
  createImageBitmap: throwing('createImageBitmap'),
};
let objectUrl: MockInstance;

beforeEach(() => {
  for (const [name, fn] of Object.entries(NETWORK)) {
    fn.mockClear();
    vi.stubGlobal(name, fn);
  }
  objectUrl = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
    throw new Error('the reader touched URL.createObjectURL');
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  expect(objectUrl).not.toHaveBeenCalled();
  objectUrl.mockRestore();
  for (const fn of Object.values(NETWORK)) expect(fn).not.toHaveBeenCalled();
});

/* ── fixtures ────────────────────────────────────────────────────────────── */

const pad4 = (n: number) => (n + 3) & ~3;

const BASE = {
  meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
  nodes: [{ mesh: 0 }],
  scenes: [{ nodes: [0] }],
  materials: [{ name: 'M' }],
};

/** The glTF document + BIN around TRIANGLE_POSITIONS: bufferView 0 is the
 *  triangle, 1, 2, … the blobs (4-aligned). `extra` keys replace BASE's. */
function parts(extra: Record<string, unknown> = {}, blobs: Uint8Array[] = []) {
  const views: Record<string, number>[] = [{ buffer: 0, byteOffset: 0, byteLength: 36 }];
  let len = 36;
  for (const b of blobs) {
    const off = pad4(len);
    views.push({ buffer: 0, byteOffset: off, byteLength: b.length });
    len = off + b.length;
  }
  const bin = new Uint8Array(pad4(len));
  bin.set(TRIANGLE_POSITIONS);
  blobs.forEach((b, i) => bin.set(b, views[i + 1].byteOffset));
  const doc = gltfPrimitiveDoc({ buffers: [{ byteLength: bin.length }], bufferViews: views, ...BASE, ...extra });
  return { doc, bin };
}

function glb(extra: Record<string, unknown> = {}, blobs: Uint8Array[] = []): Uint8Array<ArrayBuffer> {
  const { doc, bin } = parts(extra, blobs);
  return makeGlb(doc, bin);
}

function okModel(bytes: Uint8Array, kind: 'glb' | 'gltf' = 'glb'): GltfModelReport {
  const r = readGltfModel(bytes, kind);
  if (!r.ok) throw new Error('refused: ' + JSON.stringify(r.refusal));
  return r.model;
}

function refusalOf(bytes: Uint8Array, kind: 'glb' | 'gltf' = 'glb'): GltfReadRefusal | 'ok' {
  const r = readGltfModel(bytes, kind);
  return r.ok ? 'ok' : r.refusal;
}

const PNG = pngHeaderBytes(64, 32);
const JPEG = jpegHeaderBytes(40, 20);
const WEBP = webpHeaderBytes('VP8L', 16, 8);
const KTX2 = ktx2HeaderBytes(8, 8);
/** An ISO-BMFF `ftyp` box with the `avif` brand. */
const AVIF = new Uint8Array([
  0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66, 0, 0, 0, 0,
  0x61, 0x76, 0x69, 0x66, 0x6d, 0x69, 0x66, 0x31, 0x6d, 0x69, 0x61, 0x66,
]);

/** One texture per image, one image per blob. */
function texturedDoc(blobs: Uint8Array[], material: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return glb({
    images: blobs.map((_, i) => ({ bufferView: i + 1, mimeType: 'image/png' })),
    textures: blobs.map((_, i) => ({ source: i })),
    materials: [material],
    ...extra,
  }, blobs);
}

/* ── materials ───────────────────────────────────────────────────────────── */

describe('materials', () => {
  it('reads factors, clamps them, and falls back to defaults on junk', () => {
    const m = okModel(glb({
      materials: [
        {
          name: 'A',
          pbrMetallicRoughness: { baseColorFactor: ['1', 1, 1, 1], metallicFactor: 7, roughnessFactor: -2 },
          alphaMode: 'mask',
          alphaCutoff: 'x',
          emissiveFactor: [2, 0.5, -1],
        },
        {
          pbrMetallicRoughness: { baseColorFactor: [0.5, 2, -1, 0.25] },
          alphaMode: 'BLEND',
          alphaCutoff: 1.5,
          doubleSided: true,
        },
        { name: 7, pbrMetallicRoughness: 5, alphaMode: 'MASK', alphaCutoff: -3, doubleSided: 'yes' },
      ],
    }));
    const [a, b, c] = m.materials;
    expect(a).toMatchObject({
      index: 0, name: 'A', displayName: 'A', baseColorFactor: [1, 1, 1, 1], metallicFactor: 1,
      roughnessFactor: 0, alphaMode: 'OPAQUE', alphaCutoff: 0.5, emissiveFactor: [1, 0.5, 0],
      emissiveStrength: 1, doubleSided: false, unlit: false,
    });
    expect(b).toMatchObject({ name: '', baseColorFactor: [0.5, 1, 0, 0.25], alphaMode: 'BLEND', alphaCutoff: 1, doubleSided: true });
    expect(c).toMatchObject({ name: '', displayName: '', alphaMode: 'MASK', alphaCutoff: 0, doubleSided: false, metallicFactor: 1 });
  });

  it('reads emissive strength (bounded) and the unlit flag', () => {
    const m = okModel(glb({
      materials: [
        { extensions: { KHR_materials_emissive_strength: { emissiveStrength: 5 }, KHR_materials_unlit: {} } },
        { extensions: { KHR_materials_emissive_strength: { emissiveStrength: -1 } } },
        { extensions: { KHR_materials_emissive_strength: { emissiveStrength: 1e9 } } },
        { extensions: { KHR_materials_unlit: true } },
      ],
    }));
    expect(m.materials.map((x) => x.emissiveStrength)).toEqual([5, 1, 1e6, 1]);
    expect(m.materials.map((x) => x.unlit)).toEqual([true, false, false, false]);
  });

  it('lists the material extensions sorted and capped at 32', () => {
    const exts: Record<string, object> = {};
    for (let i = 39; i >= 0; i--) exts[`EXT_${String(i).padStart(2, '0')}`] = {};
    exts['BAD\u0001NAME'] = {};
    const m = okModel(glb({ materials: [{ extensions: exts }] }));
    expect(m.materials[0].extensions).toHaveLength(32);
    expect(m.materials[0].extensions[0]).toBe('EXT_00');
    expect(m.materials[0].extensions[31]).toBe('EXT_31');
  });

  it('reports textures referenced from inside material extensions, bounded in depth', () => {
    const m = okModel(texturedDoc([PNG, PNG], {
      extensions: {
        KHR_materials_clearcoat: { clearcoatFactor: 1, clearcoatTexture: { index: 0 }, clearcoatNormalTexture: { index: 1 } },
        KHR_materials_sheen: { sheenColorTexture: { index: 0 } },
        KHR_materials_broken: { brokenTexture: { index: 99 } },
        KHR_materials_deep: { a: { b: { c: { d: { e: { farTexture: { index: 0 } } } } } } },
      },
    }));
    expect(m.materials[0].unsupportedTextures).toEqual(expect.arrayContaining([
      { extension: 'KHR_materials_clearcoat', key: 'clearcoatTexture', texture: 0 },
      { extension: 'KHR_materials_clearcoat', key: 'clearcoatNormalTexture', texture: 1 },
      { extension: 'KHR_materials_sheen', key: 'sheenColorTexture', texture: 0 },
    ]));
    expect(m.materials[0].unsupportedTextures).toHaveLength(3);
  });

  it('keeps the RAW name for the signature and a clean one for display', () => {
    const long = 'n'.repeat(100);
    const m = okModel(glb({ materials: [{ name: 'Body' }, {}, { name: long }, { name: 'a\u0007b' }] }));
    expect(m.signature.materials).toEqual(['Body', '', long, 'a\u0007b']);
    expect(m.materials.map((x) => x.displayName)).toEqual(['Body', '', 'n'.repeat(64), '']);
  });
});

/* ── slots and textureInfo ───────────────────────────────────────────────── */

describe('slots and textureInfo', () => {
  it('reads the five core slots, with normal scale and occlusion strength', () => {
    const m = okModel(texturedDoc([PNG, PNG], {
      pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicRoughnessTexture: { index: 1 } },
      normalTexture: { index: 1, scale: 0.5 },
      occlusionTexture: { index: 1, strength: 3 },
      emissiveTexture: { index: 0 },
    }));
    const slots = m.materials[0].slots;
    expect(slots.map((s) => s.slot)).toEqual(['baseColor', 'metallicRoughness', 'normal', 'occlusion', 'emissive']);
    expect(slots.find((s) => s.slot === 'normal')?.scale).toBe(0.5);
    expect(slots.find((s) => s.slot === 'occlusion')?.strength).toBe(1);
    expect(slots.map((s) => slotColorSpace(s.slot))).toEqual(['color', 'data', 'data', 'data', 'color']);
  });

  const TRANSFORMED = {
    index: 0,
    texCoord: 1,
    extensions: { KHR_texture_transform: { offset: [0.1, 0.2], rotation: 0.5, scale: [2, 3], texCoord: 1, extras: { x: 1 } } },
  };

  it('copies KHR_texture_transform only when extensionsUsed lists it (GLTFLoader parity)', () => {
    const unlisted = okModel(texturedDoc([PNG], { pbrMetallicRoughness: { baseColorTexture: TRANSFORMED } }));
    expect(unlisted.materials[0].slots[0].textureInfo).toEqual({ index: 0, texCoord: 1 });
    const listed = okModel(texturedDoc([PNG], { pbrMetallicRoughness: { baseColorTexture: TRANSFORMED } }, {
      extensionsUsed: ['KHR_texture_transform'],
    }));
    expect(listed.materials[0].slots[0].textureInfo).toEqual({
      index: 0,
      texCoord: 1,
      extensions: { KHR_texture_transform: { offset: [0.1, 0.2], rotation: 0.5, scale: [2, 3], texCoord: 1 } },
    });
  });

  it('passes gltfTextureValues unchanged: the same answer as the raw file\'s textureInfo', () => {
    const listed = okModel(texturedDoc([PNG], { pbrMetallicRoughness: { baseColorTexture: TRANSFORMED } }, {
      extensionsUsed: ['KHR_texture_transform'],
    }));
    const fromReader = gltfTextureValues(listed.materials[0].slots[0].textureInfo, { normalGreenFlip: false });
    const fromFile = gltfTextureValues(TRANSFORMED, { normalGreenFlip: false });
    expect(fromReader).toEqual(fromFile);
    expect(fromReader.unsupported).toEqual([]);
  });

  it('drops a texCoord outside 0..31 and a malformed transform field, with warnings', () => {
    const m = okModel(texturedDoc([PNG], {
      pbrMetallicRoughness: {
        baseColorTexture: { index: 0, texCoord: 40, extensions: { KHR_texture_transform: { offset: [1], rotation: 0.25 } } },
      },
    }, { extensionsUsed: ['KHR_texture_transform'] }));
    expect(m.materials[0].slots[0].textureInfo).toEqual({ index: 0, extensions: { KHR_texture_transform: { rotation: 0.25 } } });
    expect(m.warnings).toEqual(expect.arrayContaining(['texcoord', 'texture-transform']));
  });

  it('refuses a slot that is not an object or points past the textures', () => {
    expect(refusalOf(texturedDoc([PNG], { pbrMetallicRoughness: { baseColorTexture: 5 } }))).toEqual({
      reason: 'invalid-model', detail: 'ref:materials[0].baseColor',
    });
    expect(refusalOf(texturedDoc([PNG], { normalTexture: { index: 3 } }))).toEqual({
      reason: 'invalid-model', detail: 'ref:materials[0].normal',
    });
  });
});

/* ── samplers and texture sources ────────────────────────────────────────── */

describe('samplers', () => {
  it('keeps the known enums, junk → null filters and REPEAT wraps', () => {
    const m = okModel(glb({
      samplers: [{ magFilter: 1, minFilter: 9987, wrapS: 'x', wrapT: 33648 }, { magFilter: 9728, minFilter: 42 }, {}],
    }));
    expect(m.samplers).toEqual([
      { magFilter: null, minFilter: 9987, wrapS: 10497, wrapT: 33648 },
      { magFilter: 9728, minFilter: null, wrapS: 10497, wrapT: 10497 },
      { magFilter: null, minFilter: null, wrapS: 10497, wrapT: 10497 },
    ]);
  });
});

describe('texture source resolution', () => {
  const doc = (blobs: Uint8Array[], texture: Record<string, unknown>) => glb({
    images: blobs.map((_, i) => ({ bufferView: i + 1 })),
    textures: [texture],
  }, blobs);

  it('webp + core → webp', () => {
    const m = okModel(doc([PNG, WEBP], { source: 0, extensions: { EXT_texture_webp: { source: 1 } } }));
    expect(m.textures[0].extract).toEqual({ status: 'ok', image: 1 });
    expect(m.textures[0].sources).toEqual({ core: 0, webp: 1, avif: null, basisu: null });
  });

  it('basisu (KTX2 bytes) + core PNG → core', () => {
    const m = okModel(doc([PNG, KTX2], { source: 0, extensions: { KHR_texture_basisu: { source: 1 } } }));
    expect(m.textures[0].extract).toEqual({ status: 'ok', image: 0 });
    expect(m.images[1].status).toBe('unsupported-format');
  });

  it('avif + core → core', () => {
    const m = okModel(doc([PNG, AVIF], { source: 0, extensions: { EXT_texture_avif: { source: 1 } } }));
    expect(m.images[1].format).toBe('avif');
    expect(m.textures[0].extract).toEqual({ status: 'ok', image: 0 });
  });

  it('KTX2 only → ktx2-only; nothing at all → no-readable-source', () => {
    expect(okModel(doc([KTX2], { extensions: { KHR_texture_basisu: { source: 0 } } })).textures[0].extract)
      .toEqual({ status: 'ktx2-only', image: null });
    expect(okModel(doc([PNG], {})).textures[0].extract).toEqual({ status: 'no-readable-source', image: null });
  });

  it('refuses an out-of-range or malformed source', () => {
    expect(refusalOf(doc([PNG], { source: 4 }))).toMatchObject({ reason: 'invalid-model' });
    expect(refusalOf(doc([PNG], { source: 0, extensions: { EXT_texture_webp: { source: 9 } } }))).toMatchObject({ reason: 'invalid-model' });
    expect(refusalOf(doc([PNG], { source: 0, extensions: { EXT_texture_webp: 3 } }))).toMatchObject({ reason: 'invalid-model' });
  });
});

/* ── images ──────────────────────────────────────────────────────────────── */

describe('images', () => {
  it('hands out a VIEW of the input, never a copy, with sniffed dimensions', () => {
    const bytes = glb({ images: [{ bufferView: 1, name: 'Albedo' }] }, [PNG]);
    const img = okModel(bytes).images[0];
    expect(img).toMatchObject({ status: 'ok', format: 'png', mime: 'image/png', width: 64, height: 32, name: 'Albedo' });
    expect(img.bytes!.buffer).toBe(bytes.buffer);
    expect([...img.bytes!]).toEqual([...PNG]);
  });

  it('trusts the sniff over the declared type and flags the mismatch', () => {
    const img = okModel(glb({ images: [{ bufferView: 1, mimeType: 'image/png' }] }, [JPEG])).images[0];
    expect(img).toMatchObject({ status: 'ok', format: 'jpeg', mime: 'image/jpeg', declaredMime: 'image/png', mimeMismatch: true, width: 40, height: 20 });
  });

  it('reports a URI image as external — absolute or relative — and never fetches it', () => {
    const m = okModel(glb({ images: [{ uri: 'https://x.example/y.png' }, { uri: 'tex.png' }] }));
    expect(m.images.map((i) => i.status)).toEqual(['external', 'external']);
    expect(m.images.every((i) => i.bytes === null)).toBe(true);
  });

  it('decodes a data: image in a .gltf; non-canonical base64 is damaged', () => {
    const doc = gltfPrimitiveDoc({
      ...BASE,
      buffers: [{ byteLength: 36, uri: encodeDataUri('application/octet-stream', TRIANGLE_POSITIONS) }],
      images: [{ uri: encodeDataUri('image/png', PNG) }, { uri: 'data:image/png;base64,QR==' }, { uri: 'data:text/plain;base64,QQ==' }],
    });
    const m = okModel(new TextEncoder().encode(JSON.stringify(doc)), 'gltf');
    expect(m.kind).toBe('gltf');
    expect(m.images.map((i) => i.status)).toEqual(['ok', 'damaged', 'damaged']);
    expect(m.images[0]).toMatchObject({ width: 64, height: 32 });
  });

  it('refuses an image over 64 MiB as too-large without reading it', () => {
    const size = GLTF_IMAGE_MAX_BYTES + 1;
    const binLength = pad4(36 + size);
    const doc = gltfPrimitiveDoc({
      ...BASE,
      buffers: [{ byteLength: binLength }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: size }],
      images: [{ bufferView: 1, mimeType: 'image/png' }],
    });
    // One allocation: the container written by hand around an untouched BIN.
    const json = new TextEncoder().encode(JSON.stringify(doc));
    const jsonLen = pad4(json.length);
    const total = 20 + jsonLen + 8 + binLength;
    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, 0x46546c67, true);
    dv.setUint32(4, 2, true);
    dv.setUint32(8, total, true);
    dv.setUint32(12, jsonLen, true);
    dv.setUint32(16, 0x4e4f534a, true);
    out.fill(0x20, 20, 20 + jsonLen);
    out.set(json, 20);
    dv.setUint32(20 + jsonLen, binLength, true);
    dv.setUint32(24 + jsonLen, 0x004e4942, true);
    out.set(TRIANGLE_POSITIONS, 28 + jsonLen);
    const img = okModel(out).images[0];
    expect(img).toMatchObject({ status: 'too-large', bytes: null, byteLength: size });
  });

  it('marks an image in a meshopt-compressed view as compressed-view', () => {
    const { doc, bin } = parts({
      extensionsUsed: ['EXT_meshopt_compression'],
      buffers: [{ byteLength: 64 }, { byteLength: 16, extensions: { EXT_meshopt_compression: { fallback: true } } }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 36 },
        { buffer: 1, byteLength: 16, extensions: { EXT_meshopt_compression: { buffer: 0, byteOffset: 36, byteLength: 16, byteStride: 4, count: 4, mode: 'ATTRIBUTES' } } },
      ],
      images: [{ bufferView: 1, mimeType: 'image/png' }],
    });
    const padded = new Uint8Array(64);
    padded.set(bin.subarray(0, 36));
    const m = okModel(makeGlb(doc, padded));
    expect(m.images[0]).toMatchObject({ status: 'compressed-view', bytes: null });
    expect(m.compression.needs.meshopt).toBe(true);
  });

  it('keeps the bytes of an unsupported format but never calls it ok', () => {
    const img = okModel(glb({ images: [{ bufferView: 1 }, {}] }, [KTX2])).images;
    expect(img[0]).toMatchObject({ status: 'unsupported-format', format: 'ktx2', mime: null });
    expect(img[0].bytes).not.toBeNull();
    expect(img[1]).toMatchObject({ status: 'damaged', bytes: null });
  });
});

/* ── buffers and views ───────────────────────────────────────────────────── */

describe('buffers and bufferViews', () => {
  it('refuses an external buffer as external-data', () => {
    expect(refusalOf(glb({ buffers: [{ byteLength: 36, uri: 'model.bin' }] }))).toEqual({ reason: 'external-data', detail: 'buffer:0' });
  });

  it('refuses a view past the BIN end', () => {
    expect(refusalOf(glb({
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 1000 }],
    }))).toEqual({ reason: 'invalid-model', detail: 'ref:bufferViews[1]' });
  });

  it('accepts overlapping image and accessor views', () => {
    const m = okModel(glb({
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 0, byteLength: 36 }],
      images: [{ bufferView: 1 }],
    }));
    expect(m.images[0].status).toBe('unsupported-format');
  });

  it('refuses a GLB whose buffer 0 has no BIN chunk, and a uri-less buffer that is no fallback', () => {
    const { doc } = parts();
    expect(refusalOf(makeGlb(doc))).toEqual({ reason: 'invalid-model', detail: 'buffer:0' });
    expect(refusalOf(glb({ buffers: [{ byteLength: 36 }, { byteLength: 4 }] }))).toEqual({ reason: 'invalid-model', detail: 'buffer:1' });
  });

  it('refuses a data: buffer that is not canonical base64 as unreadable', () => {
    const doc = gltfPrimitiveDoc({ ...BASE, buffers: [{ byteLength: 36, uri: 'data:application/octet-stream;base64,QR==' }] });
    expect(refusalOf(new TextEncoder().encode(JSON.stringify(doc)), 'gltf')).toEqual({ reason: 'unreadable', detail: 'buffer:0' });
  });
});

/* ── caps and shapes ─────────────────────────────────────────────────────── */

describe('caps and shapes', () => {
  it('refuses over-cap arrays as too-complex, never truncating', () => {
    expect(refusalOf(glb({ nodes: new Array(65537).fill({}) }))).toEqual({ reason: 'too-complex', detail: 'cap:nodes' });
    expect(refusalOf(glb({ materials: new Array(1025).fill({}) }))).toEqual({ reason: 'too-complex', detail: 'cap:materials' });
    const prims = new Array(131073).fill({ attributes: { POSITION: 0 } });
    expect(refusalOf(glb({ meshes: [{ primitives: prims }, { primitives: prims }] }))).toEqual({ reason: 'too-complex', detail: 'cap:primitives' });
  });

  it('refuses a signature the editor could not store', () => {
    expect(refusalOf(glb({ materials: [{ name: 'n'.repeat(1025) }] }))).toEqual({ reason: 'too-complex', detail: 'signature-name' });
    expect(refusalOf(glb({ materials: new Array(70).fill({ name: 'n'.repeat(1000) }) }))).toEqual({ reason: 'too-complex', detail: 'signature-total' });
  });

  it('refuses a default scene that would hold too many Mesh objects', () => {
    const prims = new Array(1000).fill({ attributes: { POSITION: 0 } });
    const nodes = new Array(300).fill({ mesh: 0 });
    expect(refusalOf(glb({ meshes: [{ primitives: prims }], nodes, scenes: [{ nodes: nodes.map((_, i) => i) }] })))
      .toEqual({ reason: 'too-complex', detail: 'cap:sceneMeshes' });
  });

  it('refuses a top-level key that is not an array of objects', () => {
    expect(refusalOf(glb({ meshes: {} }))).toEqual({ reason: 'invalid-model', detail: 'shape:meshes' });
    expect(refusalOf(glb({ nodes: [1] }))).toEqual({ reason: 'invalid-model', detail: 'shape:nodes[0]' });
  });

  it('refuses a missing or pre-2.0 asset', () => {
    for (const asset of [undefined, {}, { version: '1.0' }, { version: '10.0' }, { version: 2 }]) {
      expect(refusalOf(glb({ asset }))).toEqual({ reason: 'invalid-model', detail: 'asset' });
    }
    expect(refusalOf(glb({ asset: { version: '2.1' } }))).toBe('ok');
  });
});

/* ── prototype keys ──────────────────────────────────────────────────────── */

describe('prototype keys', () => {
  it('reads a file carrying __proto__ / constructor keys and pollutes nothing', () => {
    const jsonText = '{"__proto__":{"polluted":1},"constructor":{"x":1},"asset":{"version":"2.0"},' +
      '"buffers":[{"byteLength":36}],"bufferViews":[{"buffer":0,"byteLength":36}],' +
      '"accessors":[{"bufferView":0,"componentType":5126,"count":3,"type":"VEC3"}],' +
      '"materials":[{"name":"constructor","__proto__":{"polluted":1}},{"name":"toString"},{"name":"__proto__"}],' +
      '"textures":[{"__proto__":{}}],' +
      '"meshes":[{"primitives":[{"attributes":{"POSITION":0},"material":0}]}],' +
      '"nodes":[{"mesh":0}],"scenes":[{"nodes":[0]}]}';
    const m = okModel(makeGlb({ jsonText }, TRIANGLE_POSITIONS));
    expect(m.signature.materials).toEqual(['constructor', 'toString', '__proto__']);
    expect(m.textures[0].extract.status).toBe('no-readable-source');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')).toBe(false);
  });
});

/* ── invalid models ──────────────────────────────────────────────────────── */

describe('invalid models (stricter than GLTFLoader on purpose)', () => {
  const cases: [string, Record<string, unknown>, string][] = [
    ['a numeric node name', { nodes: [{ name: 5, mesh: 0 }] }, 'name:nodes[0]'],
    ['a numeric mesh name', { meshes: [{ name: 5, primitives: [{ attributes: { POSITION: 0 } }] }] }, 'name:meshes[0]'],
    ['a cycle', { nodes: [{ children: [1] }, { children: [0] }, { mesh: 0 }], scenes: [{ nodes: [2] }] }, 'cycle'],
    ['a node with two parents', { nodes: [{ children: [2] }, { children: [2] }, { mesh: 0 }], scenes: [{ nodes: [0, 1] }] }, 'parents:node 2'],
    ['a node that is its own child', { nodes: [{ mesh: 0, children: [0] }] }, 'ref:nodes[0].children'],
    ['a scene root with a parent', { nodes: [{ children: [1] }, { mesh: 0 }], scenes: [{ nodes: [0, 1] }] }, 'scene-root:1'],
    ['no scene', { scenes: undefined }, 'no-scene'],
    ['scene 5 of 1', { scene: 5 }, 'no-scene'],
    ['primitive mode 9', { meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 9 }] }] }, 'ref:meshes[0].primitives[0].mode'],
    ['an attribute past the accessors', { meshes: [{ primitives: [{ attributes: { POSITION: 3 } }] }] }, 'ref:meshes[0].primitives[0].attributes'],
    ['a node on a camera without parameters', { nodes: [{ mesh: 0, camera: 0 }], cameras: [{ type: 'perspective' }] }, 'camera:0'],
    ['a camera of an unknown type', { cameras: [{ type: 'fisheye', fisheye: {} }] }, 'camera:0'],
    ['a light of an unknown type', { extensions: { KHR_lights_punctual: { lights: [{ type: 'area' }] } } }, 'light:0'],
    ['a numeric light name', { extensions: { KHR_lights_punctual: { lights: [{ type: 'point', name: 3 }] } } }, 'name:lights[0]'],
    ['a skin without joints', { skins: [{}] }, 'ref:skins[0].joints'],
    ['a channel on a missing sampler', {
      animations: [{ samplers: [], channels: [{ sampler: 0, target: { node: 0 } }] }],
    }, 'ref:animations[0].channels[0].sampler'],
    ['a bad reference in an UNUSED material', {
      materials: [{ name: 'M' }, { normalTexture: { index: 0 } }],
    }, 'ref:materials[1].normal'],
  ];
  for (const [what, extra, detail] of cases) {
    it(what, () => {
      expect(refusalOf(glb(extra))).toEqual({ reason: 'invalid-model', detail });
    });
  }

  it('accepts falsy non-string names, as the loader does', () => {
    expect(refusalOf(glb({ nodes: [{ name: 0, mesh: 0 }], meshes: [{ name: null, primitives: [{ attributes: { POSITION: 0 } }] }] }))).toBe('ok');
  });
});

/* ── usage ───────────────────────────────────────────────────────────────── */

describe('usage', () => {
  it('counts default-scene Mesh primitives only, instances included', () => {
    const m = okModel(glb({
      materials: [{ name: 'A' }, { name: 'B' }, { name: 'C' }],
      meshes: [
        {
          primitives: [
            { attributes: { POSITION: 0, NORMAL: 0, TANGENT: 0, TEXCOORD_0: 0, TEXCOORD_1: 0 }, material: 0 },
            { attributes: { POSITION: 0, COLOR_0: 0, TEXCOORD_1: 0 }, material: 0 },
            { attributes: { POSITION: 0 }, material: 2, mode: 0 },
          ],
        },
        { primitives: [{ attributes: { POSITION: 0 }, material: 1 }] },
      ],
      nodes: [{ mesh: 0 }, { mesh: 0 }, { mesh: 1 }],
      scenes: [{ nodes: [0, 1] }, { nodes: [2] }],
    }));
    expect(m.materials[0].usage).toEqual({ primitives: 4, withTangents: 2, withVertexColors: 2, withoutNormals: 2, uvSets: [1] });
    expect(m.materials[1].usage.primitives).toBe(0);
    expect(m.materials[2].usage.primitives).toBe(0);
    expect(buildableMaterialIndices(m)).toEqual([0]);
  });
});

/* ── size ────────────────────────────────────────────────────────────────── */

describe('size', () => {
  it('refuses from the length alone, before any parse', () => {
    // All zeros: had the container been parsed first this would be glb:magic.
    expect(refusalOf(new Uint8Array(GLB_READ_MAX_BYTES + 1))).toEqual({ reason: 'too-large', detail: 'size' });
    expect(refusalOf(new Uint8Array(MESH_MAX_BYTES + 1), 'gltf')).toEqual({ reason: 'too-large', detail: 'size' });
  });

  it('never throws on junk input', () => {
    expect(readGltfModel(new Uint8Array(0), 'glb').ok).toBe(false);
    expect(readGltfModel(new Uint8Array([1, 2, 3]), 'gltf').ok).toBe(false);
    expect(readGltfModel('x' as unknown as Uint8Array, 'glb')).toEqual({ ok: false, refusal: { reason: 'unreadable', detail: 'input' } });
    expect(refusalOf(new TextEncoder().encode('[1,2]'), 'gltf')).toEqual({ reason: 'unreadable', detail: 'json' });
    // Valid but deeply nested: the reviver's recursion may overflow, and
    // either way the root is not an object.
    expect(refusalOf(new TextEncoder().encode('['.repeat(100000) + ']'.repeat(100000)), 'gltf')).toEqual({ reason: 'unreadable', detail: 'json' });
  });
});

/* ── the signature ───────────────────────────────────────────────────────── */

describe('signature', () => {
  it('is the raw names in order, and passes the editor sanitizer as the SAME object', () => {
    const m = okModel(glb({ materials: [{ name: 'Body' }, {}, { name: 'Glass' }, { name: 'Body' }] }));
    expect(m.signature).toEqual({ materials: ['Body', '', 'Glass', 'Body'] });
    expect(sanitizeModelSignature(m.signature)).toBe(m.signature);
    expect(modelSignatureMatches(m.signature, { materials: ['Body', '', 'Glass', 'Body'] })).toBe(true);
  });
});

/* ── derived answers ─────────────────────────────────────────────────────── */

describe('mesh names, mirrors and the preview facts', () => {
  const prim = (material?: number) => ({ attributes: { POSITION: 0 }, ...(material !== undefined ? { material } : {}) });
  const MODEL = () => glb({
    materials: [{ name: 'Body' }, { name: 'Glass' }, {}],
    meshes: [
      { name: 'Body', primitives: [prim(0)] },
      { name: 'Glass', primitives: [prim(1)] },
      { name: 'Car', primitives: [prim(0), prim(2)] },
      { name: 'X', primitives: [prim(0), prim(1)] },
      { name: 'X_1', primitives: [prim(2)] },
      { name: 'Plain', primitives: [prim()] },
      { name: 'U', primitives: [prim(0)] },
      { name: 'U', primitives: [prim(1)] },
      { name: 'bad\u0001name', primitives: [prim(0)] },
    ],
    nodes: [0, 1, 2, 3, 4, 5, 6, 7, 8].map((mesh) => ({ mesh })),
    scenes: [{ nodes: [0, 1, 2, 3, 4, 5, 6, 7, 8] }],
  });

  it('indexes every predicted name with its materials and certainty', () => {
    const m = okModel(MODEL());
    expect(meshNameMaterials(m, 'Car')).toEqual({ materials: [0], certain: true });
    expect(meshNameMaterials(m, 'Car_1')).toEqual({ materials: [2], certain: true });
    expect(meshNameMaterials(m, 'X_1')).toEqual({ materials: [1, 2], certain: true });
    expect(meshNameMaterials(m, 'Plain')).toEqual({ materials: [null], certain: true });
    expect(meshNameMaterials(m, 'U')?.certain).toBe(false);
    expect(meshNameMaterials(m, 'nope')).toBeNull();
    expect(m.meshNameIndex).toBeInstanceOf(Map);
  });

  it('mirrors only certain, usable, single-material names', () => {
    expect(mirrorNamesByMaterial(okModel(MODEL()))).toEqual(new Map([
      [0, ['Body', 'Car', 'X']],
      [1, ['Glass']],
      [2, ['Car_1']],
    ]));
  });

  it('gltfPreviewFacts: the P5d fixture', () => {
    const bytes = glb({
      materials: [{ name: 'Body' }, { name: 'Glass' }, {}],
      meshes: [
        { name: 'Body', primitives: [prim(0)] },
        { name: 'Glass', primitives: [prim(1)] },
        { name: 'Car', primitives: [prim(0), prim(2)] },
      ],
      nodes: [{ mesh: 0 }, { mesh: 1 }, { mesh: 2 }],
      scenes: [{ nodes: [0, 1, 2] }],
    });
    const facts = gltfPreviewFacts(bytes, 'glb')!;
    expect(facts.signature).toEqual(['Body', 'Glass', '']);
    expect([...facts.meshMaterials]).toEqual([
      ['Body', { materials: [0], certain: true }],
      ['Glass', { materials: [1], certain: true }],
      ['Car', { materials: [0], certain: true }],
      ['Car_1', { materials: [2], certain: true }],
    ]);
  });

  it('gltfPreviewFacts drops default-material, unusable names; OBJ → undefined; refusal → null', () => {
    const facts = gltfPreviewFacts(MODEL(), 'glb')!;
    expect(facts.meshMaterials.has('Plain')).toBe(false);
    expect(facts.meshMaterials.has('bad\u0001name')).toBe(false);
    expect(facts.meshMaterials.get('X_1')).toEqual({ materials: [1, 2], certain: true });
    expect(gltfPreviewFacts(new TextEncoder().encode('v 0 0 0'), 'obj')).toBeUndefined();
    expect(gltfPreviewFacts(new Uint8Array(4), 'glb')).toBeNull();
  });

  it('gltfPreviewFacts caps the names and keeps no view of the file', () => {
    const meshes = Array.from({ length: 300 }, (_, i) => ({ name: `m${i}`, primitives: [prim(0)] }));
    const bytes = glb({ meshes, nodes: meshes.map((_, i) => ({ mesh: i })), scenes: [{ nodes: meshes.map((_, i) => i) }] });
    const facts = gltfPreviewFacts(bytes, 'glb')!;
    expect(facts.meshMaterials.size).toBe(MAX_INVENTORY_MESHES);
    const seen: unknown[] = [facts.signature, ...facts.meshMaterials.values()];
    for (const v of seen) {
      expect(ArrayBuffer.isView(v)).toBe(false);
      for (const inner of Object.values(v as object)) expect(ArrayBuffer.isView(inner)).toBe(false);
    }
  });
});

describe('gltfImageFileName', () => {
  it('names an image by its name, a texture name, or the model stem, with the SNIFFED extension', () => {
    const m = okModel(glb({
      images: [
        { bufferView: 1, name: 'Diffuse Map!' },
        { bufferView: 2, name: 'Ādas tekstūra' },
        { bufferView: 3 },
        { bufferView: 1 },
        { bufferView: 1, name: 'a..b' + 'x'.repeat(60) },
      ],
      textures: [{ source: 2, name: 'albedo' }],
    }, [PNG, JPEG, WEBP]));
    expect(gltfImageFileName(m, 0, 'scan.glb')).toBe('Diffuse-Map.png');
    expect(gltfImageFileName(m, 1, 'scan.glb')).toBe('Ādas-tekstūra.jpg');
    expect(gltfImageFileName(m, 2, 'scan.glb')).toBe('albedo.webp');
    expect(gltfImageFileName(m, 3, 'My Model.glb')).toBe('My-Model-image-3.png');
    const capped = gltfImageFileName(m, 4, 'm.glb');
    expect(capped.startsWith('a.b')).toBe(true);
    expect(capped.length).toBe(48 + '.png'.length);
    expect(gltfImageFileName(m, 99, 'm.glb')).toBe('m-image-99.bin');
  });
});

/* ── real pixels ─────────────────────────────────────────────────────────── */

describe('a real, decodable PNG', () => {
  it('reads as ok with its true dimensions (the bytes a build would extract)', () => {
    const png = makeRealPng(3, 5, [255, 0, 0, 255]);
    const img = okModel(glb({ images: [{ bufferView: 1, mimeType: 'image/png' }], textures: [{ source: 0 }] }, [png])).images[0];
    expect(img).toMatchObject({ status: 'ok', width: 3, height: 5, byteLength: png.length });
  });
});

/* ── source pins ─────────────────────────────────────────────────────────── */

describe('source pins', () => {
  const read = (f: string) => readFileSync(join(__dirname, f), 'utf8');

  it('the reader, the naming and the container never reach the network, a decoder or three', () => {
    for (const f of ['gltfReader.ts', 'gltfNaming.ts', 'glbContainer.ts']) {
      const src = read(f);
      for (const token of ['fetch(', 'new Image', 'createImageBitmap', 'XMLHttpRequest', 'createObjectURL', 'import(', "from 'three"]) {
        expect(src.includes(token), `${f}: ${token}`).toBe(false);
      }
    }
  });

  it('every JSON.parse( in the reader carries the reviver on the same line', () => {
    const lines = read('gltfReader.ts').split('\n').filter((l) => l.includes('JSON.parse('));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l).toContain('safeJsonReviver');
  });

  it('the model-reading graph stays acyclic: the reader never imports previewMesh, the naming imports nothing', () => {
    const imports = (f: string) => [...read(f).matchAll(/^import\s[^;]*?from\s+'([^']+)'/gms)].map((m) => m[1]);
    expect(imports('gltfReader.ts')).not.toContain('./previewMesh');
    expect(imports('gltfReader.ts')).toContain('./gltfCompression');
    expect(imports('gltfNaming.ts')).toEqual([]);
  });

  it('the reader owns no second signature sanitizer', () => {
    const src = read('gltfReader.ts');
    expect(src).not.toMatch(/function sanitizeModelSignature|function sameModelSignature|MATERIAL_BUILD_AVAILABLE/);
  });
});
