/**
 * `removeEdges(ids)` — the ONE store path that removes wires (Alt+click, the
 * wire's ✕, the edge menu, an end dragged off its socket, the cut stroke):
 * one undo entry, one filter, one operand compaction, one study
 * `edge-disconnect {how:'remove-edge'}` per wire actually removed, and
 * nothing at all for ids that are not there.
 * docs/dev/canvas-interaction.md, "Cut stroke".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HISTORY_IDLE, makeEdge, makeNode } from '@/test-utils';
import { endEvalSession, getEvalEvents, startEvalSession } from '@/eval/telemetry';
import { normalizeChainOperands } from '@/utils/chainOperands';
import { useAppStore } from './useAppStore';

const srcs = ['s0', 's1', 's2', 's3'].map((id) => makeNode(id, 'float', { value: 1 }));
/** A grown Add: s0..s3 into operands a, b, c, d. */
function grownAdd() {
  const add = makeNode('add1', 'add');
  const edges = [
    makeEdge('s0', 'out', 'add1', 'a'),
    makeEdge('s1', 'out', 'add1', 'b'),
    makeEdge('s2', 'out', 'add1', 'c'),
    makeEdge('s3', 'out', 'add1', 'd'),
  ];
  return { nodes: [...srcs, add], edges };
}

const fed = () =>
  useAppStore.getState().edges.filter((e) => e.target === 'add1').map((e) => `${e.source}>${e.targetHandle}`);

describe('removeEdges', () => {
  beforeEach(() => {
    const g = grownAdd();
    useAppStore.setState({ nodes: g.nodes, edges: g.edges, past: [], future: [], ...HISTORY_IDLE });
  });

  it('removes several wires as ONE undo entry, and undo brings them all back', () => {
    const [a, , c] = useAppStore.getState().edges;
    useAppStore.getState().removeEdges([a.id, c.id]);
    expect(useAppStore.getState().past).toHaveLength(1);
    useAppStore.getState().undo();
    expect(fed()).toEqual(['s0>a', 's1>b', 's2>c', 's3>d']);
    useAppStore.setState({ ...HISTORY_IDLE });
  });

  it('cutting operands a and c of a grown Add leaves exactly b and d, compacted once', () => {
    const [a, , c] = useAppStore.getState().edges;
    useAppStore.getState().removeEdges([a.id, c.id]);
    expect(fed()).toEqual(['s1>a', 's3>b']);
  });

  it('why it is plural: one at a time, compaction re-mints c\'s id and the second removal misses', () => {
    const g = grownAdd();
    const [a, , c] = g.edges;
    // What a loop of single removals would do: filter a, compact, filter c.
    const first = normalizeChainOperands(g.nodes, g.edges.filter((e) => e.id !== a.id));
    expect(first.edges.some((e) => e.id === c.id)).toBe(false); // c was re-minted
    const second = normalizeChainOperands(first.nodes, first.edges.filter((e) => e.id !== c.id));
    expect(second.edges.map((e) => e.source)).toContain('s2'); // …so s2 survives the "cut"
  });

  it('ids that are not present change nothing and push no history', () => {
    const before = useAppStore.getState().edges;
    useAppStore.getState().removeEdges(['nope', 'also-nope']);
    useAppStore.getState().removeEdges([]);
    useAppStore.getState().removeEdge('nope');
    expect(useAppStore.getState().edges).toBe(before);
    expect(useAppStore.getState().past).toHaveLength(0);
  });

  it('removeEdge(id) is removeEdges([id]), and duplicates count once', () => {
    const [, b] = useAppStore.getState().edges;
    useAppStore.getState().removeEdge(b.id);
    expect(fed()).toEqual(['s0>a', 's2>b', 's3>c']);
    expect(useAppStore.getState().past).toHaveLength(1);
    const [x] = useAppStore.getState().edges;
    useAppStore.getState().removeEdges([x.id, x.id]);
    expect(useAppStore.getState().past).toHaveLength(2);
    expect(fed()).toEqual(['s2>a', 's3>b']);
  });
});

describe('removeEdges telemetry: one edge-disconnect per wire removed', () => {
  // A real study session needs a window, a document and sessionStorage; the
  // node env has none, so the smallest stand-ins are stubbed and RESTORED
  // (the session ended first, while its listeners' window still exists).
  beforeEach(() => {
    const store = new Map<string, string>();
    const noop = () => {};
    vi.stubGlobal('window', {
      addEventListener: noop, removeEventListener: noop,
      setInterval: () => 0, clearInterval: noop, setTimeout: () => 0, clearTimeout: noop,
    });
    vi.stubGlobal('document', {
      addEventListener: noop, removeEventListener: noop, visibilityState: 'visible', hasFocus: () => true, activeElement: null,
    });
    vi.stubGlobal('sessionStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    const g = grownAdd();
    useAppStore.setState({ nodes: g.nodes, edges: g.edges, past: [], future: [], ...HISTORY_IDLE });
    startEvalSession({ id: 'cut-test', participant: 'T0', startedIso: '', consentIso: '', consentVersion: '' });
  });
  afterEach(() => {
    endEvalSession();
    vi.unstubAllGlobals();
  });

  const disconnects = () => getEvalEvents().filter((e) => e.type === 'edge-disconnect');

  it('three wires cut, three events, each how: remove-edge — and none for absent ids', () => {
    const [a, b, c] = useAppStore.getState().edges;
    useAppStore.getState().removeEdges([a.id, b.id, c.id, 'nope']);
    expect(disconnects()).toHaveLength(3);
    expect(disconnects().every((e) => (e as { how?: string }).how === 'remove-edge')).toBe(true);
    useAppStore.getState().removeEdges(['nope']);
    expect(disconnects()).toHaveLength(3);
  });
});
