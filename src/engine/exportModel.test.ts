import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { useAppStore, cancelPendingGraphSave } from '@/store/useAppStore';
import { makeEdge, makeNode } from '@/test-utils';
import { readZip } from '@/utils/zipReader';
import type { PreviewMesh } from '@/utils/previewMesh';
import { graphToCode } from './graphToCode';
import {
  activeExportModel,
  activePreviewModel,
  documentExportModel,
  exportAlternate,
  exportFormatFor,
  exportModelChoice,
  exportModelFile,
  glbCandidate,
  type ExportModelState,
  type PreviewShape,
} from './exportModel';
import { buildShaderBundle, buildShaderExportChecked, type GlbExportUi } from './exportShader';

/**
 * WHAT an export carries (engine/exportModel.ts), CONTEXTUALLY: EXPORT writes
 * what the preview SHOWS — a dropped model the `.glb` (or the `.zip` with it,
 * when one `.glb` cannot hold it), a built-in shape the shader alone — the
 * popover's smaller button is the other way for one export, and a document
 * save keeps the old rule.
 */

const mesh = { name: 'rock.glb', kind: 'glb', bytes: new Uint8Array([1, 2, 3]), gltf: {} } as unknown as PreviewMesh;
const objMesh = { name: 'rock.obj', kind: 'obj', bytes: new Uint8Array([1]) } as unknown as PreviewMesh;
const shape = (geometry: PreviewShape['geometry'], subdivision = 4): PreviewShape => ({ geometry, subdivision, marchWindow: 1 });
const state = (o: Partial<ExportModelState>): ExportModelState => ({
  previewMesh: null,
  previewShape: null,
  exportIncludeMesh: true,
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

describe('exportFormatFor: EXPORT follows the preview, a save follows the document', () => {
  it('a packable model on screen is the .glb; a built-in shape is the shader file', () => {
    expect(exportFormatFor(state({ previewMesh: mesh, previewShape: shape('custom') }), false, 'primary')).toBe('glb');
    expect(exportFormatFor(state({ previewMesh: mesh }), false, 'primary')).toBe('glb');
    expect(exportFormatFor(state({ previewShape: shape('sphere') }), false, 'primary')).toBe('bundle');
    expect(exportFormatFor(state({}), false, 'primary')).toBe('bundle');
  });

  it('a model one .glb cannot hold stays the bundle', () => {
    expect(exportFormatFor(state({ previewMesh: objMesh, previewShape: shape('custom') }), false, 'primary')).toBe('bundle');
  });

  it('a PARKED model is the shader file for EXPORT, but a save still packs it', () => {
    const parked = state({ previewMesh: mesh, previewShape: shape('cube') });
    expect(exportFormatFor(parked, false, 'primary')).toBe('bundle');
    expect(exportFormatFor(parked, false, 'document')).toBe('glb');
    expect(exportFormatFor({ ...parked, exportIncludeMesh: false }, false, 'document')).toBe('bundle');
  });

  it('the smaller button and a study session are never a .glb', () => {
    const shown = state({ previewMesh: mesh, previewShape: shape('custom') });
    expect(exportFormatFor(shown, false, 'alternate')).toBe('bundle');
    for (const surface of ['primary', 'alternate', 'document'] as const) {
      expect(exportFormatFor(shown, true, surface), surface).toBe('bundle');
    }
  });

  it('glbCandidate names the model each surface would pack', () => {
    const shown = state({ previewMesh: mesh, previewShape: shape('custom') });
    expect(glbCandidate(shown, false, 'primary')).toBe(mesh);
    expect(glbCandidate(shown, false, 'alternate')).toBeNull();
    expect(glbCandidate(state({ previewMesh: mesh, previewShape: shape('plane') }), false, 'document')).toBe(mesh);
  });
});

describe('activeExportModel (EXPORT) vs documentExportModel (a save)', () => {
  it('a built-in shape: EXPORT ships the shader alone, "Export with model" its .obj', () => {
    const s = state({ previewShape: shape('sphere') });
    expect(activeExportModel(s, false)).toBeNull();
    const m = activeExportModel(s, false, 'alternate')!;
    expect(m.name).toBe('sphere.obj');
    expect(m.kind).toBe('obj');
    expect(new TextDecoder().decode(m.bytes)).toContain('# Sphere, radius 1, 4×4 segments');
  });

  it('a PARKED dropped model is not what EXPORT ships — but a save still carries it', () => {
    const parked = state({ previewMesh: mesh, previewShape: shape('cube') });
    expect(activeExportModel(parked, false)).toBeNull();
    expect(documentExportModel(parked)).toBe(mesh);
    expect(activeExportModel(parked, false, 'alternate')!.name).toBe('cube.obj');
  });

  it('the shown dropped model rides both ways out', () => {
    const shown = state({ previewMesh: mesh, previewShape: shape('custom') });
    expect(activeExportModel(shown, false)).toBe(mesh);
    expect(activeExportModel(shown, false, 'alternate')).toBe(mesh);
  });

  it('a study session never ships a shape and keeps the document rule', () => {
    const s = state({ previewMesh: mesh, previewShape: shape('teapot') });
    expect(activeExportModel(s, true)).toBe(mesh);
    expect(activeExportModel(s, true, 'alternate')).toBe(mesh);
    expect(activeExportModel({ ...s, previewMesh: null }, true, 'alternate')).toBeNull();
    expect(activeExportModel({ ...s, exportIncludeMesh: false }, true)).toBeNull();
  });

  it('the bunny ships only once the preview has its text', () => {
    // bunnyTextNow() is null in this process: nothing to write, nothing shipped.
    expect(activeExportModel(state({ previewShape: shape('bunny') }), false, 'alternate')).toBeNull();
    // …and the choice agrees, so no surface names a file the zip lacks.
    expect(exportModelChoice(state({ previewShape: shape('bunny') }), false, 'alternate')).toBeNull();
  });
});

describe('exportAlternate: what the popover\'s smaller button offers', () => {
  it('"Export with model" beside a built-in shape, "Export .zip" beside a packable model', () => {
    expect(exportAlternate(state({ previewShape: shape('teapot') }), false)).toBe('with-model');
    expect(exportAlternate(state({ previewMesh: mesh, previewShape: shape('custom') }), false)).toBe('zip');
    // A parked model: the shape on screen decides.
    expect(exportAlternate(state({ previewMesh: mesh, previewShape: shape('plane') }), false)).toBe('with-model');
  });

  it('no button when there is no other way out', () => {
    // An OBJ already exports as the .zip with it.
    expect(exportAlternate(state({ previewMesh: objMesh, previewShape: shape('custom') }), false)).toBeNull();
    // The bunny before its text: no .obj to write.
    expect(exportAlternate(state({ previewShape: shape('bunny') }), false)).toBeNull();
    expect(exportAlternate(state({}), false)).toBeNull();
    // A study session: EXPORT opens the finish dialog.
    expect(exportAlternate(state({ previewShape: shape('teapot') }), true)).toBeNull();
  });
});

/**
 * The decision WITHOUT the build (the A-Frame tab names its models/ entry from
 * it): it must agree with what `activeExportModel` actually writes, for every
 * row of the state space the suites above walk, on both buttons.
 */
describe('exportModelChoice + exportModelFile name what activeExportModel writes', () => {
  const cases: [string, ExportModelState, boolean][] = [
    ['nothing', state({}), false],
    ['shown dropped', state({ previewMesh: mesh, previewShape: shape('custom') }), false],
    ['shown OBJ', state({ previewMesh: objMesh, previewShape: shape('custom') }), false],
    ['dropped, not yet reported', state({ previewMesh: mesh }), false],
    ['parked dropped', state({ previewMesh: mesh, previewShape: shape('cube') }), false],
    ['teapot', state({ previewShape: shape('teapot') }), false],
    ['march window', state({ previewShape: shape('marchSphere') }), false],
    ['study, mesh loaded', state({ previewMesh: mesh, previewShape: shape('teapot') }), true],
    ['study, mesh excluded', state({ previewMesh: mesh, exportIncludeMesh: false }), true],
    ['study, no mesh', state({ previewShape: shape('teapot') }), true],
  ];
  for (const [label, s, evalMode] of cases) {
    for (const surface of ['primary', 'alternate'] as const) {
      it(`${label} (${surface})`, () => {
        const built = activeExportModel(s, evalMode, surface);
        const choice = exportModelChoice(s, evalMode, surface);
        expect(choice === null, label).toBe(built === null);
        if (choice && built) expect(exportModelFile(choice)).toEqual({ name: built.name, kind: built.kind });
      });
    }
  }
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
  const run = (model?: 'shown', variant?: 'alternate') =>
    buildShaderExportChecked({
      preflight: async () => 'cancel',
      glb: idle,
      delivery: 'write',
      ...(model ? { model } : {}),
      ...(variant ? { variant } : {}),
    });

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
    });
  });
  afterAll(() => {
    cancelPendingGraphSave();
    useAppStore.setState({ nodes: [], edges: [], code: '', previewShape: null });
    vi.unstubAllGlobals();
  });

  it('"Export with model" ships the shown plane under models/ with its A-Frame pairing line', async () => {
    const out = (await run('shown', 'alternate'))!;
    expect(out.kind).toBe('zip');
    const entries = await readZip(out.bytes);
    const names = entries.map((e) => e.name);
    expect(names).toContain('models/plane.obj');
    const readme = new TextDecoder().decode(entries.find((e) => e.name === 'README.txt')!.data);
    expect(readme).toContain('<a-entity obj-model="obj: url(models/plane.obj)" shader="src: shape.js"');
  });

  it('a save (no model mode) is the unchanged bare .js', async () => {
    const out = (await run())!;
    expect(out.kind).toBe('js');
    expect(out.bytes).toEqual(buildShaderBundle().bytes);
  });

  it('EXPORT itself is the bare .js beside a built-in shape', async () => {
    const out = (await run('shown'))!;
    expect(out.kind).toBe('js');
    expect(out.bytes).toEqual(buildShaderBundle().bytes);
  });
});
