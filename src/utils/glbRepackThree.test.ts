/**
 * The repacker's output in the REAL r184 GLTFLoader (node, no network: every
 * image is a bufferView, so GLTFLoader loads it through a blob: URL) and in
 * the REAL vendored loader 0.8's glTF plugin (src/shaderloaderHarness.ts):
 *   - the written slots land as three's maps, with texCoord and
 *     KHR_texture_transform, and the factors unchanged;
 *   - three ALWAYS decodes the WebP payload, never the PNG/JPEG fallback, in
 *     both modes (GLTFTextureWebPExtension has no fallback path — pinned here
 *     so a three change is noticed);
 *   - loader 0.8's stash holds every `assets` key with the payload's exact
 *     bytes, and a 64-key file stashes all 64.
 * The loader's EMBED_* bounds are text-pinned to the contract leaf by
 * engine/glbShaderContract.test.ts, so they are not restated here.
 *
 * `self`, `createImageBitmap` (recording each decoded blob) and
 * `ProgressEvent` are stubbed per test and undone with vi.unstubAllGlobals()
 * (`isolate: false`).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as THREE from 'three/webgpu';
import type { Material, Mesh, Object3D } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { LoadingManager, RGBA_ASTC_4x4_Format } from 'three';
import { readFileSync } from 'node:fs';
import {
  measureGlbRepack,
  prepareRepackBase,
  repackGlb,
  samplerFor,
  type RepackInput,
  type RepackPayload,
  type RepackSlot,
} from './glbRepack';
import { readGltfModel, type GltfModelReport } from './gltfReader';
import { encodeDataUri } from './glbContainer';
import { embedProjectState } from '@/engine/fastShadersProject';
import { evalLoader, loaderAvailable, type FastShadersApi } from '../shaderloaderHarness';
import { GLTF_NODE_GLOBALS, parseWith } from '../gltfTestFixtures';
import { fakeRenderer, fakeWebp, installInProcessWorker, makeRealPng, repackBaseGlb } from '@/test-utils';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

interface Decoded {
  size: number;
  head: string;
  bytes: Uint8Array;
}
let decoded: Decoded[] = [];

beforeEach(() => {
  decoded = [];
  vi.stubGlobal('self', GLTF_NODE_GLOBALS.self);
  vi.stubGlobal('ProgressEvent', GLTF_NODE_GLOBALS.ProgressEvent);
  vi.stubGlobal('createImageBitmap', async (blob: Blob) => {
    const b = new Uint8Array(await blob.arrayBuffer());
    decoded.push({ size: blob.size, head: String.fromCharCode(...b.subarray(0, 4)), bytes: b });
    return { width: 2, height: 2, close() {} };
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function read(bytes: Uint8Array): GltfModelReport {
  const r = readGltfModel(bytes, 'glb');
  if (!r.ok) throw new Error('reader refused');
  return r.model;
}

const BASE = (() => {
  const raw = repackBaseGlb({ materials: ['Body', 'Glass', 'Trim'], textured: true });
  const r = prepareRepackBase(read(raw), [0, 1]);
  if (!r.ok) throw new Error('prepare');
  return r.model;
})();

const PNG_N = makeRealPng(4, 4, [128, 128, 255, 255]);
const PNG_MR = makeRealPng(3, 3, [0, 128, 200, 255]);
const WEBP = fakeWebp(8, 8, false);
const FALLBACK = makeRealPng(8, 8, [9, 9, 9, 255]);
const SRC = {
  N: encodeDataUri('image/png', PNG_N),
  MR: encodeDataUri('image/png', PNG_MR),
  W: encodeDataUri('image/webp', WEBP),
};
const KEYS = { N: 'imgN-0000aaaa', MR: 'imgM-0000bbbb', W: 'imgW-0000cccc' };
const LIN = samplerFor({ colorSpace: 'color', nearest: false, repeat: true });
const DATA = samplerFor({ colorSpace: 'data', nearest: false, repeat: true });

const slot = (material: number, s: RepackSlot['slot'], src: string, extra: Partial<RepackSlot> = {}): RepackSlot => ({
  material,
  slot: s,
  src,
  texCoord: 0,
  transform: null,
  sampler: LIN,
  name: '',
  ...extra,
});

function input(over: Partial<RepackInput> = {}): RepackInput {
  return {
    base: BASE,
    indexMaterials: [0, 1],
    slots: [
      slot(0, 'baseColor', SRC.W, { texCoord: 1, transform: { offset: [0.25, 0.5], rotation: 0.3, scale: [2, 2] } }),
      slot(0, 'normal', SRC.N, { sampler: DATA }),
      slot(1, 'metallicRoughness', SRC.MR, { sampler: DATA }),
      slot(1, 'emissive', SRC.W),
    ],
    payloads: new Map<string, RepackPayload>([
      [SRC.N, { mime: 'image/png', bytes: PNG_N, lossless: true }],
      [SRC.MR, { mime: 'image/png', bytes: PNG_MR, lossless: true }],
      [SRC.W, { mime: 'image/webp', bytes: WEBP, lossless: false }],
    ]),
    fallbacks: new Map([[SRC.W, { mime: 'image/png', bytes: FALLBACK }]]),
    moduleText: 'export default function () { return {}; }\n',
    moduleAssets: [
      { key: KEYS.W, src: SRC.W },
      { key: KEYS.N, src: SRC.N },
      { key: KEYS.MR, src: SRC.MR },
    ],
    projectText: embedProjectState('', { version: 1, shaderName: 'x', graph: { nodes: [], edges: [] }, preview: {}, ui: {} }).trim(),
    webpMode: 'fallback',
    ...over,
  };
}

function bytesOf(i: RepackInput): Uint8Array<ArrayBuffer> {
  const r = repackGlb(i);
  if (!r.ok) throw new Error('repack refused: ' + JSON.stringify(r.refusal));
  return r.bytes;
}

function materialsByName(root: Object3D): Map<string, Any> {
  const out = new Map<string, Any>();
  root.traverse((o) => {
    const m = (o as Mesh).material as Material | undefined;
    if (m && !Array.isArray(m)) out.set(m.name, m);
  });
  return out;
}

/**
 * The KTX2 copies (Phase 8) through the REAL loaders: a texture that carries
 * one is a CompressedTexture where a KTX2Loader is installed, and the ordinary
 * WebP/PNG texture where none is — which is what makes the copies additive.
 * The transcode runs for real (three's own transcoder in an in-process
 * Worker), so this one is slow.
 */
