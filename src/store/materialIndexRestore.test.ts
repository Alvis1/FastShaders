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
import {
  contributingOutputs,
  gltfIndexOf,
  isIndexSection,
  materialTargetNames,
  outputMaterials,
  outputNodes,
  outputsInEmitOrder,
  readModelSignature,
  sanitizeOutputMaterialsReport,
  unfoldOutputMaterials,
} from '@/utils/outputMaterials';
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

/**
 * The document's SECTION BINDINGS in emit order.
 *
 * Every restore path now runs `unfoldOutputMaterials`, so what `data.materials`
 * used to describe lives across sibling Output NODES — one material each, on
 * bare channel handles. This reads the same list back out, so each case below
 * still pins what it always pinned: material 0 first (the untargeted default
 * reports an empty name list), then one entry per section.
 */
const sectionsOf = (nodes: readonly AppNode[]) =>
  outputsInEmitOrder(nodes.filter((n) => n.data.registryType === 'output'))
    .map((n) => outputMaterials(n)[0])
    .map((m) => (isIndexSection(m)
      ? { gltfMaterialIndex: gltfIndexOf(m) }
      : { meshTargets: materialTargetNames(m) }));

/** The node emission reads the signature and the mirror list from: the
 *  lowest-ranked contributing Output carrying an index section. */
const sigNodeOf = (nodes: readonly AppNode[]) =>
  contributingOutputs(nodes).find((n) => outputMaterials(n).some(isIndexSection));

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
    // One node per material now: the untargeted default plus the two index
    // siblings, in emit order. The module is what must not move — and it does
    // not, byte for byte, against the folded document it was stored as.
    expect(sectionsOf(g.nodes)).toEqual([{ meshTargets: [] }, ...VALID.materials]);
    expect(readModelSignature(sigNodeOf(g.nodes)?.data)).toEqual(SIG);
    expect(dataOf(sigNodeOf(g.nodes)!).modelMeshes).toEqual(MESHES);
    expect(codeOf(g)).toBe(codeOf(g0));
    expect(codeOf(g)).toContain('materialParts: { "0": { color: color1 }, "2": { color: color1 } }');
  });

  /**
   * THE round trip the split's data half rests on: boot 1 stores the folded
   * document and splits it, the autosave writes the SPLIT shape, boot 2 reads
   * that back — and must change nothing.
   *
   * The sanitizer used to delete a node-level `gltfMaterialIndex` outright
   * (material 0 could never be an index section while every material lived on
   * one node), so without teaching it the split shape this second load would
   * have dropped every index binding AND its signature, silently, leaving a
   * document of blank untargeted Outputs — and the module's whole
   * `materialParts` table with it.
   */
  it('the SPLIT shape survives a second load unchanged, arrays included', () => {
    ls['fs:graph'] = JSON.stringify(graphWith(VALID));
    const first = loadGraph()!;
    // What the autosave would write — the split document, through JSON.
    ls['fs:graph'] = JSON.stringify({ nodes: first.nodes, edges: first.edges });
    const second = loadGraph()!;
    expect(second.outputSectionsTrimmed).toBe(0);
    expect(sectionsOf(second.nodes)).toEqual(sectionsOf(first.nodes));
    expect(readModelSignature(sigNodeOf(second.nodes)?.data)).toEqual(SIG);
    expect(dataOf(sigNodeOf(second.nodes)!).modelMeshes).toEqual(MESHES);
    expect(codeOf(second)).toBe(codeOf(first));

    // And the sanitizer + split leave a CLEAN split document by REFERENCE: the
    // autosave subscriber and `selectionOnlyGraphChange` compare that way, so a
    // fresh array here would rewrite `fs:graph` on every boot of every
    // import-built document.
    const clean = sanitizeOutputMaterialsReport(second.nodes);
    expect(clean.nodes).toBe(second.nodes);
    expect(clean.trimmed).toBe(0);
    const split = unfoldOutputMaterials(second.nodes, second.edges);
    expect(split.nodes).toBe(second.nodes);
    expect(split.edges).toBe(second.edges);
  });

  it('every invalid signature: sections detached (wiring kept), signature and mirrors gone, no materialParts', () => {
    for (const bad of BAD_SIGNATURES) {
      ls['fs:graph'] = JSON.stringify(graphWith({ ...VALID, modelSignature: bad }));
      const g = loadGraph()!;
      const label = JSON.stringify(bad).slice(0, 40);
      expect(g.outputSectionsTrimmed, label).toBe(2);
      // Both detached sections become empty NAMED siblings; the wiring moves
      // onto their bare handles with it.
      expect(sectionsOf(g.nodes), label).toEqual([{ meshTargets: [] }, { meshTargets: [] }, { meshTargets: [] }]);
      expect(sigNodeOf(g.nodes), label).toBeUndefined();
      for (const n of outputNodes(g.nodes)) expect(dataOf(n).modelSignature, label).toBeUndefined();
      expect(g.edges.filter((e) => e.targetHandle === 'color').length, label).toBe(2);
      expect(codeOf(g), label).not.toContain('materialParts');
    }
  });

  it('every invalid index detaches only its own section', () => {
    for (const bad of BAD_INDICES) {
      ls['fs:graph'] = JSON.stringify(graphWith({ ...VALID, materials: [{ gltfMaterialIndex: 0 }, { gltfMaterialIndex: bad }] }));
      const g = loadGraph()!;
      const label = JSON.stringify(bad);
      expect(g.outputSectionsTrimmed, label).toBe(1);
      expect(sectionsOf(g.nodes), label)
        .toEqual([{ meshTargets: [] }, { gltfMaterialIndex: 0 }, { meshTargets: [] }]);
      expect(readModelSignature(sigNodeOf(g.nodes)?.data), label).toEqual(SIG);
      expect(codeOf(g), label).toContain('materialParts: { "0": ');
      expect(codeOf(g), label).not.toContain('"2":');
    }
  });

  /**
   * RE-AIMED with the Output-node split: this used to pin
   * `'gltfMaterialIndex' in d === false`, i.e. that a node-level index is
   * always deleted. Since `unfoldOutputMaterials` gives each material its own
   * node, that key is where a SPLIT index section's binding lives, so a valid
   * one survives (an invalid one still does not — the sweep below).
   *
   * Everything else the case was about is unchanged: names beside an index
   * ENTRY are stripped and counted, and a hostile mirror list is cleaned.
   */
  it('names on an index section and hostile mirror entries are cleaned; a valid node-level index survives', () => {
    ls['fs:graph'] = JSON.stringify(graphWith({
      ...VALID,
      gltfMaterialIndex: 0,
      materials: [{ gltfMaterialIndex: 0, meshTargets: ['Body'] }, { gltfMaterialIndex: 2 }],
      modelMeshes: [null, { name: '__proto__', material: 0 }, { name: 'ok', material: 99 }, ...MESHES],
    }));
    const g = loadGraph()!;
    expect(g.outputSectionsTrimmed).toBe(1);
    // Material 0 binds to glTF material 0 at NODE level, so the split leaves it
    // on `o1` itself and the two ENTRIES become siblings.
    expect(dataOf(outIn(g.nodes)).gltfMaterialIndex).toBe(0);
    expect(sectionsOf(g.nodes))
      .toEqual([{ gltfMaterialIndex: 0 }, ...VALID.materials]);
    expect(dataOf(sigNodeOf(g.nodes)!).modelMeshes).toEqual(MESHES);
  });

  it('an INVALID node-level index is still deleted on the restore path', () => {
    for (const bad of BAD_INDICES) {
      ls['fs:graph'] = JSON.stringify(graphWith({ ...VALID, gltfMaterialIndex: bad }));
      const g = loadGraph()!;
      expect('gltfMaterialIndex' in dataOf(outIn(g.nodes)), JSON.stringify(bad)).toBe(false);
      // Its `materials` index sections are untouched, so the signature stays
      // on the siblings they became.
      expect(readModelSignature(sigNodeOf(g.nodes)?.data), JSON.stringify(bad)).toEqual(SIG);
    }
  });
});

