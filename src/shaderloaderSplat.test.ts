/**
 * shaderloader 0.8's Gaussian-splat section (header delta 10, section 9b),
 * executed for real in `vm` (src/shaderloaderHarness.ts) against three/webgpu,
 * on REAL GaussianSplats built by the vendored runtime (public/js/fs-splat-0.1.js,
 * evaluated in its own sandbox over the same three).
 *
 * What it pins:
 *   - INERTNESS. `isGaussianSplat` is undefined on every other three object, a
 *     module without `splat` builds nothing new, `unsplat` returns at once on a
 *     state that wrapped nothing — and a GaussianSplat under a module WITHOUT
 *     `splat` keeps the addon's material (0.8.0 replaced it: opaque black).
 *   - A splat-only module is the object API: ordinary meshes keep, or go BACK
 *     to, their authored materials, and a target with no splat warns once.
 *   - The wrap: per instance, the addon's material object kept, its vertex node
 *     wrapped, its colour node untouched, onBeforeRender replaced by one that
 *     never re-imposes the addon's vertex node; unsplat restores all three
 *     identities (Binding.dispose, the component's remove/failure, re-apply).
 *   - Degradation: missing private names or spherical harmonics warn and edit
 *     nothing; a spec that throws — at apply, or later while the shader is
 *     built — puts that splat back and rethrows.
 *   - The weld and the barycentric corners never touch the instanced quad.
 *
 * The runtime file is read inside tests only (never at module top level).
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import * as THREE from 'three/webgpu';
import { REPO, evalLoader, loaderAvailable, type FastShadersApi } from './shaderloaderHarness';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const V = '0.8';
const TSL = THREE.TSL;
const RUNTIME = path.join(REPO, 'public/js/fs-splat-0.1.js');
const ready = loaderAvailable(V) && existsSync(RUNTIME);

const TYPED = {
  ArrayBuffer, DataView, Uint8Array, Uint8ClampedArray, Uint16Array, Uint32Array,
  Int8Array, Int16Array, Int32Array, Float32Array, Float64Array,
};

/** FastShadersSplat, from the shipped runtime, over three/webgpu. */
function splatRuntime(): Any {
  const sandbox: Record<string, unknown> = {
    THREE, console: { log() {}, warn() {}, error() {} }, Blob, DecompressionStream, TextDecoder, ...TYPED,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(RUNTIME, 'utf8'), sandbox, { filename: RUNTIME });
  return sandbox.FastShadersSplat;
}

/** A fresh 0.8 over three/webgpu, recording every warning. */
function fresh() {
  const warns: string[] = [];
  const ev = evalLoader(V, { THREE, warn: (...a: unknown[]) => warns.push(a.map(String).join(' ')) });
  return { ...ev, FS: ev.FastShaders as FastShadersApi, warns };
}

/** A real GaussianSplat of `n` splats (degree 0 unless `sh1`). */
function makeSplat(F: Any, n = 4, opts: { autoSort?: boolean; sh1?: boolean } = {}) {
  const centers = new Float32Array(n * 3).map((_, i) => ((i * 7) % 11) * 0.1 - 0.5);
  const cov = new Float32Array(n * 6);
  for (let i = 0; i < n; i++) { cov[i * 6] = 0.01; cov[i * 6 + 3] = 0.01; cov[i * 6 + 5] = 0.01; }
  const colors = new Uint8ClampedArray(n * 4).fill(200);
  const sh = opts.sh1 ? { sh1: new Uint32Array(n * 3).fill(0x80808080) } : {};
  return new F.GaussianSplat(F.createGaussianSplatGeometry(centers, cov, colors, sh), { autoSort: opts.autoSort ?? false });
}

/** What the addon put on a splat, to compare identities against. */
function identities(s: Any) {
  return {
    material: s.material,
    vertexNode: s.material.vertexNode,
    colorNode: s.material.colorNode,
    onBeforeRender: s.onBeforeRender,
    geometry: s.geometry,
  };
}

const SPEC = () => ({
  shade: TSL.Fn(([, , , c]: Any[]) => TSL.vec4(TSL.mix(c.rgb, TSL.vec3(1, 0, 0), 0.5), 1)),
  shape: TSL.Fn(([p]: Any[]) => TSL.vec4(TSL.vec3(0, 0.1, 0), TSL.length(p).sub(0.4))),
  feather: 0.05,
});
const splatModule = (spec: Any = SPEC()) => ({ default: () => ({ splat: spec }) });
const colourModule = () => ({ default: () => ({ colorNode: TSL.color(0xff0000) }) });

