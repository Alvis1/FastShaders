/**
 * Decision 9 on the three Output restore paths (GLB Phase 5 Step 4): a restore
 * that drops or empties Output sections SAYS so, once, and leaves no wires
 * pointing at a section that is gone.
 *
 *  - `loadGraph` and `loadSavedGroupsReport` return the count; App.tsx's mount
 *    effect raises `output-sections-trimmed` (slot graph / savedGroups) — the
 *    load functions never enqueue, because tests call them in a shared module
 *    registry.
 *  - `applyProjectToStore` (every file import) enqueues it directly, with no
 *    slot, which the words read as "the opened file".
 *  - Every path prunes the edges a dropped section left behind.
 *
 * Store-mutating under `isolate: false`: every test starts from a reset state,
 * the stubbed localStorage is undone after each test, and the pending
 * autosave is cancelled before the stub goes.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  useAppStore,
  cancelPendingGraphSave,
  loadGraph,
  loadSavedGroupsReport,
  reportOutputSectionsTrimmed,
} from './useAppStore';
import { makeNode, makeEdge } from '@/test-utils';
import { outputMaterials, outputNodes, MAX_PARTS } from '@/utils/outputMaterials';
import { embedProjectState, type FastShadersProject } from '@/engine/fastShadersProject';
import { importShaderText } from '@/engine/projectImport';
import type { AppNode, AppEdge } from '@/types';

const names = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

/**
 * An Output with 12 named sections and a material-0 list of 12 names: three
 * sections and three names past the caps, 6 trimmed. Wired into the default,
 * a kept section (m2) and two dropped ones (m10, m12).
 */
function overCapGraph(): { nodes: AppNode[]; edges: AppEdge[] } {
  const out = makeNode('o1', 'output');
  const d = out.data as Record<string, unknown>;
  d.meshTargets = names('zero', 12);
  d.materials = names('s', 12).map((n) => ({ meshTargets: [n] }));
  return {
    nodes: [makeNode('c1', 'color', { hex: '#22cc22' }), out],
    edges: [
      makeEdge('c1', 'out', 'o1', 'color'),
      makeEdge('c1', 'out', 'o1', 'm2:color'),
      makeEdge('c1', 'out', 'o1', 'm10:color'),
      makeEdge('c1', 'out', 'o1', 'm12:emissive'),
    ],
  };
}

function cleanGraph(): { nodes: AppNode[]; edges: AppEdge[] } {
  const out = makeNode('o1', 'output');
  (out.data as Record<string, unknown>).materials = [{ meshTargets: ['Glass'] }];
  return {
    nodes: [makeNode('c1', 'color', { hex: '#22cc22' }), out],
    edges: [makeEdge('c1', 'out', 'o1', 'color'), makeEdge('c1', 'out', 'o1', 'm1:color')],
  };
}

const handlesInto = (edges: readonly AppEdge[], target: string) =>
  edges.filter((e) => e.target === target).map((e) => e.targetHandle).sort();
const trimmedNotices = () =>
  useAppStore.getState().pendingLimitNotices.filter((n) => n.kind === 'output-sections-trimmed');

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
    ignoreImageLimits: false,
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

describe('loadGraph counts and prunes (App reports it, slot graph)', () => {
  it('drops 3 sections and 3 names, reports 6, and prunes the wires of the dropped sections', () => {
    ls['fs:graph'] = JSON.stringify(overCapGraph());
    const g = loadGraph()!;
    expect(g.outputSectionsTrimmed).toBe(6);
    const out = g.nodes.find((n) => n.id === 'o1')!;
    expect(outputMaterials(out)).toHaveLength(1 + MAX_PARTS);
    expect((out.data as { meshTargets?: string[] }).meshTargets).toHaveLength(MAX_PARTS);
    expect(handlesInto(g.edges, 'o1')).toEqual(['color', 'm2:color']);
    // The load reports; it never enqueues (App's mount effect does).
    expect(trimmedNotices()).toHaveLength(0);
  });

  it('a clean graph reports 0 and keeps every edge', () => {
    ls['fs:graph'] = JSON.stringify(cleanGraph());
    const g = loadGraph()!;
    expect(g.outputSectionsTrimmed).toBe(0);
    expect(handlesInto(g.edges, 'o1')).toEqual(['color', 'm1:color']);
  });
});

describe('loadSavedGroupsReport counts per surviving group and prunes (slot savedGroups)', () => {
  it('reports the same shape, and the repaired group carries no stranded wire', () => {
    const bad = overCapGraph();
    const good = cleanGraph();
    ls['fs:savedGroups'] = JSON.stringify([
      { id: 'g1', name: 'over', color: '#6366f1', nodes: bad.nodes, edges: bad.edges },
      { id: 'g2', name: 'clean', color: '#6366f1', nodes: good.nodes, edges: good.edges },
    ]);
    const report = loadSavedGroupsReport();
    expect(report.outputSectionsTrimmed).toBe(6);
    expect(report.groups.map((g) => g.id)).toEqual(['g1', 'g2']);
    expect(handlesInto(report.groups[0].edges, 'o1')).toEqual(['color', 'm2:color']);
    expect(handlesInto(report.groups[1].edges, 'o1')).toEqual(['color', 'm1:color']);
  });
});

