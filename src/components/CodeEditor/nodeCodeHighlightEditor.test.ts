import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { OnMount } from '@monaco-editor/react';
import { useAppStore, cancelPendingGraphSave } from '@/store/useAppStore';
import { makeNode } from '@/test-utils';
import type { AppNode, CodeNodeSpans, CodeSpan } from '@/types';
import { attachNodeCodeHighlight } from './useNodeCodeHighlight';

/**
 * The node → code highlight's BEHAVIOUR (useNodeCodeHighlight.ts), against a
 * fake editor that does what the hook relies on Monaco for: an LF model whose
 * value pushes normalize every CR, decoration collections, the four events,
 * the focus flag, the layout and the reveal call. The fake does not move
 * tracked ranges with an edit — what is pinned is when the hook seeds, keeps,
 * clears and reveals, not Monaco's range tracking.
 */

type Range = { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number };
type Listener = (e?: unknown) => void;

class FakeCollection {
  ranges: Range[] = [];
  set(decos: { range: Range }[]): void { this.ranges = decos.map((d) => d.range); }
  clear(): void { this.ranges = []; }
  getRange(i: number) {
    const r = this.ranges[i];
    return r ? { ...r, isEmpty: () => r.startLineNumber === r.endLineNumber && r.startColumn === r.endColumn } : null;
  }
}

/** What the click handler asks of its target: whether it sits in a canvas node. */
class FakeElement {
  constructor(private readonly onNode: boolean) {}
  closest(): object | null { return this.onNode ? {} : null; }
}

const MONACO = {
  editor: {
    EndOfLinePreference: { LF: 1 },
    TrackedRangeStickiness: { NeverGrowsWhenTypingAtEdges: 1 },
    OverviewRulerLane: { Left: 1 },
    EditorOption: { lineHeight: 1 },
    ScrollType: { Immediate: 1 },
  },
};

function fakeEditor(initial = '') {
  let text = initial;
  let version = 1;
  let focus = false;
  let height = 400;
  const on: Record<'content' | 'layout' | 'model' | 'dispose', Listener[]> = { content: [], layout: [], model: [], dispose: [] };
  const collections: FakeCollection[] = [];
  const reveals: [number, number][] = [];
  const model = { getValue: () => text, getValueLength: () => text.length, getVersionId: () => version };
  const sub = (k: keyof typeof on) => (cb: Listener) => {
    on[k].push(cb);
    return { dispose: () => { on[k] = on[k].filter((x) => x !== cb); } };
  };
  const editor = {
    getModel: () => model,
    createDecorationsCollection: () => {
      const c = new FakeCollection();
      collections.push(c);
      return c;
    },
    onDidChangeModelContent: sub('content'),
    onDidLayoutChange: sub('layout'),
    onDidChangeModel: sub('model'),
    onDidDispose: sub('dispose'),
    getLayoutInfo: () => ({ height }),
    getOption: () => 19,
    hasWidgetFocus: () => focus,
    revealLinesInCenterIfOutsideViewport: (a: number, b: number) => { reveals.push([a, b]); },
  };
  return {
    editor: editor as unknown as Parameters<OnMount>[0],
    /** @monaco-editor/react's value push: ONE full-range edit; the model keeps LF. */
    push(next: string) {
      text = next.replace(/\r\n?/g, '\n');
      version++;
      for (const cb of on.content) cb({ isFlush: false, changes: [{ rangeOffset: 0, text }] });
    },
    /** A keystroke: a small edit somewhere in the text. */
    type(at: number, s: string) {
      text = text.slice(0, at) + s + text.slice(at);
      version++;
      for (const cb of on.content) cb({ isFlush: false, changes: [{ rangeOffset: at, text: s }] });
    },
    setFocus(v: boolean) { focus = v; },
    layout(h: number) {
      height = h;
      for (const cb of on.layout) cb();
    },
    marks: () => collections[1].ranges,
    reveals,
  };
}

/** Every listener the hook put on `window`, by type. */
let windowListeners: Map<string, ((e: unknown) => void)[]>;

const LINES = 60;
/** A pair whose node `a` owns line 40 and node `b` line 5. */
function pairOf(code: string): CodeNodeSpans {
  const own = (line: number): CodeSpan => ({ startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 10, kind: 'own', inline: false });
  return { code, spans: new Map([['a', [own(40)]], ['b', [own(5)]]]) };
}
const textOf = (eol = '\n') => Array.from({ length: LINES }, (_, i) => `  const line${i + 1} = float(${i});`).join(eol);

const select = (...ids: string[]) =>
  useAppStore.setState({
    nodes: ['a', 'b'].map((id) => ({ ...makeNode(id, 'float'), selected: ids.includes(id) }) as AppNode),
  });
