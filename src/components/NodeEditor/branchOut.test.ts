/**
 * "Branch out" (a Branch's right-click menu; owner, 2026-11-24): a synthetic
 * press on the Branch's `out` socket starts React Flow's own connection, the
 * window swallows every press while the wire is out, and a cancel — Escape,
 * a right-click, a click on empty canvas, the window losing focus — ends it
 * connecting nothing, with NO undo entry. The vitest environment is `node`,
 * so the DOM is a few EventTargets standing in for the document, the window
 * and the socket; the connection itself is verified in the real app.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HISTORY_IDLE, makeKnot } from '@/test-utils';
import { cancelPendingGraphSave, useAppStore } from '@/store/useAppStore';
import { isEdgeDisconnecting, setEdgeDisconnecting } from '@/utils/edgeDisconnectFlag';
import {
  BRANCH_PULL_SLOP_PX,
  branchOutActive,
  branchPullModifier,
  cancelBranchOut,
  installBranchPull,
  startBranchOut,
} from './branchOut';

class FakeMouseEvent extends Event {
  clientX: number;
  clientY: number;
  button: number;
  constructor(type: string, init: { clientX?: number; clientY?: number; button?: number; bubbles?: boolean; cancelable?: boolean } = {}) {
    super(type, init);
    this.clientX = init.clientX ?? 0;
    this.clientY = init.clientY ?? 0;
    this.button = init.button ?? 0;
  }
}
class FakeKeyboardEvent extends Event {
  key: string;
  constructor(type: string, init: { key?: string; cancelable?: boolean } = {}) {
    super(type, init);
    this.key = init.key ?? '';
  }
}

let socket: EventTarget;
let doc: EventTarget & { querySelector: (sel: string) => unknown };
let win: EventTarget;
let frames: FrameRequestCallback[];
const got: { type: string; x: number; y: number; button: number }[] = [];
const record = (e: Event) => {
  const m = e as FakeMouseEvent;
  got.push({ type: e.type, x: m.clientX, y: m.clientY, button: m.button });
};

beforeEach(() => {
  cancelPendingGraphSave();
  useAppStore.setState({ nodes: [], edges: [], past: [], future: [], ...HISTORY_IDLE });
  got.length = 0;
  frames = [];
  socket = new EventTarget();
  socket.addEventListener('mousedown', record);
  const nodeWrapper = { querySelector: (sel: string) => (sel.includes('source') && sel.includes('"out"') ? socket : null) };
  doc = Object.assign(new EventTarget(), {
    querySelector: (sel: string) => (sel.includes('"k"') ? nodeWrapper : null),
  });
  doc.addEventListener('mousemove', record);
  doc.addEventListener('mouseup', record);
  win = new EventTarget();
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', win);
  vi.stubGlobal('MouseEvent', FakeMouseEvent);
  vi.stubGlobal('CSS', { escape: (s: string) => s });
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  });
});
afterEach(() => {
  // Restore FIRST: an assertion that fails below must not leak the stubs.
  cancelBranchOut();
  vi.unstubAllGlobals();
  setEdgeDisconnecting(false);
  cancelPendingGraphSave();
  useAppStore.setState({ nodes: [], edges: [], past: [], future: [], ...HISTORY_IDLE });
});

const press = (type: string, button = 0) => {
  const e = new FakeMouseEvent(type, { cancelable: true, bubbles: true, button });
  win.dispatchEvent(e);
  return e;
};

describe('startBranchOut', () => {
  it('presses the Branch\'s OUT socket where the menu was clicked, and raises the no-menu flag', () => {
    expect(startBranchOut('k', 120, 80)).toBe(true);
    expect(got).toEqual([{ type: 'mousedown', x: 120, y: 80, button: 0 }]);
    expect(branchOutActive()).toBe(true);
    // A release over empty canvas opens no Add-node menu: it is the cancel.
    expect(isEdgeDisconnecting).toBe(true);
  });

  it('stops every press while the wire is out, so no socket starts a second wire', () => {
    startBranchOut('k', 0, 0);
    expect(press('mousedown').defaultPrevented).toBe(true);
    // Stopped but never CANCELLED: a cancelled pointerdown gets no
    // compatibility mouseup, and the mouseup is what ends React Flow's wire.
    expect(press('pointerdown').defaultPrevented).toBe(false);
    expect(branchOutActive()).toBe(true);
  });

  it('starts nothing for a Branch that is not on the canvas', () => {
    expect(startBranchOut('gone', 0, 0)).toBe(false);
    expect(branchOutActive()).toBe(false);
    expect(got).toEqual([]);
    expect(isEdgeDisconnecting).toBe(false);
  });
});

describe('cancelling a Branch out writes nothing', () => {
  const ended = async (startedWire = false) => {
    if (startedWire) {
      // A wire React Flow had started was moved off every socket, then
      // released there.
      const tail = got.slice(-2);
      expect(tail[0]).toMatchObject({ type: 'mousemove', x: -1e5, y: -1e5 });
      expect(tail[1]).toMatchObject({ type: 'mouseup', x: -1e5, y: -1e5 });
    } else {
      // One that never started is only released: moving it would START it,
      // and React Flow's auto-pan slid the view 15 px at once.
      expect(got.some((g) => g.type === 'mousemove')).toBe(false);
      expect(got[got.length - 1]).toMatchObject({ type: 'mouseup' });
    }
    expect(branchOutActive()).toBe(false);
    // No undo entry, no edge.
    expect(useAppStore.getState().past).toHaveLength(0);
    expect(useAppStore.getState().edges).toEqual([]);
    // The rest of this press stays swallowed; the next task's presses are
    // the canvas's again.
    await new Promise((r) => setTimeout(r, 0));
    expect(press('mousedown').defaultPrevented).toBe(false);
    // The flag comes down a frame later, after onConnectEnd has read it.
    expect(isEdgeDisconnecting).toBe(true);
    for (const f of frames.splice(0)) f(0);
    expect(isEdgeDisconnecting).toBe(false);
  };

  it('Escape', async () => {
    startBranchOut('k', 0, 0);
    const esc = new FakeKeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    win.dispatchEvent(esc);
    expect(esc.defaultPrevented).toBe(true);
    await ended();
  });

  it('a right-click', async () => {
    startBranchOut('k', 0, 0);
    press('mousedown', 2);
    await ended();
  });

  it('the window losing focus', async () => {
    startBranchOut('k', 0, 0);
    win.dispatchEvent(new Event('blur'));
    await ended();
  });

  it('Escape after the pointer moved: the started wire goes off every socket first', async () => {
    startBranchOut('k', 0, 0);
    // React Flow starts a wire past 1 px: this move started it.
    win.dispatchEvent(new FakeMouseEvent('mousemove', { clientX: 10, clientY: 0 }));
    win.dispatchEvent(new FakeKeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    await ended(true);
  });

  it('a move of 1 px or less starts nothing, so the cancel still only releases', async () => {
    startBranchOut('k', 0, 0);
    win.dispatchEvent(new FakeMouseEvent('mousemove', { clientX: 1, clientY: 0 }));
    got.length = 0;
    win.dispatchEvent(new FakeKeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    await ended();
  });

  it('the Branch leaving the graph (an undo) — the wire would connect from a node that is not there', async () => {
    useAppStore.setState({ nodes: [makeKnot('k')] });
    startBranchOut('k', 0, 0);
    useAppStore.setState({ nodes: [] });
    await ended();
  });

  it('any other key is stopped before every graph shortcut, and changes nothing else', () => {
    // Cmd+Z mid-wire removed the Branch and the next click connected from a
    // missing source; X and Delete edited the graph under the wire.
    startBranchOut('k', 0, 0);
    for (const key of ['z', 'x', 'Delete', 'Backspace', 'v', 'a']) {
      const e = new FakeKeyboardEvent('keydown', { key, cancelable: true });
      let stopped = false;
      e.stopPropagation = () => { stopped = true; };
      win.dispatchEvent(e);
      expect(stopped, key).toBe(true);
      expect(e.defaultPrevented, key).toBe(false);
    }
    expect(branchOutActive()).toBe(true);
  });
});

describe('a TAP on an input connects (touch has no hover)', () => {
  it('a touch press first brings the pending wire to the finger, so the touchend ends it there', () => {
    startBranchOut('k', 0, 0);
    const t = Object.assign(new Event('touchstart', { cancelable: true }), { touches: [{ clientX: 140, clientY: 60 }] });
    win.dispatchEvent(t);
    expect(t.defaultPrevented).toBe(true);
    expect(got[got.length - 1]).toEqual({ type: 'mousemove', x: 140, y: 60, button: 0 });
    // …and the wire counts as started: a cancel now moves it off every socket.
    cancelBranchOut();
    expect(got.slice(-2).map((g) => g.type)).toEqual(['mousemove', 'mouseup']);
  });
});

describe('Ctrl/Cmd + DRAG on a Branch pulls a new wire out of it (owner, 2026-11-24)', () => {
  class FakePointerEvent extends FakeMouseEvent {
    ctrlKey: boolean;
    metaKey: boolean;
    pointerId: number;
    pointerType: string;
    constructor(type: string, init: { clientX?: number; clientY?: number; ctrlKey?: boolean; metaKey?: boolean; pointerType?: string; target?: unknown } = {}) {
      super(type, { clientX: init.clientX, clientY: init.clientY, cancelable: true });
      this.ctrlKey = !!init.ctrlKey;
      this.metaKey = !!init.metaKey;
      this.pointerId = 1;
      this.pointerType = init.pointerType ?? 'mouse';
    }
  }
  // The dot inside the Branch's wrapper, as `closest` walks it.
  const wrapper = { getAttribute: (a: string) => (a === 'data-id' ? 'k' : null) };
  const dot = { closest: (sel: string) => (sel === '.knot-node__dot' ? dot : sel === '.react-flow__node' ? wrapper : null) };
  const card = { closest: () => null };
  let root: EventTarget;
  let teardown: () => void;
  /** Dispatch a pointer event on `root` whose `target` reads `target`. */
  const fire = (on: EventTarget, type: string, init: ConstructorParameters<typeof FakePointerEvent>[1]) => {
    const e = new FakePointerEvent(type, init);
    Object.defineProperty(e, 'target', { get: () => init?.target ?? null });
    on.dispatchEvent(e);
    return e;
  };

  beforeEach(() => {
    root = new EventTarget();
  });
  afterEach(() => teardown?.());

  it('the modifier is Cmd on Apple and Ctrl elsewhere — never Ctrl on a Mac, where it is a contextmenu', () => {
    expect(branchPullModifier({ ctrlKey: false, metaKey: true }, true)).toBe(true);
    expect(branchPullModifier({ ctrlKey: true, metaKey: false }, true)).toBe(false);
    expect(branchPullModifier({ ctrlKey: true, metaKey: false }, false)).toBe(true);
    expect(branchPullModifier({ ctrlKey: false, metaKey: true }, false)).toBe(false);
  });

  it('past the slop, the held press becomes a Branch out from the Branch\'s output; the node drag never sees it', () => {
    teardown = installBranchPull(root, false);
    fire(root, 'pointerdown', { clientX: 50, clientY: 50, ctrlKey: true, target: dot });
    // React Flow's node drag (d3-drag) hears `mousedown`: stopped, so the
    // Branch does not move.
    const md = new FakeMouseEvent('mousedown', { clientX: 50, clientY: 50, bubbles: true });
    let stopped = false;
    md.stopPropagation = () => { stopped = true; };
    root.dispatchEvent(md);
    expect(stopped).toBe(true);
    // Inside the slop: still a click (Attach), nothing started.
    fire(win, 'pointermove', { clientX: 50 + BRANCH_PULL_SLOP_PX, clientY: 50 });
    expect(branchOutActive()).toBe(false);
    fire(win, 'pointermove', { clientX: 50 + BRANCH_PULL_SLOP_PX + 2, clientY: 50 });
    expect(branchOutActive()).toBe(true);
    expect(got[got.length - 1]).toEqual({ type: 'mousedown', x: 50 + BRANCH_PULL_SLOP_PX + 2, y: 50, button: 0 });
    // No undo entry until a release on an input connects (onConnect's).
    expect(useAppStore.getState().past).toHaveLength(0);
  });

  it('a Ctrl/Cmd CLICK without movement is left alone (Attach), and so is a plain press or another node', () => {
    teardown = installBranchPull(root, false);
    fire(root, 'pointerdown', { clientX: 0, clientY: 0, ctrlKey: true, target: dot });
    fire(win, 'pointerup', { clientX: 0, clientY: 0 });
    fire(win, 'pointermove', { clientX: 40, clientY: 0 });
    expect(branchOutActive()).toBe(false);
    // No modifier: the plain drag still MOVES the Branch.
    fire(root, 'pointerdown', { clientX: 0, clientY: 0, target: dot });
    const md = new FakeMouseEvent('mousedown', { bubbles: true });
    let stopped = false;
    md.stopPropagation = () => { stopped = true; };
    root.dispatchEvent(md);
    expect(stopped).toBe(false);
    fire(win, 'pointermove', { clientX: 40, clientY: 0 });
    expect(branchOutActive()).toBe(false);
    // Not a Branch's dot; a touch press; Ctrl on a Mac.
    fire(root, 'pointerdown', { ctrlKey: true, target: card });
    fire(win, 'pointermove', { clientX: 40, clientY: 0 });
    fire(root, 'pointerdown', { ctrlKey: true, target: dot, pointerType: 'touch' });
    fire(win, 'pointermove', { clientX: 40, clientY: 0 });
    expect(branchOutActive()).toBe(false);
    teardown();
    teardown = installBranchPull(root, true);
    fire(root, 'pointerdown', { ctrlKey: true, target: dot });
    fire(win, 'pointermove', { clientX: 40, clientY: 0 });
    expect(branchOutActive()).toBe(false);
    fire(win, 'pointerup', {});
    fire(root, 'pointerdown', { metaKey: true, target: dot });
    fire(win, 'pointermove', { clientX: 40, clientY: 0 });
    expect(branchOutActive()).toBe(true);
  });

  it('is installed on the canvas', () => {
    const editor = readFileSync(resolve(__dirname, 'NodeEditor.tsx'), 'utf8');
    expect(editor).toMatch(/const el = canvasRef\.current;\s*if \(!el\) return;\s*return installBranchPull\(el\);/);
  });
});

