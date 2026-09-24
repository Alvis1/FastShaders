/**
 * The two localStorage slots the store owns — `fs:graph` and `fs:savedGroups` —
 * on the WRITE side (both through `toAsciiStorageJson`, both naming their slot
 * when the write fails) and on the LOAD side (N8: images the hard caps strip
 * are counted, so App.tsx can report them).
 *
 * `isolate: false` shares this store, the module-level quota flags and the
 * globals with later files: every test starts from a fresh stubbed storage and
 * an empty notice queue, and the file restores the stub, the clock and the
 * persistence switch when it is done.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  useAppStore,
  setGraphPersistence,
  cancelPendingGraphSave,
  loadGraph,
  loadSavedGroups,
  loadSavedGroupsReport,
  persistSavedGroups,
  reportImagesStrippedOnLoad,
  type SavedGroup,
} from './useAppStore';
import { HISTORY_IDLE, makeNode } from '@/test-utils';
import { getNodeValues, type AppNode } from '@/types';
import { toAsciiStorageJson } from '@/utils/asciiStorage';
import { HARD_MAX_IMAGE_ENCODED_CHARS } from '@/utils/imageNode';
import { safeJsonReviver } from '@/utils/safeJson';
import { imageRefFor } from '@/utils/imagePayloadRefs';

const ASCII_ONLY = /^[\x00-\x7f]*$/;
const LV_NAME = 'Z' + String.fromCharCode(0x0101) + 'le ' + String.fromCodePoint(0x1f600);

let store: Record<string, string>;
let failing: Set<string>;

beforeEach(() => {
  cancelPendingGraphSave();
  vi.useFakeTimers();
  store = {};
  failing = new Set();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k: string, v: string) => {
      if (failing.has(k)) throw new Error('QuotaExceededError');
      store[k] = String(v);
    },
    removeItem: (k: string) => { delete store[k]; },
  });
  setGraphPersistence(true);
  useAppStore.setState({ nodes: [], edges: [], pendingLimitNotices: [], ...HISTORY_IDLE });
  cancelPendingGraphSave();
});

afterAll(() => {
  cancelPendingGraphSave();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setGraphPersistence(true);
  useAppStore.setState({ pendingLimitNotices: [] });
});

function labelled(id: string, label: string): AppNode {
  const n = makeNode(id, 'sin');
  (n.data as { label: string }).label = label;
  return n;
}

function imageNode(id: string, imageB64: string): unknown {
  return {
    id,
    type: 'shader',
    position: { x: 0, y: 0 },
    data: { registryType: 'imageNode', label: 'Image', cost: 10, values: { imageB64, width: 1, height: 1 } },
  };
}

const notices = () => useAppStore.getState().pendingLimitNotices;

function autosave(nodes: AppNode[]) {
  useAppStore.getState().setNodes(nodes, 'graph');
  vi.advanceTimersByTime(1000);
}

describe('fs:graph is written as pure ASCII', () => {
  it('escapes a Latvian + emoji label, and loadGraph reads it back unchanged', () => {
    autosave([labelled('lv1', LV_NAME)]);
    const raw = store['fs:graph'];
    expect(raw).toBeDefined();
    expect(raw).toMatch(ASCII_ONLY);
    expect(raw).toContain('\\u0101');
    const g = loadGraph();
    expect(g!.nodes.find((n) => n.id === 'lv1')!.data.label).toBe(LV_NAME);
  });

  it('the reader is unchanged: a plain stringify and the ASCII form load identically', () => {
    const payload = { nodes: [labelled('r1', LV_NAME)], edges: [] };
    store['fs:graph'] = JSON.stringify(payload);
    const plain = loadGraph();
    store['fs:graph'] = toAsciiStorageJson(payload);
    const ascii = loadGraph();
    expect(plain).not.toBeNull();
    expect(ascii).toEqual(plain);
  });
});

describe('fs:savedGroups is written as pure ASCII', () => {
  it('round-trips a Latvian + emoji group name, through the store AND through a plain parse', () => {
    const group: SavedGroup = { id: 'g', name: LV_NAME, color: '#6366f1', nodes: [], edges: [] };
    persistSavedGroups([group]);
    const raw = store['fs:savedGroups'];
    expect(raw).toMatch(ASCII_ONLY);
    expect(loadSavedGroups()[0].name).toBe(LV_NAME);
    // ShaderCarousel's bench-registry.js reads this key with a bare parse.
    expect((JSON.parse(raw) as SavedGroup[])[0].name).toBe(LV_NAME);
  });
});

describe('a failed write names its SLOT, never an English detail string (N7)', () => {
  it('fs:graph → one storage-quota notice with slot "graph"', () => {
    // A successful write first: it resets the module-level once-per-streak
    // flag a previous file in this worker may have left set.
    autosave([makeNode('q1', 'sin')]);
    expect(store['fs:graph']).toBeDefined();
    failing.add('fs:graph');
    autosave([makeNode('q2', 'sin')]);
    const quota = notices().filter((n) => n.kind === 'storage-quota');
    expect(quota).toHaveLength(1);
    expect(quota[0].slot).toBe('graph');
    expect(quota[0].detail).toBeUndefined();
    // Leave the flag reset for whoever runs next.
    failing.clear();
    autosave([makeNode('q3', 'sin')]);
  });

  it('fs:savedGroups → one storage-quota notice with slot "savedGroups"', () => {
    persistSavedGroups([]);
    failing.add('fs:savedGroups');
    persistSavedGroups([{ id: 'g', name: 'g', color: '#6366f1', nodes: [], edges: [] }]);
    const quota = notices().filter((n) => n.kind === 'storage-quota');
    expect(quota).toHaveLength(1);
    expect(quota[0].slot).toBe('savedGroups');
    expect(quota[0].detail).toBeUndefined();
    failing.clear();
    persistSavedGroups([]);
  });
});

describe('loads COUNT the images the hard caps strip (N8)', () => {
  it('loadGraph reports strippedImages, keeps the valid payload, and returns only its own keys', () => {
    store['fs:graph'] = JSON.stringify({
      nodes: [
        imageNode('html', 'data:text/html;base64,AAAA'), // fails the whitelist
        imageNode('huge', 'data:image/png;base64,' + 'A'.repeat(HARD_MAX_IMAGE_ENCODED_CHARS)), // over 8M
        imageNode('ok', 'data:image/png;base64,AAAA'),
      ],
      edges: [],
      strippedImages: 99, // a stored field must not fake the count
      evil: 'x', // nor ride out of the load
    });
    const g = loadGraph()!;
    expect(g.strippedImages).toBe(2);
    expect(Object.keys(g).sort()).toEqual(['drawings', 'edges', 'nodes', 'outputSectionsTrimmed', 'palettes', 'strippedImages']);
    const b64 = (id: string) => getNodeValues(g.nodes.find((n) => n.id === id)!).imageB64;
    expect(b64('ok')).toBe('data:image/png;base64,AAAA');
    expect(b64('html')).toBe('');
    expect(b64('huge')).toBe('');
  });

  it('a clean graph reports 0', () => {
    store['fs:graph'] = JSON.stringify({ nodes: [imageNode('ok', 'data:image/png;base64,AAAA')], edges: [] });
    expect(loadGraph()!.strippedImages).toBe(0);
  });

  it('loadSavedGroupsReport counts per group, and loadSavedGroups still returns the same groups', () => {
    store['fs:savedGroups'] = JSON.stringify([
      { id: 'g1', name: 'a', color: '#6366f1', nodes: [imageNode('i1', 'data:text/html;base64,AAAA')], edges: [] },
      { id: 'g2', name: 'b', color: '#6366f1', nodes: [imageNode('i2', 'data:image/png;base64,AAAA')], edges: [] },
    ]);
    const report = loadSavedGroupsReport();
    expect(report.strippedImages).toBe(1);
    expect(report.groups.map((g) => g.id)).toEqual(['g1', 'g2']);
    expect(loadSavedGroups()).toEqual(report.groups);
  });

  it('an empty or corrupt library reports nothing', () => {
    expect(loadSavedGroupsReport()).toEqual({ groups: [], strippedImages: 0, outputSectionsTrimmed: 0 });
    store['fs:savedGroups'] = '{not json';
    expect(loadSavedGroupsReport()).toEqual({ groups: [], strippedImages: 0, outputSectionsTrimmed: 0 });
  });
});

describe('reportImagesStrippedOnLoad', () => {
  it('stays silent for 0 and names slot + count otherwise', () => {
    reportImagesStrippedOnLoad('graph', 0);
    reportImagesStrippedOnLoad('graph', Number.NaN);
    expect(notices()).toHaveLength(0);
    reportImagesStrippedOnLoad('savedGroups', 3);
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toMatchObject({ kind: 'images-stripped-on-load', slot: 'savedGroups', detail: '3' });
  });
});

describe('image payload storage: bytes', () => {
  // The exact bytes both writers produce for image documents, spelled out as
  // explicit objects (never compared against the writer's own output). Taken
  // BEFORE the Phase 2 payload de-duplication: p1-p3 and p5 must hold through
  // every later change, and p4 is the ONE expectation that change is allowed to
  // rewrite (its second node becomes `imageB64: ''` + an `imageRef`), so the
  // diff documents exactly what moved.
  const P = 'data:image/png;base64,AAAA';
  const Q = 'data:image/png;base64,BBBB';
  const written = (id: string, values: Record<string, unknown>) => ({
    id,
    type: 'shader',
    position: { x: 0, y: 0 },
    data: { registryType: 'imageNode', label: 'Image', cost: 10, values },
  });

  it('(p1) one image is written inline', () => {
    autosave([imageNode('a', P) as AppNode]);
    expect(store['fs:graph']).toBe(JSON.stringify({
      nodes: [written('a', { imageB64: P, width: 1, height: 1 })],
      edges: [],
    }));
  });

  it('(p2) two DIFFERENT images are both written inline', () => {
    autosave([imageNode('a', P) as AppNode, imageNode('b', Q) as AppNode]);
    expect(store['fs:graph']).toBe(JSON.stringify({
      nodes: [
        written('a', { imageB64: P, width: 1, height: 1 }),
        written('b', { imageB64: Q, width: 1, height: 1 }),
      ],
      edges: [],
    }));
  });

  it('(p3) a library of two groups holding different images is a bare array, both inline', () => {
    persistSavedGroups([
      { id: 'g1', name: 'a', color: '#6366f1', nodes: [imageNode('i1', P) as AppNode], edges: [] },
      { id: 'g2', name: 'b', color: '#6366f1', nodes: [imageNode('i2', Q) as AppNode], edges: [] },
    ]);
    expect(store['fs:savedGroups']).toBe(JSON.stringify([
      { id: 'g1', name: 'a', color: '#6366f1', nodes: [written('i1', { imageB64: P, width: 1, height: 1 })], edges: [] },
      { id: 'g2', name: 'b', color: '#6366f1', nodes: [written('i2', { imageB64: Q, width: 1, height: 1 })], edges: [] },
    ]));
  });

  it('(p4) two nodes holding the SAME image: the second is written as a ref to the first', () => {
    autosave([imageNode('a', P) as AppNode, imageNode('b', P) as AppNode]);
    expect(store['fs:graph']).toBe(JSON.stringify({
      nodes: [
        written('a', { imageB64: P, width: 1, height: 1 }),
        written('b', { imageB64: '', width: 1, height: 1, imageRef: 'img1-0ce4918c-q' }),
      ],
      edges: [],
    }));
  });

  it('(p5) what an OLD reader relies on: slot shapes, a string imageB64, no foreign value keys', () => {
    const nodes = [imageNode('a', P), imageNode('b', P), imageNode('c', Q)] as AppNode[];
    autosave(nodes);
    persistSavedGroups([
      { id: 'g1', name: 'a', color: '#6366f1', nodes: [imageNode('i1', P) as AppNode], edges: [] },
      { id: 'g2', name: 'b', color: '#6366f1', nodes: [imageNode('i2', P) as AppNode], edges: [] },
    ]);
    const graph = JSON.parse(store['fs:graph'], safeJsonReviver) as Record<string, unknown>;
    const allowed = new Set(['nodes', 'edges', 'drawings', 'palettes']);
    for (const k of Object.keys(graph)) expect(allowed.has(k)).toBe(true);
    // ShaderCarousel's bench-registry.js reads the library as a bare array.
    const groups = JSON.parse(store['fs:savedGroups'], safeJsonReviver) as unknown;
    expect(Array.isArray(groups)).toBe(true);
    const original = new Set(['imageB64', 'width', 'height', 'imageRef']);
    const writtenNodes = [
      ...(graph.nodes as AppNode[]),
      ...(groups as SavedGroup[]).flatMap((g) => g.nodes),
    ];
    expect(writtenNodes).toHaveLength(5);
    for (const n of writtenNodes) {
      const values = n.data.values as Record<string, unknown>;
      expect(typeof values.imageB64).toBe('string');
      for (const k of Object.keys(values)) expect(original.has(k)).toBe(true);
    }
  });
});

describe('source pins', () => {
  const storeSrc = readFileSync(resolve(__dirname, 'useAppStore.ts'), 'utf8');
  const appSrc = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8');
  const count = (s: string, needle: string) => s.split(needle).length - 1;

  it('both store writers go through toAsciiStorageJson, once each', () => {
    expect(count(storeSrc, 'setItem(STORAGE_KEY, toAsciiStorageJson(payload))')).toBe(1);
    expect(count(storeSrc, 'setItem(SAVED_GROUPS_KEY, toAsciiStorageJson(libraryPayloadsForStorage(groups)))')).toBe(1);
    expect(storeSrc).not.toContain('setItem(STORAGE_KEY, JSON.stringify');
    expect(storeSrc).not.toContain('setItem(SAVED_GROUPS_KEY, JSON.stringify');
  });

  it('no other app file writes either key by its literal name', () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        if (statSync(p).isDirectory()) { walk(p); continue; }
        if (!/\.tsx?$/.test(p) || /\.test\.tsx?$/.test(p)) continue;
        if (/setItem\(\s*['"`]fs:(graph|savedGroups)['"`]/.test(readFileSync(p, 'utf8'))) hits.push(p);
      }
    };
    walk(resolve(__dirname, '..'));
    expect(hits).toEqual([]);
  });

  it('App.tsx reports both slots ABOVE the remembered-viewport early return, and writes a repaired library back', () => {
    expect(appSrc).toContain('loadSavedGroupsReport()');
    expect(appSrc).toContain(
      'if (groupsReport.strippedImages > 0 || groupsReport.outputSectionsTrimmed > 0) persistSavedGroups(groupsReport.groups);',
    );
    const graphReport = appSrc.indexOf("reportImagesStrippedOnLoad('graph'");
    const groupsReport = appSrc.indexOf("reportImagesStrippedOnLoad('savedGroups',");
    const earlyReturn = appSrc.indexOf('if (saved && readStoredViewport()) return;');
    expect(graphReport).toBeGreaterThan(-1);
    expect(groupsReport).toBeGreaterThan(graphReport);
    expect(earlyReturn).toBeGreaterThan(groupsReport);
  });
});

describe('image payload storage: behaviour', () => {
  // The storage de-duplication (utils/imagePayloadRefs.ts) through the REAL
  // writers and readers: what one path writes, the other reads back whole.
  const P = 'data:image/png;base64,AAAA';
  const Q = 'data:image/png;base64,BBBB';
  const REF_P = 'img1-0ce4918c-q';
  /** A hand-written stored node that carries only a ref. */
  const refNode = (id: string, ref: string): unknown => ({
    id,
    type: 'shader',
    position: { x: 0, y: 0 },
    data: { registryType: 'imageNode', label: 'Image', cost: 10, values: { imageB64: '', width: 1, height: 1, imageRef: ref } },
  });
  const b64Of = (nodes: AppNode[], id: string) => getNodeValues(nodes.find((n) => n.id === id)!).imageB64;
  const hasRef = (n: AppNode) => Object.prototype.hasOwnProperty.call(n.data.values as object, 'imageRef');
  const group = (id: string, nodes: unknown[]) => ({ id, name: id, color: '#6366f1', nodes, edges: [] });

  it('an autosave with duplicates loads back whole: no ref, nothing stripped', () => {
    autosave([imageNode('a', P), imageNode('b', P), imageNode('c', Q), imageNode('d', P)] as AppNode[]);
    expect(store['fs:graph']).toContain(REF_P);
    const g = loadGraph()!;
    expect(g.strippedImages).toBe(0);
    expect(['a', 'b', 'c', 'd'].map((id) => b64Of(g.nodes, id))).toEqual([P, P, Q, P]);
    for (const n of g.nodes) expect(hasRef(n)).toBe(false);
  });

  it('a ref with no canonical is counted with the hard strips, each node once', () => {
    store['fs:graph'] = JSON.stringify({
      nodes: [refNode('x', REF_P), imageNode('html', 'data:text/html;base64,AAAA'), imageNode('ok', Q)],
      edges: [],
    });
    const g = loadGraph()!;
    expect(g.strippedImages).toBe(2);
    expect(b64Of(g.nodes, 'x')).toBe('');
    expect(b64Of(g.nodes, 'html')).toBe('');
    expect(b64Of(g.nodes, 'ok')).toBe(Q);
    for (const n of g.nodes) expect(hasRef(n)).toBe(false);
  });

  it('loadSavedGroupsReport resolves a ref in group 2 against group 1', () => {
    store['fs:savedGroups'] = JSON.stringify([group('g1', [imageNode('i1', P)]), group('g2', [refNode('i2', REF_P)])]);
    const r = loadSavedGroupsReport();
    expect(r.strippedImages).toBe(0);
    expect(r.groups.map((g) => getNodeValues(g.nodes[0]).imageB64)).toEqual([P, P]);
    for (const g of r.groups) for (const n of g.nodes) expect(hasRef(n)).toBe(false);
  });

  it('a saved group whose image is a ref instantiates with the full payload and no ref', () => {
    // Refs never reach memory, so instantiateSavedGroup needs no ref handling:
    // pinned end to end, from fs:savedGroups to the canvas.
    const frame = {
      id: 'gg',
      type: 'group',
      position: { x: 0, y: 0 },
      width: 200,
      height: 120,
      data: { label: 'gg', color: '#dde', collapsed: false, width: 200, height: 120 },
    };
    store['fs:savedGroups'] = JSON.stringify([
      group('g1', [imageNode('i1', P)]),
      group('g2', [frame, { ...(refNode('i2', REF_P) as object), parentId: 'gg' }]),
    ]);
    useAppStore.setState({ savedGroups: loadSavedGroupsReport().groups, ignoreImageLimits: false });
    try {
      useAppStore.getState().instantiateSavedGroup('g2', { x: 10, y: 10 });
      const images = useAppStore
        .getState()
        .nodes.filter((n) => (n.data as { registryType?: string }).registryType === 'imageNode');
      expect(images).toHaveLength(1);
      for (const n of images) {
        expect(getNodeValues(n).imageB64).toBe(P);
        expect(hasRef(n)).toBe(false);
      }
    } finally {
      useAppStore.setState({ savedGroups: [], nodes: [], edges: [], past: [], future: [] });
    }
  });

  it('counts the refs that cannot be resolved, per surviving group', () => {
    store['fs:savedGroups'] = JSON.stringify([
      group('g1', [refNode('i1', imageRefFor(Q))]),
      group('g2', [imageNode('i2', P), refNode('i3', REF_P)]),
    ]);
    const r = loadSavedGroupsReport();
    expect(r.strippedImages).toBe(1);
    expect(getNodeValues(r.groups[0].nodes[0]).imageB64).toBe('');
    expect(r.groups[1].nodes.map((n) => getNodeValues(n).imageB64)).toEqual([P, P]);
  });

  it('a library round trip: written once, still a bare array, read back whole', () => {
    persistSavedGroups([
      group('g1', [imageNode('i1', P)]),
      group('g2', [imageNode('i2', P)]),
    ] as unknown as SavedGroup[]);
    const raw = store['fs:savedGroups'];
    expect(raw).toContain(REF_P);
    // ShaderCarousel's bench-registry.js reads the library as a bare array.
    const parsed = JSON.parse(raw, safeJsonReviver) as unknown;
    expect(Array.isArray(parsed)).toBe(true);
    const groups = loadSavedGroups();
    expect(groups.map((g) => getNodeValues(g.nodes[0]).imageB64)).toEqual([P, P]);
  });

  it('five duplicates of one payload write less than two copies of it', () => {
    const big = 'data:image/png;base64,' + 'A'.repeat(100_000);
    autosave(Array.from({ length: 5 }, (_, i) => imageNode(`n${i}`, big)) as AppNode[]);
    expect(store['fs:graph'].length).toBeLessThan(2 * big.length);
    expect(loadGraph()!.nodes.map((n) => getNodeValues(n).imageB64)).toEqual(Array(5).fill(big));
  });

  describe('source pins', () => {
    const storeSrc = readFileSync(resolve(__dirname, 'useAppStore.ts'), 'utf8');
    const importSrc = readFileSync(resolve(__dirname, '../engine/projectImport.ts'), 'utf8');
    const count = (s: string, needle: string) => s.split(needle).length - 1;

    it('the graph writer de-duplicates exactly once', () => {
      expect(count(storeSrc, 'imagePayloadsForStorage(bareNodes)')).toBe(1);
    });

    it('every restore path resolves refs BEFORE the image sanitizer', () => {
      const resolveAt = storeSrc.indexOf('resolveImageRefs(data.nodes)');
      expect(resolveAt).toBeGreaterThan(-1);
      expect(storeSrc.indexOf('sanitizeImageNodes(data.nodes, false)')).toBeGreaterThan(resolveAt);

      const lib = storeSrc.slice(
        storeSrc.indexOf('export function loadSavedGroupsReport('),
        storeSrc.indexOf('let graphQuotaWarned'),
      );
      const harvestAt = lib.indexOf('harvestImagePayloads(candidates.flatMap(');
      expect(harvestAt).toBeGreaterThan(-1);
      expect(lib.indexOf('.map((g) => {')).toBeGreaterThan(harvestAt);
      expect(lib.indexOf('sanitizeImageNodes(refs.nodes, false)')).toBeGreaterThan(
        lib.indexOf('resolveImageRefs(shape.nodes, index, budget)'),
      );

      const importResolve = importSrc.indexOf('resolveImageRefs(');
      expect(importResolve).toBeGreaterThan(-1);
      expect(importSrc.indexOf('sanitizeImageNodes(')).toBeGreaterThan(importResolve);
    });
  });
});
