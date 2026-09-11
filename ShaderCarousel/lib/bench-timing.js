/* bench-timing — shared multi-pass GPU timing for the WebGPU benches
 * (bench-static, bench-microplane). Replaces the per-bench copies of
 * gpuSync / measureMultiPass / calibratePasses.
 *
 * Two timing channels per measurement batch:
 *   • wallMs — performance.now() around N renders + a completion fence
 *     (device.queue.onSubmittedWorkDone). Includes CPU scheduling and
 *     fence latency; 100 µs resolution in non-cross-origin-isolated
 *     Chromium. Always available.
 *   • gpuMs — WebGPU timestamp-query pass times summed over the batch,
 *     via three's TimestampQueryPool (WebGPURenderer with
 *     trackTimestamp: true + renderer.resolveTimestampsAsync()).
 *     GPU-only time, immune to CPU noise. Available when the adapter
 *     exposes the 'timestamp-query' feature. Chrome quantizes each
 *     timestamp to 100 µs unless chrome://flags/#enable-webgpu-developer-
 *     features is on — the multi-pass batch amortizes that quantum
 *     across N passes, so batches stay useful even quantized.
 *
 * `totalMs` (the primary value) is gpuMs when available, else wallMs.
 *
 * Two-level pass calibration (slope method): each shader is measured at
 * N and 2N passes per batch. Per-pass cost = (median(total@2N) −
 * median(total@N)) / N — the fixed per-batch overhead C (fence latency,
 * JS loop, submission) cancels exactly, instead of biasing every
 * marginal by ≈ C/N as single-level baseline subtraction did when the
 * baseline calibrated to ~4000 passes and heavy shaders to ~30. */

import { TimestampQuery } from 'three';

/** Each measurement batch should span at least this many ms of wall
 *  clock so per-batch clock quantization stays a small fraction. */
export const CALIBRATE_TARGET_MS = 20;

// Pass-count ceilings. Wall-clock mode keeps the historical 4000 cap.
// Timestamp mode is bounded by three's query pool: 2048 queries =
// 1024 begin/end pairs per resolve, so a batch must not allocate more —
// the effective cap is derived from the measured query-pairs-per-pass
// (usually 1, but internal extra passes would raise it).
const WALL_MAX_PASSES = 4000;
const TS_QUERY_PAIR_BUDGET = 1000; // headroom below the 1024-pair pool

/**
 * Build a timer bound to an initialized WebGPURenderer.
 * `renderFn` executes exactly one render pass (e.g. () => renderer.render(scene, camera)).
 *
 * Returned API:
 *   timingMethod        — 'gpu-timestamp' | 'wallclock-fence'
 *   measure(passes)     — Promise<{ wallMs, gpuMs|null, totalMs }>
 *   calibrate(minPasses)— Promise<{ passesLo, passesHi }> (passesHi = 2·passesLo)
 *   maxPasses()         — current per-batch pass ceiling
 *   quantized()         — true/false/null: were the GPU timestamps 100 µs-quantized?
 */
