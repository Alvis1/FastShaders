/**
 * Phase 8, Step 0: the KTX2 path executed for REAL in node — three r184's own
 * KTX2Loader and GLTFLoader, three r184's own basis_transcoder.js/.wasm
 * (node_modules/three/examples/jsm/libs/basis), over three r184's own KTX2 test
 * textures (src/engine/fixtures/ktx2/, MIT) and the two GLBs made from them by
 * scripts/gen-ktx2-fixture-glbs.mjs.
 *
 * No FastShaders code runs here yet. These are the facts the loader's KTX2
 * section is built on — transcode targets per feature set, ETC1S never reaching
 * ASTC, a basisu texture never Y-flipped, stock three LOSING the fallback when a
 * transcode fails, a same-name plugin restoring it, and the transcode target
 * frozen per worker — and each one fails loudly the moment a three bump
 * changes it (the sha256 pins fail first).
 *
 * KTX2Loader transcodes in a blob Worker, which installInProcessWorker() runs
 * in node:vm. The transcoder is served through a LoadingManager mapping
 * `fs-decoder:/basis_transcoder.*` to data: URLs. Worker, `self`,
 * `ProgressEvent` and `createImageBitmap` are stubbed per test and undone in
 * afterEach (`isolate: false`), and every KTX2Loader is disposed there.
 */
import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import {
  LoadingManager,
  RGBAFormat,
  RGBA_ASTC_4x4_Format,
  RGBA_BPTC_Format,
  RGB_ETC2_Format,
  SRGBColorSpace,
  type CompressedTexture,
  type Mesh,
  type MeshStandardMaterial,
  type Texture,
} from 'three';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { GLTFLoader, type GLTF, type GLTFLoaderPlugin, type GLTFParser } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { safeJsonReviver } from '@/utils/safeJson';
import {
  HAS_FEATURE_BEFORE_INIT,
  fakeRenderer,
  installInProcessWorker,
  makeKtx2Glb,
  type InProcessWorkerStats,
} from '@/test-utils';

/* ── files ─────────────────────────────────────────────────────────────── */

const at = (rel: string) => new URL(rel, import.meta.url);
const fixture = (f: string) => readFileSync(at(`./engine/fixtures/ktx2/${f}`));
const threeFile = (rel: string) => readFileSync(at(`../node_modules/three/${rel}`));
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
/** A FRESH ArrayBuffer every call: a transcode transfers (detaches) it. */
const bufferOf = (f: string): ArrayBuffer => {
  const b = fixture(f);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

const KTX2_SHA256: ReadonlyArray<[string, number, string]> = [
  ['2d_uastc.ktx2', 2560, '21b6912cae1f074ae3eda1b751f43c36eafc7eb83f3af71f85bba2ccbafce125'],
  ['2d_etc1s.ktx2', 966, 'e56ddcc757fc73ff06bb0dac2a3533ce79c1e196ad895a3ff7dcc4d9de6b9d5d'],
  ['2d_rgba8.ktx2', 8888, '93c7b4c9eaecd6144ec6c6292b3408f57d9c557e060f2e2e2d53df8c195fe3d8'],
];
const TRANSCODER_SHA256: ReadonlyArray<[string, number, string]> = [
  ['basis_transcoder.js', 57529, '8478b5b6d6b74e7d3082b89f6417321d8d1dc0307f2b30d4484bb11b441696a1'],
  ['basis_transcoder.wasm', 527333, '6cf17dc889352c42e9acf8897107978d127005fe3386c36a0e3845e27967630a'],
];

const basis = (f: string) => threeFile(`examples/jsm/libs/basis/${f}`);
const TRANSCODER = {
  js: `data:text/javascript;base64,${basis('basis_transcoder.js').toString('base64')}`,
  wasm: `data:application/wasm;base64,${basis('basis_transcoder.wasm').toString('base64')}`,
};
/** An object URL nothing was ever registered under: the fetch fails. */
const MISSING = { js: 'blob:fs-decoder-missing', wasm: 'blob:fs-decoder-missing' };

function transcoderManager(files: { js: string; wasm: string } = TRANSCODER): LoadingManager {
  const manager = new LoadingManager();
  manager.setURLModifier((url) =>
    url === 'fs-decoder:/basis_transcoder.js' ? files.js : url === 'fs-decoder:/basis_transcoder.wasm' ? files.wasm : url,
  );
  return manager;
}

/* ── the GLB and PNG, read back ─────────────────────────────────────────── */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

function splitGlb(buf: ArrayBuffer): { json: Any; bin: Uint8Array } {
  const dv = new DataView(buf);
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, jsonLen)), safeJsonReviver);
  const binAt = 20 + jsonLen;
  return { json, bin: new Uint8Array(buf, binAt + 8, dv.getUint32(binAt, true)) };
}

