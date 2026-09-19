/**
 * shaderloader 0.8's `src: model` RUN PATH (section 13c), executed for real:
 * the vendored loader in `vm` (src/shaderloaderHarness.ts) over three/webgpu,
 * and the REAL r184 GLTFLoader parsing FastShaders GLBs in the main realm —
 * the hand-built fixture (`makeFastShadersGlb`) AND a file written by the
 * Phase 7 repacker (utils/glbRepack.ts). The second is the writer↔loader
 * contract: what the export writes is what `shader="src: model"` runs.
 *
 * What it pins: parsing is inert; the module runs only on the opt-in, with
 * its placeholders resolved to blob: URLs of the GLB's own image bytes; those
 * URLs live exactly as long as the binding that uses them (asserted with
 * node:buffer's resolveObjectURL); every refusal fails CLOSED before a line of
 * the module runs; staleness is a token; the one-way latch; and no network.
 *
 * GLTFLoader needs `self`, `createImageBitmap` and `ProgressEvent` in node;
 * they are stubbed per test and undone in afterEach (`isolate: false`). A vm
 * context has no Blob/TextDecoder, so the sandbox gets the main realm's,
 * a recording URL, and a fetch that throws.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolveObjectURL } from 'node:buffer';
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { evalLoader, loaderAvailable, loaderText, sliceBetween, type FastShadersApi } from './shaderloaderHarness';
import { GLTF_NODE_GLOBALS } from './gltfTestFixtures';
import {
  FS_FIXTURE_MODULE,
  FS_FIXTURE_MODULE_MARKER,
  fakeWebp,
  makeFastShadersGlb,
  makeFastShadersGltfJson,
  makeRealPng,
  repackBaseGlb,
  type FsGlbFixture,
} from './test-utils';
import { prepareRepackBase, repackGlb, samplerFor, type RepackPayload } from './utils/glbRepack';
import { readGltfModel } from './utils/gltfReader';
import { encodeDataUri } from './utils/glbContainer';
import { embedProjectState } from './engine/fastShadersProject';

const V = '0.8';
const TSL = THREE.TSL;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

let decodedImages: Uint8Array[] = [];
beforeEach(() => {
  decodedImages = [];
  vi.stubGlobal('self', GLTF_NODE_GLOBALS.self);
  vi.stubGlobal('ProgressEvent', GLTF_NODE_GLOBALS.ProgressEvent);
  vi.stubGlobal('createImageBitmap', async (blob: Blob) => {
    decodedImages.push(new Uint8Array(await blob.arrayBuffer()));
    return { width: 2, height: 2, close() {} };
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const alive = (u: string) => resolveObjectURL(u) !== undefined;
const blobUrlsIn = (source: string) => [...source.matchAll(/"(blob:[^"]+)"/g)].map((m) => m[1]);

/** A fresh 0.8 whose URL records, whose fetch throws, and whose import leg is captured. */
function fresh() {
  const created: string[] = [];
  const revoked: string[] = [];
  const fetched: string[] = [];
  class SpyURL extends URL {
    static createObjectURL(b: Blob): string {
      const u = URL.createObjectURL(b);
      created.push(u);
      return u;
    }
    static revokeObjectURL(u: string): void {
      revoked.push(u);
      URL.revokeObjectURL(u);
    }
  }
  const warns: string[] = [];
  const errors: string[] = [];
  const ev = evalLoader(V, {
    THREE,
    warn: (...a: unknown[]) => warns.push(a.map(String).join(' ')),
    error: (...a: unknown[]) => errors.push(a.map(String).join(' ')),
    globals: {
      Blob,
      TextDecoder,
      URL: SpyURL,
      fetch: (u: unknown) => {
        fetched.push(String(u));
        throw new Error('network');
      },
      document: { querySelectorAll: () => [] },
    },
  });
  if (!ev.FastShaders) throw new Error('0.8 installed no FastShaders api');
  const FS = ev.FastShaders as FastShadersApi;
  const sources: string[] = [];
  let next: (source: string) => Promise<unknown> = () => Promise.resolve(RED);
  FS.importSource = (source: string) => {
    sources.push(source);
    return next(source);
  };
  return {
    ...ev,
    FS,
    created,
    revoked,
    fetched,
    warns,
    errors,
    sources,
    setImport(fn: (source: string) => Promise<unknown>) {
      next = fn;
    },
  };
}
type Fresh = ReturnType<typeof fresh>;

