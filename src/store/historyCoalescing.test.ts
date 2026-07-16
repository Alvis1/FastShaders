import { describe, it, expect, beforeEach } from 'vitest';
import { useAppStore } from '@/store/useAppStore';
import { makeNode } from '@/test-utils';

/**
 * Regression suite for `beginInteraction` / `endInteraction`.
 *
 * A DragNumberInput scrub fires an onChange per pointermove, and every one of
 * those reaches `updateNodeData` → `pushHistory`. Unbracketed, that deep-cloned
 * the whole graph 60×/s and buried undo under dozens of sub-pixel entries, so a
 * single scrub took dozens of Ctrl+Z to reverse and undo felt broken.
 */

/** Simulate one pointermove frame of a scrub. */
function scrubFrame(nodeId: string, value: number) {
  useAppStore.getState().updateNodeData(nodeId, {
    values: { value },
  } as never);
}

function currentValue(nodeId: string): number {
  const n = useAppStore.getState().nodes.find((x) => x.id === nodeId);
  return (n?.data as { values?: { value?: number } }).values?.value as number;
}

describe('history coalescing (begin/endInteraction)', () => {
  beforeEach(() => {
    useAppStore.setState({
      nodes: [makeNode('n1', 'float', { value: 0 })],
      edges: [],
      past: [],
      future: [],
      isUndoRedo: false,
      coalescingHistory: false,
    });
  });

  it('records one entry per pushHistory when not bracketed', () => {
    const s = useAppStore.getState();
    s.pushHistory();
    s.pushHistory();
    expect(useAppStore.getState().past).toHaveLength(2);
  });

  it('collapses a whole scrub into a single undo entry', () => {
    const s = useAppStore.getState();
    s.beginInteraction();
    for (let i = 1; i <= 25; i++) scrubFrame('n1', i);
    s.endInteraction();

    expect(currentValue('n1')).toBe(25);
    // 25 frames, one entry — not 25.
    expect(useAppStore.getState().past).toHaveLength(1);
  });

  it('undo after a scrub restores the pre-scrub value in one step', () => {
    const s = useAppStore.getState();
    s.beginInteraction();
    for (let i = 1; i <= 10; i++) scrubFrame('n1', i);
    s.endInteraction();

    useAppStore.getState().undo();

    expect(currentValue('n1')).toBe(0);
    expect(useAppStore.getState().past).toHaveLength(0);
  });

  it('snapshots the pre-gesture state, not the first scrubbed value', () => {
    const s = useAppStore.getState();
    s.beginInteraction();
    scrubFrame('n1', 99);
    s.endInteraction();

    const [entry] = useAppStore.getState().past;
    const snapped = (entry.nodes[0].data as { values?: { value?: number } }).values?.value;
    expect(snapped).toBe(0);
  });

  it('resumes normal history after endInteraction', () => {
    const s = useAppStore.getState();
    s.beginInteraction();
    scrubFrame('n1', 1);
    s.endInteraction();
    expect(useAppStore.getState().past).toHaveLength(1);

    scrubFrame('n1', 2);
    expect(useAppStore.getState().past).toHaveLength(2);
  });

  it('treats two consecutive scrubs as two undo steps', () => {
    const s = useAppStore.getState();

    s.beginInteraction();
    for (let i = 1; i <= 5; i++) scrubFrame('n1', i);
    s.endInteraction();

    s.beginInteraction();
    for (let i = 6; i <= 10; i++) scrubFrame('n1', i);
    s.endInteraction();

    expect(useAppStore.getState().past).toHaveLength(2);
    useAppStore.getState().undo();
    expect(currentValue('n1')).toBe(5);
    useAppStore.getState().undo();
    expect(currentValue('n1')).toBe(0);
  });

  it('beginInteraction is idempotent — a re-entrant call adds no second snapshot', () => {
    const s = useAppStore.getState();
    s.beginInteraction();
    s.beginInteraction();
    scrubFrame('n1', 3);
    s.endInteraction();
    expect(useAppStore.getState().past).toHaveLength(1);
  });

  it('endInteraction is idempotent and leaves history recording', () => {
    const s = useAppStore.getState();
    s.endInteraction();
    s.endInteraction();
    expect(useAppStore.getState().coalescingHistory).toBe(false);

    scrubFrame('n1', 1);
    expect(useAppStore.getState().past).toHaveLength(1);
  });

  it('a fresh scrub clears the redo stack', () => {
    const s = useAppStore.getState();
    scrubFrame('n1', 1);
    useAppStore.getState().undo();
    expect(useAppStore.getState().future).toHaveLength(1);

    useAppStore.getState().beginInteraction();
    scrubFrame('n1', 7);
    useAppStore.getState().endInteraction();

    expect(useAppStore.getState().future).toHaveLength(0);
  });
});
