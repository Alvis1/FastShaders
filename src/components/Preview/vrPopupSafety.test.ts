/**
 * The editor's VR popup runs `previewCode` at the app's REAL origin — after an
 * Apply or a bare-script import that is raw text the user applied or opened,
 * not the validated emission. These pins keep the popup from reaching the
 * editor window through its opener, and keep raw code from running there
 * unasked:
 *
 *   · `opener` — cut from this side BEFORE anything is written into the popup
 *     (podest.html's popup does the same);
 *   · the confirm — code the graph did not generate (`previewCodeIsGraphCodegen`
 *     recomputes, at the click, the text the sync engine writes) asks first,
 *     IN the popup, and a decline closes it with nothing written or minted.
 *
 * The provenance test is re-derived for the CONNECTED-ONLY panel: the sync
 * engine writes `panelCodegen(…, false)` (dead chains and muted nodes left
 * out), or the Preview-mode derived graph's. A whole-graph comparison would
 * prompt on every untouched graph with an unwired chain or a muted node.
 * (2026-10-01 security review; ported onto main 2026-11-19. The popup still
 * has the origin's storage; that residual is what the confirm names, and it is
 * documented in docs/dev/preview-and-runtime.md.)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { makeNode, makeEdge } from '@/test-utils';
import type { AppEdge, AppNode } from '@/types';
import { graphToCode } from '@/engine/graphToCode';
import { panelCodegen } from '@/engine/panelCode';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { previewGraph, resolveNodePreview, type NodePreviewTarget } from '@/utils/nodePreview';
import { VR_RAW_CODE_CONFIRM_KEY, previewCodeIsGraphCodegen } from './vrPopupTrust';

const PREVIEW = readFileSync(resolve(__dirname, 'ShaderPreview.tsx'), 'utf8');
const SYNC = readFileSync(resolve(__dirname, '../../hooks/useSyncEngine.ts'), 'utf8');
const STORE = readFileSync(resolve(__dirname, '../../store/useAppStore.ts'), 'utf8');

function handleOpenVR(): string {
  const start = PREVIEW.indexOf('const handleOpenVR = useCallback(');
  expect(start, 'handleOpenVR not found').toBeGreaterThan(-1);
  return PREVIEW.slice(start, PREVIEW.indexOf('\n  }, [', start));
}

/**
 * What the sync engine's graph→code pass writes to `previewCode`, restated
 * (useSyncEngine.ts — the drift pin below holds it to the hook's text): the
 * connected-only panel codegen, or the Preview-mode derived graph's.
 */
function syncedPreviewCode(nodes: AppNode[], edges: AppEdge[], nodePreview: NodePreviewTarget | null): string {
  const { result } = panelCodegen(nodes, edges, false);
  const live = resolveNodePreview(nodes, nodePreview);
  if (!live) return result.code;
  const derived = previewGraph(nodes, edges, live);
  return panelCodegen(derived.nodes, derived.edges, false).result.code;
}

const muted = (n: AppNode): AppNode => {
  (n.data as { muted?: boolean }).muted = true;
  return n;
};

/** Node-built graphs, each in a shape main's panel treats specially. */
const GRAPHS: Record<string, () => { nodes: AppNode[]; edges: AppEdge[] }> = {
  'two floats into the Output': () => ({
    nodes: [makeNode('out', 'output'), makeNode('a', 'float', { value: 0.2 }), makeNode('b', 'float', { value: 0.7 })],
    edges: [makeEdge('a', 'out', 'out', 'color'), makeEdge('b', 'out', 'out', 'roughness')],
  }),
  // The panel leaves a chain wired to nothing out of the text (and the preview).
  'an unwired chain beside the shader': () => ({
    nodes: [makeNode('out', 'output'), makeNode('a', 'float', { value: 0.2 }), makeNode('u', 'uv'), makeNode('t', 'time'), makeNode('m', 'mul')],
    edges: [makeEdge('a', 'out', 'out', 'color'), makeEdge('u', 'out', 'm', 'a'), makeEdge('t', 'out', 'm', 'b')],
  }),
  // A MUTED node is bypassed: never in the text, whatever the scope.
  'a muted node in the chain': () => ({
    nodes: [makeNode('out', 'output'), makeNode('a', 'float', { value: 0.2 }), muted(makeNode('m', 'mul')), makeNode('b', 'float', { value: 3 })],
    edges: [makeEdge('a', 'out', 'm', 'a'), makeEdge('b', 'out', 'm', 'b'), makeEdge('m', 'out', 'out', 'color')],
  }),
  // No sink at all: the panel is the whole graph's codegen.
  'no Output on the canvas': () => ({
    nodes: [makeNode('a', 'float', { value: 0.2 }), makeNode('u', 'uv')],
    edges: [],
  }),
};

