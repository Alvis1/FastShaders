/**
 * The EXPORT flow when the Format is one `.glb` (engine/exportShader.ts's
 * `buildShaderExportChecked`), over the REAL store and the REAL composer: the
 * three user surfaces hand it a pre-flight ask and the GLB dialog's UI, and it
 * comes back with either a `.glb`, the `.js`/`.zip` bundle, or null.
 *
 * `isolate: false`: the store is shared with the worker, so each test sets
 * what it reads, `localStorage` is stubbed ABSENT (buildProjectState reads
 * preview prefs from it) and every stub and the fallback-encoder seam are
 * restored. The PNG/JPEG encoder is DOM-only, hence the seam.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { useAppStore, cancelPendingGraphSave } from '@/store/useAppStore';
import { __setFallbackEncoderForTests } from './exportSingleGlb';
import {
  announceExportDelivered,
  buildShaderExportChecked,
  type GlbExportUi,
  type GlbTooLargeChoice,
} from './exportShader';
import { graphToCode } from './graphToCode';
import { readFsGlbPointers } from './glbShaderContract';
import { parseGlbContainer } from '@/utils/glbContainer';
import { createPreviewMesh, type PreviewMesh } from '@/utils/previewMesh';
import { safeJsonReviver } from '@/utils/safeJson';
import { canonicalSrc, fakeWebp, makeEdge, makeNode, makeRealPng, repackBaseGlb } from '@/test-utils';
import type { AppEdge, AppNode } from '@/types';

const SIG = ['Body', 'Glass', 'Trim'];
const SRC_W = canonicalSrc('image/webp', fakeWebp(8, 8, false));
const FALLBACK = makeRealPng(8, 8, [9, 9, 9, 255]);

function mesh(name = 'statue.glb'): PreviewMesh {
  const r = createPreviewMesh(name, repackBaseGlb({ materials: SIG, textured: true }));
  if (!('mesh' in r)) throw new Error('mesh refused');
  return r.mesh;
}

function objMesh(): PreviewMesh {
  const r = createPreviewMesh('bunny.obj', new TextEncoder().encode('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n'));
  if (!('mesh' in r)) throw new Error('mesh refused');
  return r.mesh;
}

/** An import-shaped graph: one index section fed by a Texture node. */
function graph(signature: string[] = SIG): { nodes: AppNode[]; edges: AppEdge[] } {
  const out = makeNode('out', 'output');
  Object.assign(out.data as Record<string, unknown>, {
    materials: [{ gltfMaterialIndex: 0 }],
    modelSignature: { materials: signature },
  });
  const img = makeNode('T', 'imageNode', {
    imageB64: SRC_W,
    width: 8,
    height: 8,
    fileName: 'T.webp',
    orientation: 'gltf',
  });
  return { nodes: [out, img], edges: [makeEdge('T', 'out', 'out', 'm1:color')] };
}

function setStore(g: { nodes: AppNode[]; edges: AppEdge[] }, previewMesh: PreviewMesh | null, asGlb = true) {
  cancelPendingGraphSave();
  useAppStore.setState({
    nodes: g.nodes,
    edges: g.edges,
    code: graphToCode(g.nodes, g.edges).code,
    drawings: [],
    shaderPalettes: [],
    shaderName: 'Golden',
    previewMesh,
    exportAsGlb: asGlb,
    exportIncludeMesh: true,
    importNote: null,
  });
}

/** A recording stand-in for the modal (components/Modals/GlbExportModal.tsx). */
function stubUi(answers: {
  tooLarge?: GlbTooLargeChoice;
  failed?: 'as-bundle' | 'cancel';
  ready?: boolean;
  abortOnBegin?: boolean;
} = {}) {
  const calls: string[] = [];
  const failedMessages: string[] = [];
  const ui: GlbExportUi = {
    begin(fileName, cancel) {
      calls.push(`begin:${fileName}`);
      if (answers.abortOnBegin) cancel();
    },
    progress(done, total) {
      calls.push(`progress:${done}/${total}`);
    },
    async failed(message, canBundle) {
      calls.push(`failed:${canBundle}`);
      failedMessages.push(message);
      return answers.failed ?? 'cancel';
    },
    async tooLarge() {
      calls.push('tooLarge');
      return answers.tooLarge ?? 'cancel';
    },
    async ready(fileName, sizeBytes) {
      calls.push(`ready:${fileName}:${sizeBytes > 0}`);
      return answers.ready ?? true;
    },
    end() {
      calls.push('end');
    },
  };
  return { ui, calls, failedMessages };
}

const preflight = async () => 'full' as const;

beforeAll(() => {
  vi.stubGlobal('localStorage', undefined);
});
beforeEach(() => {
  __setFallbackEncoderForTests(async () => ({ mime: 'image/png', bytes: FALLBACK }));
});
afterEach(() => {
  // The navigator stub some tests install; localStorage is re-stubbed below.
  vi.unstubAllGlobals();
  vi.stubGlobal('localStorage', undefined);
});
afterAll(() => {
  __setFallbackEncoderForTests(null);
  cancelPendingGraphSave();
  useAppStore.setState({
    nodes: [],
    edges: [],
    drawings: [],
    shaderPalettes: [],
    previewMesh: null,
    code: '',
    exportAsGlb: false,
    importNote: null,
  });
  vi.unstubAllGlobals();
});