/** A module namespace in the main realm (what the stubbed import resolves to). */
const RED = { default: () => ({ colorNode: TSL.color(1, 0, 0) }) };

async function parse(f: Fresh | null, data: ArrayBuffer | string, path = '', manager?: THREE.LoadingManager) {
  const loader = new GLTFLoader(manager);
  if (f) loader.register(f.FS.gltfPlugin);
  return loader.parseAsync(data, path);
}

function meshesOf(root: THREE.Object3D): Any[] {
  const out: Any[] = [];
  root.traverse((o) => {
    if ((o as Any).isMesh) out.push(o);
  });
  return out;
}

/** The A-Frame component on an entity whose gltf-model holds `scene` (or none). */
function entity(f: Fresh, scene: THREE.Object3D | null, opts: { src?: string; gltf?: boolean; mesh?: THREE.Object3D } = {}) {
  const emitted: Array<[string, Any]> = [];
  const ctx = Object.create(f.def as object) as Any;
  const components: Record<string, Any> = opts.gltf === false ? { geometry: {} } : { 'gltf-model': { model: scene } };
  let mesh: THREE.Object3D | null = opts.mesh ?? scene;
  ctx.el = {
    emit: (name: string, detail: unknown) => emitted.push([name, detail]),
    addEventListener() {},
    removeEventListener() {},
    components,
    getObject3D: (k: string) => (k === 'mesh' ? mesh : null),
    getDOMAttribute: (k: string) => (k === 'shader' ? `src: ${ctx.data.src}` : null),
    sceneEl: {},
    isConnected: true,
  };
  ctx.data = { src: opts.src ?? 'model' };
  ctx.extendSchema = () => {};
  ctx.init();
  const authored = new Map<Any, Any>();
  const remember = (root: THREE.Object3D | null) => {
    if (root) for (const m of meshesOf(root)) authored.set(m, m.material);
  };
  remember(mesh);
  return {
    ctx,
    emitted,
    components,
    authored,
    /** Swap the entity's model (a gltf-model src change, model-loaded). */
    setModel(next: THREE.Object3D) {
      components['gltf-model'] = { model: next };
      mesh = next;
      remember(next);
    },
    async apply() {
      const m = ctx.el.getObject3D('mesh');
      ctx.storeOriginalMaterials(m);
      await ctx.applyTSLShader(m);
    },
  };
}

const errorEvents = (emitted: Array<[string, Any]>) => emitted.filter(([n]) => n === 'shader-error');

async function until(cond: () => boolean) {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 0));
  expect(cond()).toBe(true);
}

const PNG = makeRealPng(2, 2, [10, 20, 30, 255]);
const KEY = 'n1-0badf00d';
const moduleUsing = (...keys: string[]) =>
  `import { vec3 } from 'three/tsl';\n// ${FS_FIXTURE_MODULE_MARKER}\n` +
  keys.map((k, i) => `const img${i} = "fs-asset:${k}";\n`).join('') +
  'export default function () {\n  return { colorNode: vec3(1, 0, 0) };\n}\n';

/** The default fixture with one PNG asset the module references twice, plus an unknown key. */
const withAsset = (o: FsGlbFixture = {}) =>
  makeFastShadersGlb({
    module: moduleUsing(KEY, KEY, 'gone-00000000'),
    assets: { [KEY]: { mime: 'image/png', bytes: PNG } },
    ...o,
  });

