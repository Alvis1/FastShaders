/**
 * "Match the model" (owner, 2026-10-09): a picture added from a FILE while the
 * 3D pane SHOWS a glTF/GLB model drawn on its OWN UVs — TEXCOORD_0 on every
 * drawn primitive, which glTF stores v-DOWN — is stored the glTF way,
 * `orientation: 'gltf'` (`Texture.flipY = false`), so it reads upright there
 * and the single-GLB export may put it in the model's material slot. ONE
 * predicate decides (utils/pictureOrientation.ts), over the trusted reader's
 * `uv0` fact (utils/gltfReader.ts, from the read `createPreviewMesh` already
 * makes); every path that brings a file's picture into an Image node asks it
 * when the picture is written, and where it says no, the values are
 * byte-identical to what that path always wrote.
 *
 * What RUNS here: the reader's fact over real model bytes; the predicate over
 * every mesh kind, malformed facts and mutated bytes; the construction path
 * and the payload swap; the store's "Add anyway" for real; codegen, the export
 * plan and the texture planner over the nodes those paths build; and — in the
 * preview document's own code (FIT_BOUNDS_SCRIPT, after the REAL GLTFLoader) —
 * which orientation reads upright on each model, which the predicate must
 * choose. The two React paths (the canvas drop, "From file…") are pinned by
 * SOURCE, the house style for a surface with no jsdom, and a sweep fails on a
 * new path that brings a file's picture into an Image node without asking.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { filePictureOrientation, previewShowsGltfUvs, replacementPictureOrientation } from './pictureOrientation';
import { droppedModelPictureOrientation } from './droppedModelOrientation';
import { createPreviewMesh, type PreviewMesh } from './previewMesh';
import { gltfPreviewFacts, readGltfModel } from './gltfReader';
import { makeImageNodeFromEncode } from './imageNode';
import { pickTextureValues, projectTextureSources, withImagePayload } from './textureSources';
import { readImageUvMapping, sanitizeUvMappingKeys } from './imageUvMapping';
import { readImageTextureSpec } from './imageTextureSpec';
import { createImageTexturePlanner } from '@/engine/imageTexturePlan';
import { planGlbExport } from '@/engine/glbExportPlan';
import { graphToCode } from '@/engine/graphToCode';
import { FIT_BOUNDS_SCRIPT } from '@/engine/tslToPreviewHTML';
import { useAppStore, cancelPendingGraphSave } from '@/store/useAppStore';
import { GLTF_NODE_GLOBALS } from '@/gltfTestFixtures';
import { projectDocs } from '@/projectDocs';
import {
  HISTORY_IDLE,
  canonicalSrc,
  makeEdge,
  makeGlb,
  makeNode,
  makeRealPng,
  packBinViews,
  splatRows,
} from '@/test-utils';
import { getNodeValues, type AppEdge, type AppNode } from '@/types';

/* ── model fixtures: a quad and an octahedron, each with or without UVs ──── */

/** Facing +Z (the preview camera's side), x right, y up. */
const QUAD_POS = new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]);
/** glTF's own convention: u right, v DOWN — the top-left corner is (0, 0). */
const QUAD_UV = new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]);
const QUAD_IDX = new Uint16Array([0, 1, 2, 0, 2, 3]);
/** Closed, so the spherical UVs the preview generates for it are not degenerate. */
const OCTA_POS = new Float32Array([1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1]);
/** A planar projection from +Z, v down as glTF stores it: u = x/2 + ½, v = ½ − y/2. */
const OCTA_UV = new Float32Array([1, 0.5, 0, 0.5, 0.5, 0, 0.5, 1, 0.5, 0.5, 0.5, 0.5]);
/** Outward, counter-clockwise: the four +Z faces first. */
const OCTA_IDX = new Uint16Array([0, 2, 4, 2, 1, 4, 1, 3, 4, 3, 0, 4, 2, 0, 5, 1, 2, 5, 3, 1, 5, 0, 3, 5]);

interface PrimSpec {
  shape?: 'quad' | 'octahedron';
  /** The TEXCOORD_n sets the primitive carries. */
  uv?: number[];
  material?: number;
  mode?: number;
}
interface ModelOpts {
  /** One node per entry, naming its mesh; default one node per mesh. */
  nodes?: number[];
  /** Scenes as node lists; default one scene of every node. */
  scenes?: number[][];
  scene?: number;
  materials?: number;
}

const Q0: PrimSpec = { uv: [0] };
const Q: PrimSpec = {};
const O: PrimSpec = { shape: 'octahedron' };
const O0: PrimSpec = { shape: 'octahedron', uv: [0] };

/** The document and BIN of a model whose meshes draw the two shapes above —
 *  packed by the shared GLB fixture set (`packBinViews`, `makeGlb`). */
function uvModelDoc(meshes: PrimSpec[][], o: ModelOpts = {}): { doc: Record<string, unknown>; bin: Uint8Array<ArrayBuffer> } {
  const arrays = [QUAD_POS, QUAD_UV, QUAD_IDX, OCTA_POS, OCTA_UV, OCTA_IDX];
  const { bin, views } = packBinViews(arrays.map((a) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength)));
  const acc = (bufferView: number, count: number, type: string, componentType = 5126, extra: object = {}) => ({
    bufferView,
    componentType,
    count,
    type,
    ...extra,
  });
  const prim = (p: PrimSpec) => {
    const octa = p.shape === 'octahedron';
    const attributes: Record<string, number> = { POSITION: octa ? 3 : 0 };
    for (const n of p.uv ?? []) attributes[`TEXCOORD_${n}`] = octa ? 4 : 1;
    return {
      attributes,
      indices: octa ? 5 : 2,
      ...(p.material !== undefined ? { material: p.material } : {}),
      ...(p.mode !== undefined ? { mode: p.mode } : {}),
    };
  };
  const nodes = (o.nodes ?? meshes.map((_, i) => i)).map((mesh, i) => ({ name: `n${i}`, mesh }));
  const doc: Record<string, unknown> = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: bin.length }],
    bufferViews: views.map((v) => ({ buffer: 0, ...v })),
    accessors: [
      acc(0, 4, 'VEC3', 5126, { min: [-0.5, -0.5, 0], max: [0.5, 0.5, 0] }),
      acc(1, 4, 'VEC2'),
      acc(2, 6, 'SCALAR', 5123),
      acc(3, 6, 'VEC3', 5126, { min: [-1, -1, -1], max: [1, 1, 1] }),
      acc(4, 6, 'VEC2'),
      acc(5, 24, 'SCALAR', 5123),
    ],
    meshes: meshes.map((prims, i) => ({ name: `m${i}`, primitives: prims.map(prim) })),
    nodes,
    scenes: (o.scenes ?? [nodes.map((_, i) => i)]).map((list) => ({ nodes: list })),
    scene: o.scene ?? 0,
  };
  if (o.materials) doc.materials = Array.from({ length: o.materials }, (_, i) => ({ name: `mat${i}` }));
  return { doc, bin };
}