describe('applyProjectToStore (an opened file)', () => {
  const project = (g: { nodes: AppNode[]; edges: AppEdge[] }): FastShadersProject =>
    ({ version: 1, shaderName: 'sections', graph: g, preview: {}, ui: {} }) as FastShadersProject;
  const MODULE = 'export default function () {}\n';

  it('a valid Output lands intact and announces nothing', () => {
    expect(importShaderText(embedProjectState(MODULE, project(graphWith(VALID))))).toBe('project');
    const s = useAppStore.getState();
    expect(sectionsOf(s.nodes)).toEqual([{ meshTargets: [] }, ...VALID.materials]);
    expect(readModelSignature(sigNodeOf(s.nodes)?.data)).toEqual(SIG);
    expect(dataOf(sigNodeOf(s.nodes)!).modelMeshes).toEqual(MESHES);
    expect(s.pendingLimitNotices.filter((n) => n.kind === 'output-sections-trimmed')).toHaveLength(0);
  });

  it('a tampered signature detaches the sections and announces the count', () => {
    const g = graphWith({ ...VALID, modelSignature: { materials: 'x' } });
    expect(importShaderText(embedProjectState(MODULE, project(g)))).toBe('project');
    const s = useAppStore.getState();
    expect(sigNodeOf(s.nodes)).toBeUndefined();
    expect(sectionsOf(s.nodes)).toEqual([{ meshTargets: [] }, { meshTargets: [] }, { meshTargets: [] }]);
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
    expect(sectionsOf(report.groups[0].nodes)).toEqual([{ meshTargets: [] }, ...VALID.materials]);
    expect(sectionsOf(report.groups[1].nodes))
      .toEqual([{ meshTargets: [] }, { meshTargets: [] }, { gltfMaterialIndex: 2 }]);
    expect(readModelSignature(sigNodeOf(report.groups[1].nodes)?.data)).toEqual(SIG);
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
    const arriving = outs.filter((n) => n.id !== 'liveOut');
    // The group's Output splits on arrival: its default plus its two index
    // siblings. None of them may take the live graph's flag.
    // `cloneGroupSnapshot` mints a fresh id for the arriving Output, and the
    // siblings are derived from it — deterministic, zero-padded.
    const base = arriving[0].id;
    expect(arriving.map((n) => n.id)).toEqual([base, `${base}#m01`, `${base}#m02`]);
    for (const n of arriving) expect(dataOf(n).activeOutput, n.id).toBeUndefined();
    expect(dataOf(outs.find((n) => n.id === 'liveOut')!).activeOutput).toBe(true);
    expect(arriving.map((n) => gltfIndexOf(outputMaterials(n)[0]))).toEqual([null, 0, 2]);
    expect(readModelSignature(dataOf(arriving[1]))).toEqual(SIG);
    // The feeder's `m1:color` wire moved onto the sibling's bare handle, with a
    // re-derived id — a stale one would collide with the next edge that really
    // connects that pair.
    const moved = state.edges.filter((e) => e.target === `${base}#m01`);
    expect(moved.map((e) => e.targetHandle)).toEqual(['color']);
    expect(moved[0].id).toContain(`${base}#m01`);
    expect(state.edges.filter((e) => e.target === base)).toEqual([]);
  });
});
