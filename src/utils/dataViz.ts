/**
 * Pure DSP helpers for turning a 1-D data column into the lookup textures the
 * Stripes node samples. Kept dependency-free and deterministic so the same code
 * runs at code-gen (host) and is unit-testable without a GPU.
 *
 * The headline transform is `buildPhaseRamp`: data-driven stripe *density* must
 * come from a precomputed cumulative phase (a prefix-sum of the desired local
 * frequency), NOT from `position × frequency(value)`. Instantaneous frequency
 * is the derivative of phase, so phase must be the integral of frequency; a
 * naive product injects a spurious `x·f'(x)` term and the stripes tear wherever
 * the value changes. Because the cumulative sum is monotonic, the resulting
 * ramp is continuous and the shader can derivative-antialias it cleanly.
 */

/** Largest texture width we bake. Comfortably under the WebGPU 8192 min-spec
 *  guarantee for maxTextureDimension2D; longer columns are mean-downsampled. */
export const MAX_TEXTURE_WIDTH = 8192;

export interface MinMax {
  min: number;
  max: number;
}

export function minMax(values: ArrayLike<number>): MinMax {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1 };
  return { min, max };
}

/** Map values into [0, 1] via min/max, clamped. A flat column (max==min) maps
 *  to all-zeros (no spurious gradient). */
export function normalize01(values: ArrayLike<number>, mm: MinMax): Float32Array {
  const span = mm.max - mm.min;
  const out = new Float32Array(values.length);
  if (span <= 0) return out; // flat column → all zero
  for (let i = 0; i < values.length; i++) {
    let t = (values[i] - mm.min) / span;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    out[i] = t;
  }
  return out;
}

/**
 * Reduce a column to at most `maxWidth` samples by averaging contiguous
 * buckets (mean). Used so an over-long column still fits a single-row texture.
 * Columns already within budget are returned as a plain copy.
 */
export function capToWidth(values: ArrayLike<number>, maxWidth = MAX_TEXTURE_WIDTH): Float32Array {
  const n = values.length;
  if (n <= maxWidth) {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = values[i];
    return out;
  }
  const out = new Float32Array(maxWidth);
  for (let b = 0; b < maxWidth; b++) {
    const start = Math.floor((b * n) / maxWidth);
    const end = Math.max(start + 1, Math.floor(((b + 1) * n) / maxWidth));
    let sum = 0;
    let count = 0;
    for (let i = start; i < end && i < n; i++) {
      sum += values[i];
      count++;
    }
    out[b] = count > 0 ? sum / count : 0;
  }
  return out;
}

export interface PhaseRamp {
  /** Cumulative phase normalized to [0, 1], one entry per sample. Monotonic. */
  phase01: Float32Array;
  /** Total stripe cycles across the dataset. The shader multiplies phase01 by
   *  this to recover cumulative cycles (kept off the texture so float16 [0,1]
   *  stays precise). */
  totalCycles: number;
}

/**
 * Build a cumulative-phase ramp from normalized [0, 1] values.
 *
 * Local frequency per sample step = (baseCycles / N) · (1 + gain · norm[i]),
 * i.e. the dataset spans ≈ baseCycles stripes when gain = 0, and denser where
 * the value is higher. The ramp is the running sum (prefix-sum) of that local
 * frequency, then normalized to [0, 1]; `totalCycles` carries the scale.
 */
export function buildPhaseRamp(
  norm: ArrayLike<number>,
  baseCycles: number,
  gain: number,
): PhaseRamp {
  const n = norm.length;
  const phase = new Float32Array(n);
  if (n === 0) return { phase01: phase, totalCycles: 0 };

  const perStepBase = baseCycles / n;
  let cumulative = 0;
  for (let i = 0; i < n; i++) {
    phase[i] = cumulative; // phase BEFORE this sample's increment → phase[0] = 0
    const localFreq = perStepBase * (1 + gain * norm[i]);
    cumulative += localFreq;
  }

  const totalCycles = cumulative;
  if (totalCycles > 0) {
    for (let i = 0; i < n; i++) phase[i] /= totalCycles;
  }
  return { phase01: phase, totalCycles };
}
