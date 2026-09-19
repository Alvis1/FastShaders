/**
 * shaderloader 0.8's `materialParts` DISPATCH, executed for real: the vendored
 * loader in `vm` over three/webgpu, and records seeded by parsing real glTF
 * through `FastShaders.gltfPlugin` (there is no back door into its WeakMaps).
 *
 * Precedence per mesh: a `parts` NAME claim (mirror keys excluded) > the
 * materialParts entry for the mesh's recorded glTF material index (only when
 * the status is `applied`) > the default material > the single-mesh first-part
 * fallback (NAME parts only) > the authored material.
 *
 * Also here: the 0.6 half of the export guard, pinned against the FROZEN 0.6
 * text — a materialParts-ONLY module takes 0.6's Simple-API branch, and a bare
 * `parts: {}` is what keeps it off it — and the contract constants in
 * src/engine/materialPartsContract.ts against the loader's restatement.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  LOADER_MATERIAL_PARTS_MAX,
  MATERIAL_PART_KEY_RE,
  SIGNATURE_MATERIALS_MAX,
  SIGNATURE_NAME_MAX,
  checkLegacyGuard,
} from '@/engine/materialPartsContract';
import {
  evalLoader,
  loaderAvailable,
  loaderText,
  sliceBetween,
  type FastShadersApi,
} from './shaderloaderHarness';
import { GLTF_NODE_GLOBALS, gltfText, materials, parseWith, type GltfSpec } from './gltfTestFixtures';

const V = '0.8';
const TSL = THREE.TSL;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

beforeEach(() => {
  for (const [k, v] of Object.entries(GLTF_NODE_GLOBALS)) vi.stubGlobal(k, v);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function fresh() {
  const warns: string[] = [];
  const ev = evalLoader(V, {
    THREE,
    warn: (...a: unknown[]) => warns.push(a.map(String).join(' ')),
    globals: { document: { querySelectorAll: () => [] } },
  });
  if (!ev.FastShaders) throw new Error('0.8 installed no FastShaders api');
  return { ...ev, FS: ev.FastShaders as FastShadersApi, warns };
}

function byName(root: THREE.Object3D, name: string): Any {
  const o = root.getObjectByName(name);
  if (!o) throw new Error(`fixture has no object named ${name}`);
  return o;
}

/**
 * Materials Body/Glass/Trim. Hull and Hull2 share material 0, Window and Named
 * wear 1, Plain wears 2, Bare has none. (Mesh names differ from node names so
 * GLTFLoader's unique-naming never renames a node.)
 */
const SPEC: GltfSpec = {
  materials: materials(['Body', 'Glass', 'Trim']),
  meshes: [
    { name: 'm-hull', primitives: [{ material: 0 }] },
    { name: 'm-window', primitives: [{ material: 1 }] },
    { name: 'm-trim', primitives: [{ material: 2 }] },
    { name: 'm-bare', primitives: [{}] },
  ],
  nodes: [
    { name: 'Hull', mesh: 0 },
    { name: 'Hull2', mesh: 0 },
    { name: 'Window', mesh: 1 },
    { name: 'Named', mesh: 1 },
    { name: 'Plain', mesh: 2 },
    { name: 'Bare', mesh: 3 },
  ],
};
const SIG = { materials: ['Body', 'Glass', 'Trim'] };
const MESHES = ['Hull', 'Hull2', 'Window', 'Named', 'Plain', 'Bare'];

/** One mesh, on material 0 of two. */
const SOLO: GltfSpec = {
  materials: materials(['Body', 'Glass']),
  meshes: [{ name: 'm-solo', primitives: [{ material: 0 }] }],
  nodes: [{ name: 'Solo', mesh: 0 }],
};
const SOLO_SIG = { materials: ['Body', 'Glass'] };

async function parsed(FS: FastShadersApi, spec: GltfSpec = SPEC) {
  const gltf = await parseWith([FS.gltfPlugin], gltfText(spec));
  const scene = gltf.scene;
  const authored = new Map(MESHES.concat('Solo').flatMap((n) => {
    const o = scene.getObjectByName(n) as Any;
    return o ? [[n, o.material]] : [];
  }));
  return { scene, authored };
}

const node = () => TSL.color(Math.random());

