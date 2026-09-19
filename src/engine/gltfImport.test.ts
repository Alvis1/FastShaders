/**
 * THE GLB IMPORT COMPOSER (Phase 5 Step 8): `buildGlbImport` over the three
 * fixture shapes — the project, the texture-stripped mesh and the report —
 * plus the two round trips the sections must survive: the export zip
 * reopened through `importShaderZip`, and the IndexedDB record rebuilt
 * through `recordToMesh`, both leaving the index sections AWAKE on the
 * model they were built for.
 *
 * Store-mutating under `isolate: false`: the store is reset around every
 * test, the stubbed localStorage is undone, the pending autosave cancelled.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { buildGlbImport, glbImportShaderName, type BuildGlbImportOptions } from './gltfImport';
import { graphToCode } from './graphToCode';
import { codeToGraph } from './codeToGraph';
import { tslToShaderModule } from './tslToShaderModule';
import { inlineImageAssetsFromNodes } from './imageAssets';
import { embedProjectState } from './fastShadersProject';
import { collectShaderProperties } from './exportShader';
import { importShaderZip } from './projectImport';
import { checkLegacyGuard, MAX_INDEX_MATERIALS } from './materialPartsContract';
import { useAppStore, cancelPendingGraphSave } from '@/store/useAppStore';
import { buildExportBundle } from '@/utils/exportBundle';
import { collectImageFiles, MAX_TOTAL_IMAGE_CHARS } from '@/utils/imageNode';
import { meshToRecord, recordToMesh } from '@/utils/previewMeshCache';
import { readGltfModel } from '@/utils/gltfReader';
import { planTextureStrip } from '@/utils/gltfStrip';
import {
  indexSectionsAwake,
  loadedModelOf,
  materialPartsMirrorPlan,
  outputMaterials,
  readModelSignature,
  sanitizeOutputMaterialsReport,
} from '@/utils/outputMaterials';
import { glbImportReportLines } from '@/utils/glbImportReport';
import { importNoteLineText } from '@/utils/importNote';
import type { AppNode } from '@/types';
import { PNG_COLOR, aiGlb, blenderGlb, fakeEncoder, fakeStash, glbOf, hugeTextureGlb, manyMaterialsGlb, readOk, scanGlb, type FakeEncodeCall } from './gltfImportFixtures';

function opts(bytes: Uint8Array, over: Partial<BuildGlbImportOptions> = {}, calls: FakeEncodeCall[] = []): BuildGlbImportOptions {
  return {
    bytes,
    materialIndices: [0, 1, 2, 3],
    maxDim: null,
    deviceMaxDim: 2048,
    ignoreImageLimits: false,
    signal: new AbortController().signal,
    encode: fakeEncoder(calls),
    stash: fakeStash(),
    ...over,
  };
}

async function buildOk(bytes: Uint8Array, name = 'Model File.glb', over: Partial<BuildGlbImportOptions> = {}) {
  const r = await buildGlbImport(readOk(bytes), name, opts(bytes, over));
  if (!r.ok) throw new Error('not ok: ' + JSON.stringify(r));
  return r;
}

const outOf = (nodes: AppNode[]) => nodes.find((n) => n.data.registryType === 'output')!;

describe('the result', () => {
  it('BLENDER: a project named after the model, three index sections, a stripped custom mesh, one report', async () => {
    const r = await buildOk(blenderGlb());
    expect(r.project).toMatchObject({ version: 1, shaderName: 'Model-File', preview: { geometry: 'custom' }, ui: {} });
    const out = outOf(r.project.graph.nodes);
    expect(outputMaterials(out).slice(1).map((m) => m.gltfMaterialIndex)).toEqual([0, 1, 2]);
    expect(r.mesh.kind).toBe('glb');
    expect(r.mesh.name).toBe('Model-File.glb');
    // The mesh is the STRIPPED copy: smaller than the drop, same signature,
    // and the sections are awake on it.
    expect(r.mesh.bytes.length).toBeLessThan(blenderGlb().length);
    expect(r.mesh.gltf?.signature).toEqual(['Material.001', 'Material.002', 'Ķermenis']);
    expect(indexSectionsAwake(readModelSignature(out.data), loadedModelOf(r.mesh))).toBe(true);
    const original = readOk(blenderGlb());
    const stripped = readGltfModel(r.mesh.bytes, 'glb');
    expect(stripped.ok && stripped.model.images.every((img, i) => img.byteLength !== original.images[i].byteLength)).toBe(true);
    expect(r.report).toMatchObject({
      materials: 3,
      textures: 3,
      shared: 1,
      keptAuthored: 0,
      sectionMax: MAX_INDEX_MATERIALS,
      decodeDownscaled: { count: 0, maxSide: 0 },
      notImported: ['occlusion', 'normalScale', 'alphaCutoff'],
    });
    expect(r.report.outcomes.map((o) => [o.name, o.outcome])).toEqual([
      ['BaseColor.png', 'kept'],
      ['ORM.png', 'kept'],
      ['Normal.png', 'kept'],
    ]);
  });

  it('SCAN: the JPEG base colours are downscaled to the slot, and the note says so', async () => {
    const r = await buildOk(scanGlb(), 'scan.glb');
    expect(r.project.shaderName).toBe('scan');
    expect(r.report.outcomes.filter((o) => o.outcome === 'downscaled')).toHaveLength(3);
    const lines = glbImportReportLines(r.report).map((l) => importNoteLineText(l, 'en'));
    expect(lines[0]).toBe('Imported materials: 3, textures: 5.');
    expect(lines).toContain('Body_diffuse.jpg: downscaled to 1024×576 (the size used for this kind of map)');
  });

  it('AI: the unused material is not built; the dead emissive and the clearcoat are reported', async () => {
    const r = await buildOk(aiGlb(), 'mesh.glb');
    expect(outputMaterials(outOf(r.project.graph.nodes)).slice(1).map((m) => m.gltfMaterialIndex)).toEqual([0]);
    expect(r.report.materials).toBe(1);
    expect(r.report.notImported).toEqual(['clearcoat', 'emissiveUnused']);
  });

  it('N10: a source past the 64 MP guard is counted', async () => {
    const r = await buildOk(hugeTextureGlb(), 'huge.glb');
    expect(r.report.decodeDownscaled).toEqual({ count: 1, maxSide: 1024 });
  });

  it('past the section cap the lowest indices are built and the rest kept authored', async () => {
    const n = MAX_INDEX_MATERIALS + 2;
    const bytes = manyMaterialsGlb(n);
    const r = await buildOk(bytes, 'many.glb', { materialIndices: Array.from({ length: n }, (_, i) => i) });
    expect(r.report).toMatchObject({ materials: MAX_INDEX_MATERIALS, keptAuthored: 2 });
    const lines = glbImportReportLines(r.report).map((l) => l.kind);
    expect(lines).toContain('glb-kept-authored');
    // The unbuilt materials keep their textures in the stripped copy (their
    // bytes are exactly the dropped file's); the built ones hold the placeholder.
    const original = readOk(bytes);
    const stripped = readGltfModel(r.mesh.bytes, 'glb');
    expect(stripped.ok).toBe(true);
    if (!stripped.ok) return;
    const kept = stripped.model.images.filter((img, i) => img.byteLength === original.images[i].byteLength);
    expect(kept.map((i) => i.index)).toEqual([MAX_INDEX_MATERIALS, MAX_INDEX_MATERIALS + 1]);
  });

  it('nothing to strip (a factor-only material) keeps the dropped bytes as the mesh', async () => {
    const bytes = blenderGlb();
    const r = await buildOk(bytes, 'b.glb', { materialIndices: [2] });
    expect(planTextureStrip(readOk(bytes), [2])).toBeNull();
    expect(r.mesh.bytes.length).toBe(bytes.length);
    expect(r.report).toMatchObject({ materials: 1, textures: 0 });
  });

  it('a texture with no extractable image is reported under the reader\'s own name, never texture-<n>', async () => {
    // Material 0: base colour → an EXTERNAL image named "wood"; normal → an
    // unnamed external image whose TEXTURE is named; emissive → a readable PNG.
    const bytes = glbOf(
      {
        images: [
          { bufferView: 1, mimeType: 'image/png', name: 'ok' },
          { uri: 'wood.jpg', name: 'wood' },
          { uri: 'bump.png' },
        ],
        textures: [{ source: 0 }, { source: 1, name: 'woodTex' }, { source: 2, name: 'bumpTex' }],
        materials: [
          {
            name: 'M',
            pbrMetallicRoughness: { baseColorTexture: { index: 1 } },
            normalTexture: { index: 2 },
            emissiveTexture: { index: 0 },
            emissiveFactor: [1, 1, 1],
          },
        ],
        meshes: [{ name: 'Mesh', primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
        nodes: [{ mesh: 0 }],
        scenes: [{ nodes: [0] }],
        scene: 0,
      },
      [PNG_COLOR],
    );
    const r = await buildOk(bytes, 'ext.glb', { materialIndices: [0] });
    const skipped = r.report.outcomes.filter((o) => o.outcome === 'skipped');
    expect(skipped).toEqual([
      { name: 'wood', outcome: 'skipped', reason: 'external' },
      { name: 'bumpTex', outcome: 'skipped', reason: 'external' },
    ]);
    const lines = glbImportReportLines(r.report).map((l) => importNoteLineText(l, 'en'));
    expect(lines).toContain('wood: skipped (stored in a separate file)');
    expect(lines.some((l) => l.startsWith('texture-'))).toBe(false);
  });

  it('the shader name is the sanitised stem', () => {
    expect(glbImportShaderName('My Model (v2).glb', 'glb')).toBe('My-Model-v2');
    expect(glbImportShaderName('../../x.gltf', 'gltf')).toBe('x');
    expect(glbImportShaderName('.glb', 'glb')).toBe('model');
  });
});

describe('failures', () => {
  it('an abort before or during the encode is "aborted", and nothing else is built', async () => {
    const ac = new AbortController();
    ac.abort();
    const bytes = scanGlb();
    const r = await buildGlbImport(readOk(bytes), 's.glb', opts(bytes, { signal: ac.signal }));
    expect(r).toEqual({ ok: false, reason: 'aborted' });
    const ac2 = new AbortController();
    const r2 = await buildGlbImport(
      readOk(bytes),
      's.glb',
      opts(bytes, { signal: ac2.signal, onProgress: () => ac2.abort() }),
    );
    expect(r2).toEqual({ ok: false, reason: 'aborted' });
  });

  it('a name that is not a glTF model is "failed"', async () => {
    const bytes = scanGlb();
    const r = await buildGlbImport(readOk(bytes), 'model.obj', opts(bytes));
    expect(r).toMatchObject({ ok: false, reason: 'failed' });
  });

  it('the stripped copy goes through createPreviewMesh, so a refusal is "mesh-refused"', async () => {
    // A .gltf whose bytes are not a glTF at all cannot be stripped from the
    // report we hand in (the plan is null), so the dropped bytes are the mesh
    // and createPreviewMesh refuses the empty file.
    const bytes = blenderGlb();
    const r = await buildGlbImport(readOk(bytes), 'b.glb', opts(new Uint8Array(0), { materialIndices: [2] }));
    expect(r).toMatchObject({ ok: false, reason: 'mesh-refused' });
    if (!r.ok && r.reason === 'mesh-refused') expect(r.refusal.reason).toBe('empty');
  });

  it('the encoder budget is the whole project budget, lifted by ignore-limits', async () => {
    const bytes = scanGlb();
    // 8 bytes per lossy pixel: each 1024×576 base colour alone is ~6.3M chars,
    // far past the 3M project budget, so the composer's budget must bite.
    const imageChars = (nodes: AppNode[]) =>
      nodes.reduce((n, x) => n + String((x.data as { values?: { imageB64?: unknown } }).values?.imageB64 ?? '').length, 0);
    const heavy = (calls: FakeEncodeCall[]) => fakeEncoder(calls, { lossyBytesPerPixel: 8 });

    const limited: FakeEncodeCall[] = [];
    const r = await buildOk(bytes, 's.glb', { encode: heavy(limited) });
    expect(limited.every((c) => !c.ignoreLimits)).toBe(true);
    expect(r.report.outcomes.some((o) => (o.outcome === 'downscaled' || o.outcome === 'skipped') && o.reason === 'budget')).toBe(true);
    expect(imageChars(r.project.graph.nodes)).toBeGreaterThan(0);
    expect(imageChars(r.project.graph.nodes)).toBeLessThanOrEqual(MAX_TOTAL_IMAGE_CHARS);

    const lifted: FakeEncodeCall[] = [];
    const u = await buildOk(bytes, 's.glb', { ignoreImageLimits: true, encode: heavy(lifted) });
    expect(lifted.every((c) => c.ignoreLimits)).toBe(true);
    expect(u.report.outcomes.some((o) => (o.outcome === 'downscaled' || o.outcome === 'skipped') && o.reason === 'budget')).toBe(false);
    expect(imageChars(u.project.graph.nodes)).toBeGreaterThan(MAX_TOTAL_IMAGE_CHARS);
    expect(MAX_TOTAL_IMAGE_CHARS).toBe(3_000_000);
  });
});

describe('emission and the module', () => {
  for (const [name, bytes] of [['BLENDER', blenderGlb()], ['SCAN', scanGlb()], ['AI', aiGlb()]] as const) {
    it(`${name}: the module carries parts mirrors, materialParts, modelSignature and materialPartsMirror; apply∘apply is stable`, async () => {
      const r = await buildOk(bytes, `${name.toLowerCase()}.glb`);
      const { nodes, edges } = r.project.graph;
      const out = outOf(nodes);
      const code = graphToCode(nodes, edges).code;
      const mirror = materialPartsMirrorPlan(out);
      expect(mirror.length).toBeGreaterThan(0);
      const module = tslToShaderModule(inlineImageAssetsFromNodes(code, nodes), undefined, collectShaderProperties(nodes), mirror);
      expect(module).toContain('materialParts:');
      expect(module).toContain('modelSignature:');
      expect(module).toContain('materialPartsMirror:');
      for (const e of mirror) expect(module).toContain(JSON.stringify(e.name));
      // buildShaderModule throws in dev (vitest) on any checkLegacyGuard
      // violation, so a module that came back at all passed R1/R3/R4.
      expect(checkLegacyGuard({ hasMaterialParts: true, hasParts: true, hasSignature: true, partKeys: mirror.map((e) => e.name), mirrorKeys: mirror.map((e) => e.name) })).toEqual([]);
      // The code panel never carries the mirrors.
      expect(code).not.toContain('materialPartsMirror');
      // Image nodes are one-way through the parse; from the parsed graph on
      // the sections must be stable (BLENDER's flipped normal map is the
      // documented exception: its `unknown` fallback renames once, see
      // gltfSectionBuilder.test.ts).
      const a = codeToGraph(code);
      const second = graphToCode(a.nodes, a.edges).code;
      const b = codeToGraph(second);
      const third = graphToCode(b.nodes, b.edges).code;
      expect(name === 'BLENDER' ? third.replace(/\bfloat5\b/g, 'normalMap1') : third).toBe(second);
      expect(b.nodes.length).toBe(a.nodes.length);
      expect(module.replace(/data:image\/webp;base64,[A-Za-z0-9+/=]+/g, '<payload>')).toMatchSnapshot();
    });
  }
});

/* ── the round trips, through the real store ─────────────────────────────── */

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