describe.skipIf(!loaderAvailable(V))('shaderloader 0.8 src: model — parsing is inert (T1)', () => {
  it('no URL, no import, a record copy without bytes, and the stash in place', async () => {
    const f = fresh();
    const gltf = await parse(f, withAsset().buffer);
    expect(f.created).toEqual([]);
    expect(f.sources).toEqual([]);
    expect(Object.keys(f.FS.gltfRecord(gltf.scene)).sort()).toEqual(['materialCount', 'materialNames']);
    expect([...f.FS.embeddedAssets(gltf.scene).keys()]).toEqual([KEY]);
    expect(f.fetched).toEqual([]);
  });

  it('the api carries the run path, and no way to turn it back on', () => {
    const f = fresh();
    for (const k of ['MODEL_SRC', 'loadFromGltf', 'applyFromGltf', 'disableModelModules']) expect(k in f.FS, k).toBe(true);
    for (const k of ['loadModelModule', 'resolveModelPlaceholders', 'modelPayloadOf', 'releaseModelAssets']) {
      expect(typeof f.FS.internals[k], k).toBe('function');
    }
    expect(Object.keys(f.FS).filter((k) => /enable/i.test(k))).toEqual([]);
  });
});

describe.skipIf(!loaderAvailable(V))('shaderloader 0.8 src: model — the component (T2, T3)', () => {
  it('applies: materialParts first, then shader-applied; each key one blob URL of the PNG\'s own bytes', async () => {
    const f = fresh();
    f.setImport(() =>
      Promise.resolve({
        default: () => ({
          parts: {},
          materialParts: { 0: { colorNode: TSL.color(1, 0, 0) }, 1: { colorNode: TSL.color(0, 1, 0) } },
          modelSignature: { materials: ['Body', 'Glass'] },
        }),
      }),
    );
    const gltf = await parse(f, withAsset().buffer);
    const e = entity(f, gltf.scene);
    await e.apply();

    expect(e.emitted.map(([n]) => n)).toEqual(['shader-material-parts', 'shader-applied']);
    expect(e.emitted[0][1]).toMatchObject({ status: 'applied', applied: 2 });
    expect(e.emitted[1][1]).toEqual({ src: 'model' });
    expect(f.sources).toHaveLength(1);
    const urls = blobUrlsIn(f.sources[0]);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toBe(urls[1]);
    expect(f.sources[0]).toContain('"fs-asset:gone-00000000"');
    expect(f.sources[0]).not.toContain(`"fs-asset:${KEY}"`);
    expect(f.created).toEqual([urls[0]]);
    expect(f.warns.filter((w) => w.includes('src: model'))).toEqual([
      '[FastShaders] src: model: 1 image(s) the shader uses are not in this model; they render black.',
    ]);
    const [a, b] = meshesOf(gltf.scene);
    expect(a.material).not.toBe(b.material);
    expect(a.material.isNodeMaterial && b.material.isNodeMaterial).toBe(true);
    const blob = resolveObjectURL(urls[0])!;
    expect(blob.type).toBe('image/png');
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(PNG);
    // The stash moved into Blobs: the bytes live once.
    expect(f.FS.embeddedAssets(gltf.scene)).toBeNull();
    expect(f.errors).toEqual([]);
    expect(f.fetched).toEqual([]);
  });

  it('LIFETIME: the URL lives with the binding and dies with remove()', async () => {
    const f = fresh();
    const gltf = await parse(f, withAsset().buffer);
    const e = entity(f, gltf.scene);
    await e.apply();
    const [url] = f.created;
    expect(alive(url)).toBe(true);
    expect(e.ctx._modelAssetUrls).toEqual([url]);
    e.ctx.remove();
    expect(alive(url)).toBe(false);
    for (const m of meshesOf(gltf.scene)) expect(m.material).toBe(e.authored.get(m));
  });

  it('LIFETIME: a second model\'s commit revokes the first model\'s URLs', async () => {
    const f = fresh();
    const g1 = await parse(f, withAsset().buffer);
    const g2 = await parse(f, withAsset().buffer);
    const e = entity(f, g1.scene);
    await e.apply();
    const first = f.created[0];
    e.setModel(g2.scene);
    await e.apply();
    const second = f.created[1];
    expect(second).not.toBe(first);
    expect(alive(first)).toBe(false);
    expect(alive(second)).toBe(true);
    expect(e.emitted.map(([n]) => n)).toEqual(['shader-applied', 'shader-applied']);
  });

  it('LIFETIME: a failed import revokes its URL at once — one console.error, shader-error, authored materials', async () => {
    const f = fresh();
    f.setImport(() => Promise.reject(new Error('boom')));
    const gltf = await parse(f, withAsset().buffer);
    const e = entity(f, gltf.scene);
    await e.apply();
    expect(f.created).toHaveLength(1);
    expect(alive(f.created[0])).toBe(false);
    expect(e.emitted).toEqual([['shader-error', { src: 'model', message: 'boom' }]]);
    expect(f.errors).toHaveLength(1);
    for (const m of meshesOf(gltf.scene)) expect(m.material).toBe(e.authored.get(m));
  });

  for (const outcome of ['resolve', 'reject'] as const) {
    it(`STALE (${outcome}): a slow first model neither emits nor keeps its URL once a second one committed`, async () => {
      const f = fresh();
      const gA = await parse(f, withAsset().buffer);
      const gB = await parse(f, withAsset().buffer);
      let settle: ((v: unknown) => void) | null = null;
      f.setImport(
        () =>
          new Promise((resolve, reject) => {
            settle = outcome === 'resolve' ? resolve : reject;
          }),
      );
      const e = entity(f, gA.scene);
      const pA = e.apply();
      await until(() => settle !== null);
      const urlA = f.created[0];
      f.setImport(() => Promise.resolve(RED));
      e.setModel(gB.scene);
      await e.apply();
      const bMaterial = e.ctx._shaderMaterial;
      settle!(outcome === 'resolve' ? RED : new Error('late'));
      await pA;
      expect(alive(urlA)).toBe(false);
      expect(alive(f.created[1])).toBe(true);
      expect(e.emitted.map(([n]) => n)).toEqual(['shader-applied']);
      expect(f.errors).toEqual([]);
      for (const m of meshesOf(gB.scene)) expect(m.material).toBe(bMaterial);
      for (const m of meshesOf(gA.scene)) expect(m.material).toBe(e.authored.get(m));
    });
  }

  it('waits quietly while the entity still wears something other than its gltf-model (T5)', async () => {
    const f = fresh();
    const primitive = new THREE.Mesh(new THREE.BoxGeometry());
    const e = entity(f, null, { mesh: primitive });
    await e.apply();
    expect(e.emitted).toEqual([]);
    expect(f.sources).toEqual([]);
  });
});