describe.skipIf(!loaderAvailable(V))('materialParts — precedence', () => {
  it('name part > index part > default; one shared material per index', async () => {
    const { FS, warns } = fresh();
    const { scene } = await parsed(FS);
    const [dflt, part, i0, i1] = [node(), node(), node(), node()];
    const b = FS.apply(scene, () => ({
      colorNode: dflt,
      parts: { Named: { colorNode: part } },
      materialParts: { 0: { colorNode: i0 }, 1: { colorNode: i1 } },
      modelSignature: SIG,
    }));
    const m = (n: string) => byName(scene, n).material;
    expect(m('Named').colorNode).toBe(part); // a name claim beats index 1
    expect(m('Window').colorNode).toBe(i1);
    expect(m('Hull').colorNode).toBe(i0);
    expect(m('Hull')).toBe(m('Hull2')); // ONE material for glTF material 0
    expect(m('Plain').colorNode).toBe(dflt); // index 2 has no entry
    expect(m('Bare').colorNode).toBe(dflt); // no glTF material at all
    expect(b.materialParts).toEqual({ status: 'applied', applied: 2, dropped: 0, expected: 3, found: 3 });
    expect([...b.state._indexPartMaterials.keys()]).toEqual([0, 1]);
    expect(b.state._indexPartMaterials.get(0).colorNode).toBe(i0);
    expect(warns).toEqual([]);
  });

  it('without a default the unclaimed meshes stay authored, and every mesh is recorded', async () => {
    const { FS } = fresh();
    const { scene, authored } = await parsed(FS);
    const [part, i0] = [node(), node()];
    const b = FS.apply(scene, () => ({
      parts: { Named: { colorNode: part } },
      materialParts: { 0: { colorNode: i0 } },
      modelSignature: SIG,
    }));
    for (const n of ['Window', 'Plain', 'Bare']) expect(byName(scene, n).material, n).toBe(authored.get(n));
    expect(byName(scene, 'Hull').material.colorNode).toBe(i0);
    expect(byName(scene, 'Named').material.colorNode).toBe(part);
    // _appliedMaterials: the index-claimed AND the authored meshes (0.6's rule).
    const uuids = MESHES.map((n) => byName(scene, n).uuid).sort();
    expect(Object.keys(b.applied).sort()).toEqual(uuids);
    expect(b.applied[byName(scene, 'Hull').uuid]).toBe(byName(scene, 'Hull').material);

    b.dispose();
    for (const n of MESHES) expect(byName(scene, n).material, n).toBe(authored.get(n));
    expect(b.materialParts).toBeNull();
  });

  it('only index parts: a materialParts entry is built by the same buildMaterial as a part', async () => {
    const { FS } = fresh();
    const { scene, authored } = await parsed(FS);
    const i2 = node();
    FS.apply(scene, () => ({
      parts: {},
      materialParts: { 2: { colorNode: i2, transparent: true, side: THREE.DoubleSide, alphaTest: 0.3, depthWrite: false } },
      modelSignature: SIG,
    }));
    const plain = byName(scene, 'Plain').material;
    expect(plain.colorNode).toBe(i2);
    expect([plain.transparent, plain.side, plain.alphaTest, plain.depthWrite]).toEqual([true, THREE.DoubleSide, 0.3, false]);
    expect(byName(scene, 'Hull').material).toBe(authored.get('Hull'));
    // Source: the index loop calls buildMaterial itself, not a copy of it.
    const apply = sliceBetween(loaderText(V), 'function applyResult(', 'function fnText(');
    expect(apply).toContain('indexMaterials.set(index, buildMaterial(spec));');
  });
});

