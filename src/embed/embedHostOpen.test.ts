/**
 * What a HOST open does to the store (embed/EmbedBridge.tsx, protocol 3),
 * driven through the real import path the bridge calls. The bridge itself
 * runs only in a browser, so its wiring is pinned on the source in
 * embedBridge.test.ts; this suite holds the behaviour that wiring relies on.
 *
 *   - FRESH HISTORY. Before protocol 3, an open recorded an undo entry holding
 *     the PREVIOUS document's graph, and the bridge posted whatever the graph
 *     became as the new document's module: one Undo after the host opened
 *     shader B over shader A put A's graph into B's asset (SuperWXR's shipped
 *     48 KB day-night sky was replaced by another shader's 3 KB graph). A bare
 *     module's one entry is recorded LATER, by the sync engine's code→graph
 *     pass (doCodeSync's pushHistory), so clearing the history at the open
 *     was not enough: the request it makes says not to record.
 *   - THE HOST'S LOOK. An empty `ui` block applies nothing, which is how the
 *     bridge opens a document once the host has given a theme.
 *   - THE ROUND TRIP. With the host's theme kept, the store's look is no
 *     longer the document's; the document's own `ui` block swapped back into
 *     the project is all it takes for a mere open to post the text it opened.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { useAppStore, cancelPendingGraphSave, VR_HEADSETS } from '@/store/useAppStore';
import { setCostOverrides } from '@/utils/nodeCost';
import { setDeviceBudget } from '@/utils/budgetPoints';
import { HISTORY_IDLE, makeEdge, makeNode } from '@/test-utils';
import { importShaderText, preloadShaderImport } from '@/engine/projectImport';
import { buildExportModule, buildProjectState } from '@/engine/exportShader';
import { embedProjectState, extractProjectState, type FastShadersProject } from '@/engine/fastShadersProject';
import { graphToCode } from '@/engine/graphToCode';

/** A bare shaderloader module: no project block, so its graph comes from code. */
const BARE = `import { color } from "three/tsl";

export default function (params) {
  return { colorNode: color(0xff8800), transparent: true };
}
`;

type Parsed = NonNullable<ReturnType<typeof extractProjectState>>;

/** What the bridge imports once the host has a theme (EmbedBridge.tsx `withoutLook`). */
const withoutLook = (parsed: Parsed): Parsed => ({ ...parsed, project: { ...parsed.project, ui: {} } });

const graph = () => {
  const nodes = [makeNode('c1', 'color', { hex: '#ff8800' }), makeNode('out', 'output')];
  const edges = [makeEdge('c1', 'out', 'out', 'color')];
  return { nodes, edges, code: graphToCode(nodes, edges).code };
};

/** The text EXPORT writes for what the store holds now (the bridge's module, before its swap). */
const exported = () => embedProjectState(buildExportModule({ inlineImages: true }), buildProjectState());

/** Two entries to undo and one to redo: what an editor holds after some work. */
function someHistory(): void {
  useAppStore.getState().pushHistory();
  useAppStore.getState().pushHistory();
  useAppStore.setState({ future: [useAppStore.getState().past[0]] });
}

const LOOK_KEYS = [
  'codeEditorTheme', 'nodeEditorBgColor', 'nodeEditorBgColorLight', 'nodeEditorBgColorDark',
  'costColorLow', 'costColorHigh', 'shaderName', 'selectedHeadsetId',
] as const;
let before: Partial<ReturnType<typeof useAppStore.getState>> = {};

beforeAll(async () => {
  // buildProjectState and the import read and write the preview prefs in
  // localStorage; absent, both sides of every round trip read the same nothing.
  vi.stubGlobal('localStorage', undefined);
  const s = useAppStore.getState();
  before = Object.fromEntries(LOOK_KEYS.map((k) => [k, s[k]]));
  // The converter chunk, as the bridge awaits it before every open.
  await preloadShaderImport();
});

