/**
 * Mic node settings: the values contract, and the ONE place they are coerced.
 *
 * The Mic node carries no payload — just three settings-only numbers, the same
 * shape as the Time node's `speed`. So it follows the same rule that node uses
 * rather than growing a `sanitizeMicNodes` store pass: values arrive from
 * `.fastshader` files and `localStorage` and are therefore adversarial, and
 * every read site coerces with `Number()` + a range clamp, never `String()` and
 * never `resolveExposedParam` (which interpolates verbatim).
 *
 * A store-level sanitize pass exists for `imageNode` / `drawings` because those
 * carry unbounded PAYLOADS that must be bounded before they reach the autosave.
 * Three clamped scalars have no such exposure — clamping at read is both
 * sufficient and impossible to forget, because there is nowhere else to read
 * them from.
 *
 * These are also the values the AnalyserNode is configured with, and the Web
 * Audio spec THROWS on out-of-range input: `fftSize` must be a power of two in
 * [32, 32768] (`IndexSizeError`) and `smoothingTimeConstant` must be in [0, 1]
 * (`IndexSizeError`). An unclamped value from a shared project would take down
 * the capture path, so the clamp is load-bearing, not cosmetic.
 */

/** Allowed FFT sizes. Larger = finer bands but more latency and CPU. */
export const MIC_FFT_SIZES = [512, 1024, 2048] as const;

export type MicFftSize = (typeof MIC_FFT_SIZES)[number];

export interface MicSettings {
  /** AnalyserNode.smoothingTimeConstant — exponential averaging in the audio thread. */
  smoothing: number;
  /** Post-normalization multiplier applied to every band. */
  gain: number;
  fftSize: MicFftSize;
}

/**
 * 0.95 rather than the spec's 1.0: at exactly 1 the analyser's exponential
 * average never admits new data and every band freezes at its initial value —
 * a "smoothing" slider whose top end silently means "off" reads as broken.
 */
export const MIC_SMOOTHING_MIN = 0;
export const MIC_SMOOTHING_MAX = 0.95;
export const MIC_GAIN_MIN = 0.25;
export const MIC_GAIN_MAX = 8;

export const MIC_SETTINGS_DEFAULTS: MicSettings = {
  smoothing: 0.8,
  gain: 1,
  fftSize: 1024,
};

/**
 * The `defaultValues` a Mic node is created with (registry + Node Settings).
 *
 * `fftSize` is deliberately NOT here. The generic NodeSettingsMenu loop renders
 * every numeric entry as a free-drag number widget, and fftSize accepts only
 * powers of two — dragging it to 1023 would store a value `readMicSettings`
 * then silently snaps back to 1024, i.e. a control that appears to do nothing.
 * A correct control needs a select, which is not worth a bespoke settings
 * component for a value with one sensible answer: 1024 bins at 48 kHz is a
 * ~21 ms window, the point where band resolution and responsiveness balance
 * for a VISUAL driver. `readMicSettings` still coerces it defensively, so a
 * stored value from a hand-edited project can't reach the analyser unclamped.
 */
export const MIC_DEFAULT_VALUES: Record<string, number> = {
  smoothing: MIC_SETTINGS_DEFAULTS.smoothing,
  gain: MIC_SETTINGS_DEFAULTS.gain,
};

function clampNum(raw: unknown, min: number, max: number, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return n < min ? min : n > max ? max : n;
}

/**
 * Coerce a Mic node's stored `values` into settings safe to hand to Web Audio.
 *
 * `fftSize` snaps to the nearest ALLOWED size rather than clamping, because a
 * clamp would turn a stored 600 into 512 while a stored 4096 became 2048 — both
 * fine — but a stored 1023 into 1023, which is not a power of two and throws.
 */
export function readMicSettings(values: Record<string, unknown> | undefined | null): MicSettings {
  const v = values ?? {};
  const rawFft = Number(v.fftSize);
  const fftSize: MicFftSize = MIC_FFT_SIZES.includes(rawFft as MicFftSize)
    ? (rawFft as MicFftSize)
    : MIC_SETTINGS_DEFAULTS.fftSize;
  return {
    smoothing: clampNum(
      v.smoothing,
      MIC_SMOOTHING_MIN,
      MIC_SMOOTHING_MAX,
      MIC_SETTINGS_DEFAULTS.smoothing,
    ),
    gain: clampNum(v.gain, MIC_GAIN_MIN, MIC_GAIN_MAX, MIC_SETTINGS_DEFAULTS.gain),
    fftSize,
  };
}
