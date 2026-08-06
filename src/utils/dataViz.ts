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

/** Summary statistics of a data column, computed once at code-gen. */
export interface ColumnStats extends MinMax {
  count: number;
  mean: number;
  /** Population standard deviation (÷N, not ÷N−1 — this is the whole column,
   *  not a sample drawn from something larger). */
  sd: number;
  /** 2nd and 98th percentile — the robust domain, so a single outlier can't
   *  squash the whole ramp into two texels. */
  p2: number;
  p98: number;
}

/** Nearest-rank percentile of an already-sorted ascending array. */
function percentileSorted(sorted: ArrayLike<number>, p: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const i = Math.min(n - 1, Math.max(0, Math.round(p * (n - 1))));
  return sorted[i];
}

/** Compute the statistics the Normalize node's automatic modes need. Non-finite
 *  cells are skipped (csvParser already rejects them, but a column can also
 *  arrive from a tampered project payload). */
export function columnStats(values: ArrayLike<number>): ColumnStats {
  const finite: number[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (Number.isFinite(v)) {
      finite.push(v);
      sum += v;
    }
  }
  const n = finite.length;
  if (n === 0) return { min: 0, max: 1, count: 0, mean: 0, sd: 0, p2: 0, p98: 1 };

  const mean = sum / n;
  let sq = 0;
  for (let i = 0; i < n; i++) sq += (finite[i] - mean) ** 2;
  const sorted = finite.slice().sort((a, b) => a - b);

  return {
    min: sorted[0],
    max: sorted[n - 1],
    count: n,
    mean,
    sd: Math.sqrt(sq / n),
    p2: percentileSorted(sorted, 0.02),
    p98: percentileSorted(sorted, 0.98),
  };
}

/** Normalization strategies offered by the Normalize node. */
export type NormalizeMode =
  | 'minmax'
  | 'robust'
  | 'symmetric'
  | 'zscore'
  | 'manual'
  | 'log'
  | 'symlog';

export const NORMALIZE_MODES: NormalizeMode[] = [
  'minmax',
  'robust',
  'symmetric',
  'zscore',
  'manual',
  'log',
  'symlog',
];

export function isNormalizeMode(v: unknown): v is NormalizeMode {
  return (NORMALIZE_MODES as string[]).includes(String(v));
}

/**
 * What the shader has to compute, decided on the CPU.
 *
 * `affine` covers five of the seven modes — they differ only in which domain
 * they pick, which is precisely the point: choosing the domain is a judgement
 * about the data, and it belongs on the CPU where the whole column is visible,
 * not in a per-fragment expression.
 */
export type NormalizePlan =
  | { kind: 'affine'; lo: number; hi: number }
  /** t = (log2(max(v, floor)) − log2(lo)) / (log2(hi) − log2(lo)) */
  | { kind: 'log'; lo: number; hi: number }
  /** t = 0.5 + 0.5·sign(v)·log2(1 + |v|/thresh) / log2(1 + m/thresh) */
  | { kind: 'symlog'; thresh: number; m: number };

/** Number of standard deviations spanned by the `zscore` domain. ±3σ covers
 *  99.7% of a normal distribution — beyond that the ramp is mostly empty. */
export const ZSCORE_SIGMAS = 3;

/**
 * Turn a mode + statistics + the user's manual domain into the concrete plan.
 * Pure and total: every degenerate case (flat column, non-positive data under
 * `log`, an inverted or zero-width manual domain) resolves to something that
 * still renders rather than dividing by zero or taking log of a negative.
 */
export function planNormalize(
  mode: NormalizeMode,
  stats: ColumnStats | null,
  manual: { lo: number; hi: number },
): NormalizePlan {
  const s = stats;
  const affine = (lo: number, hi: number): NormalizePlan => {
    // A zero-width (or inverted) domain would emit a division by zero and paint
    // the surface with Infinity. Widen it symmetrically instead — a flat column
    // then reads as a flat mid-ramp colour, which is the truth about it.
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi - lo <= 0) {
      const c = Number.isFinite(lo) ? lo : 0;
      return { kind: 'affine', lo: c - 0.5, hi: c + 0.5 };
    }
    return { kind: 'affine', lo, hi };
  };

  switch (mode) {
    case 'manual':
      return affine(manual.lo, manual.hi);
    case 'robust':
      return s ? affine(s.p2, s.p98) : affine(manual.lo, manual.hi);
    case 'symmetric': {
      // Zero maps to exactly 0.5 — the whole reason a diverging colormap is
      // readable. Derived from the data's largest magnitude, not from min/max,
      // or the neutral colour would drift off zero.
      if (!s) {
        const m = Math.max(Math.abs(manual.lo), Math.abs(manual.hi));
        return affine(-m, m);
      }
      const m = Math.max(Math.abs(s.min), Math.abs(s.max));
      return affine(-m, m);
    }
    case 'zscore': {
      if (!s || s.sd <= 0) return affine(manual.lo, manual.hi);
      return affine(s.mean - ZSCORE_SIGMAS * s.sd, s.mean + ZSCORE_SIGMAS * s.sd);
    }
    case 'log': {
      const rawLo = s ? s.min : manual.lo;
      const rawHi = s ? s.max : manual.hi;
      // log needs a positive domain. Rather than refuse, floor the low end at a
      // small positive fraction of the high end — the same thing a plotting
      // library does when asked for a log axis over data touching zero.
      const hi = rawHi > 0 ? rawHi : 1;
      const lo = rawLo > 0 ? rawLo : hi * 1e-3;
      if (!(hi > lo)) return { kind: 'log', lo: hi * 1e-3, hi };
      return { kind: 'log', lo, hi };
    }
    case 'symlog': {
      const m = s ? Math.max(Math.abs(s.min), Math.abs(s.max)) : Math.max(Math.abs(manual.lo), Math.abs(manual.hi));
      const mag = Number.isFinite(m) && m > 0 ? m : 1;
      // Linear region: everything within 1/1000 of the largest magnitude. Below
      // that, log would spend most of the ramp resolving numerical noise.
      return { kind: 'symlog', thresh: mag * 1e-3, m: mag };
    }
    case 'minmax':
    default:
      return s ? affine(s.min, s.max) : affine(manual.lo, manual.hi);
  }
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
