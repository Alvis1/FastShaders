/* bench-stats — shared stats, JSON/CSV export, and the complexity.json
 * suggestion emitter that closes the paper's calibration loop.
 *
 * Used by all three benches (bench-inout, bench-static, bench-microplane).
 * The point conversion (100 pts ≡ 8.33ms ≡ 120 fps single-eye budget)
 * matches sphere/stats.js so the three benches share one currency. */

/** Single budget anchor — keeps point math comparable across benches. */
export const BUDGET_MS = 8.33;

/** Reference pixel count the point currency is anchored at (Quest 3
 *  per-eye, 2064×2208). Marginal ms measured at any other resolution is
 *  scaled by REF_PIXELS / measuredPixels before conversion to points —
 *  without this, a 1024² MicroPlane run deflates fragment-bound points
 *  by ~4.35× relative to the currency. */
export const REF_PIXELS = 2064 * 2208;

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
    // Full shape even when underpopulated — downstream consumers (CSV
    // columns, marginal annotation) must never see undefined fields.
    return {
      points: 0, medianFt: 0, meanFt: 0, p95Ft: 0, p99Ft: 0, sdFt: 0,
      cvPercent: 0, avgFps: 0, thermalDrift: 1,
      frameCount: frames?.length ?? 0, filteredCount: 0, outlierCount: 0,
      insufficientData: true,
    };
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
    // Tail percentiles come from the UNFILTERED sample — the IQR fence
    // exists to keep the median robust, but computing p95/p99 on the
    // trimmed set made tail spikes invisible by construction.
    p95Ft: +pct(fts, 95).toFixed(4),
    p99Ft: +pct(fts, 99).toFixed(4),
    sdFt: +sd.toFixed(4),
    cvPercent: +cv.toFixed(2),
    avgFps: avg > 0 ? +(1000 / avg).toFixed(1) : 0,
    thermalDrift: +(aMean > 0 ? rMean / aMean : 1).toFixed(3),
    frameCount: fts.length,
    filteredCount: filtered.length,
    outlierCount: fts.length - filtered.length,
  };
}

/**
 * Two-level slope estimate of per-pass cost. `loTotals` / `hiTotals` are
 * TOTAL batch ms measured at `passesLo` / `passesHi` (= 2·passesLo)
 * passes per batch. Because both levels carry the same fixed per-batch
 * overhead C (fence latency, JS loop, submission), the slope
 *   (median(hi) − median(lo)) / (passesHi − passesLo)
 * cancels C exactly — unlike dividing a single level by its pass count,
 * which leaves C/N in every per-pass figure and biased the old
 * baseline subtraction whenever baseline and shader calibrated to very
 * different pass counts (~4000 vs ~30).
 *
 * Returns null when a slope can't be formed (missing data or equal levels).
 */
export function slopeMsPerPass(loTotals, hiTotals, passesLo, passesHi) {
  if (!loTotals?.length || !hiTotals?.length) return null;
  if (!(passesHi > passesLo)) return null;
  const medLo = pct(loTotals, 50);
  const medHi = pct(hiTotals, 50);
  const msPerPass = (medHi - medLo) / (passesHi - passesLo);
  return {
    msPerPass,
    overheadMsPerBatch: medLo - passesLo * msPerPass,
    medLoTotalMs: medLo,
    medHiTotalMs: medHi,
  };
}

/**
 * Reduce one shader's two-level run ({ loTotals, hiTotals, passesLo,
 * passesHi }) into its stats blob: dispersion diagnostics from the
 * hi-level per-pass values, plus the authoritative slope-based
 * `msPerPass` (and `points` recomputed from it). Falls back to the
 * median-based figures with `slopeUnavailable: true` when the slope
 * can't be formed.
 */