function imageBytes(buf: ArrayBuffer, image: number): Uint8Array {
  const { json, bin } = splitGlb(buf);
  const view = json.bufferViews[json.images[image].bufferView];
  return bin.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

/** Width, height and the set of RGB colours of an 8-bit RGB, unfiltered PNG. */
function readRgbPng(png: Uint8Array): { width: number; height: number; colours: Set<string> } {
  const b = Buffer.from(png);
  expect([...b.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  for (let p = 8; p < b.length; ) {
    const len = b.readUInt32BE(p);
    const type = b.toString('ascii', p + 4, p + 8);
    const data = b.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      expect([...data.subarray(8, 13)]).toEqual([8, 2, 0, 0, 0]);
    } else if (type === 'IDAT') idat.push(data);
    p += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const colours = new Set<string>();
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    expect(raw[row]).toBe(0);
    for (let x = 0; x < width; x++) colours.add(raw.subarray(row + 1 + x * 3, row + 4 + x * 3).toString('hex'));
  }
  return { width, height, colours };
}

/* ── per-test state ─────────────────────────────────────────────────────── */

class ProgressEventStub {
  constructor(
    readonly type: string,
    init?: object,
  ) {
    Object.assign(this, init ?? {});
  }
}

let workers: InProcessWorkerStats;
let consoleError: MockInstance;
const decodedBlobTypes: string[] = [];
const loaders: KTX2Loader[] = [];

beforeEach(() => {
  workers = installInProcessWorker();
  vi.stubGlobal('self', globalThis); // GLTFLoader reads self.URL
  vi.stubGlobal('ProgressEvent', ProgressEventStub); // FileLoader's streaming path
  // GLTFLoader picks ImageBitmapLoader when createImageBitmap exists; this one
  // records what it was asked to decode instead of decoding it.
  vi.stubGlobal('createImageBitmap', async (blob: Blob) => {
    decodedBlobTypes.push(blob.type);
    return { width: 40, height: 40, close() {} };
  });
  // GLTFLoader logs every failed texture, the worker every failed transcode.
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  for (const loader of loaders.splice(0)) loader.dispose();
  decodedBlobTypes.length = 0;
  consoleError.mockRestore();
  vi.unstubAllGlobals();
});

type Renderer = Parameters<KTX2Loader['detectSupport']>[0];

/** A KTX2Loader on the transcoder manager, `detectSupport`ed on an INITIALISED fake. */
async function ktx2For(features: readonly string[], files = TRANSCODER): Promise<KTX2Loader> {
  const renderer = fakeRenderer(features);
  await renderer.init();
  const loader = new KTX2Loader(transcoderManager(files)).setTranscoderPath('fs-decoder:/');
  loader.detectSupport(renderer as unknown as Renderer);
  loaders.push(loader);
  return loader;
}

function transcode(loader: KTX2Loader, file: string): Promise<CompressedTexture> {
  return new Promise((resolve, reject) => loader.parse(bufferOf(file), resolve, reject));
}

function parseGlb(file: string, setup: (gltf: GLTFLoader) => void = () => {}): Promise<GLTF> {
  const loader = new GLTFLoader();
  setup(loader);
  return loader.parseAsync(bufferOf(file), '');
}

function baseColorMap(gltf: GLTF): Texture | null {
  let map: Texture | null = null;
  gltf.scene.traverse((o) => {
    if ((o as Mesh).isMesh) map = ((o as Mesh).material as MeshStandardMaterial).map;
  });
  return map;
}

/**
 * The shape the loader's own fallback plugin takes: NAMED like three's builtin
 * so it REPLACES it (GLTFLoader keys plugins by name), loads the basisu source,
 * and falls back to the core `source` when that yields nothing.
 */
class BasisUWithFallback {
  readonly name = 'KHR_texture_basisu';
  calls = 0;
  constructor(private readonly parser: GLTFParser) {}
  loadTexture(index: number): Promise<Texture | null> | null {
    const def = this.parser.json.textures[index];
    const source = def.extensions?.KHR_texture_basisu?.source;
    if (source === undefined) return null;
    this.calls++;
    const ktx2 = this.parser.options.ktx2Loader;
    // loadTextureImage resolves null (never rejects) when the image fails.
    const basisu: Promise<Texture | null> = ktx2 ? this.parser.loadTextureImage(index, source, ktx2) : Promise.resolve(null);
    return basisu.then((tex) => tex ?? (def.source !== undefined ? this.parser.loadTexture(index) : null));
  }
}

const SLOW = 30_000; // wasm compile per worker; heavy machine load

/* ── the inputs ──────────────────────────────────────────────────────────── */

describe('the KTX2 fixtures are three r184\'s own, untouched', () => {
  it.each(KTX2_SHA256)('%s is %i bytes, sha256 %s', (file, bytes, digest) => {
    const b = fixture(file);
    expect(b.length).toBe(bytes);
    expect(sha256(b)).toBe(digest);
  });

  it('carry three\'s MIT licence beside them', () => {
    const text = fixture('LICENSE').toString('utf8');
    expect(text.startsWith('The MIT License')).toBe(true);
    expect(text).toContain('three.js authors');
  });

  it.each(TRANSCODER_SHA256)('the transcoder %s is three 0.184.0\'s (%i bytes, sha256 %s)', (file, bytes, digest) => {
    expect(JSON.parse(threeFile('package.json').toString('utf8'), safeJsonReviver).version).toBe('0.184.0');
    const b = basis(file);
    expect(b.length).toBe(bytes);
    expect(sha256(b)).toBe(digest);
  });

  it('match the container facts the README states (three\'s ktx-parse)', async () => {
    type Container = {
      vkFormat: number;
      pixelWidth: number;
      pixelHeight: number;
      levelCount: number;
      faceCount: number;
      layerCount: number;
      supercompressionScheme: number;
      dataFormatDescriptor: Array<{ colorModel: number; transferFunction: number; colorPrimaries: number }>;
      keyValue: Record<string, unknown>;
    };
    const KTX_PARSE = 'three/examples/jsm/libs/ktx-parse.module.js';
    const { read } = (await import(/* @vite-ignore */ KTX_PARSE)) as { read(b: Uint8Array): Container };
    const facts = (f: string) => {
      const c = read(new Uint8Array(fixture(f)));
      const d = c.dataFormatDescriptor[0];
      return [c.vkFormat, c.pixelWidth, c.pixelHeight, c.levelCount, c.faceCount, c.layerCount, c.supercompressionScheme,
        d.colorModel, d.transferFunction, d.colorPrimaries, 'KTXorientation' in c.keyValue];
    };
    expect(facts('2d_uastc.ktx2')).toEqual([0, 40, 40, 6, 1, 0, 0, 166, 2, 1, false]);
    expect(facts('2d_etc1s.ktx2')).toEqual([0, 40, 40, 6, 1, 0, 1, 163, 2, 1, false]);
    expect(facts('2d_rgba8.ktx2')).toEqual([43, 40, 40, 6, 1, 0, 0, 1, 2, 1, false]);
  });

  it('makeKtx2Glb reproduces the two committed GLBs byte for byte', () => {
    const ktx2 = new Uint8Array(fixture('2d_uastc.ktx2'));
    const required = bufferOf('quad-uastc-required.glb');
    const fallback = bufferOf('quad-uastc-fallback.glb');
    // The committed PNG is reused, so a different zlib build cannot fail this.
    const png = imageBytes(fallback, 1);
    expect(new Uint8Array(makeKtx2Glb({ ktx2, required: true }))).toEqual(new Uint8Array(required));
    expect(new Uint8Array(makeKtx2Glb({ ktx2, fallbackPng: png, required: false }))).toEqual(new Uint8Array(fallback));

    expect(imageBytes(required, 0)).toEqual(ktx2);
    expect(imageBytes(fallback, 0)).toEqual(ktx2);
    const r = splitGlb(required).json;
    const f = splitGlb(fallback).json;
    expect(r.extensionsRequired).toEqual(['KHR_texture_basisu']);
    expect(r.textures[0].source).toBeUndefined();
    expect(f.extensionsUsed).toEqual(['KHR_texture_basisu']);
    expect(f.extensionsRequired).toBeUndefined();
    expect(f.images.map((i: Any) => i.mimeType)).toEqual(['image/ktx2', 'image/png']);
  });

  it('the fallback is an unmistakable 40x40 solid-magenta PNG', () => {
    const png = readRgbPng(imageBytes(bufferOf('quad-uastc-fallback.glb'), 1));
    expect([png.width, png.height, [...png.colours]]).toEqual([40, 40, ['ff00ff']]);
  });
});

describe('fakeRenderer is r184\'s Renderer as detectSupport sees it', () => {
  it('throws r184\'s own error from hasFeature before init, so detectSupport cannot run at install time', async () => {
    const source = threeFile('src/renderers/common/Renderer.js').toString('utf8');
    expect(source).toContain(`'${HAS_FEATURE_BEFORE_INIT}'`);

    const renderer = fakeRenderer(['texture-compression-astc']);
    const loader = new KTX2Loader();
    expect(() => loader.detectSupport(renderer as unknown as Renderer)).toThrow(HAS_FEATURE_BEFORE_INIT);

    // init() is memoized like r184's _initPromise; initCalls counts the calls.
    const first = renderer.init();
    expect(renderer.init()).toBe(first);
    await first;
    expect([renderer.initCalls, renderer.initialized]).toEqual([2, true]);
    expect(() => loader.detectSupport(renderer as unknown as Renderer)).not.toThrow();
    expect(loader.workerConfig.astcSupported).toBe(true);
    expect(loader.workerConfig.bptcSupported).toBe(false);
  });

  it('the WebGL variant answers the extension names KTX2Loader asks for', () => {
    const loader = new KTX2Loader();
    loader.detectSupport(fakeRenderer(['texture-compression-etc2'], { webgpu: false }) as unknown as Renderer);
    expect([loader.workerConfig.etc2Supported, loader.workerConfig.astcSupported]).toEqual([true, false]);
  });
});

/* ── real transcodes ─────────────────────────────────────────────────────── */

describe('UASTC transcodes to whatever the GPU has, all 6 levels', () => {
  // [features, format, level-0 bytes]: 40x40 is 10x10 blocks, 16 B per ASTC/BC7
  // block, 8 B per ETC2 RGB block, and 4 B per pixel uncompressed.
  it.each([
    [['texture-compression-astc'], RGBA_ASTC_4x4_Format, 1600],
    [['texture-compression-bc'], RGBA_BPTC_Format, 1600],
    [['texture-compression-etc2'], RGB_ETC2_Format, 800],
    [[], RGBAFormat, 6400],
  ] as const)(
    '%j → format %i',
    async (features, format, bytes) => {
      const tex = await transcode(await ktx2For(features), '2d_uastc.ktx2');
      expect(tex.isCompressedTexture).toBe(true);
      expect(tex.format).toBe(format);
      expect(tex.mipmaps).toHaveLength(6);
      const level0 = tex.mipmaps[0] as { data: Uint8Array; width: number; height: number };
      expect([level0.width, level0.height, level0.data.byteLength]).toEqual([40, 40, bytes]);
      expect(tex.colorSpace).toBe(SRGBColorSpace); // the DFD's sRGB transfer
      expect(workers.created).toBe(1);
    },
    SLOW,
  );

  it(
    'through a classic WebGL renderer (extensions.has, no init) as well',
    async () => {
      const loader = new KTX2Loader(transcoderManager()).setTranscoderPath('fs-decoder:/');
      loader.detectSupport(fakeRenderer(['texture-compression-astc'], { webgpu: false }) as unknown as Renderer);
      loaders.push(loader);
      expect((await transcode(loader, '2d_uastc.ktx2')).format).toBe(RGBA_ASTC_4x4_Format);
    },
    SLOW,
  );
});

describe('ETC1S never becomes ASTC (the Quest format)', () => {
  it(
    'ASTC only → uncompressed RGBA8',
    async () => {
      const tex = await transcode(await ktx2For(['texture-compression-astc']), '2d_etc1s.ktx2');
      expect(tex.format).toBe(RGBAFormat);
      expect((tex.mipmaps[0] as { data: Uint8Array }).data.byteLength).toBe(6400);
    },
    SLOW,
  );

  it(
    'ASTC + ETC2 → ETC2',
    async () => {
      const loader = await ktx2For(['texture-compression-astc', 'texture-compression-etc2']);
      expect((await transcode(loader, '2d_etc1s.ktx2')).format).toBe(RGB_ETC2_Format);
    },
    SLOW,
  );
});

describe('KHR_texture_basisu through the real GLTFLoader', () => {
  it(
    'a REQUIRED basisu texture loads as a CompressedTexture that is never Y-flipped',
    async () => {
      const ktx2 = await ktx2For(['texture-compression-astc']);
      const map = baseColorMap(await parseGlb('quad-uastc-required.glb', (g) => g.setKTX2Loader(ktx2)));
      expect(map?.isTexture).toBe(true);
      const tex = map as CompressedTexture;
      expect([tex.isCompressedTexture, tex.format, tex.flipY, tex.colorSpace, tex.userData.mimeType]).toEqual([
        true,
        RGBA_ASTC_4x4_Format,
        false,
        SRGBColorSpace,
        'image/ktx2',
      ]);
    },
    SLOW,
  );

  it('a REQUIRED basisu texture with no KTX2 loader fails the whole parse', async () => {
    await expect(parseGlb('quad-uastc-required.glb')).rejects.toThrow(
      'setKTX2Loader must be called before loading KTX2 textures',
    );
  });

  it(
    'a basisu-USED texture prefers the KTX2 source when it transcodes (the PNG is never decoded)',
    async () => {
      const ktx2 = await ktx2For(['texture-compression-astc']);
      const map = baseColorMap(await parseGlb('quad-uastc-fallback.glb', (g) => g.setKTX2Loader(ktx2)));
      expect((map as CompressedTexture | null)?.format).toBe(RGBA_ASTC_4x4_Format);
      expect(decodedBlobTypes).toEqual([]);
    },
    SLOW,
  );

  it('a basisu-USED texture with no KTX2 loader shows its PNG fallback (today\'s behaviour)', async () => {
    const map = baseColorMap(await parseGlb('quad-uastc-fallback.glb'));
    expect([map?.isTexture, (map as CompressedTexture | null)?.isCompressedTexture, map?.userData.mimeType]).toEqual([
      true,
      undefined,
      'image/png',
    ]);
    expect(decodedBlobTypes).toEqual(['image/png']);
  });

  it(
    'STOCK three LOSES that fallback when the transcode fails: no texture at all',
    async () => {
      const broken = await ktx2For(['texture-compression-astc'], MISSING);
      const map = baseColorMap(await parseGlb('quad-uastc-fallback.glb', (g) => g.setKTX2Loader(broken)));
      expect(map).toBeNull();
      expect(decodedBlobTypes).toEqual([]); // the PNG was never even tried
      expect(consoleError.mock.calls.some((c) => String(c[0]).includes("Couldn't load texture"))).toBe(true);
    },
    SLOW,
  );

  it(
    'a same-name KHR_texture_basisu plugin REPLACES the builtin and restores the fallback',
    async () => {
      const broken = await ktx2For(['texture-compression-astc'], MISSING);
      let plugin: BasisUWithFallback | undefined;
      const map = baseColorMap(
        await parseGlb('quad-uastc-fallback.glb', (g) =>
          g.setKTX2Loader(broken).register((parser) => (plugin = new BasisUWithFallback(parser)) as unknown as GLTFLoaderPlugin),
        ),
      );
      // Had the builtin run first it would have committed to the KTX2 source
      // and resolved no texture, as in the test above.
      expect(plugin?.calls).toBe(1);
      expect(map?.userData.mimeType).toBe('image/png');
      expect(decodedBlobTypes).toEqual(['image/png']);
    },
    SLOW,
  );
});

describe('the transcode target is frozen into the worker at its creation', () => {
  it(
    'a reused loader keeps its first target however detectSupport changes afterwards',
    async () => {
      const loader = await ktx2For(['texture-compression-astc']);
      expect((await transcode(loader, '2d_uastc.ktx2')).format).toBe(RGBA_ASTC_4x4_Format);

      const bc = fakeRenderer(['texture-compression-bc']);
      await bc.init();
      loader.detectSupport(bc as unknown as Renderer);
      expect(loader.workerConfig.bptcSupported).toBe(true);
      // A fresh loader on this config gives BC7; the reused one's worker does not.
      expect((await transcode(loader, '2d_uastc.ktx2')).format).toBe(RGBA_ASTC_4x4_Format);

      const astcEtc2 = fakeRenderer(['texture-compression-astc', 'texture-compression-etc2']);
      await astcEtc2.init();
      loader.detectSupport(astcEtc2 as unknown as Renderer);
      // ETC2 would be picked on a fresh loader (see above); the worker still has
      // the ASTC-only config, so ETC1S falls to RGBA8.
      expect((await transcode(loader, '2d_etc1s.ktx2')).format).toBe(RGBAFormat);
      expect(workers.created).toBe(1);
    },
    SLOW,
  );
});