/** The r184 headless GLSL build (the splat-test-184 recipe): a stub renderer. */
function buildGlsl(object: Any) {
  const renderer = {
    contextNode: TSL.context(),
    library: { fromMaterial: (m: unknown) => m },
    backend: {
      isWebGLBackend: true, isWebGPUBackend: false,
      capabilities: { getUniformBufferLimit: () => 65536 },
      extensions: { has: () => false }, has: () => false, get: () => ({}),
    },
    getRenderTarget: () => null, getMRT: () => null,
    debug: { diagnostics: { keywords: false } },
    lighting: { enabled: false },
    _currentRenderContext: null,
  };
  const builder: Any = new (THREE as Any).GLSLNodeBuilder(object, renderer);
  builder.scene = new THREE.Scene();
  builder.material = object.material;
  builder.camera = new THREE.PerspectiveCamera();
  builder.lightsNode = null;
  builder.environmentNode = null;
  builder.fogNode = null;
  builder.clippingContext = null;
  builder.build();
  return { vs: builder.vertexShader as string, fs: builder.fragmentShader as string };
}

const WARN_NO_TARGET = 'there is no GaussianSplat here';
const WARN_SHAPE = 'splat shading skipped: this GaussianSplat lacks';
const WARN_SH = 'carries view-dependent colour';

describe.skipIf(!ready)('shaderloader 0.8 — splats: inertness', () => {
  it('isGaussianSplat is undefined on every other three object', () => {
    for (const o of [
      new THREE.Mesh(), new THREE.InstancedMesh(new THREE.BoxGeometry(), undefined, 2),
      new THREE.SkinnedMesh(), new THREE.Points(), new THREE.Group(), new THREE.Object3D(),
    ]) {
      expect((o as Any).isGaussianSplat).toBeUndefined();
    }
  });

  it('a module without `splat` builds exactly what it did; a splat-only one is the object API', () => {
    const { FS } = fresh();
    const plain = FS.internals.buildMaterials({ colorNode: TSL.color(1) });
    expect(plain.splat).toBeNull();
    expect(plain.material.isNodeMaterial).toBe(true);
    const simple = FS.internals.buildMaterials(TSL.color(1));
    expect(simple.splat).toBeNull();
    expect(simple.material.colorNode).toBeTruthy();
    // Splat-only: no material at all — never the Simple-API one whose
    // colorNode would be the result object.
    const spec = SPEC();
    const only = FS.internals.buildMaterials({ splat: spec });
    expect(only.material).toBeNull();
    expect(only.partMaterials).toBeNull();
    expect(only.splat).toBe(spec);
    // Not an object → not a splat spec (falls through to the old rules).
    expect(FS.internals.buildMaterials({ colorNode: TSL.color(1), splat: 1 }).splat).toBeNull();
  });

  it('unsplat returns at once on a state that wrapped nothing', () => {
    const { FS } = fresh();
    const bare: Record<string, unknown> = {};
    FS.internals.unsplat(bare);
    expect(bare).toEqual({});
    const idle = { _splatWraps: null };
    FS.internals.unsplat(idle);
    expect(idle).toEqual({ _splatWraps: null });
  });

  it('exposes SPLAT_PARAMS, frozen, in the contract order', () => {
    const { FS } = fresh();
    expect([...FS.SPLAT_PARAMS]).toEqual(['p', 'pw', 'n', 'c']);
    expect(Object.isFrozen(FS.SPLAT_PARAMS)).toBe(true);
  });

  it('a plain apply without `splat` leaves the splat state empty', () => {
    const { FS, warns } = fresh();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry());
    const b = FS.apply(mesh, colourModule());
    expect(b.splats).toBe(0);
    expect(b.state._splatWraps).toBeNull();
    expect(b.state._splatStatus).toBeNull();
    expect(warns).toEqual([]);
  });
});

