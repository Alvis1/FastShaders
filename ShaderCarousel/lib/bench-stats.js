/* bench-stats — shared stats, JSON/CSV export, and the complexity.json
 * suggestion emitter that closes the paper's calibration loop.
 *
 * Used by all three benches (bench-inout, bench-static, bench-microplane).
 * The point conversion (100 pts ≡ 8.33ms ≡ 120 fps single-eye budget)
 * matches sphere/stats.js so the three benches share one currency. */

/** Single budget anchor — keeps point math comparable across benches. */
export const BUDGET_MS = 8.33;

// ── Percentiles + dispersion ────────────────────────────────────────────────

function pct(arr, p) {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const i = (p / 100) * (s.length - 1);
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo);
}

function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }

function stdDev(arr) {
  if (arr.length === 0) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}

/**
 * IQR outlier filter — removes samples outside [Q1 − 1.5·IQR, Q3 + 1.5·IQR].
 * The bench measurement loop runs alongside JS GC and OS scheduling jitter, so
 * a small number of clearly-outlier samples per shader is normal. The IQR
 * fence is the same one face/bench.js uses; keeps the median and percentile
 * stats robust without throwing away too much data.
 */
function filterIQR(arr) {
  if (arr.length < 4) return arr;
  const q1 = pct(arr, 25);
  const q3 = pct(arr, 75);
  const iqr = q3 - q1;
  const lo = q1 - 1.5 * iqr;
  const hi = q3 + 1.5 * iqr;
  return arr.filter(v => v >= lo && v <= hi);
}

/**
 * Reduce a list of `{ frameTime }` samples into a single stats blob.
 * `frameTime` is per-rendered-frame ms for rAF-delta benches (InOut), and
 * per-pass ms for multi-pass benches (Static, MicroPlane). The downstream
 * consumer is unit-blind — points come from ms × 100 / 8.33 regardless.
 */
export function computeStats(frames) {
  if (!frames || frames.length < 2) {
    return { points: 0, medianFt: 0, frameCount: frames?.length ?? 0 };
  }
  const fts = frames.map(f => f.frameTime);
  const filtered = filterIQR(fts);
  const med = pct(filtered, 50);
  const avg = mean(filtered);
  const sd = stdDev(filtered);
  const cv = avg > 0 ? (sd / avg) * 100 : 0;

  // Thermal drift = mean of second half ÷ mean of first half. >1 indicates the
  // bench got slower as it ran (thermal throttling, GC pressure, etc).
  const mid = Math.floor(fts.length / 2);
  const aMean = mean(fts.slice(0, mid));
  const rMean = mean(fts.slice(mid));

  return {
    points: Math.round((med / BUDGET_MS) * 100),
    medianFt: +med.toFixed(4),
    meanFt: +avg.toFixed(4),
    p95Ft: +pct(filtered, 95).toFixed(4),
    p99Ft: +pct(filtered, 99).toFixed(4),
    sdFt: +sd.toFixed(4),
    cvPercent: +cv.toFixed(2),
    avgFps: avg > 0 ? +(1000 / avg).toFixed(1) : 0,
    thermalDrift: +(aMean > 0 ? rMean / aMean : 1).toFixed(3),
    frameCount: fts.length,
    filteredCount: filtered.length,
    outlierCount: fts.length - filtered.length,
  };
}

// ── Marginal cost vs baseline ───────────────────────────────────────────────

// Common display refresh rates we check against to detect vsync clamping.
const COMMON_REFRESH_RATES = [60, 72, 90, 120, 144, 165, 240];

/**
 * Heuristic: did this run's frametimes get pinned to a display refresh rate
 * instead of measuring actual shader cost? Sphere InOut logs `rAF` deltas,
 * which the browser pins to monitor vsync outside an XR session — so a flat
 * desktop run of all-under-budget shaders collapses every shader to the
 * same frametime (e.g. 16.67 ms on a 60 Hz Mac). The exported `complexity-
 * suggestion.json` then shows 0 points across the board.
 *
 * Returns `null` when the data looks fine, or
 *   `{ hz, periodMs, avgMs, spreadMs }`
 * when shaders cluster tightly (spread ≤ 2 ms) around a known refresh
 * period (within ±0.8 ms). The Static + MicroPlane benches don't hit this
 * (their multi-pass + GPU-fence sync defeats vsync), so this is informally
 * only useful from InOut — but it's safe to call from any bench.
 */
