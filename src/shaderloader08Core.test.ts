/**
 * shaderloader 0.8's CORE, executed for real — without A-Frame, against the
 * real three/webgpu, inside `vm` (src/shaderloaderHarness.ts).
 *
 * 0.8 splits 0.6's component into a framework-agnostic core on
 * `globalThis.FastShaders` and a thin A-Frame caller. The parity suites
 * (weld, per-mesh dispatch, schema, mesh edges, transforms) run the SAME
 * assertions against 0.6 and 0.8; this file covers what only 0.8 has: the
 * plain-three.js api (use / load / apply → Binding), its deltas from 0.6, and
 * the first END-TO-END run of the component — possible now because load()'s
 * two network legs are injectable (`FastShaders.fetch` / `.importSource`).
 *
 * Everything happens inside the sandbox; nothing touches the main realm's
 * globals, so `isolate: false` is safe. Objects the loader creates (Maps,
 * errors, arrays) are from the SANDBOX realm, which is why this file checks
 * `.size`, `.message` and `.name` rather than `instanceof`.
 *
 * NOT covered, and cannot be in node: the default importSource (Blob URL →
 * dynamic import → revoke). vm has no dynamic import, so it is only pinned from
 * source below; it needs a browser.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three/webgpu';
import { THREE_REVISION } from '@/engine/threeRevision';
import { tslToShaderModule } from '@/engine/tslToShaderModule';
import { PART_SETTING_KEYS } from '@/engine/materialSettingsCode';
import {
  evalLoader,
  inertGltfModelEntry,
  loaderAvailable,
  loaderText,
  makeLoaderSandbox,
  runLoaderIn,
  sliceBetween,
  transformsOf,
  type EvalLoaderOptions,
  type FastShadersApi,
} from './shaderloaderHarness';

const V = '0.8';
const TSL = THREE.TSL;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** A fresh 0.8 whose page THREE is three/webgpu, recording every warning. */
function fresh(opts: EvalLoaderOptions = {}) {
  const warns: string[] = [];
  const ev = evalLoader(V, {
    THREE,
    warn: (...a: unknown[]) => warns.push(a.map(String).join(' ')),
    ...opts,
  });
  if (!ev.FastShaders) throw new Error('0.8 installed no FastShaders api');
  return { ...ev, FS: ev.FastShaders as FastShadersApi, warns };
}

/** The value a synchronous call throws, whatever realm it comes from. */
function thrownBy(fn: () => unknown): { name?: string; message?: string } | null {
  try {
    fn();
  } catch (e) {
    return e as { name?: string; message?: string };
  }
  return null;
}

const mat = (o: { material: unknown }) => o.material as Any;
const box = () => new THREE.BoxGeometry(1, 1, 1);
const named = (name: string, geom: THREE.BufferGeometry = box()) => {
  const m = new THREE.Mesh(geom);
  m.name = name;
  return m;
};

describe.skipIf(!loaderAvailable(V))('shaderloader 0.8 — evaluation', () => {
  it('runs without A-Frame and installs the whole api', () => {
    const ev = evalLoader(V, { aframe: false });
    const api = ev.FastShaders as FastShadersApi;
    expect(api).not.toBeNull();
    for (const k of [
      'version', 'threeRevision', 'use', 'load', 'prepareSource', 'makeParams',
      'setUniform', 'apply', 'weld', 'transforms', 'internals', 'NODE_PROPS',
      'fetch', 'importSource', 'MODEL_SRC', 'loadFromGltf', 'applyFromGltf', 'disableModelModules',
    ]) {
      expect(k in api, k).toBe(true);
    }
    expect(api.MODEL_SRC).toBe('model');
    expect(api.version).toBe('0.8.0');
    expect(api.threeRevision).toBe(THREE_REVISION);
    expect(THREE.REVISION).toBe(THREE_REVISION);
    expect(api.fetch).toBeNull();
    expect(api.importSource).toBeNull();
    expect(ev.def).toBeNull();
    expect(ev.registered).toEqual([]);
  });

  it('reads no THREE, location or fetch while it evaluates', () => {
    // Throwing getters: a read at evaluation time would take the page down
    // before any shader is even named. The core resolves all three lazily.
    const { sandbox } = makeLoaderSandbox({ aframe: false });
    for (const k of ['THREE', 'location', 'fetch']) {
      Object.defineProperty(sandbox, k, {
        get() { throw new Error(`read ${k} at evaluation`); },
        configurable: true,
      });
    }
    expect(() => runLoaderIn(V, sandbox)).not.toThrow();
    expect(sandbox.FastShaders).toBeTruthy();
  });

  it('a second include is a no-op: same api, one component', () => {
    const { sandbox, registered } = makeLoaderSandbox({ THREE });
    runLoaderIn(V, sandbox);
    const first = sandbox.FastShaders;
    runLoaderIn(V, sandbox);
    expect(sandbox.FastShaders).toBe(first);
    expect(registered.names).toEqual(['shader']);
  });

  it('never registers over another loader\'s `shader` component', () => {
    // A-Frame's registerComponent THROWS on a duplicate name, so registering
    // anyway would take this whole file down on a page that also loads 0.6.
    const warns: string[] = [];
    const ev = evalLoader(V, {
      THREE,
      // gltf-model is there too, as on every real A-Frame, so the only
      // warning is the one this test is about.
      aframeComponents: { shader: {}, 'gltf-model': inertGltfModelEntry() },
      warn: (m: unknown) => warns.push(String(m)),
    });
    expect(ev.registered).toEqual([]);
    expect(ev.def).toBeNull();
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/already registered/);
    expect(ev.FastShaders).not.toBeNull();
  });
});