describe('buildShaderExportChecked → one .glb', () => {
  it('the Work-folder write gets the file, and never the fresh-click step', async () => {
    setStore(graph(), mesh());
    const { ui, calls } = stubUi();
    const out = await buildShaderExportChecked({ preflight, glb: ui, delivery: 'write' });
    if (!out || out.kind !== 'glb') throw new Error('expected a .glb, got ' + JSON.stringify(out?.kind));
    expect(out.fileName).toBe('golden.glb');
    expect(out.mime).toBe('model/gltf-binary');
    expect(out.bytes.length).toBeGreaterThan(0);
    // The reader re-reads it, and it carries the Phase 7 extras.
    const c = parseGlbContainer(out.bytes);
    if (!c.ok) throw new Error('container');
    const doc = JSON.parse(c.chunks.json, safeJsonReviver) as Record<string, unknown>;
    const ptr = readFsGlbPointers(doc, {
      images: (doc.images as unknown[]).length,
      bufferViews: (doc.bufferViews as unknown[]).length,
    });
    expect(ptr?.module).toBeTruthy();
    expect(calls.filter((c2) => c2.startsWith('ready:'))).toEqual([]);
    expect(calls[calls.length - 1]).toBe('end');
  });

  it('a download asks for a fresh click when the activation has lapsed, and false means nothing', async () => {
    setStore(graph(), mesh());
    // node's navigator has no userActivation, which counts as lapsed.
    const yes = stubUi({ ready: true });
    const a = await buildShaderExportChecked({ preflight, glb: yes.ui, delivery: 'download' });
    expect(a?.kind).toBe('glb');
    expect(yes.calls.some((c) => c.startsWith('ready:golden.glb:true'))).toBe(true);

    const no = stubUi({ ready: false });
    expect(await buildShaderExportChecked({ preflight, glb: no.ui, delivery: 'download' })).toBeNull();
  });

  it('a live activation downloads without the extra click', async () => {
    setStore(graph(), mesh());
    vi.stubGlobal('navigator', { userActivation: { isActive: true } });
    const { ui, calls } = stubUi();
    const out = await buildShaderExportChecked({ preflight, glb: ui, delivery: 'download' });
    expect(out?.kind).toBe('glb');
    expect(calls.filter((c) => c.startsWith('ready:'))).toEqual([]);
  });

  it('reports what the file cost other viewers, once it was delivered', async () => {
    setStore(graph(), mesh());
    // No fallback encoder answer: every WebP texture ships alone.
    __setFallbackEncoderForTests(async () => null);
    const { ui } = stubUi();
    const out = await buildShaderExportChecked({ preflight, glb: ui, delivery: 'write' });
    if (!out || out.kind !== 'glb') throw new Error('expected a .glb');
    expect(out.report.map((l) => l.kind)).toContain('glb-export-fallback-missing');
    announceExportDelivered(out);
    const note = useAppStore.getState().importNote;
    expect(note?.lines.map((l) => l.kind)).toEqual(out.report.map((l) => l.kind));
  });
});

describe('when it is not a .glb', () => {
  it('an OBJ keeps the bundle path, and the dialog is never begun', async () => {
    setStore(graph(), objMesh());
    const { ui, calls } = stubUi();
    const out = await buildShaderExportChecked({ preflight, glb: ui, delivery: 'download' });
    expect(out?.kind === 'js' || out?.kind === 'zip').toBe(true);
    expect(calls).toEqual([]);
  });

  it('the flag alone is not enough: no model at all is the bundle too', async () => {
    setStore(graph(), null);
    const { ui, calls } = stubUi();
    const out = await buildShaderExportChecked({ preflight, glb: ui, delivery: 'download' });
    expect(out?.kind === 'js' || out?.kind === 'zip').toBe(true);
    expect(calls).toEqual([]);
  });

  it('the flag off exports the bundle even with a packable model loaded', async () => {
    setStore(graph(), mesh(), false);
    const { ui, calls } = stubUi();
    const out = await buildShaderExportChecked({ preflight, glb: ui, delivery: 'download' });
    expect(out?.kind === 'js' || out?.kind === 'zip').toBe(true);
    expect(calls).toEqual([]);
  });
});

describe('refusals', () => {
  it('a model that is not the one the sections were made for offers the .zip instead', async () => {
    setStore(graph(['Other']), mesh());
    const cancel = stubUi({ failed: 'cancel' });
    expect(await buildShaderExportChecked({ preflight, glb: cancel.ui, delivery: 'download' })).toBeNull();
    expect(cancel.calls).toContain('failed:true');
    expect(cancel.failedMessages[0]).toContain('material sections');

    setStore(graph(['Other']), mesh());
    const asBundle = stubUi({ failed: 'as-bundle' });
    const out = await buildShaderExportChecked({ preflight, glb: asBundle.ui, delivery: 'download' });
    expect(out?.kind === 'js' || out?.kind === 'zip').toBe(true);
    // The alternative was offered because THAT bundle reopens.
    expect(asBundle.calls).toContain('failed:true');
  });

  it('cancelling the build answers null, with no further question', async () => {
    setStore(graph(), mesh());
    const { ui, calls } = stubUi({ abortOnBegin: true });
    expect(await buildShaderExportChecked({ preflight, glb: ui, delivery: 'download' })).toBeNull();
    expect(calls.filter((c) => c !== 'end' && !c.startsWith('begin:'))).toEqual([]);
  });
});
