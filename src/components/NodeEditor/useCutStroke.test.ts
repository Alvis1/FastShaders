/**
 * The cut stroke's LISTENERS (`attachCutStroke`, the body of `useCutStroke`),
 * driven with plain events on a fake canvas and a fake window — what a release
 * cuts, what a second finger does to a stroke, and what the claimed press
 * leaves for the rest of the page. docs/dev/canvas-interaction.md, "Cut stroke".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Position, type InternalNode } from '@xyflow/react';
import { useAppStore } from '@/store/useAppStore';
import { makeTypedEdge } from '@/utils/edgeUtils';
import { attachCutStroke, type CutStrokeElement } from './useCutStroke';

/** A 100×30 box at (x, y), `in` on its left edge and `out` on its right. */
function fakeNode(id: string, x: number, y: number): InternalNode {
  return {
    id,
    type: 'shader',
    position: { x, y },
    data: {},
    measured: { width: 100, height: 30 },
    internals: {
      positionAbsolute: { x, y },
      z: 0,
      userNode: {} as never,
      handleBounds: {
        source: [{ id: 'out', type: 'source', nodeId: id, x: 100, y: 10, width: 0, height: 10, position: Position.Right }],
        target: [{ id: 'in', type: 'target', nodeId: id, x: 0, y: 10, width: 0, height: 10, position: Position.Left }],
      },
    },
  } as unknown as InternalNode;
}

/** The canvas: every press on it is a press on empty pane. */
class FakeCanvas extends EventTarget {
  attrs = new Set<string>();
  closest(sel: string) { return sel.startsWith('.react-flow__pane') ? this : null; }
  setPointerCapture() {}
  releasePointerCapture() {}
  toggleAttribute(n: string, on?: boolean) { if (on) this.attrs.add(n); else this.attrs.delete(n); return !!on; }
  setAttribute(n: string) { this.attrs.add(n); }
  removeAttribute(n: string) { this.attrs.delete(n); }
}

function ev(type: string, props: Record<string, unknown> = {}): Event {
  const e = new Event(type, { cancelable: true });
  return Object.assign(e, { button: 0, isPrimary: true, pointerId: 1, pointerType: 'mouse', clientX: 0, clientY: 0,
    altKey: false, shiftKey: false, ctrlKey: false, metaKey: false, ...props });
}

// The wire s.out → t.in runs level at y = 15 from x = 100 to x = 500.
const nodes = new Map([['s', fakeNode('s', 0, 0)], ['t', fakeNode('t', 500, 0)]]);
const wire = makeTypedEdge('s', 'out', 't', 'in');

let win: EventTarget & { setTimeout: typeof setTimeout };
let canvas: FakeCanvas;
let twoFingerNav: { current: boolean };
let detach: () => void;
let removeEdges: ReturnType<typeof vi.fn<(ids: readonly string[]) => void>>;
const saved = useAppStore.getState();

beforeEach(() => {
  // The swallowed click's timer runs at once: a real one would fire after the
  // stub is gone, against the worker's own (absent) window.
  win = Object.assign(new EventTarget(), { setTimeout: ((fn: () => void) => { fn(); return 0; }) as unknown as typeof setTimeout });
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', {
    querySelector: () => null,
    documentElement: { classList: { add() {}, remove() {} } },
    body: { style: {} },
  });
  removeEdges = vi.fn<(ids: readonly string[]) => void>();
  useAppStore.setState({ edges: [wire], drawToolActive: false, drawCut: false, removeEdges });
  canvas = new FakeCanvas();
  twoFingerNav = { current: false };
  detach = attachCutStroke(canvas as unknown as CutStrokeElement, {
    lineRef: { current: null },
    screenToFlowPosition: (p) => p,
    flowToScreenPosition: (p) => p,
    getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
    getInternalNode: (id) => nodes.get(id),
    twoFingerNavRef: twoFingerNav,
    setCanvasBusy: () => {},
    flowStore: { getState: () => ({ userSelectionRect: null }) as never, setState: () => {} },
  });
});

afterEach(() => {
  // Restore BEFORE anything can assert (isolate: false shares this worker).
  detach();
  vi.unstubAllGlobals();
  useAppStore.setState({
    edges: saved.edges, drawToolActive: saved.drawToolActive, drawCut: saved.drawCut, removeEdges: saved.removeEdges,
  });
});

const down = (p: Record<string, unknown>) => { const e = ev('pointerdown', p); canvas.dispatchEvent(e); return e; };
const move = (p: Record<string, unknown>) => win.dispatchEvent(ev('pointermove', p));
const up = (p: Record<string, unknown>) => win.dispatchEvent(ev('pointerup', p));

