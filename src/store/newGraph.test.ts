import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { useAppStore, cancelPendingGraphSave } from '@/store/useAppStore';
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

  it('drops the redo stack — the reset is a new branch of history', () => {
    useAppStore.setState({ future: [{ nodes: [], edges: [], drawings: [], shaderPalettes: [] }] });
    useAppStore.getState().newGraph();
    expect(useAppStore.getState().future).toEqual([]);
  });
});