describe.skipIf(!loaderAvailable(V))('shaderloader 0.8 — use()', () => {
  it('refuses anything but the three/webgpu namespace', async () => {
    const plain = await import('three');
    const { FS } = fresh({ THREE: undefined });
    for (const bad of [plain, null, {}, { MeshPhysicalNodeMaterial: function () {} }]) {
      const err = thrownBy(() => FS.use(bad));
      expect(err?.name).toBe('TypeError');
      expect(err?.message).toMatch(/expected the three\/webgpu namespace/);
    }
  });

  it('installs globalThis.THREE when absent, and says so when a different one is there', () => {
    const a = fresh({ THREE: undefined });
    expect(a.FS.use(THREE)).toBe(a.FS);
    expect(a.sandbox.THREE).toBe(THREE);
    expect(a.warns).toEqual([]);

    const other = { ...THREE };
    const b = fresh({ THREE: other });
    b.FS.use(THREE);
    expect(b.sandbox.THREE).toBe(other); // never overwritten
    expect(b.warns.filter((m) => /different three\.js instance/.test(m))).toHaveLength(1);
  });

  it('warns ONCE for a page on another three revision, and never refuses', () => {
    const r190 = { ...THREE, REVISION: '190' };
    const { FS, warns } = fresh({ THREE: undefined });
    FS.use(r190);
    FS.use(r190);
    expect(warns.filter((m) => /written for three r184; this page runs r190/.test(m))).toHaveLength(1);
  });
});

