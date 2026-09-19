/**
 * The mesh-name PREDICTION (`gltfNaming.ts`), read through the reader so every
 * fixture is a real GLB. Two halves:
 *
 *   (A) the expected names of each fixture, stated by hand;
 *   (B) PARITY: the same bytes parsed by the REAL r184 GLTFLoader must produce
 *       the same multiset of Mesh names, and every name the prediction calls
 *       CERTAIN must sit on a Mesh of the same glTF material. A textured
 *       variant of every fixture runs too, because texture decoding is what
 *       reorders the loader's asynchronous mesh naming.
 *
 * The loader needs `self`, `createImageBitmap` and `ProgressEvent` in node;
 * they are stubbed in (B)'s beforeEach and restored with vi.unstubAllGlobals()
 * (`isolate: false` shares a worker's globals between files). Fixtures are
 * built with JSON.stringify only — the no-JSON.parse-without-reviver rule
 * covers test files too.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { PropertyBinding, type Object3D } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { predictSceneMeshes, sanitizeGltfNodeName, type GltfSceneGraph } from './gltfNaming';
import { readGltfModel } from './gltfReader';
import { TRIANGLE_POSITIONS, makeGlb, makeRealPng } from '../test-utils';

const NBSP = String.fromCharCode(0xa0);
const IDEOGRAPHIC_SPACE = String.fromCharCode(0x3000);
const PNG = makeRealPng(2, 2, [200, 40, 40, 255]);
const pad4 = (n: number) => (n + 3) & ~3;

interface Prim {
  material?: number;
  mode?: number;
}

interface Fixture {
  name: string;
  meshes: { name?: string; prims: Prim[] }[];
  nodes: Record<string, unknown>[];
  scenes?: Record<string, unknown>[];
  materials?: (string | undefined)[];
  cameras?: Record<string, unknown>[];
  lights?: Record<string, unknown>[];
  skins?: { joints: number[] }[];
  animationTargets?: number[];
  /** Materials that carry a texture in EVERY variant (the decode-order case). */
  texturedMaterials?: number[];
  expected: string[];
  uncertain?: string[];
  /** Expected material index per prediction, when the fixture pins it. */
  materialsOf?: (number | null)[];
}