const uvGlb = (meshes: PrimSpec[][], o?: ModelOpts) => {
  const { doc, bin } = uvModelDoc(meshes, o);
  return makeGlb(doc, bin);
};

/** The same model as `.gltf` text, its buffer a `data:` URI — or, with
 *  `external`, a file next to it the trusted reader will not read. */
function uvGltf(meshes: PrimSpec[][], external = false): Uint8Array<ArrayBuffer> {
  const { doc, bin } = uvModelDoc(meshes);
  let s = '';
  for (const b of bin) s += String.fromCharCode(b);
  doc.buffers = [{ byteLength: bin.length, uri: external ? 'model.bin' : 'data:application/octet-stream;base64,' + btoa(s) }];
  return new TextEncoder().encode(JSON.stringify(doc));
}

const OBJ_WITH_VT = 'v 0 0 0\nv 1 0 0\nv 0 1 0\nvt 0 0\nvt 1 0\nvt 0 1\nf 1/1 2/2 3/3\n';
const OBJ_BARE = 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n';

function meshOf(name: string, bytes: Uint8Array): PreviewMesh {
  const r = createPreviewMesh(name, bytes);
  if (!('mesh' in r)) throw new Error(`${name} refused: ${r.error}`);
  return r.mesh;
}

/** The store's two fields, as `useAppStore.getState()` holds them. */
const shown = (previewMesh: unknown, previewShowsModel = true) => ({ previewMesh, previewShowsModel });

const PNG = canonicalSrc('image/png', makeRealPng(2, 2, [200, 40, 10, 255]));
const ENC = { dataUrl: PNG, width: 2, height: 2 };

/** A copy of `o` without `key`. */
const omit = (o: Record<string, unknown>, key: string): Record<string, unknown> => {
  const copy = { ...o };
  delete copy[key];
  return copy;
};

/* ── the reader's fact ──────────────────────────────────────────────────── */

