/**
 * The texture-stripping writer (`gltfStrip.ts`): the preview copy of a model
 * whose materials were built into a shader. What it must do, pinned here:
 * remove the BUILT materials' textures and nothing a live reference still
 * reads, never renumber anything, reclaim image-only bytes without moving an
 * accessor's bytes or alignment (and shift meshopt's raw offsets with them),
 * refuse to reclaim under an extension it cannot see into, prune dead
 * texture-only extension names, drop `extras.fastshaders`, and re-read with the
 * same signature. The "extraction before the gate" proof is here too: a 70 MiB
 * scan the 64 MiB model gate refuses becomes a preview mesh once stripped.
 *
 * The real r184 GLTFLoader parses one output, so `self`, `ProgressEvent` and
 * `createImageBitmap` are stubbed for that suite and restored with
 * vi.unstubAllGlobals() (`isolate: false`). Fixtures are built with
 * JSON.stringify; every JSON.parse carries the shared reviver.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { Material, Object3D, Texture } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  MESHOPT_EXTENSIONS,
  STRIP_WALK_BUDGET,
  TEXTURE_ONLY_EXTENSIONS,
  planTextureStrip,
  stripGltfTextures,
  type StripPlan,
} from './gltfStrip';
import { readGltfModel, type GltfModelReport } from './gltfReader';
import { PLACEHOLDER_PNG_DATA_URI, decodeDataUri, encodeDataUri, parseGlbContainer } from './glbContainer';
import { GLB_READ_MAX_BYTES, MESH_MAX_BYTES, createPreviewMesh } from './previewMesh';
import { modelSignatureMatches } from '@/engine/materialPartsContract';
import { safeJsonReviver } from './safeJson';
import { GLTF_NODE_GLOBALS } from '../gltfTestFixtures';
import { TRIANGLE_POSITIONS, makeGlb, makeRealPng, webpHeaderBytes } from '../test-utils';

/* ── helpers ─────────────────────────────────────────────────────────────── */

type Doc = Record<string, unknown>;
type Kind = 'glb' | 'gltf';

// Arithmetic, never `(n + 3) & ~3`: a bitwise operator coerces through ToInt32,
// so that spelling returns a NEGATIVE length from 2**31 up. Harmless at fixture
// sizes, but it is the shape that made the repacker u32 overflow guard dead code.
const pad4 = (n: number) => Math.ceil(n / 4) * 4;
const PNG_A = makeRealPng(2, 2, [250, 10, 10, 255]);
const PNG_B = makeRealPng(2, 2, [10, 10, 250, 255]);
const PNG_C = makeRealPng(3, 1, [10, 250, 10, 255]);
const WEBP = webpHeaderBytes('VP8 ', 16, 16);

function read(bytes: Uint8Array, kind: Kind = 'glb'): GltfModelReport {
  const r = readGltfModel(bytes, kind);
  if (!r.ok) throw new Error('reader refused: ' + JSON.stringify(r.refusal));
  return r.model;
}

function planOf(m: GltfModelReport, materials: Iterable<number>): StripPlan {
  const p = planTextureStrip(m, materials);
  if (!p) throw new Error('no plan');
  return p;
}

/** Plan and strip in one go; the output is re-read. */
function stripped(bytes: Uint8Array, materials: Iterable<number>, kind: Kind = 'glb') {
  const m = read(bytes, kind);
  const plan = planOf(m, materials);
  const out = stripGltfTextures(m, plan);
  return { m, plan, out, again: read(out.bytes, out.kind) };
}

/** The JSON document of a model file, parsed through the shared reviver. */
function docOf(bytes: Uint8Array, kind: Kind = 'glb'): Doc {
  if (kind === 'gltf') return JSON.parse(new TextDecoder().decode(bytes), safeJsonReviver) as Doc;
  const c = parseGlbContainer(bytes);
  if (!c.ok) throw new Error('container: ' + c.error);
  return JSON.parse(c.chunks.json, safeJsonReviver) as Doc;
}