describe.skipIf(!loaderAvailable(V))('shaderloader 0.8 src: model — plain three (T3)', () => {
  it('applyFromGltf adopts the URLs; binding.dispose() revokes them and puts the materials back', async () => {
    const f = fresh();
    const gltf = await parse(f, withAsset().buffer);
    const authored = meshesOf(gltf.scene).map((m) => m.material);
    const b = await f.FS.applyFromGltf(gltf);
    const [url] = f.created;
    expect(alive(url)).toBe(true);
    expect(b.state._modelAssetUrls).toEqual([url]);
    b.dispose();
    expect(alive(url)).toBe(false);
    expect(meshesOf(gltf.scene).map((m) => m.material)).toEqual(authored);
  });

  it('loadFromGltf: apply() never takes ownership; release() is the caller\'s, idempotent', async () => {
    const f = fresh();
    const gltf = await parse(f, withAsset().buffer);
    const loaded = await f.FS.loadFromGltf(gltf.scene);
    expect(loaded.url).toBe('model');
    expect(loaded.root).toBe(gltf.scene);
    expect(Object.keys(loaded)).not.toContain('release');
    const [url] = f.created;
    const b1 = f.FS.apply(gltf.scene, loaded);
    const b2 = f.FS.apply(gltf.scene, loaded);
    b1.dispose();
    b2.dispose();
    expect(alive(url)).toBe(true);
    loaded.release();
    loaded.release();
    expect(alive(url)).toBe(false);
  });

  it('a target that is not a glTF result or a scene rejects', async () => {
    const f = fresh();
    for (const bad of [null, 5, {}, { scene: {} }]) {
      await expect(f.FS.loadFromGltf(bad)).rejects.toMatchObject({ message: 'loadFromGltf needs a glTF result or its scene.' });
    }
  });
});