const FIXTURES: Fixture[] = [
  {
    name: 'blender single primitive: the node name overrides',
    meshes: [{ name: 'Cube', prims: [{ material: 0 }] }],
    nodes: [{ name: 'Cube', mesh: 0 }],
    materials: ['Material'],
    expected: ['Cube'],
  },
  {
    name: 'multi-primitive mesh on a named node: the Group takes the name',
    meshes: [{ name: 'Cube', prims: [{ material: 0 }, { material: 1 }] }],
    nodes: [{ name: 'Cube', mesh: 0 }],
    materials: ['A', 'B'],
    expected: ['Cube_1', 'Cube_2'],
    materialsOf: [0, 1],
  },
  {
    name: 'multi-primitive mesh on an unnamed node',
    meshes: [{ name: 'Cube', prims: [{ material: 0 }, { material: 1 }] }],
    nodes: [{ mesh: 0 }],
    materials: ['A', 'B'],
    expected: ['Cube', 'Cube_1'],
  },
  {
    name: 'unnamed meshes',
    meshes: [{ prims: [{ material: 0 }] }, { prims: [{ material: 0 }] }],
    nodes: [{ mesh: 0 }, { mesh: 1 }],
    materials: ['M'],
    expected: ['mesh_0', 'mesh_1'],
  },
  {
    name: 'instanced mesh: _instance_<k> on every reference, a named node overrides',
    meshes: [{ name: 'Solo', prims: [{ material: 0 }] }],
    nodes: [{ name: 'Solo' }, { mesh: 0 }, { mesh: 0 }, { name: 'Named', mesh: 0 }],
    materials: ['M'],
    expected: ['Solo_1_instance_0', 'Solo_1_instance_1', 'Named'],
  },
  {
    name: 'Body.001 and Body001 share a sanitized base',
    meshes: [
      { name: 'Body.001', prims: [{ material: 0 }] },
      { name: 'Body001', prims: [{ material: 1 }] },
    ],
    nodes: [{ mesh: 0 }, { mesh: 1 }],
    materials: ['A', 'B'],
    expected: ['Body001', 'Body001_1'],
    uncertain: ['Body001', 'Body001_1'],
  },
  {
    name: 'a scene name is reserved before its meshes',
    meshes: [{ name: 'S', prims: [{ material: 0 }] }],
    nodes: [{ mesh: 0 }],
    scenes: [{ name: 'S', nodes: [0] }],
    materials: ['M'],
    expected: ['S_1'],
  },
  {
    name: 'a POINTS primitive consumes a name but is not listed',
    meshes: [{ name: 'Pm', prims: [{ mode: 0, material: 0 }, { material: 1 }] }],
    nodes: [{ mesh: 0 }],
    materials: ['P', 'T'],
    expected: ['Pm_1'],
    materialsOf: [1],
  },
  {
    name: 'an animation target outside the scene reserves its name',
    meshes: [{ name: 'Q', prims: [{ material: 0 }] }],
    nodes: [{ mesh: 0 }, { name: 'Q' }],
    scenes: [{ nodes: [0] }],
    animationTargets: [1],
    materials: ['M'],
    expected: ['Q_1'],
  },
  {
    name: 'Object.prototype names come out _NaN',
    meshes: [
      { name: 'constructor', prims: [{ material: 0 }] },
      { name: 'toString', prims: [{ material: 0 }] },
      { name: '__proto__', prims: [{ material: 0 }] },
    ],
    nodes: [{ mesh: 0 }, { mesh: 1 }, { mesh: 2 }],
    materials: ['M'],
    expected: ['constructor_NaN', 'toString_NaN', '__proto___NaN'],
  },
  {
    name: 'every JS whitespace becomes _',
    meshes: [{ name: 'a' + NBSP + 'b' + IDEOGRAPHIC_SPACE + 'c d', prims: [{ material: 0 }] }],
    nodes: [{ mesh: 0 }],
    materials: ['M'],
    expected: ['a_b_c_d'],
  },
  {
    name: 'a bone carrying a mesh: the mesh keeps its own name',
    meshes: [{ name: 'BoneMesh', prims: [{ material: 0 }] }],
    nodes: [{ name: 'Root', skin: 0, children: [1] }, { name: 'Bone1', mesh: 0 }],
    skins: [{ joints: [1] }],
    materials: ['M'],
    expected: ['BoneMesh'],
  },
  {
    name: 'a node with a mesh and a camera: the mesh keeps its name',
    meshes: [{ name: 'M', prims: [{ material: 0 }] }],
    nodes: [{ name: 'Rig', mesh: 0, camera: 0 }],
    cameras: [{ type: 'perspective', name: 'Cam', perspective: { yfov: 0.8, znear: 0.1 } }],
    materials: ['M'],
    expected: ['M'],
  },
  {
    name: 'a camera without parameters reserves no name',
    meshes: [{ name: 'Cam', prims: [{ material: 0 }] }],
    nodes: [{ mesh: 0 }],
    cameras: [{ type: 'perspective', name: 'Cam' }],
    materials: ['M'],
    expected: ['Cam'],
  },
  {
    name: 'an unnamed light reserves light_<index>',
    meshes: [{ name: 'light_0', prims: [{ material: 0 }] }],
    nodes: [{ extensions: { KHR_lights_punctual: { light: 0 } } }, { mesh: 0 }],
    lights: [{ type: 'point' }],
    materials: ['M'],
    expected: ['light_0_1'],
  },
  {
    name: 'two mesh defs sharing a base are uncertain, an unrelated one is not',
    meshes: [
      { name: 'X', prims: [{ material: 0 }] },
      { name: 'X', prims: [{ material: 1 }] },
      { name: 'Y', prims: [{ material: 0 }] },
    ],
    nodes: [{ mesh: 0 }, { mesh: 1 }, { mesh: 2 }],
    materials: ['A', 'B'],
    expected: ['X', 'X_1', 'Y'],
    uncertain: ['X', 'X_1'],
  },
  {
    name: 'texturedFirst: a textured mesh referenced first',
    meshes: [
      { name: 'X', prims: [{ material: 0 }] },
      { name: 'X', prims: [{ material: 1 }] },
    ],
    nodes: [{ mesh: 0 }, { mesh: 1 }],
    materials: ['Tex', 'Plain'],
    texturedMaterials: [0],
    expected: ['X', 'X_1'],
    uncertain: ['X', 'X_1'],
  },
];