describe.skipIf(!loaderAvailable(V))('materialParts — statuses', () => {
  const run = async (result: Record<string, unknown>) => {
    const { FS, warns } = fresh();
    const { scene, authored } = await parsed(FS);
    const b = FS.apply(scene, () => result);
    return { FS, warns, scene, authored, b };
  };

  it('mismatch — count, one name, or order — drops ONLY the index table', async () => {
    for (const materialsList of [['Body', 'Glass'], ['Body', 'Glaze', 'Trim'], ['Glass', 'Body', 'Trim']]) {
      const [dflt, part, i0] = [node(), node(), node()];
      const { warns, scene, b } = await run({
        colorNode: dflt,
        parts: { Named: { colorNode: part } },
        materialParts: { 0: { colorNode: i0 } },
        modelSignature: { materials: materialsList },
      });
      expect(b.materialParts.status).toBe('mismatch');
      expect(byName(scene, 'Hull').material.colorNode).toBe(dflt);
      expect(byName(scene, 'Named').material.colorNode).toBe(part);
      expect(b.state._indexPartMaterials).toBeNull();
      expect(warns).toHaveLength(1);
      expect(warns[0]).toMatch(/^\[FastShaders\] materialParts skipped: the shader was made for a model with/);
    }
  });

  it('the mismatch warning names both lists', async () => {
    const { warns } = await run({
      parts: {},
      materialParts: { 0: { colorNode: node() } },
      modelSignature: { materials: ['Body', 'Glass'] },
    });
    expect(warns).toEqual([
      '[FastShaders] materialParts skipped: the shader was made for a model with 2 materials ("Body", "Glass"), this model has 3 ("Body", "Glass", "Trim"). Its material numbers are ignored; name parts and the default material still apply.',
    ]);
  });

  it('no-signature and invalid signatures', async () => {
    const noSig = await run({ parts: {}, materialParts: { 0: { colorNode: node() } } });
    expect(noSig.b.materialParts).toEqual({ status: 'no-signature', applied: 0, dropped: 0, expected: null, found: 3 });
    expect(noSig.warns).toEqual([
      '[FastShaders] materialParts skipped: the module has no modelSignature, so it cannot tell which model its material numbers belong to.',
    ]);
    for (const modelSignature of [
      { materials: 'Body' },
      { materials: [1, 2, 3] },
      { materials: ['Body', 'Glass', 'x'.repeat(SIGNATURE_NAME_MAX + 1)] },
      { materials: new Array(SIGNATURE_MATERIALS_MAX + 1).fill('a') },
      'Body,Glass,Trim',
    ]) {
      const { b, warns, scene, authored } = await run({
        parts: {},
        materialParts: { 0: { colorNode: node() } },
        modelSignature,
      });
      expect(b.materialParts.status).toBe('invalid');
      expect(warns).toEqual(['[FastShaders] materialParts skipped: modelSignature is malformed.']);
      expect(byName(scene, 'Hull').material).toBe(authored.get('Hull'));
    }
  });

  it('no-record: a model the plugin never saw; one warning per apply', () => {
    const { FS, warns } = fresh();
    const g = new THREE.Group();
    const loose = new THREE.Mesh(new THREE.BufferGeometry());
    g.add(loose);
    const result = { parts: {}, materialParts: { 0: { colorNode: node() } }, modelSignature: SIG };
    const b1 = FS.apply(g, () => result);
    FS.apply(g, () => result);
    expect(b1.materialParts).toEqual({ status: 'no-record', applied: 0, dropped: 0, expected: 3, found: null });
    expect(warns).toHaveLength(2);
    expect(warns[0]).toMatch(/loaded without the FastShaders glTF plugin/);
  });

  it('not-gltf (a primitive) is silent', () => {
    const { FS, warns } = fresh();
    const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    const b = FS.apply(box, () => ({ parts: {}, materialParts: { 0: { colorNode: node() } } }));
    expect(b.materialParts.status).toBe('not-gltf');
    expect(warns).toEqual([]);
  });

  it('a module without materialParts reports nothing', async () => {
    const { b, warns } = await run({ colorNode: node() });
    expect(b.materialParts).toBeNull();
    expect(warns).toEqual([]);
  });
});