describe('the wiring', () => {
  const read = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf8');

  it('the Branch menu offers it, and the Branch\'s OUT socket may take the synthetic press', () => {
    const menu = read('menus/NodeSettingsMenu.tsx');
    expect(menu).toContain("t('Branch out', language)");
    expect(menu).toContain('startBranchOut(nodeId, e.clientX, e.clientY)');
    const knot = read('nodes/KnotNode.tsx');
    expect(knot).toMatch(/id="out"\s+className="knot-node__handle"\s+isConnectableStart\s*\/>/);
  });

  it('a release that connects goes through the canvas\'s onConnect (one entry); one that does not opens no menu', () => {
    const editor = read('NodeEditor.tsx');
    expect(editor).toMatch(/connectSucceeded\.current = true;\s*useAppStore\.getState\(\)\.pushHistory\(\);\s*applyConnection\(connection\);/);
    expect(editor).toMatch(/if \(isEdgeDisconnecting\) \{\s*setEdgeDisconnecting\(false\);\s*return;\s*\}/);
  });

  it('every graph key handler stands down while a Branch-out wire is out', () => {
    // The capture-phase keyboard navigation runs BEFORE the wire's own key
    // guard (registered first), so it asks for itself; the accelerators and
    // bare canvas keys ask too, on top of the window-level stop.
    expect(read('useKeyboardNav.ts')).toMatch(/if \(branchOutActive\(\)\) return;/);
    const editor = read('NodeEditor.tsx');
    expect(editor.match(/if \(branchOutActive\(\)\) return;/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('the comments say what is TRUE: the out socket is always connectable-start; only pointer-events keep presses off it', () => {
    const src = read('branchOut.ts');
    expect(src).not.toMatch(/on for this press alone/);
    expect(src).toContain('`isConnectableStart` is permanently on (KnotNode.tsx)');
  });
});