/** Every node that is nobody's child, in index order. */
function rootsOf(nodes: Record<string, unknown>[]): number[] {
  const child = new Set<number>();
  for (const n of nodes) for (const c of (n.children as number[] | undefined) ?? []) child.add(c);
  return nodes.map((_, i) => i).filter((i) => !child.has(i));
}

interface Built {
  bytes: Uint8Array<ArrayBuffer>;
  meshes: { primitives: { material?: number }[] }[];
}

function build(fx: Fixture, texturedVariant: boolean): Built {
  const materials: Record<string, unknown>[] = (fx.materials ?? []).map((n) => (n === undefined ? {} : { name: n }));
  const meshes = fx.meshes.map((m) => ({
    ...(m.name !== undefined ? { name: m.name } : {}),
    primitives: m.prims.map((p) => ({
      attributes: { POSITION: 0 },
      ...(p.material !== undefined ? { material: p.material } : {}),
      ...(p.mode !== undefined ? { mode: p.mode } : {}),
    })) as { attributes: object; material?: number; mode?: number }[],
  }));
  let textured = new Set(fx.texturedMaterials ?? []);
  if (texturedVariant) {
    if (materials.length === 0) {
      materials.push({ name: 'T' });
      for (const m of meshes) for (const p of m.primitives) if (p.material === undefined) p.material = 0;
    }
    textured = new Set(materials.map((_, i) => i));
  }
  for (const i of textured) materials[i].pbrMetallicRoughness = { baseColorTexture: { index: 0 } };

  const withTexture = textured.size > 0;
  const bin = new Uint8Array(36 + (withTexture ? pad4(PNG.length) : 0));
  bin.set(TRIANGLE_POSITIONS, 0);
  const bufferViews: Record<string, number>[] = [{ buffer: 0, byteOffset: 0, byteLength: 36 }];
  if (withTexture) {
    bin.set(PNG, 36);
    bufferViews.push({ buffer: 0, byteOffset: 36, byteLength: PNG.length });
  }
  const accessors: Record<string, unknown>[] = [
    { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
  ];
  const doc: Record<string, unknown> = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: bin.length }],
    bufferViews,
    accessors,
    meshes,
    nodes: fx.nodes,
    scenes: fx.scenes ?? [{ nodes: rootsOf(fx.nodes) }],
    scene: 0,
  };
  if (materials.length > 0) doc.materials = materials;
  if (withTexture) {
    doc.images = [{ bufferView: 1, mimeType: 'image/png' }];
    doc.textures = [{ source: 0 }];
  }
  if (fx.cameras) doc.cameras = fx.cameras;
  if (fx.skins) doc.skins = fx.skins;
  if (fx.lights) {
    doc.extensions = { KHR_lights_punctual: { lights: fx.lights } };
    doc.extensionsUsed = ['KHR_lights_punctual'];
  }
  if (fx.animationTargets) {
    accessors.push(
      { bufferView: 0, componentType: 5126, count: 1, type: 'SCALAR', min: [0], max: [0] },
      { bufferView: 0, componentType: 5126, count: 1, type: 'VEC3' },
    );
    doc.animations = [{
      samplers: [{ input: 1, output: 2 }],
      channels: fx.animationTargets.map((node) => ({ sampler: 0, target: { node, path: 'translation' } })),
    }];
  }
  return { bytes: makeGlb(doc, bin), meshes };
}

