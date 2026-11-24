/**
 * "BRANCH OUT" — a new wire pulled out of a Branch's output (owner, 2026-11-24;
 * docs/dev/canvas-interaction.md, "Branch"). Two ways in:
 *  - the Branch's right-click menu row ("right mouse on the branch gives an
 *    option to branch out"): the wire follows the pointer, and a click — or a
 *    tap, or a release after a press-and-drag — on an input socket connects it;
 *  - Ctrl (Windows, Linux) or Cmd (macOS) + DRAG on the Branch dot ("if
 *    dragged out while pressing Control or Command, a branch is dragged out",
 *    `installBranchPull`): once the press travels past `BRANCH_PULL_SLOP_PX`
 *    the same wire starts under the held button, and the release ends it. A
 *    Ctrl/Cmd CLICK that never travels stays Attach; on macOS only Cmd pulls,
 *    since Ctrl+press there is a contextmenu event (Attach's other door).
 * Either way the commit is React Flow's own connection through the canvas's
 * ONE connect path (onConnect: one undo entry, the study's `edge-connect`).
 * Escape, a click on empty canvas, a right-click, the window losing focus or
 * the Branch leaving the graph (an undo) CANCEL it: nothing is written and no
 * undo entry is spent.
 *
 * How: a synthetic `mousedown` on the Branch's `out` socket — the trick a
 * wire dragged off its socket already uses (TypedEdge) — so the line, the
 * snap, `isValidConnection` and the commit are all React Flow's and the
 * canvas's own. The socket is ZERO-size and takes no pointer events
 * (PassThroughNode.css), so the user never presses it; its
 * `isConnectableStart` is permanently on (KnotNode.tsx) so this synthetic
 * press can start a wire there — pointer-events alone keep real presses off
 * it. While the wire is out:
 *  - every press is stopped at the window (pointerdown, mousedown,
 *    touchstart; the mousedown and touchstart cancelled too, never the
 *    pointerdown — that would cost the mouseup), so the socket pressed never
 *    starts a SECOND wire and the canvas starts no marquee, pan or cut — the
 *    release that follows is React Flow's to end the wire with (its own
 *    document listener);
 *  - a TOUCH press first moves the pending wire to where the finger came
 *    down (a synthetic `mousemove`), so a TAP on an input connects: React
 *    Flow starts a wire only once it has moved, and a finger has no hover;
 *  - every KEY but Escape is stopped at the window, so no graph shortcut runs
 *    under the wire — Cmd+Z could remove the very Branch the wire leaves
 *    (and the click that followed connected from a node no longer there);
 *    the capture-phase keyboard navigation asks `branchOutActive()` itself;
 *  - the click that follows the release is swallowed too, so the socket's
 *    click-to-connect never arms (and a Ctrl/Cmd drag opens no Attach);
 *  - the disconnect flag is up, so a release over empty canvas opens no
 *    Add-node menu (onConnectEnd): it is the cancel.
 * A cancel releases the pending wire where it connects nothing: moved far off
 * every socket first when React Flow had started it, else released where it
 * is — a wire that never started connects nothing, and moving one that had
 * not started would START it, and React Flow's auto-pan would slide the view.
 */
import { useAppStore } from '@/store/useAppStore';
import { setEdgeDisconnecting } from '@/utils/edgeDisconnectFlag';
import { handleEl, nodeEl } from './nodeElement';

/** The running Branch out's teardown, or null when none runs. */
let active: (() => void) | null = null;

/** Is a Branch-out wire following the pointer right now? */
export function branchOutActive(): boolean {
  return active !== null;
}

/**
 * React Flow's `connectionDragThreshold` (its default, which NodeEditor
 * keeps): a pending wire STARTS once the pointer is more than this many px
 * from the press.
 */
const RF_CONNECTION_THRESHOLD = 1;

/** Has the running Branch out's wire been started by React Flow? */
let started = false;

/** End the running Branch out, if any, connecting nothing. */
export function cancelBranchOut(): void {
  if (!active) return;
  const far = { clientX: -1e5, clientY: -1e5, bubbles: true, cancelable: true, view: window };
  // Off every socket first, so the release React Flow sees connects nothing —
  // but only a wire React Flow has STARTED: moving one that has not would
  // start it, and its auto-pan slides the view at once (15 px, measured).
  if (started) document.dispatchEvent(new MouseEvent('mousemove', far));
  document.dispatchEvent(new MouseEvent('mouseup', far));
  // React Flow's release reached our window listener, which tore it down; a
  // wire that never started has no listener to reach — tear down here.
  active?.();
}

