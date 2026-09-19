/**
 * shaderloader 0.8's glTF PLUGIN, executed for real: the vendored loader in
 * `vm` (src/shaderloaderHarness.ts) and the REAL r184 GLTFLoader parsing
 * in-memory fixtures (src/gltfTestFixtures.ts) in the main realm.
 *
 * What it pins: the parse record (which glTF material each mesh came from,
 * and the model's signature), that the plugin can never be why a model fails
 * to load, the bounded embedded-image stash, the ONE `gltf-model` prototype
 * hook (plus the evaluation-time sweep and the shader component's fallback),
 * and the A-Frame bundle shape that hook depends on. What a record is USED for
 * (materialParts dispatch) is shaderloaderMaterialParts.test.ts.
 *
 * GLTFLoader needs `self`, `createImageBitmap` and `ProgressEvent` in node.
 * They are stubbed per test and undone in afterEach (`isolate: false`).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { imageAssetFor } from '@/engine/imageAssets';
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
import {
  GLTF_NODE_GLOBALS,
  glbBytes,
  gltfText,
  materials,
  parseWith,
  pluginCallbacks,
  type GltfSpec,
} from './gltfTestFixtures';

const V = '0.8';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

beforeEach(() => {
  for (const [k, v] of Object.entries(GLTF_NODE_GLOBALS)) vi.stubGlobal(k, v);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

interface FreshOptions {
  components?: Record<string, unknown>;
  document?: unknown;
}

/** A fresh 0.8 over three/webgpu, recording every warning. */
function fresh(opts: FreshOptions = {}) {
  const warns: string[] = [];
  const ev = evalLoader(V, {
    THREE,
    warn: (...a: unknown[]) => warns.push(a.map(String).join(' ')),
    ...(opts.components ? { aframeComponents: opts.components } : {}),
    globals: { document: opts.document ?? { querySelectorAll: () => [] } },
  });
  if (!ev.FastShaders) throw new Error('0.8 installed no FastShaders api');
  return { ...ev, FS: ev.FastShaders as FastShadersApi, warns };
}

function byName(root: THREE.Object3D, name: string): Any {
  const o = root.getObjectByName(name);
  if (!o) throw new Error(`fixture has no object named ${name}`);
  return o;
}

/** A gltf-model registry entry whose init builds a GLTFLoader, as A-Frame's does. */
function gltfModelEntry() {
  return inertGltfModelEntry(function () {
    this.loader = new GLTFLoader();
  });
}

/**
 * Three materials (two share the name 'Body'), a two-primitive mesh (one
 * primitive without tangents, which GLTFLoader clones with normalScale.y
 * flipped), one mesh used by two nodes, a primitive with no material, a
 * POINTS primitive, and a node name GLTFLoader sanitizes.
 */
const SPEC: GltfSpec = {
  materials: materials(['Body', 'Glass', 'Body']),
  meshes: [
    { name: 'Multi', primitives: [{ material: 0 }, { material: 1, tangent: true }] },
    { name: 'Shared', primitives: [{ material: 1 }] },
    { primitives: [{}] },
    { name: 'PtsMesh', primitives: [{ material: 0, mode: 0 }] },
    { name: 'Tail', primitives: [{ material: 2 }] },
  ],
  nodes: [
    { name: 'Multi', mesh: 0 },
    { name: 'A', mesh: 1 },
    { name: 'B', mesh: 1 },
    { mesh: 2 },
    { name: 'Pts', mesh: 3 },
    { name: 'Body.001', mesh: 4 },
  ],
};