describe.skipIf(!loaderAvailable(V))('materialParts — key hygiene and the cap', () => {
  it('only canonical in-range indices with a channel are applied', async () => {
    const { FS } = fresh();
    const { scene } = await parsed(FS);
    const ch = { colorNode: 1 };
    const table: Record<string, unknown> = {
      '01': ch, '-1': ch, '1.0': ch, ' 1': ch, constructor: ch, toString: ch,
      '10000': ch, '3': ch, // 3 ≥ the model's 3 materials
      '2': { transparent: true }, // settings only: no channel
      '1': ch,
    };
    Object.defineProperty(table, '__proto__', { value: ch, enumerable: true });
    const res = FS.internals.resolveMaterialParts({ materialParts: table, modelSignature: SIG }, scene, true);
    expect(res.status).toBe('applied');
    expect(res.entries.map((e: [number, unknown]) => e[0])).toEqual([1]);
    expect(res.detail).toEqual({ status: 'applied', applied: 1, dropped: 0, expected: 3, found: 3 });
  });

  it('300 valid entries: 256 built, 44 dropped with one warning', async () => {
    const { FS, warns } = fresh();
    const names = Array.from({ length: 300 }, (_, i) => `m${i}`);
    const { scene } = await parsed(FS, {
      materials: materials(names),
      meshes: [{ name: 'm', primitives: [{ material: 299 }] }],
      nodes: [{ name: 'Last', mesh: 0 }],
    });
    const table: Record<string, unknown> = {};
    for (let i = 0; i < 300; i++) table[i] = { colorNode: node() };
    const b = FS.apply(scene, () => ({ parts: {}, materialParts: table, modelSignature: { materials: names } }));
    expect(b.materialParts).toEqual({ status: 'applied', applied: 256, dropped: 44, expected: 300, found: 300 });
    expect(b.state._indexPartMaterials.size).toBe(256);
    // Integer keys enumerate ascending: 0…255 are kept, so 299 is dropped.
    const last = byName(scene, 'Last');
    expect(last.material.isNodeMaterial).toBeFalsy();
    expect(warns).toEqual(['[FastShaders] materialParts: 44 entries over the limit of 256 were ignored.']);
  });
});

describe.skipIf(!loaderAvailable(V))('materialParts — mirror keys', () => {
  it('are never name claims, whether the table applies or not', async () => {
    for (const modelSignature of [SIG, { materials: ['Something', 'Else'] }]) {
      const { FS, warns } = fresh();
      const { scene } = await parsed(FS);
      const [dflt, mirror, part, i0] = [node(), node(), node(), node()];
      const b = FS.apply(scene, () => ({
        colorNode: dflt,
        parts: { Hull: { colorNode: mirror }, Named: { colorNode: part } },
        materialPartsMirror: ['Hull', 'Ghost'], // Ghost is not a parts key: harmless
        materialParts: { 0: { colorNode: i0 } },
        modelSignature,
      }));
      const applied = b.materialParts.status === 'applied';
      expect(byName(scene, 'Hull').material.colorNode).toBe(applied ? i0 : dflt);
      expect(byName(scene, 'Hull2').material.colorNode).toBe(applied ? i0 : dflt);
      expect(byName(scene, 'Named').material.colorNode).toBe(part);
      expect([...b.parts.keys()]).toEqual(['Named']);
      expect(warns.length).toBe(applied ? 0 : 1);
    }
  });

  it('a malformed list is ignored with a warning (its keys stay name claims)', async () => {
    const { FS, warns } = fresh();
    const { scene } = await parsed(FS);
    const [mirror, i0] = [node(), node()];
    FS.apply(scene, () => ({
      parts: { Hull: { colorNode: mirror } },
      materialPartsMirror: 'Hull',
      materialParts: { 0: { colorNode: i0 } },
      modelSignature: SIG,
    }));
    expect(byName(scene, 'Hull').material.colorNode).toBe(mirror);
    expect(byName(scene, 'Hull2').material.colorNode).toBe(i0);
    expect(warns).toEqual(['[FastShaders] materialPartsMirror is not an array of part names; it was ignored.']);
  });
});

describe.skipIf(!loaderAvailable(V))('materialParts — the single-mesh fallback covers NAME parts only', () => {
  it('still picks the first name part on a parts-only module', async () => {
    const { FS } = fresh();
    const { scene } = await parsed(FS, SOLO);
    const p = node();
    FS.apply(scene, () => ({ parts: { Body: { colorNode: p } } }));
    expect(byName(scene, 'Solo').material.colorNode).toBe(p);
  });

  it('never fires for an index-claimed mesh', async () => {
    const { FS } = fresh();
    const { scene } = await parsed(FS, SOLO);
    const [p, i0] = [node(), node()];
    FS.apply(scene, () => ({ parts: { Body: { colorNode: p } }, materialParts: { 0: { colorNode: i0 } }, modelSignature: SOLO_SIG }));
    expect(byName(scene, 'Solo').material.colorNode).toBe(i0);
  });

  it('never picks a mirror key, and index parts alone never trigger it', async () => {
    const { FS } = fresh();
    const { scene, authored } = await parsed(FS, SOLO);
    // A mirror on a mismatched model: the only `parts` key is a mirror.
    FS.apply(scene, () => ({
      parts: { SoloMirror: { colorNode: node() } },
      materialPartsMirror: ['SoloMirror'],
      materialParts: { 0: { colorNode: node() } },
      modelSignature: { materials: ['X'] },
    }));
    expect(byName(scene, 'Solo').material).toBe(authored.get('Solo'));
    // An applied table whose only entry claims another material.
    const b = FS.apply(scene, () => ({ parts: {}, materialParts: { 1: { colorNode: node() } }, modelSignature: SOLO_SIG }));
    expect(b.materialParts.applied).toBe(1);
    expect(byName(scene, 'Solo').material).toBe(authored.get('Solo'));
  });
});