describe.skipIf(!loaderAvailable(V))('shaderloader 0.8 src: model — fails CLOSED (T4, T5)', () => {
  const ROWS: Array<[string, FsGlbFixture, string]> = [
    ['no extras at all', { omitExtras: true, omitSceneExtras: true }, 'carries no FastShaders shader'],
    ['fastshaders null', { extras: { fastshaders: null } }, 'carries no FastShaders shader'],
    ['fastshaders an array', { extras: { fastshaders: [1] } }, 'carries no FastShaders shader'],
    ['fastshaders a string', { extras: { fastshaders: 'v1' } }, 'carries no FastShaders shader'],
    ['v: 2', { extras: { fastshaders: { v: 2 } } }, 'is format 2; this loader reads format 1'],
    ["v: '1'", { extras: { fastshaders: { v: '1' } } }, 'carries no FastShaders shader'],
    ['assets only', { module: null, assets: { [KEY]: { mime: 'image/png', bytes: PNG } } }, 'carries no FastShaders shader'],
    ...[-1, 99, 1.5, '2'].map(
      (bv): [string, FsGlbFixture, string] => [
        `module.bufferView ${JSON.stringify(bv)}`,
        { moduleEntry: { bufferView: bv, mimeType: 'text/javascript' } },
        'unreadable (not a bufferView)',
      ],
    ),
    ['a wrong mimeType', { moduleEntry: { bufferView: 1, mimeType: 'application/javascript' } }, 'unreadable (wrong type)'],
    ['a strided view', { moduleView: { byteStride: 4 } }, 'unreadable (compressed or strided view)'],
    ['a view with a target', { moduleView: { target: 34962 } }, 'unreadable (compressed or strided view)'],
    ['a meshopt view', { moduleView: { extensions: { EXT_meshopt_compression: {} } } }, 'unreadable (compressed or strided view)'],
    ['an external buffer', { moduleBuffer: 'external' }, 'unreadable (stored outside the file)'],
    ['a view past the BIN', { moduleView: { byteLength: 100000 } }, 'unreadable (cut short)'],
    ['a view over 16 MiB', { moduleView: { byteLength: 16777217 } }, 'unreadable (over 16 MB)'],
    ['an empty view', { moduleView: { byteLength: 0 } }, 'unreadable (empty)'],
    ['bytes that are not UTF-8', { module: new Uint8Array([0xc3, 0x28]) }, 'unreadable (not UTF-8 text)'],
  ];

  it.each(ROWS)('%s', async (_label, fixture, text) => {
    const f = fresh();
    const urlsSeen: string[] = [];
    const manager = new THREE.LoadingManager();
    manager.setURLModifier((u: string) => {
      urlsSeen.push(u);
      return u;
    });
    const gltf = await parse(f, makeFastShadersGlb(fixture).buffer, '', manager);
    const e = entity(f, gltf.scene);
    await e.apply();
    const errs = errorEvents(e.emitted);
    expect(errs).toHaveLength(1);
    expect(e.emitted).toHaveLength(1);
    expect(errs[0][1].src).toBe('model');
    expect(errs[0][1].message).toContain(text);
    expect(f.sources).toEqual([]);
    expect(f.created).toEqual([]);
    expect(f.errors).toHaveLength(1);
    for (const m of meshesOf(gltf.scene)) expect(m.material).toBe(e.authored.get(m));
    expect(urlsSeen.some((u) => u.includes('blocked.test'))).toBe(false);
    expect(f.fetched).toEqual([]);
  });

  it('a module with no default export is imported but never called', async () => {
    const f = fresh();
    f.setImport(() => Promise.resolve({ schema: {} }));
    const gltf = await parse(f, withAsset().buffer);
    const e = entity(f, gltf.scene);
    await e.apply();
    expect(f.sources).toHaveLength(1);
    expect(e.emitted).toEqual([['shader-error', { src: 'model', message: "This model's FastShaders shader has no default export." }]]);
    expect(alive(f.created[0])).toBe(false);
    expect(f.errors).toHaveLength(1);
  });

  it('wiring: an entity with no gltf-model, and a model parsed without the plugin', async () => {
    const f = fresh();
    const primitive = new THREE.Mesh(new THREE.BoxGeometry());
    const e1 = entity(f, null, { gltf: false, mesh: primitive });
    await e1.apply();
    expect(e1.emitted).toEqual([['shader-error', { src: 'model', message: 'src: model needs a gltf-model on the same entity.' }]]);

    const bare = await parse(null, withAsset().buffer);
    const e2 = entity(f, bare.scene);
    await e2.apply();
    expect(errorEvents(e2.emitted)[0][1].message).toContain('loaded without FastShaders.gltfPlugin');
    expect(f.sources).toEqual([]);
    expect(f.created).toEqual([]);
  });
});

