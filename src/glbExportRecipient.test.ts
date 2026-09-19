/**
 * What a RECIPIENT of a single-GLB export gets, from a file this app really
 * wrote: `buildShaderExportChecked` over the REAL store and the REAL composer,
 * then the REAL r184 GLTFLoader and the REAL vendored loaders.
 *
 *  (a) any glTF viewer — the optimised textures replace the model's own, and
 *      `EXT_texture_webp` is USED, never REQUIRED, so a viewer without it
 *      still opens the file;
 *  (b) loader 0.8 — the parse stashes every `fs-asset:` key the module spells,
 *      under the opt-in literal `src: model`;
 *  (c) the FROZEN loader 0.6 — `src: model` is a PATH there: one shader-error
 *      and the model keeps its authored materials (no crash, no blank mesh);
 *  (d) the module inside carries the GLB usage header, so whoever opens the
 *      file in an editor is told how to run it and what the opt-in costs.
 *
 * `isolate: false`: the store is set per test, `localStorage` is stubbed
 * ABSENT (buildProjectState reads preview prefs), GLTFLoader's node globals
 * are stubbed per test, and everything is restored.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { useAppStore, cancelPendingGraphSave } from '@/store/useAppStore';
import { __setFallbackEncoderForTests } from './engine/exportSingleGlb';
import { buildShaderExportChecked, type GlbExportUi } from './engine/exportShader';
import { graphToCode } from './engine/graphToCode';
import { glbModuleHeaderLines } from './engine/glbUsage';
import { MODEL_SRC } from './engine/glbShaderContract';
import { readGlbFsExtras } from './utils/glbShaderExtras';
import { createPreviewMesh, type PreviewMesh } from '@/utils/previewMesh';
import { decodeDataUri, parseGlbContainer, PLACEHOLDER_PNG_DATA_URI } from '@/utils/glbContainer';
import { safeJsonReviver } from '@/utils/safeJson';
import { evalLoader, loaderAvailable, type FastShadersApi } from './shaderloaderHarness';
import { GLTF_NODE_GLOBALS, parseWith } from './gltfTestFixtures';
import { canonicalSrc, fakeWebp, makeEdge, makeNode, makeRealPng, repackBaseGlb } from '@/test-utils';
import type { AppEdge, AppNode } from '@/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const SIG = ['Body', 'Glass', 'Trim'];
const WEBP = fakeWebp(8, 8, false);
const SRC_W = canonicalSrc('image/webp', WEBP);
const FALLBACK = makeRealPng(8, 8, [9, 9, 9, 255]);

const NOOP_UI: GlbExportUi = {
  begin: () => {},
  progress: () => {},
  failed: async () => 'cancel',
  tooLarge: async () => 'cancel',
  ready: async () => true,
  end: () => {},
};

function mesh(): PreviewMesh {
  const r = createPreviewMesh('statue.glb', repackBaseGlb({ materials: SIG, textured: true }));
  if (!('mesh' in r)) throw new Error('mesh refused');
  return r.mesh;
}

function graph(): { nodes: AppNode[]; edges: AppEdge[] } {
  const out = makeNode('out', 'output');
  Object.assign(out.data as Record<string, unknown>, {
    materials: [{ gltfMaterialIndex: 0 }],
    modelSignature: { materials: SIG },
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

/** The file the EXPORT button would hand over, built once. */
let GLB: Uint8Array<ArrayBuffer>;

let decoded: Uint8Array[] = [];

beforeAll(async () => {
  vi.stubGlobal('localStorage', undefined);
  __setFallbackEncoderForTests(async () => ({ mime: 'image/png', bytes: FALLBACK }));
  const g = graph();
  cancelPendingGraphSave();
  useAppStore.setState({
    nodes: g.nodes,
    edges: g.edges,
    code: graphToCode(g.nodes, g.edges).code,
    drawings: [],
    shaderPalettes: [],
    shaderName: 'Golden',
    previewMesh: mesh(),
    exportAsGlb: true,
    exportIncludeMesh: true,
  });
  const out = await buildShaderExportChecked({
    preflight: async () => 'full',
    glb: NOOP_UI,
    delivery: 'write',
  });
  if (!out || out.kind !== 'glb') throw new Error('the export did not produce a .glb');
  GLB = out.bytes;
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
  });
  vi.unstubAllGlobals();
});

