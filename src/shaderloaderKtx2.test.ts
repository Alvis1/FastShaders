/**
 * Phase 8, Step 3: loader 0.8's KTX2 section (13b-KTX2), executed.
 *
 * The REAL vendored `public/js/a-frame-shaderloader-0.8.js` runs in `vm`
 * through src/shaderloaderHarness.ts, with an `AFRAME.THREE` carrying the real
 * KTX2Loader / GLTFLoader / LoadingManager / FileLoader — and `window.THREE`
 * deliberately holding a bare namespace with none of them. That is the entry.js
 * trap the decoders section documents: on a page using the A-Frame bundle the
 * loader classes are reachable only through AFRAME.THREE.
 *
 * Everything here is a real transcode: three's own basis_transcoder.js/.wasm in
 * an in-process Worker (src/test-utils `installInProcessWorker`), over three's
 * own KTX2 fixtures and GLBs built from them. Step 0 (ktx2Transcode.test.ts)
 * pins what THREE does; this pins what the LOADER does with it.
 *
 * Worker, `self`, `ProgressEvent` and `createImageBitmap` are stubbed per test
 * and undone in afterEach (`isolate: false` shares a worker's globals), and
 * every sandbox's shared KTX2Loader is disposed there through configure(null).
 */
import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import {
  DefaultLoadingManager,
  RGBA_ASTC_4x4_Format,
  RGBA_BPTC_Format,
  type CompressedTexture,
  type Mesh,
  type MeshStandardMaterial,
  type Texture,
} from 'three';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  CURRENT_LOADER,
  evalLoader,
  inertGltfModelEntry,
  loaderAvailable,
  loaderText,
  type FastShadersApi,
} from '@/shaderloaderHarness';
import { safeJsonReviver } from '@/utils/safeJson';
import { fakeRenderer, installInProcessWorker, makeKtx2Glb, type InProcessWorkerStats } from '@/test-utils';

/* ── files ─────────────────────────────────────────────────────────────── */

const at = (rel: string) => new URL(rel, import.meta.url);
const fixture = (f: string) => readFileSync(at(`./engine/fixtures/ktx2/${f}`));
const basis = (f: string) => readFileSync(at(`../node_modules/three/examples/jsm/libs/basis/${f}`));

/** The decoder files as a host hands them over: data: URLs the sandbox can read. */
const TRANSCODER: Record<string, string> = {
  'basis_transcoder.js': `data:text/javascript;base64,${basis('basis_transcoder.js').toString('base64')}`,
  'basis_transcoder.wasm': `data:application/wasm;base64,${basis('basis_transcoder.wasm').toString('base64')}`,
};
/** An object URL nothing was registered under: every transcoder fetch fails. */
const BROKEN: Record<string, string> = {
  'basis_transcoder.js': 'blob:fs-decoder-missing',
  'basis_transcoder.wasm': 'blob:fs-decoder-missing',
};

const UASTC = () => new Uint8Array(fixture('2d_uastc.ktx2'));
const bufferOf = (f: string): ArrayBuffer => {
  const b = fixture(f);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

const KTX2_PIXEL_WIDTH = 20;
const KTX2_FACE_COUNT = 36;
/** Over KTX2_MAX_SIDE_UNCOMPRESSED (4096), inside KTX2_MAX_SIDE_COMPRESSED. */
const OVER_UNCOMPRESSED_SIDE = 8192;

/** One little-endian u32 of a fixture's header replaced, in place. */
function patchedBytes(bytes: Uint8Array, offset: number, value: number): Uint8Array {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(offset, value, true);
  return bytes;
}

/** A copy of 2d_uastc.ktx2 with one little-endian u32 of its header replaced. */
function patchedKtx2(offset: number, value: number): Uint8Array {
  return patchedBytes(UASTC(), offset, value);
}

type GlbJson = {
  bufferViews: Array<{ byteOffset: number; byteLength: number }>;
  images: Array<Record<string, unknown>>;
};

function splitGlb(buf: ArrayBuffer): { json: GlbJson; bin: Uint8Array } {
  const dv = new DataView(buf);
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, jsonLen)), safeJsonReviver) as GlbJson;
  const binAt = 20 + jsonLen;
  return { json, bin: new Uint8Array(buf, binAt + 8, dv.getUint32(binAt, true)) };
}

