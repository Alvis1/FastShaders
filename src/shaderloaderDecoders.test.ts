/**
 * shaderloader 0.8's MESH DECODERS (section 13b), executed for real: the
 * vendored loader in `vm` (src/shaderloaderHarness.ts), three r184's own
 * GLTFLoader and DRACOLoader in the main realm, and the vendored decoder files
 * from public/js/decoders decoding the two committed fixtures
 * (src/engine/fixtures/compressed/, made by scripts/gen-compressed-fixtures.mjs).
 *
 * The sandbox reproduces the bundle's trap: `THREE` is the bare three
 * namespace, and DRACOLoader/GLTFLoader exist only on `AFRAME.THREE`.
 *
 * DRACOLoader decodes in a Worker built from a blob: URL of the wrapper text.
 * Node has no Worker, so `InProcessWorker` runs that exact source in a fresh
 * `vm` context and structured-clones messages both ways, as a real worker's
 * postMessage does. Worker, `self`, `createImageBitmap` and `ProgressEvent`
 * are stubbed per test and undone in afterEach (`isolate: false`), as is the
 * DefaultLoadingManager modifier test (b) installs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolveObjectURL } from 'node:buffer';
import path from 'node:path';
import vm from 'node:vm';
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { safeJsonReviver } from '@/utils/safeJson';
import {
  REPO,
  evalLoader,
  inertGltfModelEntry,
  loaderAvailable,
  loaderText,
  makeLoaderSandbox,
  runLoaderIn,
  sliceBetween,
  type FastShadersApi,
} from './shaderloaderHarness';
import { GLTF_NODE_GLOBALS, glbBytes, packGlb } from './gltfTestFixtures';

const V = '0.8';
const DECODERS = path.join(REPO, 'public/js/decoders');
const FIXTURES = path.join(REPO, 'src/engine/fixtures/compressed');
const WRAPPER = 'draco_wasm_wrapper.js';
const WASM = 'draco_decoder.wasm';
const MESHOPT = 'meshopt_decoder.module.js';
const BASIS_JS = 'basis_transcoder.js';
const BASIS_WASM = 'basis_transcoder.wasm';
const ALL = [WRAPPER, WASM, MESHOPT];
const GSTATIC = 'https://www.gstatic.com/draco/versioned/decoders/1.5.7/';
const INSTALLED = Symbol.for('fastshaders.decoders');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/* ── a Worker for node: the real worker source, in its own realm ─────────── */

class InProcessWorker {
  static created = 0;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  private dead = false;
  private scope: Promise<Record<string, Any>>;

  constructor(url: string) {
    InProcessWorker.created++;
    const blob = resolveObjectURL(String(url));
    this.scope = (blob ? blob.text() : Promise.reject(new Error(`no blob at ${url}`))).then((src) => {
      const scope: Record<string, Any> = {
        console: { log() {}, warn() {}, error() {} },
        importScripts() {},
        location: { href: String(url) },
        setTimeout,
        clearTimeout,
        postMessage: (data: unknown) => {
          const copy = structuredClone(data);
          setTimeout(() => {
            if (!this.dead) this.onmessage?.({ data: copy });
          }, 0);
        },
      };
      vm.createContext(scope);
      // `self` must be the context's GLOBAL (it carries the builtins the
      // worker reads as self.Float32Array), not the sandbox object.
      vm.runInContext('this.self = this;', scope);
      vm.runInContext(src, scope, { filename: 'draco-worker.js' });
      return scope;
    });
  }

  postMessage(data: unknown): void {
    const copy = structuredClone(data);
    void this.scope.then((s) => {
      if (!this.dead) s.onmessage({ data: copy });
    });
  }

  terminate(): void {
    this.dead = true;
  }
}

/* ── the sandbox ────────────────────────────────────────────────────────── */