describe('KTX2 copies in the REAL GLTFLoader', () => {
  const KTX2 = new Uint8Array(readFileSync(new URL('../engine/fixtures/ktx2/2d_uastc.ktx2', import.meta.url)));
  const basisFile = (f: string) =>
    readFileSync(new URL(`../../node_modules/three/examples/jsm/libs/basis/${f}`, import.meta.url));
  const SLOW = 30_000;

  /** The file with a KTX2 copy on the first written texture. */
  function withKtx2(): { bytes: Uint8Array<ArrayBuffer>; texture: number } {
    const i = input();
    const m = measureGlbRepack(i);
    if (!m.ok) throw new Error('measure refused');
    const texture = m.written[0].texture;
    return { bytes: bytesOf({ ...i, ktx2Sources: new Map([[texture, KTX2]]) }), texture };
  }

  it('without a KTX2 loader, the texture is the ordinary WebP one', async () => {
    const gltf = await new GLTFLoader().parseAsync(withKtx2().bytes.buffer, '');
    const body = materialsByName(gltf.scene).get('Body');
    expect(body.map).toBeTruthy();
    expect(body.map.isCompressedTexture).toBeFalsy();
    // three took the WebP payload, exactly as it does without the copies.
    expect(decoded.some((d) => d.head === 'RIFF')).toBe(true);
  });

  it(
    'with one, the same texture transcodes to a CompressedTexture',
    async () => {
      const workers = installInProcessWorker();
      const manager = new LoadingManager();
      const url = (f: string, mime: string) =>
        `data:${mime};base64,${basisFile(f).toString('base64')}`;
      manager.setURLModifier((u) =>
        u === 'fs-decoder:/basis_transcoder.js'
          ? url('basis_transcoder.js', 'text/javascript')
          : u === 'fs-decoder:/basis_transcoder.wasm'
            ? url('basis_transcoder.wasm', 'application/wasm')
            : u,
      );
      const renderer = fakeRenderer(['texture-compression-astc']);
      await renderer.init();
      const ktx2 = new KTX2Loader(manager).setTranscoderPath('fs-decoder:/');
      ktx2.detectSupport(renderer as unknown as Parameters<KTX2Loader['detectSupport']>[0]);
      try {
        const loader = new GLTFLoader().setKTX2Loader(ktx2);
        const gltf = await loader.parseAsync(withKtx2().bytes.buffer, '');
        const body = materialsByName(gltf.scene).get('Body');
        expect(body.map.isCompressedTexture).toBe(true);
        expect(body.map.format).toBe(RGBA_ASTC_4x4_Format);
        expect(body.map.userData.mimeType).toBe('image/ktx2');
        expect(workers.created).toBeGreaterThan(0);
      } finally {
        ktx2.dispose();
      }
    },
    SLOW,
  );
});

