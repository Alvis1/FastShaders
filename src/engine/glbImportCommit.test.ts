/**
 * `commitGlbImport` (Phase 5 Step 8): the ONE commit path for an import-built
 * shader — the texture-stripped mesh first, then `applyProjectToStore` with
 * the geometry forced to 'custom': ONE undo entry, the restore-path
 * sanitizers, `fs:project-imported` then `fs:graph-imported`, each once.
 *
 * Real store; `window` and `localStorage` stubbed and restored; the store
 * reset around every test (isolate: false).
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { commitGlbImport } from './projectImport';
import { useAppStore, cancelPendingGraphSave } from '@/store/useAppStore';
import { createPreviewMesh, type PreviewMesh } from '@/utils/previewMesh';
import { makeNode } from '@/test-utils';
import { MAX_IMAGE_ENCODED_CHARS } from '@/utils/imageNode';
import type { FastShadersProject } from './fastShadersProject';
import { blenderGlb } from './gltfImportFixtures';

let ls: Record<string, string>;
let savedName = '';
let events: string[];

function mesh(): PreviewMesh {
  const r = createPreviewMesh('m.glb', blenderGlb());
  if ('error' in r) throw new Error(r.error);
  return r.mesh;
}

function project(over: Partial<FastShadersProject> = {}): FastShadersProject {
  return {
    version: 1,
    shaderName: 'built',
    graph: { nodes: [makeNode('o1', 'output')], edges: [] },
    preview: {},
    ui: {},
    ...over,
  };
}

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

beforeAll(() => {
  savedName = useAppStore.getState().shaderName;
});
beforeEach(() => {
  reset();
  ls = {};
  events = [];
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (Object.prototype.hasOwnProperty.call(ls, k) ? ls[k] : null),
    setItem: (k: string, v: string) => { ls[k] = String(v); },
    removeItem: (k: string) => { delete ls[k]; },
  });
  const target = new EventTarget();
  vi.stubGlobal('window', Object.assign(target, {
    // A listener on fs:project-imported already sees the mesh in the store.
    __seen: null as PreviewMesh | null,
  }));
  target.addEventListener('fs:project-imported', () => {
    events.push('project');
    (target as unknown as { __seen: PreviewMesh | null }).__seen = useAppStore.getState().previewMesh;
  });
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

describe('commitGlbImport', () => {
  it('one undo entry, the mesh set, the geometry forced to custom, both events once in order', () => {
    const m = mesh();
    const before = useAppStore.getState().past.length;
    commitGlbImport(project({ preview: { geometry: 'sphere', lighting: 'studio' } }), m);
    const s = useAppStore.getState();
    expect(s.past.length).toBe(before + 1);
    expect(s.previewMesh).toBe(m);
    expect(ls['fs:previewGeometry']).toBe('custom');
    expect(ls['fs:previewLighting']).toBe('studio');
    expect(events).toEqual(['project', 'graph']);
    expect((globalThis.window as unknown as { __seen: PreviewMesh | null }).__seen).toBe(m);
    expect(s.shaderName).toBe('built');
    expect(s.nodes.map((n) => n.id)).toEqual(['o1']);
  });

  it('forces custom even when the project names no geometry at all', () => {
    commitGlbImport(project({ preview: undefined as unknown as FastShadersProject['preview'] }), mesh());
    expect(ls['fs:previewGeometry']).toBe('custom');
  });

  it('a payload over the soft cap is still stripped, with the images-stripped notice (the backstop)', () => {
    const img = makeNode('i1', 'imageNode', {
      imageB64: 'data:image/png;base64,' + 'A'.repeat(MAX_IMAGE_ENCODED_CHARS + 400),
      width: 4,
      height: 4,
      fileName: 'x.png',
      colorSpace: 'color',
    });
    commitGlbImport(project({ graph: { nodes: [img, makeNode('o1', 'output')], edges: [] } }), mesh());
    const s = useAppStore.getState();
    expect(s.pendingLimitNotices.some((n) => n.kind === 'images-stripped')).toBe(true);
    const restored = s.nodes.find((n) => n.id === 'i1')!;
    expect((restored.data.values as { imageB64?: string }).imageB64).toBe('');
  });
});

describe('source pins', () => {
  const src = readFileSync(resolve(__dirname, 'projectImport.ts'), 'utf8');
  const body = src.slice(src.indexOf('export function commitGlbImport('));
  const fn = body.slice(0, body.indexOf('\n}\n') + 3);

  it('sets the mesh BEFORE applying the project, and announces nothing of its own', () => {
    expect(fn.indexOf('setPreviewMesh(')).toBeGreaterThan(0);
    expect(fn.indexOf('setPreviewMesh(')).toBeLessThan(fn.indexOf('applyProjectToStore('));
    expect(fn).not.toContain('announceGraphImport(');
    expect(fn).toContain("geometry: 'custom'");
  });
});