describe('reportOutputSectionsTrimmed', () => {
  it('stays silent for 0 or junk, and names slot + count otherwise', () => {
    reportOutputSectionsTrimmed('graph', 0);
    reportOutputSectionsTrimmed('graph', Number.NaN);
    reportOutputSectionsTrimmed('savedGroups', -1);
    expect(trimmedNotices()).toHaveLength(0);
    reportOutputSectionsTrimmed('savedGroups', 3);
    reportOutputSectionsTrimmed('graph', 2);
    const notices = trimmedNotices();
    expect(notices.map((n) => [n.slot, n.detail])).toEqual([['savedGroups', '3'], ['graph', '2']]);
  });
});

describe('applyProjectToStore (every file import) announces it directly, with no slot', () => {
  const project = (g: { nodes: AppNode[]; edges: AppEdge[] }): FastShadersProject =>
    ({ version: 1, shaderName: 'sections', graph: g, preview: {}, ui: {} }) as FastShadersProject;
  const MODULE = 'export default function () {}\n';

  it('enqueues ONE output-sections-trimmed notice for the opened file, and prunes', () => {
    expect(importShaderText(embedProjectState(MODULE, project(overCapGraph())))).toBe('project');
    const notices = trimmedNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0].detail).toBe('6');
    expect('slot' in notices[0]).toBe(false);
    expect(handlesInto(useAppStore.getState().edges, 'o1')).toEqual(['color', 'm2:color']);
  });

  it('a clean project raises no such notice', () => {
    expect(importShaderText(embedProjectState(MODULE, project(cleanGraph())))).toBe('project');
    expect(trimmedNotices()).toHaveLength(0);
    expect(handlesInto(useAppStore.getState().edges, 'o1')).toEqual(['color', 'm1:color']);
  });
});

describe('instantiateSavedGroup prunes the combined graph', () => {
  it('an arriving Output keeps only the wires of sections it really has', () => {
    const groupNode = {
      id: 'g',
      type: 'group',
      position: { x: 0, y: 0 },
      width: 200,
      height: 120,
      data: { label: 'g', color: '#dde', collapsed: false, width: 200, height: 120 },
    } as unknown as AppNode;
    const savedOut = makeNode('sgOut', 'output');
    (savedOut.data as Record<string, unknown>).materials = [{ meshTargets: ['A'] }];
    useAppStore.setState({
      nodes: [makeNode('liveOut', 'output')],
      edges: [],
      savedGroups: [
        {
          id: 'sg1',
          name: 'with-output',
          color: '#dde',
          nodes: [
            groupNode,
            { ...makeNode('feeder', 'float'), parentId: 'g' } as AppNode,
            { ...savedOut, parentId: 'g' } as AppNode,
          ],
          edges: [makeEdge('feeder', 'out', 'sgOut', 'm1:color'), makeEdge('feeder', 'out', 'sgOut', 'm5:color')],
        },
      ] as never,
    });
    useAppStore.getState().instantiateSavedGroup('sg1', { x: 500, y: 500 });
    const state = useAppStore.getState();
    const arriving = outputNodes(state.nodes).find((n) => n.id !== 'liveOut')!;
    expect(arriving).toBeDefined();
    expect(handlesInto(state.edges, arriving.id)).toEqual(['m1:color']);
  });
});

describe('source pins: every restore path counts and prunes', () => {
  const store = readFileSync(resolve(__dirname, 'useAppStore.ts'), 'utf8');
  const imp = readFileSync(resolve(__dirname, '../engine/projectImport.ts'), 'utf8');
  const app = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8');
  const slice = (src: string, from: string, to: string) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from)));

  it('loadGraph, loadSavedGroupsReport and applyProjectToStore', () => {
    const load = slice(store, 'export function loadGraph()', 'export function reportImagesStrippedOnLoad(');
    expect(load).toContain('sanitizeOutputMaterialsReport(data.nodes)');
    expect(load).toContain('pruneOrphanMaterialEdges(data.nodes, data.edges)');
    const lib = slice(store, 'export function loadSavedGroupsReport(', 'let graphQuotaWarned');
    expect(lib).toContain('sanitizeOutputMaterialsReport(');
    expect(lib).toContain('pruneOrphanMaterialEdges(');
    expect(imp).toContain('sanitizeOutputMaterialsReport(dataSanitized.nodes)');
    expect(imp).toContain('pruneOrphanMaterialEdges(folded.nodes, folded.edges)');
    expect(imp).toContain("kind: 'output-sections-trimmed'");
  });

  it('instantiateSavedGroup prunes after the fold', () => {
    const inst = slice(store, 'instantiateSavedGroup: (savedId, position, opts) => {', 'applyLangAttribute(');
    expect(inst).toContain('pruneOrphanMaterialEdges(folded.nodes, folded.edges)');
  });

  it('App reports both slots ABOVE the remembered-viewport early return', () => {
    const graph = app.indexOf("reportOutputSectionsTrimmed('graph'");
    const groups = app.indexOf("reportOutputSectionsTrimmed('savedGroups',");
    const earlyReturn = app.indexOf('if (saved && readStoredViewport()) return;');
    expect(graph).toBeGreaterThan(-1);
    expect(groups).toBeGreaterThan(graph);
    expect(earlyReturn).toBeGreaterThan(groups);
  });
});
