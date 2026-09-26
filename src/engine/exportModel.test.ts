import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { useAppStore, cancelPendingGraphSave } from '@/store/useAppStore';
import { makeEdge, makeNode } from '@/test-utils';
import { readZip } from '@/utils/zipReader';
import type { PreviewMesh } from '@/utils/previewMesh';
import { graphToCode } from './graphToCode';
import { activeExportModel, activePreviewModel, documentExportModel, type ExportModelState, type PreviewShape } from './exportModel';
import { buildShaderBundle, buildShaderExportChecked, type GlbExportUi } from './exportShader';

/**
 * Which model an export carries (engine/exportModel.ts): EXPORT ships the
 * model the preview SHOWS — a built-in shape as an .obj when "Export model" is
 * ticked for it — while a document save keeps the old rule.
 */

const mesh = { name: 'rock.glb', kind: 'glb', bytes: new Uint8Array([1, 2, 3]) } as unknown as PreviewMesh;
const shape = (geometry: PreviewShape['geometry'], subdivision = 4): PreviewShape => ({ geometry, subdivision, marchWindow: 1 });
const state = (o: Partial<ExportModelState>): ExportModelState => ({
  previewMesh: null,
  previewShape: null,
  exportIncludeMesh: true,
  exportBuiltinModel: false,
  ...o,
});

describe('activePreviewModel', () => {
  it('is the shape on screen, or the dropped model while it is shown', () => {
    expect(activePreviewModel(shape('teapot'), mesh)).toEqual({ kind: 'builtin', shape: 'teapot' });
    expect(activePreviewModel(shape('custom'), mesh)).toEqual({ kind: 'dropped', mesh });
    expect(activePreviewModel(shape('marchSphere'), null)).toEqual({ kind: 'builtin', shape: 'marchSphere' });
    // 'custom' with the mesh gone shows nothing exportable.
    expect(activePreviewModel(shape('custom'), null)).toBeNull();
  });

  it('before the preview reports, a loaded model counts as shown (the old rule)', () => {
    expect(activePreviewModel(null, mesh)).toEqual({ kind: 'dropped', mesh });
    expect(activePreviewModel(null, null)).toBeNull();
  });
});

describe('activeExportModel (EXPORT) vs documentExportModel (a save)', () => {
  it('a built-in shape ships only when its row is ticked, as an .obj', () => {
    expect(activeExportModel(state({ previewShape: shape('sphere') }), false)).toBeNull();
    const m = activeExportModel(state({ previewShape: shape('sphere'), exportBuiltinModel: true }), false)!;
    expect(m.name).toBe('sphere.obj');
    expect(m.kind).toBe('obj');
    expect(new TextDecoder().decode(m.bytes)).toContain('# Sphere, radius 1, 4×4 segments');
  });

  it('a PARKED dropped model is not what EXPORT ships — but a save still carries it', () => {
    const parked = state({ previewMesh: mesh, previewShape: shape('cube') });
    expect(activeExportModel(parked, false)).toBeNull();
    expect(documentExportModel(parked)).toBe(mesh);
    expect(activeExportModel({ ...parked, exportBuiltinModel: true }, false)!.name).toBe('cube.obj');
  });

  it('the shown dropped model follows exportIncludeMesh, as before', () => {
    expect(activeExportModel(state({ previewMesh: mesh, previewShape: shape('custom') }), false)).toBe(mesh);
    expect(activeExportModel(state({ previewMesh: mesh, previewShape: shape('custom'), exportIncludeMesh: false }), false)).toBeNull();
  });

  it('a study session never ships a shape and keeps the document rule', () => {
    const s = state({ previewMesh: mesh, previewShape: shape('teapot'), exportBuiltinModel: true });
    expect(activeExportModel(s, true)).toBe(mesh);
    expect(activeExportModel({ ...s, previewMesh: null }, true)).toBeNull();
  });

  it('the bunny ships only once the preview has its text', () => {
    // bunnyTextNow() is null in this process: nothing to write, nothing shipped.
    expect(activeExportModel(state({ previewShape: shape('bunny'), exportBuiltinModel: true }), false)).toBeNull();
  });
});

/** The real store and composer: what the downloaded file holds. */
describe('EXPORT with a built-in shape (real store)', () => {
  const idle: GlbExportUi = {
    begin: () => {},
    progress: () => {},
    failed: async () => 'cancel',
    tooLarge: async () => 'cancel',
    ready: async () => true,
    end: () => {},
  };
  const run = (model?: 'shown') =>
    buildShaderExportChecked({ preflight: async () => 'cancel', glb: idle, delivery: 'write', ...(model ? { model } : {}) });

  beforeAll(() => {
    vi.stubGlobal('localStorage', undefined);
  });
  beforeEach(() => {
    cancelPendingGraphSave();
    const ns = [makeNode('f1', 'float', { value: 0.5 }), makeNode('out1', 'output')];
    const es = [makeEdge('f1', 'out', 'out1', 'roughness')];
    useAppStore.setState({
      nodes: ns,
      edges: es,
      code: graphToCode(ns, es).code,
      drawings: [],
      shaderPalettes: [],
      shaderName: 'Shape',
      previewMesh: null,
      previewShape: shape('plane', 2),
      exportIncludeMesh: true,
      exportBuiltinModel: true,
      exportAsGlb: false,
    });
  });
  afterAll(() => {
    cancelPendingGraphSave();
    useAppStore.setState({ nodes: [], edges: [], code: '', previewShape: null, exportBuiltinModel: false });
    vi.unstubAllGlobals();
  });

  it('ships the shown plane under models/ with its A-Frame pairing line', async () => {
    const out = (await run('shown'))!;
    expect(out.kind).toBe('zip');
    const entries = await readZip(out.bytes);
    const names = entries.map((e) => e.name);
    expect(names).toContain('models/plane.obj');
    const readme = new TextDecoder().decode(entries.find((e) => e.name === 'README.txt')!.data);
    expect(readme).toContain('<a-entity obj-model="obj: url(models/plane.obj)" shader="src: shape.js"');
  });

  it('a save (no model mode) is the unchanged bare .js, whatever the row says', async () => {
    const out = (await run())!;
    expect(out.kind).toBe('js');
    expect(out.bytes).toEqual(buildShaderBundle().bytes);
  });

  it('unticked, EXPORT is the bare .js too', async () => {
    useAppStore.setState({ exportBuiltinModel: false });
    expect((await run('shown'))!.kind).toBe('js');
  });
});
