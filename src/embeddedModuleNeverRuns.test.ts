/**
 * A module found INSIDE a model never runs in a document the app itself runs:
 * the editor's sandboxed preview, its XR popup, podest's stage and podest's
 * VR popup. A FastShaders GLB is a `.js` in a model's clothing, and loader
 * 0.8's `shader="src: model"` (and FastShaders.loadFromGltf/applyFromGltf) is
 * the opt-in that would run it. Three independent layers keep those documents
 * from ever doing so, and this ONE suite pins them (integration §3 C16 merged
 * the loader package's surface pins with the re-import package's never-runs
 * suite):
 *
 *   L1  the bytes cannot carry one: every preview copy (createPreviewMesh —
 *       the drop, the zip import, the IndexedDB restore, the build and the
 *       restore) is payload-free, and the XR popup's blob is those bytes;
 *   L2  the opt-in is never spelled: no such document's source carries the
 *       keyword, and every `shader` attribute write is a blob URL;
 *   L3  the loader's one-way latch: every such document closes it first in
 *       its URL-modifier script, and the REAL vendored loader then refuses —
 *       while the same loader, unlatched, runs the module on the opt-in and
 *       only there (so the latch and the opt-in are the switches, nothing
 *       else).
 *
 * The keyword regex stays scoped to those three source files: the GLB-mode
 * module header (engine/glbUsage.ts) DOES spell the opt-in, on purpose, for
 * recipients.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MODEL_MODULE_LATCH, tslToPreviewHTML } from '@/engine/tslToPreviewHTML';
import { LOADER_FILE } from '@/engine/tslToShaderModule';
import { REPO, evalLoader, loaderAvailable, type FastShadersApi } from './shaderloaderHarness';
import { GLTF_NODE_GLOBALS } from './gltfTestFixtures';
import { FS_FIXTURE_MODULE_MARKER, makeFastShadersGlb, makeFastShadersGlbEscapedKey } from './test-utils';
import { createPreviewMesh } from '@/utils/previewMesh';
import { recordToMesh } from '@/utils/previewMeshCache';
import { readGlbFsExtras } from '@/utils/glbShaderExtras';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const V = '0.8';
const read = (rel: string) => readFileSync(path.join(REPO, rel), 'utf8');
const OPT_IN_RE = /src\s*:\s*['"]?model\b/i;
const RUN_SURFACES = ['src/engine/tslToPreviewHTML.ts', 'src/components/Preview/ShaderPreview.tsx', 'public/podest.html'];

const TSL = "import { Fn, vec3 } from 'three/tsl';\nconst shader = Fn(() => {\n  return vec3(1, 0, 0);\n});\nexport default shader;\n";

beforeEach(() => {
  for (const [k, v] of Object.entries(GLTF_NODE_GLOBALS)) vi.stubGlobal(k, v);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('L1 — a preview copy never carries a module', () => {
  it('the drop and the IndexedDB restore keep no payload, and the XR document built over them runs none', () => {
    const src = makeFastShadersGlb();
    expect(readGlbFsExtras(src).state).toBe('ok');
    const dropped = createPreviewMesh('fs.glb', src);
    const restored = recordToMesh({ name: 'fs.glb', bytes: src.slice().buffer });
    for (const mesh of ['mesh' in dropped ? dropped.mesh : null, restored]) {
      expect(mesh).not.toBeNull();
      expect(readGlbFsExtras(mesh!.bytes).state).toBe('none');
      expect(new TextDecoder().decode(mesh!.bytes)).not.toContain(FS_FIXTURE_MODULE_MARKER);
    }
    const html = tslToPreviewHTML(TSL, { geometry: 'custom', customModel: { kind: 'glb', id: 1, url: 'blob:x' }, xr: true });
    expect(html).not.toContain(FS_FIXTURE_MODULE_MARKER);
    expect(html).not.toMatch(OPT_IN_RE);
  });

  it('an ESCAPED extras key does not walk the module past the drop either', () => {
    // `"fastshaders"` in both places the key appears: JSON.parse yields
    // the same document, so a text gate testing the literal spelling alone
    // hands these bytes back unread — and the IndexedDB mirror, the XR blob
    // (the app's REAL origin) and every zip `models/` entry would carry a
    // stranger's module.
    const src = makeFastShadersGlbEscapedKey();
    expect(new TextDecoder().decode(src)).not.toContain('"fastshaders"');
    expect(readGlbFsExtras(src).state).toBe('ok');
    const dropped = createPreviewMesh('evil.glb', src);
    const restored = recordToMesh({ name: 'evil.glb', bytes: src.slice().buffer });
    for (const mesh of ['mesh' in dropped ? dropped.mesh : null, restored]) {
      expect(mesh).not.toBeNull();
      expect(new TextDecoder().decode(mesh!.bytes)).not.toContain(FS_FIXTURE_MODULE_MARKER);
      expect(readGlbFsExtras(mesh!.bytes).state).toBe('none');
    }
  });
});

describe('L2 — the opt-in is never spelled where the app runs a shader', () => {
  it.each(RUN_SURFACES)('%s carries no `src: model`', (rel) => {
    expect(read(rel)).not.toMatch(OPT_IN_RE);
  });

  it.each(RUN_SURFACES)('%s writes the shader attribute only as a blob URL', (rel) => {
    const text = read(rel);
    const writes = [...text.matchAll(/setAttribute\(\s*\\?["']shader\\?["']([^)]{0,80})/g)];
    for (const w of writes) {
      expect(w[1], `${rel}: ${w[0]}`).toMatch(/^\s*,\s*(\\?["']src: \\?["']\s*\+|\\?["']src\\?["']\s*,\s*[A-Za-z_$])/);
    }
  });

  it('those attribute writes exist (the pin above is not vacuous)', () => {
    const count = RUN_SURFACES.map((rel) => [...read(rel).matchAll(/setAttribute\(\s*\\?["']shader\\?["']/g)].length);
    expect(count.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(4);
  });

  it('the XR popup\'s model blob is minted from the preview mesh bytes, and the preview never asks for a GLB module header', () => {
    const preview = read('src/components/Preview/ShaderPreview.tsx');
    const at = preview.indexOf('const handleOpenVR = useCallback(');
    expect(at).toBeGreaterThan(-1);
    const body = preview.slice(at, preview.indexOf('}, [previewCode', at));
    expect(body).toContain('new Blob([previewMesh.bytes]');
    expect(read('src/engine/tslToPreviewHTML.ts')).not.toContain('glbFile');
  });

  it('no app module calls loadFromGltf or applyFromGltf', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\.ts$/.test(name) && name !== 'shaderloaderHarness.ts') {
          if (/\b(loadFromGltf|applyFromGltf)\s*\(/.test(readFileSync(full, 'utf8'))) offenders.push(full);
        }
      }
    };
    walk(path.join(REPO, 'src'));
    expect(offenders).toEqual([]);
    expect(read('public/podest.html')).not.toMatch(/\b(loadFromGltf|applyFromGltf)\s*\(/);
  });
});

describe('L3 — every run document closes the loader\'s latch first', () => {
  it('the sandboxed pane and the XR popup: after the loader tag, before the scene', () => {
    for (const xr of [false, true]) {
      for (const geometry of ['sphere', 'custom'] as const) {
        const html = tslToPreviewHTML(TSL, {
          geometry,
          xr,
          ...(geometry === 'custom' ? { customModel: { kind: 'glb' as const, id: 1, url: xr ? 'blob:x' : undefined } } : {}),
        });
        const label = `xr=${xr} ${geometry}`;
        const loaderTag = html.indexOf(`js/${LOADER_FILE}`);
        const latch = html.indexOf(`<script>${MODEL_MODULE_LATCH}try{if(window.THREE&&THREE.DefaultLoadingManager`);
        expect(loaderTag, label).toBeGreaterThan(-1);
        expect(latch, label).toBeGreaterThan(loaderTag);
        expect(html.indexOf('<a-scene'), label).toBeGreaterThan(latch);
        expect(html.split('FastShaders.disableModelModules()').length - 1, label).toBe(1);
        expect(html, label).not.toMatch(OPT_IN_RE);
      }
    }
  });

  it('podest: exactly two latches, each inside a URL-modifier script', () => {
    const page = read('public/podest.html');
    const lines = page.split('\n').filter((l) => l.includes('FastShaders.disableModelModules()'));
    expect(lines).toHaveLength(2);
    for (const l of lines) {
      expect(l).toContain('setURLModifier');
      expect(l).toContain(MODEL_MODULE_LATCH);
    }
    // One per document: the VR popup (inside its closure) and the stage.
    expect(lines[0]).toContain("L.push('<script>(function(){" + MODEL_MODULE_LATCH + 'var origin=');
    expect(lines[1]).toContain("L.push('<script>" + MODEL_MODULE_LATCH + 'try{if(window.THREE');
  });
});

describe.skipIf(!loaderAvailable(V))('L3 — the REAL vendored loader: the latch and the opt-in are the only switches', () => {
  function fresh() {
    const ev = evalLoader(V, {
      THREE,
      globals: { Blob, TextDecoder, document: { querySelectorAll: () => [] } },
    });
    const FS = ev.FastShaders as FastShadersApi;
    const sources: string[] = [];
    FS.importSource = (source: string) => {
      sources.push(source);
      return Promise.resolve({ default: () => ({ colorNode: THREE.TSL.color(1, 0, 0) }) });
    };
    FS.fetch = () =>
      Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve("export default () => ({});\n") });
    return { ev, FS, sources };
  }

  async function modelEntity(f: ReturnType<typeof fresh>, src: string) {
    const loader = new GLTFLoader();
    loader.register(f.FS.gltfPlugin);
    const gltf = await loader.parseAsync(makeFastShadersGlb().buffer, '');
    const emitted: Array<[string, Any]> = [];
    const ctx = Object.create(f.ev.def as object) as Any;
    ctx.el = {
      emit: (n: string, d: unknown) => emitted.push([n, d]),
      addEventListener() {},
      removeEventListener() {},
      components: { 'gltf-model': { model: gltf.scene } },
      getObject3D: (k: string) => (k === 'mesh' ? gltf.scene : null),
      getDOMAttribute: () => `src: ${src}`,
      sceneEl: {},
      isConnected: true,
    };
    ctx.data = { src };
    ctx.extendSchema = () => {};
    ctx.init();
    ctx.storeOriginalMaterials(gltf.scene);
    await ctx.applyTSLShader(gltf.scene);
    return { gltf, emitted };
  }

  it('unlatched: a dropped .js runs and the model\'s module does not; the opt-in runs the model\'s module', async () => {
    const f = fresh();
    const dropped = await modelEntity(f, './dropped.js');
    expect(dropped.emitted.map(([n]) => n)).toEqual(['shader-applied']);
    expect(f.sources).toHaveLength(1);
    expect(f.sources[0]).not.toContain(FS_FIXTURE_MODULE_MARKER);
    expect(f.FS.embeddedAssets(dropped.gltf.scene)).toBeNull(); // the fixture carries no images

    const opted = await modelEntity(f, 'model');
    expect(opted.emitted.map(([n]) => n)).toEqual(['shader-applied']);
    expect(f.sources).toHaveLength(2);
    expect(f.sources[1]).toContain(FS_FIXTURE_MODULE_MARKER);
  });

  it('the latch script, as a run document emits it, turns the opt-in into a refusal', async () => {
    const f = fresh();
    const html = tslToPreviewHTML(TSL, { geometry: 'sphere' });
    const start = html.indexOf(`<script>${MODEL_MODULE_LATCH}`);
    const script = html.slice(start + '<script>'.length, html.indexOf('</script>', start));
    // The document's `window` is its global; this sandbox has no THREE, so the
    // URL-modifier half of the same script is a no-op here.
    const sandbox = f.ev.sandbox as Record<string, unknown>;
    sandbox.window = sandbox;
    delete sandbox.THREE;
    vm.runInContext(script, sandbox);
    const r = await modelEntity(f, 'model');
    expect(r.emitted).toEqual([['shader-error', { src: 'model', message: 'src: model is turned off on this page.' }]]);
    await expect(f.FS.loadFromGltf(r.gltf)).rejects.toMatchObject({ message: 'src: model is turned off on this page.' });
    expect(f.sources).toEqual([]);
  });
});
