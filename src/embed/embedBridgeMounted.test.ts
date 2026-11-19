/**
 * The embed bridge (embed/EmbedBridge.tsx) and the sync engine MOUNTED with
 * the real React renderer — react-dom/client on a stand-in container, the
 * technique of settledPreview.test.ts — with the host's messages dispatched on
 * a stand-in window, the real import, and the real code→graph pass with its
 * real parser chunk. embedBridge.test.ts pins the wiring on the source; this
 * suite holds what protocol 3's review MEASURED on the built embed:
 *
 *   - a bare module's graph is parsed in by the sync engine AFTER its open's
 *     turn, so a block opened right behind it got the bare module's graph
 *     (0–10 ms apart, chunk loaded or not), which the bridge then posted as
 *     the block's module: the host overwrote the block's asset;
 *   - an open cancelled whatever broadcast was pending, so the last edit
 *     before it (a node deleted 100 ms earlier) never reached the host, nor
 *     did the first post of a file opened inside the editor;
 *   - a block that lacked a preview key posted back what the PREVIOUS
 *     document left in the shared preview settings, on a mere open;
 *   - a host open's fresh history held at the open, but an edit of the graph
 *     still on screen while the bare module's pass was on its way recorded an
 *     entry that undid back to the previous document;
 *   - a bare module that does not parse (a syntax error: no graph written)
 *     took the host's id at once, so the canvas kept the PREVIOUS document's
 *     graph, under the new file's name, and the next post filed that graph
 *     under the new id: the host's hand-written module was replaced by
 *     another shader's export. Nor did a host ever learn an open failed;
 *   - a hand-written bare module with code at module scope (`const K`) opened
 *     with no error, its conversion having left that code out, and went back
 *     to the host reading `K` with nothing declaring it;
 *   - a bare module opened over a block with ink and a group frame went back
 *     carrying both: its code→graph pass paired with the previous graph;
 *   - a file opened inside the editor while a bare module's graph was on its
 *     way named the PREVIOUS document as the one it replaced, and the host,
 *     told that open had failed, dropped it.
 *
 * Only `setTimeout` is faked: React's scheduler (setImmediate), microtasks and
 * the chunk imports run for real, and `settle` turns the event loop until no
 * pass is on its way before it fires the bridge's trailing settle.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useAppStore, cancelPendingGraphSave, VR_HEADSETS } from '@/store/useAppStore';
import { setCostOverrides } from '@/utils/nodeCost';
import { setDeviceBudget } from '@/utils/budgetPoints';
import { useSyncEngine } from '@/hooks/useSyncEngine';
import { importShaderText, preloadShaderImport } from '@/engine/projectImport';
import { loadUnknownExpressionValidator } from '@/engine/unknownExpression';
import { panelCodegen } from '@/engine/panelCode';
import { extractProjectState } from '@/engine/fastShadersProject';
import { HISTORY_IDLE, makeEdge, makeNode, stubLocalStorage } from '@/test-utils';
import type { AppNode } from '@/types';
import { EmbedBridge } from './EmbedBridge';
import { embedDocument, embedDocumentOpened, MINTED_ID_PREFIX } from './embedDocument';

const ORIGIN = 'http://host.test';
/** The bridge's trailing settle (SETTLE_MS) and a margin. */
const SETTLE = 400;

const BEGIN = '/* FASTSHADERS_PROJECT_V1';
const END = 'END_FASTSHADERS_PROJECT */';
/** A module and its block, apart: the block as JSON, the code before it as written. */
const split = (text: string) => {
  const at = text.indexOf(BEGIN);
  return { code: text.slice(0, at), project: JSON.parse(text.slice(at + BEGIN.length, text.indexOf(END)).trim()) as Record<string, unknown> };
};
/** …and together again, the way embedProjectState writes them. */
const join = (code: string, project: Record<string, unknown>) =>
  `${code}${BEGIN}\n${JSON.stringify(project, null, 2).replace(/\*\//g, '*\\u002F')}\n${END}\n`;

/** A bare shaderloader module: no block, so its graph is the code→graph pass's. */
const bare = (hex: string) => `import { color } from "three/tsl";\n\nexport default function (params) {\n  return { colorNode: color(0x${hex}) };\n}\n`;

/** SuperWXR's New shader, verbatim (its shaderChoice.js SHADER_TEMPLATE): a bare module that parses. */
const TEMPLATE = `import { color } from 'three/tsl';

export const threeRevision = '184';

export const schema = {};

export default function() {
  const result = color('#cfd3d8');
  return { colorNode: result };
}
`;
/** The same, hand-edited with a comma missing: converted, it parses to NO graph (one blocking error). */
const BROKEN = TEMPLATE.replace('return { colorNode: result };', 'return { colorNode: result transparent: true };');
/** That error's message (the converted module's `(4:25)` is not the file's line, so it is not sent). */
const BROKEN_REASON = 'Unexpected token, expected ","';

/**
 * Hand-written modules whose conversion LOSES code at module scope (the
 * review's three, measured): each parsed with no error, and went back to the
 * host without what its function reads.
 */