beforeEach(() => {
  decoded = [];
  vi.stubGlobal('self', GLTF_NODE_GLOBALS.self);
  vi.stubGlobal('ProgressEvent', GLTF_NODE_GLOBALS.ProgressEvent);
  vi.stubGlobal('createImageBitmap', async (blob: Blob) => {
    decoded.push(new Uint8Array(await blob.arrayBuffer()));
    return { width: 2, height: 2, close() {} };
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});
afterAll(() => {
  __setFallbackEncoderForTests(null);
  vi.unstubAllGlobals();
});

describe('(a) any glTF 2.0 viewer', () => {
  it('shows the model with the OPTIMISED textures, and never the stripped placeholder', async () => {
    const gltf = await new GLTFLoader().parseAsync(GLB.buffer as ArrayBuffer, '');
    const maps: Any[] = [];
    gltf.scene.traverse((o: Any) => {
      const m = o.material;
      if (m && !Array.isArray(m) && m.map) maps.push(m.map);
    });
    expect(maps.length).toBeGreaterThan(0);
    expect(decoded.length).toBeGreaterThan(0);
    const placeholder = decodeDataUri(PLACEHOLDER_PNG_DATA_URI, 'image', 4096);
    const placeholderBytes = placeholder.ok ? placeholder.bytes : null;
    expect(placeholderBytes).toBeTruthy();
    for (const bytes of decoded) {
      expect(bytes.length).toBeGreaterThan(0);
      expect(
        bytes.length === placeholderBytes!.length && bytes.every((v, i) => v === placeholderBytes![i]),
      ).toBe(false);
    }
    // The shader's own WebP really is what a WebP-capable viewer decodes.
    expect(decoded.some((b) => b.length === WEBP.length && b.every((v, i) => v === WEBP[i]))).toBe(true);
  });

  it('lists EXT_texture_webp as USED, never REQUIRED, so a viewer without it still opens the file', () => {
    const c = parseGlbContainer(GLB);
    if (!c.ok) throw new Error('container');
    const doc = JSON.parse(c.chunks.json, safeJsonReviver) as Record<string, string[]>;
    expect(doc.extensionsUsed ?? []).toContain('EXT_texture_webp');
    expect(doc.extensionsRequired ?? []).not.toContain('EXT_texture_webp');
  });
});

describe.skipIf(!loaderAvailable('0.8'))('(b) loader 0.8', () => {
  it('stashes every fs-asset key the module spells, under the opt-in `src: model`', async () => {
    const ev = evalLoader('0.8', { THREE, globals: { document: { querySelectorAll: () => [] } } });
    const FS = ev.FastShaders as FastShadersApi;
    expect(FS.MODEL_SRC).toBe(MODEL_SRC);
    const gltf = await parseWith([FS.gltfPlugin], GLB.buffer as ArrayBuffer);
    const stash = FS.embeddedAssets(gltf.scene) as Map<string, unknown>;
    const read = readGlbFsExtras(GLB);
    if (read.state !== 'ok') throw new Error('reader: ' + JSON.stringify(read));
    const keys = [...read.shader.assets.keys()].sort();
    expect(keys.length).toBeGreaterThan(0);
    expect([...stash.keys()].sort()).toEqual(keys);
  });
});

describe.skipIf(!loaderAvailable('0.6'))('(c) the frozen loader 0.6', () => {
  it('reads `src: model` as a path: one shader-error, and the authored materials stay', async () => {
    const errors: string[] = [];
    const ev = evalLoader('0.6', {
      THREE,
      error: (...a: unknown[]) => errors.push(a.map(String).join(' ')),
      globals: {
        // 0.6 fetches `./model`; a static host answers 404 (an SPA answers
        // with index.html, which then fails to import — the same catch).
        fetch: async (u: unknown) => ({ ok: false, status: 404, url: String(u) }),
      },
    });
    const def = ev.def as Any;
    if (!def) throw new Error('0.6 registered no shader component');

    const original = new THREE.MeshStandardMaterial({ name: 'authored' });
    const model: Any = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), original);
    const emitted: Array<[string, Any]> = [];
    const ctx = Object.create(def) as Any;
    ctx.el = {
      emit: (name: string, detail: unknown) => emitted.push([name, detail]),
      addEventListener() {},
      removeEventListener() {},
      components: { 'gltf-model': { model } },
      getObject3D: (k: string) => (k === 'mesh' ? model : null),
      sceneEl: {},
      isConnected: true,
    };
    ctx.data = { src: MODEL_SRC };
    ctx.init();
    ctx.storeOriginalMaterials(model);
    model.material = new THREE.MeshBasicMaterial({ name: 'replaced' });
    await ctx.applyTSLShader(model);

    expect(emitted.map(([n]) => n)).toEqual(['shader-error']);
    expect(emitted[0][1].src).toBe(MODEL_SRC);
    expect(String(emitted[0][1].message)).toContain('404');
    expect(errors).toHaveLength(1);
    // The model is back on what the file authored.
    expect(model.material.name).toBe('authored');
  });
});

describe('(d) the module inside the file', () => {
  it('opens with the GLB usage header: the snippet, the loader floor and the warning', () => {
    const read = readGlbFsExtras(GLB);
    if (read.state !== 'ok' || read.shader.moduleText === null) throw new Error('no module');
    const header = glbModuleHeaderLines('golden.glb').join('\n');
    expect(read.shader.moduleText).toContain(header);
    expect(read.shader.moduleText.indexOf(header)).toBeLessThan(600);
    expect(header).toContain(`src: ${MODEL_SRC}`);
  });
});