/**
 * Start a Branch-out wire from the Branch `knotId`'s output, at the pointer
 * `(clientX, clientY)` (the menu row's click, or where a Ctrl/Cmd drag left
 * its slop). False, starting nothing, when the Branch's socket is not on the
 * canvas.
 */
export function startBranchOut(knotId: string, clientX: number, clientY: number): boolean {
  cancelBranchOut();
  const socket = handleEl(nodeEl(knotId), 'source', 'out');
  if (!socket) return false;
  // A release that connects nothing opens no Add-node menu: it cancels.
  setEdgeDisconnecting(true);
  started = false;
  socket.dispatchEvent(new MouseEvent('mousedown', {
    clientX, clientY, bubbles: true, cancelable: true, button: 0, view: window,
  }));

  const swallow = (e: Event) => {
    e.stopPropagation();
    e.preventDefault();
  };
  // React Flow's own test for a started wire, mirrored on every move.
  const onMove = (e: Event) => {
    const m = e as MouseEvent;
    if (started || typeof m.clientX !== 'number') return;
    const dx = m.clientX - clientX;
    const dy = m.clientY - clientY;
    if (dx * dx + dy * dy > RF_CONNECTION_THRESHOLD * RF_CONNECTION_THRESHOLD) started = true;
  };
  const onPress = (e: Event) => {
    e.stopPropagation();
    // Never CANCEL the pointerdown: a cancelled one gets no compatibility
    // mousedown or mouseup (the cut stroke's trap, useCutStroke.ts), and the
    // mouseup is what React Flow ends the wire on — the click that should
    // connect left it hanging. The mousedown and touchstart are cancelled.
    if (e.type !== 'pointerdown') e.preventDefault();
    // Any button but the main one (a right-click) cancels.
    if (e instanceof MouseEvent && e.button !== 0) {
      cancelBranchOut();
      return;
    }
    // A finger has no hover: bring the wire to where it came down, so the
    // touchend that follows ends it there — a TAP on an input connects.
    if (e.type === 'touchstart') {
      const touch = (e as TouchEvent).touches?.[0];
      if (!touch) return;
      const at = { clientX: touch.clientX, clientY: touch.clientY, bubbles: true, cancelable: true, view: window };
      onMove(at as unknown as Event);
      document.dispatchEvent(new MouseEvent('mousemove', at));
    }
  };
  const onKey = (e: KeyboardEvent) => {
    // No graph key runs under the wire (stopped before every bubble-phase
    // handler: NodeEditor's accelerators and bare keys, the undo shortcut).
    e.stopPropagation();
    if (e.key !== 'Escape') return;
    e.preventDefault();
    cancelBranchOut();
  };
  const onBlur = () => cancelBranchOut();
  // BUBBLE phase on the window: after React Flow's own document listener has
  // ended the wire (connected, or not).
  const onRelease = () => finish(true);
  // The Branch the wire leaves is gone (an undo, a delete from elsewhere):
  // the wire would connect from a node that is not there.
  const unsubscribe = useAppStore.subscribe((s) => {
    if (!s.nodes.some((n) => n.id === knotId)) cancelBranchOut();
  });

  // The window the listeners went on, held: the deferred clean-up below must
  // take them off the SAME one.
  const win = window;
  const opts = { capture: true } as const;
  const touchOpts = { capture: true, passive: false } as const;
  win.addEventListener('pointerdown', onPress, opts);
  win.addEventListener('mousedown', onPress, opts);
  win.addEventListener('touchstart', onPress, touchOpts);
  win.addEventListener('mousemove', onMove, opts);
  win.addEventListener('touchmove', onMove, opts);
  win.addEventListener('contextmenu', swallow, opts);
  win.addEventListener('keydown', onKey, opts);
  win.addEventListener('blur', onBlur);
  win.addEventListener('mouseup', onRelease);
  win.addEventListener('touchend', onRelease);

  const finish = (afterRelease: boolean) => {
    if (active !== finishNow) return;
    active = null;
    started = false;
    unsubscribe();
    win.removeEventListener('keydown', onKey, opts);
    win.removeEventListener('blur', onBlur);
    win.removeEventListener('mouseup', onRelease);
    win.removeEventListener('touchend', onRelease);
    win.removeEventListener('mousemove', onMove, opts);
    win.removeEventListener('touchmove', onMove, opts);
    // The rest of THIS press stays swallowed — the mousedown after a
    // pointerdown that cancelled, the click (and a right-click's menu) after
    // the release — and the canvas has its presses back on the next task.
    if (afterRelease) win.addEventListener('click', swallow, opts);
    setTimeout(() => {
      win.removeEventListener('pointerdown', onPress, opts);
      win.removeEventListener('mousedown', onPress, opts);
      win.removeEventListener('touchstart', onPress, touchOpts);
      win.removeEventListener('click', swallow, opts);
      win.removeEventListener('contextmenu', swallow, opts);
    }, 0);
    // After onConnectEnd has read it this tick (the reconnect's rule).
    requestAnimationFrame(() => setEdgeDisconnecting(false));
  };
  const finishNow = () => finish(false);
  active = finishNow;
  return true;
}