const LOSSY = {
  constant: `import { color, float } from 'three/tsl';\nconst K = 0.5;\nexport default function() {\n  return { colorNode: color('#cfd3d8').mul(float(K)) };\n}\n`,
  node: `import { color } from 'three/tsl';\nconst base = color('#cfd3d8');\nexport default function() {\n  return { colorNode: base };\n}\n`,
  helper: `import { color } from 'three/tsl';\nfunction tint(a) {\n  return a.mul(2);\n}\nexport default function() {\n  return { colorNode: tint(color('#cfd3d8')) };\n}\n`,
};
/** The line each is refused for, as the host is told. */
const lost = (line: string) => `only the default function's body can be shown as a graph, and this would be lost: ${line}`;

interface Posted {
  type: string;
  module: string;
  name: string;
  id: string | null;
  replaced?: string | null;
}

interface OpenFailed {
  type: 'superwxr:open-failed';
  id: string | null;
  reason: string;
  retry: boolean;
}

const has = (nodes: AppNode[], hex: string) => JSON.stringify(nodes).toLowerCase().includes(hex);
const blockGraph = (m: Posted) => extractProjectState(m.module)!.project.graph.nodes;

let posts: Posted[] = [];
let root: Root | null = null;
let consoleError: ReturnType<typeof vi.spyOn>;
/** Quiet: the bridge says a failed open in a warning, which a test asserts where it expects one. */
let consoleWarn: ReturnType<typeof vi.spyOn>;
/** The device the store held before a test: every opened block selects its own (`setSelectedHeadsetId`). */
let device: { selectedHeadsetId: string; costProfiles: ReturnType<typeof useAppStore.getState>['costProfiles'] };

/** Every `superwxr:module` the host got for `id`. */
const modules = (id: string | null) => posts.filter((m) => m.type === 'superwxr:module' && m.id === id);
/** Every `superwxr:open-failed` the host got, exactly as it got it. */
const failures = () => posts.filter((m) => m.type === 'superwxr:open-failed') as unknown as OpenFailed[];
/** The bridge's own warnings, each the reason of a failed open. */
const warned = () => consoleWarn.mock.calls.map((c: unknown[]) => c.join(' '));

/** A host message, as the parent page posts it. */
const send = (data: Record<string, unknown>) => {
  window.dispatchEvent(Object.assign(new Event('message'), { data, origin: ORIGIN, source: window.parent }));
};
const open = (module: string, id: string, name = `${id}.js`) => send({ type: 'superwxr:open', module, name, id });

/** Real turns of the event loop: chunk imports, React's scheduler, microtasks. */
const turns = async (n = 25) => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r));
};
const passPending = () => {
  const s = useAppStore.getState();
  return s.codeSyncRequested || s.syncInProgress;
};
/** What moves while the editor works: the posts, the graph, the document, a pass. */
const motion = () => {
  const s = useAppStore.getState();
  return [posts.length, s.nodes, s.code, s.shaderName, embedDocument().id, passPending()];
};
/**
 * Until nothing is on its way: every pass landed, every settle (the bridge's,
 * the autosave's) fired, and nothing moved for three rounds of real turns —
 * a host open's turn awaits the chunk imports, which `beforeAll` loaded so
 * they resolve within them.
 */
async function settle() {
  let still = 0;
  let before = motion();
  for (let round = 0; round < 400; round++) {
    await turns();
    const now = motion();
    const moved = now.some((v, i) => v !== before[i]);
    before = now;
    if (passPending() || moved) {
      still = 0;
      continue;
    }
    if (vi.getTimerCount() > 0) {
      still = 0;
      vi.advanceTimersByTime(SETTLE);
      continue;
    }
    if (++still >= 3) return;
  }
  throw new Error('the editor never settled');
}

/** The colour node of a graph made of one colour into the Output: the editor's normal form of it is read back below. */
function seed(hex: string) {
  const nodes = [makeNode('c1', 'color', { hex: `#${hex}` }), makeNode('out', 'output')];
  const edges = [makeEdge('c1', 'out', 'out', 'color')];
  useAppStore.setState({
    nodes,
    edges,
    code: panelCodegen(nodes, edges, false).result.code,
    // The block every fixture is built from names this device, and opening
    // one selects it: the first headset, priced by the base table, never a
    // measured profile another suite left selected.
    selectedHeadsetId: VR_HEADSETS[0].id,
    costProfiles: [],
    drawings: [],
    shaderPalettes: [],
    syncSource: 'graph',
    syncInProgress: false,
    codeSyncRequested: false,
    codeSyncHistory: true,
    codeSyncImported: false,
    nodePreview: null,
    past: [],
    future: [],
    ...HISTORY_IDLE,
  });
}

/**
 * Mounted on a one-colour graph; the module the editor posts for it at mount
 * (the boot graph, id null) opened back as `normal-0` and read again, so the
 * text is EXACTLY what this editor writes for that document. Variants are that
 * text with another colour (in the code and the block alike), name or block
 * keys: still what it writes, so a mere open of one posts nothing back.
 */
async function mount(): Promise<string> {
  seed('2266ee');
  root = createRoot({
    nodeType: 1,
    tagName: 'DIV',
    namespaceURI: null,
    addEventListener() {},
    removeEventListener() {},
    ownerDocument: { addEventListener() {}, removeEventListener() {} },
  } as unknown as Element);
  function Sync() {
    useSyncEngine();
    return null;
  }
  root.render(createElement(Fragment, null, createElement(Sync), createElement(EmbedBridge)));
  await settle();
  expect(posts[0]).toEqual({ type: 'superwxr:ready', protocol: 3 });
  const boot = modules(null)[0];
  expect(boot, 'the mount-time broadcast').toBeDefined();
  open(boot.module, 'normal-0');
  await settle();
  const normalized = modules('normal-0');
  const normal = normalized.length > 0 ? normalized[normalized.length - 1].module : boot.module;
  posts = [];
  return normal;
}