describe('the VR popup cannot reach the editor window', () => {
  it('cuts the opener after window.open and before the document is written', () => {
    const body = handleOpenVR();
    const open = body.indexOf("window.open('', '_blank')");
    const cut = body.indexOf('w.opener = null');
    const write = body.indexOf('w.document.write(');
    expect(open).toBeGreaterThan(-1);
    expect(cut).toBeGreaterThan(open);
    expect(write).toBeGreaterThan(cut);
    // Only one write, and it is the one after the cut.
    expect(body.indexOf('w.document.write(', write + 1)).toBe(-1);
  });

  it('nor find it by NAME: the editor drops a window name it was opened with, before it renders', () => {
    // `window.open('', name)` from any same-origin page — the popup runs code
    // at this origin — returns a live handle to a window of that name.
    const main = readFileSync(resolve(__dirname, '../../main.tsx'), 'utf8');
    const clear = main.indexOf("window.name = '';");
    expect(clear).toBeGreaterThan(-1);
    expect(clear).toBeLessThan(main.indexOf('ReactDOM.createRoot('));
    // Nothing in the app opens a NAMED window or reads the name back, so
    // clearing it costs nothing.
    const SRC = resolve(__dirname, '../..');
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [join(dir, e.name)] : [],
      );
    let opens = 0;
    for (const file of walk(SRC)) {
      // Comments out (rough, but a comment only ever hides from this sweep).
      const text = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      for (const m of text.matchAll(/window\.open\(([^)]*)\)/g)) {
        opens++;
        expect(m[1].split(',')[1]?.trim(), file).toBe("'_blank'");
      }
      expect(text.replace("window.name = '';", ''), file).not.toMatch(/\bwindow\.name\b/);
    }
    expect(opens).toBeGreaterThanOrEqual(2); // the VR popup and Compare devices
  });
});