export function statsFromTwoLevelRun(out) {
  const perPassHi = out.hiTotals.map(t => ({ frameTime: t / out.passesHi }));
  const stats = computeStats(perPassHi);
  const slope = slopeMsPerPass(out.loTotals, out.hiTotals, out.passesLo, out.passesHi);
  if (slope) {
    stats.msPerPass = +slope.msPerPass.toFixed(5);
    stats.overheadMsPerBatch = +slope.overheadMsPerBatch.toFixed(4);
    stats.points = Math.max(0, Math.round((slope.msPerPass / BUDGET_MS) * 100));
  } else {
    stats.slopeUnavailable = true;
  }
  stats.passesLo = out.passesLo;
  stats.passesHi = out.passesHi;
  return stats;
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
 * Subtract the baseline shader's per-pass cost from each measured
 * shader's, and convert to points at the reference resolution. Mutates
 * each `result` in `results` to add `baselineMs`, `marginalMs`,
 * `marginalMsAtRef`, and `marginalPoints`. Baseline is identified by
 * `result.id === 'ref_baseline'`.
 *
 * Per-shader cost prefers the slope-based `stats.msPerPass` (overhead-
 * free, see slopeMsPerPass) and falls back to `stats.medianFt`.
 *
 * `pixels` is the measured render-target pixel count (w×h). When known,
 * marginal ms is scaled by REF_PIXELS/pixels before the point
 * conversion, since fragment-bound cost scales ~linearly with fragment
 * count. When unknown, points are computed unscaled and the caller must
 * flag the run (see buildSuggestion's validity gating).
 *
 * When the baseline is missing, marginal fields are null — previously
 * they silently fell back to raw medians, which exported as clean-
 * looking (and wrong) suggestions.
 *
 * Returns { baselineMs, resolutionScale }.
 */
export function annotateMarginalCost(results, { pixels = null } = {}) {
  const baseline = results.find(r => r.id === 'ref_baseline');
  const baselineMs = baseline ? (baseline.stats.msPerPass ?? baseline.stats.medianFt) : null;
  const resolutionScale = pixels > 0 ? REF_PIXELS / pixels : null;
  for (const r of results) {
    if (baselineMs == null) {
      r.stats.baselineMs = null;
      r.stats.marginalMs = null;
      r.stats.marginalMsAtRef = null;
      r.stats.marginalPoints = null;
      continue;
    }
    const own = r.stats.msPerPass ?? r.stats.medianFt;
    const marginal = own - baselineMs;
    r.stats.baselineMs = +baselineMs.toFixed(4);
    r.stats.marginalMs = +marginal.toFixed(4);
    r.stats.marginalMsAtRef = resolutionScale != null ? +(marginal * resolutionScale).toFixed(4) : null;
    const basis = resolutionScale != null ? marginal * resolutionScale : marginal;
    r.stats.marginalPoints = Math.max(0, Math.round((basis / BUDGET_MS) * 100));
  }
  return { baselineMs, resolutionScale };
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
 * Build the complexity-suggestion object (schema v2) from a bench run
 * payload. Pure — no DOM, so it's unit-testable and reusable.
 *
 * Validity gating: a run only gets `valid: true` when it can honestly
 * price nodes — baseline present, no vsync clamping, resolution known
 * (so points are normalized to REF_PIXELS), and a timing method that
 * resolves sub-frame cost. Anything else exports with `valid: false`
 * plus machine-readable `reasons`, so a suggestion file can never look
 * clean while its numbers are garbage.
 */
export function buildSuggestion(data, sourceName) {
  const md = data.metadata || {};
  const res = md.resolution || null;
  const pixels = res?.width > 0 && res?.height > 0 ? res.width * res.height : null;
  const { baselineMs, resolutionScale } = annotateMarginalCost(data.shaders, { pixels });

  const reasons = [];
  if (baselineMs == null) {
    reasons.push('baseline-missing: no ref_baseline in this run — marginal cost cannot be derived, marginal fields are null');
  }
  if (md.vsyncClamping) {
    reasons.push(`vsync-clamped: frametimes pinned to ${md.vsyncClamping.hz} Hz refresh (${md.vsyncClamping.periodMs} ms) — values reflect display cadence, not shader cost`);
  }
  if (pixels == null) {
    reasons.push('resolution-unknown: marginal ms could not be normalized to the reference pixel count (2064×2208) — points are NOT in the shared currency');
  }
  if (md.timingMethod === 'raf-delta') {
    reasons.push('raf-delta timing: refresh-quantized frame deltas resolve budget fit, not per-node cost — use for flat↔immersive ratios only');
  }
  const insufficient = (data.shaders || []).filter(s => s.stats?.insufficientData);
  if (insufficient.length) {
    reasons.push(`insufficient-data: ${insufficient.map(s => s.id).join(', ')} had <2 samples`);
  }

  return {
    metadata: {
      schemaVersion: 2,
      bench: md.bench,
      source: sourceName,
      generatedAt: new Date().toISOString(),
      device: md.gpu || md.headset || 'unknown',
      adapterInfo: md.adapterInfo ?? null,
      browser: md.userAgent ?? null,
      timingMethod: md.timingMethod ?? 'wallclock-fence',
      quantized: md.quantized ?? null,     // 100 µs GPU-timestamp quantization detected? null = unknown/not applicable
      clockPinned: md.clockPinned ?? null, // adb-pinned GPU/CPU clocks? null = unknown (browser can't tell)
      stereo: md.stereo ?? false,
      resolution: res,
      refPixels: REF_PIXELS,
      resolutionScale: resolutionScale != null ? +resolutionScale.toFixed(4) : null,
      budgetMs: BUDGET_MS,
      valid: reasons.length === 0,
      reasons,
      note: 'Suggested complexity points derived from measured marginal per-pass cost (slope-based msPerPass − baseline, scaled to the 2064×2208 reference resolution). suggestedPoints = round(marginalMsAtRef / budgetMs × 100). Do not merge runs with different timingMethod/device/stereo without ratio bridging.',
    },
    suggestions: (data.shaders || [])
      .filter(s => s.id !== 'ref_baseline')
      .map(s => ({
        id: s.id,
        label: s.label,
        category: s.category,
        medianMs: s.stats.medianFt,
        msPerPass: s.stats.msPerPass ?? s.stats.medianFt,
        marginalMs: s.stats.marginalMs,
        marginalMsAtRef: s.stats.marginalMsAtRef,
        suggestedPoints: s.stats.marginalPoints,
      })),
  };
}

/**
 * Write the raw frame data + per-shader stats as JSON, a flat per-shader CSV
 * for quick spreadsheet inspection, AND a complexity.json-shaped suggestion
 * file that the FastShaders editor can diff against its current scoring.
 * Commit these into ShaderCarousel/benchData/ — browser downloads
 * otherwise evaporate and the calibration loop never closes.
 *
 * `data.metadata.bench` should be one of 'inout' | 'static' | 'microplane'
 * so downstream analysis can group like-for-like.
 */
export function exportResults(data, prefix) {
  if (!data?.shaders?.length) return { fileCount: 0 };

  const ts = timestamp();
  const suggestion = buildSuggestion(data, `${prefix}-${ts}.json`);

  // 1) raw JSON — every frame, every shader (already thinned at capture time)
  triggerDownload(
    new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
    `${prefix}-${ts}.json`,
  );

  // 2) summary CSV — one row per shader
  const csvRows = [
    [
      'id', 'label', 'category',
      'medianMs', 'msPerPass', 'meanMs', 'p95Ms', 'p99Ms', 'sdMs', 'cvPct',
      'marginalMs', 'marginalMsAtRef', 'marginalPoints', 'points', 'avgFps', 'thermalDrift',
      'frameCount', 'outlierCount',
    ].join(','),
    ...data.shaders.map(s => [
      s.id, `"${s.label}"`, s.category,
      s.stats.medianFt, s.stats.msPerPass ?? '', s.stats.meanFt, s.stats.p95Ft, s.stats.p99Ft,
      s.stats.sdFt, s.stats.cvPercent,
      s.stats.marginalMs ?? '', s.stats.marginalMsAtRef ?? '', s.stats.marginalPoints ?? '',
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
  // src/registry/complexity.json directly. Check metadata.valid/reasons
  // before trusting suggestedPoints.
  triggerDownload(
    new Blob([JSON.stringify(suggestion, null, 2)], { type: 'application/json' }),
    `${prefix}-complexity-suggestion-${ts}.json`,
  );

  return { fileCount: 3, timestamp: ts, valid: suggestion.metadata.valid, reasons: suggestion.metadata.reasons };
}
