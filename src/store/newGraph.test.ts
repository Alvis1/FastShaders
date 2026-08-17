import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { useAppStore, cancelPendingGraphSave, DEFAULT_SHADER_NAME } from '@/store/useAppStore';
import { makeNode, makeEdge } from '@/test-utils';
import type { DrawStroke } from '@/utils/drawings';

// isolate: false shares this worker's globals with later files — leave no
// armed autosave timer or leftover graph behind.
afterAll(() => {
  cancelPendingGraphSave();
  useAppStore.setState({
    nodes: [], edges: [], drawings: [], shaderPalettes: [], past: [], future: [],
  });
});

const stroke = (id: string): DrawStroke => ({
  id,
  color: '#e8455f',
  width: 3,
  opacity: 1,
  points: [0, 0, 10, 10],
});

beforeEach(() => {
  useAppStore.setState({
    nodes: [makeNode('a', 'mul'), makeNode('b', 'sin')],
    edges: [makeEdge('a', 'out', 'b', 'x')],
    drawings: [stroke('s1')],
    shaderPalettes: [{ id: 'pal-x', name: 'Sunset', colors: ['#ff0000'] }],
    past: [],
    future: [],
    isUndoRedo: false,
  });
});

describe('newGraph', () => {
  it('clears to a single Output node', () => {
    useAppStore.getState().newGraph();

    const s = useAppStore.getState();
    expect(s.nodes).toHaveLength(1);
    expect(s.nodes[0].type).toBe('output');
    expect(s.nodes[0].data.registryType).toBe('output');
    expect(s.edges).toEqual([]);
    expect(s.drawings).toEqual([]);
    // Palettes belong to the DOCUMENT, so a new shader starts without them.
    expect(s.shaderPalettes).toEqual([]);
    // The graph→code effect keys on this: a reset must regenerate the code,
    // not be mistaken for a code-sourced update.
    expect(s.syncSource).toBe('graph');
  });

  it('is one undo entry that restores nodes, edges, ink AND palettes', () => {
    useAppStore.getState().newGraph();
    expect(useAppStore.getState().past).toHaveLength(1);

    useAppStore.getState().undo();

    const s = useAppStore.getState();
    expect(s.nodes.map((n) => n.id)).toEqual(['a', 'b']);
    expect(s.edges).toHaveLength(1);
    expect(s.drawings.map((d) => d.id)).toEqual(['s1']);
    expect(s.shaderPalettes.map((p) => p.id)).toEqual(['pal-x']);
  });

  it('snapshots even while isUndoRedo is still set', () => {
    // pushHistory honours that flag; a NEW click that landed before the sync
    // engine cleared it would otherwise wipe the document unrecoverably.
    useAppStore.setState({ isUndoRedo: true });
    useAppStore.getState().newGraph();

    expect(useAppStore.getState().past).toHaveLength(1);
    useAppStore.getState().undo();
    expect(useAppStore.getState().nodes.map((n) => n.id)).toEqual(['a', 'b']);
  });

  it('resets the shader name, so NEW cannot inherit a file to overwrite', () => {
    // The name is what every export path turns into a FILE name, and the
    // desktop Work folder adopts the opened file's name on load — so keeping
    // it across a NEW would aim the next Save at the shader just opened and
    // replace it with the blank document. work_folder_write has no undo.
    useAppStore.setState({ shaderName: 'waves' });
    useAppStore.getState().newGraph();

    expect(useAppStore.getState().shaderName).toBe(DEFAULT_SHADER_NAME);
  });

  it('persists the reset name, so a reload cannot restore the old target', () => {
    // The env is `node`, so localStorage must be stubbed — which also proves
    // the store's try/catch keeps NEW working with no storage at all.
    const store: Record<string, string> = { 'fs:shaderName': 'waves' };
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; },
    });
    try {
      useAppStore.setState({ shaderName: 'waves' });
      useAppStore.getState().newGraph();
      expect(store['fs:shaderName']).toBe(DEFAULT_SHADER_NAME);
    } finally {
      // isolate: false — never leave a stubbed global behind.
      vi.unstubAllGlobals();
      cancelPendingGraphSave();
    }
  });

  it('announces itself with fs:graph-new', () => {
    // The desktop Work folder listens: the name reset alone cannot sever its
    // tracking, because a document already AT the default name kebabs to the
    // same file — so it would keep the last-opened shader as this one's home
    // and replace it on the next Save. Deliberately NOT fs:graph-imported,
    // which also arms NodeEditor's import auto-fit.
    // The env is `node`, so `window` must be stubbed — an EventTarget is the
    // whole surface the dispatch uses. This also proves the store's
    // `typeof window` guard, which is what keeps newGraph usable from the
    // node-env suites and from node-editor.html.
    const bus = new EventTarget();
    vi.stubGlobal('window', bus);
    const seen: string[] = [];
    const spy = () => seen.push('new');
    bus.addEventListener('fs:graph-new', spy);
    try {
      useAppStore.getState().newGraph();
      expect(seen).toEqual(['new']);
    } finally {
      bus.removeEventListener('fs:graph-new', spy);
      // isolate: false — never leave a stubbed global behind.
      vi.unstubAllGlobals();
    }
  });

  it('drops the redo stack — the reset is a new branch of history', () => {
    useAppStore.setState({ future: [{ nodes: [], edges: [], drawings: [], shaderPalettes: [] }] });
    useAppStore.getState().newGraph();
    expect(useAppStore.getState().future).toEqual([]);
  });
});