/** The committed magenta PNG, reused so no zlib build can change these bytes. */
function fallbackPng(): Uint8Array {
  const { json, bin } = splitGlb(bufferOf('quad-uastc-fallback.glb'));
  const view = json.bufferViews[json.images[1].bufferView as number];
  return bin.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

/**
 * The same GLB with its KTX2 image served from a URI instead of a bufferView —
 * the shape a hostile file takes, and the one the manager chain must neutralise.
 * The JSON chunk is rebuilt (0x20-padded); the BIN chunk is copied verbatim.
 */
function withKtx2Uri(glb: ArrayBuffer, uri: string): ArrayBuffer {
  const dv = new DataView(glb);
  const jsonLen = dv.getUint32(12, true);
  const { json, bin } = splitGlb(glb);
  json.images[0] = { name: 'hostile', uri, mimeType: 'image/ktx2' };
  const binLen = dv.getUint32(20 + jsonLen, true);

  let text = JSON.stringify(json);
  while (text.length % 4 !== 0) text += ' ';
  const jsonBytes = new TextEncoder().encode(text);
  const out = new ArrayBuffer(12 + 8 + jsonBytes.length + 8 + binLen);
  const o = new DataView(out);
  o.setUint32(0, 0x46546c67, true);
  o.setUint32(4, 2, true);
  o.setUint32(8, out.byteLength, true);
  o.setUint32(12, jsonBytes.length, true);
  o.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(out, 20, jsonBytes.length).set(jsonBytes);
  o.setUint32(20 + jsonBytes.length, binLen, true);
  o.setUint32(24 + jsonBytes.length, 0x004e4942, true);
  new Uint8Array(out, 28 + jsonBytes.length, binLen).set(bin);
  return out;
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

interface Ktx2Shim {
  isFastShadersKtx2Shim?: true;
}
interface DecodersApi {
  FILES: Record<string, string>;
  configure(opts: unknown): DecodersApi;
  install(loader: unknown, ctx?: unknown): unknown;
  readonly lastError: string;
  readonly ktx2Stats: { transcoded: number; fallbacks: number; missing: number };
  readonly ktx2Formats: Record<string, boolean> | null;
}
interface World {
  api: FastShadersApi;
  decoders: DecodersApi;
  info: string[];
  gltfModel: ReturnType<typeof inertGltfModelEntry>;
}

let workers: InProcessWorkerStats;
let consoleError: MockInstance;
let consoleWarn: MockInstance;
const decodedBlobTypes: string[] = [];
const worlds: World[] = [];

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
  // GLTFLoader logs every failed texture; KTX2Loader warns about co-existing
  // loaders (one per sandbox, and a sandbox cannot dispose another's).
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  // configure(null) disposes the shared KTX2Loader (its worker and blob URL).
  for (const world of worlds.splice(0)) world.decoders.configure(null);
  decodedBlobTypes.length = 0;
  DefaultLoadingManager.setURLModifier(undefined as unknown as (url: string) => string);
  consoleError.mockRestore();
  consoleWarn.mockRestore();
  vi.unstubAllGlobals();
});

/* ── the loader, in a sandbox ────────────────────────────────────────────── */

/**
 * A fresh document: every piece of KTX2 state (the shared loader, the memoized
 * ready, the formats snapshot, the stats, the console line) is per evaluation.
 * `console.info` is captured, since the one format line is an assertion.
 */
function makeWorld(): World {
  const info: string[] = [];
  const gltfModel = inertGltfModelEntry();
  const { FastShaders } = evalLoader(CURRENT_LOADER, {
    // The bundle's ENRICHED namespace: three's own exports plus the loader
    // classes, exactly as a-frame-180-a-01.min.js builds it
    // (`THREE = {...three}; THREE.GLTFLoader = …; THREE.KTX2Loader = …`).
    aframeThree: { ...THREE, KTX2Loader, GLTFLoader },
    aframeComponents: { 'gltf-model': gltfModel },
    // …while the bare global has no KTX2Loader at all (the entry.js trap).
    THREE: { REVISION: THREE.REVISION },
    globals: { console: { log() {}, warn() {}, error() {}, info: (m: string) => info.push(m) } },
  });
  if (!FastShaders) throw new Error('0.8 installed no FastShaders api');
  const world: World = { api: FastShaders, decoders: FastShaders.decoders as DecodersApi, gltfModel, info };
  worlds.push(world);
  return world;
}

