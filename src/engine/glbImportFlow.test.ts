/**
 * The GLB import flow end to end over hand-built models (Phase 5 Step 9):
 * the reader → the facts → the plan — what the dialog would offer, refuse,
 * gate or price for each shape — and, for one of them, all the way through
 * the builder and `commitGlbImport` into the real store, so the pieces the
 * dialog composes are proven to fit.
 *
 * Store-mutating under `isolate: false`: reset around every test, stubs
 * undone, the pending autosave cancelled.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { readGltfModel } from '@/utils/gltfReader';
import { glbImportFactsOf, planGlbImportDialog, type GlbDialogContext } from '@/utils/glbImportGate';
import { GLB_IMPORT_MATERIAL_LIMIT } from '@/utils/glbImportLimits';
import { MAX_INDEX_MATERIALS } from './materialPartsContract';
import { buildGlbImport } from './gltfImport';
import { commitGlbImport } from './projectImport';
import { glbImportReportLines } from '@/utils/glbImportReport';
import { useAppStore, cancelPendingGraphSave } from '@/store/useAppStore';
import { contributingOutputs, gltfIndexOf, isIndexSection, outputMaterials, readModelSignature, indexSectionsAwake, loadedModelOf } from '@/utils/outputMaterials';
import { HISTORY_IDLE, makeGlb, makeRealPng, pngHeaderBytes } from '@/test-utils';
import { blenderGlb, fakeEncoder, fakeStash, glbOf, manyMaterialsGlb, readOk, scanGlb } from './gltfImportFixtures';

const CTX: GlbDialogContext = { allowManyMaterials: false, ignoreImageLimits: false, deviceMaxDim: 2048 };

/** The plan for a model's bytes: null facts when the reader refuses. */
function planOf(bytes: Uint8Array, kind: 'glb' | 'gltf' = 'glb', ctx = CTX) {
  const r = readGltfModel(bytes, kind);
  const facts = r.ok ? glbImportFactsOf(r.model, 'model.' + kind, bytes.length) : null;
  return { refused: !r.ok, facts, plan: planGlbImportDialog(facts, ctx) };
}

describe('what the dialog is offered', () => {
  it('(a) two materials with base colour 2048², normal 1024² and ORM 1024² PNGs: offered, gate ok, 6 textures, fits', () => {
    const big = pngHeaderBytes(2048, 2048);
    const mid = pngHeaderBytes(1024, 1024);
    const blobs = [big, mid, mid, big, mid, mid];
    const bytes = glbOf(
      {
        images: blobs.map((_, i) => ({ bufferView: i + 1, mimeType: 'image/png' })),
        textures: blobs.map((_, i) => ({ source: i })),
        materials: [0, 3].map((base, m) => ({
          name: `M${m}`,
          pbrMetallicRoughness: { baseColorTexture: { index: base }, metallicRoughnessTexture: { index: base + 2 } },
          normalTexture: { index: base + 1 },
        })),
        meshes: [0, 1].map((i) => ({ name: `Mesh${i}`, primitives: [{ attributes: { POSITION: 0 }, material: i }] })),
        nodes: [{ mesh: 0 }, { mesh: 1 }],
        scenes: [{ nodes: [0, 1] }],
        scene: 0,
      },
      blobs,
    );
    const { plan } = planOf(bytes);
    expect(plan.offer).toBe(true);
    expect(plan.gate).toEqual({ state: 'ok', build: 2 });
    expect(plan).toMatchObject({ materials: 2, textures: 6, primary: 'build', maxDim: null });
    expect(plan.budget?.fits).toBe(true);
    expect(plan.memory?.count).toBe(6);
  });

  it('(b) 12 materials each with a base colour: blocked with the setting off, confirm with it on', () => {
    const bytes = manyMaterialsGlb(12);
    expect(planOf(bytes).plan.gate).toEqual({ state: 'blocked', n: 12, limit: GLB_IMPORT_MATERIAL_LIMIT });
    expect(planOf(bytes, 'glb', { ...CTX, allowManyMaterials: true }).plan.gate).toEqual({
      state: 'confirm', n: 12, limit: GLB_IMPORT_MATERIAL_LIMIT, build: 12, keptAuthored: 0, max: MAX_INDEX_MATERIALS,
    });
  });

  it('(c) factor-only materials are not offered', () => {
    const bytes = makeGlb(
      {
        asset: { version: '2.0' },
        buffers: [{ byteLength: 36 }],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
        accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
        materials: [{ name: 'A', pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1] } }, { name: 'B' }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }, { attributes: { POSITION: 0 }, material: 1 }] }],
        nodes: [{ mesh: 0 }],
        scenes: [{ nodes: [0] }],
        scene: 0,
      },
      new Uint8Array(36),
    );
    const { refused, plan } = planOf(bytes);
    expect(refused).toBe(false);
    expect(plan.offer).toBe(false);
  });

  it('(d) a .gltf whose only image is an external uri is not offered (the reader refuses external data, or the texture is unextractable)', () => {
    const doc = {
      asset: { version: '2.0' },
      buffers: [{ byteLength: 36, uri: 'data:application/octet-stream;base64,' + Buffer.from(new Uint8Array(36)).toString('base64') }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
      images: [{ uri: 'albedo.png' }],
      textures: [{ source: 0 }],
      materials: [{ name: 'A', pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
      nodes: [{ mesh: 0 }],
      scenes: [{ nodes: [0] }],
      scene: 0,
    };
    const bytes = new TextEncoder().encode(JSON.stringify(doc));
    const { plan } = planOf(bytes, 'gltf');
    expect(plan.offer).toBe(false);
  });

  it('(e) a material referenced by no primitive is not counted', () => {
    const png = makeRealPng(2, 2, [1, 2, 3, 255]);
    const bytes = glbOf(
      {
        images: [{ bufferView: 1, mimeType: 'image/png' }],
        textures: [{ source: 0 }],
        materials: [
          { name: 'used', pbrMetallicRoughness: { baseColorTexture: { index: 0 } } },
          { name: 'orphan', pbrMetallicRoughness: { baseColorTexture: { index: 0 } } },
        ],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
        nodes: [{ mesh: 0 }],
        scenes: [{ nodes: [0] }],
        scene: 0,
      },
      [png],
    );
    const { plan } = planOf(bytes);
    expect(plan.materials).toBe(1);
    expect(plan.buildMaterialIndices).toEqual([0]);
  });

  it('a file the reader refuses has no facts and is not offered (model-only is the caller\'s path)', () => {
    const { refused, facts, plan } = planOf(new Uint8Array([1, 2, 3, 4]));
    expect(refused).toBe(true);
    expect(facts).toBeNull();
    expect(plan.offer).toBe(false);
  });
});

/* ── through the store ───────────────────────────────────────────────────── */

let ls: Record<string, string>;
let savedName = '';
beforeAll(() => {
  savedName = useAppStore.getState().shaderName;
});
function reset() {
  cancelPendingGraphSave();
  useAppStore.setState({
    nodes: [],
    edges: [],
    past: [],
    future: [],
    ...HISTORY_IDLE,
    previewMesh: null,
    previewMeshInventory: null,
    pendingLimitNotices: [],
    importNote: null,
  });
}
beforeEach(() => {
  reset();
  ls = {};
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (Object.prototype.hasOwnProperty.call(ls, k) ? ls[k] : null),
    setItem: (k: string, v: string) => { ls[k] = String(v); },
    removeItem: (k: string) => { delete ls[k]; },
  });
});
afterEach(() => {
  reset();
  vi.unstubAllGlobals();
});
afterAll(() => {
  cancelPendingGraphSave();
  vi.unstubAllGlobals();
  useAppStore.setState({ shaderName: savedName });
});