export function createBenchTimer({ renderer, renderFn, log = () => {} }) {
  const backend = renderer.backend;
  const device = backend?.device ?? null;
  // backend.trackTimestamp is already ANDed with the adapter's
  // 'timestamp-query' feature by three at init (WebGPU backend), and
  // with EXT_disjoint_timer_query_webgl2 presence on the WebGL backend.
  const tsAvailable = backend?.trackTimestamp === true
    && (device ? true : !!backend?.disjoint);

  const timingMethod = tsAvailable ? 'gpu-timestamp' : 'wallclock-fence';

  // Query pairs consumed per render pass — measured on the first batch
  // instead of assumed, in case a render() allocates internal extra passes.
  let pairsPerPass = 1;
  let pairsMeasured = false;

  // Ring of recent gpuMs samples for the quantization heuristic.
  const gpuSamples = [];
  const GPU_SAMPLE_CAP = 512;

  async function fence() {
    if (device?.queue?.onSubmittedWorkDone) {
      await device.queue.onSubmittedWorkDone();
      return;
    }
    if (backend?.gl) { backend.gl.finish(); return; }
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  }

  function maxPasses() {
    return tsAvailable
      ? Math.max(2, Math.floor(TS_QUERY_PAIR_BUDGET / pairsPerPass))
      : WALL_MAX_PASSES;
  }

  async function measure(passes) {
    // One batch allocates `passes` query pairs; the timestamp pool holds
    // only 1024 (see TS_QUERY_PAIR_BUDGET above), so clamp to maxPasses()
    // — the same bound calibrate uses — before the loop. Guards the warmup
    // loops that pass a user-set `passes` (up to 2000); calibrated main-loop
    // batches already arrive clamped, so this is a no-op for them.
    if (passes >= 1) passes = Math.min(passes, maxPasses());
    const pool = tsAvailable ? backend.timestampQueryPool?.[TimestampQuery.RENDER] : null;
    const t0 = performance.now();
    for (let i = 0; i < passes; i++) renderFn();
    if (pool && !pairsMeasured && passes > 0) {
      // currentQueryIndex counts individual queries (2 per pass-pair).
      // A saturated pool (allocation stopped at maxQueries) would make
      // this ratio underestimate — skip and let a smaller batch measure.
      const idx = pool.currentQueryIndex;
      if (idx < pool.maxQueries) {
        pairsPerPass = Math.max(1, Math.ceil(idx / 2 / passes));
        pairsMeasured = true;
        if (pairsPerPass > 1) log(`timestamp queries: ${pairsPerPass} pass-pairs per render`, 'info');
      }
    }
    await fence();
    const wallMs = performance.now() - t0;

    let gpuMs = null;
    if (tsAvailable) {
      // The batch loop is synchronous, so all its passes share one
      // internal frame bucket — resolveTimestampsAsync returns their sum.
      // Resolving after the fence keeps wallMs semantics unchanged.
      const v = await renderer.resolveTimestampsAsync(TimestampQuery.RENDER);
      if (typeof v === 'number' && Number.isFinite(v)) {
        gpuMs = v;
        if (gpuSamples.length >= GPU_SAMPLE_CAP) gpuSamples.shift();
        gpuSamples.push(v);
      }
    }

    return { wallMs, gpuMs, totalMs: gpuMs ?? wallMs };
  }

  /**
   * Find the smallest pass count ≥ `minPasses` whose batch spans
   * CALIBRATE_TARGET_MS of wall clock, capped so the 2N (hi) level still
   * fits the per-batch ceiling. Returns both slope levels.
   */
  async function calibrate(minPasses) {
    // Recomputed each iteration: pairs-per-pass detection during the
    // probes can shrink maxPasses(), and a stale cap would let the hi
    // (2N) batches overflow the query pool and undercount GPU time.
    const cap = () => Math.max(1, Math.floor(maxPasses() / 2));
    let p = Math.min(Math.max(1, Math.floor(minPasses) || 1), cap());
    await measure(p); // burn one batch to warm the pipeline
    for (let probe = 0; probe < 10; probe++) {
      const { wallMs } = await measure(p);
      p = Math.min(p, cap());
      if (wallMs >= CALIBRATE_TARGET_MS || p >= cap()) break;
      const scale = wallMs > 0
        ? Math.max(2, Math.ceil((CALIBRATE_TARGET_MS / wallMs) * 1.2))
        : 4;
      p = Math.min(p * scale, cap());
    }
    p = Math.min(p, cap());
    return { passesLo: p, passesHi: p * 2 };
  }

  /**
   * Heuristic: were the GPU timestamps quantized (Chrome's 100 µs
   * timing-attack mitigation)? Quantized batch sums are near-multiples
   * of 0.1 ms far more often than nanosecond-precision ones. Returns
   * null when there's no GPU-timestamp data to judge.
   */
  function quantized() {
    const vals = gpuSamples.filter(v => v > 0);
    if (!tsAvailable || vals.length < 8) return null;
    const q = 0.1; // ms
    const eps = 1e-4;
    const hits = vals.filter(v => Math.abs(v / q - Math.round(v / q)) < eps).length;
    return hits / vals.length >= 0.8;
  }

  log(`GPU timing: ${timingMethod}${tsAvailable ? '' : ' (timestamp-query unavailable — wall clock around fence)'}`,
    tsAvailable ? 'ok' : 'warn');

  return { timingMethod, measure, calibrate, maxPasses, quantized };
}