describe.skipIf(!loaderAvailable(V))('materialParts — the A-Frame component', () => {
  function component(FS: FastShadersApi, def: unknown, mesh: THREE.Object3D, components: Record<string, unknown>, result: unknown) {
    const emitted: Array<[string, unknown]> = [];
    const ctx = Object.create(def as object) as Any;
    ctx.el = {
      emit: (name: string, detail: unknown) => emitted.push([name, detail]),
      addEventListener() {},
      removeEventListener() {},
      components,
      getObject3D: (k: string) => (k === 'mesh' ? mesh : null),
      getDOMAttribute: () => null,
      sceneEl: {},
      isConnected: true,
    };
    ctx.data = { src: 'x.js' };
    ctx.extendSchema = () => {};
    ctx.init();
    FS.fetch = () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('export default () => ({});\n') });
    FS.importSource = () => Promise.resolve({ default: () => result });
    return { ctx, emitted };
  }

  it('emits shader-material-parts BEFORE shader-applied, for a glTF entity', async () => {
    const { FS, def, warns } = fresh();
    const { scene } = await parsed(FS);
    const i0 = node();
    const { ctx, emitted } = component(FS, def, scene, { 'gltf-model': { loader: new GLTFLoader() } }, {
      parts: {},
      materialParts: { 0: { colorNode: i0 } },
      modelSignature: SIG,
    });
    ctx.storeOriginalMaterials(scene);
    await ctx.applyTSLShader(scene);
    const detail = { status: 'applied', applied: 1, dropped: 0, expected: 3, found: 3 };
    expect(emitted).toEqual([
      ['shader-material-parts', detail],
      ['shader-applied', { src: 'x.js' }],
    ]);
    expect(emitted[0][1]).not.toBe(ctx._materialPartsStatus); // a copy: a listener cannot edit the state
    expect(byName(scene, 'Hull').material.colorNode).toBe(i0);
    expect(ctx._indexPartMaterials.size).toBe(1);
    expect(warns).toEqual([]);

    ctx.remove();
    expect(ctx._materialPartsStatus).toBeNull();
    expect(ctx._indexPartMaterials).toBeNull();
  });

  it('a primitive entity reports not-gltf, quietly; a module without the key reports nothing', async () => {
    const { FS, def, warns } = fresh();
    const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    const withKey = component(FS, def, box, { geometry: {} }, { parts: {}, materialParts: { 0: { colorNode: node() } } });
    withKey.ctx.storeOriginalMaterials(box);
    await withKey.ctx.applyTSLShader(box);
    expect(withKey.emitted.map((e) => e[0])).toEqual(['shader-material-parts', 'shader-applied']);
    expect((withKey.emitted[0][1] as { status: string }).status).toBe('not-gltf');

    const without = component(FS, def, box, { geometry: {} }, { colorNode: node() });
    without.ctx.storeOriginalMaterials(box);
    await without.ctx.applyTSLShader(box);
    expect(without.emitted.map((e) => e[0])).toEqual(['shader-applied']);
    expect(warns).toEqual([]);
  });
});

describe.skipIf(!loaderAvailable(V))('materialParts — classification', () => {
  it('a materialParts-only result is the object API: no default, no part, never the Simple API', () => {
    const { FS } = fresh();
    const built = FS.internals.buildMaterials({ materialParts: { 0: { colorNode: node() } } });
    expect(built.material).toBeNull();
    expect(built.partMaterials).toBeNull();
    expect(built.hasMaterialParts).toBe(true);
  });

  it('the interim WARN_MATERIAL_PARTS is gone', () => {
    expect(loaderText(V)).not.toContain('WARN_MATERIAL_PARTS');
  });
});

