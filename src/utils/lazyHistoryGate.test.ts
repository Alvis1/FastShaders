import { describe, it, expect, beforeEach } from 'vitest';
import { useAppStore } from '@/store/useAppStore';
import { getNodeValues } from '@/types';
import { HISTORY_IDLE, makeNode } from '@/test-utils';
import { createLazyGate, createLazyIdleWrite } from './lazyHistoryGate';

/**
 * The Color Ramp / RGB Curves editors' history rule, on the REAL store: a
 * bracket opens on the first write that changes the canonical string, never
 * on the press. `beginInteraction` clears `future`, so an eager bracket costs
 * an empty undo entry AND the redo stack on every tap.
 */

const KEY = 'stops';
const DEFAULT = 'D';
const state = () => useAppStore.getState();
const stored = () => getNodeValues(state().nodes.find((n) => n.id === 'n')!)[KEY];

/** The io lutEditorGestures wires up, minus React: canonical = the stored string, absent = DEFAULT. */
const io = {
  read: () => {
    const v = stored();
    return typeof v === 'string' ? v : DEFAULT;
  },
  write: (next: string) => {
    const node = state().nodes.find((n) => n.id === 'n')!;
    const values = { ...getNodeValues(node) };
    if (next === DEFAULT) delete values[KEY];
    else values[KEY] = next;
    state().updateNodeData('n', { values });
  },
  begin: () => state().beginInteraction(),
  end: () => state().endInteraction(),
};

beforeEach(() => {
  useAppStore.setState({ nodes: [makeNode('n', 'float')], edges: [], past: [], future: [], ...HISTORY_IDLE });
});

describe('createLazyGate', () => {
  it('a proposal equal to the current canonical string touches nothing — not past, not future', () => {
    const redo = [{ nodes: [], edges: [] }] as unknown as ReturnType<typeof state>['future'];
    useAppStore.setState({ future: redo });
    const gate = createLazyGate(io);
    expect(gate.propose(DEFAULT)).toBe(false);
    expect(gate.open).toBe(false);
    gate.finish();
    expect(state().past).toHaveLength(0);
    expect(state().future).toBe(redo);
    expect(state().coalescingHistory).toBe(false);
  });

  it('N changing proposals are ONE undo entry, and undo restores the pre-gesture string', () => {
    const gate = createLazyGate(io);
    for (const s of ['a', 'b', 'b', 'c', 'd']) gate.propose(s);
    expect(gate.open).toBe(true);
    gate.finish();
    expect(gate.open).toBe(false);
    expect(state().coalescingHistory).toBe(false);
    expect(state().past).toHaveLength(1);
    expect(stored()).toBe('d');
    state().undo();
    expect(stored()).toBeUndefined();
  });

  it('writing the default back DELETES the key (absent = default)', () => {
    const gate = createLazyGate(io);
    gate.propose('x');
    gate.propose(DEFAULT);
    gate.finish();
    expect(stored()).toBeUndefined();
    expect('stops' in getNodeValues(state().nodes[0])).toBe(false);
  });

  it('finish without a begin is a no-op, and finish is idempotent', () => {
    const outer = createLazyGate(io);
    outer.finish();
    expect(state().coalescingHistory).toBe(false);
    const gate = createLazyGate(io);
    gate.propose('a');
    gate.finish();
    gate.finish();
    expect(state().past).toHaveLength(1);
    expect(state().interactionDepth).toBe(0);
  });

  it('nested inside another open bracket it rides that bracket and cannot close it', () => {
    state().beginInteraction();
    const gate = createLazyGate(io);
    gate.propose('a');
    gate.finish();
    expect(state().coalescingHistory).toBe(true);
    state().endInteraction();
    expect(state().coalescingHistory).toBe(false);
    expect(state().past).toHaveLength(1);
  });
});

describe('createLazyIdleWrite — the colour picker path', () => {
  it('never brackets an equal write, and brackets before EVERY changing one', () => {
    const calls: string[] = [];
    const w = createLazyIdleWrite({
      read: io.read,
      write: (n) => {
        calls.push('write:' + n);
        io.write(n);
      },
      bracket: () => calls.push('bracket'),
    });
    expect(w(DEFAULT)).toBe(false);
    expect(calls).toEqual([]);
    w('a');
    w('a');
    w('b');
    expect(calls).toEqual(['bracket', 'write:a', 'bracket', 'write:b']);
  });

  it('a pick of the current colour leaves the redo stack intact', () => {
    useAppStore.setState({ nodes: [makeNode('n', 'float', { [KEY]: 'cur' })] });
    const redo = [{ nodes: [], edges: [] }] as unknown as ReturnType<typeof state>['future'];
    useAppStore.setState({ future: redo });
    let open = false;
    const w = createLazyIdleWrite({
      read: io.read,
      write: io.write,
      bracket: () => {
        if (!open) {
          open = true;
          state().beginInteraction();
        }
      },
    });
    w('cur');
    expect(state().future).toBe(redo);
    expect(state().past).toHaveLength(0);
    w('new');
    if (open) state().endInteraction();
    expect(state().past).toHaveLength(1);
    expect(state().future).toEqual([]);
  });
});
