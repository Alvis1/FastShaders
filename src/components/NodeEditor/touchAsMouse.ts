/**
 * Touch from a browser that reports none: the Steam Frame's controller laser.
 *
 * gamescope hands a non-Steam window the TRIGGER as a real touch (its OpenVR
 * backend's passthrough mode turns VREvent_MouseButtonDown into
 * wlserver_touchdown) and keeps a hidden mouse cursor on the laser for hover,
 * while Chromium on Wayland reports `navigator.maxTouchPoints` 0 and no
 * `ontouchstart`. Blink still DISPATCHES the touch events, but d3-drag (React
 * Flow's node, selection-box and resize drag) subscribes to touch only when
 * that feature test passes, and a touch that MOVES gets no compatibility mouse
 * events. Measured in Chrome 2026-10-08: a tap gets mousedown + click, a drag
 * gets nothing. So a trigger tap selected a node and a trigger drag moved
 * nothing.
 *
 * In that environment the canvas treats touch as a mouse:
 *  - this bridge replays a one-touch drag that starts on a node or the
 *    selection box as the mouse press, moves and release d3 listens for;
 *  - NodeEditor keeps the DESKTOP pointer model for it (left-drag on empty
 *    canvas marquees, double-tap-drag pans), since the touch model navigates
 *    with two fingers and a laser has one;
 *  - the canvas carries `touch-action: none` (`.fs-touch-as-mouse`), or Chrome
 *    takes the first move of every touch as a page pan and cancels the pointer
 *    that the marquee and the edge drag follow.
 * Wherever touch IS detected (iPad, Android, a Windows touchscreen) none of
 * this runs: d3 hears touch there itself, and a second copy of the gesture
 * would drive every drag twice.
 */

/** d3's own test (`defaultTouchable` in d3-drag and d3-zoom), read once. */
export const TOUCH_UNDETECTED: boolean =
  typeof navigator !== 'undefined' &&
  typeof document !== 'undefined' &&
  !navigator.maxTouchPoints &&
  !('ontouchstart' in document.documentElement);

/** Where d3-drag listens. */
const DRAG_SCOPE = '.react-flow__node, .react-flow__nodesselection-rect';
/** React Flow starts a connection from React's onTouchStart, which DOES fire;
 *  a replayed press on a handle would start a second one. */
const NOT_BRIDGED = '.react-flow__handle';
/** Movement before a touch counts as a drag. Below Chrome's own tap slop
 *  (~15 px, measured), so a bridged drag cancels its touchend; otherwise Chrome
 *  follows a short drag with the tap's mousedown + click. */
const SLOP_PX = 4;
/** React Flow takes its grip at the first move past `nodeDragThreshold` (1 px)
 *  and drops the travel before it. Chrome holds touch moves back until the
 *  tap slop is crossed, so that first move lands 15+ px out and the node would
 *  trail the pointer by as much for the whole drag. A first step this short
 *  takes the grip where the touch began, the way a mouse's first move does. */
const LIFT_PX = 2;

type Point = { clientX: number; clientY: number };
type MouseType = 'mousedown' | 'mousemove' | 'mouseup';
/** `at` null = the document, which bubbles to the window d3 listens on. */
export type MouseSend = (type: MouseType, at: Element | null, p: Point, e: TouchEvent) => void;

/** The bridge's state machine, DOM-free so the node test env can drive it. */
export function touchAsMouse(send: MouseSend) {
  let id: number | null = null;
  let target: Element | null = null;
  let start: Point = { clientX: 0, clientY: 0 };
  let last: Point = start;
  let dragging = false;
  let lastDown: PointerEvent | null = null;

  const own = (list: TouchList) => {
    for (let i = 0; i < list.length; i++) if (list[i].identifier === id) return list[i];
    return null;
  };
  const release = (e: TouchEvent) => {
    if (dragging) send('mouseup', null, last, e);
    id = null;
    target = null;
    dragging = false;
  };

  return {
    pointerdown(e: PointerEvent) {
      if (e.pointerType === 'touch') lastDown = e;
    },
    touchstart(e: TouchEvent) {
      // Read AFTER the pointerdown's whole dispatch: a cancelled pointerdown
      // gets no compatibility mouse events (the double-tap pan cancels it to
      // take the gesture), and the replay keeps that rule.
      const cancelled = lastDown?.defaultPrevented ?? false;
      lastDown = null;
      // A second finger is not this drag.
      if (id !== null) { release(e); return; }
      if (cancelled || e.touches.length !== 1) return;
      const t = e.target as Element | null;
      if (!t?.closest?.(DRAG_SCOPE) || t.closest(NOT_BRIDGED)) return;
      const p = e.changedTouches[0];
      id = p.identifier;
      target = t;
      start = last = { clientX: p.clientX, clientY: p.clientY };
    },
    touchmove(e: TouchEvent) {
      if (id === null) return;
      const p = own(e.changedTouches);
      if (!p) return;
      last = { clientX: p.clientX, clientY: p.clientY };
      if (!dragging) {
        const dx = last.clientX - start.clientX;
        const dy = last.clientY - start.clientY;
        const d = Math.hypot(dx, dy);
        if (d <= SLOP_PX) return;
        dragging = true;
        // The press lands where the touch STARTED, so the node keeps the grip.
        send('mousedown', target, start, e);
        send('mousemove', null, {
          clientX: start.clientX + (dx / d) * LIFT_PX,
          clientY: start.clientY + (dy / d) * LIFT_PX,
        }, e);
      }
      send('mousemove', null, last, e);
    },
    touchend(e: TouchEvent) {
      if (id === null || !own(e.changedTouches)) return;
      const dragged = dragging;
      release(e);
      if (dragged && e.cancelable) e.preventDefault();
    },
  };
}

export function installTouchAsMouse(el: HTMLElement): () => void {
  const h = touchAsMouse((type, at, p, e) => {
    (at?.isConnected ? at : document).dispatchEvent(new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      view: window, // d3-drag subscribes its moves on `event.view`
      clientX: p.clientX,
      clientY: p.clientY,
      button: 0,
      buttons: type === 'mouseup' ? 0 : 1,
      shiftKey: e.shiftKey,
      ctrlKey: e.ctrlKey,
      altKey: e.altKey,
      metaKey: e.metaKey,
    }));
  });
  // The window, so a capture listener's stopImmediatePropagation on the canvas
  // cannot hide the pointerdown whose cancellation touchstart reads.
  window.addEventListener('pointerdown', h.pointerdown, true);
  el.addEventListener('touchstart', h.touchstart, { capture: true, passive: true });
  el.addEventListener('touchmove', h.touchmove, { capture: true, passive: true });
  el.addEventListener('touchend', h.touchend, { capture: true, passive: false });
  el.addEventListener('touchcancel', h.touchend, { capture: true, passive: false });
  return () => {
    window.removeEventListener('pointerdown', h.pointerdown, true);
    el.removeEventListener('touchstart', h.touchstart, true);
    el.removeEventListener('touchmove', h.touchmove, true);
    el.removeEventListener('touchend', h.touchend, true);
    el.removeEventListener('touchcancel', h.touchend, true);
  };
}