describe.skipIf(!loaderAvailable(V))('shaderloader 0.8 glTF plugin — the parse record', () => {
  it('records every mesh\'s glTF material index, mesh association first', async () => {
    const { FS, warns } = fresh();
    const gltf = await parseWith([FS.gltfPlugin], gltfText(SPEC));
    const scene = gltf.scene;
    const idx = (name: string) => FS.materialIndexOf(byName(scene, name));

    // The tangent-less primitive wears GLTFLoader's flipped CLONE of material 0.
    expect(byName(scene, 'Multi_1').material.normalScale.y).toBe(-1);
    expect(idx('Multi_1')).toBe(0);
    expect(byName(scene, 'Multi_2').material.normalScale.y).toBe(1);
    expect(idx('Multi_2')).toBe(1);
    // One mesh, two nodes: both refs carry the index.
    expect(idx('A')).toBe(1);
    expect(idx('B')).toBe(1);
    // A primitive with no material wears the shared default: no index.
    expect(idx('mesh_2')).toBeUndefined();
    // POINTS: GLTFLoader mints an un-associated PointsMaterial, so only the
    // MESH association can find the index.
    expect(byName(scene, 'Pts').isPoints).toBe(true);
    expect(byName(scene, 'Pts').material.isPointsMaterial).toBe(true);
    expect(idx('Pts')).toBe(0);
    // 'Body.001' is renamed by GLTFLoader; the index does not care.
    expect(idx('Body001')).toBe(2);
    // The multi-primitive mesh's Group is not a mesh.
    expect(idx('Multi')).toBeUndefined();
    expect(warns).toEqual([]);
  });

  it('records the material count and the RAW names, duplicates and all', async () => {
    const { FS } = fresh();
    const gltf = await parseWith([FS.gltfPlugin], gltfText(SPEC));
    const want = { materialCount: 3, materialNames: ['Body', 'Glass', 'Body'] };
    expect(FS.gltfRecord(gltf.scene)).toEqual(want);
    expect(FS.modelSignature(gltf)).toEqual({ materials: ['Body', 'Glass', 'Body'] });
    expect(FS.modelSignature(gltf.scene)).toEqual({ materials: ['Body', 'Glass', 'Body'] });
    // A descendant finds its model's record.
    expect(FS.gltfRecord(byName(gltf.scene, 'A'))).toEqual(want);
    // Copies: editing one does not edit the record.
    FS.gltfRecord(gltf.scene).materialNames.push('x');
    expect(FS.gltfRecord(gltf.scene)).toEqual(want);
  });

  it('writes nothing into the model (userData would leak into a re-export as extras)', async () => {
    // GLTFLoader writes some userData of its own (a multi-primitive Group's
    // `name`), so compare against the same file parsed WITHOUT the plugin.
    const userData = (scene: THREE.Object3D) => {
      const out: string[] = [];
      scene.traverse((o: Any) => {
        out.push(JSON.stringify(o.userData));
        if (o.material) out.push(JSON.stringify(o.material.userData));
      });
      return out;
    };
    const { FS } = fresh();
    const withPlugin = await parseWith([FS.gltfPlugin], gltfText(SPEC));
    const without = await parseWith([], gltfText(SPEC));
    expect(userData(withPlugin.scene)).toEqual(userData(without.scene));
    expect(userData(withPlugin.scene).length).toBeGreaterThan(6);
  });

  it('a clone carries no record (the documented limit)', async () => {
    const { FS } = fresh();
    const gltf = await parseWith([FS.gltfPlugin], gltfText(SPEC));
    const clone = gltf.scene.clone();
    let meshes = 0;
    clone.traverse((o: Any) => {
      if (o.isMesh) meshes++;
      expect(FS.materialIndexOf(o)).toBeUndefined();
    });
    expect(meshes).toBeGreaterThan(0);
    expect(FS.gltfRecord(clone)).toBeNull();
  });

  it('registering twice leaves ONE callback; the plugin has its name', () => {
    const { FS } = fresh();
    const loader = new GLTFLoader();
    loader.register(FS.gltfPlugin);
    loader.register(FS.gltfPlugin);
    expect(pluginCallbacks(loader).filter((c) => c === FS.gltfPlugin)).toHaveLength(1);
    expect(FS.gltfPlugin({}).name).toBe('FASTSHADERS_parse_record');
  });

  it('a plugin registered before load() in the same tick has the record by onLoad', async () => {
    const { FS } = fresh();
    const loader = new GLTFLoader();
    loader.register(FS.gltfPlugin);
    const seen = await new Promise((resolve, reject) => {
      loader.parse(gltfText(SPEC), '', (g) => resolve(FS.gltfRecord(g.scene)), reject);
    });
    expect(seen).toEqual({ materialCount: 3, materialNames: ['Body', 'Glass', 'Body'] });
  });

  it('over-long names are recorded null, so no signature can match them', async () => {
    const { FS } = fresh();
    const long = 'x'.repeat(1025);
    const gltf = await parseWith(
      [FS.gltfPlugin],
      gltfText({ ...SPEC, materials: materials([long, 'Glass', 'Body']) }),
    );
    expect(FS.gltfRecord(gltf.scene).materialNames).toEqual([null, 'Glass', 'Body']);
    expect(FS.modelSignature(gltf)).toBeNull();
    const r = (names: string[]) =>
      FS.internals.resolveMaterialParts(
        { materialParts: { 0: { colorNode: 1 } }, modelSignature: { materials: names } },
        gltf.scene,
        true,
      ).status;
    expect(r([long, 'Glass', 'Body'])).toBe('invalid'); // over the signature's own cap
    expect(r(['x'.repeat(1024), 'Glass', 'Body'])).toBe('mismatch');
  });

  it('names that look like Object.prototype keys are plain strings', async () => {
    const { FS } = fresh();
    const names = ['__proto__', 'constructor', 'toString'];
    const gltf = await parseWith(
      [FS.gltfPlugin],
      gltfText({ ...SPEC, materials: materials(names) }),
    );
    expect(FS.gltfRecord(gltf.scene).materialNames).toEqual(names);
    expect(FS.modelSignature(gltf)).toEqual({ materials: names });
    const res = FS.internals.resolveMaterialParts(
      { materialParts: { 1: { colorNode: 1 } }, modelSignature: { materials: names } },
      gltf.scene,
      true,
    );
    expect(res.status).toBe('applied');
  });
});