describe.skipIf(!loaderAvailable(V))('shaderloader 0.8 — apply()', () => {
  it('Simple API: a bare node becomes the colour of a node material', () => {
    const { FS } = fresh();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1, 2, 2, 2));
    const red = TSL.color(0xff0000);
    const b = FS.apply(mesh, () => red);
    expect(mat(mesh).isNodeMaterial).toBe(true);
    expect(mat(mesh).colorNode).toBe(red);
    expect(b.material).toBe(mesh.material);
  });

  it('Object API: channels are copied, and emissive alone becomes the colour too', () => {
    const { FS } = fresh();
    const c = TSL.color(0x00ff00);
    const r = TSL.float(0.3);
    const a = new THREE.Mesh(box());
    FS.apply(a, () => ({ colorNode: c, roughnessNode: r }));
    expect(mat(a).colorNode).toBe(c);
    expect(mat(a).roughnessNode).toBe(r);

    const e = TSL.color(0x0000ff);
    const b = new THREE.Mesh(box());
    FS.apply(b, () => ({ emissiveNode: e }));
    expect(mat(b).emissiveNode).toBe(e);
    expect(mat(b).colorNode).toBe(e);
  });

  it('applies every per-material setting, on the default AND on a part', () => {
    // The behavioural twin of perMeshMaterials' PART_SETTING_KEYS source pin.
    const { FS } = fresh();
    // Every value differs from three's default AND from the other material's,
    // so a key applied to the wrong one, or not at all, moves an assertion.
    const dflt = { transparent: true, side: 2, alphaTest: 0.5, depthWrite: false, flatShading: true };
    const part = { transparent: true, side: 1, alphaTest: 0.25, depthWrite: false, flatShading: false };
    expect([...PART_SETTING_KEYS].sort()).toEqual(Object.keys(dflt).sort());
    const body = named('Body');
    const other = named('Other');
    const group = new THREE.Group();
    group.add(body, other);
    FS.apply(group, () => ({
      colorNode: TSL.color(1),
      ...dflt,
      parts: { Body: { colorNode: TSL.color(2), ...part } },
    }));
    for (const key of PART_SETTING_KEYS) {
      expect(mat(other)[key], `default ${key}`).toBe((dflt as Any)[key]);
      expect(mat(body)[key], `part ${key}`).toBe((part as Any)[key]);
    }
  });

  it('parts by name: a match, the multi-mesh authored fallback, the sole-mesh first part', () => {
    const { FS } = fresh();
    const c = TSL.color(0xff0000);
    const e = TSL.color(0x0000ff);

    const body = named('Body');
    const other = named('Other');
    const authoredOther = other.material;
    const group = new THREE.Group();
    group.add(body, other);
    FS.apply(group, () => ({ parts: { Body: { colorNode: c } } }));
    expect(mat(body).colorNode).toBe(c);
    expect(other.material).toBe(authoredOther);

    const only = named('Nope');
    const lone = new THREE.Group();
    lone.add(only);
    FS.apply(lone, () => ({ parts: { Glass: { colorNode: e }, Body: { colorNode: c } } }));
    expect(mat(only).colorNode).toBe(e); // FIRST part in source order
  });

  it('a materialParts-only return leaves every mesh authored — never the Simple API', () => {
    // 0.6 has no `materialParts` test in its object-API check, so it assigns
    // the whole return object to colorNode: a near-black mesh and no error.
    // A plain Group is not a primitive, so its materials are looked up in the
    // glTF plugin's records; this one was never parsed, so each apply reports
    // no-record and warns (shaderloaderMaterialParts.test.ts covers the rest).
    const { FS, warns } = fresh();
    const make = () => {
      const a = named('A');
      const b = named('B');
      const g = new THREE.Group();
      g.add(a, b);
      return { g, a, b, authored: [a.material, b.material] };
    };
    const shader = () => ({ materialParts: { 0: { colorNode: TSL.color(1) } } });
    for (let i = 0; i < 2; i++) {
      const m = make();
      const binding = FS.apply(m.g, shader, { url: 'parts.js' });
      expect(m.a.material).toBe(m.authored[0]);
      expect(m.b.material).toBe(m.authored[1]);
      expect(!!mat(m.a).isNodeMaterial).toBe(false);
      expect(binding.materialParts.status).toBe('no-record');
    }
    const mp = warns.filter((m) => /materialParts/.test(m));
    expect(mp).toHaveLength(2);
    expect(mp[0]).toMatch(/loaded without the FastShaders glTF plugin/);
  });

  it('the dispatch ladder: name > index > default > sole-mesh > authored', () => {
    const { FS } = fresh();
    const b = FS.apply(new THREE.Mesh(box()), () => TSL.color(1));
    const state = b.state;
    const tag = (t: string) => ({ tag: t });
    const part = tag('part');
    const idx = tag('index');
    const dflt = tag('default');
    const fake = (name: string, uuid: string) => ({ isMesh: true, name, uuid, material: tag(`authored:${uuid}`) });
    const modelOf = (meshes: Any[]) => {
      const root = { isMesh: false, traverse(fn: (n: unknown) => void) { fn(root); meshes.forEach(fn); } };
      return root;
    };
    state._indexPartResolver = (node: Any) => (node.name === 'Named' || node.name === 'Indexed' ? idx : null);

    // With a default: a name claim beats the index, the index beats the default.
    const withDefault = [fake('Named', 'u1'), fake('Indexed', 'u2'), fake('Plain', 'u3')];
    state.originalMaterials = {};
    FS.internals.applyMaterialToMesh(state, modelOf(withDefault), dflt, new Map([['Named', part]]));
    expect(withDefault.map((m) => m.material.tag)).toEqual(['part', 'index', 'default']);

    // No default, one mesh: the index beats the sole-mesh fallback …
    const onlyIndexed = [fake('Indexed', 'u4')];
    FS.internals.applyMaterialToMesh(state, modelOf(onlyIndexed), null, new Map([['Body', part]]));
    expect(onlyIndexed[0].material.tag).toBe('index');
    // … and with no index, the sole mesh takes the first part …
    const onlyOther = [fake('Other', 'u5')];
    FS.internals.applyMaterialToMesh(state, modelOf(onlyOther), null, new Map([['Body', part]]));
    expect(onlyOther[0].material.tag).toBe('part');
    // … while several unclaimed meshes keep what they were authored with.
    const several = [fake('X', 'u6'), fake('Y', 'u7')];
    FS.internals.applyMaterialToMesh(state, modelOf(several), null, new Map([['Body', part]]));
    expect(several.map((m) => m.material.tag)).toEqual(['authored:u6', 'authored:u7']);
    // Every mesh that was assigned is recorded, for the preview's highlight.
    expect(Object.keys(state._appliedMaterials)).toEqual(['u6', 'u7']);
  });

  it('refuses a target that is not an Object3D, and input that is nothing', () => {
    const { FS } = fresh();
    for (const target of [null, {}, 'mesh']) {
      expect(thrownBy(() => FS.apply(target, () => TSL.color(1)))?.name).toBe('TypeError');
    }
    expect(thrownBy(() => FS.apply(new THREE.Mesh(box()), null))?.name).toBe('TypeError');
  });

  it('puts the target back when the shader throws', () => {
    const { FS } = fresh();
    const geom = box();
    const mesh = new THREE.Mesh(geom);
    const authored = mesh.material;
    const err = thrownBy(() => FS.apply(mesh, () => { throw new Error('shader broke'); }));
    expect(err?.message).toBe('shader broke');
    expect(mesh.material).toBe(authored);
    expect(mesh.geometry).toBe(geom);
  });
});

