import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { asOneHistoryEntry } from './historyGesture';
import { toggleExposedPort } from './exposedPorts';
import { useAppStore, setGraphPersistence, cancelPendingGraphSave } from '@/store/useAppStore';
import { makeNode, makeEdge } from '../test-utils';
import type { ShaderNodeData } from '@/types';

// Mirrors edgeUtils.test.ts — this block mutates the LIVE store and
// `isolate: false` shares the module with later files in the same worker.
describe('asOneHistoryEntry', () => {
  beforeAll(() => setGraphPersistence(false));
  afterAll(() => {
    cancelPendingGraphSave();
    useAppStore.setState({ nodes: [], edges: [], past: [], future: [], coalescingHistory: false, interactionDepth: 0 });
    setGraphPersistence(true);
  });

  beforeEach(() => {
    const img = makeNode('img1', 'imageNode');
    (img.data as ShaderNodeData).exposedPorts = ['uv'];
    useAppStore.setState({
      nodes: [makeNode('f1', 'float', { value: 1 }), img],
      edges: [makeEdge('f1', 'out', 'img1', 'uv')],
      past: [], future: [], isUndoRedo: false,
      coalescingHistory: false, interactionDepth: 0,
    });
  });

  it('hiding a WIRED exposed port is TWO entries unbracketed (the bug)', () => {
    useAppStore.getState().updateNodeData('img1', {
      exposedPorts: toggleExposedPort('img1', ['uv'], 'uv'),
    } as never);
    const { past } = useAppStore.getState();
    expect(past).toHaveLength(2);
    // The entry the FIRST Cmd+Z lands on: socket restored, wire already gone.
    expect(past[1].edges).toHaveLength(0);
    expect((past[1].nodes[1].data as ShaderNodeData).exposedPorts).toEqual(['uv']);
  });

  it('collapses the edge drop + the exposedPorts commit into ONE undo entry', () => {
    asOneHistoryEntry(() => {
      useAppStore.getState().updateNodeData('img1', {
        exposedPorts: toggleExposedPort('img1', ['uv'], 'uv'),
      } as never);
    });
    const after = useAppStore.getState();
    expect(after.past).toHaveLength(1);
    expect(after.edges).toHaveLength(0);
    expect((after.nodes[1].data as ShaderNodeData).exposedPorts).toEqual([]);

    useAppStore.getState().undo();
    const undone = useAppStore.getState();
    expect(undone.edges).toHaveLength(1);                                   // wire back
    expect((undone.nodes[1].data as ShaderNodeData).exposedPorts).toEqual(['uv']); // socket back
  });

  it('closes the bracket even when the body throws', () => {
    const before = useAppStore.getState().past.length;
    expect(() => asOneHistoryEntry(() => { throw new Error('boom'); })).toThrow('boom');
    expect(useAppStore.getState().coalescingHistory).toBe(false);
    expect(useAppStore.getState().interactionDepth).toBe(0);
    // beginInteraction takes its snapshot BEFORE the body runs, so the entry
    // is already there — what the finally guarantees is that recording RESUMES.
    expect(useAppStore.getState().past).toHaveLength(before + 1);
    useAppStore.getState().pushHistory();
    expect(useAppStore.getState().past).toHaveLength(before + 2);
  });

  it('an EMPTY body still costs an entry and CLEARS redo — why the !outputNode guard is hoisted', () => {
    useAppStore.getState().updateNodeData('img1', { values: { tileX: 9 } } as never);
    useAppStore.getState().undo();
    expect(useAppStore.getState().future).toHaveLength(1);
    const n = useAppStore.getState().past.length;
    asOneHistoryEntry(() => { /* an early-returning handler body */ });
    expect(useAppStore.getState().past).toHaveLength(n + 1);
    expect(useAppStore.getState().future).toHaveLength(0);
  });

  it('nests: an inner gesture rides the open bracket', () => {
    asOneHistoryEntry(() => {
      asOneHistoryEntry(() => {
        useAppStore.getState().updateNodeData('img1', { values: { tileX: 2 } } as never);
      });
      useAppStore.getState().updateNodeData('img1', { values: { tileX: 3 } } as never);
    });
    expect(useAppStore.getState().past).toHaveLength(1);
  });
});