/** configure() with a resolver for the basis files only (Draco/meshopt unresolved). */
function configureBasis(world: World, files: Record<string, string> = TRANSCODER): void {
  world.decoders.configure({ resolve: (f: string) => files[f] ?? null });
}

function install(world: World, loader: GLTFLoader, renderer: unknown): void {
  world.decoders.install(loader, { getRenderer: () => renderer });
}

function shimOf(loader: GLTFLoader): Ktx2Shim | null {
  return (loader as unknown as { ktx2Loader: Ktx2Shim | null }).ktx2Loader;
}

function baseColorMap(gltf: GLTF): Texture | null {
  let map: Texture | null = null;
  gltf.scene.traverse((o) => {
    if ((o as Mesh).isMesh) map = ((o as Mesh).material as MeshStandardMaterial).map;
  });
  return map;
}

const formatOf = (map: Texture | null) => (map as CompressedTexture | null)?.format;
const mimeOf = (map: Texture | null) => map?.userData.mimeType;

const requiredGlb = () => makeKtx2Glb({ ktx2: UASTC(), required: true });
const fallbackGlb = (ktx2: Uint8Array = UASTC()) =>
  makeKtx2Glb({ ktx2, fallbackPng: fallbackPng(), required: false });

const SLOW = 30_000; // a wasm compile per worker, on a loaded machine
const available = loaderAvailable(CURRENT_LOADER);

/* ── install ─────────────────────────────────────────────────────────────── */

describe.skipIf(!available)('0.8 equips a GLTFLoader with the KTX2 shim', () => {
  const CASES: ReadonlyArray<readonly [string, Record<string, string>, boolean]> = [
    ['both files', TRANSCODER, true],
    ['the .js only', { 'basis_transcoder.js': TRANSCODER['basis_transcoder.js'] }, false],
    ['the .wasm only', { 'basis_transcoder.wasm': TRANSCODER['basis_transcoder.wasm'] }, false],
    ['neither', {}, false],
  ];

  // NB the case is named by its LABEL: a data: URL in a test name floods every
  // reporter with the whole transcoder.
  for (const [label, files, equipped] of CASES) {
    it(`resolves ${label} → equipped: ${equipped}`, () => {
      const world = makeWorld();
      configureBasis(world, files);
      const loader = new GLTFLoader();
      install(world, loader, fakeRenderer(['texture-compression-astc']));
      expect(!!shimOf(loader)?.isFastShadersKtx2Shim).toBe(equipped);
    });
  }

  it('names both files in FILES, so a host can push exactly what it needs', () => {
    const world = makeWorld();
    expect(world.decoders.FILES.basisJs).toBe('basis_transcoder.js');
    expect(world.decoders.FILES.basisWasm).toBe('basis_transcoder.wasm');
  });

  it('respects a ktx2Loader the page set itself', () => {
    const world = makeWorld();
    configureBasis(world);
    const loader = new GLTFLoader();
    const mine = new KTX2Loader();
    loader.setKTX2Loader(mine);
    install(world, loader, fakeRenderer(['texture-compression-astc']));
    expect(shimOf(loader)).toBe(mine as unknown as Ktx2Shim);
    mine.dispose();
  });

  it('is idempotent, and configure(null) turns it off', () => {
    const world = makeWorld();
    configureBasis(world);
    const loader = new GLTFLoader();
    install(world, loader, fakeRenderer([]));
    const first = shimOf(loader);
    expect(first?.isFastShadersKtx2Shim).toBe(true);
    install(world, loader, fakeRenderer([]));
    expect(shimOf(loader)).toBe(first); // the DECODERS_INSTALLED symbol

    world.decoders.configure(null);
    const off = new GLTFLoader();
    install(world, off, fakeRenderer([]));
    expect(shimOf(off)).toBeNull();
  });

  it('never WRITES A-Frame\'s gltf-model basisTranscoderPath (its update detects support before init)', () => {
    const lines = loaderText(CURRENT_LOADER)
      .split('\n')
      .filter((l) => l.includes('basisTranscoderPath'));
    expect(lines.length).toBeGreaterThan(0); // the rule is written down…
    for (const line of lines) expect(line.trim().startsWith('//')).toBe(true); // …and only written down
  });
});

