/**
 * The ONE text rule of every number field in the app: a field SHOWS a number
 * with a dot whatever the locale, and TAKES a dot or a comma as the decimal
 * separator.
 *
 * Why a text field at all: `<input type="number">` draws its value in the
 * browser's own localized form. On a Latvian machine Chrome printed `0,5958`
 * and `-0,5` in the settings menus beside every other value's `0.5`, whatever
 * the app's own language (measured 2026-10-10, the Data Viz menu), and which
 * separator it would accept back depended on the browser. So every number field
 * is an `<input type="text">` — `components/inputs/NumberField.tsx`, and the LUT
 * editors' `LazyNumberField` — whose text goes through these functions only.
 *
 * Pure LEAF (imports nothing): the field, its callers' commit paths and the
 * node tests share one copy.
 */

/**
 * A typed number, or null while the text is not one (yet): `.` or `,` as the
 * decimal separator — an OS keypad may type either (iOS's decimal keypad types
 * the region's) — in decimal notation, with an optional exponent (`1e-4`, which
 * `<input type="number">` took as well). `Number()` alone would also take
 * `0x10`, `Infinity` and the empty string.
 */
export function parseFieldNumber(raw: string): number | null {
  const s = raw.trim().replace(',', '.');
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * How a field SHOWS a number: a JS number's own text, so a dot whatever the
 * locale, with float noise cut at `decimals` places (`0.1 + 0.2` shows `0.3`);
 * EMPTY for a non-finite value, as `<input type="number">` showed one — a junk
 * stored value must not read as a real `0`. Whatever this prints,
 * `parseFieldNumber` reads back.
 */
export function formatFieldNumber(n: number, decimals = 6): string {
  if (!Number.isFinite(n)) return '';
  const f = 10 ** decimals;
  const scaled = n * f;
  // Past 2^53 the scaled value has no fraction left to round (and n·f can overflow).
  return String(Math.abs(scaled) < Number.MAX_SAFE_INTEGER ? Math.round(scaled) / f : n);
}

/** `n` held inside a field's range; a bound left out is no bound, and NaN stays NaN. */
export function clampFieldNumber(n: number, min?: number, max?: number): number {
  if (min !== undefined && n < min) return min;
  if (max !== undefined && n > max) return max;
  return n;
}

/** What a field steps by and within. */
export interface FieldRange {
  /** One arrow press or wheel notch; ×10 with Shift. */
  step: number;
  min?: number;
  max?: number;
}

/**
 * The text one step leaves in a field: `dir` steps (×10 with Shift) from the
 * number the field SHOWS — or, while that text does not parse, from `value`,
 * the number it stands for (0 when that is no number either, as the number
 * input stepped an empty field) — clamped and formatted. Plain `± step`, never
 * snapped to a `min + k·step` grid: with the point cap's min of 1 the number
 * input stepped 200 to 201 instead of 210.
 */
export function stepFieldText(text: string, value: number, dir: 1 | -1, shift: boolean, range: FieldRange): string {
  const from = parseFieldNumber(text) ?? (Number.isFinite(value) ? value : 0);
  const step = Number.isFinite(range.step) && range.step > 0 ? range.step : 1;
  return formatFieldNumber(clampFieldNumber(from + dir * step * (shift ? 10 : 1), range.min, range.max));
}

/** The keys a field answers, read structurally so a node test can drive it. */
export interface FieldKey {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  /** An IME composition is in progress: its Enter, Escape and arrows are the IME's. */
  isComposing: boolean;
}

export type FieldKeyAction = { kind: 'enter' } | { kind: 'escape' } | { kind: 'step'; text: string } | null;

/**
 * What a key does in a field: Enter and Escape are REPORTED (each caller
 * decides what they commit or cancel), ArrowUp/ArrowDown step the shown text
 * (Shift ×10; with Alt/Ctrl/Cmd they keep moving the caret, as in any text
 * field), and nothing at all happens mid-composition.
 */
export function fieldKeyAction(e: FieldKey, text: string, value: number, range: FieldRange): FieldKeyAction {
  if (e.isComposing) return null;
  if (e.key === 'Enter') return { kind: 'enter' };
  if (e.key === 'Escape') return { kind: 'escape' };
  if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.altKey && !e.ctrlKey && !e.metaKey) {
    return { kind: 'step', text: stepFieldText(text, value, e.key === 'ArrowUp' ? 1 : -1, e.shiftKey, range) };
  }
  return null;
}

/** A wheel event, read structurally. */
export interface FieldWheel {
  deltaX: number;
  deltaY: number;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  defaultPrevented: boolean;
}

/**
 * The text one wheel event over a FOCUSED field leaves, or null to leave the
 * wheel alone. The number input's own rule, kept: a vertical notch steps (away
 * from you = up) — but only a wheel nothing else took (`defaultPrevented`: the
 * canvas zooms over a node's field, the Designer stage pans), and never a zoom
 * gesture (Ctrl/Cmd, which a trackpad pinch also reports).
 *
 * With Shift the notch steps ×10 — and arrives SIDEWAYS from a mouse: macOS and
 * Chrome on Windows turn a Shift+wheel into a horizontal scroll (`deltaY` 0),
 * so under Shift a horizontal delta is the notch (away from you, or left, =
 * up). Without Shift a sideways wheel — a trackpad swipe — steps nothing.
 */
export function fieldWheelText(e: FieldWheel, text: string, value: number, range: FieldRange): string | null {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey) return null;
  const d = e.deltaY !== 0 ? e.deltaY : e.shiftKey ? e.deltaX : 0;
  if (!(d < 0 || d > 0)) return null;
  return stepFieldText(text, value, d < 0 ? 1 : -1, e.shiftKey, range);
}

/**
 * The on-screen keyboard a field asks for (`inputMode`). The iOS `decimal` and
 * `numeric` keypads have NO minus key, so only a field whose `min` is 0 or more
 * gets one; a field that may go negative (no `min`, or a negative one) gets the
 * full keyboard. `numeric` — digits only — for a whole-number field.
 */
export function fieldInputMode(min: number | undefined, integer = false): 'text' | 'decimal' | 'numeric' {
  if (min === undefined || !(min >= 0)) return 'text';
  return integer ? 'numeric' : 'decimal';
}