describe.skipIf(!ready)('shaderloader 0.8 — a GaussianSplat under a module WITHOUT `splat`', () => {
  it('keeps the addon material, both nodes and onBeforeRender (object and Simple API)', () => {
    const F = splatRuntime();
    for (const mod of [colourModule(), { default: () => TSL.color(0x00ff00) }]) {
      const { FS } = fresh();
      const s = makeSplat(F);
      const before = identities(s);
      const b = FS.apply(s, mod);
      expect(identities(s)).toEqual(before);
      expect(s.material).toBe(before.material);
      expect(s.material.vertexNode).toBe(before.vertexNode);
      expect(b.applied[s.uuid]).toBeUndefined();
      expect(b.state.originalMaterials[s.uuid]).toBeUndefined();
      b.dispose();
      expect(s.material).toBe(before.material);
    }
  });

  it('in a group, the mesh takes the shader and the splat keeps its own', () => {
    const F = splatRuntime();
    const { FS } = fresh();
    const g = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry());
    const authored = mesh.material;
    const s = makeSplat(F);
    const before = identities(s);
    g.add(mesh, s);
    const b = FS.apply(g, colourModule());
    expect(mesh.material).toBe(b.material);
    expect(identities(s)).toEqual(before);
    b.dispose();
    expect(mesh.material).toBe(authored);
    expect(identities(s)).toEqual(before);
  });

  it('the parts-only single-mesh fallback counts ordinary meshes only', () => {
    const F = splatRuntime();
    const { FS } = fresh();
    const g = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry());
    mesh.name = 'Unmatched';
    g.add(mesh, makeSplat(F));
    const b = FS.apply(g, { default: () => ({ parts: { Other: { colorNode: TSL.color(1) } } }) });
    // One ordinary mesh → the first part, exactly as for a model with no splat.
    expect(mesh.material).toBe(b.parts.get('Other'));
  });
});

describe.skipIf(!ready)('shaderloader 0.8 — a splat-only module', () => {
  it('on a plain mesh: the authored material stays, nothing is built, one warning', () => {
    const { FS, warns } = fresh();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry());
    const authored = mesh.material;
    const b = FS.apply(mesh, splatModule());
    expect(mesh.material).toBe(authored);
    expect(b.material).toBeNull();
    expect(b.splats).toBe(0);
    expect(b.state._splatStatus).toBe('no-target');
    expect(warns.filter((w) => w.includes(WARN_NO_TARGET))).toHaveLength(1);
    FS.apply(new THREE.Mesh(), splatModule());
    expect(warns.filter((w) => w.includes(WARN_NO_TARGET))).toHaveLength(1); // once per page
  });

  it('on a re-apply, a mesh wearing the previous shader goes BACK to its authored material', () => {
    const { FS } = fresh();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry());
    const authored = mesh.material;
    const state: Any = { originalMaterials: {}, _baryOwned: [] };
    FS.internals.storeOriginalMaterials(state, mesh);
    FS.internals.applyResult(state, mesh, { module: colourModule(), source: '' }, {});
    expect(mesh.material).toBe(state._shaderMaterial);
    FS.internals.applyResult(state, mesh, { module: splatModule(), source: '' }, {});
    expect(mesh.material).toBe(authored);
    expect(state._shaderMaterial).toBeNull();
  });
});