describe.skipIf(!loaderAvailable(V))('shaderloader 0.8 glTF plugin — never breaks a load', () => {
  /** A plugin that runs BEFORE ours in afterRoot and vandalises the parser's json. */
  const vandal = (mutate: (json: Any) => void) => (parser: Any) => ({
    name: 'TEST_vandal',
    afterRoot() {
      mutate(parser.json);
    },
  });

  it('a non-array `materials` records a count of 0', async () => {
    const { FS } = fresh();
    const gltf = await parseWith(
      [FS.gltfPlugin],
      gltfText({ materials: 5, meshes: [{ primitives: [{}] }], nodes: [{ mesh: 0 }] }),
    );
    expect(FS.gltfRecord(gltf.scene)).toEqual({ materialCount: 0, materialNames: [] });
  });

  it('a name getter that throws: the model loads, unindexed, with one warning', async () => {
    const { FS, warns } = fresh();
    const gltf = await parseWith(
      [
        vandal((json) => {
          json.materials[0] = {
            get name() {
              throw new Error('hostile name');
            },
          };
        }),
        FS.gltfPlugin,
      ],
      gltfText(SPEC),
    );
    expect(gltf.scene).toBeTruthy();
    expect(FS.gltfRecord(gltf.scene)).toBeNull();
    expect(warns).toEqual(['[FastShaders] could not index this glTF: hostile name']);
  });

  it('a non-string name is never coerced (a throwing toString is recorded as \'\')', async () => {
    const { FS, warns } = fresh();
    const gltf = await parseWith(
      [
        vandal((json) => {
          json.materials[0].name = {
            toString() {
              throw 0;
            },
          };
        }),
        FS.gltfPlugin,
      ],
      gltfText(SPEC),
    );
    expect(FS.gltfRecord(gltf.scene).materialNames).toEqual(['', 'Glass', 'Body']);
    expect(warns).toEqual([]);
  });

  it('hostile fastshaders extras: the record survives, the stash does not', async () => {
    for (const extras of [
      {
        fastshaders: {
          get v() {
            throw new Error('hostile extras');
          },
        },
      },
      {
        fastshaders: {
          v: 1,
          assets: {
            get img() {
              throw new Error('hostile asset');
            },
          },
        },
      },
    ]) {
      const { FS, warns } = fresh();
      const gltf = await parseWith(
        [
          vandal((json) => {
            json.extras = extras;
          }),
          FS.gltfPlugin,
        ],
        gltfText(SPEC),
      );
      expect(FS.gltfRecord(gltf.scene)?.materialCount).toBe(3);
      expect(FS.embeddedAssets(gltf.scene)).toBeNull();
      expect(warns).toHaveLength(1);
      expect(warns[0]).toMatch(/^\[FastShaders\] could not index this glTF: hostile (extras|asset)$/);
    }
  });

  it('a parser whose json throws: afterRoot still resolves', async () => {
    const { FS, warns } = fresh();
    const parser = {
      get json() {
        throw new Error('no json');
      },
    };
    await expect(FS.gltfPlugin(parser).afterRoot({ scenes: [new THREE.Group()] })).resolves.toBeUndefined();
    expect(warns).toEqual(['[FastShaders] could not index this glTF: no json']);
  });
});

