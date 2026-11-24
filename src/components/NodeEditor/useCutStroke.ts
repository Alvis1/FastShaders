/**
 * The CUT STROKE: a temporary dashed line whose release removes every wire
 * it crosses, in ONE undo entry (`store.removeEdges`). Two triggers, one
 * gesture:
 *  - Alt/⌥ + left-drag that STARTS on empty canvas or on a wire — never on a
 *    node, a socket, a Branch dot or a portal hole (those are nodes) — and
 *    travels past `CUT_CLICK_SLOP_PX`. A press that never does
 *    stays today's Alt+click: the click is left alone, so a wire is deleted
 *    by `onEdgeClick` and a node still goes to Preview mode.
 *  - the draw toolbar's SCISSORS (draw mode, `drawCut`): a one-finger or left
 *    drag anywhere off the chrome, for touch and the laser, which have no Alt.
 * Alt+Shift is never a cut (Windows switches the keyboard layout on it).
 *
 * The press is taken in the CAPTURE phase on the canvas
 * (stopImmediatePropagation; a mouse press's compatibility mousedown is
 * stopped there too, never cancelled at the pointerdown, so the document's
 * outside-press closers still hear it), so React Flow starts no marquee and
 * the wire's own 5 px drag-disconnect (TypedEdge) never arms. Once the stroke
 * starts, pointer capture, the `fs-canvas-busy` refcount and the drag chrome
 * bracket it, so a release over the 3D preview still ends it. Escape, a window
 * blur, a pointercancel or a SECOND FINGER (two-finger navigation) drop it —
 * never pause it. The line is drawn from
 * FLOW points on pointermove only — no loop of its own. The hit test is
 * `edgesCrossedByStroke` (edgeHit.ts), against each wire's DRAWN centreline.
 * docs/dev/canvas-interaction.md, "Cut stroke".
 */
import { useEffect, type RefObject } from 'react';
import type { InternalNode, ReactFlowState, Viewport, XYPosition } from '@xyflow/react';
import { useAppStore } from '@/store/useAppStore';
import { beginDragChrome } from '@/utils/dragChrome';
import { isTypingTarget } from '@/utils/isTypingTarget';
import { edgesCrossedByStroke } from './edgeHit';
import { CUT_CLICK_SLOP_PX, CUT_SAMPLE_PX, MAX_CUT_POINTS, type Pt } from './cutStroke';

/** Controls a press never starts a stroke on (the draw handler's list). */
const CHROME = 'input, textarea, select, button, .nodrag, [contenteditable="true"], .react-flow__panel';
/** Never an Alt cut: what a press there already means. A Branch dot and a
 *  portal hole are NODES, so `.react-flow__node` covers them. */
const NOT_CUT = '.react-flow__node, .react-flow__handle, .react-flow__nodesselection, .react-flow__edgeupdater';
/** Where an Alt cut may start: empty canvas, or a wire's body. */
const CUT_FROM = '.react-flow__pane, .react-flow__edge, .react-flow__background';

const modalOpen = () => !!document.querySelector('[role="dialog"][aria-modal="true"]');

/** May an Alt press on `target` start a cut? Pure DOM test. */
function altCutTarget(target: EventTarget | null): boolean {
  const el = target as Element | null;
  if (!el?.closest) return false;
  if (el.closest(CHROME) || el.closest(NOT_CUT)) return false;
  return !!el.closest(CUT_FROM);
}

export interface CutStrokeDeps {
  canvasRef: RefObject<HTMLDivElement | null>;
  lineRef: RefObject<SVGPolylineElement | null>;
  screenToFlowPosition: (p: XYPosition) => XYPosition;
  flowToScreenPosition: (p: XYPosition) => XYPosition;
  getViewport: () => Viewport;
  getInternalNode: (id: string) => InternalNode | undefined;
  /** True while a second finger pans/zooms: the stroke is DROPPED (ink only
   *  pauses, but a cut joining points across a view change deletes wires). */
  twoFingerNavRef: RefObject<boolean>;
  /** NodeEditor's refcounted iframe suppression. */
  setCanvasBusy: (busy: boolean) => void;
  /** React Flow's own store (`useStoreApi`): the marquee's start rectangle. */
  flowStore: { getState: () => ReactFlowState; setState: (s: Partial<ReactFlowState>) => void };
}