describe.skipIf(!ready)('shaderloader 0.8 — the wrap, through FS.apply and Binding.dispose', () => {
  it('wraps the vertex node per instance and restores every identity on dispose', () => {
    const F = splatRuntime();
    const { FS, warns } = fresh();
    const s = makeSplat(F);
    const before = identities(s);
    const v0 = s.material.version;
    const b = FS.apply(s, splatModule());
    expect(b.splats).toBe(1);
    expect(b.state._splatStatus).toBe('applied');
    expect(s.material).toBe(before.material); // the addon's material, kept
    expect(s.material.vertexNode).not.toBe(before.vertexNode);
    expect(s.material.vertexNode.isNode).toBe(true);
    expect(s.material.colorNode).toBe(before.colorNode); // the kernel untouched
    expect(s.onBeforeRender).not.toBe(before.onBeforeRender);
    expect(s.geometry).toBe(before.geometry);
    expect(s.material.version).toBeGreaterThan(v0);
    const rec = b.state._splatWraps[0];
    expect(rec.node).toBe(s);
    expect(rec.vertexNode).toBe(before.vertexNode);
    expect(warns).toEqual([]);

    const v1 = s.material.version;
    b.dispose();
    expect(identities(s)).toEqual(before);
    expect(s.material.version).toBeGreaterThan(v1);
    expect(b.splats).toBe(0);
    b.dispose(); // a second call does nothing
    expect(identities(s)).toEqual(before);
  });

  it('two splats get two wrapper graphs; the ordinary mesh beside them stays authored', () => {
    const F = splatRuntime();
    const { FS } = fresh();
    const g = new THREE.Group();
    const a = makeSplat(F);
    const c = makeSplat(F, 6);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry());
    const authored = mesh.material;
    g.add(a, mesh, c);
    const ia = identities(a);
    const ic = identities(c);
    const b = FS.apply(g, splatModule());
    expect(b.splats).toBe(2);
    expect(a.material.vertexNode).not.toBe(c.material.vertexNode);
    expect(mesh.material).toBe(authored);
    b.dispose();
    expect(identities(a)).toEqual(ia);
    expect(identities(c)).toEqual(ic);
  });

  it('the new onBeforeRender calls the two public updates and never re-imposes the addon node', () => {
    const F = splatRuntime();
    const { FS } = fresh();
    const s = makeSplat(F, 4, { autoSort: true });
    const addonHook = s.onBeforeRender;
    FS.apply(s, splatModule());
    const wrapper = s.material.vertexNode;
    const calls: string[] = [];
    s.updateSphericalHarmonics = () => { calls.push('sh'); return false; };
    s.updateSort = () => { calls.push('sort'); return false; };
    const webgpu = { backend: { isWebGPUBackend: true, isWebGLBackend: false } };
    const cam = new THREE.PerspectiveCamera();
    s.onBeforeRender(webgpu, new THREE.Scene(), cam);
    expect(calls).toEqual(['sh', 'sort']);
    expect(s.material.vertexNode).toBe(wrapper);
    s.autoSort = false;
    s.onBeforeRender(webgpu, new THREE.Scene(), cam);
    expect(calls).toEqual(['sh', 'sort', 'sh']);
    // Why it is replaced: the addon's own hook puts its node back.
    addonHook(webgpu, new THREE.Scene(), cam);
    expect(s.material.vertexNode).not.toBe(wrapper);
  });

  it('a re-apply wraps ONCE: the new wrapper wraps the addon node, not the old wrapper', () => {
    const F = splatRuntime();
    const { FS } = fresh();
    const s = makeSplat(F);
    const before = identities(s);
    const state: Any = { originalMaterials: {}, _baryOwned: [] };
    FS.internals.applyResult(state, s, { module: splatModule(), source: '' }, {});
    const first = s.material.vertexNode;
    FS.internals.applyResult(state, s, { module: splatModule(), source: '' }, {});
    expect(state._splatWraps).toHaveLength(1);
    expect(state._splatWraps[0].vertexNode).toBe(before.vertexNode);
    expect(s.material.vertexNode).not.toBe(first);
    // A module without `splat` next: the splat is back on the addon's node.
    FS.internals.applyResult(state, s, { module: colourModule(), source: '' }, {});
    expect(identities(s)).toEqual(before);
    expect(state._splatWraps).toBeNull();
  });

  it('wrapSplats / unsplat through internals', () => {
    const F = splatRuntime();
    const { FS } = fresh();
    const s = makeSplat(F);
    const before = identities(s);
    const state: Any = {};
    expect(FS.internals.wrapSplats(state, s, SPEC())).toBe(1);
    expect(FS.internals.wrapSplats(state, s, SPEC())).toBe(1); // unsplats first
    expect(state._splatWraps[0].vertexNode).toBe(before.vertexNode);
    FS.internals.unsplat(state);
    expect(identities(s)).toEqual(before);
    expect(state._splatWraps).toBeNull();
  });
});