/**
 * The export guard's 0.6 half, against the FROZEN 0.6 text. 0.6's object-API
 * test has no materialParts clause, so a materialParts-only module takes the
 * Simple-API branch (the whole result object becomes every mesh's colorNode:
 * near-black, no error), and a truthy `parts` — `{}` at minimum — is what
 * keeps it on the object path, where an empty parts map dispatches nothing.
 */
describe.skipIf(!loaderAvailable('0.6'))('frozen 0.6 — why a materialParts module must carry parts (R1)', () => {
  const NODE_PROPS = [
    'colorNode', 'positionNode', 'normalNode', 'opacityNode',
    'roughnessNode', 'metalnessNode', 'emissiveNode', 'envNode',
  ];

  it('0.6 classifies materialParts-only as the Simple API, and { parts: {} } as the object API', () => {
    const text = loaderText('0.6');
    const start = text.indexOf('const hasChannels = function');
    const decl = text.indexOf('const isObjectAPI = ', start);
    expect(start).toBeGreaterThan(-1);
    expect(decl).toBeGreaterThan(start);
    const block = text.slice(start, text.indexOf(';', decl) + 1);
    const isObjectAPI = new Function('nodeProps', 'shaderResult', `${block}\nreturn isObjectAPI;`) as (
      p: string[],
      r: unknown,
    ) => unknown;
    const table = { 0: { colorNode: 1 } };
    expect(!!isObjectAPI(NODE_PROPS, { materialParts: table })).toBe(false);
    expect(!!isObjectAPI(NODE_PROPS, { parts: {}, materialParts: table })).toBe(true);
  });

  it('…and with no default and no part, 0.6 leaves every mesh authored', () => {
    const { def } = evalLoader('0.6', {});
    const ctx = Object.create(def as object) as Any;
    const meshes = ['a', 'b'].map((n) => ({ isMesh: true, name: n, uuid: n, material: { tag: n } }));
    const root = { isMesh: false, traverse: (fn: (o: unknown) => void) => { fn(root); meshes.forEach(fn); } };
    ctx.originalMaterials = {};
    ctx._appliedMaterials = null;
    ctx.applyMaterialToMesh(root, null, null);
    expect(meshes.map((m) => m.material.tag)).toEqual(['a', 'b']);
  });
});

describe('the materialParts contract (src/engine/materialPartsContract.ts)', () => {
  it('checkLegacyGuard flags every shape that breaks on 0.6 or confuses 0.8', () => {
    const ok = { hasMaterialParts: true, hasParts: true, hasSignature: true, partKeys: ['Body'], mirrorKeys: ['Body'] };
    expect(checkLegacyGuard(ok)).toEqual([]);
    expect(checkLegacyGuard({ ...ok, hasMaterialParts: false, hasSignature: false, mirrorKeys: [] })).toEqual([]);
    expect(checkLegacyGuard({ ...ok, hasParts: false, partKeys: [], mirrorKeys: [] })).toHaveLength(1);
    expect(checkLegacyGuard({ ...ok, hasSignature: false })).toHaveLength(1);
    expect(checkLegacyGuard({ ...ok, mirrorKeys: ['Ghost'] })).toEqual([
      'mirror key is not a parts key (R4): "Ghost"',
    ]);
    expect(checkLegacyGuard({ ...ok, mirrorKeys: ['Body', 'Body'] })).toEqual(['mirror key listed twice: "Body"']);
  });

  it.skipIf(!loaderAvailable(V))('the loader restates the same bounds and key rule', () => {
    const text = loaderText(V);
    const num = (name: string) => Number(new RegExp(`var ${name} = (\\d+);`).exec(text)?.[1]);
    expect(num('MATERIAL_PARTS_MAX')).toBe(LOADER_MATERIAL_PARTS_MAX);
    expect(num('SIGNATURE_MATERIALS_MAX')).toBe(SIGNATURE_MATERIALS_MAX);
    expect(num('SIGNATURE_NAME_MAX')).toBe(SIGNATURE_NAME_MAX);
    const re = /var MATERIAL_PART_KEY_RE = \/(.+)\/;/.exec(text)?.[1];
    expect(re).toBe(MATERIAL_PART_KEY_RE.source);
  });
});