describe('raw code asks before the VR popup runs it', () => {
  it('the provenance test runs after the opener cut, and its confirm sits before every write and mint', () => {
    const body = handleOpenVR();
    const cut = body.indexOf('w.opener = null');
    const gate = body.indexOf('if (!previewCodeIsGraphCodegen(previewCode, store.nodes, store.edges, store.nodePreview)) {');
    const ask = body.indexOf('w.confirm(t(VR_RAW_CODE_CONFIRM_KEY, store.language))');
    const decline = body.indexOf('if (!ok || w.closed) {');
    const close = body.indexOf('w.close();', decline);
    const bail = body.indexOf('return;', decline);
    expect(cut).toBeGreaterThan(-1);
    expect(gate, 'the provenance gate moved or was renamed').toBeGreaterThan(cut);
    expect(ask).toBeGreaterThan(gate);
    expect(decline).toBeGreaterThan(ask);
    expect(close).toBeGreaterThan(decline);
    expect(bail).toBeGreaterThan(close);
    // Nothing reaches the popup, and no model blob is minted, before the answer.
    expect(body.indexOf('w.document.write(')).toBeGreaterThan(bail);
    expect(body.indexOf('URL.createObjectURL(')).toBeGreaterThan(bail);
    // The code it compares is the code it runs, and the nodes its images come
    // from are the nodes it compared against: one store read, before the gate.
    // (The blocked-popup alert above the cut reads only the language.)
    expect(body.indexOf('const store = useAppStore.getState();')).toBeLessThan(gate);
    expect(body.slice(cut).split('useAppStore.getState()').length - 1).toBe(1);
    expect(body.split('store.previewCode').length - 1).toBe(1);
    expect(body.indexOf('const previewCode = store.previewCode;')).toBeLessThan(gate);
    expect(body).toContain('tslToPreviewHTML(inlineImageAssetsFromNodes(previewCode, store.nodes), ');
  });

  it('asks in the POPUP (the tab the user is looking at), never through the background editor tab', () => {
    const body = handleOpenVR();
    expect(body).not.toMatch(/window\.confirm\(/);
    expect(body.split('.confirm(').length - 1).toBe(1);
  });

  it('the question has a Latvian entry', () => {
    const lv = JSON.parse(readFileSync(resolve(__dirname, '../../i18n/lv.json'), 'utf8')) as { ui: Record<string, string> };
    const text = lv.ui[VR_RAW_CODE_CONFIRM_KEY];
    expect(typeof text).toBe('string');
    expect(text.length).toBeGreaterThan(40);
    expect(text).not.toBe(VR_RAW_CODE_CONFIRM_KEY);
  });

  it('the English names what makes it a decision: outside the sandbox, the saved data, and the trust', () => {
    expect(VR_RAW_CODE_CONFIRM_KEY).toMatch(/outside the preview’s sandbox/);
    expect(VR_RAW_CODE_CONFIRM_KEY).toMatch(/this site’s saved data/);
    expect(VR_RAW_CODE_CONFIRM_KEY).toMatch(/trust/);
    // Short: two sentences.
    expect(VR_RAW_CODE_CONFIRM_KEY.split(/[.?!](\s|$)/).filter((s) => s.trim().length > 1)).toHaveLength(2);
  });
});

describe('previewCodeIsGraphCodegen — never asks for a node-built graph', () => {
  it.each(Object.keys(GRAPHS))('an untouched graph (%s) never prompts', (name) => {
    const { nodes, edges } = GRAPHS[name]();
    expect(previewCodeIsGraphCodegen(syncedPreviewCode(nodes, edges, null), nodes, edges, null)).toBe(true);
  });

  it('…and the connected-only scope is what makes that true (a whole-graph comparison would ask)', () => {
    for (const name of ['an unwired chain beside the shader', 'a muted node in the chain']) {
      const { nodes, edges } = GRAPHS[name]();
      expect(syncedPreviewCode(nodes, edges, null), name).not.toBe(graphToCode(nodes, edges, NODE_REGISTRY).code);
    }
  });

  it("accepts Preview mode's derived codegen only while that node is previewed", () => {
    const { nodes, edges } = GRAPHS['an unwired chain beside the shader']();
    const preview = { nodeId: 'u', handleId: 'out' };
    const derived = syncedPreviewCode(nodes, edges, preview);
    expect(derived).not.toBe(syncedPreviewCode(nodes, edges, null)); // the test below is not vacuous
    expect(previewCodeIsGraphCodegen(derived, nodes, edges, preview)).toBe(true);
    // No preview, or a target that no longer resolves: the derived text is foreign.
    expect(previewCodeIsGraphCodegen(derived, nodes, edges, null)).toBe(false);
    expect(previewCodeIsGraphCodegen(derived, nodes, edges, { nodeId: 'gone', handleId: 'out' })).toBe(false);
  });

  it('drift pin: the sync engine writes exactly the text `syncedPreviewCode` restates', () => {
    expect(SYNC).toContain('const { result, emitted } = panelCodegen(nodes, edges, false);');
    expect(SYNC).toContain('const live = resolveNodePreview(nodes, nodePreview);');
    expect(SYNC).toContain('const derived = previewGraph(nodes, edges, live);');
    expect(SYNC).toContain('previewText = panelCodegen(derived.nodes, derived.edges, false).result.code;');
    expect(SYNC).toContain("setCode(result.code, 'graph', previewText, ");
    expect(STORE).toContain('previewCode: previewCode ?? code,');
    // The other writer: an Apply (and a bare-script import) puts the panel's TEXT on the preview.
    expect(STORE).toContain('requestCodeSync: () => set({ codeSyncRequested: true, previewCode: get().code }),');
  });
});

describe('previewCodeIsGraphCodegen — asks for code the graph did not generate', () => {
  it('asks after hand-written code is applied (the graph is then the PARSE of that text)', async () => {
    const { codeToGraph } = await import('@/engine/codeToGraph');
    const { nodes, edges } = GRAPHS['two floats into the Output']();
    const typed = `${syncedPreviewCode(nodes, edges, null)}\n// tuned by hand\n`;
    const parsed = codeToGraph(typed);
    expect(parsed.errors.filter((e) => e.severity !== 'warning')).toEqual([]);
    expect(previewCodeIsGraphCodegen(typed, parsed.nodes, parsed.edges, null)).toBe(false);
    // A module nobody's graph emits, however short.
    const hand = "import { Fn, vec3 } from 'three/tsl';\nexport default Fn(() => vec3(1, 0, 0));\n";
    const handParsed = codeToGraph(hand);
    expect(previewCodeIsGraphCodegen(hand, handParsed.nodes, handParsed.edges, null)).toBe(false);
  });

  it('asks for text that leaves the graph untouched (a direct assignment, a failed parse)', () => {
    const { nodes, edges } = GRAPHS['two floats into the Output']();
    const own = syncedPreviewCode(nodes, edges, null);
    expect(previewCodeIsGraphCodegen(`${own}\n// applied by hand`, nodes, edges, null)).toBe(false);
    expect(previewCodeIsGraphCodegen(own.replace(/\n/g, '\r\n'), nodes, edges, null)).toBe(false);
    expect(previewCodeIsGraphCodegen('export default () => { fetch("https://example.com"); };', nodes, edges, null)).toBe(false);
    expect(previewCodeIsGraphCodegen('', nodes, edges, null)).toBe(false);
  });

  it('fails closed: a codegen that throws vouches for nothing, so the user is asked', () => {
    const { nodes, edges } = GRAPHS['two floats into the Output']();
    const own = syncedPreviewCode(nodes, edges, null);
    const poisoned = [...nodes, Object.defineProperty({ id: 'p', type: 'shader', position: { x: 0, y: 0 } }, 'data', {
      get() { throw new Error('poisoned'); },
      enumerable: true,
    })] as unknown as AppNode[];
    expect(() => panelCodegen(poisoned, edges, false)).toThrow();
    expect(previewCodeIsGraphCodegen(own, poisoned, edges, null)).toBe(false);
  });

  it('a graph edit since the last pass makes the old text foreign (the click recomputes, nothing is cached)', () => {
    const { nodes, edges } = GRAPHS['two floats into the Output']();
    const before = syncedPreviewCode(nodes, edges, null);
    const edited = nodes.map((n) => (n.id === 'a' ? makeNode('a', 'float', { value: 0.9 }) : n));
    expect(previewCodeIsGraphCodegen(before, edited, edges, null)).toBe(false);
    expect(previewCodeIsGraphCodegen(syncedPreviewCode(edited, edges, null), edited, edges, null)).toBe(true);
  });
});