export function useCutStroke({
  canvasRef, lineRef, screenToFlowPosition, flowToScreenPosition, getViewport, getInternalNode,
  twoFingerNavRef, setCanvasBusy, flowStore,
}: CutStrokeDeps): void {
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    return attachCutStroke(el, {
      lineRef, screenToFlowPosition, flowToScreenPosition, getViewport, getInternalNode,
      twoFingerNavRef, setCanvasBusy, flowStore,
    });
  }, [canvasRef, lineRef, screenToFlowPosition, flowToScreenPosition, getViewport, getInternalNode, twoFingerNavRef, setCanvasBusy, flowStore]);
}

/** The element the gesture listens on: the canvas (an interface, so the
 *  listeners can be driven from a DOM-free test). */
export type CutStrokeElement = Pick<HTMLElement,
  'addEventListener' | 'removeEventListener' | 'setPointerCapture' | 'releasePointerCapture'
  | 'toggleAttribute' | 'setAttribute' | 'removeAttribute'>;

/** Wire the cut stroke's listeners onto `el` and the window; returns the
 *  detach. `useCutStroke` is this inside an effect. */
export function attachCutStroke(
  el: CutStrokeElement,
  {
    lineRef, screenToFlowPosition, flowToScreenPosition, getViewport, getInternalNode,
    twoFingerNavRef, setCanvasBusy, flowStore,
  }: Omit<CutStrokeDeps, 'canvasRef'>,
): () => void {
  {
    /** The press being followed: its pointer and where it went down. */
    let press: { id: number; x: number; y: number } | null = null;
    /** Past the slop: a stroke on screen, holding capture + busy + chrome. */
    let stroking = false;
    /** Escape or blur ended it: the release only tidies up. */
    let dropped = false;
    /** The marquee rectangle React Flow opened for this press, held back. */
    let heldRect: ReactFlowState['userSelectionRect'] = null;
    let endChrome: (() => void) | null = null;
    const pts: Pt[] = [];
    let lastScreen = { x: 0, y: 0 };
    let origin = { x: 0, y: 0 };
    let drawnVp = '';
    let drawn = '';
    let ready = false;
    /** A claimed MOUSE press: its compatibility mousedown stops at the canvas. */
    let claimMouseDown = false;

    // ATTRIBUTES, never classes: the canvas's className is React's, and a
    // re-render that changes it would erase a hand-added class mid-gesture.
    const setReady = (on: boolean) => {
      if (on === ready) return;
      ready = on;
      el.toggleAttribute('data-fs-cut-ready', on);
    };

    const flow = (x: number, y: number) => screenToFlowPosition({ x, y });

    // Screen copy of the FLOW points, relative to the overlay. Appended while
    // the view is still; rebuilt whole when it moved (a wheel zoom mid-stroke).
    const render = () => {
      const line = lineRef.current;
      if (!line) return;
      const vp = getViewport();
      const key = `${vp.x},${vp.y},${vp.zoom}`;
      const at = (p: Pt) => {
        const s = flowToScreenPosition(p);
        return `${Math.round((s.x - origin.x) * 10) / 10},${Math.round((s.y - origin.y) * 10) / 10}`;
      };
      if (key !== drawnVp) {
        drawnVp = key;
        drawn = pts.map(at).join(' ');
      } else if (pts.length) {
        drawn += (drawn ? ' ' : '') + at(pts[pts.length - 1]);
      }
      line.setAttribute('points', drawn);
    };

    const addPoint = (x: number, y: number, force = false) => {
      if (pts.length >= MAX_CUT_POINTS) return;
      const dx = x - lastScreen.x, dy = y - lastScreen.y;
      if (!force && dx * dx + dy * dy < CUT_SAMPLE_PX * CUT_SAMPLE_PX) return;
      lastScreen = { x, y };
      pts.push(flow(x, y));
      render();
    };

    const startStroke = (pointerId: number) => {
      if (!press) return;
      stroking = true;
      try { el.setPointerCapture(pointerId); } catch { /* not capturable */ }
      setCanvasBusy(true);
      endChrome = beginDragChrome(null);
      el.setAttribute('data-fs-cutting', '');
      const box = lineRef.current?.ownerSVGElement?.getBoundingClientRect();
      origin = { x: box?.left ?? 0, y: box?.top ?? 0 };
      pts.length = 0;
      drawnVp = '';
      drawn = '';
      lastScreen = { x: press.x, y: press.y };
      pts.push(flow(press.x, press.y));
      render();
    };

    // Everything a stroke holds, released ABOVE any early return of a caller:
    // capture, the busy refcount, the chrome, the line.
    const teardown = () => {
      if (stroking) {
        stroking = false;
        if (press) {
          try { el.releasePointerCapture(press.id); } catch { /* already released */ }
        }
        setCanvasBusy(false);
        el.removeAttribute('data-fs-cutting');
      }
      endChrome?.();
      endChrome = null;
      pts.length = 0;
      drawn = '';
      drawnVp = '';
      lineRef.current?.setAttribute('points', '');
    };

    const reset = () => {
      teardown();
      press = null;
      dropped = false;
      heldRect = null;
      claimMouseDown = false;
    };

    // Escape, a blur, a second finger: the stroke is gone and the release
    // only tidies up. A cut must never join points from either side of a
    // navigation — the jump between them is a segment nobody drew.
    const drop = () => {
      if (!press || dropped) return;
      teardown();
      dropped = true;
    };

    // A stroke's release lands a click on the capture target; it was a cut,
    // not a click, so the one that follows this release is swallowed.
    const swallowNextClick = () => {
      const swallow = (ev: MouseEvent) => {
        ev.stopImmediatePropagation();
        ev.preventDefault();
      };
      window.addEventListener('click', swallow, true);
      window.setTimeout(() => window.removeEventListener('click', swallow, true), 0);
    };

    const onDown = (e: PointerEvent) => {
      claimMouseDown = false;
      // A new PRIMARY press means the old one never reported its release (a
      // blur mid-press): it is dead. A second finger is not one — it is a
      // two-finger pan or pinch, so the stroke under way is DROPPED, never
      // paused: points from before and after the view moved are not a line.
      if (press && e.isPrimary) reset();
      else if (press) drop();
      if (e.button !== 0 || !e.isPrimary) return;
      const store = useAppStore.getState();
      let scissors = false;
      if (store.drawToolActive) {
        if (!store.drawCut || (e.target as Element | null)?.closest?.(CHROME)) return;
        scissors = true;
      } else {
        if (!e.altKey || e.shiftKey || e.ctrlKey || e.metaKey) return;
        if (modalOpen() || !altCutTarget(e.target)) return;
      }
      // A MOUSE press is not cancelled: a cancelled pointerdown gets no
      // compatibility mousedown, and every toolbar popover closes on a
      // document-capture mousedown (useDismiss). That mousedown is stopped
      // HERE instead (onMouseDown), after the document has heard it and
      // before anything under the canvas does. Touch and pen keep the cancel:
      // their compatibility events come after the release, and touchAsMouse
      // reads a cancelled pointerdown as "not a node drag".
      if (e.pointerType === 'mouse') claimMouseDown = true;
      else e.preventDefault();
      e.stopImmediatePropagation();
      press = { id: e.pointerId, x: e.clientX, y: e.clientY };
      // React Flow's pane opens its marquee in a React CAPTURE handler, which
      // runs at the root, before this one: its rectangle is already set, and
      // the pane's next move would start a box selection. Hold it back — and
      // hand it back on a release that never travelled, so the pane's own
      // click (deselect, onPaneClick) still happens as before.
      heldRect = flowStore.getState().userSelectionRect ?? null;
      if (heldRect) flowStore.setState({ userSelectionRect: null });
      // The scissors have no click to keep: the stroke starts at once.
      if (scissors) startStroke(e.pointerId);
    };

    // The claimed mouse press's compatibility mousedown: stopped (and its
    // default — text selection, focus — prevented) as the pointerdown used to
    // be, so React Flow and the wire's drag never see the press.
    const onMouseDown = (e: MouseEvent) => {
      if (!claimMouseDown) return;
      claimMouseDown = false;
      e.preventDefault();
      e.stopImmediatePropagation();
    };

    const onMove = (e: PointerEvent) => {
      if (!press || e.pointerId !== press.id || dropped) return;
      if (twoFingerNavRef.current) { drop(); return; }
      if (!stroking) {
        if (Math.hypot(e.clientX - press.x, e.clientY - press.y) <= CUT_CLICK_SLOP_PX) return;
        startStroke(e.pointerId);
      }
      addPoint(e.clientX, e.clientY);
    };

    const onUp = (e: PointerEvent) => {
      if (!press || e.pointerId !== press.id) return;
      // Lifted while a second finger still navigates (pointerup comes before
      // that touchend): the view moved under this stroke, so it is dropped.
      if (twoFingerNavRef.current) drop();
      const wasStroke = stroking || dropped;
      if (stroking && !dropped && e.type === 'pointerup') {
        addPoint(e.clientX, e.clientY, true);
        const stroke = pts.slice();
        const zoom = getViewport().zoom;
        reset();
        const store = useAppStore.getState();
        // Half a screen pixel of flattening: what is cut is what is drawn.
        const ids = edgesCrossedByStroke(stroke, store.edges, getInternalNode, 0.5 / (zoom > 0 ? zoom : 1));
        if (ids.length) store.removeEdges(ids);
      } else {
        // A click, not a stroke: React Flow's pane gets its rectangle back
        // before its own pointerup (this listener is the window's capture).
        const rect = !wasStroke && e.type === 'pointerup' ? heldRect : null;
        reset();
        if (rect) flowStore.setState({ userSelectionRect: rect });
      }
      if (wasStroke) swallowNextClick();
    };

    // Escape drops the stroke and nothing else: it must not also leave draw
    // mode (NodeEditor's own Escape) while the scissors are mid-drag.
    const onKeyDown = (e: KeyboardEvent) => {
      if (press && !dropped && e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        drop();
        return;
      }
      onKeyState(e);
    };
    const onKeyState = (e: KeyboardEvent) => {
      setReady(
        e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey
          && !isTypingTarget(e.target) && !modalOpen() && !useAppStore.getState().drawToolActive,
      );
    };
    // The pointer over the canvas knows the modifiers too (focus may be in a
    // frame that never sent the keydown); one attribute write on a change.
    const onHover = (e: PointerEvent) => {
      setReady(e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey && !useAppStore.getState().drawToolActive);
    };
    const onBlur = () => {
      setReady(false);
      drop();
    };

    el.addEventListener('pointerdown', onDown, true);
    el.addEventListener('mousedown', onMouseDown, true);
    el.addEventListener('pointermove', onHover, { passive: true });
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onUp, true);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyState, true);
    window.addEventListener('blur', onBlur);
    return () => {
      reset();
      setReady(false);
      el.removeEventListener('pointerdown', onDown, true);
      el.removeEventListener('mousedown', onMouseDown, true);
      el.removeEventListener('pointermove', onHover);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyState, true);
      window.removeEventListener('blur', onBlur);
    };
  }
}