function predict(bytes: Uint8Array) {
  const r = readGltfModel(bytes, 'glb');
  if (!r.ok) throw new Error('reader refused: ' + JSON.stringify(r.refusal));
  return r.model;
}

/* ── (A) pure expectations ───────────────────────────────────────────────── */

describe('predicted mesh names (through the reader)', () => {
  for (const fx of FIXTURES) {
    it(fx.name, () => {
      const m = predict(build(fx, false).bytes);
      expect(m.sceneMeshes.map((s) => s.name)).toEqual(fx.expected);
      expect(m.sceneMeshes.filter((s) => !s.certain).map((s) => s.name)).toEqual(fx.uncertain ?? []);
      expect(m.namingExact).toBe((fx.uncertain ?? []).length === 0);
      if (fx.materialsOf) expect(m.sceneMeshes.map((s) => s.material)).toEqual(fx.materialsOf);
    });
  }

  it('an unrelated mesh stays certain beside an uncertain group', () => {
    const fx = FIXTURES.find((f) => f.name.startsWith('two mesh defs'))!;
    const m = predict(build(fx, false).bytes);
    expect(m.meshNameIndex.get('Y')).toEqual({ materials: [0], certain: true });
    expect(m.meshNameIndex.get('X')?.certain).toBe(false);
  });
});