describe.skipIf(!ready)('shaderloader 0.8 — splats never reach the weld or the corners', () => {
  it('weld: true and barycentric on a splat leave the instanced quad alone', () => {
    const F = splatRuntime();
    const { FS } = fresh();
    const s = makeSplat(F, 5);
    const before = identities(s);
    const b = FS.apply(
      s,
      { default: () => ({ positionNode: TSL.positionLocal.mul(1.1), barycentric: true, splat: SPEC() }) },
      { weld: true },
    );
    expect(s.geometry).toBe(before.geometry);
    expect(s.geometry.isInstancedBufferGeometry).toBe(true);
    expect(s.geometry.instanceCount).toBe(5);
    expect(s.geometry.getAttribute('bary')).toBeUndefined();
    expect(b.state._welded).toBeNull();
    expect(s.material).toBe(before.material); // the positionNode material is not the splat's
    b.dispose();
    expect(identities(s)).toEqual(before);
  });

  it('syncWeld on a splat root and syncBary over a group with a splat', () => {
    const F = splatRuntime();
    const { FS } = fresh();
    const s = makeSplat(F);
    const geom = s.geometry;
    const state: Any = { _weldWanted: true, _weldUvDriven: true, _welded: null, _weldSource: null, _weldScanned: null, _baryOwned: [], _baryWanted: true };
    FS.internals.syncWeld(state, s);
    expect(s.geometry).toBe(geom);
    expect(state._welded).toBeNull();
    const g = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry());
    g.add(mesh, s);
    FS.internals.syncBary(state, g);
    expect(mesh.geometry.getAttribute('bary')).toBeTruthy();
    expect(s.geometry).toBe(geom);
    expect(state._baryOwned).toHaveLength(1);
  });
});

describe.skipIf(!ready)('shaderloader 0.8 — splats that cannot be wrapped', () => {
  it('missing private names: one warning, nothing edited, no throw', () => {
    const { FS, warns } = fresh();
    const material = new THREE.NodeMaterial();
    material.vertexNode = TSL.vec4(0, 0, 0, 1);
    const fake: Any = new THREE.Mesh(new THREE.BoxGeometry(), material);
    fake.isGaussianSplat = true;
    fake.updateSort = () => {};
    fake.updateSphericalHarmonics = () => {};
    const hook = fake.onBeforeRender;
    const vn = material.vertexNode;
    let b: Any;
    expect(() => { b = FS.apply(fake, splatModule()); }).not.toThrow();
    expect(b.splats).toBe(0);
    expect(b.state._splatStatus).toBe('unavailable');
    expect(material.vertexNode).toBe(vn);
    expect(fake.onBeforeRender).toBe(hook);
    expect(fake.material).toBe(material);
    expect(warns.filter((w) => w.includes(WARN_SHAPE))).toHaveLength(1);
    // _buffers without _sort: the same.
    fake._buffers = { centerRead: TSL.vec4(0) };
    expect(FS.apply(fake, splatModule()).splats).toBe(0);
    expect(warns.filter((w) => w.includes(WARN_SHAPE))).toHaveLength(1); // once per page
  });

  it('a splat that still carries spherical harmonics is left alone, with its own warning', () => {
    const F = splatRuntime();
    const { FS, warns } = fresh();
    const s = makeSplat(F, 3, { sh1: true });
    expect(s._sphericalHarmonicsVertexNode).not.toBeNull();
    const before = identities(s);
    const b = FS.apply(s, splatModule());
    expect(b.splats).toBe(0);
    expect(identities(s)).toEqual(before);
    expect(warns.filter((w) => w.includes(WARN_SH))).toHaveLength(1);
  });
});

describe.skipIf(!ready)('shaderloader 0.8 — a splat spec that throws', () => {
  it('at apply (a plain function): the apply throws and leaves every target as authored', () => {
    const F = splatRuntime();
    const { FS } = fresh();
    const g = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry());
    const authored = mesh.material;
    const s = makeSplat(F);
    const before = identities(s);
    g.add(mesh, s);
    const boom = { default: () => ({ colorNode: TSL.color(1), splat: { shade: () => { throw new Error('boom'); } } }) };
    expect(() => FS.apply(g, boom)).toThrow('boom');
    expect(mesh.material).toBe(authored);
    expect(identities(s)).toEqual(before);
    // A plain function that returns no node fails the apply the same way.
    const bad = { default: () => ({ splat: { shape: () => 3 } }) };
    expect(() => FS.apply(s, bad)).toThrow('splat.shape(p, pw, n, c) must return a TSL node');
    expect(identities(s)).toEqual(before);
  });

  it('size / feather functions may return a number or nothing: they fall back, the apply stands', () => {
    const F = splatRuntime();
    const { FS } = fresh();
    const s = makeSplat(F);
    const b = FS.apply(s, splatModule({ size: () => 2, feather: () => undefined, shape: SPEC().shape }));
    expect(b.splats).toBe(1);
    expect(buildGlsl(s).vs).toMatch(/fsS = min\( 2\.0,/);
  });

  it('while the shader is BUILT (a TSL Fn body): that splat is put back, the error goes on', () => {
    const F = splatRuntime();
    const { FS } = fresh();
    const s = makeSplat(F);
    const before = identities(s);
    const b = FS.apply(s, splatModule({ shade: TSL.Fn(() => { throw new Error('tsl boom'); }) }));
    expect(b.splats).toBe(1);
    expect(() => buildGlsl(s)).toThrow('tsl boom');
    expect(identities(s)).toEqual(before);
    expect(b.splats).toBe(0);
    // The next build is the addon's own shader.
    expect(buildGlsl(s).vs).toContain('vSplatColor');
  });

  it('while the shader is BUILT (a plain function that passed the apply): the same', () => {
    const F = splatRuntime();
    const { FS } = fresh();
    const s = makeSplat(F);
    const before = identities(s);
    let calls = 0;
    const flaky = (p: Any) => {
      calls++;
      if (calls > 1) throw new Error('second call');
      return TSL.vec4(p, 1);
    };
    const b = FS.apply(s, splatModule({ shade: flaky }));
    expect(calls).toBe(1); // the apply-time probe
    expect(() => buildGlsl(s)).toThrow('second call');
    expect(identities(s)).toEqual(before);
    expect(b.splats).toBe(0);
  });
});