/* ── the lazy renderer ───────────────────────────────────────────────────── */

describe.skipIf(!available)('detectSupport waits for renderer.init()', () => {
  it(
    'transcodes to ASTC, initialises the renderer ONCE across two models, and never detects before init',
    async () => {
      const world = makeWorld();
      configureBasis(world);
      const renderer = fakeRenderer(['texture-compression-astc']);
      const detectedUninitialised: boolean[] = [];
      const real = KTX2Loader.prototype.detectSupport;
      const spy = vi
        .spyOn(KTX2Loader.prototype, 'detectSupport')
        .mockImplementation(function (this: KTX2Loader, r: Parameters<KTX2Loader['detectSupport']>[0]) {
          detectedUninitialised.push(!(r as unknown as { initialized: boolean }).initialized);
          return real.call(this, r);
        });
      try {
        for (let i = 0; i < 2; i++) {
          const loader = new GLTFLoader();
          install(world, loader, renderer);
          const map = baseColorMap(await loader.parseAsync(requiredGlb(), '')) as CompressedTexture | null;
          // A REAL transcode: three's own basis wasm, all six levels, 10x10
          // ASTC blocks of 16 bytes at level 0.
          expect([map?.isCompressedTexture, map?.format, map?.mipmaps?.length]).toEqual([
            true,
            RGBA_ASTC_4x4_Format,
            6,
          ]);
          expect((map?.mipmaps?.[0] as { data: Uint8Array }).data.byteLength).toBe(1600);
        }
        expect(renderer.initCalls).toBe(1); // the memoized ready, across both parses
        expect(detectedUninitialised).toEqual([false]);
        expect(workers.created).toBe(1); // one document, one loader, one worker
        expect(world.decoders.ktx2Stats).toEqual({ transcoded: 2, fallbacks: 0, missing: 0 });
      } finally {
        spy.mockRestore();
      }
    },
    SLOW,
  );

  it(
    'reports the formats it found, and says so on the console exactly once per document',
    async () => {
      const world = makeWorld();
      configureBasis(world);
      expect(world.decoders.ktx2Formats).toBeNull(); // nothing detected yet
      const loader = new GLTFLoader();
      install(world, loader, fakeRenderer(['texture-compression-astc', 'texture-compression-etc2']));
      await loader.parseAsync(requiredGlb(), '');
      expect(world.decoders.ktx2Formats).toEqual({
        astc: true,
        bptc: false,
        etc2: true,
        s3tc: false,
        etc1: false,
        pvrtc: false,
      });
      expect(world.info).toEqual(['FastShaders KTX2: transcoding for ASTC 4x4 (astc, etc2).']);

      const second = new GLTFLoader();
      install(world, second, fakeRenderer(['texture-compression-astc']));
      await second.parseAsync(requiredGlb(), '');
      expect(world.info).toHaveLength(1);
    },
    SLOW,
  );

  it(
    'names the BC7 target on a bptc-only GPU',
    async () => {
      const world = makeWorld();
      configureBasis(world);
      const loader = new GLTFLoader();
      install(world, loader, fakeRenderer(['texture-compression-bc']));
      expect(formatOf(baseColorMap(await loader.parseAsync(requiredGlb(), '')))).toBe(RGBA_BPTC_Format);
      expect(world.info).toEqual(['FastShaders KTX2: transcoding for BC7 (bptc).']);
    },
    SLOW,
  );

  it('falls back with a reason when no renderer is available at all', async () => {
    const world = makeWorld();
    configureBasis(world);
    const loader = new GLTFLoader();
    install(world, loader, null);
    expect(mimeOf(baseColorMap(await loader.parseAsync(fallbackGlb(), '')))).toBe('image/png');
    expect(world.decoders.lastError).toContain('KTX2 needs the renderer');
    expect(world.decoders.ktx2Stats).toEqual({ transcoded: 0, fallbacks: 1, missing: 0 });
    expect(workers.created).toBe(0);
  });
});

