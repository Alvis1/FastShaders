/**
 * How far a DRAG moves a node's number (DragNumberInput; owner, 2026-11-16).
 *
 * A plain drag moves the value in steps of the field's `step` — 0.1 for an
 * ordinary number, 1 for a whole-number field, the finer steps the Output
 * nodes' settings declare — one step per DRAG_PX_PER_STEP screen pixels, at a
 * constant rate, so a small number can be set exactly. CTRL (or ⌘) makes each
 * step ten times as big (1 on an ordinary field), SHIFT ten times as small
 * (0.01) — except on a whole-number field, which cannot hold a tenth and keeps
 * its own step. Shift wins when both are held. Nothing accelerates with
 * distance: a pull of a few centimetres never overshoots by tens.
 *
 * Until 2026-11-16 Shift made steps BIGGER (×10, then ×100 further out). The
 * owner turned it round after the professional sessions: Blender and Unreal
 * users reach for Shift to go finer.
 *
 * The offset is measured from where the drag (or the last modifier press or
 * release) started, so dragging back to the start gives the start value back
 * exactly, and pressing a modifier mid-drag changes the rate from there on
 * rather than making the value jump. Pure: no DOM, no store.
 */

/** Screen pixels the pointer travels per step. */
export const DRAG_PX_PER_STEP = 10;

/** What the held modifiers do to a drag's step. */
export type DragRate = 'plain' | 'coarse' | 'fine';

/** The rate the held keys ask for: Shift fine, Ctrl or ⌘ coarse, Shift first. */
export function dragRate(keys: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }): DragRate {
  if (keys.shiftKey) return 'fine';
  if (keys.ctrlKey || keys.metaKey) return 'coarse';
  return 'plain';
}

/** The step a field drags by: its own when that is a positive number, else 0.1. */
export function dragStep(step: unknown): number {
  return typeof step === 'number' && Number.isFinite(step) && step > 0 ? step : 0.1;
}

/** A whole-number step (1, 2…): the field holds integers, so it has no finer step. */
function isWholeStep(s: number): boolean {
  return Number.isInteger(s) && s >= 1;
}

/** The step a drag moves by at this rate: the field's, ×10, or ÷10. */
export function dragStepAt(step: unknown, rate: DragRate): number {
  const s = dragStep(step);
  if (rate === 'coarse') return s * 10;
  if (rate === 'fine') return isWholeStep(s) ? s : s / 10;
  return s;
}

/**
 * The value change for a pointer `dx` screen pixels from where the rate
 * began: whole steps only (truncated toward zero, so a few pixels either way
 * change nothing).
 */
export function dragOffset(dx: number, step: unknown, rate: DragRate): number {
  if (!Number.isFinite(dx)) return 0;
  // Pointer coordinates are fractional, and their difference is not exact:
  // 521.97 − 431.97 is 89.999…, which would count 8 steps at 90 px. Rounded
  // to a hundredth of a pixel first.
  const n = Math.trunc(Math.round(dx * 100) / 100 / DRAG_PX_PER_STEP);
  return n * dragStepAt(step, rate);
}

/**
 * Decimal places a value moved by `step` must be rounded to so the step is
 * never rounded away (0.0001 needs 4, 0.00005 needs 5) — at least `min`.
 */
export function stepDecimals(step: number, min: number): number {
  if (!(step > 0) || !Number.isFinite(step)) return min;
  const need = Math.ceil(-Math.log10(step) - 1e-9);
  return Math.min(10, Math.max(min, need));
}

/** A step as the readout prints it: a dot whatever the locale (the number
 *  fields' rule), without the float noise of 0.1 × 10. */
export function formatDragStep(step: number): string {
  return String(Number(step.toPrecision(10)));
}