describe('round trips', () => {
  it('export zip → importShaderZip: the sections come back, and they are AWAKE on the bundled mesh', async () => {
    const r = await buildOk(blenderGlb(), 'blend.glb');
    const { nodes, edges } = r.project.graph;
    const out = outOf(nodes);
    const code = graphToCode(nodes, edges).code;
    const script = tslToShaderModule(inlineImageAssetsFromNodes(code, nodes), undefined, collectShaderProperties(nodes), materialPartsMirrorPlan(out));
    const embedded = embedProjectState(script, r.project);
    const bundle = buildExportBundle('blend', embedded, collectImageFiles(nodes), r.mesh);
    expect(bundle.kind).toBe('zip');
    const file = new File([bundle.bytes.slice().buffer as ArrayBuffer], bundle.fileName, { type: 'application/zip' });
    const result = await importShaderZip(file);
    expect(result).toBe('project');
    const s = useAppStore.getState();
    const restored = outOf(s.nodes);
    expect(outputMaterials(restored).slice(1).map((m) => m.gltfMaterialIndex)).toEqual([0, 1, 2]);
    expect(readModelSignature(restored.data)).toEqual(['Material.001', 'Material.002', 'Ķermenis']);
    expect((restored.data as { modelMeshes?: unknown }).modelMeshes).toEqual((out.data as { modelMeshes?: unknown }).modelMeshes);
    expect(s.previewMesh).not.toBeNull();
    expect(s.previewMesh!.name).toBe('blend.glb');
    expect(indexSectionsAwake(readModelSignature(restored.data), loadedModelOf(s.previewMesh))).toBe(true);
    expect(ls['fs:previewGeometry']).toBe('custom');
    expect(sanitizeOutputMaterialsReport(s.nodes).trimmed).toBe(0);
    // Every image node's payload survived the zip (one file per distinct image).
    expect(s.nodes.filter((n) => n.data.registryType === 'imageNode')).toHaveLength(3);
    expect(graphToCode(s.nodes, s.edges).code).toBe(code);
  });

  it('IndexedDB record → recordToMesh: the restored mesh recomputes its facts and the sections stay awake', async () => {
    const r = await buildOk(scanGlb(), 'scan.glb');
    const out = outOf(r.project.graph.nodes);
    const restored = recordToMesh(meshToRecord(r.mesh));
    expect(restored).not.toBeNull();
    expect(restored!.id).not.toBe(r.mesh.id);
    expect(restored!.gltf?.signature).toEqual(['Body', 'Base', 'Trim']);
    expect(indexSectionsAwake(readModelSignature(out.data), loadedModelOf(restored))).toBe(true);
  });

  it('the sections are DORMANT on a different model, and on an OBJ', async () => {
    const r = await buildOk(scanGlb(), 'scan.glb');
    const out = outOf(r.project.graph.nodes);
    const other = await buildOk(blenderGlb(), 'b.glb');
    expect(indexSectionsAwake(readModelSignature(out.data), loadedModelOf(other.mesh))).toBe(false);
    expect(indexSectionsAwake(readModelSignature(out.data), loadedModelOf({ kind: 'obj' }))).toBe(false);
  });
});
