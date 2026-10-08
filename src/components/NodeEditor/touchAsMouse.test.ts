/**
 * Touch from a browser that reports none (Steam Frame's controller laser:
 * gamescope sends the trigger as touch, Chromium on Wayland reports
 * `maxTouchPoints` 0). d3-drag never subscribes to that touch, so a trigger
 * drag moved neither a node nor the selection. Measured 2026-10-08 in Chrome
 * with CDP touch input on the real canvas: before, a 120×80 px drag moved
 * the node 0 px and a canvas drag selected nothing; after, 118×79 px (the
 * 2 px lift) and a marquee of 6 nodes.
 *
 * The state machine runs here against fake events (the env is `node`); the
 * NodeEditor half is source pins.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { touchAsMouse, type MouseSend } from './touchAsMouse';

const NODE_EDITOR = readFileSync(new URL('./NodeEditor.tsx', import.meta.url).pathname, 'utf8');
const NODE_EDITOR_CSS = readFileSync(new URL('./NodeEditor.css', import.meta.url).pathname, 'utf8');

type Where = 'node' | 'handle' | 'pane';
const element = (where: Where) => ({
  closest: (sel: string) => {
    if (sel === '.react-flow__handle') return where === 'handle' ? {} : null;
    return where === 'pane' ? null : {};
  },
}) as unknown as Element;

type Pt = { id?: number; x: number; y: number };
const list = (pts: Pt[]) =>
  pts.map((p) => ({ identifier: p.id ?? 0, clientX: p.x, clientY: p.y })) as unknown as TouchList;

function touch(target: Element, touches: Pt[], changed: Pt[] = touches) {
  const e = {
    target,
    touches: list(touches),
    changedTouches: list(changed),
    cancelable: true,
    defaultPrevented: false,
    shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
    preventDefault: () => { e.defaultPrevented = true; },
  };
  return e as unknown as TouchEvent;
}
const pointerDown = (defaultPrevented = false) =>
  ({ pointerType: 'touch', defaultPrevented }) as unknown as PointerEvent;

function harness() {
  const sent: { type: string; at: Element | null; x: number; y: number }[] = [];
  const send: MouseSend = (type, at, p) => sent.push({ type, at, x: p.clientX, y: p.clientY });
  return { sent, h: touchAsMouse(send) };
}

/** One touch on `where`: down at (100,100), moves to each point, up. */
function gesture(where: Where, moves: Pt[], { cancelledDown = false } = {}) {
  const { sent, h } = harness();
  const target = element(where);
  h.pointerdown(pointerDown(cancelledDown));
  h.touchstart(touch(target, [{ x: 100, y: 100 }]));
  for (const m of moves) h.touchmove(touch(target, [m]));
  const end = touch(target, [], [moves[moves.length - 1] ?? { x: 100, y: 100 }]);
  h.touchend(end);
  return { sent, target, endCancelled: end.defaultPrevented };
}

describe('touchAsMouse: replaying an unheard touch drag as mouse events', () => {
  it('a drag on a node is a mouse press at the START, a lift step, the moves, a release', () => {
    const { sent, target, endCancelled } = gesture('node', [{ x: 120, y: 100 }, { x: 160, y: 130 }]);
    expect(sent.map((s) => s.type)).toEqual(['mousedown', 'mousemove', 'mousemove', 'mousemove', 'mouseup']);
    expect(sent[0]).toEqual({ type: 'mousedown', at: target, x: 100, y: 100 });
    // The lift: a first move a hair past React Flow's 1 px threshold, toward
    // the touch, so its grip is taken at the start rather than 15+ px out.
    const lift = sent[1];
    expect(Math.hypot(lift.x - 100, lift.y - 100)).toBeCloseTo(2, 5);
    expect(lift.x).toBeGreaterThan(100);
    // Moves and the release go to the document (d3 listens on the window).
    expect(sent.slice(1).every((s) => s.at === null)).toBe(true);
    expect(sent.slice(2, 4).map((s) => [s.x, s.y])).toEqual([[120, 100], [160, 130]]);
    expect(sent[4]).toMatchObject({ type: 'mouseup', x: 160, y: 130 });
    // Chrome would otherwise follow a short drag with its tap's mousedown + click.
    expect(endCancelled).toBe(true);
  });

  it('a tap is left to the browser: nothing sent, its click untouched', () => {
    const { sent, endCancelled } = gesture('node', [{ x: 102, y: 101 }]);
    expect(sent).toEqual([]);
    expect(endCancelled).toBe(false);
  });

  it('a handle and the empty canvas are not bridged', () => {
    // React Flow connects from React's onTouchStart, which does fire; the
    // pane's marquee is pointer-driven.
    expect(gesture('handle', [{ x: 160, y: 130 }]).sent).toEqual([]);
    expect(gesture('pane', [{ x: 160, y: 130 }]).sent).toEqual([]);
  });

  it('a CANCELLED pointerdown is not a drag (the double-tap pan takes it)', () => {
    expect(gesture('node', [{ x: 160, y: 130 }], { cancelledDown: true }).sent).toEqual([]);
  });

  it('a second finger ends the replayed drag', () => {
    const { sent, h } = harness();
    const target = element('node');
    h.pointerdown(pointerDown());
    h.touchstart(touch(target, [{ x: 100, y: 100 }]));
    h.touchmove(touch(target, [{ x: 140, y: 100 }]));
    h.touchstart(touch(target, [{ x: 140, y: 100 }, { id: 1, x: 300, y: 300 }], [{ id: 1, x: 300, y: 300 }]));
    h.touchmove(touch(target, [{ x: 180, y: 100 }]));
    expect(sent.map((s) => s.type)).toEqual(['mousedown', 'mousemove', 'mousemove', 'mouseup']);
  });
});

describe('NodeEditor: such touch keeps the desktop model', () => {
  it('a touch pointerdown flips to the coarse model only when the browser reports touch', () => {
    expect(NODE_EDITOR).toMatch(
      /e\.pointerType === 'mouse' \|\| \(e\.pointerType === 'touch' && TOUCH_UNDETECTED\)\) setIsCoarsePointer\(false\)/,
    );
  });

  it('installs the bridge only for undetected touch, and the canvas drops browser panning', () => {
    expect(NODE_EDITOR).toMatch(/if \(!el \|\| !TOUCH_UNDETECTED\) return;\s*return installTouchAsMouse\(el\);/);
    expect(NODE_EDITOR).toContain("${TOUCH_UNDETECTED ? ' fs-touch-as-mouse' : ''}");
    expect(NODE_EDITOR_CSS).toMatch(/\.node-editor__canvas\.fs-touch-as-mouse \{\s*touch-action: none;/);
  });
});