export function detectVsyncClamping(results) {
  if (!results || results.length < 2) return null;
  const medians = results
    .filter(r => r.id !== 'ref_baseline')   // baseline is in every cluster anyway
    .map(r => r.stats?.medianFt)
    .filter(v => typeof v === 'number' && v > 0);
  if (medians.length < 2) return null;

  const min = Math.min(...medians);
  const max = Math.max(...medians);
  const spread = max - min;
  if (spread > 2) return null;                // genuine differentiation

  const avg = medians.reduce((a, b) => a + b, 0) / medians.length;
  for (const hz of COMMON_REFRESH_RATES) {
    const periodMs = 1000 / hz;
    if (Math.abs(avg - periodMs) < 0.8) {
      return {
        hz,
        periodMs: +periodMs.toFixed(3),
        avgMs: +avg.toFixed(3),
        spreadMs: +spread.toFixed(3),
        shaderCount: medians.length,
      };
    }
  }
  return null;
}

/**
 * Subtract the baseline shader's median from each measured shader's median.
 * Mutates each `result` in `results` to add `marginalMs` + `marginalPoints`.
 * Baseline is identified by `result.id === 'ref_baseline'`.
 *
 * Marginal cost is what makes the data usable for the paper's calibration
 * pass: it isolates the shader's contribution above scene + driver fixed
 * overhead, which is what complexity.json points should approximate.
 */
export function annotateMarginalCost(results) {
  const baseline = results.find(r => r.id === 'ref_baseline');
  const baselineMs = baseline ? baseline.stats.medianFt : 0;
  for (const r of results) {
    r.stats.baselineMs = +baselineMs.toFixed(4);
    r.stats.marginalMs = +(r.stats.medianFt - baselineMs).toFixed(4);
    r.stats.marginalPoints = Math.max(0, Math.round((r.stats.marginalMs / BUDGET_MS) * 100));
  }
  return baselineMs;
}

// ── Export pipeline ─────────────────────────────────────────────────────────

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function timestamp() {
  return new Date().toISOString().slice(0, 16).replace(/:/g, '');
}

/**
 * Write the raw frame data + per-shader stats as JSON, a flat per-shader CSV
 * for quick spreadsheet inspection, AND a complexity.json-shaped suggestion
 * file that the FastShaders editor can diff against its current scoring.
 *
 * `data.metadata.bench` should be one of 'inout' | 'static' | 'microplane'
 * so downstream analysis can group like-for-like.
 */
export function exportResults(data, prefix) {
  if (!data?.shaders?.length) return { fileCount: 0 };

  const ts = timestamp();
  annotateMarginalCost(data.shaders);

  // 1) raw JSON — every frame, every shader (already thinned at capture time)
  triggerDownload(
    new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
    `${prefix}-${ts}.json`,
  );

  // 2) summary CSV — one row per shader
  const csvRows = [
    [
      'id', 'label', 'category',
      'medianMs', 'meanMs', 'p95Ms', 'p99Ms', 'sdMs', 'cvPct',
      'marginalMs', 'marginalPoints', 'points', 'avgFps', 'thermalDrift',
      'frameCount', 'outlierCount',
    ].join(','),
    ...data.shaders.map(s => [
      s.id, `"${s.label}"`, s.category,
      s.stats.medianFt, s.stats.meanFt, s.stats.p95Ft, s.stats.p99Ft,
      s.stats.sdFt, s.stats.cvPercent,
      s.stats.marginalMs ?? '', s.stats.marginalPoints ?? '',
      s.stats.points, s.stats.avgFps, s.stats.thermalDrift,
      s.stats.frameCount, s.stats.outlierCount,
    ].join(',')),
  ].join('\n');
  triggerDownload(
    new Blob([csvRows], { type: 'text/csv' }),
    `${prefix}-summary-${ts}.csv`,
  );

  // 3) complexity.json suggestion — maps id → suggested points based on the
  // measured marginal cost (so each shader's number is what would close the
  // paper's calibration gap on this device). Editor can diff this against
  // src/registry/complexity.json directly.
  const suggestion = {
    metadata: {
      bench: data.metadata?.bench,
      source: `${prefix}-${ts}.json`,
      generatedAt: new Date().toISOString(),
      device: data.metadata?.gpu || data.metadata?.headset || 'unknown',
      budgetMs: BUDGET_MS,
      note: 'Suggested complexity points derived from measured marginal cost (median − baseline). marginalPoints = round(marginalMs / budgetMs × 100).',
    },
    suggestions: data.shaders
      .filter(s => s.id !== 'ref_baseline')
      .map(s => ({
        id: s.id,
        label: s.label,
        category: s.category,
        medianMs: s.stats.medianFt,
        marginalMs: s.stats.marginalMs,
        suggestedPoints: s.stats.marginalPoints,
      })),
  };
  triggerDownload(
    new Blob([JSON.stringify(suggestion, null, 2)], { type: 'application/json' }),
    `${prefix}-complexity-suggestion-${ts}.json`,
  );

  return { fileCount: 3, timestamp: ts };
}