/** A real mouse click on a canvas node: press, the focus leaving the panel a
 *  tick later, release — then React Flow selects it. */
function clickNode(f: ReturnType<typeof fakeEditor>, id: string, typingAtPress = false) {
  f.setFocus(typingAtPress);
  for (const fn of windowListeners.get('pointerdown') ?? []) fn({ clientX: 10, clientY: 10 });
  f.setFocus(false);
  for (const fn of windowListeners.get('click') ?? []) fn({ clientX: 11, clientY: 10, target: new FakeElement(true) });
  select(id);
}

describe('the node → code highlight on an editor', () => {
  let ctrl: { dispose(): void } | null = null;

  beforeEach(() => {
    windowListeners = new Map();
    vi.stubGlobal('window', {
      addEventListener: (type: string, fn: (e: unknown) => void) => {
        windowListeners.set(type, [...(windowListeners.get(type) ?? []), fn]);
      },
      removeEventListener: (type: string, fn: (e: unknown) => void) => {
        windowListeners.set(type, (windowListeners.get(type) ?? []).filter((x) => x !== fn));
      },
      setTimeout: (fn: () => void) => setTimeout(fn, 0),
    });
    vi.stubGlobal('Element', FakeElement);
    cancelPendingGraphSave();
    useAppStore.setState({ nodes: [], edges: [], codeNodeSpans: null });
  });

  afterEach(() => {
    // The stubs go whatever dispose does (docs/dev/testing.md).
    try {
      ctrl?.dispose();
    } finally {
      ctrl = null;
      vi.unstubAllGlobals();
      cancelPendingGraphSave();
    }
  });

  it('a value push that matches a pair seeds it; the selected node is marked', () => {
    const f = fakeEditor('');
    ctrl = attachNodeCodeHighlight(f.editor, MONACO as never);
    const pair = pairOf(textOf());
    useAppStore.setState({ codeNodeSpans: pair });
    select('a');
    expect(f.marks()).toEqual([]); // Monaco still shows the old text
    f.push(pair.code);
    expect(f.marks().map((r) => r.startLineNumber)).toEqual([40]);
  });

  it('typing keeps the marks; a whole replace that matches no pair drops them', () => {
    const f = fakeEditor('');
    ctrl = attachNodeCodeHighlight(f.editor, MONACO as never);
    const pair = pairOf(textOf());
    useAppStore.setState({ codeNodeSpans: pair });
    f.push(pair.code);
    select('a');
    f.type(0, '// typed\n');
    expect(f.marks().map((r) => r.startLineNumber)).toEqual([40]);
    f.push('// an imported script\n');
    expect(f.marks()).toEqual([]);
  });

  it('a pair whose text holds a CR still matches — Monaco keeps none (review 2026-10-27)', () => {
    const f = fakeEditor('');
    ctrl = attachNodeCodeHighlight(f.editor, MONACO as never);
    // An unknown node's expression keeps the CRLF of the file it was parsed
    // from, and a lone CR is a break too: Monaco stores both as LF.
    const pair = pairOf(textOf().replace('float(3);\n', 'float(3);\r\n').replace('float(7);\n', 'float(7);\r'));
    useAppStore.setState({ codeNodeSpans: pair });
    select('a');
    f.push(pair.code);
    expect(f.marks().map((r) => r.startLineNumber)).toEqual([40]);
  });

  it('a click reveals its node; a click made while TYPING in the panel does not', () => {
    const f = fakeEditor('');
    ctrl = attachNodeCodeHighlight(f.editor, MONACO as never);
    const pair = pairOf(textOf());
    useAppStore.setState({ codeNodeSpans: pair });
    f.push(pair.code);
    // Typing at the press: the press itself blurs Monaco (it notices a tick
    // later), so by the click the editor no longer has the focus.
    clickNode(f, 'a', true);
    expect(f.reveals).toEqual([]);
    clickNode(f, 'b');
    expect(f.reveals).toEqual([[5, 5]]);
  });

  it('a click while the panel is hidden is parked, and flushed ONCE when it shows lines', () => {
    const f = fakeEditor('');
    ctrl = attachNodeCodeHighlight(f.editor, MONACO as never);
    const pair = pairOf(textOf());
    useAppStore.setState({ codeNodeSpans: pair });
    f.push(pair.code);
    f.layout(5);
    clickNode(f, 'a');
    expect(f.reveals).toEqual([]);
    f.layout(400);
    expect(f.reveals).toEqual([[40, 40]]);
    f.layout(401);
    expect(f.reveals).toHaveLength(1);
  });
});