describe("the reader's uv0 fact: the default scene's drawn primitives, from the ONE read", () => {
  const uv0 = (meshes: PrimSpec[][], o?: ModelOpts) => gltfPreviewFacts(uvGlb(meshes, o), 'glb')?.uv0;

  it("'all', 'some' or 'none' of the drawn primitives carry TEXCOORD_0", () => {
    expect(uv0([[Q0]])).toBe('all');
    expect(uv0([[O0]])).toBe('all');
    expect(uv0([[Q0, O0], [Q0]])).toBe('all');
    expect(uv0([[Q]])).toBe('none');
    expect(uv0([[O]])).toBe('none');
    // One mesh with two primitives, or two meshes: one with, one without.
    expect(uv0([[Q0, O]])).toBe('some');
    expect(uv0([[Q0], [O]])).toBe('some');
  });

  it('TEXCOORD_1 alone is not TEXCOORD_0: GLTFLoader makes it `uv1`, never the `uv()` a picture samples', () => {
    expect(uv0([[{ uv: [1] }]])).toBe('none');
    expect(uv0([[{ uv: [0, 1] }]])).toBe('all');
    expect(uv0([[{ uv: [1] }], [Q0]])).toBe('some');
  });

  it('counts a primitive on the DEFAULT material too — the preview samples uv() on every drawn primitive', () => {
    expect(uv0([[Q0], [{ uv: [0], material: 0 }]], { materials: 1 })).toBe('all');
    expect(uv0([[Q], [{ uv: [0], material: 0 }]], { materials: 1 })).toBe('some');
    // ...while the per-material usage keeps leaving the default material out.
    const r = readGltfModel(uvGlb([[Q], [{ uv: [0], material: 0 }]], { materials: 1 }), 'glb');
    expect(r.ok && r.model.materials[0].usage).toMatchObject({ primitives: 1, uvSets: [0] });
  });

  it('instances count, and only the DEFAULT scene is drawn', () => {
    const r = readGltfModel(uvGlb([[Q0], [O]], { nodes: [0, 0, 1] }), 'glb');
    expect(r.ok && [r.model.sceneMeshesWithUv0, r.model.sceneMeshes.length]).toEqual([2, 3]);
    expect(uv0([[Q0], [O]], { scenes: [[0], [1]] })).toBe('all');
    expect(uv0([[Q0], [O]], { scenes: [[0], [1]], scene: 1 })).toBe('none');
  });

  it('only a Mesh draws a picture: a POINTS primitive is not counted, and nothing drawn reads none', () => {
    expect(uv0([[{ mode: 0 }], [Q0]])).toBe('all');
    expect(uv0([[{ mode: 0, uv: [0] }]])).toBe('none');
    expect(uv0([[Q0]], { scenes: [[]] })).toBe('none');
  });

  it('createPreviewMesh keeps it on PreviewMesh.gltf — a string beside the signature, from its single read', () => {
    const mesh = meshOf('quad.glb', uvGlb([[Q0]]));
    expect(mesh.gltf?.uv0).toBe('all');
    expect(typeof mesh.gltf?.uv0).toBe('string');
    expect(meshOf('quad.gltf', uvGltf([[Q0]])).gltf?.uv0).toBe('all');
    // createPreviewMesh still reads the model ONCE (outputIndexSection.pins
    // pins the call); the predicate reads no bytes at all.
    const src = readFileSync(new URL('./pictureOrientation.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/readGltfModel|gltfPreviewFacts\(|parseGlbContainer|JSON\.parse/);
  });
});

/* ── the predicate ──────────────────────────────────────────────────────── */

describe('previewShowsGltfUvs: a glTF model on screen, drawn on its OWN TEXCOORD_0 everywhere', () => {
  it('true for a .glb and a .gltf whose every drawn primitive carries TEXCOORD_0', () => {
    for (const [name, bytes] of [
      ['quad.glb', uvGlb([[Q0]])],
      ['octahedron.glb', uvGlb([[O0]])],
      ['both.glb', uvGlb([[Q0, O0]])],
      ['quad.gltf', uvGltf([[Q0]])],
    ] as const) {
      const state = shown(meshOf(name, bytes));
      expect(previewShowsGltfUvs(state), name).toBe(true);
      expect(filePictureOrientation(state), name).toBe('gltf');
    }
  });

  it('false for a glTF without TEXCOORD_0, with only TEXCOORD_1, or with it on only SOME primitives', () => {
    for (const [name, bytes] of [
      ['plain.glb', uvGlb([[Q]])],
      ['octahedron.glb', uvGlb([[O]])],
      ['uv1.glb', uvGlb([[{ uv: [1] }]])],
      ['mixed.glb', uvGlb([[Q0], [O]])],
      ['plain.gltf', uvGltf([[Q]])],
    ] as const) {
      const state = shown(meshOf(name, bytes));
      expect(previewShowsGltfUvs(state), name).toBe(false);
      expect(filePictureOrientation(state), name).toBeUndefined();
    }
  });

  it('false for every other kind: an OBJ with or without vt (OBJ stores v up), a Gaussian splat', () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    for (const mesh of [meshOf('a.obj', enc(OBJ_WITH_VT)), meshOf('b.obj', enc(OBJ_BARE)), meshOf('c.splat', splatRows(4))]) {
      expect(previewShowsGltfUvs(shown(mesh)), mesh.kind).toBe(false);
    }
  });

  it('false when the strict reader refused the glTF (an external buffer: `gltf` is null)', () => {
    const mesh = meshOf('far.gltf', uvGltf([[Q0]], true));
    expect(mesh.gltf).toBeNull();
    expect(previewShowsGltfUvs(shown(mesh))).toBe(false);
  });

  it('false while the pane shows a built-in shape or the Raymarch window, and with no model loaded', () => {
    const mesh = meshOf('quad.glb', uvGlb([[Q0]]));
    // ShaderPreview writes previewShowsModel = (geometry === 'custom').
    expect(previewShowsGltfUvs(shown(mesh, false))).toBe(false);
    expect(previewShowsGltfUvs(shown(null))).toBe(false);
    expect(previewShowsGltfUvs(shown(undefined))).toBe(false);
  });

  it("an absent previewShowsModel means shown — the store's own value until the preview reports", () => {
    const mesh = meshOf('quad.glb', uvGlb([[Q0]]));
    expect(previewShowsGltfUvs({ previewMesh: mesh })).toBe(true);
    expect(useAppStore.getInitialState().previewShowsModel).toBe(true);
  });

  it('malformed facts answer false, and never throw', () => {
    const hostile: unknown[] = [
      null, undefined, 0, 1, '', 'glb', true, [], [{ kind: 'glb', gltf: { uv0: 'all' } }],
      {}, { kind: 'glb' }, { kind: 'glb', gltf: null }, { kind: 'glb', gltf: 0 }, { kind: 'glb', gltf: 'all' },
      { kind: 'glb', gltf: [] }, { kind: 'glb', gltf: {} }, { kind: 'glb', gltf: { uv0: 'ALL' } },
      { kind: 'glb', gltf: { uv0: 'all ' } }, { kind: 'glb', gltf: { uv0: true } }, { kind: 'glb', gltf: { uv0: 1 } },
      { kind: 'glb', gltf: { uv0: ['all'] } }, { kind: 'glb', gltf: { uv0: { toString: () => 'all' } } },
      { kind: 'glb', gltf: { uv0: 'some' } }, { kind: 'glb', gltf: { uv0: 'none' } },
      { kind: 'GLB', gltf: { uv0: 'all' } }, { kind: ['glb'], gltf: { uv0: 'all' } }, { gltf: { uv0: 'all' } },
      { kind: 'obj', gltf: { uv0: 'all' } }, { kind: 'splat', gltf: { uv0: 'all' } }, { kind: 'ply', gltf: { uv0: 'all' } },
      { kind: 'glb', gltf: Object.create(null) },
    ];
    for (const pm of hostile) {
      for (const showing of [true, false, undefined]) {
        const state = { previewMesh: pm, ...(showing === undefined ? {} : { previewShowsModel: showing }) };
        expect(() => previewShowsGltfUvs(state)).not.toThrow();
        expect(previewShowsGltfUvs(state), JSON.stringify(pm)).toBe(false);
      }
    }
    // The exact shape answers true, on both glTF kinds.
    expect(previewShowsGltfUvs(shown({ kind: 'glb', gltf: { uv0: 'all' } }))).toBe(true);
    expect(previewShowsGltfUvs(shown({ kind: 'gltf', gltf: { uv0: 'all' } }))).toBe(true);
  });

  it('never throws on mutated model bytes, and a true answer always rests on the reader’s own count', () => {
    const base = uvGlb([[Q0], [O0]]);
    let s = 0x9e3779b9;
    const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    let trueAnswers = 0;
    for (let k = 0; k < 300; k++) {
      const bytes = base.slice();
      const flips = 1 + Math.floor(rnd() * 4);
      for (let f = 0; f < flips; f++) bytes[Math.floor(rnd() * bytes.length)] = Math.floor(rnd() * 256);
      const r = createPreviewMesh('fuzz.glb', bytes);
      if (!('mesh' in r)) continue;
      let answer = false;
      expect(() => (answer = previewShowsGltfUvs(shown(r.mesh)))).not.toThrow();
      if (!answer) continue;
      trueAnswers++;
      const read = readGltfModel(r.mesh.bytes, 'glb');
      expect(read.ok && read.model.sceneMeshes.length > 0 && read.model.sceneMeshesWithUv0 === read.model.sceneMeshes.length).toBe(true);
    }
    // Most single-byte hits land in the BIN chunk and leave the model readable.
    expect(trueAnswers).toBeGreaterThan(0);
  });
});

/* ── the construction path and the payload swap ─────────────────────────── */

const SPHERE_STATE = shown(meshOf('quad.glb', uvGlb([[Q0]])), false);
const MODEL_STATE = shown(meshOf('quad.glb', uvGlb([[Q0]])));

describe('makeImageNodeFromEncode (the canvas drop and its "Add anyway"): gltf exactly when asked', () => {
  const ORIGIN = { originId: 'abc12345', srcWidth: 3, srcHeight: 3 };
  /** What the construction path wrote before the parameter existed, frozen. */
  const BEFORE =
    `{"registryType":"imageNode","label":"Image","cost":2,"values":{"imageB64":"${PNG}","width":2,"height":2,` +
    `"fileName":"photo.png","colorSpace":"color","originId":"abc12345","srcWidth":3,"srcHeight":3}}`;

  it('the app orientation writes the bytes it always wrote', () => {
    expect(JSON.stringify(makeImageNodeFromEncode(ENC, 2, 'photo.png', ORIGIN))).toBe(BEFORE);
    expect(JSON.stringify(makeImageNodeFromEncode(ENC, 2, 'photo.png', ORIGIN, undefined))).toBe(BEFORE);
    expect(JSON.stringify(makeImageNodeFromEncode(ENC, 2, 'photo.png', ORIGIN, filePictureOrientation(SPHERE_STATE)))).toBe(BEFORE);
    // A value the type forbids writes nothing either.
    expect(makeImageNodeFromEncode(ENC, 2, 'photo.png', ORIGIN, 'GLTF' as 'gltf').values).not.toHaveProperty('orientation');
  });

  it('over a glTF model’s own UVs it adds `orientation: gltf` and changes nothing else', () => {
    const v = makeImageNodeFromEncode(ENC, 2, 'photo.png', ORIGIN, filePictureOrientation(MODEL_STATE)).values;
    expect(v.orientation).toBe('gltf');
    expect(readImageUvMapping(v).orientation).toBe('gltf');
    expect(readImageTextureSpec(v).flipY).toBe(false);
    expect(JSON.stringify(omit(v, 'orientation'))).toBe(JSON.stringify(makeImageNodeFromEncode(ENC, 2, 'photo.png', ORIGIN).values));
    // The canonical form every restore keeps.
    expect(sanitizeUvMappingKeys(v)).toBeNull();
  });
});

describe('withImagePayload ("From file…"): the decided orientation replaces the old picture’s', () => {
  const FIELDS = { dataUrl: PNG, width: 2, height: 2, fileName: 'photo.png' };
  const MODEL_TEXTURE = { imageB64: 'data:image/png;base64,AAAA', width: 4, height: 4, fileName: 'Diffuse.png', orientation: 'gltf', colorSpace: 'data', tileX: 2, originId: 'deadbeef' };
  const PHOTO = { imageB64: 'data:image/png;base64,AAAA', width: 4, height: 4, fileName: 'old.png', tileX: 2 };

  it('the app orientation is byte-identical to the swap without it — and drops a model texture’s glTF row order', () => {
    for (const live of [MODEL_TEXTURE, PHOTO]) {
      const before = JSON.stringify(withImagePayload(live, FIELDS));
      expect(JSON.stringify(withImagePayload(live, { ...FIELDS, orientation: filePictureOrientation(SPHERE_STATE) }))).toBe(before);
      expect(withImagePayload(live, { ...FIELDS, orientation: filePictureOrientation(SPHERE_STATE) })).not.toHaveProperty('orientation');
    }
  });

  it('over a glTF model’s own UVs the new picture is stored the glTF way; the node’s own settings stay', () => {
    const next = withImagePayload(PHOTO, { ...FIELDS, orientation: filePictureOrientation(MODEL_STATE) });
    expect(next).toMatchObject({ imageB64: PNG, fileName: 'photo.png', orientation: 'gltf', tileX: 2 });
    expect(JSON.stringify(omit(next, 'orientation'))).toBe(JSON.stringify(withImagePayload(PHOTO, FIELDS)));
  });
});

/* ── the store's "Add anyway", for real ─────────────────────────────────── */

describe('the store’s "Add anyway" places the picture with the drop’s orientation, decided as it is placed', () => {
  function reset() {
    useAppStore.setState({
      nodes: [],
      edges: [],
      past: [],
      future: [],
      ...HISTORY_IDLE,
      pendingLimitNotices: [],
      ignoreImageLimits: false,
      importNote: null,
      previewMesh: null,
      previewShowsModel: true,
    });
  }
  beforeEach(reset);
  afterAll(() => {
    cancelPendingGraphSave();
    reset();
  });

  /** The canvas drop's refusal by the project budget, then "Add anyway". */
  function addAnyway(): Record<string, string | number> {
    const s = useAppStore.getState();
    s.enqueueLimitNotice({
      id: 'refused',
      kind: 'image-total-cap',
      fileName: 'photo.png',
      file: { name: 'photo.png' } as unknown as File,
      position: { x: 0, y: 0 },
      encoded: { ...ENC },
    });
    useAppStore.getState().resolveLimitNotice('proceed', null);
    const nodes = useAppStore.getState().nodes;
    expect(nodes).toHaveLength(1);
    return getNodeValues(nodes[0]);
  }
  /** What the canvas drop always stored for this file. */
  const BEFORE = `{"imageB64":"${PNG}","width":2,"height":2,"fileName":"photo.png","colorSpace":"color"}`;

  it('over a glTF model on its own UVs: orientation gltf', () => {
    useAppStore.setState({ previewMesh: meshOf('quad.glb', uvGlb([[Q0]])), previewShowsModel: true });
    const v = addAnyway();
    expect(v.orientation).toBe('gltf');
    expect(JSON.stringify(omit(v, 'orientation'))).toBe(BEFORE);
  });

  it('anywhere else: the values the drop always wrote, byte for byte', () => {
    const cases: [string, Record<string, unknown>][] = [
      ['no model', { previewMesh: null }],
      ['the model loaded, a built-in shape shown', { previewMesh: meshOf('quad.glb', uvGlb([[Q0]])), previewShowsModel: false }],
      ['a glTF without UVs', { previewMesh: meshOf('plain.glb', uvGlb([[O]])) }],
      ['a glTF with UVs on some parts', { previewMesh: meshOf('mixed.glb', uvGlb([[Q0], [O]])) }],
      ['an OBJ with vt', { previewMesh: meshOf('a.obj', new TextEncoder().encode(OBJ_WITH_VT)) }],
      ['a Gaussian splat', { previewMesh: meshOf('c.splat', splatRows(4)) }],
    ];
    for (const [label, state] of cases) {
      reset();
      useAppStore.setState(state);
      expect(JSON.stringify(addAnyway()), label).toBe(BEFORE);
    }
  });

  it('decided once: a later model change never rewrites the stored value', () => {
    useAppStore.setState({ previewMesh: meshOf('quad.glb', uvGlb([[Q0]])), previewShowsModel: true });
    const placed = addAnyway();
    const s = useAppStore.getState();
    s.setPreviewShowsModel(false);
    useAppStore.setState({ previewMesh: meshOf('plain.glb', uvGlb([[O]])) });
    useAppStore.setState({ previewMesh: null });
    const now = getNodeValues(useAppStore.getState().nodes[0]);
    expect(now).toBe(placed);
    expect(now.orientation).toBe('gltf');
  });
});

/* ── every file path into an Image node asks, decided after its encode ──── */

const SRC_ROOT = fileURLToPath(new URL('../', import.meta.url));
const read = (rel: string) => readFileSync(join(SRC_ROOT, rel), 'utf8');
/** Comments out: a pin on what the CODE does must neither be met nor broken by prose. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
function between(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + from.length);
  expect(a, from).toBeGreaterThan(-1);
  expect(b, to).toBeGreaterThan(a);
  return src.slice(a, b);
}
const count = (s: string, needle: string) => s.split(needle).length - 1;
/** The lines of `src` that are code — a JSDoc, block-comment or `//` line is
 *  left out — for a sweep across every source file, whose strings may hold
 *  a slash-star (`accept="image/*"`) that a block-comment regex would eat. */
const codeLines = (src: string) =>
  src
    .split('\n')
    .filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l))
    .join('\n');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sourceFiles(join(dir, e.name))
      : /\.(ts|tsx)$/.test(e.name) && !e.name.endsWith('.test.ts') ? [join(dir, e.name)] : [],
  );
}