describe('predictSceneMeshes on a hand-built graph', () => {
  const graph = (meshNames: string[]): GltfSceneGraph => ({
    nodes: meshNames.map((_, i) => ({ name: '', children: [], mesh: i, camera: null, skin: null, light: null })),
    meshes: meshNames.map((name) => ({ name, primitives: [{ material: 0, mode: 4, tangents: false, vertexColors: false }] })),
    scenes: [{ name: '', nodes: meshNames.map((_, i) => i) }],
    defaultScene: 0,
    skins: [],
    animationTargets: [],
    cameras: [],
    lights: [],
  });

  it('reproduces the loader counter for inherited names without writing a prototype', () => {
    const before = Object.getOwnPropertyNames(Object.prototype).sort();
    const { meshes, exact } = predictSceneMeshes(graph(['__proto__', '__proto__', 'hasOwnProperty', 'valueOf']));
    expect(meshes.map((m) => m.name)).toEqual(['__proto___NaN', '__proto___NaN', 'hasOwnProperty_NaN', 'valueOf_NaN']);
    // Two defs share the base '__proto__', so those two are uncertain.
    expect(exact).toBe(false);
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(before);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('sanitizeGltfNodeName is PropertyBinding.sanitizeNodeName', () => {
    for (const s of ['Body.001', 'a b\tc', 'a[b]:c/d.e', NBSP + 'x' + IDEOGRAPHIC_SPACE, '', '__proto__', 'ok_name-1']) {
      expect(sanitizeGltfNodeName(s)).toBe(PropertyBinding.sanitizeNodeName(s));
    }
  });

  it('survives an out-of-range reference instead of throwing (the reader refuses those first)', () => {
    const g = graph(['A']);
    g.nodes[0].mesh = 5;
    g.nodes[0].children = [9];
    expect(() => predictSceneMeshes(g)).not.toThrow();
    expect(predictSceneMeshes(g).meshes).toEqual([]);
  });
});

/* ── (B) parity against the real GLTFLoader ──────────────────────────────── */

class ProgressEventStub {
  constructor(
    readonly type: string,
    init?: object,
  ) {
    Object.assign(this, init ?? {});
  }
}

interface RealMesh {
  name: string;
  mesh: number | null;
  material: number | null;
}

async function realMeshes(built: Built): Promise<RealMesh[]> {
  const gltf = await new GLTFLoader().parseAsync(built.bytes.buffer, '');
  const out: RealMesh[] = [];
  gltf.scene.traverse((o: Object3D) => {
    if (!(o as { isMesh?: boolean }).isMesh) return;
    const a = gltf.parser.associations.get(o) as { meshes?: number; primitives?: number } | undefined;
    const prim = a && a.meshes !== undefined && a.primitives !== undefined
      ? built.meshes[a.meshes].primitives[a.primitives]
      : undefined;
    out.push({
      name: o.name,
      mesh: a?.meshes ?? null,
      material: prim && typeof prim.material === 'number' ? prim.material : null,
    });
  });
  return out;
}

describe('PARITY with the real r184 GLTFLoader', () => {
  let warn: MockInstance;
  let error: MockInstance;
  beforeEach(() => {
    vi.stubGlobal('self', globalThis);
    vi.stubGlobal('ProgressEvent', ProgressEventStub);
    // Resolve on a macrotask, so a textured material really resolves LATER
    // than an untextured one, as a browser decode does.
    vi.stubGlobal('createImageBitmap', () => new Promise((resolve) => {
      setTimeout(() => resolve({ width: 2, height: 2, close() {} }), 0);
    }));
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    error = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    error.mockRestore();
    vi.unstubAllGlobals();
  });

  for (const fx of FIXTURES) {
    for (const textured of [false, true]) {
      it(`${fx.name}${textured ? ' (textured)' : ''}`, async () => {
        const built = build(fx, textured);
        const predicted = predict(built.bytes).sceneMeshes;
        const real = await realMeshes(built);
        expect(real.map((r) => r.name).sort()).toEqual(predicted.map((p) => p.name).sort());
        // Every CERTAIN prediction sits on a real Mesh of that name and material.
        const pool = real.map((r) => `${r.name}\u0000${r.material}`);
        for (const p of predicted.filter((q) => q.certain)) {
          const at = pool.indexOf(`${p.name}\u0000${p.material}`);
          expect(at, `${p.name} / material ${p.material}`).toBeGreaterThanOrEqual(0);
          pool.splice(at, 1);
        }
      });
    }
  }

  it('texturedFirst is the negative control: the real names are NOT reference order', async () => {
    const fx = FIXTURES.find((f) => f.name.startsWith('texturedFirst'))!;
    const built = build(fx, false);
    const predicted = predict(built.bytes).sceneMeshes;
    const real = await realMeshes(built);
    // Reference order gives mesh 0 'X'; the loader names the untextured mesh 1
    // first, so mesh 0 comes out 'X_1'. If the loader ever becomes
    // deterministic in reference order this fails, and the uncertainty flag
    // can be relaxed.
    expect(predicted.find((p) => p.mesh === 0)?.name).toBe('X');
    expect(real.find((r) => r.mesh === 0)?.name).toBe('X_1');
    expect(predicted.every((p) => !p.certain)).toBe(true);
  });

  it('a node on a camera without parameters: the loader throws, the reader refuses', async () => {
    const fx: Fixture = {
      name: 'paramless camera on a node',
      meshes: [{ name: 'M', prims: [{ material: 0 }] }],
      nodes: [{ mesh: 0 }, { camera: 0 }],
      cameras: [{ type: 'perspective', name: 'Cam' }],
      materials: ['M'],
      expected: [],
    };
    const built = build(fx, false);
    await expect(new GLTFLoader().parseAsync(built.bytes.buffer, '')).rejects.toBeTruthy();
    const r = readGltfModel(built.bytes, 'glb');
    expect(r.ok ? null : r.refusal).toEqual({ reason: 'invalid-model', detail: 'camera:0' });
  });

  it('a light of an unknown type: the loader throws, the reader refuses', async () => {
    const fx: Fixture = {
      name: 'area light',
      meshes: [{ name: 'M', prims: [{ material: 0 }] }],
      nodes: [{ mesh: 0 }, { extensions: { KHR_lights_punctual: { light: 0 } } }],
      lights: [{ type: 'area' }],
      materials: ['M'],
      expected: [],
    };
    const built = build(fx, false);
    await expect(new GLTFLoader().parseAsync(built.bytes.buffer, '')).rejects.toBeTruthy();
    const r = readGltfModel(built.bytes, 'glb');
    expect(r.ok ? null : r.refusal).toEqual({ reason: 'invalid-model', detail: 'light:0' });
  });
});