const blobUrls: string[] = [];
const blobOf = (bytes: Uint8Array | string): string => {
  const u = URL.createObjectURL(new Blob([typeof bytes === 'string' ? bytes : new Uint8Array(bytes)]));
  blobUrls.push(u);
  return u;
};
const decoderBytes = (f: string) => readFileSync(path.join(DECODERS, f));
const fixture = (f: string): ArrayBuffer => {
  const b = readFileSync(path.join(FIXTURES, f));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

/** A resolver answering blob: URLs of the vendored decoder bytes. */
function blobResolver(files: string[] = ALL) {
  const urls: Record<string, string> = Object.create(null);
  for (const f of files) urls[f] = blobOf(decoderBytes(f));
  const calls: string[] = [];
  return {
    urls,
    calls,
    resolve: (f: string) => {
      calls.push(f);
      return urls[f] ?? null;
    },
  };
}

/** The meshopt module through a data: import (node cannot import a blob: URL). */
const MESHOPT_DATA_URL =
  'data:text/javascript;base64,' + decoderBytes(MESHOPT).toString('base64');
const importMeshopt = () =>
  vi.fn((_url: string) => import(/* @vite-ignore */ MESHOPT_DATA_URL));

interface SystemData {
  dracoDecoderPath?: string;
}

/**
 * A registry entry shaped like A-Frame 1.8's gltf-model: init builds the
 * GLTFLoader and hands it the SYSTEM's DRACOLoader (A-Frame builds one aimed
 * at gstatic on every scene), exactly before the loader's hook runs.
 */
function gltfModelEntry(system: { data: SystemData } = { data: { dracoDecoderPath: GSTATIC } }) {
  const systemDraco = new DRACOLoader().setDecoderPath(String(system.data.dracoDecoderPath ?? ''));
  const entry = inertGltfModelEntry(function () {
    this.system = system;
    this.loader = new GLTFLoader();
    if (system.data.dracoDecoderPath) (this.loader as GLTFLoader).setDRACOLoader(systemDraco);
  });
  return { entry, systemDraco };
}

interface FreshOptions {
  scriptSrc?: string;
  aframeThree?: unknown;
  aframe?: boolean;
  system?: { data: SystemData };
}

const loaded: FastShadersApi[] = [];

function fresh(opts: FreshOptions = {}) {
  const { entry, systemDraco } = gltfModelEntry(opts.system);
  const ev = evalLoader(V, {
    THREE,
    aframe: opts.aframe ?? true,
    aframeThree: opts.aframeThree === undefined ? { ...THREE, DRACOLoader, GLTFLoader } : opts.aframeThree,
    aframeComponents: { 'gltf-model': entry },
    globals: {
      document: {
        currentScript: opts.scriptSrc === undefined ? null : { src: opts.scriptSrc },
        querySelectorAll: () => [],
      },
    },
  });
  if (!ev.FastShaders) throw new Error('0.8 installed no FastShaders api');
  const FS = ev.FastShaders as FastShadersApi;
  loaded.push(FS);
  /** A new gltf-model component, through the wrapped init; its GLTFLoader. */
  const modelLoader = (): Any => {
    const inst = new entry.Component() as Any;
    inst.init();
    return inst.loader;
  };
  return { FS, D: FS.decoders as Any, modelLoader, entry, systemDraco };
}

/** Parse the way A-Frame's gltf-model load() does: a synchronous throw is an error too. */
function aframeParse(loader: GLTFLoader, data: ArrayBuffer, ms = 4000): Promise<{ gltf?: Any; error?: Any }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms — a HANG`)), ms);
    const done = (r: { gltf?: Any; error?: Any }) => {
      clearTimeout(timer);
      resolve(r);
    };
    try {
      loader.parse(data, '', (gltf) => done({ gltf }), (error) => done({ error }));
    } catch (error) {
      done({ error });
    }
  });
}

function quadGeometry(gltf: Any): THREE.BufferGeometry {
  const mesh = gltf.scene.getObjectByName('Quad');
  if (!mesh || !mesh.isMesh) throw new Error('fixture has no Quad mesh');
  return mesh.geometry;
}

/** A GLB's JSON (through the shared reviver) and its BIN chunk. */
function splitGlb(buf: ArrayBuffer): { json: Any; bin: Uint8Array } {
  const dv = new DataView(buf);
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, jsonLen)), safeJsonReviver);
  const binAt = 20 + jsonLen;
  const binLen = dv.getUint32(binAt, true);
  return { json, bin: new Uint8Array(buf.slice(binAt + 8, binAt + 8 + binLen)) };
}

beforeEach(() => {
  for (const [k, v] of Object.entries(GLTF_NODE_GLOBALS)) vi.stubGlobal(k, v);
  vi.stubGlobal('Worker', InProcessWorker);
  InProcessWorker.created = 0;
});
afterEach(() => {
  // configure(null) disposes each document's shared DRACOLoader (its worker
  // and its worker-source blob URL).
  for (const FS of loaded.splice(0)) FS.decoders.configure(null);
  for (const u of blobUrls.splice(0)) URL.revokeObjectURL(u);
  THREE.DefaultLoadingManager.setURLModifier(undefined);
  vi.unstubAllGlobals();
});

describe.skipIf(!loaderAvailable(V))('shaderloader 0.8 decoders — Draco', () => {
  it('(a) decodes the Draco fixture on a gltf-model loader, through the wrapped init', async () => {
    const { D, modelLoader } = fresh();
    const r = blobResolver();
    D.configure({ resolve: r.resolve });
    const loader = modelLoader();
    expect(loader[INSTALLED]).toBe(true);
    expect(loader.dracoLoader).toBeInstanceOf(DRACOLoader);

    const { gltf, error } = await aframeParse(loader, fixture('tri-draco.glb'));
    expect(error).toBeUndefined();
    const g = quadGeometry(gltf);
    expect(g.getAttribute('position').count).toBe(4);
    expect(g.index?.count).toBe(6);
    expect([...new Set(g.getAttribute('position').array)].sort()).toEqual([0, 1]);
    expect(InProcessWorker.created).toBe(1);
    expect(D.lastError).toBe('');
  });

  it('(b) fetches through its OWN manager: DefaultLoadingManager sees nothing, the manager sees the two Draco names', async () => {
    // The sandbox's allowlist lives on DefaultLoadingManager; it must never be
    // consulted (or widened) for a decoder.
    const defaultSeen: string[] = [];
    THREE.DefaultLoadingManager.setURLModifier((u: string) => {
      defaultSeen.push(u);
      return /^(blob|data):/.test(u) ? u : 'data:,';
    });
    const { D, modelLoader } = fresh();
    const r = blobResolver();
    D.configure({ resolve: r.resolve });
    const loader = modelLoader();
    const manager = loader.dracoLoader.manager;
    expect(manager).not.toBe(THREE.DefaultLoadingManager);
    // LoadingManager keeps its modifier in a closure; FileLoader asks resolveURL.
    const managed: string[] = [];
    const resolveURL = manager.resolveURL.bind(manager);
    manager.resolveURL = (u: string) => {
      managed.push(u);
      return resolveURL(u);
    };

    const { error } = await aframeParse(loader, fixture('tri-draco.glb'));
    expect(error).toBeUndefined();
    expect(defaultSeen).toEqual([]);
    expect(managed.sort()).toEqual(['fs-decoder:/draco_decoder.wasm', 'fs-decoder:/draco_wasm_wrapper.js']);
    // Anything else the dedicated manager is asked for is unfetchable — and a
    // blob: URL, never a data: one (an empty worker would HANG, not fail).
    expect(resolveURL('fs-decoder:/../secrets.js')).toBe('blob:fs-decoder-missing');
    expect(resolveURL('https://evil.example/draco_decoder.wasm')).toBe('blob:fs-decoder-missing');
    expect(resolveURL('fs-decoder:/__proto__')).toBe('blob:fs-decoder-missing');
    expect(resolveURL('fs-decoder:/' + WASM)).toBe(r.urls[WASM]);
  });

  it('(d) with no Draco source in manage mode, the parse fails fast: no loader, a synchronous throw, model-error', async () => {
    const { D, modelLoader } = fresh();
    D.configure({ resolve: () => null });
    const loader = modelLoader();
    // A-Frame's own gstatic DRACOLoader (set by the original init) is REPLACED
    // by null: it would hang in a sandbox.
    expect(loader.dracoLoader).toBeNull();
    expect(() => loader.parse(fixture('tri-draco.glb'), '', () => {}, () => {})).toThrow(
      'No DRACOLoader instance provided',
    );
    const t0 = Date.now();
    const { error } = await aframeParse(loader, fixture('tri-draco.glb'), 2000);
    expect(String(error?.message)).toMatch(/No DRACOLoader/);
    expect(Date.now() - t0).toBeLessThan(2000);
    // One Draco file alone is no source either.
    const half = fresh();
    half.D.configure({ resolve: blobResolver([WRAPPER]).resolve });
    expect(half.modelLoader().dracoLoader).toBeNull();
  });

  it('(e) a decoder URL that stops resolving after install ends in an error, not a hang', async () => {
    // Revoked: fetch rejects.
    {
      const { D, modelLoader } = fresh();
      const r = blobResolver();
      D.configure({ resolve: r.resolve });
      const loader = modelLoader();
      for (const f of ALL) URL.revokeObjectURL(r.urls[f]);
      const { gltf, error } = await aframeParse(loader, fixture('tri-draco.glb'));
      expect(gltf).toBeUndefined();
      expect(error).toBeTruthy();
      expect(InProcessWorker.created).toBe(0);
    }
    // No longer answered: the manager maps it to the unfetchable MISSING URL.
    {
      const { D, modelLoader } = fresh();
      const r = blobResolver();
      let answering = true;
      D.configure({ resolve: (f: string) => (answering ? r.resolve(f) : null) });
      const loader = modelLoader();
      answering = false;
      const { gltf, error } = await aframeParse(loader, fixture('tri-draco.glb'));
      expect(gltf).toBeUndefined();
      expect(error).toBeTruthy();
    }
  });

  it('reads the loader classes from AFRAME.THREE (window.THREE is the bare namespace), or says why there are none', () => {
    // The bundle's trap, in both directions.
    expect((THREE as Any).DRACOLoader).toBeUndefined();
    const withAframe = fresh();
    withAframe.D.configure({ resolve: blobResolver().resolve });
    expect(withAframe.modelLoader().dracoLoader).toBeInstanceOf(DRACOLoader);

    const without = fresh({ aframeThree: { ...THREE } });
    without.D.configure({ resolve: blobResolver().resolve });
    expect(without.modelLoader().dracoLoader).toBeNull();
    expect(without.D.lastError).toBe('Draco decoder unavailable: this three build has no DRACOLoader.');
    without.D.clearError();
    expect(without.D.lastError).toBe('');
  });

  it('plain three.js: configure({ resolve, DRACOLoader, LoadingManager }) and install(new GLTFLoader())', async () => {
    const { FS, D } = fresh({ aframe: false, aframeThree: null });
    D.configure({ resolve: blobResolver().resolve, DRACOLoader, LoadingManager: THREE.LoadingManager });
    const loader = new GLTFLoader();
    expect(D.install(loader)).toBe(loader);
    const { gltf, error } = await aframeParse(loader, fixture('tri-draco.glb'));
    expect(error).toBeUndefined();
    expect(quadGeometry(gltf).getAttribute('position').count).toBe(4);
    expect(FS.decoders).toBe(D);
  });

  it("plain three.js, the README's own call: configure({ DRACOLoader }) with no resolve keeps decoders/ beside the script", () => {
    // DEC-1/DL1: configure() used to replace the self-located resolver with
    // null whenever `resolve` was absent, so this exact recipe set no Draco
    // loader, no meshopt decoder and an empty lastError.
    const readme = readFileSync(path.join(REPO, 'README.md'), 'utf8');
    const start = readme.indexOf('\n## Using the shader module with plain Three.js\n');
    expect(start).toBeGreaterThan(-1);
    const next = readme.indexOf('\n## ', start + 1);
    const section = readme.slice(start, next < 0 ? undefined : next);
    // DRACOLoader (and GLTFLoader) resolve through the import map's addons
    // entry; LoadingManager is core three, never an addon.
    expect(section).toContain('"three/addons/": "https://cdn.jsdelivr.net/npm/three@');
    expect(section).toContain("three/addons/loaders/DRACOLoader.js");
    expect(section).not.toMatch(/LoadingManager[^.]*three\/addons/);
    const call = /FastShaders\.decoders\.configure\(\{([^}]*)\}\)/.exec(section);
    expect(call, 'the README names the configure call').not.toBeNull();
    const classes: Record<string, unknown> = { DRACOLoader, LoadingManager: THREE.LoadingManager };
    const keys = call![1].split(',').map((k) => k.trim()).filter(Boolean);
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) expect(Object.keys(classes), `the README passes ${k}`).toContain(k);

    const src = 'https://cdn.jsdelivr.net/gh/Alvis1/a-frame-shaderloader@master/js/a-frame-shaderloader-0.8.js';
    const beside = 'https://cdn.jsdelivr.net/gh/Alvis1/a-frame-shaderloader@master/js/decoders/';
    const { FS, D } = fresh({ aframe: false, aframeThree: null, scriptSrc: src });
    FS.use(THREE);
    D.configure(Object.fromEntries(keys.map((k) => [k, classes[k]])));
    const loader = D.install(new GLTFLoader());
    expect(loader.dracoLoader).toBeInstanceOf(DRACOLoader);
    expect(loader.dracoLoader.manager.resolveURL('fs-decoder:/' + WASM)).toBe(beside + WASM);
    expect(loader.dracoLoader.manager.resolveURL('fs-decoder:/' + WRAPPER)).toBe(beside + WRAPPER);
    expect(loader.meshoptDecoder?.supported).toBe(true);
    expect(D.lastError).toBe('');
  });
});

describe.skipIf(!loaderAvailable(V))('shaderloader 0.8 decoders — meshopt', () => {
  it('(c) decodes the meshopt fixture with ONE lazy import; an uncompressed model imports nothing', async () => {
    const { D, modelLoader } = fresh();
    const importModule = importMeshopt();
    D.configure({
      resolve: (f: string) => (f === MESHOPT ? 'https://decoders.test/' + f : null),
      importModule,
    });

    // Uncompressed first: the shim is on the loader, and costs nothing.
    const plain = modelLoader();
    expect(plain.meshoptDecoder?.supported).toBe(true);
    const flat = await aframeParse(plain, glbBytes({ meshes: [{ primitives: [{}] }], nodes: [{ mesh: 0 }] }));
    expect(flat.error).toBeUndefined();
    expect(importModule).toHaveBeenCalledTimes(0);

    for (let i = 0; i < 2; i++) {
      const { gltf, error } = await aframeParse(modelLoader(), fixture('quad-meshopt.glb'));
      expect(error).toBeUndefined();
      const g = quadGeometry(gltf);
      expect(Array.from(g.getAttribute('position').array)).toEqual([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
      expect(Array.from(g.index!.array)).toEqual([0, 1, 2, 0, 2, 3]);
    }
    // Memoized per document: two models, one import.
    expect(importModule).toHaveBeenCalledTimes(1);
    expect(importModule).toHaveBeenCalledWith('https://decoders.test/' + MESHOPT);
  });

  it('(f) caps one model\'s decoded bytes at 256 MiB BEFORE allocating, and never imports the decoder for it', async () => {
    const { D, modelLoader } = fresh();
    const importModule = importMeshopt();
    D.configure({ resolve: (f: string) => (f === MESHOPT ? 'https://decoders.test/' + f : null), importModule });
    expect(D.MAX_MESHOPT_DECODED_BYTES).toBe(256 * 1024 * 1024);

    // BOTH views over the cap on their own, so the outcome cannot depend on
    // which one GLTFLoader decodes first.
    const { json, bin } = splitGlb(fixture('quad-meshopt.glb'));
    json.bufferViews[0].extensions.EXT_meshopt_compression.count = 2 ** 25; // × stride 12 = 384 MiB
    json.bufferViews[1].extensions.EXT_meshopt_compression.count = 2 ** 28; // × stride 2 = 512 MiB
    const { gltf, error } = await aframeParse(modelLoader(), packGlb(json, bin));
    expect(gltf).toBeUndefined();
    expect(String(error?.message)).toContain('over the 256 MB limit for one model');
    expect(D.lastError).toMatch(/^meshopt data would unpack to (384|512|896) MB, over the 256 MB limit for one model\.$/);
    expect(importModule).not.toHaveBeenCalled();

    // A malformed stride is refused the same way (0, and over the 256 maximum).
    D.clearError();
    const bad = splitGlb(fixture('quad-meshopt.glb'));
    bad.json.bufferViews[0].extensions.EXT_meshopt_compression.byteStride = 0;
    bad.json.bufferViews[1].extensions.EXT_meshopt_compression.byteStride = 260;
    const r2 = await aframeParse(modelLoader(), packGlb(bad.json, bad.bin));
    expect(r2.error).toBeTruthy();
    expect(D.lastError).toMatch(/^meshopt data is malformed/);
    expect(importModule).not.toHaveBeenCalled();
  });

  it('the cap is per MODEL: one long-lived loader gives every parse the full budget, and still refuses one over it', async () => {
    // A-Frame's gltf-model builds its GLTFLoader once and reuses it for every
    // src, so a running total kept per LOADER became a lifetime budget: the
    // second 192 MiB model was refused, and every model after it.
    const { D, modelLoader } = fresh();
    const real = ((await import(/* @vite-ignore */ MESHOPT_DATA_URL)) as Any).MeshoptDecoder;
    await real.ready;
    // Each view's REAL count by stride (12 and 2), so a view can CLAIM a huge
    // count — which is all the cap reads — without the test allocating it.
    const realCount = new Map<number, number>();
    for (const v of splitGlb(fixture('quad-meshopt.glb')).json.bufferViews) {
      const x = v.extensions.EXT_meshopt_compression;
      realCount.set(x.byteStride, x.count);
    }
    expect(realCount.size).toBe(2);
    const decoder = () => ({
      supported: true,
      ready: Promise.resolve(),
      decodeGltfBufferAsync: vi.fn((count: number, size: number, source: Uint8Array, mode: string, filter: string) =>
        real.decodeGltfBufferAsync(realCount.get(size), size, source, mode, filter),
      ),
    });
    const ours = decoder();
    D.configure({
      resolve: (f: string) => (f === MESHOPT ? 'https://decoders.test/' + f : null),
      importModule: () => Promise.resolve({ MeshoptDecoder: ours }),
    });
    const claiming = (count: number) => {
      const { json, bin } = splitGlb(fixture('quad-meshopt.glb'));
      json.bufferViews[0].extensions.EXT_meshopt_compression.count = count; // × stride 12
      return packGlb(json, bin);
    };
    const quad = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0];

    const loader = modelLoader();
    for (const label of ['first', 'second']) {
      const { gltf, error } = await aframeParse(loader, claiming(2 ** 24)); // 192 MiB
      expect(error, label).toBeUndefined();
      expect(Array.from(quadGeometry(gltf).getAttribute('position').array), label).toEqual(quad);
    }
    // One model over the cap is still refused, and the message is its OWN size.
    const over = await aframeParse(loader, claiming(2 ** 25)); // 384 MiB
    expect(over.gltf).toBeUndefined();
    expect(D.lastError).toBe('meshopt data would unpack to 384 MB, over the 256 MB limit for one model.');
    // …and it does not use up the next model's budget.
    D.clearError();
    const after = await aframeParse(loader, fixture('quad-meshopt.glb'));
    expect(after.error).toBeUndefined();
    expect(D.lastError).toBe('');

    // A decoder the page set itself is never swapped for a shim.
    const pages = decoder();
    loader.setMeshoptDecoder(pages);
    const own = await aframeParse(loader, claiming(2 ** 25));
    expect(own.error).toBeUndefined();
    expect(loader.meshoptDecoder).toBe(pages);
    expect(pages.decodeGltfBufferAsync).toHaveBeenCalled();
  });

  it('a module with no supported MeshoptDecoder is reported, and the next model may retry', async () => {
    const { D, modelLoader } = fresh();
    const importModule = vi
      .fn()
      .mockResolvedValueOnce({ MeshoptDecoder: { supported: false } })
      .mockImplementation(() => import(/* @vite-ignore */ MESHOPT_DATA_URL));
    D.configure({ resolve: (f: string) => (f === MESHOPT ? 'https://decoders.test/' + f : null), importModule });
    const first = await aframeParse(modelLoader(), fixture('quad-meshopt.glb'));
    expect(first.error).toBeTruthy();
    expect(D.lastError).toBe('Could not load the meshopt decoder: the module has no supported MeshoptDecoder');
    const second = await aframeParse(modelLoader(), fixture('quad-meshopt.glb'));
    expect(second.error).toBeUndefined();
    expect(importModule).toHaveBeenCalledTimes(2);
  });
});

describe.skipIf(!loaderAvailable(V))('shaderloader 0.8 decoders — install and configure', () => {
  it('(g) install is idempotent, and configure(null) leaves a page\'s own decoders alone', () => {
    const { D, modelLoader } = fresh();
    D.configure({ resolve: blobResolver().resolve });
    const loader = modelLoader();
    const ours = loader.dracoLoader;
    const pagesOwn = new DRACOLoader();
    loader.setDRACOLoader(pagesOwn);
    expect(D.install(loader)).toBe(loader);
    expect(loader.dracoLoader).toBe(pagesOwn);
    // ONE shared DRACOLoader per document.
    expect(modelLoader().dracoLoader).toBe(ours);
    // The flag is not enumerable: nothing new shows on the loader.
    expect(Object.getOwnPropertyDescriptor(loader, INSTALLED)?.enumerable).toBe(false);

    D.configure(null);
    const page = new GLTFLoader();
    const meshopt = { supported: true };
    page.setDRACOLoader(pagesOwn).setMeshoptDecoder(meshopt as Any);
    expect(D.install(page)).toBe(page);
    expect(page.dracoLoader).toBe(pagesOwn);
    expect((page as Any).meshoptDecoder).toBe(meshopt);
    expect((page as Any)[INSTALLED]).toBeUndefined();
    // …and A-Frame's own loader stays on a gltf-model, too.
    expect(modelLoader().dracoLoader).toBeInstanceOf(DRACOLoader);
    // Not a GLTFLoader: returned untouched, no throw.
    expect(D.install(null)).toBeNull();
    const notALoader = {};
    expect(D.install(notALoader)).toBe(notALoader);
  });

  it('(h) self-located: decoders/ beside the loader script, and a page-set dracoDecoderPath is left alone', () => {
    const src = 'https://cdn.jsdelivr.net/gh/Alvis1/a-frame-shaderloader@master/js/a-frame-shaderloader-0.8.js';
    const beside = 'https://cdn.jsdelivr.net/gh/Alvis1/a-frame-shaderloader@master/js/decoders/';

    // A-Frame's gstatic default is replaced by ours, resolved beside the script.
    const def = fresh({ scriptSrc: src });
    const loader = def.modelLoader();
    expect(loader.dracoLoader).not.toBe(def.systemDraco);
    expect(loader.dracoLoader.manager.resolveURL('fs-decoder:/' + WASM)).toBe(beside + WASM);
    expect(loader.dracoLoader.manager.resolveURL('fs-decoder:/' + WRAPPER)).toBe(beside + WRAPPER);
    expect(loader.meshoptDecoder?.supported).toBe(true);

    // A page that pointed A-Frame somewhere of its own keeps it.
    const own = fresh({ scriptSrc: src, system: { data: { dracoDecoderPath: 'https://my.example/draco/' } } });
    const kept = own.modelLoader();
    expect(kept.dracoLoader).toBe(own.systemDraco);

    // A page's own meshopt decoder survives the default mode too.
    const page = new GLTFLoader();
    const meshopt = { supported: true };
    page.setMeshoptDecoder(meshopt as Any);
    def.D.install(page);
    expect((page as Any).meshoptDecoder).toBe(meshopt);

    // An explicit configure() is the page's answer: a page-set path no longer wins.
    own.D.configure({ resolve: blobResolver().resolve });
    expect(own.modelLoader().dracoLoader).not.toBe(own.systemDraco);
  });

  it('with no http(s)/tauri script URL (a sandboxed document before configure), install does nothing', () => {
    for (const scriptSrc of [undefined, 'blob:https://app.example/1234', 'file:///x/a-frame-shaderloader-0.8.js']) {
      const { modelLoader, systemDraco } = fresh({ scriptSrc });
      const loader = modelLoader();
      expect(loader.dracoLoader, String(scriptSrc)).toBe(systemDraco);
      expect(loader[INSTALLED]).toBeUndefined();
    }
    const tauri = fresh({ scriptSrc: 'tauri://localhost/js/a-frame-shaderloader-0.8.js' });
    expect(tauri.modelLoader().dracoLoader.manager.resolveURL('fs-decoder:/' + WASM)).toBe(
      'tauri://localhost/js/decoders/' + WASM,
    );
  });

  it('(i) evaluated against an already-hooked prototype, the init still installs exactly once', () => {
    const { entry } = gltfModelEntry();
    const first = makeLoaderSandbox({
      THREE,
      aframeThree: { ...THREE, DRACOLoader, GLTFLoader },
      aframeComponents: { 'gltf-model': entry },
      globals: { document: { currentScript: null, querySelectorAll: () => [] } },
    });
    runLoaderIn(V, first.sandbox);
    const FS1 = first.sandbox.FastShaders as FastShadersApi;
    loaded.push(FS1);
    FS1.decoders.configure({ resolve: blobResolver().resolve });
    const wrapped = entry.Component.prototype.init;

    const second = makeLoaderSandbox({
      THREE,
      aframeThree: { ...THREE, DRACOLoader, GLTFLoader },
      aframeComponents: { 'gltf-model': entry },
      globals: { document: { currentScript: null, querySelectorAll: () => [] } },
    });
    runLoaderIn(V, second.sandbox);
    const FS2 = second.sandbox.FastShaders as FastShadersApi;
    loaded.push(FS2);
    FS2.decoders.configure({ resolve: blobResolver().resolve });
    expect(entry.Component.prototype.init).toBe(wrapped);

    const inst = new entry.Component() as Any;
    const spy = vi.spyOn(inst, 'init');
    inst.init();
    expect(spy).toHaveBeenCalledTimes(1);
    // The FIRST evaluation's hook equipped it, with that document's loader.
    const probe = new GLTFLoader();
    FS1.decoders.install(probe);
    expect(inst.loader.dracoLoader).toBe(probe.dracoLoader);
    expect(inst.loader[INSTALLED]).toBe(true);
  });

  it('a throwing resolver counts as no answer, and the api has the documented shape', () => {
    const { D, modelLoader } = fresh();
    D.configure({
      resolve: () => {
        throw new Error('page bug');
      },
    });
    expect(() => modelLoader()).not.toThrow();
    // ktx2Stats / ktx2Formats joined in Phase 8 (the KTX2 half, 13b-KTX2).
    expect(Object.keys(D).sort()).toEqual(
      [
        'FILES',
        'MAX_MESHOPT_DECODED_BYTES',
        'clearError',
        'configure',
        'install',
        'ktx2Formats',
        'ktx2Stats',
        'lastError',
      ].sort(),
    );
    expect(D.FILES).toEqual({
      dracoWrapper: WRAPPER,
      dracoWasm: WASM,
      meshopt: MESHOPT,
      // The KTX2 section's two, in the SAME table: one vocabulary, because the
      // sandbox refuses any key that is not in it.
      basisJs: BASIS_JS,
      basisWasm: BASIS_WASM,
    });
    expect(Object.isFrozen(D.FILES)).toBe(true);
  });
});

describe.skipIf(!loaderAvailable(V))('shaderloader 0.8 decoders — source', () => {
  const text = loaderText(V);
  // The MESH half only. The KTX2 half (13b-KTX2) follows it in the same
  // section and deliberately chains DefaultLoadingManager — see below.
  const section = sliceBetween(text, '// (13b) Mesh decoders', '// (13b-KTX2)');
  const ktx2Section = sliceBetween(text, '// (13b-KTX2)', '// (14) The public api');

  it('the decoder section never touches DefaultLoadingManager and maps nothing to a data: URL', () => {
    expect(section).not.toContain('DefaultLoadingManager.');
    expect(section).not.toMatch(/["']data:/);
    expect(section).toContain('var DECODER_MISSING = "blob:fs-decoder-missing";');
  });

  /**
   * The one difference between the two managers, and the reason it is safe: the
   * Draco loader fetches decoder FILES only, so its manager may map everything
   * else to nothing; the KTX2 loader also fetches the texture IMAGE, so every
   * URL that is not one of the two basis names goes to the page's own
   * DefaultLoadingManager modifier — the sandbox's blob:/data: allowlist.
   */
  it('the KTX2 half chains DefaultLoadingManager instead, and still maps no data: URL of its own', () => {
    expect(ktx2Section).toContain('dm.resolveURL(s)');
    expect(ktx2Section).toContain('DefaultLoadingManager');
    expect(ktx2Section).not.toMatch(/["']data:/);
    // The basis names are answered BEFORE the chain, so a decoder URL never
    // reaches the page's allowlist (shaderloaderKtx2.test.ts executes that).
    expect(ktx2Section.indexOf('DECODER_FILES.basisJs')).toBeLessThan(ktx2Section.indexOf('dm.resolveURL(s)'));
  });

  it('the ONE gltf-model attach point registers the plugin, then installs the decoders', () => {
    const attach = sliceBetween(text, 'function attachGltfModel(comp) {', 'function installGltfModelHook(');
    expect(attach.indexOf('registerPlugin(comp.loader);')).toBeGreaterThan(-1);
    expect(attach.indexOf('installDecoders(comp.loader,')).toBeGreaterThan(attach.indexOf('registerPlugin(comp.loader);'));
    // No second prototype hook: the decoders ride the glTF one.
    expect(text.match(/proto\.init = function/g)).toHaveLength(1);
  });

  it('the section sits between the glTF section and the api, and the api exports it', () => {
    expect(text.indexOf('// (13a) glTF')).toBeLessThan(text.indexOf('// (13b) Mesh decoders'));
    expect(text).toContain('  decoders: decoders,\n');
    expect(evalLoader(V, { aframe: false }).FastShaders?.decoders).toBeTruthy();
  });
});