/* ── the embedded-image stash (Phase 7's input; nothing reads it yet) ─────── */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const NOT_JPEG = new Uint8Array([0x00, 0x11, 0x22, 0x33, 0x44]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 9, 9]);

function withPngMagic(size: number): ArrayBuffer {
  const buf = new ArrayBuffer(size);
  new Uint8Array(buf).set(PNG.subarray(0, 8));
  return buf;
}

/** A parser stand-in for the stash's bounds: `getDependency` hands back views[i]. */
function fakeParser(images: unknown[], views: ArrayBuffer[], assets: Record<string, number>) {
  return {
    json: {
      materials: [],
      images,
      bufferViews: views.map(() => ({})),
      extras: { fastshaders: { v: 1, assets } },
    },
    associations: new Map(),
    getDependency: async (type: string, i: number) => {
      if (type !== 'bufferView') throw new Error(type);
      return views[i];
    },
  };
}

describe.skipIf(!loaderAvailable(V))('shaderloader 0.8 glTF plugin — the embedded-image stash', () => {
  it('keeps whitelisted bufferView images byte-identical and refuses the rest, fetching nothing', async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error('the stash must not fetch')));
    vi.stubGlobal('fetch', fetchSpy);
    const { FS, warns } = fresh();
    const spec: GltfSpec = {
      ...SPEC,
      blobs: [PNG, NOT_JPEG, WEBP], // bufferViews 2, 3, 4
      images: [
        { bufferView: 2, mimeType: 'image/png' },
        { uri: 'https://evil.example/x.png', mimeType: 'image/png' },
        { bufferView: 3, mimeType: 'image/jpeg' },
        { bufferView: 2, mimeType: 'image/gif' },
        { bufferView: 4, mimeType: 'image/webp' },
      ],
      extras: {
        fastshaders: {
          v: 1,
          assets: {
            'img1-0123abcd': 0,
            remote: 1,
            badmagic: 2,
            gif: 3,
            'img2-deadbeef': 4,
            'bad key!': 0,
            far: 99,
          },
        },
      },
    };
    const gltf = await parseWith([FS.gltfPlugin], glbBytes(spec));
    const stash = FS.embeddedAssets(gltf.scene);
    expect([...stash.keys()]).toEqual(['img1-0123abcd', 'img2-deadbeef']);
    expect(stash.get('img1-0123abcd').mime).toBe('image/png');
    expect([...new Uint8Array(stash.get('img1-0123abcd').bytes)]).toEqual([...PNG]);
    expect([...new Uint8Array(stash.get('img2-deadbeef').bytes)]).toEqual([...WEBP]);
    expect(warns.sort()).toEqual(
      [
        '[FastShaders] embedded image "remote" ignored: not a bufferView image',
        '[FastShaders] embedded image "badmagic" ignored: wrong file signature',
        '[FastShaders] embedded image "gif" ignored: unsupported type',
        '[FastShaders] embedded image "bad key!" ignored: not a valid key',
        '[FastShaders] embedded image "far" ignored: no such image',
      ].sort(),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('embeddedAssets hands out a copy, and releaseEmbedded drops the bytes', async () => {
    const { FS } = fresh();
    const gltf = await parseWith(
      [FS.gltfPlugin],
      glbBytes({
        ...SPEC,
        blobs: [PNG],
        images: [{ bufferView: 2, mimeType: 'image/png' }],
        extras: { fastshaders: { v: 1, assets: { a: 0 } } },
      }),
    );
    FS.embeddedAssets(gltf.scene).clear();
    expect(FS.embeddedAssets(gltf.scene).size).toBe(1);
    FS.releaseEmbedded(gltf.scene);
    expect(FS.embeddedAssets(gltf.scene)).toBeNull();
    expect(FS.gltfRecord(gltf.scene)?.materialCount).toBe(3); // the record itself stays
  });

  it('no fastshaders extras (or another version of them) means no stash', async () => {
    const { FS } = fresh();
    const plain = await parseWith([FS.gltfPlugin], gltfText(SPEC));
    expect(FS.embeddedAssets(plain.scene)).toBeNull();
    const v2 = await parseWith(
      [FS.gltfPlugin],
      glbBytes({
        ...SPEC,
        blobs: [PNG],
        images: [{ bufferView: 2, mimeType: 'image/png' }],
        extras: { fastshaders: { v: 2, assets: { a: 0 } } },
      }),
    );
    expect(FS.embeddedAssets(v2.scene)).toBeNull();
  });

  it('a module pointer with NO assets is still a FastShaders file: no stash, no warning, no bytes on the record', async () => {
    // A single-GLB export may carry a module and no images (Phase 7). The stash
    // used to gate on `assets` being an object, which read such a file as not
    // FastShaders at all — the fold that makes `assets` optional (loader
    // header delta 9). The record must stay exactly the public pair.
    const { FS, warns } = fresh();
    const gltf = await parseWith(
      [FS.gltfPlugin],
      glbBytes({
        ...SPEC,
        blobs: [new TextEncoder().encode('export default () => null;')],
        extras: { fastshaders: { v: 1, module: { bufferView: 2, mimeType: 'text/javascript' } } },
      }),
    );
    expect(FS.embeddedAssets(gltf.scene)).toBeNull();
    expect(warns).toEqual([]);
    expect(Object.keys(FS.gltfRecord(gltf.scene) ?? {}).sort()).toEqual(['materialCount', 'materialNames']);
    expect(FS.gltfRecord(gltf.scene)?.materialCount).toBe(3);
  });

  it('an `assets` that is not a plain object stashes nothing and warns nothing', async () => {
    for (const assets of ['junk', 7, null, [0]]) {
      const { FS, warns } = fresh();
      const gltf = await parseWith(
        [FS.gltfPlugin],
        glbBytes({
          ...SPEC,
          blobs: [PNG],
          images: [{ bufferView: 2, mimeType: 'image/png' }],
          extras: { fastshaders: { v: 1, assets } },
        }),
      );
      expect(FS.embeddedAssets(gltf.scene)).toBeNull();
      expect(warns).toEqual([]);
      expect(FS.gltfRecord(gltf.scene)?.materialCount).toBe(3);
    }
  });

  it('caps one image at 16 MB and the model at 64 MB', async () => {
    const { FS, warns } = fresh();
    const big = withPngMagic(16 * 1048576 + 1);
    const full = withPngMagic(16 * 1048576);
    const images = [
      { bufferView: 0, mimeType: 'image/png' },
      { bufferView: 1, mimeType: 'image/png' },
    ];
    const scene = new THREE.Group();
    await FS.gltfPlugin(
      fakeParser(images, [big, full], { big: 0, f1: 1, f2: 1, f3: 1, f4: 1, f5: 1 }),
    ).afterRoot({ scenes: [scene] });
    expect([...FS.embeddedAssets(scene).keys()]).toEqual(['f1', 'f2', 'f3', 'f4']);
    expect(warns).toEqual([
      '[FastShaders] embedded image "big" ignored: over 16 MB',
      '[FastShaders] embedded image "f5" ignored: over 64 MB in total',
    ]);
  });

  it('stops at 64 images, with one warning', async () => {
    const { FS, warns } = fresh();
    const assets: Record<string, number> = {};
    for (let i = 0; i < 70; i++) assets[`k${i}`] = 0;
    const scene = new THREE.Group();
    await FS.gltfPlugin(
      fakeParser([{ bufferView: 0, mimeType: 'image/png' }], [PNG.slice().buffer], assets),
    ).afterRoot({ scenes: [scene] });
    expect(FS.embeddedAssets(scene).size).toBe(64);
    expect(warns).toEqual(['[FastShaders] embedded image "k64" ignored: over the 64-image limit']);
  });

  it('accepts every key the editor\'s image placeholders can produce', () => {
    const m = /var EMBED_KEY_RE = \/(.+)\/;/.exec(loaderText(V));
    expect(m, 'EMBED_KEY_RE not found in the loader').not.toBeNull();
    const re = new RegExp(m![1]);
    const valid = {
      imageB64: `data:image/webp;base64,${btoa('abc')}`,
      width: 2,
      height: 2,
      fileName: 'x.webp',
      colorSpace: 'color',
    };
    const latvian = 'Z' + String.fromCodePoint(0x12b) + 'le';
    const ids = ['img1', 'a b/c', '../../etc', 'x'.repeat(500), '', '__proto__', '<script>', 'n l', latvian];
    for (const id of ids) {
      const asset = imageAssetFor(id, valid);
      expect(asset, id).not.toBeNull();
      expect(asset!.key, id).toMatch(re);
    }
  });
});

