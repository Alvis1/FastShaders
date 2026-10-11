import { appTime } from './appClock';

/**
 * ONE frame loop for every decorative canvas surface — the live edge-value
 * labels, the sin/cos card, the Time node's hand, the animated noise
 * thumbnails, the Sound meter and the edge info chip.
 *
 * WHY one loop at a LOW rate, measured on a 150-node graph with one Time node
 * (headless Chrome, ants off, 2026-10-11): every frame in which ANY canvas
 * element is written pays Chrome's whole-canvas layerization pass. Six loops
 * each writing on every frame cost 8.8 ms/frame at 1x and kept a 4x-throttled
 * CPU 100% busy; freezing any ONE writer saved at most 8%, because the other
 * five still dirtied the same frames. Only writing TOGETHER, on few frames,
 * helps: a shared 30 Hz gate measured 4.9 ms/frame at 1x but nothing at 4x;
 * 15 Hz measured 2.6 ms/frame at 1x and 69% busy at 4x. So every subscriber
 * runs on the SAME frames, at FRAME_TICK_HZ — the ONE rate constant.
 *
 * Off-screen and hidden subscribers are skipped. ONE IntersectionObserver
 * watches the element each subscriber names: a card panned out of the pane,
 * or a member of a COLLAPSED group (only `display: none`'d — the store keeps
 * it MOUNTED on purpose, so its loop survives the collapse), reports "not
 * intersecting". That matters because Chrome does not skip the cost for you:
 * with the cards panned off-screen the same graph still spent 4.1 ms/frame
 * (0.23 with their writes stopped). It replaces the per-loop `offsetParent`
 * reads, which also forced one layout per label after the previous label's
 * write. Skipping is safe because the clock is ABSOLUTE (utils/appClock): the
 * first tick after a card comes back draws the true current value, not a
 * resumed private epoch. A one-shot STATIC draw must never be routed through
 * here — it has no later frame to catch up on, and a hidden canvas keeps its
 * bitmap, so drawing into it is what makes it right the moment it reappears.
 *
 * Every subscriber receives `appTime(ts)` of the frame it runs on (the ONE
 * clock rule), so all surfaces evaluate one t per tick and share
 * cpuEvaluator's per-time cache bucket.
 *
 * The loop exists only while something is subscribed, and the observer only
 * while something is observed. The 3D preview's Sound pump drives the SHADER,
 * not a canvas surface, and deliberately stays on its own clock.
 */
export const FRAME_TICK_HZ = 15;
const FRAME_TICK_MS = 1000 / FRAME_TICK_HZ;
/**
 * Frame timestamps jitter by a fraction of a millisecond, so a tick due at
 * 66.67 ms must still fire on a 60 Hz panel's 4th frame (66.6 ms) rather than
 * slipping to the 5th (83 ms, i.e. 12 Hz).
 */
const SLACK_MS = 2;

/** Called on every shared tick while the subscriber's element is visible. */
export type FrameTick = (t: number) => void;

export interface FrameLoopOptions<E extends Element = Element> {
  /** Called INSTEAD of the tick while the element is off-screen or hidden. */
  onHidden?: (t: number) => void;
  /** Called once when the subscription stops, with the element it watched. */
  onStop?: (el: E | null) => void;
}

interface Sub {
  el: Element | null;
  tick: FrameTick;
  hidden?: (t: number) => void;
}

const subs = new Set<Sub>();
let rafId = 0;
/** Timestamp of the last tick; -Infinity = tick on the next frame. */
let lastTick = -Infinity;

const observed = new Map<Element, number>();
const offscreen = new WeakSet<Element>();
let io: IntersectionObserver | null = null;

function frame(ts: number): void {
  // Schedule first, so a throwing subscriber cannot stop the loop.
  rafId = requestAnimationFrame(frame);
  // A MINIMUM interval, not a phase-locked cadence: on a saturated CPU whose
  // frames take 45 ms, a cadence would tick on two frames out of three to keep
  // its average, while this ticks every other one — the loaded machine is the
  // one that most needs its frames left alone (the 69% figure above was
  // measured with this policy). A 144 Hz panel gets 14.4 Hz.
  if (ts - lastTick < FRAME_TICK_MS - SLACK_MS) return;
  lastTick = ts;
  const t = appTime(ts);
  for (const s of subs) {
    try {
      if (s.el !== null && offscreen.has(s.el)) s.hidden?.(t);
      else s.tick(t);
    } catch (err) {
      // One broken surface must not freeze every other one on the canvas.
      console.error(err);
    }
  }
}

function observe(el: Element): void {
  const n = observed.get(el) ?? 0;
  observed.set(el, n + 1);
  if (n > 0) return;
  if (io === null && typeof IntersectionObserver !== 'undefined') {
    io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) offscreen.delete(e.target);
        else offscreen.add(e.target);
      }
    });
  }
  // Until the observer's first report the element counts as visible.
  io?.observe(el);
}

function unobserve(el: Element): void {
  const n = observed.get(el) ?? 0;
  if (n > 1) {
    observed.set(el, n - 1);
    return;
  }
  observed.delete(el);
  offscreen.delete(el);
  io?.unobserve(el);
  if (observed.size === 0 && io !== null) {
    io.disconnect();
    io = null;
  }
}

/**
 * Run `tick` on every shared frame tick while `el` is on screen (a null `el`
 * is always treated as visible). Returns the stop function.
 */
export function subscribeFrames<E extends Element>(
  el: E | null,
  tick: FrameTick,
  opts?: FrameLoopOptions<E>,
): () => void {
  const sub: Sub = { el, tick, hidden: opts?.onHidden };
  subs.add(sub);
  if (el !== null) observe(el);
  if (subs.size === 1) {
    lastTick = -Infinity;
    rafId = requestAnimationFrame(frame);
  }
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    subs.delete(sub);
    if (el !== null) unobserve(el);
    if (subs.size === 0) cancelAnimationFrame(rafId);
    opts?.onStop?.(el);
  };
}