describe('attachCutStroke — a release cuts what the stroke crossed', () => {
  it('an Alt stroke across the wire cuts it in one call', () => {
    down({ altKey: true, clientX: 300, clientY: -10 });
    move({ altKey: true, clientX: 300, clientY: 10 });
    move({ altKey: true, clientX: 300, clientY: 40 });
    up({ altKey: true, clientX: 300, clientY: 40 });
    expect(removeEdges).toHaveBeenCalledTimes(1);
    expect(removeEdges).toHaveBeenCalledWith([wire.id]);
  });
});

describe('attachCutStroke — a second finger is navigation, never part of a cut', () => {
  const touch = { pointerType: 'touch' };
  beforeEach(() => useAppStore.setState({ drawToolActive: true, drawCut: true }));

  it('lifting the stroke finger while two fingers navigate cuts nothing', () => {
    down({ ...touch, clientX: 300, clientY: -10 }); // the scissors start at once
    down({ ...touch, pointerId: 2, isPrimary: false, clientX: 600, clientY: 300 });
    twoFingerNav.current = true;
    move({ ...touch, clientX: 300, clientY: -6 });
    // The view moved under the fingers; the release lands across the wire.
    up({ ...touch, clientX: 300, clientY: 40 });
    expect(removeEdges).not.toHaveBeenCalled();
  });

  it('the second finger lifting first does not let the first one cut on', () => {
    down({ ...touch, clientX: 300, clientY: -10 });
    down({ ...touch, pointerId: 2, isPrimary: false, clientX: 600, clientY: 300 });
    twoFingerNav.current = true;
    twoFingerNav.current = false; // finger 2 up: navigation over
    move({ ...touch, clientX: 300, clientY: 40 });
    up({ ...touch, clientX: 300, clientY: 40 });
    expect(removeEdges).not.toHaveBeenCalled();
  });

  it('navigation seen only on a move (no second pointerdown reached us) still drops it', () => {
    down({ ...touch, clientX: 300, clientY: -10 });
    twoFingerNav.current = true;
    move({ ...touch, clientX: 300, clientY: 10 });
    twoFingerNav.current = false;
    move({ ...touch, clientX: 300, clientY: 40 });
    up({ ...touch, clientX: 300, clientY: 40 });
    expect(removeEdges).not.toHaveBeenCalled();
  });

  it('the next press after a dropped stroke cuts normally', () => {
    down({ ...touch, clientX: 300, clientY: -10 });
    down({ ...touch, pointerId: 2, isPrimary: false, clientX: 600, clientY: 300 });
    up({ ...touch, clientX: 300, clientY: 40 });
    down({ ...touch, pointerId: 3, clientX: 300, clientY: -10 });
    move({ ...touch, pointerId: 3, clientX: 300, clientY: 40 });
    up({ ...touch, pointerId: 3, clientX: 300, clientY: 40 });
    expect(removeEdges).toHaveBeenCalledWith([wire.id]);
  });
});

describe('attachCutStroke — a claimed mouse press still reaches the outside-press closers', () => {
  it('the Alt press is not cancelled (so the browser fires mousedown), and that mousedown stops at the canvas', () => {
    const p = down({ altKey: true, clientX: 300, clientY: -10 });
    // A cancelled pointerdown gets NO compatibility mousedown, and useDismiss
    // (every toolbar popover) closes on a document-capture mousedown.
    expect(p.defaultPrevented).toBe(false);
    const below = vi.fn();
    canvas.addEventListener('mousedown', below);
    const md = ev('mousedown', { altKey: true, clientX: 300, clientY: -10 });
    canvas.dispatchEvent(md);
    // ...but nothing under the canvas sees it (React Flow, the wire's drag).
    expect(below).not.toHaveBeenCalled();
    expect(md.defaultPrevented).toBe(true);
    up({ altKey: true, clientX: 300, clientY: -10 });
    // An unclaimed press's mousedown passes untouched.
    down({ clientX: 300, clientY: -10 });
    canvas.dispatchEvent(ev('mousedown', { clientX: 300, clientY: -10 }));
    expect(below).toHaveBeenCalledTimes(1);
  });

  it('a touch press keeps its cancel (touchAsMouse and the compat-event rule rely on it)', () => {
    useAppStore.setState({ drawToolActive: true, drawCut: true });
    const p = down({ pointerType: 'touch', clientX: 300, clientY: -10 });
    expect(p.defaultPrevented).toBe(true);
    up({ pointerType: 'touch', clientX: 300, clientY: -10 });
  });
});

describe('the scissors own the touch gesture', () => {
  it('the canvas sets touch-action: none while the scissors are on', () => {
    // Without it Chrome takes a one-finger drag as a pan after a few moves and
    // sends pointercancel, which drops the stroke: the scissors cut nothing.
    const css = readFileSync(path.resolve(__dirname, 'NodeEditor.css'), 'utf8');
    expect(css).toMatch(/\.node-editor__canvas\.fs-scissors-active\s*\{\s*touch-action:\s*none;\s*\}/);
  });
});
