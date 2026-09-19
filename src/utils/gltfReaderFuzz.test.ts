/**
 * A seeded mutation fuzz of the trusted-side glTF reader AND the texture-strip
 * writer it feeds (`gltfStrip.ts`). Six valid fixtures, 400 mutations each, in
 * two families:
 *
 *   - BYTE-level: bit flips in the first 64 bytes, and u32 overwrites of the
 *     container's length and chunk fields from {0, 1, 3, 0x7fffffff,
 *     0xffffffff, len±1};
 *   - JSON-level: one value somewhere in the document replaced by a hostile
 *     one, the container rebuilt with makeGlb.
 *
 * Every case must come back ok or refused — never thrown, never the
 * unforeseen-error detail `internal` — within 50 ms, and an ok report must be
 * self-consistent: image bytes inside the input (or inside a decoded buffer),
 * every index in range, every name a string, `meshNameIndex` a Map. And the
 * writer must hold on it: stripping the buildable materials either has nothing
 * to do (a null plan) or yields a copy that re-reads with the same signature.
 * Object.prototype must be untouched afterwards. The seed is fixed and printed
 * with every failure.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  GLTF_IMAGE_MAX_BYTES,
  buildableMaterialIndices,
  gltfPreviewFacts,
  mirrorNamesByMaterial,
  readGltfModel,
  type GltfModelReport,
} from './gltfReader';
import { encodeDataUri } from './glbContainer';
import { planTextureStrip, stripGltfTextures } from './gltfStrip';
import { modelSignatureMatches } from '@/engine/materialPartsContract';
import { safeJsonReviver } from './safeJson';
import { TRIANGLE_POSITIONS, gltfPrimitiveDoc, jpegHeaderBytes, makeGlb, makeRealPng, webpHeaderBytes } from '../test-utils';

const SEED = 0x5eed1234;
const ROUNDS = 400;
const CASE_MS = 50;

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Arithmetic, never `(n + 3) & ~3`: a bitwise operator coerces through ToInt32,
// so that spelling returns a NEGATIVE length from 2**31 up. Harmless at fixture
// sizes, but it is the shape that made the repacker u32 overflow guard dead code.
const pad4 = (n: number) => Math.ceil(n / 4) * 4;

/** bufferView 0 is the triangle, 1, 2, … the blobs. */
function withBlobs(extra: Record<string, unknown>, blobs: Uint8Array[]) {
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
  return { doc: gltfPrimitiveDoc({ buffers: [{ byteLength: bin.length }], bufferViews: views, ...extra }), bin };
}

interface Fixture {
  name: string;
  kind: 'glb' | 'gltf';
  doc: Record<string, unknown>;
  bin: Uint8Array | null;
}

const PNG_A = makeRealPng(2, 2, [200, 100, 50, 255]);
const PNG_B = makeRealPng(2, 2, [0, 128, 255, 255]);
const JPEG = jpegHeaderBytes(32, 16);
const WEBP = webpHeaderBytes('VP8 ', 16, 16);