describe.skipIf(!loaderAvailable(V))('shaderloader 0.8 — uniforms', () => {
  const SCHEMA = {
    speed: { type: 'number', default: 2 },
    tint: { type: 'color', default: '#ff0000' },
    tex: { type: 'map', default: '' },
  };

  it('builds a null-prototype map of the declared kinds', () => {
    const { FS } = fresh();
    const u = FS.makeParams(SCHEMA);
    expect(Object.getPrototypeOf(u)).toBeNull();
    expect(u.speed.value).toBe(2);
    expect(u.tint.value.getHexString()).toBe('ff0000');
    expect(u.tex.isTextureNode).toBe(true);
    expect(FS.makeParams(SCHEMA, { speed: 5 }).speed.value).toBe(5);
    expect(FS.setUniform(u, 'speed', 9)).toBe(true);
    expect(u.speed.value).toBe(9);
    expect(FS.setUniform(u, 'toString', 1)).toBe(false);
  });

  it('opts.values, binding.set, and names the shader does not declare', () => {
    const { FS } = fresh();
    const mesh = new THREE.Mesh(box());
    const b = FS.apply(
      mesh,
      { schema: SCHEMA, default: (p: Any) => ({ colorNode: p.tint.mul(p.speed) }) },
      { values: { speed: 3, nope: 1 } },
    );
    expect(b.uniforms.speed.value).toBe(3);
    expect(b.set('speed', 4)).toBe(true);
    expect(b.uniforms.speed.value).toBe(4);
    expect(b.set('tint', '#00ff00')).toBe(true);
    expect(b.uniforms.tint.value.getHexString()).toBe('00ff00');
    expect(b.set('nope', 1)).toBe(false);
    expect(b.set('constructor', 1)).toBe(false);
    expect(b.set('__proto__', 1)).toBe(false);

    const dt = new THREE.DataTexture(new Uint8Array([1, 2, 3, 255]), 1, 1);
    expect(b.set('tex', dt)).toBe(true);
    expect(b.uniforms.tex.value).toBe(dt);
    expect(dt.colorSpace).toBe(THREE.SRGBColorSpace);
    // Two different Textures must not collide in the texture cache (a Texture
    // has no `src`, and its `id` can be 0).
    const dt2 = new THREE.DataTexture(new Uint8Array([9, 9, 9, 255]), 1, 1);
    expect(b.set('tex', dt2)).toBe(true);
    expect(b.uniforms.tex.value).toBe(dt2);
  });
});

describe.skipIf(!loaderAvailable(V))('shaderloader 0.8 — the weld on plain three.js', () => {
  const displace = () => ({ positionNode: TSL.positionLocal.add(TSL.normalLocal.mul(0.1)) });

  it('welds a three primitive that the shader displaces', () => {
    const { FS } = fresh();
    const geom = box();
    const mesh = new THREE.Mesh(geom);
    FS.apply(mesh, displace);
    expect(mesh.geometry).not.toBe(geom);
    expect(mesh.geometry.attributes.position.count).toBe(8);
  });

  it('leaves an authored BufferGeometry alone under "auto", welds it with weld: true', () => {
    const { FS } = fresh();
    const copy = () => {
      const src = box();
      const g = new THREE.BufferGeometry();
      for (const k of ['position', 'normal', 'uv']) g.setAttribute(k, src.getAttribute(k).clone());
      g.setIndex(src.index!.clone());
      return g;
    };
    const auto = new THREE.Mesh(copy());
    FS.apply(auto, displace);
    expect(auto.geometry.type).toBe('BufferGeometry');
    expect(auto.geometry.attributes.position.count).toBe(24);

    const forced = new THREE.Mesh(copy());
    FS.apply(forced, displace, { weld: true });
    expect(forced.geometry.attributes.position.count).toBe(8);

    const refused = new THREE.Mesh(box());
    FS.apply(refused, displace, { weld: false });
    expect(refused.geometry.attributes.position.count).toBe(24);
  });

  it('honours mergeVertices: false', () => {
    const { FS } = fresh();
    const mesh = new THREE.Mesh(box());
    FS.apply(mesh, () => ({ ...displace(), mergeVertices: false }));
    expect(mesh.geometry.attributes.position.count).toBe(24);
  });

  it('welds a sphere only for a shader that reads uv()', () => {
    const { FS } = fresh();
    const sphere = new THREE.SphereGeometry(1, 36, 18);
    const a = new THREE.Mesh(sphere);
    FS.apply(a, displace);
    expect(a.geometry).toBe(sphere);

    // Without load() the default export's own text is all apply() can read,
    // so opts.source is how a caller says the module reads uv().
    const b = new THREE.Mesh(new THREE.SphereGeometry(1, 36, 18));
    FS.apply(b, displace, { source: 'positionLocal.add(uv().x)' });
    expect(b.geometry.attributes.position.count).toBe(614);
  });
});

