import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { useAppStore, cancelPendingGraphSave } from '@/store/useAppStore';
import { makeNode } from '@/test-utils';
import type { AppNode } from '@/types';

/**
 * History must not deep-copy the Image node's data-URL or the Data node's
 * packed Float32 blob.
 *
 * Those two `data.values` keys are the only unbounded strings a node can carry,
 * and history is a 50-entry ring of `structuredClone`s: at the documented 3M
 * char `MAX_TOTAL_IMAGE_CHARS` cap, 60 pushes retained ~146 MB of duplicated
 * base64 text, and every edit/undo/redo paid a fresh multi-MB copy even for a
 * colour tweak on an unrelated node. `imageNode.ts` and `dataNode.ts` both cite
 * this multiplication as the reason their caps are set where they are.
 *
 * Strings are immutable, so sharing one between the live graph and every entry
 * is safe BY CONSTRUCTION — the same argument `HistoryEntry` already makes for
 * `drawings` and `shaderPalettes`. What must still hold is that everything
 * AROUND the string is a real copy, so an edit cannot reach back into a
 * snapshot. A heap-delta probe would pin the same thing far more flakily; these
 * are identity assertions, which is what the guarantee actually is.
 */

const PAYLOAD = 'x'.repeat(50_000);

function imageNode(id: string, payload = PAYLOAD): AppNode {
  return makeNode(id, 'imageNode', { imageB64: payload, fileName: 'a.webp', width: 8 });
}

function nodeValues(n: AppNode | undefined): Record<string, unknown> {
  return (n?.data as { values: Record<string, unknown> }).values;
}

afterAll(() => {
  cancelPendingGraphSave();
  useAppStore.setState({
    nodes: [], edges: [], past: [], future: [],
    isUndoRedo: false, coalescingHistory: false, interactionDepth: 0,
  });
});

describe('history carries big node payloads by reference', () => {
  beforeEach(() => {
    useAppStore.setState({
      nodes: [imageNode('img'), makeNode('f1', 'float', { value: 0 })],
      edges: [],
      past: [],
      future: [],
      isUndoRedo: false,
      coalescingHistory: false,
    });
  });

  it('shares the imageB64 string with the snapshot instead of cloning it', () => {
    const live = nodeValues(useAppStore.getState().nodes[0]).imageB64;
    useAppStore.getState().pushHistory();
    const snapped = nodeValues(useAppStore.getState().past[0].nodes[0]).imageB64;
    // Same string OBJECT, not merely an equal one.
    expect(snapped).toBe(live);
  });

  it('shares the Data node dataB64 blob too', () => {
    const data = makeNode('d1', 'dataNode', { dataB64: PAYLOAD, rowCount: 4 });
    useAppStore.setState({ nodes: [data], past: [] });
    useAppStore.getState().pushHistory();
    expect(nodeValues(useAppStore.getState().past[0].nodes[0]).dataB64).toBe(
      nodeValues(useAppStore.getState().nodes[0]).dataB64,
    );
  });

  it('still isolates the node, data and values objects around it', () => {
    useAppStore.getState().pushHistory();
    const snapped = useAppStore.getState().past[0].nodes[0];
    const live = useAppStore.getState().nodes[0];
    expect(snapped).not.toBe(live);
    expect(snapped.data).not.toBe(live.data);
    expect(nodeValues(snapped)).not.toBe(nodeValues(live));

    // The placeholder used during the clone must never survive into the entry,
    // and a later edit must not reach back into it.
    useAppStore.getState().updateNodeData('img', { values: { imageB64: 'replaced' } } as never);
    expect(nodeValues(useAppStore.getState().past[0].nodes[0]).imageB64).toBe(PAYLOAD);
  });

  it('keeps values key order, so the autosave payload is byte-stable', () => {
    useAppStore.getState().pushHistory();
    const snapped = nodeValues(useAppStore.getState().past[0].nodes[0]);
    expect(Object.keys(snapped)).toEqual(Object.keys(nodeValues(useAppStore.getState().nodes[0])));
  });

  it('undo restores the payload by reference as well', () => {
    useAppStore.getState().pushHistory();
    useAppStore.getState().updateNodeData('img', { values: { imageB64: 'replaced' } } as never);
    useAppStore.getState().undo();
    expect(nodeValues(useAppStore.getState().nodes[0]).imageB64).toBe(PAYLOAD);
  });

  it('leaves a node whose values is not an object alone (tampered graph)', () => {
    const bad = makeNode('b1', 'imageNode');
    (bad.data as { values: unknown }).values = 5;
    useAppStore.setState({ nodes: [bad], past: [] });
    expect(() => useAppStore.getState().pushHistory()).not.toThrow();
    expect((useAppStore.getState().past[0].nodes[0].data as { values: unknown }).values).toBe(5);
  });
});

describe('a no-op pushHistory does not notify subscribers', () => {
  beforeEach(() => {
    useAppStore.setState({
      nodes: [makeNode('f1', 'float', { value: 0 })],
      edges: [],
      past: [],
      future: [],
      isUndoRedo: false,
      coalescingHistory: false,
    });
  });

  /**
   * zustand skips both the state merge and the listener sweep only when the
   * updater returns an object `Object.is`-equal to the current state — an empty
   * object is a fresh identity, so a pushHistory that decided to do NOTHING
   * still re-ran every mounted selector. `updateNodeData` calls it on every
   * pointermove frame of a bracketed scrub, so that was one wasted full-store
   * notification per frame.
   */
  it('fires once per scrub frame while bracketed, not twice', () => {
    let notifications = 0;
    const unsub = useAppStore.subscribe(() => { notifications++; });
    try {
      useAppStore.getState().beginInteraction();
      notifications = 0;
      for (let i = 1; i <= 10; i++) {
        useAppStore.getState().updateNodeData('f1', { values: { value: i } } as never);
      }
      expect(notifications).toBe(10);
    } finally {
      // In the finally, not after the expect: vite.config.ts sets
      // `isolate: false`, so a store left mid-gesture by a failed assertion
      // would swallow the history of every suite sharing this worker.
      useAppStore.getState().endInteraction();
      unsub();
    }
  });

  it('does not notify while isUndoRedo is set', () => {
    useAppStore.setState({ isUndoRedo: true });
    let notifications = 0;
    const unsub = useAppStore.subscribe(() => { notifications++; });
    try {
      useAppStore.getState().pushHistory();
      expect(notifications).toBe(0);
    } finally {
      unsub();
      useAppStore.setState({ isUndoRedo: false });
    }
  });
});