function binOf(bytes: Uint8Array): Uint8Array {
  const c = parseGlbContainer(bytes);
  if (!c.ok || !c.chunks.bin) throw new Error('no BIN chunk');
  return c.chunks.bin;
}

function indexOfBytes(hay: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/** Every accessor's view bytes, through the report's own buffers. */
function accessorBytes(m: GltfModelReport): Uint8Array[] {
  const doc = m.source.doc;
  const views = (doc.bufferViews as Doc[] | undefined) ?? [];
  return ((doc.accessors as Doc[] | undefined) ?? []).map((a) => {
    const v = views[a.bufferView as number];
    const data = m.source.buffers[v.buffer as number];
    if (!(data instanceof Uint8Array)) return new Uint8Array(0);
    const off = typeof v.byteOffset === 'number' ? v.byteOffset : 0;
    return data.slice(off, off + (v.byteLength as number));
  });
}

const certainNames = (m: GltfModelReport) =>
  m.sceneMeshes.filter((s) => s.certain).map((s) => `${s.name}/${s.material}`);

/** bufferView 0 is the triangle, 1, 2, … the blobs (4-aligned). */
function withBlobs(extra: Doc, blobs: Uint8Array[]): { doc: Doc; bin: Uint8Array } {
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

/** `n` single-primitive meshes, material i on mesh i, one node each. */
function sceneOf(n: number): Doc {
  return {
    meshes: Array.from({ length: n }, (_, i) => ({ name: `M${i}`, primitives: [{ attributes: { POSITION: 0 }, material: i }] })),
    nodes: Array.from({ length: n }, (_, i) => ({ mesh: i })),
    scenes: [{ nodes: Array.from({ length: n }, (_, i) => i) }],
    scene: 0,
  };
}

/** THE fixture: materials A and B each textured with a distinct PNG, C sharing B's texture. */
function threeMaterials(extra: Doc = {}): Uint8Array<ArrayBuffer> {
  const { doc, bin } = withBlobs(
    {
      images: [
        { bufferView: 1, mimeType: 'image/png', name: 'A' },
        { bufferView: 2, mimeType: 'image/png', name: 'B' },
      ],
      samplers: [{ magFilter: 9729, minFilter: 9987 }],
      textures: [{ source: 0, sampler: 0 }, { source: 1, sampler: 0 }],
      materials: [
        { name: 'A', pbrMetallicRoughness: { baseColorTexture: { index: 0 } } },
        { name: 'B', pbrMetallicRoughness: { baseColorTexture: { index: 1 } }, normalTexture: { index: 1, scale: 1 } },
        { name: 'C', pbrMetallicRoughness: { baseColorTexture: { index: 1 } } },
      ],
      ...sceneOf(3),
      ...extra,
    },
    [PNG_A, PNG_B],
  );
  return makeGlb(doc, bin);
}

/* ── liveness ────────────────────────────────────────────────────────────── */

describe('liveness: only the built materials lose their textures', () => {
  it('plans the dead texture, image and view — and mutates nothing', () => {
    const m = read(threeMaterials());
    const before = JSON.stringify(m.source.doc);
    const plan = planOf(m, [0, 1]);
    expect(plan).toMatchObject({
      materials: [0, 1],
      deadTextures: [0],
      deadImages: [0],
      deadViews: [1],
      mode: 'compacted',
      bytesBefore: m.byteLength,
    });
    stripGltfTextures(m, plan);
    expect(JSON.stringify(m.source.doc)).toBe(before);
  });

  it("drops A's image bytes and keeps B's, which C still reads", () => {
    const { out, again } = stripped(threeMaterials(), [0, 1]);
    expect(indexOfBytes(out.bytes, PNG_A)).toBe(-1);
    expect(indexOfBytes(out.bytes, PNG_B)).toBeGreaterThan(-1);
    const doc = docOf(out.bytes);
    const mats = doc.materials as Doc[];
    expect(mats[0].pbrMetallicRoughness).toEqual({});
    expect(mats[1].pbrMetallicRoughness).toEqual({});
    expect(mats[1].normalTexture).toBeUndefined();
    expect(mats[2].pbrMetallicRoughness).toEqual({ baseColorTexture: { index: 1 } });
    // Index-stable: the dead texture points at the placeholder image, which
    // keeps image 0's slot; the live texture and image are untouched.
    expect(doc.textures).toEqual([{ source: 0 }, { source: 1, sampler: 0 }]);
    expect((doc.images as Doc[])[0]).toEqual({ uri: PLACEHOLDER_PNG_DATA_URI });
    expect((doc.images as Doc[])[1]).toEqual({ bufferView: 2, mimeType: 'image/png', name: 'B' });
    expect((doc.bufferViews as Doc[])[1]).toEqual({ buffer: 0, byteOffset: 0, byteLength: 1 });
    expect(again.materials[2].slots.map((s) => s.texture)).toEqual([1]);
  });

  it('ignores invalid material indices, and has nothing to do without a texture', () => {
    const m = read(threeMaterials());
    expect(planTextureStrip(m, [-1, 3, 1.5, Number.NaN, 99])).toBeNull();
    expect(planTextureStrip(m, [])).toBeNull();
    const plain = read(makeGlb(withBlobs({ materials: [{ name: 'Plain' }], ...sceneOf(1) }, []).doc, TRIANGLE_POSITIONS));
    expect(planTextureStrip(plain, [0])).toBeNull();
  });

  it('a built material sharing a texture with an unbuilt one kills nothing', () => {
    const { plan, out, m } = stripped(threeMaterials(), [2, 2]);
    expect(plan).toMatchObject({ materials: [2], deadTextures: [], deadImages: [], deadViews: [] });
    expect(binOf(out.bytes)).toEqual(m.source.bin);
    expect((docOf(out.bytes).materials as Doc[])[2].pbrMetallicRoughness).toEqual({});
  });

  it('a dead texture sharing a LIVE image keeps pointing at it (nothing to replace)', () => {
    const { doc, bin } = withBlobs(
      {
        images: [{ bufferView: 1, mimeType: 'image/png' }],
        textures: [{ source: 0, name: 'first' }, { source: 0, name: 'second' }],
        materials: [
          { name: 'X', pbrMetallicRoughness: { baseColorTexture: { index: 0 } } },
          { name: 'Y', pbrMetallicRoughness: { baseColorTexture: { index: 1 } } },
        ],
        ...sceneOf(2),
      },
      [PNG_A],
    );
    const { plan, out } = stripped(makeGlb(doc, bin), [0]);
    expect(plan).toMatchObject({ deadTextures: [0], deadImages: [], deadViews: [] });
    expect((docOf(out.bytes).textures as Doc[])[0]).toEqual({ source: 0 });
    expect(indexOfBytes(out.bytes, PNG_A)).toBeGreaterThan(-1);
  });

  it("deletes a built material's extension textures too, but no one else's", () => {
    const { doc, bin } = withBlobs(
      {
        extensionsUsed: ['KHR_materials_clearcoat'],
        images: [{ bufferView: 1, mimeType: 'image/png' }, { bufferView: 2, mimeType: 'image/png' }],
        textures: [{ source: 0 }, { source: 1 }],
        materials: [
          { name: 'Coat', extensions: { KHR_materials_clearcoat: { clearcoatFactor: 1, clearcoatTexture: { index: 0 } } } },
          { name: 'Other', extensions: { KHR_materials_clearcoat: { clearcoatTexture: { index: 1 } } } },
        ],
        ...sceneOf(2),
      },
      [PNG_A, PNG_B],
    );
    const { plan, out } = stripped(makeGlb(doc, bin), [0]);
    expect(plan).toMatchObject({ materials: [0], deadTextures: [0], deadImages: [0] });
    const mats = docOf(out.bytes).materials as Doc[];
    expect(mats[0].extensions).toEqual({ KHR_materials_clearcoat: { clearcoatFactor: 1 } });
    expect(mats[1].extensions).toEqual({ KHR_materials_clearcoat: { clearcoatTexture: { index: 1 } } });
  });

  it('an unknown extension that references a texture keeps it alive (the conservative walk)', () => {
    const { doc, bin } = withBlobs(
      {
        images: [{ bufferView: 1, mimeType: 'image/png' }],
        textures: [{ source: 0 }],
        materials: [{ name: 'M', pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
        extensions: { EXT_someone_else: { decal: { lookupTexture: { index: 0 } } } },
        ...sceneOf(1),
      },
      [PNG_A],
    );
    const { plan, out } = stripped(makeGlb(doc, bin), [0]);
    expect(plan).toMatchObject({ materials: [0], deadTextures: [], deadImages: [] });
    expect(indexOfBytes(out.bytes, PNG_A)).toBeGreaterThan(-1);
  });
});

/* ── the real loader ─────────────────────────────────────────────────────── */

describe('the stripped copy in the REAL r184 GLTFLoader', () => {
  let bitmaps: MockInstance;
  let warn: MockInstance;
  let error: MockInstance;
  beforeEach(() => {
    bitmaps = vi.fn(async () => ({ width: 2, height: 2, close() {} }));
    vi.stubGlobal('self', GLTF_NODE_GLOBALS.self);
    vi.stubGlobal('ProgressEvent', GLTF_NODE_GLOBALS.ProgressEvent);
    vi.stubGlobal('createImageBitmap', bitmaps);
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    error = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    error.mockRestore();
    vi.unstubAllGlobals();
  });

  it('A and B lose their map, C keeps it, and only the live texture is decoded', async () => {
    const { out } = stripped(threeMaterials(), [0, 1]);
    const gltf = await new GLTFLoader().parseAsync(out.bytes.buffer, '');
    const maps = new Map<string, Texture | null>();
    gltf.scene.traverse((o: Object3D) => {
      const mat = (o as Object3D & { material?: Material & { map?: Texture | null } }).material;
      if (mat) maps.set(mat.name, mat.map ?? null);
    });
    expect(maps.get('A')).toBeNull();
    expect(maps.get('B')).toBeNull();
    expect(maps.get('C')).not.toBeNull();
    expect(bitmaps).toHaveBeenCalledTimes(1);
  });
});

/* ── integrity ───────────────────────────────────────────────────────────── */

describe('integrity', () => {
  it('keeps every accessor byte, the signature and the certain names', () => {
    const { m, again } = stripped(threeMaterials(), [0, 1]);
    expect(accessorBytes(again)).toEqual(accessorBytes(m));
    expect(modelSignatureMatches(again.signature, m.signature)).toBe(true);
    expect(certainNames(again)).toEqual(certainNames(m));
    expect(again.kind).toBe('glb');
  });

  it('estimates the output size to within 256 bytes', () => {
    const { plan, out } = stripped(threeMaterials(), [0, 1]);
    // (A 2×2 PNG is smaller than the placeholder's JSON, so this tiny copy is
    // not smaller than its input; the 70 MiB proof below is the shrinking case.)
    expect(Math.abs(plan.estimatedBytes - out.bytes.length)).toBeLessThanOrEqual(256);
  });

  it('is deterministic, and a second strip of the same set has nothing left to do', () => {
    const input = threeMaterials();
    const a = stripped(input, [0, 1]);
    const b = stripped(threeMaterials(), [0, 1]);
    expect(b.out.bytes).toEqual(a.out.bytes);
    expect(stripGltfTextures(a.m, a.plan).bytes).toEqual(a.out.bytes);
    expect(planTextureStrip(a.again, [0, 1])).toBeNull();
  });

  it('a plan is a pure value: a JSON copy strips the same, a foreign plan throws', () => {
    const { m, plan, out } = stripped(threeMaterials(), [0, 1]);
    const copy = JSON.parse(JSON.stringify(plan), safeJsonReviver) as StripPlan;
    expect(stripGltfTextures(m, copy).bytes).toEqual(out.bytes);
    expect(() => stripGltfTextures(m, { ...plan, deadImages: [1] })).toThrow(/plan does not describe/);
    expect(() => stripGltfTextures(m, { ...plan, materials: [2] })).toThrow(/plan does not describe/);
  });

  // The 4M-element array alone is a multi-second parse under load, so this
  // one test carries its own timeout: the suite's 5 s default timed it out
  // while cargo or a second vitest run shared the machine.
  it('a walk over the budget is no plan, not a slow one', () => {
    const big = new Array(STRIP_WALK_BUDGET + 8).fill(0);
    const m = read(threeMaterials({ extras: { big } }));
    expect(planTextureStrip(m, [0, 1])).toBeNull();
  }, 60_000);
});

/* ── compaction ──────────────────────────────────────────────────────────── */

describe('compaction', () => {
  const FILL = 0xab;

  it('an image view overlapping an accessor view: the shared bytes stay and the accessor is intact', () => {
    const bin = new Uint8Array(100).fill(FILL);
    bin.set(TRIANGLE_POSITIONS, 64);
    const doc = {
      asset: { version: '2.0' },
      buffers: [{ byteLength: 100 }],
      bufferViews: [{ buffer: 0, byteOffset: 64, byteLength: 36 }, { buffer: 0, byteOffset: 0, byteLength: 100 }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
      images: [{ bufferView: 1, mimeType: 'image/png' }],
      textures: [{ source: 0 }],
      materials: [{ name: 'M', pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
      ...sceneOf(1),
    };
    const { m, plan, out, again } = stripped(makeGlb(doc, bin), [0]);
    expect(plan.deadViews).toEqual([1]);
    const outBin = binOf(out.bytes);
    expect(outBin.length).toBe(36);
    expect((docOf(out.bytes).bufferViews as Doc[])[0]).toEqual({ buffer: 0, byteOffset: 0, byteLength: 36 });
    expect(accessorBytes(again)).toEqual(accessorBytes(m));
    expect((docOf(out.bytes).buffers as Doc[])[0].byteLength).toBe(36);
  });

  it('a dead view at an unaligned offset: every live view keeps its offset mod 4', () => {
    const bin = new Uint8Array(100);
    bin.set(TRIANGLE_POSITIONS, 0);
    bin.fill(FILL, 37, 87);
    for (let i = 0; i < 8; i++) bin[90 + i] = i + 1;
    const doc = {
      asset: { version: '2.0' },
      buffers: [{ byteLength: 100 }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 36 },
        { buffer: 0, byteOffset: 37, byteLength: 50 },
        { buffer: 0, byteOffset: 90, byteLength: 8 },
      ],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
        { bufferView: 2, componentType: 5121, count: 8, type: 'SCALAR' },
      ],
      images: [{ bufferView: 1, mimeType: 'image/png' }],
      textures: [{ source: 0 }],
      materials: [{ name: 'M', pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
      ...sceneOf(1),
    };
    const { m, out, again } = stripped(makeGlb(doc, bin), [0]);
    const before = (doc.bufferViews as Doc[]).map((v) => v.byteOffset as number);
    const after = (docOf(out.bytes).bufferViews as Doc[]).map((v) => (typeof v.byteOffset === 'number' ? v.byteOffset : 0));
    for (const v of [0, 2]) expect(after[v] % 4).toBe(before[v] % 4);
    expect(after[2]).toBeLessThan(before[2]);
    expect(accessorBytes(again)).toEqual(accessorBytes(m));
  });

  it('meshopt: the extension ranges after a dead image shift with their bytes', () => {
    const blob = Uint8Array.from({ length: 40 }, (_, i) => 100 + i);
    const x = pad4(PNG_A.length);
    const bin = new Uint8Array(x + blob.length);
    bin.set(PNG_A, 0);
    bin.set(blob, x);
    const doc = {
      asset: { version: '2.0' },
      extensionsUsed: ['EXT_meshopt_compression'],
      buffers: [{ byteLength: bin.length }, { byteLength: 36, extensions: { EXT_meshopt_compression: { fallback: true } } }],
      bufferViews: [
        {
          buffer: 1,
          byteOffset: 0,
          byteLength: 36,
          byteStride: 12,
          extensions: {
            EXT_meshopt_compression: { buffer: 0, byteOffset: x, byteLength: 40, byteStride: 12, count: 3, mode: 'ATTRIBUTES' },
          },
        },
        { buffer: 0, byteOffset: 0, byteLength: PNG_A.length },
      ],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
      images: [{ bufferView: 1, mimeType: 'image/png' }],
      textures: [{ source: 0 }],
      materials: [{ name: 'Packed', pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
      ...sceneOf(1),
    };
    const { plan, out } = stripped(makeGlb(doc, bin), [0]);
    expect(plan.mode).toBe('compacted');
    const outBin = binOf(out.bytes);
    const removed = bin.length - outBin.length;
    expect(removed).toBe(PNG_A.length - (PNG_A.length % 4));
    const ext = ((docOf(out.bytes).bufferViews as Doc[])[0].extensions as Doc).EXT_meshopt_compression as Doc;
    expect(ext.byteOffset).toBe(x - removed);
    expect(outBin.slice(ext.byteOffset as number, (ext.byteOffset as number) + 40)).toEqual(blob);
  });

  it('a bufferView carrying another extension: kept mode, the BIN byte-identical, the images still replaced', () => {
    const input = threeMaterials({
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 36, extensions: { EXT_foo: { any: 1 } } },
        { buffer: 0, byteOffset: 36, byteLength: PNG_A.length },
        { buffer: 0, byteOffset: pad4(36 + PNG_A.length), byteLength: PNG_B.length },
      ],
    });
    const { m, plan, out } = stripped(input, [0, 1]);
    expect(plan.mode).toBe('kept');
    expect(binOf(out.bytes)).toEqual(m.source.bin);
    const doc = docOf(out.bytes);
    expect((doc.images as Doc[])[0]).toEqual({ uri: PLACEHOLDER_PNG_DATA_URI });
    expect((doc.bufferViews as Doc[])[1]).toEqual({ buffer: 0, byteOffset: 36, byteLength: PNG_A.length });
  });

  it('a buffer extension that is not meshopt switches compaction off too', () => {
    const input = threeMaterials({ buffers: [{ byteLength: 36 + 4 + PNG_A.length + PNG_B.length + 8, extensions: { EXT_bar: {} } }] });
    const m = read(input);
    expect(planOf(m, [0, 1]).mode).toBe('kept');
    expect(MESHOPT_EXTENSIONS).toEqual(['EXT_meshopt_compression', 'KHR_meshopt_compression']);
  });
});

/* ── extensions and extras ───────────────────────────────────────────────── */

describe('extension names and extras', () => {
  function webpModel(): Uint8Array<ArrayBuffer> {
    const { doc, bin } = withBlobs(
      {
        extensionsUsed: ['EXT_texture_webp', 'KHR_materials_emissive_strength'],
        extensionsRequired: ['EXT_texture_webp'],
        images: [
          { bufferView: 1, mimeType: 'image/png' },
          { bufferView: 2, mimeType: 'image/webp' },
          { bufferView: 3, mimeType: 'image/png' },
          { bufferView: 4, mimeType: 'image/webp' },
        ],
        textures: [
          { source: 0, extensions: { EXT_texture_webp: { source: 1 } } },
          { source: 2, extensions: { EXT_texture_webp: { source: 3 } } },
        ],
        materials: [
          { name: 'W0', pbrMetallicRoughness: { baseColorTexture: { index: 0 } } },
          { name: 'W1', pbrMetallicRoughness: { baseColorTexture: { index: 1 } } },
        ],
        ...sceneOf(2),
      },
      [PNG_A, WEBP, PNG_B, WEBP],
    );
    return makeGlb(doc, bin);
  }

  it('EXT_texture_webp stays while a live texture uses it', () => {
    const doc = docOf(stripped(webpModel(), [0]).out.bytes);
    expect(doc.extensionsUsed).toEqual(['EXT_texture_webp', 'KHR_materials_emissive_strength']);
    expect(doc.extensionsRequired).toEqual(['EXT_texture_webp']);
  });

  it('EXT_texture_webp is pruned once every webp texture is dead (an emptied list goes)', () => {
    const { plan, out } = stripped(webpModel(), [0, 1]);
    expect(plan.deadImages).toEqual([0, 1, 2, 3]);
    const doc = docOf(out.bytes);
    expect(doc.extensionsUsed).toEqual(['KHR_materials_emissive_strength']);
    expect(doc.extensionsRequired).toBeUndefined();
  });

  function transformModel(otherHasTransform: boolean): Uint8Array<ArrayBuffer> {
    const xf = { extensions: { KHR_texture_transform: { scale: [2, 2] } } };
    const { doc, bin } = withBlobs(
      {
        extensionsUsed: ['KHR_texture_transform'],
        images: [{ bufferView: 1, mimeType: 'image/png' }, { bufferView: 2, mimeType: 'image/png' }],
        textures: [{ source: 0 }, { source: 1 }],
        materials: [
          { name: 'T0', pbrMetallicRoughness: { baseColorTexture: { index: 0, ...xf } } },
          { name: 'T1', pbrMetallicRoughness: { baseColorTexture: { index: 1, ...(otherHasTransform ? xf : {}) } } },
        ],
        ...sceneOf(2),
      },
      [PNG_A, PNG_B],
    );
    return makeGlb(doc, bin);
  }

  it('KHR_texture_transform is pruned when no remaining textureInfo carries it, kept when one does', () => {
    expect(docOf(stripped(transformModel(false), [0]).out.bytes).extensionsUsed).toBeUndefined();
    expect(docOf(stripped(transformModel(true), [0]).out.bytes).extensionsUsed).toEqual(['KHR_texture_transform']);
    expect(TEXTURE_ONLY_EXTENSIONS).toContain('KHR_texture_transform');
  });

  it('removes extras.fastshaders from the root and the scenes, and keeps other extras', () => {
    const input = threeMaterials({
      extras: { fastshaders: { v: 1, assets: { k: 0 } }, author: 'me' },
      scenes: [{ nodes: [0, 1, 2], extras: { fastshaders: 2, other: 'x' } }],
    });
    const doc = docOf(stripped(input, [0]).out.bytes);
    expect(doc.extras).toEqual({ author: 'me' });
    expect((doc.scenes as Doc[])[0].extras).toEqual({ other: 'x' });
  });
});

/* ── .gltf ───────────────────────────────────────────────────────────────── */

describe('.gltf (embedded data: URIs)', () => {
  it('replaces data-URI images and re-encodes a data: buffer that held an image view', () => {
    const data = new Uint8Array(pad4(36 + PNG_B.length));
    data.set(TRIANGLE_POSITIONS, 0);
    data.set(PNG_B, 36);
    const doc = {
      asset: { version: '2.0' },
      buffers: [{ byteLength: data.length, uri: encodeDataUri('application/octet-stream', data) }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: PNG_B.length }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
      images: [{ uri: encodeDataUri('image/png', PNG_C) }, { bufferView: 1, mimeType: 'image/png' }],
      textures: [{ source: 0 }, { source: 1 }],
      materials: [
        { name: 'G0', pbrMetallicRoughness: { baseColorTexture: { index: 0 } } },
        { name: 'G1', emissiveTexture: { index: 1 } },
      ],
      ...sceneOf(2),
    };
    const input = new TextEncoder().encode(JSON.stringify(doc));
    const { m, plan, out, again } = stripped(input, [0, 1], 'gltf');
    expect(out.kind).toBe('gltf');
    expect(plan.deadImages).toEqual([0, 1]);
    const outDoc = docOf(out.bytes, 'gltf');
    expect(outDoc.images).toEqual([{ uri: PLACEHOLDER_PNG_DATA_URI }, { uri: PLACEHOLDER_PNG_DATA_URI }]);
    const buf = (outDoc.buffers as Doc[])[0];
    const decoded = decodeDataUri(buf.uri as string, 'buffer', 1 << 20);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(buf.uri).toBe(encodeDataUri('application/octet-stream', decoded.bytes));
      expect(decoded.bytes.length).toBeLessThan(data.length);
      expect(decoded.bytes.slice(0, 36)).toEqual(TRIANGLE_POSITIONS);
    }
    expect(accessorBytes(again)).toEqual(accessorBytes(m));
    expect(Math.abs(plan.estimatedBytes - out.bytes.length)).toBeLessThanOrEqual(256);
  });
});

/* ── extraction before the gate ──────────────────────────────────────────── */

describe('extraction before the gate: a 70 MiB scan', () => {
  it('the 64 MiB gate refuses the file, and accepts its stripped copy as a preview mesh', () => {
    const MiB = 1024 * 1024;
    const total = 70 * MiB;
    // ONE allocation: the GLB is written by hand around a zero-filled image
    // that only carries the PNG signature (the reader reports it too large to
    // extract, which does not matter: it is stripped either way).
    const docFor = (imageLength: number) => ({
      asset: { version: '2.0' },
      buffers: [{ byteLength: 36 + imageLength }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: imageLength }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
      images: [{ bufferView: 1, mimeType: 'image/png' }],
      textures: [{ source: 0 }],
      materials: [{ name: 'Scan', pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
      ...sceneOf(1),
    });
    const probe = new TextEncoder().encode(JSON.stringify(docFor(total)));
    const jsonLength = pad4(probe.length);
    const binLength = total - 20 - jsonLength - 8;
    const imageLength = binLength - 36;
    const json = new TextEncoder().encode(JSON.stringify(docFor(imageLength)));
    expect(json.length).toBeLessThanOrEqual(jsonLength);
    const glb = new Uint8Array(total);
    const dv = new DataView(glb.buffer);
    dv.setUint32(0, 0x46546c67, true);
    dv.setUint32(4, 2, true);
    dv.setUint32(8, total, true);
    dv.setUint32(12, jsonLength, true);
    dv.setUint32(16, 0x4e4f534a, true);
    glb.fill(0x20, 20, 20 + jsonLength);
    glb.set(json, 20);
    const binAt = 20 + jsonLength;
    dv.setUint32(binAt, binLength, true);
    dv.setUint32(binAt + 4, 0x004e4942, true);
    glb.set(TRIANGLE_POSITIONS, binAt + 8);
    glb.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], binAt + 8 + 36);

    expect(glb.length).toBeGreaterThan(MESH_MAX_BYTES);
    expect(glb.length).toBeLessThanOrEqual(GLB_READ_MAX_BYTES);
    const refused = createPreviewMesh('scan.glb', glb);
    expect('refusal' in refused && refused.refusal.reason).toBe('too-large');

    const m = read(glb);
    expect(m.images[0].status).toBe('too-large');
    const plan = planOf(m, [0]);
    expect(plan.estimatedBytes).toBeLessThan(MESH_MAX_BYTES);
    const out = stripGltfTextures(m, plan);
    expect(out.bytes.length).toBeLessThan(MESH_MAX_BYTES);
    expect(Math.abs(plan.estimatedBytes - out.bytes.length)).toBeLessThanOrEqual(256);
    const result = createPreviewMesh('scan.glb', out.bytes);
    expect('mesh' in result).toBe(true);
    if ('mesh' in result) {
      expect(result.mesh.kind).toBe('glb');
      expect(result.mesh.name).toBe('scan.glb');
    }
  });
});