describe.skipIf(!loaderAvailable(V))('shaderloader 0.8 — barycentric corners and dispose()', () => {
  it('adds a bary attribute, and dispose() puts everything back exactly once', () => {
    const { FS } = fresh();
    const geom = box();
    const authored = new THREE.MeshBasicMaterial();
    const mesh = new THREE.Mesh(geom, authored);
    const b = FS.apply(mesh, () => ({
      positionNode: TSL.positionLocal.add(TSL.normalLocal.mul(0.1)),
      colorNode: TSL.color(1),
      barycentric: true,
    }));
    // Welded to 8 corners, then expanded to 3 corners per triangle.
    expect(mesh.geometry.getAttribute('bary')).toBeTruthy();
    expect(mesh.geometry.attributes.position.count).toBe(36);
    let disposed = 0;
    b.material.addEventListener('dispose', () => { disposed++; });

    b.dispose();
    expect(mesh.geometry).toBe(geom);
    expect(mesh.material).toBe(authored);
    expect(disposed).toBe(1);
    expect(b.uniforms).toBeNull();

    b.dispose();
    expect(disposed).toBe(1);
    expect(b.set('anything', 1)).toBe(false);
  });
});

describe.skipIf(!loaderAvailable(V))('shaderloader 0.8 — a module\'s threeRevision', () => {
  it('warns once for another revision, never for its own or for junk', () => {
    const { FS, warns } = fresh();
    const run = (threeRevision: unknown) =>
      FS.apply(new THREE.Mesh(box()), { default: () => TSL.color(1), threeRevision });
    run('190');
    run('190');
    run('184');
    run('<b>');
    run(12345);
    run({ toString() { throw new Error('never stringified'); } });
    const moduleWarns = warns.filter((m) => /exported for three/.test(m));
    expect(moduleWarns).toHaveLength(1);
    expect(moduleWarns[0]).toMatch(/exported for three r190; this page runs r184\. If it fails to compile, load three 0\.190\.0\./);
    expect(warns.join('\n')).not.toContain('<b>');
    expect(warns.join('\n')).not.toContain('12345');
  });
});

describe.skipIf(!loaderAvailable(V))('shaderloader 0.8 — load()', () => {
  const TEXT = [
    "import { color } from 'three/tsl';",
    "import helper from './helper.js';",
    'export default () => color(0xff0000).mul(helper);',
    '',
  ].join('\n');
  const ok = (text: string) => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(text) });

  it('fetches with 0.6\'s path rule and imports exactly the prepared source', async () => {
    const { FS } = fresh();
    const calls: string[] = [];
    FS.fetch = (p: string) => { calls.push(p); return ok(TEXT); };
    const mod = { default: () => 1 };
    let received: string | null = null;
    FS.importSource = (s: string) => { received = s; return Promise.resolve(mod); };

    const loaded = await FS.load('x.js');
    expect(calls).toEqual(['./x.js']);
    expect(received).toBe(FS.prepareSource(TEXT, 'https://example.test/x.js'));
    expect(received).toContain("from 'https://example.test/helper.js'");
    expect(loaded.module).toBe(mod);
    expect(loaded.source).toBe(received);
    expect(loaded.url).toBe('x.js');

    // A blob:/data: module cannot carry a RELATIVE import — such a URL is not a
    // valid base, and resolveTSLImports' `new URL(specifier, base)` throws,
    // in 0.6 exactly as here. The path rule is what is under test, so these
    // loads use a module without one.
    FS.fetch = (p: string) => { calls.push(p); return ok("export default 1;\n"); };
    await FS.load('blob:null/1234-abcd');
    await FS.load('data:text/javascript,export%20default%201');
    await FS.load('/abs/y.js');
    expect(calls.slice(1)).toEqual(['blob:null/1234-abcd', 'data:text/javascript,export%20default%201', '/abs/y.js']);
  });

  it('rejects with 0.6\'s wording on an HTTP error', async () => {
    const { FS } = fresh();
    FS.fetch = () => Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('') });
    FS.importSource = () => Promise.resolve({});
    const err = await FS.load('x.js').then(() => null, (e: { message?: string }) => e);
    expect(err?.message).toBe('HTTP 404 loading ./x.js');
  });

  it('the default importSource is a Blob URL import, revoked however it ends', () => {
    // vm cannot run a dynamic import, so this leg is pinned from source only.
    const src = sliceBetween(loaderText(V), 'function defaultImportSource(', 'async function load(');
    expect(src).toContain('URL.createObjectURL');
    expect(src).toContain('import(blobUrl)');
    expect(src).toMatch(/\.finally\(function \(\) \{\s*URL\.revokeObjectURL\(blobUrl\);/);
  });
});