function fixtures(): Fixture[] {
  const blender = withBlobs({
    extensionsUsed: ['KHR_texture_transform'],
    images: [{ bufferView: 1, mimeType: 'image/png', name: 'Base' }, { bufferView: 2, mimeType: 'image/png', name: 'ORM' }],
    samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }],
    textures: [{ source: 0, sampler: 0 }, { source: 1, sampler: 0 }],
    materials: [
      {
        name: 'Material.001',
        pbrMetallicRoughness: {
          baseColorTexture: { index: 0, extensions: { KHR_texture_transform: { offset: [0.1, 0], scale: [2, 2] } } },
          metallicRoughnessTexture: { index: 1 },
        },
        occlusionTexture: { index: 1 },
        alphaMode: 'BLEND',
      },
      { name: 'Material.002', doubleSided: true, pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1] } },
    ],
    meshes: [{
      name: 'Cube',
      primitives: [
        { attributes: { POSITION: 0, NORMAL: 0, TEXCOORD_0: 0 }, material: 0 },
        { attributes: { POSITION: 0, NORMAL: 0, TEXCOORD_0: 0 }, material: 1 },
      ],
    }],
    nodes: [{ name: 'Cube', mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  }, [PNG_A, PNG_B]);

  const scan = withBlobs({
    images: [{ bufferView: 1, mimeType: 'image/jpeg' }, { bufferView: 2, mimeType: 'image/png' }, { bufferView: 3, mimeType: 'image/png' }],
    textures: [{ source: 0 }, { source: 1 }, { source: 2 }],
    materials: [
      { name: 'Scan', pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicRoughnessTexture: { index: 2 } }, normalTexture: { index: 1, scale: 1 } },
      { name: 'Scan.001' },
    ],
    meshes: [{ name: 'Scan', primitives: [{ attributes: { POSITION: 0, NORMAL: 0, TANGENT: 0, TEXCOORD_0: 0 }, material: 0 }] }, { primitives: [{ attributes: { POSITION: 0 }, material: 1 }] }],
    nodes: [{ name: 'Scan', mesh: 0, children: [1] }, { mesh: 1 }],
    scenes: [{ nodes: [0] }],
  }, [JPEG, PNG_A, PNG_B]);

  const ai = withBlobs({
    extensionsUsed: ['EXT_texture_webp', 'KHR_materials_emissive_strength'],
    images: [{ bufferView: 1, mimeType: 'image/png' }, { bufferView: 2, mimeType: 'image/webp' }],
    textures: [{ source: 0, extensions: { EXT_texture_webp: { source: 1 } } }],
    materials: [{
      pbrMetallicRoughness: { baseColorTexture: { index: 0, texCoord: 1 } },
      emissiveTexture: { index: 0 },
      emissiveFactor: [0, 0, 0],
      extensions: { KHR_materials_emissive_strength: { emissiveStrength: 3 } },
    }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 0, TEXCOORD_1: 0 }, material: 0 }] }],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
  }, [PNG_A, WEBP]);

  const instanced = withBlobs({
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 0, componentType: 5126, count: 1, type: 'SCALAR', min: [0], max: [0] },
      { bufferView: 0, componentType: 5126, count: 1, type: 'VEC3' },
    ],
    materials: [{ name: 'Solo' }],
    meshes: [{ name: 'Solo', primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    cameras: [{ type: 'perspective', name: 'Cam', perspective: { yfov: 1, znear: 0.1 } }],
    extensions: { KHR_lights_punctual: { lights: [{ type: 'spot', name: 'Spot' }] } },
    skins: [{ joints: [2] }],
    animations: [{ samplers: [{ input: 1, output: 2 }], channels: [{ sampler: 0, target: { node: 4, path: 'translation' } }] }],
    nodes: [
      { name: 'Root', children: [1, 2, 3], skin: 0 },
      { mesh: 0 },
      { mesh: 0, camera: 0 },
      { name: 'Lamp', mesh: 0, extensions: { KHR_lights_punctual: { light: 0 } } },
      { name: 'Loose' },
    ],
    scenes: [{ name: 'Main', nodes: [0] }],
  }, []);

  const gltfDoc = gltfPrimitiveDoc({
    buffers: [{ byteLength: 36, uri: encodeDataUri('application/octet-stream', TRIANGLE_POSITIONS) }],
    images: [{ uri: encodeDataUri('image/png', PNG_A) }, { uri: 'external.png' }],
    textures: [{ source: 0 }, { source: 1 }],
    materials: [{ name: 'Embedded', pbrMetallicRoughness: { baseColorTexture: { index: 0 } }, emissiveTexture: { index: 1 } }],
    meshes: [{ name: 'Tri', primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
  });

  const meshoptBin = new Uint8Array(36 + pad4(PNG_A.length));
  meshoptBin.set(TRIANGLE_POSITIONS);
  meshoptBin.set(PNG_A, 36);
  const meshopt = gltfPrimitiveDoc({
    extensionsUsed: ['EXT_meshopt_compression'],
    buffers: [{ byteLength: meshoptBin.length }, { byteLength: 36, extensions: { EXT_meshopt_compression: { fallback: true } } }],
    bufferViews: [
      { buffer: 1, byteOffset: 0, byteLength: 36, byteStride: 12, extensions: { EXT_meshopt_compression: { buffer: 0, byteOffset: 0, byteLength: 36, byteStride: 12, count: 3, mode: 'ATTRIBUTES' } } },
      { buffer: 0, byteOffset: 36, byteLength: PNG_A.length },
    ],
    images: [{ bufferView: 1, mimeType: 'image/png' }],
    textures: [{ source: 0 }],
    materials: [{ name: 'Packed', pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
    meshes: [{ name: 'Packed', primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
  });

  return [
    { name: 'blender-like', kind: 'glb', ...blender },
    { name: 'scan-like', kind: 'glb', ...scan },
    { name: 'ai-like', kind: 'glb', ...ai },
    { name: 'instanced', kind: 'glb', ...instanced },
    { name: 'gltf-embedded', kind: 'gltf', doc: gltfDoc, bin: null },
    { name: 'meshopt', kind: 'glb', doc: meshopt, bin: meshoptBin },
  ];
}

function encode(f: Fixture, doc: Record<string, unknown>): Uint8Array<ArrayBuffer> {
  return f.kind === 'glb'
    ? makeGlb(doc, f.bin ?? undefined)
    : new TextEncoder().encode(JSON.stringify(doc)) as Uint8Array<ArrayBuffer>;
}

const HOSTILE: unknown[] = [-1, 1.5, 1e308, 2 ** 53, '0', '', [], {}, null, true, 'x'.repeat(5000), '__proto__', 'constructor', -0];
const U32S = [0, 1, 3, 0x7fffffff, 0xffffffff];

/** Every value path in a document, capped. */
function valuePaths(root: unknown): (string | number)[][] {
  const out: (string | number)[][] = [];
  const stack: { v: unknown; path: (string | number)[] }[] = [{ v: root, path: [] }];
  while (stack.length > 0 && out.length < 4000) {
    const { v, path } = stack.pop()!;
    if (Array.isArray(v)) {
      v.forEach((x, i) => {
        out.push([...path, i]);
        stack.push({ v: x, path: [...path, i] });
      });
    } else if (v && typeof v === 'object') {
      for (const k of Object.keys(v)) {
        out.push([...path, k]);
        stack.push({ v: (v as Record<string, unknown>)[k], path: [...path, k] });
      }
    }
  }
  return out;
}

function mutateJson(f: Fixture, rand: () => number): Uint8Array<ArrayBuffer> {
  const clone = JSON.parse(JSON.stringify(f.doc), safeJsonReviver) as Record<string, unknown>;
  const paths = valuePaths(clone);
  const path = paths[Math.floor(rand() * paths.length)];
  let o = clone as Record<string | number, unknown>;
  for (let i = 0; i < path.length - 1; i++) o = o[path[i]] as Record<string | number, unknown>;
  o[path[path.length - 1]] = HOSTILE[Math.floor(rand() * HOSTILE.length)];
  return encode(f, clone);
}

function mutateBytes(f: Fixture, base: Uint8Array, rand: () => number): Uint8Array<ArrayBuffer> {
  const b = base.slice() as Uint8Array<ArrayBuffer>;
  const dv = new DataView(b.buffer);
  const n = 1 + Math.floor(rand() * 3);
  for (let k = 0; k < n; k++) {
    if (f.kind === 'glb' && rand() < 0.5) {
      const binAt = 20 + dv.getUint32(12, true);
      const fields = [8, 12, 16, binAt, binAt + 4].filter((at) => at + 4 <= b.length);
      const at = fields[Math.floor(rand() * fields.length)];
      const cur = dv.getUint32(at, true);
      const choices = [...U32S, (cur + 1) >>> 0, (cur - 1) >>> 0];
      dv.setUint32(at, choices[Math.floor(rand() * choices.length)], true);
    } else {
      const i = Math.floor(rand() * Math.min(64, b.length));
      b[i] ^= 1 << Math.floor(rand() * 8);
    }
  }
  return b;
}

/** Every image view lies inside the input or inside one of the decoded buffers. */
function viewInside(v: Uint8Array, input: Uint8Array, m: GltfModelReport): boolean {
  const inside = (outer: Uint8Array) =>
    v.buffer === outer.buffer && v.byteOffset >= outer.byteOffset && v.byteOffset + v.byteLength <= outer.byteOffset + outer.byteLength;
  if (inside(input)) return true;
  if (m.source.buffers.some((b) => b !== 'fallback' && inside(b))) return true;
  // A decoded data: image stands alone in its own ArrayBuffer.
  return v.byteOffset === 0 && v.byteLength === v.buffer.byteLength && v.byteLength <= GLTF_IMAGE_MAX_BYTES;
}

function checkModel(m: GltfModelReport, input: Uint8Array): void {
  const inRange = (i: number | null, n: number) => i === null || (Number.isInteger(i) && i >= 0 && i < n);
  expect(m.signature.materials).toHaveLength(m.materials.length);
  expect(m.meshNameIndex).toBeInstanceOf(Map);
  for (const s of m.signature.materials) expect(typeof s).toBe('string');
  m.images.forEach((img, i) => {
    expect(img.index).toBe(i);
    expect(typeof img.name).toBe('string');
    if (img.bytes) expect(viewInside(img.bytes, input, m)).toBe(true);
    if (img.status === 'ok') expect(img.mime).not.toBeNull();
  });
  m.textures.forEach((t, i) => {
    expect(t.index).toBe(i);
    expect(inRange(t.sampler, m.samplers.length)).toBe(true);
    for (const src of Object.values(t.sources)) expect(inRange(src, m.images.length)).toBe(true);
    if (t.extract.status === 'ok') expect(m.images[t.extract.image].status).toBe('ok');
  });
  m.materials.forEach((mat, i) => {
    expect(mat.index).toBe(i);
    expect(typeof mat.name).toBe('string');
    expect(typeof mat.displayName).toBe('string');
    for (const slot of mat.slots) {
      expect(inRange(slot.texture, m.textures.length)).toBe(true);
      expect(slot.textureInfo.index).toBe(slot.texture);
    }
    for (const u of mat.unsupportedTextures) expect(inRange(u.texture, m.textures.length)).toBe(true);
  });
  for (const sm of m.sceneMeshes) {
    expect(typeof sm.name).toBe('string');
    expect(inRange(sm.material, m.materials.length)).toBe(true);
  }
  for (const i of buildableMaterialIndices(m)) expect(inRange(i, m.materials.length)).toBe(true);
  for (const [i, names] of mirrorNamesByMaterial(m)) {
    expect(inRange(i, m.materials.length)).toBe(true);
    for (const n of names) expect(typeof n).toBe('string');
  }
}

function runCase(bytes: Uint8Array, kind: 'glb' | 'gltf', label: string): void {
  let t0 = performance.now();
  let r = readGltfModel(bytes, kind);
  let ms = performance.now() - t0;
  if (ms > CASE_MS) {
    // One retry: a GC pause is not a slow reader.
    t0 = performance.now();
    r = readGltfModel(bytes, kind);
    ms = performance.now() - t0;
  }
  expect(ms, `${label}: ${ms.toFixed(1)} ms`).toBeLessThan(CASE_MS);
  if (!r.ok) {
    expect(r.refusal.detail, label).not.toBe('internal');
    return;
  }
  checkModel(r.model, bytes);
  expect(() => gltfPreviewFacts(bytes, kind), label).not.toThrow();
  checkStrip(r.model, label);
}

/** The strip invariant: no throw, and a copy that re-reads with the input's
 *  signature (or nothing to strip). Returns whether a copy was written. */
function checkStrip(m: GltfModelReport, label: string): boolean {
  let out: ReturnType<typeof stripGltfTextures> | null = null;
  try {
    const plan = planTextureStrip(m, buildableMaterialIndices(m));
    if (plan) out = stripGltfTextures(m, plan);
  } catch (e) {
    throw new Error(`${label}: the strip threw: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!out) return false;
  const again = readGltfModel(out.bytes, out.kind);
  expect(again.ok, `${label}: ${again.ok ? '' : JSON.stringify(again.refusal)}`).toBe(true);
  if (again.ok) expect(modelSignatureMatches(again.model.signature, m.signature), label).toBe(true);
  return true;
}

describe(`glTF reader seeded mutation fuzz (seed 0x${SEED.toString(16)})`, () => {
  let protoBefore: string[];
  beforeAll(() => {
    protoBefore = Object.getOwnPropertyNames(Object.prototype).sort();
  });
  afterAll(() => {
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(protoBefore);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  const FIXTURES = fixtures();

  it('every fixture reads ok unmutated (a fuzz of refusals only would prove nothing)', () => {
    for (const f of FIXTURES) {
      const r = readGltfModel(encode(f, f.doc), f.kind);
      expect(r.ok, `${f.name}: ${r.ok ? '' : JSON.stringify(r.refusal)}`).toBe(true);
      // Every textured fixture really strips, or the strip invariant below
      // would only ever see null plans ('instanced' carries no texture).
      if (r.ok) expect(checkStrip(r.model, f.name), f.name).toBe(f.name !== 'instanced');
    }
  });

  for (const [index, f] of FIXTURES.entries()) {
    it(`${f.name}: ${ROUNDS} mutations never throw, never mis-index, never pollute`, () => {
      const rand = mulberry32(SEED + index);
      const base = encode(f, f.doc);
      let accepted = 0;
      for (let round = 0; round < ROUNDS; round++) {
        const bytes = round % 2 === 0 ? mutateBytes(f, base, rand) : mutateJson(f, rand);
        const label = `seed 0x${SEED.toString(16)} ${f.name} round ${round}`;
        runCase(bytes, f.kind, label);
        if (readGltfModel(bytes, f.kind).ok) accepted++;
      }
      // Some mutations must still be accepted, or the invariants above never ran.
      expect(accepted).toBeGreaterThan(0);
    });
  }
});