describe.skipIf(!loaderAvailable(V))('shaderloader 0.8 src: model — opt-in only, and the latch (T6, T7)', () => {
  it('`src: x.js` on the same model runs x.js and never the model\'s module', async () => {
    const f = fresh();
    f.FS.fetch = () =>
      Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve("import { color } from 'three/tsl';\nexport default () => ({ colorNode: color(1) });\n") });
    const gltf = await parse(f, withAsset().buffer);
    const e = entity(f, gltf.scene, { src: 'x.js' });
    await e.apply();
    expect(e.emitted.map(([n]) => n)).toEqual(['shader-applied']);
    expect(f.sources).toHaveLength(1);
    expect(f.sources[0]).not.toContain(FS_FIXTURE_MODULE_MARKER);
    expect(f.created).toEqual([]);
    // The stash is untouched: nothing read it.
    expect(f.FS.embeddedAssets(gltf.scene)).not.toBeNull();
  });

  it('disableModelModules() is one-way: the component and both plain calls refuse', async () => {
    const f = fresh();
    const gltf = await parse(f, withAsset().buffer);
    f.FS.disableModelModules();
    f.FS.disableModelModules();
    const e = entity(f, gltf.scene);
    await e.apply();
    expect(e.emitted).toEqual([['shader-error', { src: 'model', message: 'src: model is turned off on this page.' }]]);
    await expect(f.FS.applyFromGltf(gltf)).rejects.toMatchObject({ message: 'src: model is turned off on this page.' });
    await expect(f.FS.loadFromGltf(gltf)).rejects.toMatchObject({ message: 'src: model is turned off on this page.' });
    expect(f.sources).toEqual([]);
    expect(f.created).toEqual([]);
  });
});