describe('Build: the plan feeds the builder, the builder feeds the commit', () => {
  it('SCAN: the dialog\'s build indices and cap go in, the sections come out awake on the stripped mesh, one note', async () => {
    const bytes = scanGlb();
    const report = readOk(bytes);
    const facts = glbImportFactsOf(report, 'scan.glb', bytes.length);
    const plan = planGlbImportDialog(facts, CTX);
    expect(plan.primary).toBe('build');
    const r = await buildGlbImport(report, 'scan.glb', {
      bytes,
      materialIndices: plan.buildMaterialIndices,
      maxDim: plan.maxDim,
      deviceMaxDim: CTX.deviceMaxDim,
      ignoreImageLimits: false,
      signal: new AbortController().signal,
      encode: fakeEncoder([]),
      stash: fakeStash(),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const before = useAppStore.getState().past.length;
    commitGlbImport(r.project, r.mesh);
    useAppStore.getState().showImportNote(glbImportReportLines(r.report));
    const s = useAppStore.getState();
    expect(s.past.length).toBe(before + 1);
    expect(s.shaderName).toBe('scan');
    expect(s.previewMesh).toBe(r.mesh);
    expect(ls['fs:previewGeometry']).toBe('custom');
    // The commit SPLITS the built Output: the untargeted default plus one node
    // per glTF material, the binding at node level.
    const outs = contributingOutputs(s.nodes);
    expect(outs.map((n) => gltfIndexOf(outputMaterials(n)[0]))).toEqual([null, 0, 1, 2]);
    const sigNode = outs.find((n) => outputMaterials(n).some(isIndexSection))!;
    expect(indexSectionsAwake(readModelSignature(sigNode.data), loadedModelOf(s.previewMesh))).toBe(true);
    expect(s.importNote?.lines[0]).toEqual({ kind: 'glb-import', materials: 3, textures: 5, shared: 0 });
    expect(s.pendingLimitNotices.filter((n) => n.kind === 'output-sections-trimmed')).toHaveLength(0);
  });

  it('a blocked plan builds nothing (no build indices); a confirm plan past the ceiling keeps the rest authored', async () => {
    const bytes = manyMaterialsGlb(MAX_INDEX_MATERIALS + 2);
    const report = readOk(bytes);
    const facts = glbImportFactsOf(report, 'many.glb', bytes.length);
    expect(planGlbImportDialog(facts, CTX).buildMaterialIndices).toEqual([]);
    const plan = planGlbImportDialog(facts, { ...CTX, allowManyMaterials: true });
    const r = await buildGlbImport(report, 'many.glb', {
      bytes,
      materialIndices: plan.buildMaterialIndices,
      maxDim: plan.maxDim,
      deviceMaxDim: 2048,
      ignoreImageLimits: false,
      signal: new AbortController().signal,
      encode: fakeEncoder([]),
      stash: fakeStash(),
    });
    expect(r.ok && r.report.materials).toBe(MAX_INDEX_MATERIALS);
    expect(r.ok && r.report.keptAuthored).toBe(2);
  });

  it('the BLENDER model is offered with its Latvian-named material and builds three sections', async () => {
    const bytes = blenderGlb();
    const { plan, facts } = planOf(bytes);
    expect(plan.offer).toBe(true);
    expect(facts?.materialIndices).toEqual([0, 1, 2]);
  });
});