/* ---------------- Ctrl/Cmd + drag on a Branch (owner, 2026-11-24) ---------------- */

/** How far a Ctrl/Cmd press on a Branch travels before it pulls a wire —
 *  the cut stroke's click slop: inside it the press is a click (Attach). */
export const BRANCH_PULL_SLOP_PX = 5;

/** Is this an Apple platform, where the modifier is ⌘ (introKeys' reading). */
export const APPLE_PLATFORM =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');

/**
 * The modifier that pulls a wire out of a Branch: Cmd on Apple, Ctrl
 * elsewhere. On macOS Ctrl+press is a CONTEXTMENU event (it opens Attach), so
 * Ctrl never pulls there.
 */
export function branchPullModifier(e: { ctrlKey: boolean; metaKey: boolean }, apple: boolean): boolean {
  return apple ? e.metaKey : e.ctrlKey;
}

/** The Branch whose DOT `target` is in, by its React Flow wrapper's id. */
function knotOfDot(target: EventTarget | null): string | null {
  const el = target as Element | null;
  const dot = typeof el?.closest === 'function' ? el.closest('.knot-node__dot') : null;
  return dot?.closest('.react-flow__node')?.getAttribute('data-id') ?? null;
}

/**
 * Install the Ctrl/Cmd + drag on the canvas element `root`: a main-button
 * mouse or pen press on a Branch's DOT with the modifier held is held back
 * from React Flow's node drag (its `mousedown` is stopped at the canvas, so
 * the Branch never moves), and once it travels past `BRANCH_PULL_SLOP_PX` it
 * becomes a Branch out (`startBranchOut`) under the held button — the release
 * on an input connects (one undo entry), anywhere else cancels (none). A press
 * that never travels is left a click: React Flow's node click opens Attach as
 * before. Touch never pulls (no modifier). Returns the teardown.
 */
export function installBranchPull(root: EventTarget, apple: boolean = APPLE_PLATFORM): () => void {
  let press: { knotId: string; x: number; y: number; pointerId: number } | null = null;
  const win = window;
  const opts = { capture: true } as const;

  const end = () => {
    press = null;
    win.removeEventListener('pointermove', onMove, opts);
    win.removeEventListener('pointerup', end, opts);
    win.removeEventListener('pointercancel', end, opts);
    win.removeEventListener('blur', end);
  };
  const onMove = (e: Event) => {
    const p = e as PointerEvent;
    if (!press || p.pointerId !== press.pointerId) return;
    if (Math.hypot(p.clientX - press.x, p.clientY - press.y) <= BRANCH_PULL_SLOP_PX) return;
    const { knotId } = press;
    end();
    startBranchOut(knotId, p.clientX, p.clientY);
  };
  const onPointerDown = (e: Event) => {
    const p = e as PointerEvent;
    if (press || branchOutActive()) return;
    if (p.button !== 0 || p.pointerType === 'touch') return;
    if (!branchPullModifier(p, apple)) return;
    const knotId = knotOfDot(p.target);
    if (!knotId) return;
    press = { knotId, x: p.clientX, y: p.clientY, pointerId: p.pointerId };
    win.addEventListener('pointermove', onMove, opts);
    win.addEventListener('pointerup', end, opts);
    win.addEventListener('pointercancel', end, opts);
    win.addEventListener('blur', end);
  };
  // The pull's own press never reaches React Flow's node drag (d3-drag hears
  // `mousedown`): the Branch stays where it is. The click is untouched.
  const onMouseDown = (e: Event) => {
    if (press) e.stopPropagation();
  };
  root.addEventListener('pointerdown', onPointerDown, opts);
  root.addEventListener('mousedown', onMouseDown, opts);
  return () => {
    end();
    root.removeEventListener('pointerdown', onPointerDown, opts);
    root.removeEventListener('mousedown', onMouseDown, opts);
  };
}