describe.skipIf(!loaderAvailable(V))('shaderloader 0.8 src: model — variants (T8, T9)', () => {
  it('a REAL import: the module sees a blob: URL of the PNG, and no revision warning', async () => {
    vi.stubGlobal('THREE', THREE);
    const f = fresh();
    f.setImport((source) => import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`));
    const gltf = await parse(
      f,
      withAsset({
        module:
          "import { color } from 'three/tsl';\nexport const threeRevision = '184';\n" +
          `export const assetUrl = "fs-asset:${KEY}";\nexport default function () { return { colorNode: color(1, 0, 0) }; }\n`,
      }).buffer,
    );
    const loaded = await f.FS.loadFromGltf(gltf);
    expect(String(loaded.module.assetUrl)).toMatch(/^blob:/);
    const blob = resolveObjectURL(loaded.module.assetUrl)!;
    expect(blob.type).toBe('image/png');
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(PNG);
    const b = f.FS.apply(gltf.scene, loaded);
    expect(f.warns.filter((w) => /r\d+/.test(w))).toEqual([]);
    b.dispose();
    loaded.release();
    expect(alive(loaded.module.assetUrl)).toBe(false);
  });

  it('an embedded .gltf (the BIN as a data: buffer) runs too', async () => {
    const f = fresh();
    const gltf = await parse(f, makeFastShadersGltfJson({}));
    const e = entity(f, gltf.scene);
    await e.apply();
    expect(e.emitted.map(([n]) => n)).toEqual(['shader-applied']);
    expect(f.sources[0]).toContain(FS_FIXTURE_MODULE_MARKER);
  });

  it('relative imports resolve against the model\'s own http(s) path, and stay verbatim for a blob: one', async () => {
    const module = "import helper from './helper.js';\nexport default function () { return {}; }\n";
    for (const [path, want] of [
      ['https://cdn.example/models/', "'https://cdn.example/models/helper.js'"],
      ['blob:null/', "'./helper.js'"],
    ] as const) {
      const f = fresh();
      const gltf = await parse(f, makeFastShadersGlb({ module }).buffer, path);
      await f.FS.loadFromGltf(gltf);
      expect(f.sources[0], path).toContain(want);
    }
  });

  it('a signature mismatch is not a failure: materialParts reports it, then shader-applied', async () => {
    const f = fresh();
    f.setImport(() =>
      Promise.resolve({
        default: () => ({
          parts: {},
          colorNode: TSL.color(1, 1, 1),
          materialParts: { 0: { colorNode: TSL.color(1, 0, 0) } },
          modelSignature: { materials: ['Body', 'Other'] },
        }),
      }),
    );
    const gltf = await parse(f, withAsset().buffer);
    const e = entity(f, gltf.scene);
    await e.apply();
    expect(e.emitted.map(([n]) => n)).toEqual(['shader-material-parts', 'shader-applied']);
    expect(e.emitted[0][1].status).toBe('mismatch');
  });

  it('one images[] entry serves the glTF texture AND the module', async () => {
    const f = fresh();
    const gltf = await parse(f, withAsset({ textureFromAsset: KEY }).buffer);
    expect(decodedImages.some((d) => d.length === PNG.length && d.every((v, i) => v === PNG[i]))).toBe(true);
    const e = entity(f, gltf.scene);
    await e.apply();
    const blob = resolveObjectURL(blobUrlsIn(f.sources[0])[0])!;
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(PNG);
  });
});

/* ── the writer↔loader contract: a GLB the Phase 7 repacker wrote ───────── */

describe.skipIf(!loaderAvailable(V))('shaderloader 0.8 src: model — a GLB written by utils/glbRepack.ts', () => {
  const PNG_N = makeRealPng(4, 4, [128, 128, 255, 255]);
  const WEBP = fakeWebp(8, 8, false);
  const FALLBACK = makeRealPng(8, 8, [9, 9, 9, 255]);
  const SRC_N = encodeDataUri('image/png', PNG_N);
  const SRC_W = encodeDataUri('image/webp', WEBP);
  const K_W = 'imgW-0000cccc';
  const K_N = 'imgN-0000aaaa';

  function repacked(): ArrayBuffer {
    const raw = repackBaseGlb({ materials: ['Body', 'Glass'], textured: true });
    const report = readGltfModel(raw, 'glb');
    if (!report.ok) throw new Error('reader refused the base');
    const base = prepareRepackBase(report.model, [0]);
    if (!base.ok) throw new Error('prepare refused');
    const r = repackGlb({
      base: base.model,
      indexMaterials: [0],
      slots: [
        { material: 0, slot: 'baseColor', src: SRC_W, texCoord: 0, transform: null, sampler: samplerFor({ colorSpace: 'color', nearest: false, repeat: true }), name: '' },
      ],
      payloads: new Map<string, RepackPayload>([
        [SRC_W, { mime: 'image/webp', bytes: WEBP, lossless: false }],
        [SRC_N, { mime: 'image/png', bytes: PNG_N, lossless: true }],
      ]),
      fallbacks: new Map([[SRC_W, { mime: 'image/png' as const, bytes: FALLBACK }]]),
      moduleText: moduleUsing(K_W, K_N, K_W),
      moduleAssets: [
        { key: K_W, src: SRC_W },
        { key: K_N, src: SRC_N },
      ],
      projectText: embedProjectState('', { version: 1, shaderName: 'x', graph: { nodes: [], edges: [] }, preview: {}, ui: {} } as Any).trim(),
      webpMode: 'fallback',
    });
    if (!r.ok) throw new Error('repack refused: ' + JSON.stringify(r.refusal));
    return r.bytes.buffer;
  }

  it('src: model runs the stored module with every key a blob: URL of the PAYLOAD bytes, never the fallback', async () => {
    const f = fresh();
    const gltf = await parse(f, repacked());
    const e = entity(f, gltf.scene);
    await e.apply();
    expect(e.emitted.map(([n]) => n)).toEqual(['shader-applied']);
    expect(f.sources).toHaveLength(1);
    const source = f.sources[0];
    expect(source).toContain(FS_FIXTURE_MODULE_MARKER);
    expect(source).not.toContain('"fs-asset:');
    const urls = blobUrlsIn(source);
    expect(urls).toHaveLength(3);
    expect(urls[0]).toBe(urls[2]);
    expect(f.created.sort()).toEqual([...new Set(urls)].sort());
    const w = resolveObjectURL(urls[0])!;
    const n = resolveObjectURL(urls[1])!;
    expect(w.type).toBe('image/webp');
    expect(new Uint8Array(await w.arrayBuffer())).toEqual(WEBP);
    expect(n.type).toBe('image/png');
    expect(new Uint8Array(await n.arrayBuffer())).toEqual(PNG_N);
    expect(f.warns.filter((x) => x.includes('src: model') || x.includes('embedded image'))).toEqual([]);
    expect(f.errors).toEqual([]);
    e.ctx.remove();
    for (const u of urls) expect(alive(u)).toBe(false);
  });
});

/* ── source pins ─────────────────────────────────────────────────────────── */

describe.skipIf(!loaderAvailable(V))('shaderloader 0.8 src: model — source (T10)', () => {
  const text = () => loaderText(V);

  it('the new section has no err-named catch, and the component keeps 0.6\'s catch order', () => {
    const section = sliceBetween(text(), '// (13c) The shader a FastShaders .glb carries', '// (14) The public api');
    expect(section).not.toContain('catch (err)');
    const catchBlock = sliceBetween(text(), '    } catch (err) {\n      // Staleness guard', 'this.el.emit("shader-error"');
    expect(catchBlock.indexOf('this.unbary();')).toBeLessThan(catchBlock.indexOf('this.unweld();'));
  });

  it('the placeholder regex is the editor\'s, the default fixture module is a loader module', () => {
    expect(text()).toContain('var MODEL_PLACEHOLDER_RE = /"fs-asset:([^"]+)"/g;');
    expect(FS_FIXTURE_MODULE).toMatch(/export default function/);
  });

  it('the URLs die with the material generation: disposeShaderMaterial releases them', () => {
    const dispose = sliceBetween(text(), 'function disposeShaderMaterial(state) {', '\n}\n');
    expect(dispose.trimEnd().endsWith('releaseModelAssets(state);')).toBe(true);
  });
});
