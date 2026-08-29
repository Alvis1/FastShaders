/**
 * Telling a TRACKPAD two-finger scroll from a notched MOUSE WHEEL.
 *
 * The canvas has to answer this because the two gestures mean opposite things
 * and arrive as the same event: a mouse wheel means ZOOM (what every node
 * editor does, and what this one has always done), while a trackpad two-finger
 * swipe means PAN — nobody expects a flick to change the zoom level, and on a
 * trackpad the zoom gesture is the pinch, which arrives separately with
 * `ctrlKey`. Guessing wrong is loud in one direction: a mouse user whose wheel
 * suddenly pans has lost their zoom control, so every rule below is written to
 * fall back to "wheel" when it cannot tell.
 *
 * Pure and DOM-free (it reads plain numbers off the event), so it is testable
 * under the node env — which matters, because the whole thing is heuristics
 * over per-platform reporting conventions and there is no way to feel a
 * regression here except by having a mouse and a trackpad on the desk.
 */

/** The fields this needs — a real WheelEvent satisfies it structurally. */
export interface WheelSample {
  deltaMode: number;
  deltaX: number;
  deltaY: number;
  /** Chromium/WebKit legacy fields; absent in Firefox. */
  wheelDeltaX?: number;
  wheelDeltaY?: number;
}

/** One notch of a classic wheel, by the legacy IE convention every engine kept. */
const DETENT = 120;

/**
 * Does this event look like it came from a precision device (trackpad, Windows
 * precision touchpad, magic mouse) rather than a notched wheel?
 *
 * Two signals, in order of reliability:
 *
 *  1. `deltaMode` — a trackpad ALWAYS reports pixels (`DOM_DELTA_PIXEL`, 0).
 *     Line or page deltas can only be a classic wheel, which is Firefox's
 *     default for a mouse, so that is an immediate no.
 *  2. `wheelDelta` — Chromium and WebKit still report the legacy field, and a
 *     notched wheel's value is a MULTIPLE OF 120 (one detent) while a
 *     trackpad's is 3x its pixel delta and hits 120 only by coincidence.
 *
 * Firefox reports no `wheelDelta` at all, so a pixel-mode event there has
 * already been identified by rule 1 and is taken as precision.
 *
 * A single event can still be wrong — a trackpad flick CAN land on a multiple
 * of 120 — which is why callers latch the answer per gesture rather than
 * re-deciding per event; see `WheelGesture`.
 */
export function isPrecisionWheel(e: WheelSample): boolean {
  if (e.deltaMode !== 0) return false;
  const raw: number[] = [];
  if (typeof e.wheelDeltaY === 'number' && e.wheelDeltaY !== 0) raw.push(e.wheelDeltaY);
  if (typeof e.wheelDeltaX === 'number' && e.wheelDeltaX !== 0) raw.push(e.wheelDeltaX);
  if (raw.length) return raw.some((v) => Math.abs(v) % DETENT !== 0);
  return true;
}

/** Wheel events closer together than this belong to one gesture. */
export const WHEEL_GESTURE_GAP_MS = 150;

/**
 * Latches `isPrecisionWheel` across a gesture, UPGRADE-ONLY: once any event in
 * the run looks like a trackpad the whole run is a trackpad, and it can never
 * fall back the other way mid-flick.
 *
 * The asymmetry is the point. A trackpad emits a burst of events and only some
 * of them are individually distinguishable (a slow scroll really can report
 * exactly one detent's worth), so re-deciding per event makes a single flick
 * alternate between panning and zooming — visibly worse than either answer on
 * its own. A mouse wheel, meanwhile, never produces a precision-looking event
 * at all, so the upgrade cannot fire spuriously for it.
 */
export class WheelGesture {
  private precision = false;
  private lastTs = -Infinity;

  /** Feed one event; returns whether to treat the CURRENT gesture as a trackpad. */
  next(e: WheelSample, timeStamp: number): boolean {
    if (timeStamp - this.lastTs > WHEEL_GESTURE_GAP_MS) this.precision = false;
    this.lastTs = timeStamp;
    if (isPrecisionWheel(e)) this.precision = true;
    return this.precision;
  }
}
