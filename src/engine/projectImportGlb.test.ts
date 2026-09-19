/**
 * `importShaderGlb` (GLB Phase 7 Step 6): RESTORING the shader a FastShaders
 * single-GLB export stores inside the model, on the REAL store.
 *
 * What it pins: the project wins when its block parses (the module is never
 * parsed); refs resolve against the GLB's own images; a module-only file takes
 * the bare-script path; every refusal leaves the store untouched; ONE undo
 * entry and one `fs:graph-imported`; the preview mesh is the strip for the
 * restored index sections and carries no payload; and the zip import still
 * strips a payload GLB it finds in `models/`.
 *
 * `window` (an EventTarget) and `localStorage` are stubbed and restored; the
 * store is reset around every test (isolate: false).
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { importShaderGlb, importShaderZip } from './projectImport';
import { embedProjectState, type FastShadersProject } from './fastShadersProject';
import { useAppStore, cancelPendingGraphSave } from '@/store/useAppStore';
import { buildZip } from '@/utils/zipWriter';
import { readGlbFsExtras } from '@/utils/glbShaderExtras';
import { readGltfModel } from '@/utils/gltfReader';
import { imageRefFor } from '@/utils/imagePayloadRefs';
import { indexSectionsAwake, loadedModelOf, readModelSignature } from '@/utils/outputMaterials';
import { encodeDataUri } from '@/utils/glbContainer';
import { FS_FIXTURE_MODULE_MARKER, makeFastShadersGlb, makeNode, makeRealPng, type FsGlbFixture } from '@/test-utils';
import type { AppNode } from '@/types';

let ls: Record<string, string>;
let events: string[];
let savedName = '';

function reset() {
  cancelPendingGraphSave();
  useAppStore.setState({
    nodes: [],
    edges: [],
    past: [],
    future: [],
    code: '',
    previewMesh: null,
    previewMeshInventory: null,
    pendingLimitNotices: [],
    importNote: null,
    shaderName: 'before',
  });
}

beforeAll(() => {
  savedName = useAppStore.getState().shaderName;
});
beforeEach(() => {
  reset();
  ls = {};
  events = [];
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (Object.prototype.hasOwnProperty.call(ls, k) ? ls[k] : null),
    setItem: (k: string, v: string) => {
      ls[k] = String(v);
    },
    removeItem: (k: string) => {
      delete ls[k];
    },
  });
  const target = new EventTarget();
  vi.stubGlobal('window', target);
  target.addEventListener('fs:project-imported', () => events.push('project'));
  target.addEventListener('fs:graph-imported', () => events.push('graph'));
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

const PNG = makeRealPng(2, 2, [200, 10, 10, 255]);
const SRC = encodeDataUri('image/png', PNG);
const KEY = 'img1-0badf00d';

function imageNode(id: string, imageB64: string): AppNode {
  return makeNode(id, 'imageNode', { imageB64, width: 2, height: 2, fileName: 'red.png', colorSpace: 'color' });
}

function project(over: Partial<FastShadersProject> = {}): FastShadersProject {
  return {
    version: 1,
    shaderName: 'restored',
    graph: { nodes: [makeNode('o1', 'output')], edges: [] },
    preview: { lighting: 'studio' },
    ui: {},
    ...over,
  };
}

const MODULE =
  `import { vec3 } from 'three/tsl';\n// ${FS_FIXTURE_MODULE_MARKER}\nconst img = "fs-asset:${KEY}";\n` +
  'export default function () {\n  return { colorNode: vec3(1, 0, 0) };\n}\n';

function glb(p: FastShadersProject | string | null, o: FsGlbFixture = {}): Uint8Array<ArrayBuffer> {
  return makeFastShadersGlb({
    module: MODULE,
    project: p === null ? null : typeof p === 'string' ? p : embedProjectState('', p).trim(),
    assets: { [KEY]: { mime: 'image/png', bytes: PNG } },
    ...o,
  });
}

const noPayload = (bytes: Uint8Array) => {
  expect(readGlbFsExtras(bytes).state).toBe('none');
  expect(new TextDecoder().decode(bytes)).not.toContain(FS_FIXTURE_MODULE_MARKER);
  expect(new TextDecoder().decode(bytes)).not.toContain('FASTSHADERS_PROJECT_V1');
};

function indexOfBytes(hay: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

function snapshot() {
  const s = useAppStore.getState();
  return { nodes: s.nodes, edges: s.edges, past: s.past.length, mesh: s.previewMesh, name: s.shaderName, code: s.code };
}

describe('importShaderGlb — the project branch', () => {
  it('restores the graph: one undo entry, both events once, the model shown, no payload in the mesh', async () => {
    const before = useAppStore.getState().past.length;
    const r = await importShaderGlb('my shader.glb', glb(project()));
    expect(r).toEqual({ ok: true, imported: 'project', notes: [{ kind: 'glb-restored', fileName: 'my-shader.glb', imported: 'project' }] });
    const s = useAppStore.getState();
    expect(s.past.length).toBe(before + 1);
    expect(s.nodes.map((n) => n.id)).toEqual(['o1']);
    expect(s.shaderName).toBe('restored');
    expect(events.filter((e) => e === 'graph')).toHaveLength(1);
    expect(ls['fs:previewGeometry']).toBe('custom');
    expect(ls['fs:previewLighting']).toBe('studio');
    expect(s.previewMesh?.kind).toBe('glb');
    noPayload(s.previewMesh!.bytes);
    // The asset-only image went with the payload: the copy is smaller.
    expect(s.previewMesh!.bytes.length).toBeLessThan(glb(project()).length);
  });

  it('runs the restore-path sanitizers on the block', async () => {
    const edge = { id: 'e1', source: 'i1', sourceHandle: 'out', target: 'o1', targetHandle: 'color', data: { waypoints: [null] } };
    const r = await importShaderGlb(
      'm.glb',
      glb(project({ graph: { nodes: [imageNode('i1', SRC), makeNode('o1', 'output')], edges: [edge as never] } })),
    );
    expect(r.ok).toBe(true);
    const e = useAppStore.getState().edges.find((x) => x.id === 'e1')!;
    expect((e.data as { waypoints?: unknown } | undefined)?.waypoints).toBeUndefined();
  });

  it('image refs resolve against the GLB\'s own images; an inline payload also restores', async () => {
    const p = project({ graph: { nodes: [imageNode('i1', ''), imageNode('i2', SRC), makeNode('o1', 'output')], edges: [] } });
    (p as { imageRefs?: Record<string, string> }).imageRefs = { i1: imageRefFor(SRC) };
    const r = await importShaderGlb('m.glb', glb(p));
    expect(r.ok).toBe(true);
    const s = useAppStore.getState();
    const b64 = (id: string) => (s.nodes.find((n) => n.id === id)!.data.values as { imageB64: string }).imageB64;
    expect(b64('i1')).toBe(SRC);
    expect(b64('i2')).toBe(SRC);
    expect(s.pendingLimitNotices).toEqual([]);
  });

  it('a ref whose image the file refused is reported, and the others still restore', async () => {
    const p = project({ graph: { nodes: [imageNode('i1', ''), imageNode('i2', SRC), makeNode('o1', 'output')], edges: [] } });
    (p as { imageRefs?: Record<string, string> }).imageRefs = { i1: imageRefFor(SRC) };
    // The PNG asset carries a WebP mimeType: the reader refuses it, so no literal.
    const r = await importShaderGlb('m.glb', glb(p, { assets: { [KEY]: { mime: 'image/webp', bytes: PNG } } }));
    expect(r.ok).toBe(true);
    const s = useAppStore.getState();
    expect((s.nodes.find((n) => n.id === 'i2')!.data.values as { imageB64: string }).imageB64).toBe(SRC);
    expect((s.nodes.find((n) => n.id === 'i1')!.data.values as { imageB64: string }).imageB64).toBe('');
    expect(s.pendingLimitNotices.some((n) => n.kind === 'images-missing')).toBe(true);
  });

  it('the DISAGREEMENT rule: a module edited after export is ignored, the project wins', async () => {
    const r = await importShaderGlb('m.glb', glb(project(), { fnv1a: '00000000' }));
    expect(r.ok && r.imported).toBe('project');
    expect(useAppStore.getState().code).not.toContain(FS_FIXTURE_MODULE_MARKER);
    expect(useAppStore.getState().nodes.map((n) => n.id)).toEqual(['o1']);
  });

  it('the preview mesh is the strip for the restored index sections, and they are awake', async () => {
    const out = makeNode('o1', 'output');
    const d = out.data as Record<string, unknown>;
    d.materials = [{ gltfMaterialIndex: 0 }];
    d.modelSignature = { materials: ['Body', 'Glass'] };
    const r = await importShaderGlb('m.glb', glb(project({ graph: { nodes: [out], edges: [] } }), { textureFromAsset: KEY }));
    expect(r.ok).toBe(true);
    const s = useAppStore.getState();
    const mesh = s.previewMesh!;
    noPayload(mesh.bytes);
    const model = readGltfModel(mesh.bytes, 'glb');
    expect(model.ok).toBe(true);
    if (!model.ok) return;
    expect(model.model.signature.materials).toEqual(['Body', 'Glass']);
    // The built material's texture is gone, and the PNG no longer rides in the copy.
    expect(model.model.materials[0].slots).toEqual([]);
    expect(indexOfBytes(mesh.bytes, PNG)).toBe(-1);
    expect(indexOfBytes(glb(project(), { textureFromAsset: KEY }), PNG)).toBeGreaterThan(-1);
    const restored = s.nodes.find((n) => n.id === 'o1')!;
    expect(indexSectionsAwake(readModelSignature(restored.data), loadedModelOf(mesh))).toBe(true);
  });
});

describe('importShaderGlb — the module branch and the refusals', () => {
  it('module only: the bare-script path', async () => {
    const r = await importShaderGlb('m.glb', glb(null));
    expect(r.ok && r.imported).toBe('script');
    expect(events).toContain('graph');
    // The module (not a project) became the code; its inlining is the reader's (glbShaderExtras.test.ts).
    const code = useAppStore.getState().code;
    expect(code).toContain('vec3(1, 0, 0)');
    expect(code).not.toContain('fs-asset:');
    noPayload(useAppStore.getState().previewMesh!.bytes);
  });

  it('an unparseable project with a module falls back to the module; without one, nothing changes', async () => {
    const bad = '/* FASTSHADERS_PROJECT_V1\n{ not json\nEND_FASTSHADERS_PROJECT */';
    const r1 = await importShaderGlb('m.glb', glb(bad));
    expect(r1.ok && r1.imported).toBe('script');

    reset();
    const before = snapshot();
    const r2 = await importShaderGlb('m.glb', glb(bad, { module: null }));
    expect(r2).toEqual({ ok: false, reason: 'damaged' });
    expect(snapshot()).toEqual(before);
  });

  it('no stored shader, and a damaged one, leave the store untouched', async () => {
    const before = snapshot();
    expect(await importShaderGlb('m.glb', makeFastShadersGlb({ omitExtras: true, omitSceneExtras: true }))).toEqual({
      ok: false,
      reason: 'no-shader',
    });
    expect(await importShaderGlb('m.glb', glb(project(), { moduleView: { byteStride: 4 } }))).toEqual({
      ok: false,
      reason: 'damaged',
    });
    expect(snapshot()).toEqual(before);
    expect(events).toEqual([]);
  });

  it('a model the preview cannot take is refused before the store is touched', async () => {
    const before = snapshot();
    // A name `detectMeshKind` does not know. Compression is no longer a mesh
    // refusal — the bundled decoders take Draco, meshopt and KTX2 alike — so
    // the refusal here is the container's own.
    const r = await importShaderGlb('m.bin', glb(project(), { textureFromAsset: KEY }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('mesh-refused');
    expect(snapshot()).toEqual(before);
  });

  it('a KTX2-required model is RESTORED now, not refused (the transcoder is bundled)', async () => {
    const r = await importShaderGlb(
      'm.glb',
      glb(project(), {
        textureFromAsset: KEY,
        json: (doc) => {
          doc.extensionsUsed = ['KHR_texture_basisu'];
          doc.extensionsRequired = ['KHR_texture_basisu'];
          (doc.textures as Array<Record<string, unknown>>)[0].extensions = { KHR_texture_basisu: { source: 0 } };
        },
      }),
    );
    expect(r.ok).toBe(true);
    expect(useAppStore.getState().previewMesh?.decoders?.ktx2).toBe(true);
  });

  it('an aborted restore changes nothing, on either branch', async () => {
    const ac = new AbortController();
    ac.abort();
    const before = snapshot();
    expect(await importShaderGlb('m.glb', glb(null), { signal: ac.signal })).toEqual({ ok: false, reason: 'aborted' });
    expect(await importShaderGlb('m.glb', glb(project()), { signal: ac.signal })).toEqual({ ok: false, reason: 'aborted' });
    expect(snapshot()).toEqual(before);
  });
});

describe('importShaderZip — a payload GLB in models/ (regression)', () => {
  it('the zip\'s .js wins, and the model entry is stored without its payload', async () => {
    const script = 'import { positionGeometry } from "three/tsl";\nexport default function () {\n  return positionGeometry;\n}\n';
    const file = new File(
      [
        buildZip([
          { name: 'shader.js', data: new TextEncoder().encode(script) },
          { name: 'models/fs.glb', data: glb(project()) },
        ]) as BlobPart,
      ],
      'export.zip',
    );
    expect(await importShaderZip(file)).toBe('script');
    noPayload(useAppStore.getState().previewMesh!.bytes);
    expect(useAppStore.getState().shaderName).not.toBe('restored');
  });
});
