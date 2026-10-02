/**
 * A Gaussian splat dropped on a graph with NO Splat Output asks whether to
 * clear the node graph (owner, 2026-10-01): the predicate, the cleared graph's
 * one node, the commit (`startSplatGraph` — one undo entry, the document kept,
 * `fs:graph-merged`), and the wiring in ShaderPreview that asks only for a
 * VALID, standalone splat.
 *
 * Real store; `window` and `localStorage` stubbed and restored; the store
 * reset around every test (isolate: false).
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useAppStore, cancelPendingGraphSave } from '@/store/useAppStore';
import { HISTORY_IDLE, makeEdge, makeNode, stubLocalStorage } from '@/test-utils';
import { startSplatGraph } from '@/engine/projectImport';
import { asksToClearForSplat, splatStarterNode } from '@/utils/splatGraphStart';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { activeSink, drivingSplatOutput, isSplatOutput } from '@/utils/sdfPartition';
import lv from '@/i18n/lv.json';

const PREVIEW = readFileSync(resolve(__dirname, 'ShaderPreview.tsx'), 'utf8');
const ASK = readFileSync(resolve(__dirname, 'useSplatGraphAsk.tsx'), 'utf8');
const MODAL = readFileSync(resolve(__dirname, '../Modals/SplatGraphModal.tsx'), 'utf8');

/** The text of a `const name = useCallback(` … up to its first `}, [` dep list. */
function callbackBody(src: string, name: string): string {
  const at = src.indexOf(`const ${name} = useCallback(`);
  expect(at, `${name} was renamed`).toBeGreaterThan(-1);
  return src.slice(at, src.indexOf('}, [', at));
}

describe('asksToClearForSplat', () => {
  it('asks when the graph has nodes and no Splat Output', () => {
    expect(asksToClearForSplat([makeNode('o', 'output')])).toBe(true);
    expect(asksToClearForSplat([makeNode('f', 'float'), makeNode('r', 'raymarchOutput')])).toBe(true);
  });

  it('never asks on an empty canvas — there is nothing to clear', () => {
    expect(asksToClearForSplat([])).toBe(false);
  });

  it('never asks when a Splat Output is present, active or not', () => {
    expect(asksToClearForSplat([makeNode('o', 'output'), makeNode('s', 'splatOutput')])).toBe(false);
    expect(asksToClearForSplat([makeNode('s', 'splatOutput')])).toBe(false);
  });
});

describe('splatStarterNode', () => {
  it('is a palette-identical Splat Output, flagged as the active sink', () => {
    const n = splatStarterNode();
    const def = NODE_REGISTRY.get('splatOutput')!;
    expect(n.type).toBe('splatOutput');
    expect(isSplatOutput(n)).toBe(true);
    expect(n.data.label).toBe(def.label);
    expect((n.data as { values?: unknown }).values).toEqual(def.defaultValues);
    expect((n.data as { activeOutput?: unknown }).activeOutput).toBe(true);
    // Drives with nothing wired (the identity program), so a plain Output
    // added later arrives inactive rather than taking the render.
    expect(activeSink([n], [])).toBe(n);
    expect(drivingSplatOutput([n, makeNode('o', 'output')], [])).toBe(n);
  });

  it('mints a fresh id each time', () => {
    expect(splatStarterNode().id).not.toBe(splatStarterNode().id);
  });
});

