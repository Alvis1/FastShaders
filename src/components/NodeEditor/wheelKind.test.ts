import { describe, it, expect } from 'vitest';
import { isPrecisionWheel, WheelGesture, WHEEL_GESTURE_GAP_MS, type WheelSample } from './wheelKind';

/** A notched mouse wheel as Chromium/WebKit report it: pixel mode, and a
 *  wheelDelta that is a whole number of 120-unit detents. */
const wheel = (notches = 1): WheelSample => ({
  deltaMode: 0,
  deltaX: 0,
  deltaY: notches * 100,
  wheelDeltaY: notches * -120,
  wheelDeltaX: 0,
});

/** A trackpad two-finger swipe: pixel mode, wheelDelta exactly -3x the pixel
 *  delta and (almost always) off the detent grid. */
const pad = (dy: number, dx = 0): WheelSample => ({
  deltaMode: 0,
  deltaX: dx,
  deltaY: dy,
  wheelDeltaY: dy * -3,
  wheelDeltaX: dx * -3,
});

describe('isPrecisionWheel', () => {
  it('rejects a notched mouse wheel at every speed', () => {
    // Acceleration multiplies whole detents, so a fast wheel stays on the grid.
    for (const n of [1, -1, 2, -3, 5, 10]) expect(isPrecisionWheel(wheel(n))).toBe(false);
  });

  it('rejects line- and page-mode deltas outright', () => {
    // Firefox's default for a mouse. A trackpad always reports pixels, so this
    // needs no second opinion.
    expect(isPrecisionWheel({ deltaMode: 1, deltaX: 0, deltaY: 3 })).toBe(false);
    expect(isPrecisionWheel({ deltaMode: 2, deltaX: 0, deltaY: 1 })).toBe(false);
  });

  it('accepts ordinary trackpad deltas', () => {
    for (const d of [1, -1, 2, 7, -13, 0.5, -0.25, 47]) expect(isPrecisionWheel(pad(d))).toBe(true);
  });

  it('accepts a pixel-mode event with no wheelDelta at all (Firefox trackpad)', () => {
    // Firefox implements neither wheelDeltaX nor wheelDeltaY, so rule 1 is the
    // only signal there — and it has already excluded that engine's mice.
    expect(isPrecisionWheel({ deltaMode: 0, deltaX: 0, deltaY: 12 })).toBe(true);
  });

  it('is fooled by a trackpad delta that lands exactly on a detent', () => {
    // The known failure of the per-event test, and the reason WheelGesture
    // latches: 40px * 3 = 120. Pinned so the limitation stays visible rather
    // than being rediscovered as a bug.
    expect(isPrecisionWheel(pad(-40))).toBe(false);
  });

  it('reads a horizontal-only trackpad swipe off wheelDeltaX', () => {
    expect(isPrecisionWheel(pad(0, 7))).toBe(true);
  });
});

describe('WheelGesture — latching', () => {
  it('keeps a mouse wheel classified as a wheel for the whole run', () => {
    const g = new WheelGesture();
    let t = 0;
    for (let i = 0; i < 20; i++) expect(g.next(wheel(), (t += 40))).toBe(false);
  });

  it('carries a trackpad verdict across an event that looks like a detent', () => {
    // The flick this exists for: most events say trackpad, one lands on 120.
    // Without the latch that single event would zoom mid-pan.
    const g = new WheelGesture();
    let t = 0;
    expect(g.next(pad(-7), (t += 16))).toBe(true);
    expect(g.next(pad(-40), (t += 16))).toBe(true);
    expect(g.next(pad(-12), (t += 16))).toBe(true);
  });

  it('upgrades mid-gesture but never downgrades', () => {
    const g = new WheelGesture();
    let t = 0;
    expect(g.next(pad(-40), (t += 16))).toBe(false); // ambiguous first event
    expect(g.next(pad(-7), (t += 16))).toBe(true); // upgraded
    expect(g.next(wheel(), (t += 16))).toBe(true); // and it stays
  });

  it('forgets the verdict once the gesture ends', () => {
    // Swipe on the trackpad, then reach for the mouse: the wheel must zoom.
    const g = new WheelGesture();
    expect(g.next(pad(-7), 0)).toBe(true);
    expect(g.next(wheel(), WHEEL_GESTURE_GAP_MS + 1)).toBe(false);
  });

  it('treats a gap of exactly the threshold as the same gesture', () => {
    const g = new WheelGesture();
    expect(g.next(pad(-7), 0)).toBe(true);
    expect(g.next(wheel(), WHEEL_GESTURE_GAP_MS)).toBe(true);
  });

  it('starts as a wheel, so the very first event of a session cannot pan', () => {
    // The bias that matters: a mouse user must never lose zoom, so an
    // unclassifiable event resolves to the historical behaviour.
    expect(new WheelGesture().next(wheel(), 0)).toBe(false);
  });
});