describe.skipIf(!ready)('shaderloader 0.8 — splats through the A-Frame component', () => {
  function setup(target: Any) {
    const ev = fresh();
    const FS = ev.FS;
    const emitted: Array<[string, unknown]> = [];
    const ctx = Object.create(ev.def as object) as Any;
    ctx.el = {
      emit: (name: string, detail: unknown) => emitted.push([name, detail]),
      addEventListener() {},
      removeEventListener() {},
      components: {},
      getObject3D: (k: string) => (k === 'mesh' ? target : null),
      getDOMAttribute: () => 'src: x.js',
      sceneEl: {},
      isConnected: true,
    };
    ctx.data = { src: 'x.js' };
    ctx.extendSchema = () => {};
    ctx.init();
    FS.fetch = () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('export default () => ({});\n') });
    return { FS, ctx, emitted, warns: ev.warns };
  }

  it('wraps on the splat-model mesh, emits shader-splat before shader-applied, and remove() restores', async () => {
    const F = splatRuntime();
    const s = makeSplat(F);
    const before = identities(s);
    const { FS, ctx, emitted } = setup(s);
    FS.importSource = () => Promise.resolve(splatModule());
    ctx.applyShader();
    await new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < 50 && emitted.length === 0; i++) await new Promise((r) => setTimeout(r, 0));
    expect(emitted).toEqual([
      ['shader-splat', { src: 'x.js', splats: 1 }],
      ['shader-applied', { src: 'x.js' }],
    ]);
    expect(s.material).toBe(before.material);
    expect(s.material.vertexNode).not.toBe(before.vertexNode);

    // A re-apply (a hot swap) wraps once.
    await ctx.applyTSLShader(s);
    expect(ctx._splatWraps).toHaveLength(1);
    expect(ctx._splatWraps[0].vertexNode).toBe(before.vertexNode);

    ctx.remove();
    expect(identities(s)).toEqual(before);
    expect(ctx._splatWraps).toBeNull();
  });

  it('a failed apply after a wrap puts the splat back and emits shader-error', async () => {
    const F = splatRuntime();
    const s = makeSplat(F);
    const before = identities(s);
    const { FS, ctx, emitted } = setup(s);
    FS.importSource = () => Promise.resolve(splatModule());
    await ctx.applyTSLShader(s);
    expect(s.material.vertexNode).not.toBe(before.vertexNode);
    FS.importSource = () => Promise.resolve({ default: () => ({ splat: { shade: () => { throw new Error('boom'); } } }) });
    ctx.data = { src: 'y.js' };
    await ctx.applyTSLShader(s);
    expect(emitted[emitted.length - 1]).toEqual(['shader-error', { src: 'y.js', message: 'boom' }]);
    expect(identities(s)).toEqual(before);
  });

  it('a module without `splat` on a splat entity: no shader-splat, the addon material kept', async () => {
    const F = splatRuntime();
    const s = makeSplat(F);
    const before = identities(s);
    const { FS, ctx, emitted } = setup(s);
    FS.importSource = () => Promise.resolve(colourModule());
    await ctx.applyTSLShader(s);
    expect(emitted).toEqual([['shader-applied', { src: 'x.js' }]]);
    expect(identities(s)).toEqual(before);
  });
});