describe('every path that brings a FILE’s picture into an Image node asks the one predicate', () => {
  it('the canvas drop: after the encode, from the LIVE store, into the one construction path', () => {
    const editor = code(read('components/NodeEditor/NodeEditor.tsx'));
    const body = between(editor, 'const placeImageFile = useCallback(', '[screenToFlowPosition, addNode],');
    const call =
      /makeImageNodeFromEncode\(\s*payload,\s*cost,\s*file\.name,\s*origin,\s*withModel \? withModel\.orientation : filePictureOrientation\(useAppStore\.getState\(\)\),\s*\)/;
    expect(body).toMatch(call);
    expect(body.search(call)).toBeGreaterThan(body.indexOf('await encodeImageFile('));
    expect(count(editor, 'makeImageNodeFromEncode(')).toBe(1);
  });

  it('the canvas drop WITH a model: its pictures are decided against THAT model, awaited before the budget check', () => {
    // The preview shows the dropped model only after its own read (a textured GLB only after its dialog), so the
    // store answered with the PREVIOUS model.
    const editor = code(read('components/NodeEditor/NodeEditor.tsx'));
    const body = between(editor, 'const placeImageFile = useCallback(', '[screenToFlowPosition, addNode],');
    const awaited = body.indexOf('const withModel = droppedModelOrientation ? { orientation: await droppedModelOrientation } : null;');
    expect(awaited).toBeGreaterThan(body.indexOf('await encodeImageFile('));
    expect(awaited).toBeLessThan(body.indexOf('exceedsImageBudgetAdding('));
    expect(editor).toMatch(
      /const droppedModelOrientation =\s*models\.length > 0 && images\.length > 0 \? droppedModelPictureOrientation\(models\[0\]\) : null;/,
    );
    expect(editor).toContain('await placeImageFile(q.img, q.x, q.y, q.ghostId, choice, dropId, droppedModelOrientation);');
  });

  it('"Add anyway": both branches — the carried encode and the re-encode — place through ONE closure that asks', () => {
    const store = code(read('store/useAppStore.ts'));
    const body = between(store, 'resolveLimitNotice: (action, ignoreFuture) => {', 'setIgnoreImageLimits: (v) => {');
    const place = between(body, 'const place = (', '} as AppNode);');
    expect(place).toMatch(/makeImageNodeFromEncode\(\s*enc,\s*imageNodeCost\(getCost\('imageNode'\), enc\.width, enc\.height\),\s*file\.name,\s*origin,\s*filePictureOrientation\(get\(\)\),\s*\)/);
    expect(body).toContain('place(encoded, encoded.origin);');
    expect(body).toContain('place(payload, origin);');
    expect(count(store, 'makeImageNodeFromEncode(')).toBe(1);
  });

  it('"From file…": decided after the encode from the LIVE store, written through withImagePayload, and part of the no-op test', () => {
    const menu = code(read('components/NodeEditor/menus/ImageNodeSettings.tsx'));
    const body = between(menu, 'async function fillImageNodeFromFile(', 'async function materialiseModelTexture(');
    const decided = body.indexOf('const orientation = replacementPictureOrientation(store, liveVals);');
    expect(decided).toBeGreaterThan(body.indexOf('const store = useAppStore.getState();'));
    expect(body.indexOf('const store = useAppStore.getState();')).toBeGreaterThan(body.indexOf('await encodeImageFile('));
    expect(body).toMatch(/values: withImagePayload\(liveVals, \{[^}]*fileName: file\.name,\s*orientation,/);
    // Loading the very same file again is a no-op only while the answer is
    // unchanged too — read through the mapping reader, never `liveVals.orientation`.
    expect(body).toMatch(
      /currentUrl === payload\.dataUrl &&\s*liveVals\.fileName === file\.name &&\s*readImageUvMapping\(liveVals\)\.orientation === \(orientation \?\? 'app'\)\s*\) return;/,
    );
    expect(count(body, 'replacementPictureOrientation(')).toBe(1);
    expect(count(body, 'filePictureOrientation(')).toBe(0);
  });

  it('a sweep: no other source file encodes a file into an Image node or builds one from an encode', () => {
    const files = sourceFiles(SRC_ROOT).map((f) => [f.slice(SRC_ROOT.length), readFileSync(f, 'utf8')] as const);
    const callers = (needle: RegExp) => files.filter(([, s]) => needle.test(codeLines(s))).map(([f]) => f).sort();
    // `encodeImageFile(` outside its own module: exactly the three file paths.
    // The intro's image slide runs the real drop on a painted photo and asks
    // the same predicate, though its node is only ever DRAWN (it never
    // reaches the graph — introGate.test.ts pins that the intro writes nothing).
    expect(callers(/(?<!function )\bencodeImageFile\(/).filter((f) => f !== 'utils/imageImport.ts')).toEqual([
      'components/NodeEditor/NodeEditor.tsx',
      'components/NodeEditor/menus/ImageNodeSettings.tsx',
      'intro/ImageScene.tsx',
      'store/useAppStore.ts',
    ]);
    // `makeImageNodeFromEncode(`: the drop, its "Add anyway", and the GLB
    // import — a model's own texture, which writes 'gltf' itself.
    expect(callers(/(?<!function )\bmakeImageNodeFromEncode\(/).filter((f) => f !== 'utils/imageNode.ts')).toEqual([
      'components/NodeEditor/NodeEditor.tsx',
      'engine/gltfSectionBuilder.ts',
      'intro/ImageScene.tsx',
      'store/useAppStore.ts',
    ]);
    for (const f of ['components/NodeEditor/NodeEditor.tsx', 'components/NodeEditor/menus/ImageNodeSettings.tsx', 'intro/ImageScene.tsx', 'store/useAppStore.ts']) {
      expect(code(read(f)), f).toMatch(/\b(?:file|replacement)PictureOrientation\(/);
    }
    const builder = code(read('engine/gltfSectionBuilder.ts'));
    expect(builder).toContain('const mv = gltfTextureValues(ref.textureInfo, { normalGreenFlip });');
    expect(builder).toContain('data.values = { ...data.values, ...sv.values, ...mv.values, colorSpace };');
  });

  it('the predicate decides from store state only — no study-mode branch, no stored preference', () => {
    const src = code(read('utils/pictureOrientation.ts'));
    expect(src).not.toMatch(/isEvalMode|localStorage|sessionStorage|useAppStore/);
    expect(src).toMatch(/import \{ shownPreviewMesh \} from '\.\/outputMaterials';/);
  });
});

/* ── the two exceptions: a ticked Flip Y, and a model in the same drop ──── */

describe('replacementPictureOrientation ("From file…" into an existing node)', () => {
  it('a node whose Flip Y is ticked keeps its own orientation — the tick was set against it', () => {
    // App + Flip Y reads exactly as glTF without it: storing 'gltf' under the tick mirrored the replacement.
    expect(replacementPictureOrientation(MODEL_STATE, { flipY: 1 })).toBeUndefined();
    expect(replacementPictureOrientation(SPHERE_STATE, { flipY: 1, orientation: 'gltf' })).toBe('gltf');
    expect(replacementPictureOrientation(MODEL_STATE, { flipY: 1, orientation: 'gltf' })).toBe('gltf');
  });

  it('otherwise it is the file rule, whatever the node stored', () => {
    expect(replacementPictureOrientation(MODEL_STATE, {})).toBe('gltf');
    expect(replacementPictureOrientation(MODEL_STATE, { flipY: 0 })).toBe('gltf');
    expect(replacementPictureOrientation(SPHERE_STATE, { orientation: 'gltf' })).toBeUndefined();
    expect(replacementPictureOrientation(SPHERE_STATE, {})).toBeUndefined();
    expect(replacementPictureOrientation(MODEL_STATE, { flipY: { toString: 1 } as unknown as number })).toBe('gltf');
  });
});

describe('droppedModelPictureOrientation (pictures dropped together with a model)', () => {
  const file = (name: string, bytes: Uint8Array | string) => new File([bytes as BlobPart], name);

  it("answers from the dropped model's OWN bytes, as the preview's read will", async () => {
    expect(await droppedModelPictureOrientation(file('chair.glb', uvGlb([[Q0, O0]])))).toBe('gltf');
    expect(await droppedModelPictureOrientation(file('chair.gltf', uvGltf([[Q0]])))).toBe('gltf');
    expect(await droppedModelPictureOrientation(file('bare.glb', uvGlb([[Q]])))).toBeUndefined();
    expect(await droppedModelPictureOrientation(file('mixed.glb', uvGlb([[Q0, O]])))).toBeUndefined();
  });

  it('an OBJ, a splat, junk bytes and an oversized file answer undefined, and nothing throws', async () => {
    expect(await droppedModelPictureOrientation(file('model.obj', OBJ_WITH_VT))).toBeUndefined();
    expect(await droppedModelPictureOrientation(file('garbage.glb', new Uint8Array([1, 2, 3])))).toBeUndefined();
    expect(await droppedModelPictureOrientation(file('scan.ply', 'ply'))).toBeUndefined();
    const huge = { name: 'huge.glb', size: 2 ** 40, arrayBuffer: () => Promise.reject(new Error('must not be read')) } as unknown as File;
    expect(await droppedModelPictureOrientation(huge)).toBeUndefined();
  });

  it('the predicate module still reads no bytes: the read lives in its own module', () => {
    const src = readFileSync(new URL('./droppedModelOrientation.ts', import.meta.url), 'utf8');
    expect(src).toContain('gltfPreviewFacts(new Uint8Array(await model.arrayBuffer()), kind)');
    expect(src).toContain('if (preReadModelGate(kind, model.size, true)) return undefined;');
  });
});

/* ── what the nodes those paths build do downstream ─────────────────────── */

/** An Image node exactly as the canvas drop builds it, over `state`. */
const dropped = (id: string, state: Parameters<typeof filePictureOrientation>[0]): AppNode =>
  ({
    id,
    type: 'shader',
    position: { x: 0, y: 0 },
    data: makeImageNodeFromEncode(ENC, 2, `${id}.png`, undefined, filePictureOrientation(state)),
  }) as unknown as AppNode;

describe('downstream: codegen, the export gate and texture sharing follow the stored orientation', () => {
  it('codegen uploads the glTF-way picture unflipped, the app one flipped', () => {
    const emit = (state: Parameters<typeof filePictureOrientation>[0]) => {
      const out = makeNode('out', 'output');
      return graphToCode([dropped('img', state), out], [makeEdge('img', 'out', 'out', 'color')]).code;
    };
    expect(emit(MODEL_STATE)).toMatch(/_image\d*_tex\.flipY = false;/);
    expect(emit(SPHERE_STATE)).toMatch(/_image\d*_tex\.flipY = true;/);
    expect(emit(SPHERE_STATE)).not.toMatch(/flipY = false/);
  });

  it('the single-GLB export puts a picture added over the model into the material slot; one added elsewhere stays out', () => {
    const SIG = ['Body'];
    const out = makeNode('out', 'output');
    Object.assign(out.data as Record<string, unknown>, { materials: [{ gltfMaterialIndex: 0 }], modelSignature: { materials: SIG } });
    const edges: AppEdge[] = [makeEdge('T', 'out', 'out', 'm1:color')];
    const plan = (state: Parameters<typeof filePictureOrientation>[0]) => {
      const r = planGlbExport([out, dropped('T', state)], edges, '', { materials: SIG });
      if (!r.ok) throw new Error('plan refused: ' + r.reason);
      return r.plan;
    };
    const over = plan(MODEL_STATE);
    expect(over.problems).toEqual([]);
    expect(over.slots).toHaveLength(1);
    expect(over.slots[0]).toMatchObject({ material: 0, slot: 'baseColor', src: PNG, texCoord: 0 });
    const elsewhere = plan(SPHERE_STATE);
    expect(elsewhere.slots).toEqual([]);
    expect(elsewhere.problems).toEqual([{ material: 0, slot: 'baseColor', reason: 'not-gltf-oriented' }]);
  });

  it('a picture sampled only as a SKY is uploaded the app way whatever it stores; one also sampled on the mesh keeps its orientation', () => {
    // A panorama added over a glTF model is stored glTF-oriented; as an Environment (PMREM reads the texture
    // object) or through a wired Direction (equirect) it then lit and reflected the model upside down.
    const out = () => makeNode('out', 'output');
    const env = graphToCode([dropped('img', MODEL_STATE), out()], [makeEdge('img', 'out', 'out', 'env')]).code;
    expect(env).toMatch(/_image\d*_tex\.flipY = true;/);
    expect(env).not.toMatch(/flipY = false/);
    const dir = graphToCode(
      [dropped('img', MODEL_STATE), makeNode('d1', 'vec3', { x: 0, y: 1, z: 0 }), out()],
      [makeEdge('d1', 'out', 'img', 'dir'), makeEdge('img', 'out', 'out', 'color')],
    ).code;
    expect(dir).toMatch(/texture\(_image\d*_tex, equirectUV\(/);
    expect(dir).not.toMatch(/flipY = false/);
    const both = graphToCode(
      [dropped('img', MODEL_STATE), out()],
      [makeEdge('img', 'out', 'out', 'env'), makeEdge('img', 'out', 'out', 'color')],
    ).code;
    expect(both).toMatch(/_image\d*_tex\.flipY = false;/);
    // The stored key itself is untouched: only the emission ignores it.
    expect(getNodeValues(dropped('img', MODEL_STATE)).orientation).toBe('gltf');
  });

  it('texture sharing still keys on the orientation: one file added over the model and over a sphere is two textures over one element', () => {
    const v = (id: string, state: Parameters<typeof filePictureOrientation>[0]) => getNodeValues(dropped(id, state));
    const mixed = createImageTexturePlanner();
    mixed.place('a', v('a', SPHERE_STATE));
    const b = mixed.place('b', v('b', MODEL_STATE))!;
    expect(b.textureOwner).toBe('b');
    expect(b.imageOwner).toBe('a');
    expect(b.spec.flipY).toBe(false);
    expect([mixed.textureCount, mixed.imageCount]).toEqual([2, 1]);
    const same = createImageTexturePlanner();
    same.place('a', v('a', MODEL_STATE));
    expect(same.place('b', v('b', MODEL_STATE))!.textureOwner).toBe('a');
    expect([same.textureCount, same.imageCount]).toEqual([1, 1]);
  });
});

/* ── the Texture picker: one file, added under two models ──────────────── */

describe('the Texture picker: a file added under two models is ONE cell, and a pick decides it as "From file…" would', () => {
  const OTHER = { imageB64: 'data:image/png;base64,AAAA', width: 4, height: 4, fileName: 'other.png', colorSpace: 'color' };
  const pick = (nodes: AppNode[], state: Parameters<typeof filePictureOrientation>[0], into: Record<string, string | number>) => {
    const cells = projectTextureSources(nodes);
    expect(cells).toHaveLength(1);
    return pickTextureValues(into, cells[0], replacementPictureOrientation(state, into))!;
  };

  it('the model on screen decides — in either document order, never the first holder', () => {
    // Same file, same encode, dropped once over a sphere and once over the model.
    const a = dropped('a', SPHERE_STATE);
    const b = dropped('b', MODEL_STATE);
    for (const order of [[a, b], [b, a]]) {
      expect(projectTextureSources(order)[0].orientation).toBe('mixed');
      expect(readImageTextureSpec(pick(order, MODEL_STATE, OTHER)).flipY, 'model on screen').toBe(false);
      expect(readImageTextureSpec(pick(order, SPHERE_STATE, OTHER)).flipY, 'sphere on screen').toBe(true);
    }
    // Exactly what "From file…" stores for that file into that node.
    const fromFile = withImagePayload(OTHER, {
      dataUrl: ENC.dataUrl, width: 2, height: 2, fileName: 'b.png', orientation: replacementPictureOrientation(MODEL_STATE, OTHER),
    });
    expect(readImageUvMapping(pick([a, b], MODEL_STATE, OTHER)).orientation).toBe(readImageUvMapping(fromFile).orientation);
  });

  it('a node whose Flip Y is ticked keeps its own frame, as "From file…" does', () => {
    const order = [dropped('a', SPHERE_STATE), dropped('b', MODEL_STATE)];
    expect(pick(order, MODEL_STATE, { ...OTHER, flipY: 1 })).not.toHaveProperty('orientation');
    expect(pick(order, SPHERE_STATE, { ...OTHER, flipY: 1, orientation: 'gltf' }).orientation).toBe('gltf');
  });

  it('a picture every holder stores one way still brings that way, whatever is on screen', () => {
    expect(pick([dropped('a', MODEL_STATE), dropped('b', MODEL_STATE)], SPHERE_STATE, OTHER).orientation).toBe('gltf');
    expect(pick([dropped('a', SPHERE_STATE), dropped('b', SPHERE_STATE)], MODEL_STATE, OTHER)).not.toHaveProperty('orientation');
  });

  it('codegen still shares by orientation: the picked node joins the holder stored its way', () => {
    const a = dropped('a', SPHERE_STATE);
    const b = dropped('b', MODEL_STATE);
    const planner = createImageTexturePlanner();
    planner.place('a', getNodeValues(a));
    planner.place('b', getNodeValues(b));
    const c = planner.place('c', pick([a, b], MODEL_STATE, OTHER))!;
    expect(c.textureOwner).toBe('b');
    expect(c.imageOwner).toBe('a');
    expect([planner.textureCount, planner.imageCount]).toEqual([2, 1]);
  });

  it('the menu passes the "From file…" answer, decided from the LIVE store and node', () => {
    const menu = code(read('components/NodeEditor/menus/ImageNodeSettings.tsx'));
    const body = between(menu, 'const pickTexture = ', 'const pickFile = ');
    expect(body).toMatch(/const next = pickTextureValues\(liveVals, src, replacementPictureOrientation\(store, liveVals\)\);/);
    expect(body.indexOf('const store = useAppStore.getState();')).toBeGreaterThan(-1);
    expect(body.indexOf('const liveVals = getNodeValues(live);')).toBeLessThan(body.indexOf('pickTextureValues('));
  });
});

/* ── in the preview document: the orientation that reads upright ───────── */

interface FitComponent {
  fit: (this: { el: { getObject3D: () => THREE.Object3D | null }; data: { size: number; regen: boolean } }) => void;
}

/** The preview's own fit-bounds, evaluated against the real three. */
function fitBounds(): FitComponent {
  const registry: Record<string, FitComponent> = {};
  const AFRAME = {
    components: {} as Record<string, unknown>,
    registerComponent: (name: string, def: FitComponent) => {
      registry[name] = def;
    },
  };
  const body = FIT_BOUNDS_SCRIPT.replace(/^<script>/, '').replace(/<\/script>$/, '');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('THREE', 'window', 'AFRAME', body)(THREE, { AFRAME }, AFRAME);
  expect(registry['fit-bounds'], 'fit-bounds was not registered').toBeTruthy();
  return registry['fit-bounds'];
}

/** What the preview draws for a dropped model: GLTFLoader's scene after
 *  fit-bounds' PRESERVE path (`regen: false`, every GLB/glTF), one geometry
 *  per drawn primitive. */
async function previewGeometries(bytes: Uint8Array<ArrayBuffer>): Promise<THREE.BufferGeometry[]> {
  const gltf = await new GLTFLoader().parseAsync(bytes.buffer, '');
  const root = gltf.scene;
  fitBounds().fit.call({ el: { getObject3D: () => root }, data: { size: 1.6, regen: false } });
  root.updateMatrixWorld(true);
  const out: THREE.BufferGeometry[] = [];
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) out.push((o as THREE.Mesh).geometry);
  });
  return out;
}

/**
 * Does a picture stored in `orientation` read UPRIGHT and unmirrored on every
 * front-facing triangle of `g`? The preview camera looks down −Z (x right, y
 * up), and fit-bounds has baked every transform into the vertices. In the
 * picture's own frame x is u, and its UP is +v when it is uploaded flipped
 * (the app orientation, three's default) but −v when it is not (glTF: its
 * first row is its top) — so the screen → picture map must keep right right,
 * up up, and its determinant positive.
 */
function readsUpright(g: THREE.BufferGeometry, orientation: 'app' | 'gltf'): boolean {
  const pos = g.getAttribute('position');
  const uv = g.getAttribute('uv');
  if (!uv) return false;
  const idx = g.getIndex();
  const n = idx ? idx.count : pos.count;
  let faced = 0;
  for (let t = 0; t + 2 < n; t += 3) {
    const c = [0, 1, 2].map((k) => (idx ? idx.getX(t + k) : t + k));
    const p = c.map((i) => new THREE.Vector3().fromBufferAttribute(pos, i));
    const normal = new THREE.Vector3().subVectors(p[1], p[0]).cross(new THREE.Vector3().subVectors(p[2], p[0])).normalize();
    if (normal.z < 0.5) continue;
    faced++;
    const pic = c.map((i) => [uv.getX(i), orientation === 'app' ? uv.getY(i) : 1 - uv.getY(i)]);
    const e1 = [p[1].x - p[0].x, p[1].y - p[0].y];
    const e2 = [p[2].x - p[0].x, p[2].y - p[0].y];
    const d1 = [pic[1][0] - pic[0][0], pic[1][1] - pic[0][1]];
    const d2 = [pic[2][0] - pic[0][0], pic[2][1] - pic[0][1]];
    const det = e1[0] * e2[1] - e2[0] * e1[1];
    // J = [d1 d2]·[e1 e2]⁻¹: d(picture)/d(screen).
    const j00 = (d1[0] * e2[1] - d2[0] * e1[1]) / det;
    const j01 = (d2[0] * e1[0] - d1[0] * e2[0]) / det;
    const j10 = (d1[1] * e2[1] - d2[1] * e1[1]) / det;
    const j11 = (d2[1] * e1[0] - d1[1] * e2[0]) / det;
    if (!(j00 > 0 && j11 > 0 && j00 * j11 - j01 * j10 > 0)) return false;
  }
  return faced > 0;
}

describe('in the preview document (real GLTFLoader + the preview’s fit-bounds): the stored orientation is the one that reads upright', () => {
  beforeEach(() => {
    for (const [k, v] of Object.entries(GLTF_NODE_GLOBALS)) vi.stubGlobal(k, v);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** The orientation a file's picture is stored with over this model. */
  const storedOver = (name: string, bytes: Uint8Array) => filePictureOrientation(shown(meshOf(name, bytes))) ?? 'app';

  it('a model on its OWN TEXCOORD_0 (v down): only the glTF way reads upright — and that is what is stored', async () => {
    for (const [name, bytes] of [
      ['quad.glb', uvGlb([[Q0]])],
      ['octahedron.glb', uvGlb([[O0]])],
    ] as const) {
      const geoms = await previewGeometries(bytes);
      expect(geoms.length, name).toBeGreaterThan(0);
      expect(geoms.every((g) => readsUpright(g, 'gltf')), name).toBe(true);
      expect(geoms.some((g) => readsUpright(g, 'app')), name).toBe(false);
      expect(storedOver(name, bytes), name).toBe('gltf');
    }
  });

  it('a model WITHOUT UVs gets spherical UVs (three’s v up): only the app way reads upright — and that is what is stored', async () => {
    const bytes = uvGlb([[O]]);
    const geoms = await previewGeometries(bytes);
    expect(geoms).toHaveLength(1);
    expect(readsUpright(geoms[0], 'app')).toBe(true);
    expect(readsUpright(geoms[0], 'gltf')).toBe(false);
    expect(storedOver('octahedron.glb', bytes)).toBe('app');
  });

  it('a model with UVs on SOME parts: no one orientation reads upright everywhere, so nothing changes (the app way)', async () => {
    const bytes = uvGlb([[Q0], [O]]);
    const geoms = await previewGeometries(bytes);
    expect(geoms).toHaveLength(2);
    expect(geoms.map((g) => readsUpright(g, 'gltf'))).toEqual([true, false]);
    expect(geoms.map((g) => readsUpright(g, 'app'))).toEqual([false, true]);
    expect(storedOver('mixed.glb', bytes)).toBe('app');
  });
});

/* ── the documentation states it ────────────────────────────────────────── */

describe('the docs state the rule', () => {
  it('names the predicate, what it reads, the paths that ask it, and that the answer is decided once', () => {
    const DOCS = projectDocs();
    for (const claim of [
      "a picture added from a file over a glTF model's own UVs is stored glTF-oriented",
      '`filePictureOrientation`',
      '`PreviewMesh.gltf.uv0`',
      'decided ONCE, when the picture is written into its node',
      '`orientation` is a fact about the BYTES',
    ]) {
      expect(DOCS, claim).toContain(claim);
    }
  });
});