/* ── the dedicated manager ───────────────────────────────────────────────── */

describe.skipIf(!available)('the KTX2 manager chains DefaultLoadingManager', () => {
  it(
    'a hostile image uri meets the page\'s allowlist; the transcoder never does',
    async () => {
      const world = makeWorld();
      configureBasis(world);
      const seen: string[] = [];
      // The sandboxed preview's allowlist, as tslToPreviewHTML installs it.
      DefaultLoadingManager.setURLModifier((url: string) => {
        seen.push(url);
        return /^(blob:|data:)/.test(url) ? url : 'data:,';
      });
      const renderer = fakeRenderer(['texture-compression-astc']);

      // A real transcode first, so the transcoder has really been fetched…
      const ok = new GLTFLoader();
      install(world, ok, renderer);
      expect(formatOf(baseColorMap(await ok.parseAsync(requiredGlb(), '')))).toBe(RGBA_ASTC_4x4_Format);

      // …and then a KTX2 image the file points at an outside host.
      const hostile = new GLTFLoader();
      install(world, hostile, renderer);
      await expect(hostile.parseAsync(withKtx2Uri(requiredGlb(), 'https://example.invalid/x.ktx2'), '')).rejects.toBeTruthy();

      expect(seen).toContain('https://example.invalid/x.ktx2');
      expect(seen.some((u) => u.includes('basis_transcoder'))).toBe(false);
      expect(world.decoders.ktx2Stats).toEqual({ transcoded: 1, fallbacks: 0, missing: 1 });
    },
    SLOW,
  );
});

/* ── the fallback plugin ─────────────────────────────────────────────────── */

describe.skipIf(!available)('a failed transcode falls back instead of losing the texture', () => {
  it(
    'a basisu-USED texture shows its PNG, counted as a fallback',
    async () => {
      const world = makeWorld();
      configureBasis(world, BROKEN);
      const loader = new GLTFLoader();
      install(world, loader, fakeRenderer(['texture-compression-astc']));
      expect(mimeOf(baseColorMap(await loader.parseAsync(fallbackGlb(), '')))).toBe('image/png');
      expect(decodedBlobTypes).toEqual(['image/png']);
      expect(world.decoders.ktx2Stats).toEqual({ transcoded: 0, fallbacks: 1, missing: 0 });
      expect(world.decoders.lastError).not.toBe('');
    },
    SLOW,
  );

  it(
    'a basisu-REQUIRED texture has nothing to fall back to: the parse fails, counted as missing',
    async () => {
      const world = makeWorld();
      configureBasis(world, BROKEN);
      const loader = new GLTFLoader();
      install(world, loader, fakeRenderer(['texture-compression-astc']));
      await expect(loader.parseAsync(requiredGlb(), '')).rejects.toBeTruthy();
      expect(world.decoders.ktx2Stats).toEqual({ transcoded: 0, fallbacks: 0, missing: 1 });
    },
    SLOW,
  );
});

/* ── the header caps ─────────────────────────────────────────────────────── */

