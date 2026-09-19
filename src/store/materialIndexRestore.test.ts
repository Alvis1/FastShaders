/**
 * Index sections on EVERY restore path (GLB Phase 5 Step 5), through the real
 * store: `loadGraph` (a tampered `fs:graph`), `applyProjectToStore` (an opened
 * file, via `importShaderText`), `loadSavedGroupsReport` (a tampered library)
 * and `instantiateSavedGroup` (the combined list).
 *
 * The rules under test live in `sanitizeOutputMaterialsReport`: an index the
 * signature cannot vouch for DETACHES its section into an empty named one
 * (wiring kept, counted); an invalid signature detaches them all and is
 * removed with its mirror source; names on an index section are stripped. The
 * emitted code after a restore therefore carries no `materialParts` for
 * invalid input — and carries it, byte for byte, for valid input.
 *
 * Store-mutating under `isolate: false`: every test starts from a reset state,
 * the stubbed localStorage is undone after each test, and the pending autosave
 * is cancelled before the stub goes.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import {
  useAppStore,
  cancelPendingGraphSave,
  loadGraph,
  loadSavedGroupsReport,
} from './useAppStore';
import { makeNode, makeEdge } from '@/test-utils';
import { outputMaterials, outputNodes } from '@/utils/outputMaterials';
import { embedProjectState, type FastShadersProject } from '@/engine/fastShadersProject';
import { importShaderText } from '@/engine/projectImport';
import { graphToCode } from '@/engine/graphToCode';
import type { AppNode, AppEdge } from '@/types';

const SIG = ['Body', 'Glass', 'Trim'];
const MESHES = [{ name: 'Hull', material: 0 }, { name: 'Plain', material: 2 }];
const VALID = {
  materials: [{ gltfMaterialIndex: 0 }, { gltfMaterialIndex: 2 }],
  modelSignature: { materials: SIG },
  modelMeshes: MESHES,
};

function graphWith(outData: Record<string, unknown>): { nodes: AppNode[]; edges: AppEdge[] } {
  const out = makeNode('o1', 'output');
  Object.assign(out.data as Record<string, unknown>, outData);
  return {
    nodes: [makeNode('c1', 'color', { hex: '#22cc22' }), out],
    edges: [makeEdge('c1', 'out', 'o1', 'm1:color'), makeEdge('c1', 'out', 'o1', 'm2:color')],
  };
}

/** Tampered signatures: each one invalid, so every index section detaches. */
const BAD_SIGNATURES: unknown[] = [
  5,
  { materials: 'x' },
  [1],
  { materials: new Array(2000).fill('m') },
  { materials: ['x'.repeat(70_000)] },
  { materials: ['a', 3] },
];
/** Tampered indices, as JSON carries them (NaN and Infinity arrive as null). */
const BAD_INDICES: unknown[] = ['1', 1.5, -1, null, 1e9, 3, {}, true];

const dataOf = (n: AppNode) => n.data as Record<string, unknown>;
const outIn = (nodes: readonly AppNode[]) => nodes.find((n) => n.id === 'o1')!;
const codeOf = (g: { nodes: AppNode[]; edges: AppEdge[] }) => graphToCode(g.nodes, g.edges).code;

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
    savedGroups: [],
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

describe('loadGraph (fs:graph)', () => {
  it('a valid import-built Output survives exactly, and emits materialParts', () => {
    const g0 = graphWith(VALID);
    ls['fs:graph'] = JSON.stringify(g0);
    const g = loadGraph()!;
    expect(g.outputSectionsTrimmed).toBe(0);
    const out = outIn(g.nodes);
    expect(dataOf(out).materials).toEqual(VALID.materials);
    expect(dataOf(out).modelSignature).toEqual(VALID.modelSignature);
    expect(dataOf(out).modelMeshes).toEqual(MESHES);
    expect(codeOf(g)).toBe(codeOf(g0));
    expect(codeOf(g)).toContain('materialParts: { "0": { color: color1 }, "2": { color: color1 } }');
  });

  it('every invalid signature: sections detached (wiring kept), signature and mirrors gone, no materialParts', () => {
    for (const bad of BAD_SIGNATURES) {
      ls['fs:graph'] = JSON.stringify(graphWith({ ...VALID, modelSignature: bad }));
      const g = loadGraph()!;
      const label = JSON.stringify(bad).slice(0, 40);
      expect(g.outputSectionsTrimmed, label).toBe(2);
      const out = outIn(g.nodes);
      expect(dataOf(out).materials, label).toEqual([{ meshTargets: [] }, { meshTargets: [] }]);
      expect(dataOf(out).modelSignature, label).toBeUndefined();
      expect(dataOf(out).modelMeshes, label).toBeUndefined();
      expect(g.edges.filter((e) => e.target === 'o1').map((e) => e.targetHandle).sort(), label).toEqual(['m1:color', 'm2:color']);
      expect(codeOf(g), label).not.toContain('materialParts');
    }
  });

  it('every invalid index detaches only its own section', () => {
    for (const bad of BAD_INDICES) {
      ls['fs:graph'] = JSON.stringify(graphWith({ ...VALID, materials: [{ gltfMaterialIndex: 0 }, { gltfMaterialIndex: bad }] }));
      const g = loadGraph()!;
      const label = JSON.stringify(bad);
      expect(g.outputSectionsTrimmed, label).toBe(1);
      expect(dataOf(outIn(g.nodes)).materials, label).toEqual([{ gltfMaterialIndex: 0 }, { meshTargets: [] }]);
      expect(dataOf(outIn(g.nodes)).modelSignature, label).toEqual({ materials: SIG });
      expect(codeOf(g), label).toContain('materialParts: { "0": ');
      expect(codeOf(g), label).not.toContain('"2":');
    }
  });

  it('names on an index section, a node-level index and hostile mirror entries are all cleaned', () => {
    ls['fs:graph'] = JSON.stringify(graphWith({
      ...VALID,
      gltfMaterialIndex: 0,
      materials: [{ gltfMaterialIndex: 0, meshTargets: ['Body'] }, { gltfMaterialIndex: 2 }],
      modelMeshes: [null, { name: '__proto__', material: 0 }, { name: 'ok', material: 99 }, ...MESHES],
    }));
    const g = loadGraph()!;
    const d = dataOf(outIn(g.nodes));
    expect(g.outputSectionsTrimmed).toBe(1);
    expect(d.materials).toEqual(VALID.materials);
    expect('gltfMaterialIndex' in d).toBe(false);
    expect(d.modelMeshes).toEqual(MESHES);
  });
});