/** `text` with its colour, name or block keys changed: the same editor's text for that document. */
function variant(text: string, hex: string, block: Record<string, unknown> = {}): string {
  const recoloured = text.replace(/2266ee/gi, hex);
  const { code, project } = split(recoloured);
  return join(code, { ...project, ...block });
}

beforeAll(async () => {
  // Every chunk a host open and its pass import (the converter, the parser,
  // the expression validator), loaded once: from then on each resolves within
  // the turns `settle` waits, never on file I/O it cannot see.
  await Promise.all([preloadShaderImport(), import('@/engine/codeToGraph'), loadUnknownExpressionValidator()]);
});

beforeEach(() => {
  posts = [];
  const s = useAppStore.getState();
  device = { selectedHeadsetId: s.selectedHeadsetId, costProfiles: s.costProfiles };
  embedDocumentOpened(null);
  cancelPendingGraphSave();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', false);
  stubLocalStorage();
  vi.stubGlobal(
    'window',
    Object.assign(new EventTarget(), {
      parent: { postMessage: (m: Posted, origin: string) => { if (origin === ORIGIN) posts.push(m); } },
      location: { origin: ORIGIN, href: `${ORIGIN}/?embed=1`, search: '?embed=1' },
      // React DOM's commit reads it (focus bookkeeping).
      HTMLIFrameElement: class {},
    }),
  );
  consoleError = vi.spyOn(console, 'error');
  consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(async () => {
  // Clean up FIRST and assert last: under `isolate: false` the stubs, the fake
  // timers and the store ride into whichever file this worker runs next.
  root?.unmount();
  root = null;
  await turns(5);
  cancelPendingGraphSave();
  const errors = consoleError.mock.calls.slice();
  consoleError.mockRestore();
  const warnings = warned();
  consoleWarn.mockRestore();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  embedDocumentOpened(null);
  seed('ff8800');
  useAppStore.setState({ nodes: [], edges: [], code: '', past: [], future: [], ...device, ...HISTORY_IDLE });
  // Selecting a device writes the cost module's table and the points' budget,
  // which outlive the store's fields: back to the defaults every cost suite
  // resets to (a profile's table left here re-priced libraryPricingKey.test.ts).
  setCostOverrides(null);
  setDeviceBudget(VR_HEADSETS[0].maxPoints);
  // Nothing in these flows is an error: no React misuse, and a test that
  // makes an open throw takes the one line it logs. A warning is only ever a
  // failed open's.
  expect(errors).toEqual([]);
  for (const w of warnings) expect(w.startsWith('[FastShaders embed] open failed: ')).toBe(true);
});

describe('the embed bridge with the sync engine, mounted', () => {
  it('a bare module opened with a block right behind it: the block keeps its graph, each document is posted under its own id', async () => {
    const normal = await mount();
    const B = variant(normal, 'aa33cc', { shaderName: 'Block B' });
    // As SuperWXR sends two quick selections: back to back.
    open(bare('11aa55'), 'asset-A', 'Bare A.js');
    open(B, 'asset-B');
    await settle();

    const s = useAppStore.getState();
    expect(embedDocument().id).toBe('asset-B');
    expect(has(s.nodes, 'aa33cc')).toBe(true);
    expect(has(s.nodes, '11aa55')).toBe(false);
    expect(s.past).toHaveLength(0);
    expect(s.future).toHaveLength(0);
    // B was a mere open: nothing goes back for it, A's graph least of all.
    expect(modules('asset-B')).toEqual([]);
    // A's converted module (its first post: the block appended) went under A's
    // own id, with A's graph, before B replaced it.
    const a = modules('asset-A');
    expect(a).toHaveLength(1);
    expect(has(blockGraph(a[0]), '11aa55')).toBe(true);
    expect(has(blockGraph(a[0]), 'aa33cc')).toBe(false);
  });

  it('the last edit before a host open reaches the host under its own document', async () => {
    const normal = await mount();
    open(variant(normal, 'aa33cc', { shaderName: 'Doc A' }), 'asset-A');
    await settle();
    expect(modules('asset-A')).toEqual([]);

    // An edit, and the host opens another shader inside its trailing settle.
    const c1 = useAppStore.getState().nodes.find((n) => n.data.registryType === 'color')!;
    useAppStore.getState().updateNodeData(c1.id, { values: { hex: '#123456' } });
    await turns();
    vi.advanceTimersByTime(100);
    open(variant(normal, '44bb44', { shaderName: 'Doc B' }), 'asset-B');
    await settle();

    const a = modules('asset-A');
    expect(a).toHaveLength(1);
    expect(has(blockGraph(a[0]), '123456')).toBe(true);
    expect(a[0].module).toContain('0x123456');
    expect(embedDocument().id).toBe('asset-B');
    expect(has(useAppStore.getState().nodes, '44bb44')).toBe(true);
    expect(modules('asset-B')).toEqual([]);
  });

  it('a bare file opened INSIDE the editor right before a host open is posted, converted, under its minted id', async () => {
    const normal = await mount();
    open(variant(normal, 'aa33cc', { shaderName: 'Doc A' }), 'asset-A');
    await settle();

    // IMPORT / a dropped file's Open: another document, an id minted for it.
    importShaderText(bare('11aa55'), { nameFallback: 'Dropped' });
    const minted = embedDocument().id!;
    expect(minted.startsWith(MINTED_ID_PREFIX)).toBe(true);
    open(variant(normal, '44bb44', { shaderName: 'Doc B' }), 'asset-B');
    await settle();

    const dropped = modules(minted);
    expect(dropped).toHaveLength(1);
    expect(dropped[0].replaced).toBe('asset-A');
    expect(dropped[0].name).toBe('Dropped');
    // Its graph, not the one on screen before its pass landed.
    expect(has(blockGraph(dropped[0]), '11aa55')).toBe(true);
    expect(has(blockGraph(dropped[0]), 'aa33cc')).toBe(false);
    expect(embedDocument().id).toBe('asset-B');
    expect(has(useAppStore.getState().nodes, '44bb44')).toBe(true);
    expect(has(useAppStore.getState().nodes, '11aa55')).toBe(false);
  });

  it('a mere open posts nothing back, whatever preview settings the document before it left', async () => {
    const normal = await mount();
    const plain = { uniformValues: {}, uniformBounds: {}, playing: false };
    const P = variant(normal, 'aa33cc', { shaderName: 'Plain', preview: plain });
    const X = variant(normal, '44bb44', {
      shaderName: 'Cam',
      preview: { geometry: 'torus', lighting: 'studio', uniformValues: { property1: 0.5 }, uniformBounds: {}, cameraPos: { x: 1, y: 2, z: 3 } },
    });
    open(X, 'asset-X');
    await settle();
    open(P, 'asset-P');
    await settle();
    expect(modules('asset-X')).toEqual([]);
    expect(modules('asset-P')).toEqual([]);

    // Its next edit goes back with ITS preview block, none of X's.
    const c1 = useAppStore.getState().nodes.find((n) => n.data.registryType === 'color')!;
    useAppStore.getState().updateNodeData(c1.id, { values: { hex: '#123456' } });
    await settle();
    const p = modules('asset-P');
    expect(p).toHaveLength(1);
    expect(extractProjectState(p[0].module)!.project.preview).toEqual(plain);

    // A bare module carries none, so its converted module has no preview key.
    open(bare('11aa55'), 'asset-bare');
    await settle();
    const b = modules('asset-bare');
    expect(b).toHaveLength(1);
    expect('preview' in extractProjectState(b[0].module)!.project).toBe(false);
    expect('ui' in extractProjectState(b[0].module)!.project).toBe(false);
  });

  it('an open waits for a code→graph pass already on its way, and gives up after PASS_WAIT_MS', async () => {
    // Under node a loaded chunk's import resolves within microtasks, so the
    // pass is held here by hand: `syncInProgress` armed as the sync engine
    // arms it while its parser chunk loads (in Chrome even a loaded one
    // resolved only after the next host message).
    const normal = await mount();
    useAppStore.setState({ syncInProgress: true });
    open(variant(normal, 'aa33cc', { shaderName: 'Block B' }), 'asset-B');
    await turns(60);
    expect(embedDocument().id).toBe('normal-0');
    expect(has(useAppStore.getState().nodes, 'aa33cc')).toBe(false);
    // It lands: the open goes ahead.
    useAppStore.setState({ syncInProgress: false });
    await settle();
    expect(embedDocument().id).toBe('asset-B');
    expect(has(useAppStore.getState().nodes, 'aa33cc')).toBe(true);

    // One that never lands holds the next open PASS_WAIT_MS (5 s) at most;
    // the store's documentEpoch keeps such a pass from writing when it does.
    useAppStore.setState({ syncInProgress: true });
    open(variant(normal, '44bb44', { shaderName: 'Block C' }), 'asset-C');
    await turns(60);
    vi.advanceTimersByTime(4900);
    await turns(60);
    expect(embedDocument().id).toBe('asset-B');
    vi.advanceTimersByTime(200);
    await turns(60);
    expect(embedDocument().id).toBe('asset-C');
    expect(has(useAppStore.getState().nodes, '44bb44')).toBe(true);
    useAppStore.setState({ syncInProgress: false });
    await settle();
  });

  it('nothing is posted while a bare module\'s graph is on its way: the settle waits for it to land', async () => {
    await mount();
    // The bridge's trailing settle fires while the pass waits for its parser
    // chunk (a slow device): the store holds the new code over the previous
    // graph then, and a post filed that graph under the new id.
    let firedMidPass = false;
    const stop = useAppStore.subscribe((s, prev) => {
      if (s.syncInProgress && !prev.syncInProgress) {
        stop();
        vi.advanceTimersByTime(SETTLE);
        firedMidPass = useAppStore.getState().syncInProgress;
      }
    });
    open(bare('11aa55'), 'asset-A');
    await settle();
    expect(firedMidPass).toBe(true);
    const a = modules('asset-A');
    expect(a).toHaveLength(1);
    expect(has(blockGraph(a[0]), '11aa55')).toBe(true);
    expect(has(blockGraph(a[0]), '2266ee')).toBe(false);
  });

  it('a host-opened bare module leaves no history, even with an edit recorded while its graph was on its way', async () => {
    await mount();
    useAppStore.getState().pushHistory();
    // The graph still on screen is the previous document's: an edit of it
    // (a node dragged) records an entry while the pass waits for its chunk.
    let recordedMidPass = -1;
    const stop = useAppStore.subscribe((s, prev) => {
      if (s.syncInProgress && !prev.syncInProgress) {
        stop();
        useAppStore.getState().pushHistory();
        recordedMidPass = useAppStore.getState().past.length;
      }
    });
    open(bare('11aa55'), 'asset-A');
    await settle();
    expect(recordedMidPass).toBe(1);
    const s = useAppStore.getState();
    expect(has(s.nodes, '11aa55')).toBe(true);
    expect(s.past).toHaveLength(0);
    expect(s.future).toHaveLength(0);
  });

  /**
   * Runs `replace` the moment the bare module's pass has armed `syncInProgress`
   * and waits for its parser chunk — deterministically inside the window the
   * review measured (the bridge's own opens now wait their turn, so the
   * document is replaced here directly, the way a file opened inside the
   * editor does).
   */
  async function replaceMidPass(replace: () => void): Promise<void> {
    let midPass = false;
    const stop = useAppStore.subscribe((s, prev) => {
      if (s.syncInProgress && !prev.syncInProgress) {
        stop();
        replace();
        midPass = useAppStore.getState().syncInProgress;
      }
    });
    importShaderText(bare('11aa55'), { freshHistory: true });
    await settle();
    expect(midPass).toBe(true);
  }

  it('a pass that lands after another document replaced the graph writes nothing', async () => {
    const normal = await mount();
    const B = variant(normal, 'aa33cc', { shaderName: 'Block B' });
    await replaceMidPass(() => importShaderText(B, { freshHistory: true }));
    const s = useAppStore.getState();
    expect(has(s.nodes, 'aa33cc')).toBe(true);
    expect(has(s.nodes, '11aa55')).toBe(false);
    expect(s.past).toHaveLength(0);
    expect(s.future).toHaveLength(0);
  });

  it('the same bare text opened again while its first pass is on its way is still parsed in', async () => {
    await mount();
    // The first pass is dropped (another conversion replaced the graph); the
    // second asks for the very text the first had taken, and is not taken
    // for it.
    await replaceMidPass(() => importShaderText(bare('11aa55'), { freshHistory: true }));
    const s = useAppStore.getState();
    expect(has(s.nodes, '11aa55')).toBe(true);
    expect(has(s.nodes, '2266ee')).toBe(false);
    expect(s.past).toHaveLength(0);
  });

  it('NEW while a pass is on its way: the blank document stays blank', async () => {
    await mount();
    await replaceMidPass(() => useAppStore.getState().newGraph());
    const s = useAppStore.getState();
    expect(s.nodes.map((n) => n.data.registryType)).toEqual(['output']);
    expect(has(s.nodes, '11aa55')).toBe(false);
  });

  it('a bare file opened inside the editor keeps its one undo entry, the pass\'s, as before', async () => {
    await mount();
    useAppStore.getState().pushHistory();
    const before = useAppStore.getState().past.length;
    importShaderText(bare('11aa55'), { nameFallback: 'Dropped' });
    await settle();
    expect(has(useAppStore.getState().nodes, '11aa55')).toBe(true);
    expect(useAppStore.getState().past).toHaveLength(before + 1);
  });

  it('a bare file opened inside the editor replaces the ink with the graph, and its one undo brings both back', async () => {
    await mount();
    const ink = [{ id: 'ink1', color: '#ff0000', opacity: 1, width: 2, points: [{ x: 0, y: 0 }] }] as never;
    useAppStore.setState({ drawings: ink });
    importShaderText(bare('11aa55'), { nameFallback: 'Dropped' });
    await settle();
    expect(has(useAppStore.getState().nodes, '11aa55')).toBe(true);
    // The board's drawings were the previous graph's (an import's pass carries
    // none of it), cleared as the file's graph lands…
    expect(useAppStore.getState().drawings).toEqual([]);
    // …in the write its undo entry was recorded before.
    useAppStore.getState().undo();
    await settle();
    expect(useAppStore.getState().drawings === ink).toBe(true);
    expect(has(useAppStore.getState().nodes, '2266ee')).toBe(true);
    expect(has(useAppStore.getState().nodes, '11aa55')).toBe(false);
  });
});

describe('a host open that does not become the document says so (superwxr:open-failed)', () => {
  /** Mounted, with the block B opened: the document every test below starts from. */
  async function withBlockB(): Promise<string> {
    const normal = await mount();
    open(variant(normal, 'aa33cc', { shaderName: 'Block B' }), 'asset-B');
    await settle();
    expect(embedDocument().id).toBe('asset-B');
    expect(modules('asset-B')).toEqual([]);
    return normal;
  }

  /** An edit of the graph on the canvas: its colour node set to #123456. */
  function editColour(): void {
    const c1 = useAppStore.getState().nodes.find((n) => n.data.registryType === 'color')!;
    useAppStore.getState().updateNodeData(c1.id, { values: { hex: '#123456' } });
  }

  it('a bare module that does not parse: nothing posted under either id, the host told why, the graph nobody\'s', async () => {
    await withBlockB();
    open(BROKEN, 'asset-X', 'Broken X.js');
    await settle();

    // Measured before: B's graph, under X's name, posted as X's module.
    expect(modules('asset-B')).toEqual([]);
    expect(modules('asset-X')).toEqual([]);
    // The file's own doing: the same bytes fail the same way (`retry` false).
    expect(failures()).toEqual([{ type: 'superwxr:open-failed', id: 'asset-X', reason: BROKEN_REASON, retry: false }]);
    expect(warned()).toEqual([`[FastShaders embed] open failed: ${BROKEN_REASON} (4:25)`]);
    // The canvas still shows the previous graph, which is no document now.
    const s = useAppStore.getState();
    expect(embedDocument()).toEqual({ id: null });
    expect(has(s.nodes, 'aa33cc')).toBe(true);
    expect(has(s.nodes, 'cfd3d8')).toBe(false);

    // Edits of it go to the host under id null, which files them nowhere.
    editColour();
    await settle();
    expect(modules('asset-B')).toEqual([]);
    expect(modules('asset-X')).toEqual([]);
    const nobody = modules(null);
    expect(nobody.length).toBeGreaterThan(0);
    expect(has(blockGraph(nobody[nobody.length - 1]), '123456')).toBe(true);
    expect(failures()).toHaveLength(1);
  });

  it('nothing is posted between the pass landing and the decision: a settle due at that very moment waits for it', async () => {
    await withBlockB();
    // The bridge's trailing settle (armed by the import's own writes) fired in
    // the store write that lands the graph — a microtask BEFORE the open
    // decides whose that graph is, while the id is still B's.
    let firedAtLanding = -1;
    const stop = useAppStore.subscribe((s, prev) => {
      if (!s.syncInProgress && prev.syncInProgress) {
        stop();
        const before = posts.length;
        vi.advanceTimersByTime(SETTLE);
        firedAtLanding = posts.length - before;
      }
    });
    open(TEMPLATE, 'asset-T', 'New shader.js');
    await settle();
    expect(firedAtLanding).toBe(0);
    expect(modules('asset-B')).toEqual([]);
    const t = modules('asset-T');
    expect(t).toHaveLength(1);
    expect(has(blockGraph(t[0]), 'cfd3d8')).toBe(true);
  });

  it('the same broken module opened again fails again: a text whose pass wrote no graph is parsed again, never skipped as landed', async () => {
    await withBlockB();
    open(BROKEN, 'asset-X', 'Broken X.js');
    await settle();
    // Another asset with the same bytes. The code is the text the first pass
    // took, so the sync engine's dedupe skipped it, and the skip read as a
    // graph that had landed: B's graph would have gone out as Y's module.
    open(BROKEN, 'asset-Y', 'Broken Y.js');
    await settle();
    expect(failures()).toEqual([
      { type: 'superwxr:open-failed', id: 'asset-X', reason: BROKEN_REASON, retry: false },
      { type: 'superwxr:open-failed', id: 'asset-Y', reason: BROKEN_REASON, retry: false },
    ]);
    for (const id of ['asset-B', 'asset-X', 'asset-Y']) expect(modules(id), id).toEqual([]);
    expect(embedDocument().id).toBeNull();
    expect(has(useAppStore.getState().nodes, 'aa33cc')).toBe(true);
  });

  it('a bare module that parses (SuperWXR\'s New shader) becomes the document once its graph landed, and posts its converted module', async () => {
    await withBlockB();
    open(TEMPLATE, 'asset-T', 'New shader.js');
    await settle();
    expect(failures()).toEqual([]);
    expect(embedDocument().id).toBe('asset-T');
    expect(modules('asset-B')).toEqual([]);
    const t = modules('asset-T');
    expect(t).toHaveLength(1);
    expect(t[0].name).toBe('New shader');
    // Converted: FastShaders' own module with a project block, of ITS graph.
    expect(extractProjectState(t[0].module)).not.toBeNull();
    expect(has(blockGraph(t[0]), 'cfd3d8')).toBe(true);
    expect(has(blockGraph(t[0]), 'aa33cc')).toBe(false);

    // The same file under another id: another document, so its request is
    // parsed in afresh even though the graph on the canvas already is that
    // text's — the skip would have kept whatever was drawn on T since.
    let parsed = false;
    const stop = useAppStore.subscribe((s, prev) => {
      if (s.syncInProgress && !prev.syncInProgress) parsed = true;
    });
    try {
      open(TEMPLATE, 'asset-T2', 'Copy.js');
      await settle();
    } finally {
      stop();
    }
    expect(parsed).toBe(true);
    expect(failures()).toEqual([]);
    expect(embedDocument().id).toBe('asset-T2');
    const t2 = modules('asset-T2');
    expect(t2).toHaveLength(1);
    expect(t2[0].name).toBe('Copy');
    expect(has(blockGraph(t2[0]), 'cfd3d8')).toBe(true);
    expect(modules('asset-T')).toHaveLength(1);
  });

  it('a block whose import throws: the host is told, and the document it held keeps its id, graph and name', async () => {
    const normal = await withBlockB();
    // No block that passes extractProjectState's gate is known to throw (the
    // gate is there so none does), so the throw is put in by hand where a
    // corrupt block's comes: inside its apply, after it renamed the editor.
    const real = useAppStore.getState().setSelectedHeadsetId;
    useAppStore.setState({ setSelectedHeadsetId: () => { throw new Error('a corrupt block'); } });
    try {
      open(variant(normal, '44bb44', { shaderName: 'Block C' }), 'asset-C');
      await settle();
    } finally {
      useAppStore.setState({ setSelectedHeadsetId: real });
    }
    expect(failures()).toEqual([{ type: 'superwxr:open-failed', id: 'asset-C', reason: 'a corrupt block', retry: false }]);
    // An expected outcome, said to the host: a warning, never an error (a
    // host's test runner fails on one).
    expect(consoleError).not.toHaveBeenCalled();
    expect(warned()).toEqual(['[FastShaders embed] open failed: Error: a corrupt block']);

    const s = useAppStore.getState();
    expect(embedDocument().id).toBe('asset-B');
    expect(s.shaderName).toBe('Block B');
    expect(has(s.nodes, 'aa33cc')).toBe(true);
    expect(has(s.nodes, '44bb44')).toBe(false);
    // Nothing went back: the name the half-applied block wrote is put back,
    // or B's next post renamed B after C.
    expect(modules('asset-B')).toEqual([]);
    expect(modules('asset-C')).toEqual([]);
    // B's edits are still B's.
    editColour();
    await settle();
    const b = modules('asset-B');
    expect(b).toHaveLength(1);
    expect(b[0].name).toBe('Block B');
    expect(has(blockGraph(b[0]), '123456')).toBe(true);
  });

  it('an open with no module text: the editor keeps its document, and the host is told in turn', async () => {
    await withBlockB();
    send({ type: 'superwxr:open', module: '', name: 'Empty.js', id: 'asset-E' });
    send({ type: 'superwxr:open', module: 42, id: 'asset-F' });
    send({ type: 'superwxr:open', module: '' });
    await settle();
    const reason = 'there was no shader module to open';
    expect(failures()).toEqual([
      { type: 'superwxr:open-failed', id: 'asset-E', reason, retry: false },
      { type: 'superwxr:open-failed', id: 'asset-F', reason, retry: false },
      { type: 'superwxr:open-failed', id: null, reason, retry: false },
    ]);
    expect(embedDocument().id).toBe('asset-B');
    expect(useAppStore.getState().shaderName).toBe('Block B');
    expect(posts.filter((m) => m.type === 'superwxr:module')).toEqual([]);
  });

  it('a bare module whose conversion would lose code is refused before anything is written: the document it held stays', async () => {
    await withBlockB();
    open(LOSSY.constant, 'asset-K', 'K.js');
    open(LOSSY.node, 'asset-N', 'N.js');
    open(LOSSY.helper, 'asset-H', 'H.js');
    await settle();
    // Measured before: no error and no warning, each became the document,
    // and its module went back without what it reads (`float(K)`, `tint(…)`
    // with nothing declaring them; `base` gone, the graph an Output alone).
    expect(failures()).toEqual([
      { type: 'superwxr:open-failed', id: 'asset-K', reason: lost('const K = 0.5;'), retry: false },
      { type: 'superwxr:open-failed', id: 'asset-N', reason: lost("const base = color('#cfd3d8');"), retry: false },
      { type: 'superwxr:open-failed', id: 'asset-H', reason: lost('function tint(a) {'), retry: false },
    ]);
    for (const id of ['asset-K', 'asset-N', 'asset-H', 'asset-B']) expect(modules(id), id).toEqual([]);
    // Refused before the import wrote anything: B is still the document, whole.
    const s = useAppStore.getState();
    expect(embedDocument().id).toBe('asset-B');
    expect(s.shaderName).toBe('Block B');
    expect(has(s.nodes, 'aa33cc')).toBe(true);
    expect(has(s.nodes, 'cfd3d8')).toBe(false);
    expect(s.syncSource).toBe('graph');
    // …and B's edits are still B's.
    editColour();
    await settle();
    const b = modules('asset-B');
    expect(b).toHaveLength(1);
    expect(b[0].name).toBe('Block B');
    expect(has(blockGraph(b[0]), '123456')).toBe(true);
  });

  it('a bare module opened over a block with ink and a group frame goes back with neither: its pass carries nothing of that graph', async () => {
    await withBlockB();
    // B's colour node framed in a group, and a stroke of ink on the board.
    const before = useAppStore.getState();
    const c1 = before.nodes.find((n) => n.data.registryType === 'color')!;
    const frame = {
      id: 'frame-b',
      type: 'group',
      position: { x: -40, y: -40 },
      data: { registryType: 'group', label: 'Frame of B', color: '#888888', width: 400, height: 300 },
    } as unknown as AppNode;
    useAppStore.setState({
      nodes: [frame, ...before.nodes.map((n) => (n.id === c1.id ? ({ ...n, parentId: 'frame-b', extent: 'parent' } as AppNode) : n))],
      drawings: [{ id: 'ink1', color: '#ff0000', opacity: 1, width: 2, points: [{ x: 0, y: 0 }, { x: 10, y: 10 }] }] as never,
    });
    await settle();

    open(TEMPLATE, 'asset-T', 'New shader.js');
    await settle();
    expect(failures()).toEqual([]);
    expect(embedDocument().id).toBe('asset-T');
    const t = modules('asset-T');
    expect(t).toHaveLength(1);
    // Measured before: `drawings: [{ id: 'ink1', … }]`, and the nodes
    // [group, output, color] — B's frame, its label, T's colour node in it.
    const project = extractProjectState(t[0].module)!.project;
    expect(project.drawings ?? []).toEqual([]);
    expect(JSON.stringify(project.graph.nodes)).not.toContain('Frame of B');
    expect(project.graph.nodes.map((n) => n.data.registryType).sort()).toEqual(['color', 'output']);
    expect(project.graph.nodes.some((n) => (n as { parentId?: string }).parentId !== undefined)).toBe(false);
    expect(has(project.graph.nodes, 'cfd3d8')).toBe(true);
    // The canvas likewise.
    const s = useAppStore.getState();
    expect(s.drawings).toEqual([]);
    expect(s.nodes.map((n) => n.data.registryType).sort()).toEqual(['color', 'output']);
  });

  it('…while the one thing it does carry, the file\'s own material settings, still arrives — and none of the block\'s', async () => {
    const normal = await mount();
    // B is double-sided and depth-writes off; the file is transparent, and says nothing of either.
    const B = variant(normal, 'aa33cc', { shaderName: 'Block B' });
    open(B, 'asset-B');
    await settle();
    const out = useAppStore.getState().nodes.find((n) => n.data.registryType === 'output')!;
    useAppStore.getState().updateNodeData(out.id, { materialSettings: { side: 'double', depthWrite: false } });
    await settle();
    open(TEMPLATE.replace('return { colorNode: result };', 'return { colorNode: result, transparent: true };'), 'asset-T', 'Glass.js');
    await settle();
    expect(failures()).toEqual([]);
    const t = modules('asset-T');
    expect(t).toHaveLength(1);
    const output = blockGraph(t[0]).find((n) => n.data.registryType === 'output')!;
    expect((output.data as { materialSettings?: unknown }).materialSettings).toEqual({ transparent: true });
    expect(t[0].module).toContain('transparent: true');
    expect(t[0].module).not.toMatch(/side:|depthWrite:/);
  });

  it('a bare module whose graph is not ready within PASS_WAIT_MS failed, and its graph landing later is nobody\'s', async () => {
    await withBlockB();
    // The pass held from starting, as a slow device holds it: `syncInProgress`
    // armed by hand the moment the import asks for it.
    let held = false;
    const stop = useAppStore.subscribe((s, prev) => {
      if (s.codeSyncRequested && !prev.codeSyncRequested) {
        stop();
        held = true;
        useAppStore.setState({ syncInProgress: true });
      }
    });
    open(TEMPLATE, 'asset-T', 'New shader.js');
    await turns(60);
    expect(held).toBe(true);
    vi.advanceTimersByTime(4900);
    await turns(60);
    // Undecided: B is gone (T's import ran) and T is not there yet — nobody's
    // id, and nothing posted under it, B's or T's.
    expect(failures()).toEqual([]);
    expect(embedDocument()).toEqual({ id: null });
    expect(modules('asset-B')).toEqual([]);
    vi.advanceTimersByTime(200);
    await turns(60);
    // Not the file's doing: it may open another time (`retry`).
    expect(failures()).toEqual([{ type: 'superwxr:open-failed', id: 'asset-T', reason: 'its graph was not ready after 5 s', retry: true }]);
    expect(embedDocument().id).toBeNull();

    // It lands after all: the file's graph, on a canvas that is nobody's.
    useAppStore.setState({ syncInProgress: false });
    await settle();
    expect(has(useAppStore.getState().nodes, 'cfd3d8')).toBe(true);
    expect(embedDocument().id).toBeNull();
    expect(modules('asset-T')).toEqual([]);
    expect(modules('asset-B')).toEqual([]);
    expect(modules(null).length).toBeGreaterThan(0);
  });

  it('a file opened inside the editor while a host-opened bare module\'s graph is on its way: that file is the document, and the open failed', async () => {
    const normal = await withBlockB();
    let midPass = false;
    const stop = useAppStore.subscribe((s, prev) => {
      if (s.syncInProgress && !prev.syncInProgress) {
        stop();
        // IMPORT / a dropped file's Open, while the pass waits for its parser chunk.
        importShaderText(variant(normal, '44bb44', { shaderName: 'Dropped D' }), { nameFallback: 'Dropped' });
        midPass = useAppStore.getState().syncInProgress;
      }
    });
    open(TEMPLATE, 'asset-T', 'New shader.js');
    await settle();
    expect(midPass).toBe(true);
    expect(failures()).toEqual([
      { type: 'superwxr:open-failed', id: 'asset-T', reason: 'another file was opened in the editor before its graph was ready', retry: true },
    ]);
    // The dropped file keeps the id minted for it, and replaced NO document
    // of the host's: B was gone with T's import, and T never became one.
    // Measured: naming B, it reached a host that had just been told T failed
    // (its own record of the editor's document emptied) and was dropped.
    const doc = embedDocument();
    expect(doc.id!.startsWith(MINTED_ID_PREFIX)).toBe(true);
    expect(doc.replaced).toBeNull();
    const d = modules(doc.id);
    expect(d).toHaveLength(1);
    expect(d[0].replaced).toBeNull();
    // After the failure, as the host must read them in that order.
    expect(posts.findIndex((m) => m.type === 'superwxr:open-failed')).toBeLessThan(posts.indexOf(d[0]));
    expect(d[0].name).toBe('Dropped D');
    expect(has(blockGraph(d[0]), '44bb44')).toBe(true);
    expect(has(useAppStore.getState().nodes, 'cfd3d8')).toBe(false);
    expect(modules('asset-T')).toEqual([]);
    expect(modules('asset-B')).toEqual([]);
  });
});
