/**
 * How far a DRAG moves a node's number (DragNumberInput; owner, 2026-11-13).
 *
 * A plain drag moves the value in steps of the field's `step` — 0.1 for an
 * ordinary number, 1 for a whole-number field, the finer steps the Output
 * nodes' settings declare — one step per DRAG_PX_PER_STEP screen pixels, at a
 * constant rate, so a small number can be set exactly. SHIFT+drag moves it ten
 * times as far per step (1 on an ordinary field), and past the first
 * COARSE_NEAR_STEPS of those, a hundred times (10): the near range is still
 * aimable and a long pull still reaches a large number. Neither accelerates
 * with distance otherwise — the old drag did, which is what made a pull of a
 * few centimetres overshoot by tens.
 *
 * The offset is measured from where the drag (or the last Shift press or
 * release) started, so dragging back to the start gives the start value back
 * exactly, and pressing Shift mid-drag changes the rate from there on rather
 * than making the value jump. Pure: no DOM, no store.
 */

/** Screen pixels the pointer travels per step. */
export const DRAG_PX_PER_STEP = 10;

/** Shift+drag: this many ×10 steps either side of the start, then ×100. */
export const COARSE_NEAR_STEPS = 10;

/** The step a field drags by: its own when that is a positive number, else 0.1. */
export function dragStep(step: unknown): number {
  return typeof step === 'number' && Number.isFinite(step) && step > 0 ? step : 0.1;
}

/**
 * The value change for a pointer `dx` screen pixels from the drag's start:
 * whole steps only (truncated toward zero, so a few pixels either way change
 * nothing), `coarse` for Shift.
 */
export function dragOffset(dx: number, step: number, coarse: boolean): number {
  if (!Number.isFinite(dx)) return 0;
  const s = dragStep(step);
  // Pointer coordinates are fractional, and their difference is not exact:
  // 521.97 − 431.97 is 89.999…, which would count 8 steps at 90 px. Rounded
  // to a hundredth of a pixel first.
  const n = Math.trunc(Math.round(dx * 100) / 100 / DRAG_PX_PER_STEP);
  if (!coarse) return n * s;
  const a = Math.abs(n);
  const near = Math.min(a, COARSE_NEAR_STEPS);
  return Math.sign(n) * (near * s * 10 + (a - near) * s * 100);
}

/**
 * The step a drag is moving by RIGHT NOW, `dx` pixels from where its rate
 * began — what the readout above a dragged number shows (DragNumberInput).
 * Plain: the field's step. Shift: ten of them while still within
 * COARSE_NEAR_STEPS of the start, a hundred past that — the size of the NEXT
 * step outward, so the readout changes exactly where dragOffset's rate does.
 */
export function dragStepNow(dx: number, step: unknown, coarse: boolean): number {
  const s = dragStep(step);
  if (!coarse) return s;
  const n = Number.isFinite(dx) ? Math.abs(Math.trunc(Math.round(dx * 100) / 100 / DRAG_PX_PER_STEP)) : 0;
  return s * (n < COARSE_NEAR_STEPS ? 10 : 100);
}

/** A step as the readout prints it: a dot whatever the locale (the number
 *  fields' rule), without the float noise of 0.1 × 10. */
export function formatDragStep(step: number): string {
  return String(Number(step.toPrecision(10)));
}
