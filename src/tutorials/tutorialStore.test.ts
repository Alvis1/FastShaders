import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { useAppStore, cancelPendingGraphSave } from '@/store/useAppStore';
import { HISTORY_IDLE, makeNode, makeEdge, stubLocalStorage } from '@/test-utils';
import type { DrawStroke } from '@/utils/drawings';
import type { PreviewMesh } from '@/utils/previewMesh';

// isolate: false shares this worker's store with later files — leave no armed
// autosave timer, lesson or leftover graph behind.
afterAll(() => {
  cancelPendingGraphSave();
  useAppStore.setState({
    nodes: [], edges: [], drawings: [], shaderPalettes: [], past: [], future: [],
    tutorial: null, tutorialsDone: [], previewMesh: null, nodePreview: null, ...HISTORY_IDLE,
  });
});

const stroke: DrawStroke = { id: 's1', color: '#e8455f', width: 3, opacity: 1, points: [0, 0, 10, 10] };
const mesh = { kind: 'glb', name: 'thing.glb', bytes: new Uint8Array([1]) } as unknown as PreviewMesh;

beforeEach(() => {
  useAppStore.setState({
    nodes: [makeNode('a', 'mul'), makeNode('b', 'sin')],
    edges: [makeEdge('a', 'out', 'b', 'x')],
    drawings: [stroke],
    shaderPalettes: [{ id: 'pal-x', name: 'Sunset', colors: ['#ff0000'] }],
    shaderName: 'My Waves',
    previewMesh: mesh,
    nodePreview: { nodeId: 'a', handleId: 'out' },
    tutorial: null,
    tutorialsDone: [],
    past: [],
    future: [],
    ...HISTORY_IDLE,
  });
});

const s = () => useAppStore.getState();

describe('startTutorial', () => {
  it('over real work ASKS first: phase ask, graph and history untouched', () => {
    s().startTutorial('tut-mix');
    expect(s().tutorial).toEqual({ id: 'tut-mix', phase: 'ask', step: 0, reached: 0, bindings: {} });
    expect(s().nodes.map((n) => n.id)).toEqual(['a', 'b']);
    expect(s().past).toHaveLength(0);
  });

  it('over a blank canvas takes over at once', () => {
    useAppStore.setState({ nodes: [makeNode('o', 'output')], edges: [], drawings: [] });
    s().startTutorial('tut-mix');
    expect(s().tutorial?.phase).toBe('run');
    expect(s().nodes).toHaveLength(1);
    expect(s().nodes[0].id).not.toBe('o');
    expect(s().past).toHaveLength(1);
  });
});

describe('the takeover (confirmTutorial)', () => {
  it('is ONE undo entry: a lone Output, no wires, no strokes, Preview mode ended, out bound', () => {
    s().startTutorial('tut-mix');
    s().confirmTutorial();
    const st = s();
    expect(st.past).toHaveLength(1);
    expect(st.nodes).toHaveLength(1);
    expect(st.nodes[0].type).toBe('output');
    expect(st.edges).toEqual([]);
    expect(st.drawings).toEqual([]);
    expect(st.nodePreview).toBeNull();
    expect(st.tutorial).toEqual({ id: 'tut-mix', phase: 'run', step: 0, reached: 0, bindings: { out: st.nodes[0].id } });
    expect(st.syncSource).toBe('graph');
  });

  it('keeps the DOCUMENT: name, palettes, preview model', () => {
    s().startTutorial('tut-mix');
    s().confirmTutorial();
    expect(s().shaderName).toBe('My Waves');
    expect(s().shaderPalettes.map((p) => p.id)).toEqual(['pal-x']);
    expect(s().previewMesh).toBe(mesh);
  });

  it('undo brings the old graph back whole', () => {
    s().startTutorial('tut-mix');
    s().confirmTutorial();
    s().undo();
    expect(s().nodes.map((n) => n.id)).toEqual(['a', 'b']);
    expect(s().edges).toHaveLength(1);
    expect(s().drawings).toEqual([stroke]);
  });

  it('snapshots even while isUndoRedo is still set (the guard pushHistory would honour)', () => {
    s().startTutorial('tut-mix');
    useAppStore.setState({ isUndoRedo: true });
    s().confirmTutorial();
    expect(s().past).toHaveLength(1);
    expect(s().nodes).toHaveLength(1);
  });

  it('is a no-op unless asking', () => {
    s().confirmTutorial();
    expect(s().nodes.map((n) => n.id)).toEqual(['a', 'b']);
    expect(s().past).toHaveLength(0);
  });

  it('announces fs:graph-merged (the canvas fits, Preview mode ends, the preview settles)', () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal('window', { dispatchEvent });
    vi.stubGlobal('CustomEvent', class FakeEvent { constructor(public type: string) {} });
    let types: string[] = [];
    try {
      s().startTutorial('tut-mix');
      s().confirmTutorial();
      types = dispatchEvent.mock.calls.map((c) => (c[0] as { type: string }).type);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(types).toEqual(['fs:graph-merged']);
  });
});

describe('navigation, bindings and the end', () => {
  beforeEach(() => {
    useAppStore.setState({ nodes: [makeNode('o', 'output')], edges: [], drawings: [] });
    s().startTutorial('tut-mix');
  });

  it('tutorialGo moves the step and raises `reached`, never lowering it', () => {
    s().tutorialGo(3);
    expect(s().tutorial).toMatchObject({ step: 3, reached: 3 });
    s().tutorialGo(1);
    expect(s().tutorial).toMatchObject({ step: 1, reached: 3 });
  });

  it('tutorialBind adds, replaces and drops roles, and is identity when nothing changes', () => {
    const before = s().tutorial;
    s().tutorialBind('noise', 'p1');
    expect(s().tutorial?.bindings).toEqual({ out: before!.bindings.out, noise: 'p1' });
    const same = s().tutorial;
    s().tutorialBind('noise', 'p1');
    expect(s().tutorial).toBe(same);
    s().tutorialBind('ghost', null);
    expect(s().tutorial).toBe(same);
    s().tutorialBind('noise', null);
    expect(s().tutorial?.bindings).toEqual({ out: before!.bindings.out });
  });

  it('endTutorial keep leaves the graph and the history as they are', () => {
    const past = s().past.length;
    s().endTutorial('keep');
    expect(s().tutorial).toBeNull();
    expect(s().nodes).toHaveLength(1);
    expect(s().past).toHaveLength(past);
    expect(s().tutorialsDone).toEqual([]);
  });

  it('endTutorial new is NEW: a fresh Output, one more entry', () => {
    const outId = s().nodes[0].id;
    const past = s().past.length;
    s().endTutorial('new');
    expect(s().tutorial).toBeNull();
    expect(s().nodes).toHaveLength(1);
    expect(s().nodes[0].id).not.toBe(outId);
    expect(s().past).toHaveLength(past + 1);
  });

  it('a completed lesson is remembered once, in fs:tutorialsDone', () => {
    const store = stubLocalStorage();
    try {
      s().endTutorial('keep', true);
      expect(s().tutorialsDone).toEqual(['tut-mix']);
      expect(store['fs:tutorialsDone']).toBe('["tut-mix"]');
      useAppStore.setState({ nodes: [makeNode('o', 'output')], edges: [], drawings: [] });
      s().startTutorial('tut-mix');
      s().endTutorial('keep', true);
      expect(s().tutorialsDone).toEqual(['tut-mix']);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