/* ── registration: the ONE gltf-model hook, the sweep, the fallback ──────── */

describe.skipIf(!loaderAvailable(V))('shaderloader 0.8 glTF plugin — registration', () => {
  it('wraps gltf-model\'s init once, so every model loader has the plugin before it loads', async () => {
    const entry = gltfModelEntry();
    const { FS, warns } = fresh({ components: { 'gltf-model': entry } });
    const inst = new entry.Component() as Any;
    inst.init();
    expect(pluginCallbacks(inst.loader)).toContain(FS.gltfPlugin);
    const gltf = await inst.loader.parseAsync(gltfText(SPEC), '');
    expect(FS.gltfRecord(gltf.scene)?.materialCount).toBe(3);
    expect(warns).toEqual([]);

    // ONE non-enumerable flag, and nothing else added to the prototype.
    const flag = Object.getOwnPropertyDescriptor(
      entry.Component.prototype,
      Symbol.for('fastshaders.gltfModelHook'),
    );
    expect(flag?.value).toBe(true);
    expect(flag?.enumerable).toBe(false);
    expect(Object.keys(entry.Component.prototype)).toEqual(['init']);
  });

  it('a second evaluation does not wrap it again', () => {
    const entry = gltfModelEntry();
    const { sandbox } = makeLoaderSandbox({
      THREE,
      aframeComponents: { 'gltf-model': entry },
      globals: { document: { querySelectorAll: () => [] } },
    });
    runLoaderIn(V, sandbox);
    const wrapped = entry.Component.prototype.init;
    // Defeat the double-include guard, so only the flag stands in the way.
    delete sandbox.FastShaders;
    runLoaderIn(V, sandbox);
    expect(entry.Component.prototype.init).toBe(wrapped);
    const inst = new entry.Component() as Any;
    inst.init();
    const ours = pluginCallbacks(inst.loader).filter((c) => (c as { name?: string }).name === 'gltfPlugin');
    expect(ours).toHaveLength(1);
  });

  it('an A-Frame whose gltf-model it cannot hook warns once and still evaluates', () => {
    for (const components of [{}, { 'gltf-model': { Component: function () {} } }]) {
      const { FS, def, warns } = fresh({ components });
      expect(FS).toBeTruthy();
      expect(def).toBeTruthy();
      expect(warns).toEqual([
        "[FastShaders] could not hook A-Frame's gltf-model; a model that loads before its shader attaches will not be indexed.",
      ]);
    }
    // No A-Frame at all: nothing to hook, nothing to say.
    const warns: string[] = [];
    evalLoader(V, { aframe: false, warn: (m: unknown) => warns.push(String(m)) });
    expect(warns).toEqual([]);
  });

  it('sweeps the gltf-model components that initialised before the file ran', () => {
    const early = new GLTFLoader();
    const querySelectorAll = vi.fn(() => [
      { components: { 'gltf-model': { loader: early } } },
      { components: {} },
      null,
    ]);
    const { FS } = fresh({ document: { querySelectorAll } });
    expect(querySelectorAll).toHaveBeenCalledWith('[gltf-model]');
    expect(pluginCallbacks(early)).toContain(FS.gltfPlugin);
  });

  it('the shader component registers too: on init and when a gltf-model attaches later', () => {
    const { FS, def } = fresh();
    const first = new GLTFLoader();
    const listeners: Record<string, (e: unknown) => void> = {};
    const ctx = Object.create(def as object) as Any;
    ctx.el = {
      components: { 'gltf-model': { loader: first } },
      addEventListener: (n: string, f: (e: unknown) => void) => {
        listeners[n] = f;
      },
      removeEventListener() {},
    };
    ctx.data = {};
    ctx.init();
    expect(pluginCallbacks(first)).toContain(FS.gltfPlugin);

    const later = new GLTFLoader();
    ctx.el.components['gltf-model'] = { loader: later };
    listeners.componentinitialized({ detail: { name: 'gltf-model' } });
    expect(pluginCallbacks(later)).toContain(FS.gltfPlugin);
  });

  it('source: the hook registers AFTER the wrapped init, inside that same function', () => {
    const text = loaderText(V);
    const hook = sliceBetween(text, 'function installGltfModelHook(', 'function recordFor(');
    expect(hook).toMatch(
      /proto\.init = function \(\) \{\s*var r = init\.apply\(this, arguments\);\s*attachGltfModel\(this\);\s*return r;\s*\};/,
    );
    // …and it is installed after the shader component registers.
    const tail = sliceBetween(text, 'var AF = root.AFRAME;', '})(typeof globalThis');
    expect(tail.indexOf('installGltfModelHook(AF);')).toBeGreaterThan(
      tail.indexOf('AF.registerComponent("shader", componentDef);'),
    );
  });

  it('exports the glTF api, and no planMeshMaterials', () => {
    const { FS } = fresh();
    for (const k of ['gltfPlugin', 'gltfRecord', 'materialIndexOf', 'modelSignature', 'embeddedAssets', 'releaseEmbedded']) {
      expect(typeof FS[k], k).toBe('function');
    }
    expect(typeof FS.internals.resolveMaterialParts).toBe('function');
    expect('planMeshMaterials' in FS).toBe(false);
    // The reserved keyword (header delta 9) is on the api, so a page can read
    // it instead of spelling the literal.
    expect(FS.MODEL_SRC).toBe('model');
  });

  it('source: a FastShaders GLB is recognised by v === 1 alone (assets optional)', () => {
    const text = loaderText(V);
    const gate = sliceBetween(text, 'function fsExtrasOf(', 'function isFsExtras(');
    expect(gate).toContain('.v === 1');
    expect(gate).not.toContain('assets');
    // isFsExtras keeps its name for every caller and is the thin wrapper.
    const wrapper = sliceBetween(text, 'function isFsExtras(', '\n}');
    expect(wrapper).toContain('fsExtrasOf({ extras: x }) !== null');
  });
});