describe('applyProjectToStore (an opened file)', () => {
  const project = (g: { nodes: AppNode[]; edges: AppEdge[] }): FastShadersProject =>
    ({ version: 1, shaderName: 'sections', graph: g, preview: {}, ui: {} }) as FastShadersProject;
  const MODULE = 'export default function () {}\n';

  it('a valid Output lands intact and announces nothing', () => {
    expect(importShaderText(embedProjectState(MODULE, project(graphWith(VALID))))).toBe('project');
    const s = useAppStore.getState();
    const out = outIn(s.nodes);
    expect(dataOf(out).materials).toEqual(VALID.materials);
    expect(dataOf(out).modelSignature).toEqual({ materials: SIG });
    expect(dataOf(out).modelMeshes).toEqual(MESHES);
    expect(s.pendingLimitNotices.filter((n) => n.kind === 'output-sections-trimmed')).toHaveLength(0);
  });

  it('a tampered signature detaches the sections and announces the count', () => {
    const g = graphWith({ ...VALID, modelSignature: { materials: 'x' } });
    expect(importShaderText(embedProjectState(MODULE, project(g)))).toBe('project');
    const s = useAppStore.getState();
    const out = outIn(s.nodes);
    expect(dataOf(out).modelSignature).toBeUndefined();
    expect(outputMaterials(out).slice(1)).toEqual([{ meshTargets: [] }, { meshTargets: [] }]);
    const notices = s.pendingLimitNotices.filter((n) => n.kind === 'output-sections-trimmed');
    expect(notices.map((n) => n.detail)).toEqual(['2']);
    expect(graphToCode(s.nodes, s.edges).code).not.toContain('materialParts');
  });
});

describe('loadSavedGroupsReport (fs:savedGroups)', () => {
  it('validates each group: a valid one keeps its sections, a tampered one is detached and counted', () => {
    const good = graphWith(VALID);
    const bad = graphWith({ ...VALID, materials: [{ gltfMaterialIndex: 1.5 }, { gltfMaterialIndex: 2 }] });
    ls['fs:savedGroups'] = JSON.stringify([
      { id: 'g1', name: 'good', color: '#6366f1', nodes: good.nodes, edges: good.edges },
      { id: 'g2', name: 'bad', color: '#6366f1', nodes: bad.nodes, edges: bad.edges },
    ]);
    const report = loadSavedGroupsReport();
    expect(report.outputSectionsTrimmed).toBe(1);
    expect(dataOf(outIn(report.groups[0].nodes)).materials).toEqual(VALID.materials);
    expect(dataOf(outIn(report.groups[1].nodes)).materials).toEqual([{ meshTargets: [] }, { gltfMaterialIndex: 2 }]);
    expect(dataOf(outIn(report.groups[1].nodes)).modelSignature).toEqual({ materials: SIG });
  });
});

describe('instantiateSavedGroup (the combined list)', () => {
  it('an arriving import-built Output lands INACTIVE with its sections and signature intact', () => {
    const groupNode = {
      id: 'g',
      type: 'group',
      position: { x: 0, y: 0 },
      width: 200,
      height: 120,
      data: { label: 'g', color: '#dde', collapsed: false, width: 200, height: 120 },
    } as unknown as AppNode;
    const savedOut = makeNode('sgOut', 'output');
    Object.assign(savedOut.data as Record<string, unknown>, VALID);
    const live = makeNode('liveOut', 'output');
    (live.data as Record<string, unknown>).activeOutput = true;
    useAppStore.setState({
      nodes: [live],
      edges: [],
      savedGroups: [
        {
          id: 'sg1',
          name: 'import-built',
          color: '#dde',
          nodes: [groupNode, { ...makeNode('feeder', 'color', { hex: '#123456' }), parentId: 'g' } as AppNode, { ...savedOut, parentId: 'g' } as AppNode],
          edges: [makeEdge('feeder', 'out', 'sgOut', 'm1:color')],
        },
      ] as never,
    });
    useAppStore.getState().instantiateSavedGroup('sg1', { x: 500, y: 500 });
    const state = useAppStore.getState();
    const outs = outputNodes(state.nodes);
    const arriving = outs.find((n) => n.id !== 'liveOut')!;
    expect(arriving).toBeDefined();
    expect(dataOf(arriving).activeOutput).toBeUndefined();
    expect(dataOf(outs.find((n) => n.id === 'liveOut')!).activeOutput).toBe(true);
    expect(dataOf(arriving).materials).toEqual(VALID.materials);
    expect(dataOf(arriving).modelSignature).toEqual({ materials: SIG });
    expect(state.edges.filter((e) => e.target === arriving.id).map((e) => e.targetHandle)).toEqual(['m1:color']);
  });
});