/**
 * prepareSource MUST equal 0.6's four-transform chain byte for byte: a module
 * that runs on 0.6 has to run identically on 0.8, and the transforms were
 * copied rather than rewritten precisely so this can hold.
 */
describe.skipIf(!loaderAvailable(V) || !loaderAvailable('0.6'))('shaderloader 0.8 — prepareSource equals 0.6', () => {
  const URL_ = 'https://example.test/x.js';
  const PLAIN = `import { Fn, color, uv, mx_noise_float } from 'three/tsl';

const shader = Fn(() => {
  const color1 = color(0xff0000);
  const n = mx_noise_float(uv());

  return color1.mul(n);
});

export default shader;
`;
  const WITH_PROPERTY = `import { Fn, uniform, mul, positionGeometry } from 'three/tsl';

const shader = Fn(() => {
  const amount = uniform(2.5);
  const mul1 = positionGeometry.mul(amount);

  return mul1;
});

export default shader;
`;
  const CORPUS: Array<[string, string]> = [
    ['a 0.5-era export with a property and a project block', `// TSL Shader Module — for use with a-frame-shaderloader
//
// HTML setup — these two scripts are all you need (no import map, no shim):
//   a-frame-shaderloader-0.5.js rewrites the three/tsl import to that bundle
//   <a-entity shader="src: shader.js; ecomindspeed: 0.5289"></a-entity>
//
// Properties can be updated at runtime:
//   el.setAttribute('shader', { ecomindspeed: value });

import { color, mul, time, positionGeometry, mx_noise_float } from 'three/tsl';

export const schema = { ecomindspeed: { type: 'number', default: 0.5289 } };

export default function (params) {
  const noise1 = mx_noise_float(positionGeometry.mul(mul(time, params.ecomindspeed)));
  return { colorNode: noise1, emissiveNode: color(0xff8800) };
}

/* FASTSHADERS_PROJECT_V1
{ "version": 1, "shaderName": "x", "ui": { "nodeEditorBgColor": "#FAFAFA" } }
END_FASTSHADERS_PROJECT */
`],
    ['a current export, no properties', tslToShaderModule(PLAIN)],
    ['a current export with a property', tslToShaderModule(WITH_PROPERTY, undefined, [
      { name: 'amount', type: 'float', defaultValue: 2.5 },
    ])],
    ['a TDZ-shadowing local', `import { color } from 'three/tsl';
export default function () {
  const color = color(0x14f55b);
  return color;
}
`],
    ['a parts module', `import { color, uv } from 'three/tsl';
export default function () {
  return {
    colorNode: color(0x111111),
    parts: { "Body": { colorNode: color(0x222222).mul(uv().x) }, "Glass": { colorNode: color(3), transparent: true } },
  };
}
`],
    ['three/webgpu namespace + a relative import + names to inject', `import * as THREE from 'three/webgpu';
import helper from './helper.js';
import { texture } from 'three/tsl';
const tex = new THREE.Texture();
export default function () {
  return { colorNode: texture(tex, uv()).rgb.mul(mx_noise_float(positionLocal)).mul(helper), roughnessNode: mysteryFn() };
}
`],
  ];

  it.each(CORPUS)('%s', (_name, text) => {
    const t06 = transformsOf('0.6', { THREE });
    const chain06 = t06.resolveTSLImports(
      t06.globalizeBareImports(t06.fixTSLShadowing(t06.autoInjectTSLImports(text))),
      URL_,
    );
    const api = evalLoader(V, { THREE }).FastShaders as FastShadersApi;
    expect(api.prepareSource(text, URL_)).toBe(chain06);
  });

  it('the corpus exercises every transform (so the equality above is not vacuous)', () => {
    const api = evalLoader(V, { THREE }).FastShaders as FastShadersApi;
    const out = CORPUS.map(([, text]) => api.prepareSource(text, URL_)).join('\n');
    expect(out).toContain('= globalThis.THREE.TSL;'); // globalizeBareImports
    expect(out).toContain('const THREE = globalThis.THREE;'); // namespace import
    expect(out).toContain('https://example.test/helper.js'); // resolveTSLImports
    expect(out).toContain('const __color = color(0x14f55b)'); // fixTSLShadowing
    expect(out).toMatch(/const \{[^}]*\bmx_noise_float\b[^}]*\} = globalThis\.THREE\.TSL;/); // autoInject
    expect(out).not.toMatch(/const \{[^}]*\bmysteryFn\b/); // …validated against the real TSL
  });
});