/**
 * The hook leans on two A-Frame internals: the `AFRAME.components[name] =
 * { Component, … }` registry, and gltf-model building its GLTFLoader in INIT
 * while loading only in UPDATE, behind `this.ready.then(…)`. An A-Frame bump
 * that moves either would silently un-index every model that loads before
 * its shader attaches, so the minified bundle's shape is pinned here.
 */
describe('the A-Frame bundle still has the gltf-model shape the hook depends on', () => {
  const bundle = readFileSync(path.join(REPO, 'public/js/a-frame-180-a-01.min.js'), 'utf8');

  it('gltf-model creates its loader in init and loads in update', () => {
    const anchor = '"gltf-model",{schema:{type:"model"},init:function(){';
    const at = bundle.indexOf(anchor);
    expect(at, 'gltf-model registration not found').toBeGreaterThan(-1);
    const body = bundle.slice(at, at + 1500);
    const updateAt = body.indexOf('update:function(){');
    expect(updateAt).toBeGreaterThan(0);
    expect(body.slice(0, updateAt)).toContain('this.loader=new ');
    const update = body.slice(updateAt, updateAt + 300);
    expect(update).toContain('this.ready.then(');
    expect(update).toContain('.loader.load(');
  });

  it('components are registered as { Component, … }', () => {
    expect(bundle).toMatch(/\[\w+\]=\{Component:\w+,dependencies:/);
  });
});
