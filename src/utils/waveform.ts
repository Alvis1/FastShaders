/**
 * Pure geometry + label model for the sin/cos waveform SVG — the shared math
 * behind WaveformSvg (MathPreviewNode's plot and its asset-card twin).
 *
 * Replaces the per-frame canvas repaint (the old utils/mathPreview.ts): the
 * periodic curve is built ONCE as a path spanning two cycles, and animation
 * is a per-frame translateX of that path plus a translateY of the dot — two
 * style writes instead of a full 72×72 CPU raster. Vector output also stays
 * sharp under the viewport zoom, where the fixed-resolution canvas blurred.
 *
 * Everything here is DOM-free on purpose (node-env testable); WaveformSvg
 * owns the elements.
 */

const TWO_PI = Math.PI * 2;

/** Square plot size in CSS px (matches the old canvas). */
export const WAVE_SIZE = 72;
/** Vertical value range of the plot window. */
export const WAVE_Y_MIN = -1.35;
export const WAVE_Y_MAX = 1.35;
/** One 2π cycle spans the full window width. */
export const WAVE_CYCLE_PX = WAVE_SIZE;
/** Grid lines at these function values (the old canvas's dashed rows). */
export const WAVE_GRID_YS = [-1, -0.5, 0.5, 1];

/** Function value → svg y. */
export function waveScreenY(y: number): number {
  return WAVE_SIZE - ((y - WAVE_Y_MIN) / (WAVE_Y_MAX - WAVE_Y_MIN)) * WAVE_SIZE;
}

/**
 * Static path for `func` over x ∈ [−π, 3π] — two full cycles, sampled per px.
 * The visible window shows one cycle; `waveTranslateX` slides the path so the
 * window is always covered, and for 2π-periodic funcs the wrap at
 * phase = 2π is pixel-identical (pinned by test).
 */
export function buildWavePath(func: (x: number) => number): string {
  const parts: string[] = [];
  const total = WAVE_CYCLE_PX * 2;
  for (let px = 0; px <= total; px++) {
    const x = -Math.PI + (px / WAVE_CYCLE_PX) * TWO_PI;
    const y = waveScreenY(func(x));
    parts.push(`${px === 0 ? 'M' : 'L'}${px} ${+y.toFixed(2)}`);
  }
  return parts.join(' ');
}

/**
 * Per-frame curve translate (px) for the current phase, always in
 * (−WAVE_CYCLE_PX, 0] so the two-cycle path keeps the window covered. The
 * window ends up showing x ∈ [phase−π, phase+π] with x = phase at center —
 * where the dot sits — matching the old canvas framing exactly.
 */
export function waveTranslateX(phase: number): number {
  if (!Number.isFinite(phase)) return 0;
  const frac = (((phase % TWO_PI) + TWO_PI) % TWO_PI) / TWO_PI;
  return -frac * WAVE_CYCLE_PX;
}

/** JetBrains Mono advance is exactly 0.6 em → 4.8 px at the 8px label size. */
export const WAVE_LABEL_CHAR_PX = 4.8;
/** Pill padding the label carries beyond the glyph run. */
export const WAVE_LABEL_PAD_PX = 6;

/** Pill width for a given label string (mono metrics — pure arithmetic). */
export function waveLabelWidth(label: string): number {
  return label.length * WAVE_LABEL_CHAR_PX + WAVE_LABEL_PAD_PX;
}

/**
 * Fit-aware readout. The old canvas drew
 * `sin(48.3) = -0.923` unconditionally — ~82px of mono on a 72px canvas, so
 * BOTH ends clipped (the missing "s" made it read as "ln(48.3)", and any
 * time-fed input reaches two digits ten seconds after mount). Mono metrics
 * make the fit check pure arithmetic: use the full form when it fits the
 * plot, otherwise just the output value — which matches the edge info chip's
 * format (toFixed(2)), so the two surfaces read identically.
 */
export function waveLabel(
  funcLabel: string,
  input: number,
  value: number,
  maxPx: number = WAVE_SIZE,
): string {
  if (!Number.isFinite(input) || !Number.isFinite(value)) return '…';
  const full = `${funcLabel}(${input.toFixed(1)}) = ${value.toFixed(2)}`;
  if (waveLabelWidth(full) <= maxPx) return full;
  return value.toFixed(2);
}