beforeEach(() => {
  cancelPendingGraphSave();
  useAppStore.setState({
    ...graph(),
    drawings: [],
    shaderPalettes: [],
    syncSource: 'graph',
    codeSyncRequested: false,
    codeSyncHistory: true,
    codeSyncImported: false,
    past: [],
    future: [],
    ...HISTORY_IDLE,
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
  cancelPendingGraphSave();
  useAppStore.setState({
    ...before,
    nodes: [], edges: [], code: '', drawings: [], shaderPalettes: [],
    syncSource: 'graph', codeSyncRequested: false, codeSyncHistory: true, codeSyncImported: false,
    past: [], future: [], ...HISTORY_IDLE,
  });
  // Every opened block selected its device (`setSelectedHeadsetId`), which
  // writes the cost module's table and the points' budget: a measured profile
  // another suite left selected re-priced libraryPricingKey.test.ts. Back to
  // the defaults every cost suite resets to.
  setCostOverrides(null);
  setDeviceBudget(VR_HEADSETS[0].maxPoints);
});

describe('a host open starts a fresh undo history', () => {
  it('a project block: nothing to undo or redo after it, and Undo then changes nothing', () => {
    const text = exported();
    someHistory();
    expect(importShaderText(text, { freshHistory: true })).toBe('project');
    const s = useAppStore.getState();
    expect(s.past).toHaveLength(0);
    expect(s.future).toHaveLength(0);
    const nodes = s.nodes;
    s.undo();
    expect(useAppStore.getState().nodes === nodes).toBe(true);
  });

  it('a bare module: empty at once, and the code→graph pass it asks for records nothing', () => {
    someHistory();
    expect(importShaderText(BARE, { freshHistory: true })).toBe('script');
    const s = useAppStore.getState();
    expect(s.past).toHaveLength(0);
    expect(s.future).toHaveLength(0);
    // The graph itself comes from the sync engine's pass, which lands after
    // this: it must not record the entry that would hold the old graph — and
    // is an import's, carrying nothing of that graph.
    expect(s.codeSyncRequested).toBe(true);
    expect(s.codeSyncHistory).toBe(false);
    expect(s.codeSyncImported).toBe(true);
    expect(s.syncSource).toBe('code');
  });

  it('an open that throws leaves the history exactly as it was', () => {
    someHistory();
    const { past, future } = useAppStore.getState();
    const broken = {
      project: { version: 1, shaderName: 'Broken', graph: { nodes: null, edges: [] }, preview: {}, ui: {} },
      stripped: '',
    } as unknown as Parsed;
    expect(() => importShaderText('', { parsed: broken, freshHistory: true })).toThrow();
    expect(useAppStore.getState().past === past).toBe(true);
    expect(useAppStore.getState().future === future).toBe(true);
  });

  it('a block that throws while it is read writes NOTHING: name, device, look, notices, history, model', () => {
    // The gate (extractProjectState) is there so no block does; handed past
    // it, one that does shows the order: every write comes after the read.
    // Before, the name, the device, the look and the preview settings were
    // written first and stayed — the embed bridge put back only two of them.
    someHistory();
    const mesh = { kind: 'obj', name: 'held.obj', text: 'v 0 0 0' } as never;
    useAppStore.setState({ shaderName: 'Held', previewMesh: mesh });
    const before = useAppStore.getState();
    const other = VR_HEADSETS.find((h) => h.id !== before.selectedHeadsetId)!.id;
    const broken = {
      project: {
        version: 1,
        shaderName: 'Broken',
        selectedHeadsetId: other,
        graph: { nodes: null, edges: [] },
        preview: { geometry: 'torus', uniformValues: { property1: 0.5 } },
        ui: { codeEditorTheme: before.codeEditorTheme === 'vs' ? 'vs-dark' : 'vs', nodeEditorBgColor: '#123456', costColorLow: '#00ff00', costColorHigh: '#0000ff' },
      },
      stripped: '',
    } as unknown as Parsed;
    // Not the fresh history: a FastShaders import records, and records nothing here either.
    expect(() => importShaderText('', { parsed: broken })).toThrow();
    const s = useAppStore.getState();
    for (const key of [...LOOK_KEYS, 'past', 'future', 'pendingLimitNotices', 'previewMesh', 'nodes', 'edges', 'documentEpoch'] as const) {
      expect(s[key] === before[key], key).toBe(true);
    }
  });

  it('without it — a dropped file\'s Open, IMPORT — an import keeps FastShaders\' own history', () => {
    const text = exported();
    someHistory();
    importShaderText(text);
    // One entry for the import itself, the redo stack gone with the edit.
    expect(useAppStore.getState().past).toHaveLength(3);
    expect(useAppStore.getState().future).toHaveLength(0);

    someHistory();
    const { past } = useAppStore.getState();
    importShaderText(BARE);
    // A bare script's entry is its code→graph pass's, which records as ever.
    expect(useAppStore.getState().past === past).toBe(true);
    expect(useAppStore.getState().codeSyncRequested).toBe(true);
    expect(useAppStore.getState().codeSyncHistory).toBe(true);
    expect(useAppStore.getState().codeSyncImported).toBe(true);
  });

  it('every code-sync request says whether its pass records, so a no-history one never lends its answer', () => {
    useAppStore.getState().requestCodeSync({ history: false });
    expect(useAppStore.getState().codeSyncHistory).toBe(false);
    // CodeEditor's Apply: a plain request, which records.
    useAppStore.getState().requestCodeSync();
    expect(useAppStore.getState().codeSyncHistory).toBe(true);
    useAppStore.getState().requestCodeSync({ history: true });
    expect(useAppStore.getState().codeSyncHistory).toBe(true);
  });

  it('…and whether it is an import\'s, so an Apply after one is never taken for another document', () => {
    useAppStore.getState().requestCodeSync({ history: false, imported: true });
    expect(useAppStore.getState().codeSyncImported).toBe(true);
    useAppStore.getState().requestCodeSync();
    expect(useAppStore.getState().codeSyncImported).toBe(false);
    useAppStore.setState({ codeSyncRequested: false });
  });
});

describe('a host open refuses a bare module whose conversion would lose code (refuseDroppedCode)', () => {
  /** A hand-written module with a constant at module scope, which only the default function's body escapes. */
  const LOSSY = `import { color, float } from 'three/tsl';
const K = 0.5;
export default function() {
  return { colorNode: color('#cfd3d8').mul(float(K)) };
}
`;

  it('throws before anything is written: the name, the graph, the code, the model, the history, the document count', () => {
    someHistory();
    const mesh = { kind: 'obj', name: 'held.obj', text: 'v 0 0 0' } as never;
    useAppStore.setState({ shaderName: 'Held', previewMesh: mesh });
    const before = useAppStore.getState();
    expect(() => importShaderText(LOSSY, { nameFallback: 'K', freshHistory: true, refuseDroppedCode: true })).toThrow(
      "only the default function's body can be shown as a graph, and this would be lost: const K = 0.5;",
    );
    const s = useAppStore.getState();
    for (const key of ['shaderName', 'nodes', 'edges', 'code', 'previewMesh', 'past', 'future', 'documentEpoch', 'codeSyncRequested', 'syncSource', 'shaderPalettes'] as const) {
      expect(s[key] === before[key], key).toBe(true);
    }
  });

  it('a module that loses nothing opens as ever with it, a block is never refused, and no other caller asks', () => {
    expect(importShaderText(BARE, { freshHistory: true, refuseDroppedCode: true })).toBe('script');
    expect(importShaderText(exported(), { freshHistory: true, refuseDroppedCode: true })).toBe('project');
    // A dropped file's Open, IMPORT: converted as before, its loss in the
    // code panel for the user to see.
    expect(importShaderText(LOSSY)).toBe('script');
    useAppStore.setState({ codeSyncRequested: false });
  });
});

describe('the host\'s look, and the document\'s own going back', () => {
  it('a document with its look stripped changes none of the editor\'s', () => {
    useAppStore.getState().setCodeEditorTheme('vs-dark');
    const look = () => {
      const s = useAppStore.getState();
      return { theme: s.codeEditorTheme, canvas: s.nodeEditorBgColor, low: s.costColorLow, high: s.costColorHigh };
    };
    const held = look();
    const text = embedProjectState(buildExportModule({ inlineImages: true }), {
      ...buildProjectState(),
      ui: { nodeEditorBgColor: '#123456', codeEditorTheme: 'vs', costColorLow: '#00ff00', costColorHigh: '#0000ff' },
    });
    importShaderText(text, { parsed: withoutLook(extractProjectState(text)!), freshHistory: true });
    expect(look()).toEqual(held);
    // The same document with its look (protocol 2, or before the host sent a theme) turns the editor light.
    importShaderText(text, { parsed: extractProjectState(text), freshHistory: true });
    expect(useAppStore.getState().codeEditorTheme).toBe('vs');
  });

  it('a mere open goes back as the text it arrived as, whatever theme the editor is in', () => {
    // A document a full FastShaders saved in LIGHT mode, as an export of an
    // opened file is (one import normalises what it restores).
    useAppStore.getState().setCodeEditorTheme('vs');
    importShaderText(exported(), { freshHistory: true });
    const saved = exported();
    expect(extractProjectState(saved)!.project.ui.codeEditorTheme).toBe('vs');

    // The host is DARK, and opens it.
    useAppStore.getState().setCodeEditorTheme('vs-dark');
    importShaderText(saved, { parsed: withoutLook(extractProjectState(saved)!), freshHistory: true });
    expect(useAppStore.getState().codeEditorTheme).toBe('vs-dark');

    // The store's look is the host's now: EXPORT's text differs only there…
    const module = buildExportModule({ inlineImages: true });
    const project: FastShadersProject = buildProjectState();
    expect(project.ui.codeEditorTheme).toBe('vs-dark');
    expect(embedProjectState(module, project)).not.toBe(saved);
    // …and the bridge's swap — the document's own block, assigned in place —
    // posts the very text the host holds, which the dedupe then swallows.
    project.ui = extractProjectState(saved)!.project.ui;
    expect(embedProjectState(module, project)).toBe(saved);
  });

  it('a document that carried no ui block goes back with none', () => {
    importShaderText(exported(), { freshHistory: true });
    const bare: Partial<FastShadersProject> = buildProjectState();
    delete bare.ui;
    const saved = embedProjectState(buildExportModule({ inlineImages: true }), bare as FastShadersProject);
    expect(saved).not.toContain('"ui"');

    useAppStore.getState().setCodeEditorTheme('vs-dark');
    importShaderText(saved, { parsed: withoutLook(extractProjectState(saved)!), freshHistory: true });
    const project: Partial<FastShadersProject> = buildProjectState();
    delete project.ui;
    expect(embedProjectState(buildExportModule({ inlineImages: true }), project as FastShadersProject)).toBe(saved);
  });
});
