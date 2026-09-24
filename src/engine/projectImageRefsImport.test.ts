/**
 * The `imageRefs` READER through the real import path (importShaderText /
 * importShaderZip → applyProjectToStore), with the real sanitizers after it.
 *
 * Store-mutating: every test starts from the same reset state, and the state
 * this file touches is restored afterwards (`isolate: false`). No stubbed
 * globals: in the node env `localStorage` and `window` are absent, and every
 * access on this path is guarded.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { useAppStore, cancelPendingGraphSave } from '@/store/useAppStore';
import { makeNode } from '@/test-utils';
import { getNodeValues, type AppNode } from '@/types';
import { buildZip } from '@/utils/zipWriter';
import { imageRefFor } from '@/utils/imagePayloadRefs';
import { embedProjectState, type FastShadersProject } from './fastShadersProject';
import { referenceImagesInModule } from './projectImageRefs';
import { importShaderText, importShaderZip } from './projectImport';
import { projectDocs } from '../projectDocs';

const enc = new TextEncoder();
const P1 = `data:image/png;base64,${btoa('one')}`;
const P2 = `data:image/webp;base64,${btoa('two')}`;
// Over the 600K soft per-image cap, still a valid payload.
const BIG = `data:image/png;base64,${'A'.repeat(600_000)}`;

const img = (id: string, values: Record<string, string | number> = {}): AppNode =>
  makeNode(id, 'imageNode', { width: 1, height: 1, fileName: `${id}.png`, colorSpace: 'color', ...values });

function project(nodes: AppNode[], extra: Record<string, unknown> = {}): FastShadersProject {
  return { version: 1, shaderName: 'refs', graph: { nodes, edges: [] }, preview: {}, ui: {}, ...extra } as FastShadersProject;
}

const moduleWith = (...lits: string[]) =>
  `export default function () {}\n${lits.map((l, i) => `const s${i} = "${l}";`).join('\n')}\n`;

const storedSrc = (n: AppNode) => {
  const p = getNodeValues(n).imageB64;
  return typeof p === 'string' && p.length > 0 ? p : null;
};

/** A ref-only block built by the real writer against `writeModule`, embedded
 *  into `shipModule` (the same text unless a literal is being deleted). */
function refBlock(nodes: AppNode[], writeModule: string, shipModule = writeModule): string {
  return embedProjectState(shipModule, referenceImagesInModule(project(nodes), writeModule, storedSrc));
}

const storeImage = (id: string) => {
  const n = useAppStore.getState().nodes.find((x) => x.id === id);
  return n ? String(getNodeValues(n).imageB64 ?? '') : undefined;
};
const notices = () => useAppStore.getState().pendingLimitNotices.map((n) => ({ kind: n.kind, detail: n.detail }));

let savedName = '';
beforeAll(() => {
  savedName = useAppStore.getState().shaderName;
});
function reset() {
  cancelPendingGraphSave();
  useAppStore.setState({ nodes: [], edges: [], pendingLimitNotices: [], ignoreImageLimits: false, importNote: null });
}
beforeEach(reset);
afterEach(reset);
afterAll(() => {
  cancelPendingGraphSave();
  useAppStore.setState({ shaderName: savedName });
});

describe('importShaderText reads both block shapes', () => {
  it('an OLD block (imageB64 present, no imageRefs) is unchanged and raises nothing', () => {
    const text = embedProjectState(moduleWith(P1), project([img('a', { imageB64: P1 }), img('b', { imageB64: P1 })]));
    expect(importShaderText(text)).toBe('project');
    expect(storeImage('a')).toBe(P1);
    expect(storeImage('b')).toBe(P1);
    expect(notices()).toEqual([]);
  });

  it('a ref-only block recovers every payload from its own module', () => {
    const nodes = [img('a', { imageB64: P1 }), img('b', { imageB64: P1 }), img('c', { imageB64: P2 })];
    const text = refBlock(nodes, moduleWith(P1, P2));
    expect(text).not.toContain(`"imageB64": "${P1}"`);
    expect(importShaderText(text)).toBe('project');
    expect(storeImage('a')).toBe(P1);
    expect(storeImage('b')).toBe(P1);
    expect(storeImage('c')).toBe(P2);
    expect(notices()).toEqual([]);
    // The store never sees a ref of either kind.
    for (const n of useAppStore.getState().nodes) {
      const v = getNodeValues(n) as Record<string, unknown>;
      expect(v.imageRef).toBeUndefined();
    }
  });

  it('a ref whose module literal was deleted → one images-missing notice; the node stays without pixels', () => {
    const nodes = [img('a', { imageB64: P1 }), img('c', { imageB64: P2 })];
    importShaderText(refBlock(nodes, moduleWith(P1, P2), moduleWith(P2)));
    expect(notices()).toEqual([{ kind: 'images-missing', detail: '1' }]);
    expect(storeImage('a')).toBe('');
    expect(storeImage('c')).toBe(P2);
  });

  it('a recovered payload still passes the soft cap: stripped with images-stripped, not images-missing', () => {
    importShaderText(refBlock([img('a', { imageB64: BIG })], moduleWith(BIG)));
    expect(notices()).toEqual([{ kind: 'images-stripped', detail: '1' }]);
    expect(storeImage('a')).toBe('');
  });

  it('with Ignore limits on, the same recovered payload is kept', () => {
    useAppStore.setState({ ignoreImageLimits: true });
    importShaderText(refBlock([img('a', { imageB64: BIG })], moduleWith(BIG)));
    expect(notices()).toEqual([]);
    expect(storeImage('a')).toBe(BIG);
  });

  it('a node carrying BOTH an unresolved top-level ref and a dangling imageRef is reported once', () => {
    const node = img('a', { imageRef: imageRefFor(P2) });
    importShaderText(embedProjectState(moduleWith(), project([node], { imageRefs: { a: imageRefFor(P1) } })));
    expect(notices()).toEqual([{ kind: 'images-missing', detail: '1' }]);
    expect(storeImage('a')).toBe('');
  });

  it('an in-node imageRef still fills a node whose top-level ref missed: no notice', () => {
    const nodes = [img('a', { imageB64: P1 }), img('b', { imageRef: imageRefFor(P1) })];
    importShaderText(embedProjectState(moduleWith(), project(nodes, { imageRefs: { b: imageRefFor(P2) } })));
    expect(notices()).toEqual([]);
    expect(storeImage('b')).toBe(P1);
  });
});

describe('importShaderZip', () => {
  it('recovers a ref-only block from the .js inside the archive', async () => {
    const nodes = [img('a', { imageB64: P1 }), img('b', { imageB64: P1 })];
    const zip = buildZip([
      { name: 's.js', data: enc.encode(refBlock(nodes, moduleWith(P1))) },
      { name: 'images/a.png', data: enc.encode('one') },
    ]);
    const file = new File([zip as BlobPart], 's.zip', { type: 'application/zip' });
    expect(await importShaderZip(file)).toBe('project');
    expect(storeImage('a')).toBe(P1);
    expect(storeImage('b')).toBe(P1);
    expect(notices()).toEqual([]);
  });
});

describe('CLAUDE.md', () => {
  // 'a ref-only block recovers every payload from its own module' above is the
  // fact: with a block present, this reader reads the MODULE's data: literals.
  it('does not claim the module goes unread while a project block is present', () => {
    const doc = projectDocs();
    expect(doc).not.toContain('no FastShaders reader or Podest ever reads them');
    expect(doc).toContain('pixel RESTORE reads the per-node block copies');
    expect(doc).toContain('which is all Podest/A-Frame and the top-level imageRefs reader need');
  });
});