describe('the REAL r184 GLTFLoader', () => {
  it('maps land on the right materials, with texCoord and the transform; factors unchanged', async () => {
    const gltf = await new GLTFLoader().parseAsync(bytesOf(input()).buffer, '');
    const mats = materialsByName(gltf.scene);
    const body = mats.get('Body');
    const glass = mats.get('Glass');
    expect(body.map).toBeTruthy();
    expect(body.map.channel).toBe(1);
    expect(body.map.offset.toArray()).toEqual([0.25, 0.5]);
    expect(body.map.repeat.toArray()).toEqual([2, 2]);
    expect(body.map.rotation).toBeCloseTo(0.3, 12);
    expect(body.normalMap).toBeTruthy();
    expect(glass.metalnessMap).toBeTruthy();
    expect(glass.roughnessMap).toBe(glass.metalnessMap);
    expect(glass.emissiveMap).toBeTruthy();
    expect(body.color.getHex()).toBe(0xffffff);
    expect(glass.metalness).toBe(1);
    expect(glass.roughness).toBe(1);
    // The unbuilt material keeps its own texture.
    expect(mats.get('Trim').map).toBeTruthy();
    expect([...mats.keys()].sort()).toEqual([...BASE.signature.materials].sort());
  });

  for (const webpMode of ['fallback', 'required'] as const) {
    it(`three decodes the WebP payload, never the fallback ('${webpMode}')`, async () => {
      await new GLTFLoader().parseAsync(bytesOf(input({ webpMode })).buffer, '');
      const webps = decoded.filter((d) => d.head === 'RIFF');
      expect(webps.length).toBeGreaterThan(0);
      for (const d of webps) expect(d.bytes).toEqual(WEBP);
      expect(decoded.some((d) => d.size === FALLBACK.length && d.bytes.every((v, k) => v === FALLBACK[k]))).toBe(false);
    });
  }
});

describe.skipIf(!loaderAvailable('0.8'))('the REAL vendored loader 0.8 stash', () => {
  function fresh() {
    const warns: string[] = [];
    const ev = evalLoader('0.8', {
      THREE,
      warn: (...a: unknown[]) => warns.push(a.map(String).join(' ')),
      globals: { document: { querySelectorAll: () => [] } },
    });
    if (!ev.FastShaders) throw new Error('0.8 installed no FastShaders api');
    return { FS: ev.FastShaders as FastShadersApi, warns };
  }

  it('records the signature and stashes every asset key with the payload\'s exact bytes', async () => {
    const { FS, warns } = fresh();
    const gltf = await parseWith([FS.gltfPlugin], bytesOf(input()).buffer);
    expect((FS as Any).gltfRecord(gltf.scene).materialNames).toEqual(BASE.signature.materials);
    const stash = (FS as Any).embeddedAssets(gltf.scene) as Map<string, { mime: string; bytes: ArrayBuffer }>;
    expect(stash).not.toBeNull();
    expect([...stash.keys()].sort()).toEqual([KEYS.MR, KEYS.N, KEYS.W].sort());
    expect(new Uint8Array(stash.get(KEYS.W)!.bytes)).toEqual(WEBP);
    expect(stash.get(KEYS.W)!.mime).toBe('image/webp');
    expect(new Uint8Array(stash.get(KEYS.N)!.bytes)).toEqual(PNG_N);
    expect(warns).toEqual([]);
  });

  it('a 64-key file stashes all 64', async () => {
    const { FS, warns } = fresh();
    const payloads = new Map<string, RepackPayload>();
    const moduleAssets = [];
    for (let i = 0; i < 64; i++) {
      const png = makeRealPng(1, 1, [i, 255 - i, 7, 255]);
      const src = encodeDataUri('image/png', png);
      payloads.set(src, { mime: 'image/png', bytes: png, lossless: true });
      moduleAssets.push({ key: `img${i}-0000${(0x1000 + i).toString(16)}`, src });
    }
    const gltf = await parseWith([FS.gltfPlugin], bytesOf(input({ slots: [], payloads, fallbacks: new Map(), moduleAssets })).buffer);
    const stash = (FS as Any).embeddedAssets(gltf.scene) as Map<string, unknown>;
    expect(stash.size).toBe(64);
    expect(warns).toEqual([]);
  });
});