describe.skipIf(!loaderAvailable(V))('shaderloader 0.8 — the A-Frame component, end to end', () => {
  const SOURCE = "import { color } from 'three/tsl';\nexport default (p) => ({ colorNode: color(1) });\n";
  const MODULE = {
    schema: {
      speed: { type: 'number', default: 1 },
      tint: { type: 'color', default: '#ffffff' },
    },
    default: (p: Any) => ({ colorNode: p.tint.mul(p.speed) }),
  };
  const DISPLACING = {
    default: () => ({ positionNode: TSL.positionLocal.add(TSL.normalLocal.mul(0.1)) }),
  };

  function setup() {
    const ev = evalLoader(V, { THREE });
    const FS = ev.FastShaders as FastShadersApi;
    const geom = box();
    const mesh = new THREE.Mesh(geom);
    const authored = mesh.material;
    const emitted: Array<[string, unknown]> = [];
    const extendCalls: Array<Record<string, unknown>> = [];
    const ctx = Object.create(ev.def as object) as Any;
    ctx.el = {
      emit: (name: string, detail: unknown) => emitted.push([name, detail]),
      addEventListener() {},
      removeEventListener() {},
      components: { geometry: {} },
      getObject3D: (k: string) => (k === 'mesh' ? mesh : null),
      getDOMAttribute: (k: string) => (k === 'shader' ? 'src: x.js; speed: 3' : null),
      sceneEl: {},
      isConnected: true,
    };
    ctx.data = { src: 'x.js' };
    ctx.extendSchema = (s: Record<string, unknown>) => { extendCalls.push(s); };
    ctx.init();
    FS.fetch = () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(SOURCE) });
    return { FS, ctx, mesh, geom, authored, emitted, extendCalls };
  }

  /** Let the fetch → text → prepare → import chain reach the import. */
  async function until(cond: () => boolean) {
    for (let i = 0; i < 50 && !cond(); i++) await new Promise((r) => setTimeout(r, 0));
    expect(cond()).toBe(true);
  }

  it('applies: one extendSchema call, attribute values, the material, shader-applied', async () => {
    const { FS, ctx, mesh, emitted, extendCalls } = setup();
    FS.importSource = () => Promise.resolve(MODULE);
    ctx.storeOriginalMaterials(mesh);
    await ctx.applyTSLShader(mesh);

    expect(emitted).toEqual([['shader-applied', { src: 'x.js' }]]);
    expect(extendCalls).toHaveLength(1);
    expect(Object.keys(extendCalls[0]).sort()).toEqual(['speed', 'tint']);
    expect(ctx._propertyUniforms.speed.value).toBe(3); // from the attribute
    expect(mesh.material).toBe(ctx._shaderMaterial);
    expect(ctx._shaderMaterial.isNodeMaterial).toBe(true);

    // A later setAttribute reaches the live uniform through update().
    ctx.data = { src: 'x.js', speed: 7 };
    ctx.update({ src: 'x.js', speed: 3 });
    expect(ctx._propertyUniforms.speed.value).toBe(7);
  });

  it('fails cleanly: shader-error, the authored material and geometry back', async () => {
    const { FS, ctx, mesh, geom, authored, emitted } = setup();
    // First a displacing shader, so there is a weld to undo …
    FS.importSource = () => Promise.resolve(DISPLACING);
    ctx.storeOriginalMaterials(mesh);
    await ctx.applyTSLShader(mesh);
    expect(mesh.geometry).not.toBe(geom);
    expect(ctx._welded).toBeTruthy();

    // … then one that fails to import.
    FS.importSource = () => Promise.reject(new Error('boom'));
    ctx.data = { src: 'y.js' };
    await ctx.applyTSLShader(mesh);
    expect(emitted[emitted.length - 1]).toEqual(['shader-error', { src: 'y.js', message: 'boom' }]);
    expect(mesh.material).toBe(authored);
    expect(ctx._welded).toBeNull();
    expect(mesh.geometry).toBe(geom);
  });

  it('`src: model` never fetches a file: on an entity without a gltf-model it fails CLOSED, authored material kept', async () => {
    // Header delta 9. The keyword names the shader a FastShaders .glb carries
    // inside the entity's OWN model (section 13c, shaderloaderModelSrc.test.ts),
    // so the component must neither fetch a file called `./model` nor run
    // anything on a primitive — one console.error, shader-error, authored material.
    const { FS, ctx, mesh, authored, emitted } = setup();
    const fetched: string[] = [];
    FS.fetch = (url: string) => {
      fetched.push(url);
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(SOURCE) });
    };
    let imported = 0;
    FS.importSource = () => {
      imported++;
      return Promise.resolve(MODULE);
    };
    ctx.storeOriginalMaterials(mesh);
    ctx.data = { src: 'model' };
    await ctx.applyTSLShader(mesh);
    expect(fetched).toEqual([]);
    expect(imported).toBe(0);
    expect(emitted).toHaveLength(1);
    expect(emitted[0][0]).toBe('shader-error');
    const detail = emitted[0][1] as { src: string; message: string };
    expect(detail.src).toBe('model');
    expect(detail.message).toContain('src: model');
    expect(mesh.material).toBe(authored);
    expect(ctx._shaderMaterial).toBeNull();
  });

  it('a superseded apply emits nothing, whether it succeeds or fails', async () => {
    for (const outcome of ['resolve', 'reject'] as const) {
      const { FS, ctx, mesh, authored, emitted } = setup();
      let settle: ((v: unknown) => void) | null = null;
      FS.importSource = () =>
        new Promise((resolve, reject) => { settle = outcome === 'resolve' ? resolve : reject; });
      ctx.storeOriginalMaterials(mesh);
      const p = ctx.applyTSLShader(mesh);
      await until(() => settle !== null);
      ctx._currentSrc = 'something-newer.js';
      settle!(outcome === 'resolve' ? MODULE : new Error('late'));
      await p;
      expect(emitted, outcome).toEqual([]);
      expect(mesh.material, outcome).toBe(authored);
    }
  });

  it('a re-apply of a materialParts-only or mirror-only module puts every mesh back on its AUTHORED material', async () => {
    // ONE glTF entity, two applies — a preview hot-swap, a podest playlist
    // step. With no default and no surviving NAME part, the authored rung was
    // gated on name parts alone, so both meshes stayed on shader A's
    // material, which the second apply had just disposed.
    const second = {
      'materialParts-only': { materialParts: { 0: { colorNode: TSL.color(2) } }, modelSignature: { materials: ['X'] } },
      'mirror-only': {
        materialParts: { 0: { colorNode: TSL.color(2) } },
        modelSignature: { materials: ['X'] },
        parts: { Body: { colorNode: TSL.color(2) } },
        materialPartsMirror: ['Body'],
      },
    };
    for (const [label, result] of Object.entries(second)) {
      const ev = evalLoader(V, { THREE, warn: () => {} });
      const FS = ev.FastShaders as FastShadersApi;
      const a = named('Body');
      const b = named('Other');
      const group = new THREE.Group();
      group.add(a, b);
      const authored = [a.material, b.material];
      const emitted: string[] = [];
      const ctx = Object.create(ev.def as object) as Any;
      ctx.el = {
        emit: (name: string) => emitted.push(name),
        addEventListener() {},
        removeEventListener() {},
        components: { 'gltf-model': {} },
        getObject3D: (k: string) => (k === 'mesh' ? group : null),
        getDOMAttribute: (k: string) => (k === 'shader' ? 'src: a.js' : null),
        sceneEl: {},
        isConnected: true,
      };
      ctx.data = { src: 'a.js' };
      ctx.extendSchema = () => {};
      ctx.init();
      FS.fetch = () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(SOURCE) });

      FS.importSource = () => Promise.resolve({ default: () => ({ colorNode: TSL.color(1) }) });
      ctx.storeOriginalMaterials(group);
      await ctx.applyTSLShader(group);
      const first = ctx._shaderMaterial;
      expect(a.material, label).toBe(first);

      FS.importSource = () => Promise.resolve({ default: () => result });
      ctx.data = { src: 'b.js' };
      await ctx.applyTSLShader(group);
      expect(emitted[emitted.length - 1], label).toBe('shader-applied');
      expect(a.material, label).toBe(authored[0]);
      expect(b.material, label).toBe(authored[1]);
      // What the preview's highlight-clear restores agrees with the screen.
      expect(ctx._appliedMaterials[a.uuid], label).toBe(authored[0]);
      expect(ctx._appliedMaterials[b.uuid], label).toBe(authored[1]);
      expect(Object.values(ctx._appliedMaterials), label).not.toContain(first);
    }
  });

  it('remove() restores the entity and drops the uniforms', async () => {
    const { FS, ctx, mesh, authored } = setup();
    FS.importSource = () => Promise.resolve(MODULE);
    ctx.storeOriginalMaterials(mesh);
    await ctx.applyTSLShader(mesh);
    ctx.remove();
    expect(mesh.material).toBe(authored);
    expect(ctx._propertyUniforms).toBeNull();
    expect(ctx._shaderMaterial).toBeNull();
  });
});