describe('startSplatGraph', () => {
  let events: string[];
  let savedName = '';
  let savedPalettes: ReturnType<typeof useAppStore.getState>['shaderPalettes'];

  const reset = () => {
    cancelPendingGraphSave();
    useAppStore.setState({ nodes: [], edges: [], drawings: [], past: [], future: [], ...HISTORY_IDLE, previewMesh: null });
  };

  beforeAll(() => {
    savedName = useAppStore.getState().shaderName;
    savedPalettes = useAppStore.getState().shaderPalettes;
  });
  beforeEach(() => {
    reset();
    stubLocalStorage();
    events = [];
    const target = new EventTarget();
    vi.stubGlobal('window', target);
    for (const name of ['fs:graph-merged', 'fs:graph-imported', 'fs:project-imported', 'fs:graph-new']) {
      target.addEventListener(name, () => events.push(name));
    }
  });
  afterEach(() => {
    reset();
    vi.unstubAllGlobals();
  });
  afterAll(() => {
    cancelPendingGraphSave();
    vi.unstubAllGlobals();
    useAppStore.setState({ shaderName: savedName, shaderPalettes: savedPalettes });
  });

  it('replaces nodes, wires and drawings with ONE Splat Output, as ONE undo entry', () => {
    useAppStore.setState({
      nodes: [makeNode('a', 'float'), makeNode('o', 'output')],
      edges: [makeEdge('a', 'out', 'o', 'color')],
      drawings: [{ id: 'd1', color: '#ff0000', opacity: 1, width: 2, points: [{ x: 0, y: 0 }] }] as never,
    });
    startSplatGraph();
    const s = useAppStore.getState();
    expect(s.nodes).toHaveLength(1);
    expect(isSplatOutput(s.nodes[0])).toBe(true);
    expect(s.edges).toEqual([]);
    expect(s.drawings).toEqual([]);
    expect(s.syncSource).toBe('graph');
    expect(s.past).toHaveLength(1);

    s.undo();
    const back = useAppStore.getState();
    expect(back.nodes.map((n) => n.id)).toEqual(['a', 'o']);
    expect(back.edges).toHaveLength(1);
    expect(back.drawings).toHaveLength(1);
  });

  it('keeps the DOCUMENT — name and palettes — and fires fs:graph-merged only', () => {
    useAppStore.setState({
      nodes: [makeNode('o', 'output')],
      shaderName: 'my-shader',
      shaderPalettes: [{ id: 'p1', name: 'mine', colors: ['#112233'] }] as never,
    });
    startSplatGraph();
    const s = useAppStore.getState();
    expect(s.shaderName).toBe('my-shader');
    expect(s.shaderPalettes.map((p) => p.id)).toEqual(['p1']);
    // fs:graph-imported would make the Work folder forget the open file.
    expect(events).toEqual(['fs:graph-merged']);
  });

  it('leaves the preview model alone — the caller loads the splat next', () => {
    useAppStore.setState({ nodes: [makeNode('o', 'output')] });
    startSplatGraph();
    expect(useAppStore.getState().previewMesh).toBeNull();
  });
});

describe('ShaderPreview wiring', () => {
  const apply = callbackBody(PREVIEW, 'applyModelBytes');
  const load = callbackBody(PREVIEW, 'loadMeshFile');

  it('asks only AFTER the constructor accepted the file, and only for a splat on an askable graph', () => {
    const made = apply.indexOf('createPreviewMesh(fileName, bytes)');
    const refused = apply.indexOf("if ('error' in result)");
    const ask = apply.indexOf('splatAsk.offer(');
    expect(made).toBeGreaterThan(-1);
    expect(refused).toBeGreaterThan(made);
    expect(ask).toBeGreaterThan(refused);
    expect(apply).toContain(
      'if (askSplat && isSplatKind(result.mesh.kind) && asksToClearForSplat(useAppStore.getState().nodes))',
    );
    // The dialog shows the SANITIZED name, never the raw (attacker-chosen) one.
    expect(apply).toContain('splatAsk.offer(result.mesh.name, show)');
    // An open question refuses the second splat with the busy notice.
    expect(apply).toContain('showDropNotice(t(GLB_IMPORT_KEYS.busy, language))');
  });

  it('a paired model never asks; a study session never reaches the ask (splats refused first)', () => {
    expect(load).toContain('applyModelBytes(file.name, bytes, opts?.offerBuild !== false);');
    const refusal = load.indexOf('if (isEvalMode() && isSplatKind(kind))');
    expect(refusal).toBeGreaterThan(-1);
    expect(refusal).toBeLessThan(load.indexOf('applyModelBytes('));
  });

  it('the GLB dialog\'s "Only Mesh" answer calls the two-argument form, so it never asks', () => {
    const glb = readFileSync(resolve(__dirname, 'useGlbImport.tsx'), 'utf8');
    expect(glb).toContain('depsRef.current.applyModelBytes(req.fileName, req.bytes);');
  });

  it('renders the question beside the GLB dialog', () => {
    expect(PREVIEW).toContain('{splatAsk.modal}');
  });
});

describe('the answers', () => {
  it('Clear runs startSplatGraph BEFORE loading the splat, Cancel loads nothing', () => {
    const choose = callbackBody(ASK, 'choose');
    expect(choose).toContain("if (c === 'cancel') return;");
    const clear = choose.indexOf("if (c === 'clear') startSplatGraph();");
    expect(clear).toBeGreaterThan(-1);
    expect(clear).toBeLessThan(choose.indexOf('p.load();'));
  });

  it('focus starts on Keep, Escape and the backdrop are Cancel', () => {
    expect(MODAL).toContain('keepRef.current.focus()');
    expect(MODAL).toMatch(/e\.key === 'Escape'[\s\S]{0,80}onChoose\('cancel'\)/);
    expect(MODAL).toContain("onClick={() => onChoose('cancel')}");
  });

  it('every string the dialog shows has a Latvian translation', () => {
    const ui = (lv as { ui: Record<string, string> }).ui;
    const keys = [...MODAL.matchAll(/t\('([^']+)', language\)/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThanOrEqual(6);
    for (const k of keys) expect(ui[k], k).toBeTruthy();
  });
});