describe.skipIf(!available)('the 80-byte header is read before anything is transcoded', () => {
  it('an over-size texture falls back, and the reason names the limit', async () => {
    const world = makeWorld();
    configureBasis(world);
    const loader = new GLTFLoader();
    install(world, loader, fakeRenderer(['texture-compression-astc']));
    const glb = fallbackGlb(patchedKtx2(KTX2_PIXEL_WIDTH, 16384));
    expect(mimeOf(baseColorMap(await loader.parseAsync(glb, '')))).toBe('image/png');
    expect(world.decoders.lastError).toContain('8192 px');
    expect(world.decoders.ktx2Stats.fallbacks).toBe(1);
    expect(workers.created).toBe(0); // refused before a worker was ever built
  });

  // The 8192 cap is for a file that will REACH a compressed format. Two shapes
  // read off the same 80 bytes cannot, whatever the GPU reports, and must take
  // the 4096 (64 MB) cap instead — or they transcode/allocate RGBA8 at 8192².
  it('an ETC1S texture takes the uncompressed cap on an ASTC-only GPU: it can never become ASTC', async () => {
    const world = makeWorld();
    configureBasis(world);
    const loader = new GLTFLoader();
    install(world, loader, fakeRenderer(['texture-compression-astc']));
    // supercompressionScheme 1 (BasisLZ) is ETC1S, and r184's ASTC entry is
    // basisFormat [UASTC] with priorityETC1S Infinity — so this file falls to
    // the if-less RGBA32 entry: 8192² × 4 B at level 0 alone.
    const etc1s = patchedBytes(new Uint8Array(fixture('2d_etc1s.ktx2')), KTX2_PIXEL_WIDTH, OVER_UNCOMPRESSED_SIDE);
    expect(mimeOf(baseColorMap(await loader.parseAsync(fallbackGlb(etc1s), '')))).toBe('image/png');
    expect(world.decoders.lastError).toContain('4096 px');
    expect(workers.created).toBe(0); // refused before a worker was ever built
  }, SLOW);

  it('a RAW (vkFormat) texture takes the uncompressed cap: three never transcodes it', async () => {
    const world = makeWorld();
    configureBasis(world);
    const loader = new GLTFLoader();
    install(world, loader, fakeRenderer(['texture-compression-astc']));
    // 2d_rgba8.ktx2 declares vkFormat 43: three's _createTexture computes
    // needsTranscoder = (vkFormat === 0), so createRawTexture allocates
    // width × height × bytes from a file of a few KB with no transcoder at all.
    const raw = patchedBytes(new Uint8Array(fixture('2d_rgba8.ktx2')), KTX2_PIXEL_WIDTH, OVER_UNCOMPRESSED_SIDE);
    expect(mimeOf(baseColorMap(await loader.parseAsync(fallbackGlb(raw), '')))).toBe('image/png');
    expect(world.decoders.lastError).toContain('4096 px');
    expect(workers.created).toBe(0);
  }, SLOW);

  it('a cube map is refused: a glTF texture is 2D', async () => {
    const world = makeWorld();
    configureBasis(world);
    const loader = new GLTFLoader();
    install(world, loader, fakeRenderer(['texture-compression-astc']));
    const glb = fallbackGlb(patchedKtx2(KTX2_FACE_COUNT, 6));
    expect(mimeOf(baseColorMap(await loader.parseAsync(glb, '')))).toBe('image/png');
    expect(world.decoders.lastError).toContain('2D KTX2 textures');
    expect(workers.created).toBe(0);
  });

  it('bytes that are not a KTX2 file at all are refused by the identifier', async () => {
    const world = makeWorld();
    configureBasis(world);
    const loader = new GLTFLoader();
    install(world, loader, fakeRenderer(['texture-compression-astc']));
    const notKtx2 = UASTC();
    notKtx2[0] = 0x00;
    expect(mimeOf(baseColorMap(await loader.parseAsync(fallbackGlb(notKtx2), '')))).toBe('image/png');
    expect(world.decoders.lastError).toContain('not a KTX2 file');
    expect(workers.created).toBe(0);
  });
});

/* ── the A-Frame hook ────────────────────────────────────────────────────── */

describe.skipIf(!available)('the gltf-model init wrap supplies the renderer', () => {
  it(
    'reads el.sceneEl.renderer LAZILY, so a scene with none yet still equips the loader',
    async () => {
      const world = makeWorld();
      configureBasis(world);
      const loader = new GLTFLoader();
      const renderer = fakeRenderer(['texture-compression-astc']);
      // A gltf-model component as A-Frame builds one: the hook runs its init.
      const comp: Record<string, unknown> = { loader, el: { sceneEl: {} }, system: { data: {} } };
      (world.gltfModel.Component.prototype.init as () => void).call(comp);
      expect(shimOf(loader)?.isFastShadersKtx2Shim).toBe(true);

      // The renderer appears only later, exactly as on a booting scene.
      (comp.el as { sceneEl: Record<string, unknown> }).sceneEl.renderer = renderer;
      expect(formatOf(baseColorMap(await loader.parseAsync(requiredGlb(), '')))).toBe(RGBA_ASTC_4x4_Format);
      expect(renderer.initCalls).toBe(1);
    },
    SLOW,
  );
});
