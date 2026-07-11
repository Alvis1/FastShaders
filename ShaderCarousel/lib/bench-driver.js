/* bench-driver — shared WebGPU measurement driver for the multi-pass
 * benches (bench-static, bench-microplane). Replaces the per-bench copies
 * of initRenderer / benchmarkOne / runBenchmark / results-popup / boot
 * wiring, which were ~220 verbatim-identical lines before extraction.
 *
 * The bench page owns everything scene-shaped (geometry, camera, material
 * class, sizing policy) plus its config/report text, and hands the driver
 * a spec:
 *   log             — makeLogger(...) instance. The bench installs the
 *                     error overlay + logger itself, BEFORE building its
 *                     scene, so scene-construction failures still surface.
 *   registry        — buildBenchRegistry(TSL) result
 *   defaults        — settings defaults (wireSettings)
 *   settingsKey / pickerKey / defaultGroups — persistence namespaces
 *   render(renderer)          — exactly one render pass
 *   setInitialSize(renderer)  — idle sizing, called before renderer.init()
 *   extraInitLogs?            — strings logged 'ok' after the GPU line
 *   afterInit?(renderer)      — after successful boot (e.g. idle render)
 *   readConfig()    — returns cfg; MUST carry frames/passes/warmup/stride,
 *                     MAY carry duration (ms cap per shader's measurement
 *                     loop; absent = frames-count only). Whole cfg lands
 *                     verbatim in the export's metadata.config.
 *   beforeRun?(cfg, renderer) / afterRun?(cfg, renderer)
 *                   — snap to / restore from measurement state
 *   applyShader(shaderDef)    — build + assign the material; returns it
 *                     (driver disposes). A throw (bad TSL build) is logged
 *                     as FAIL and the shader is skipped.
 *   frameT(i, elapsedMs)      — value for the exported frames[].t axis
 *   onPair?({lo, hi, passesLo, passesHi}) — per lo/hi batch pair, for
 *                     bench-specific HUD extras (driver owns hud-ft)
 *   onResult(shaderDef, stats, out) — per-shader completion log line
 *                     (+ any state capture, e.g. the baseline ms)
 *   report          — { bench, tool, filename, popupTitle, notes,
 *                       subtitleSuffix?, resolution(cfg) → {width, height,
 *                       label} } — resolution drives the annotator's pixel
 *                       count, the metadata block, and the log/popup text
 *   gate            — { title, subtitle, buttonLabel } for createStartGate
 *
 * Measurement semantics (unchanged from the per-bench copies): warmup
 * batches at the user's minimum passes, per-shader two-level calibration
 * (bench-timing), then interleaved lo/hi batches (ABAB) so thermal drift
 * hits both slope levels symmetrically instead of biasing one. */

import { WebGPURenderer } from 'three';
import {
  statsFromTwoLevelRun, annotateMarginalCost, exportResults,
} from './bench-stats.js';
import { createBenchTimer, CALIBRATE_TARGET_MS } from './bench-timing.js';
import {
  buildPicker, getSelectedIds, wireSettings,
  createStartGate, showDonePopup,
} from './bench-ui.js';

// Falls back to the parent document when the iframe lookup misses —
// covers the case where the ShaderCarousel launcher has re-parented
// #controls / #hud / #shader-picker / #log into its sidebar by the time
// a click handler fires. See the matching comment in bench-inout/bench.js.
export const $ = id => {
  const el = document.getElementById(id);
  if (el) return el;
  if (window.parent !== window) {
    try { return window.parent.document.getElementById(id); } catch { /* cross-origin */ }
  }
  return null;
};

export function createBenchDriver(spec) {
  const { log, registry } = spec;

  let renderer, timer, gpuInfo = 'unknown', adapterInfo = null;
  let running = false;

  async function initRenderer() {
    log('Initializing WebGPU renderer…');
    renderer = new WebGPURenderer({
      canvas: $('canvas'),
      antialias: false,
      powerPreference: 'high-performance',
      trackTimestamp: true, // three degrades this to false when the adapter lacks 'timestamp-query'
    });
    renderer.setPixelRatio(1);
    spec.setInitialSize(renderer);
    await renderer.init();

    timer = createBenchTimer({
      renderer,
      renderFn: () => spec.render(renderer),
      log,
    });

    try {
      if (navigator.gpu) {
        const a = await navigator.gpu.requestAdapter();
        const i = a?.info;
        if (i) adapterInfo = { vendor: i.vendor, architecture: i.architecture, device: i.device, description: i.description };
        gpuInfo = [i?.vendor, i?.architecture, i?.device, i?.description]
          .filter(Boolean).join(' / ') || 'unknown';
      }
    } catch { /* no WebGPU adapter */ }
    log(`GPU: ${gpuInfo}`, 'ok');
    for (const line of spec.extraInitLogs ?? []) log(line, 'ok');

    spec.render(renderer);
    log('Ready', 'ok');
  }

  // ── Measurement loop ─────────────────────────────────────────────────────
  async function benchmarkOne(shaderDef, cfg) {
    let mat;
    try { mat = spec.applyShader(shaderDef); }
    catch (e) { log(`FAIL ${shaderDef.label}: ${e.message}`, 'err'); return null; }

    // Warmup (compile + first-frame texture upload spikes)
    for (let i = 0; i < cfg.warmup; i++) await timer.measure(cfg.passes);

    // Per-shader pass calibration: the user's `passes` setting is the
    // minimum; bench-timing bumps until each batch spans CALIBRATE_TARGET_MS
    // and returns the two slope levels (N and 2N).
    const { passesLo, passesHi } = await timer.calibrate(cfg.passes);
    if (passesLo !== cfg.passes) {
      log(`  calibrated ${shaderDef.label} → ${passesLo}/${passesHi} passes per lo/hi batch`, 'info');
    }

    // Interleaved lo/hi batches (ABAB) so thermal drift hits both slope
    // levels symmetrically instead of biasing one.
    const frames = [];
    const loTotals = [], hiTotals = [];
    const durationCap = cfg.duration ?? Infinity;
    const start = performance.now();
    let i = 0;
    while (i < cfg.frames && (performance.now() - start) < durationCap && running) {
      const lo = await timer.measure(passesLo);
      const hi = await timer.measure(passesHi);
      loTotals.push(lo.totalMs);
      hiTotals.push(hi.totalMs);
      if ((i % cfg.stride) === 0) {
        const t = spec.frameT(i, performance.now() - start);
        frames.push({ t, passes: passesLo, totalMs: +lo.totalMs.toFixed(4), gpuMs: lo.gpuMs != null ? +lo.gpuMs.toFixed(4) : null, frameTime: +(lo.totalMs / passesLo).toFixed(4) });
        frames.push({ t, passes: passesHi, totalMs: +hi.totalMs.toFixed(4), gpuMs: hi.gpuMs != null ? +hi.gpuMs.toFixed(4) : null, frameTime: +(hi.totalMs / passesHi).toFixed(4) });
      }
      $('hud-ft').textContent = (hi.totalMs / passesHi).toFixed(4) + ' ms';
      spec.onPair?.({ lo, hi, passesLo, passesHi });
      i++;
      if (i % 5 === 0) await new Promise(r => setTimeout(r, 0));
    }

    mat.dispose();
    return { frames, loTotals, hiTotals, passesLo, passesHi };
  }

  async function runBenchmark() {
    running = true;
    $('btn-start').disabled = true; $('btn-stop').disabled = false;

    const cfg = spec.readConfig();
    spec.beforeRun?.(cfg, renderer);

    // Honour the user's selection — baseline defaults on but is toggleable.
    // If unticked, the export's marginal-cost columns fall back to raw ms.
    const selectedIds = new Set(getSelectedIds(refs.pickList));
    const shaders = registry.filter(s => selectedIds.has(s.id) && !s.disabled);
    // If selected, baseline runs first so subsequent shaders can subtract.
    shaders.sort((a, b) => (a.id === 'ref_baseline' ? -1 : b.id === 'ref_baseline' ? 1 : 0));

    const res = spec.report.resolution(cfg);
    log(`Running ${shaders.length} shaders @ ${res.width}×${res.height}, ${cfg.passes} passes × ${cfg.frames} frames`);

    const results = [];
    for (let i = 0; i < shaders.length; i++) {
      if (!running) break;
      const s = shaders[i];
      $('hud-shader').textContent = s.label;
      $('hud-progress').textContent = `${i + 1}/${shaders.length}`;
      $('progress-bar').style.width = `${((i + 1) / shaders.length * 100).toFixed(1)}%`;
      $('hud-phase').textContent = 'measuring';
      log(`[${i + 1}/${shaders.length}] ${s.label}…`);

      const out = await benchmarkOne(s, cfg);
      if (!out || out.hiTotals.length < 2) {
        if (out) log(`  skipped ${s.label}: only ${out.hiTotals.length} measurement pair(s) — need ≥2`, 'warn');
        continue;
      }
      const stats = statsFromTwoLevelRun(out);
      $('hud-pts').textContent = stats.points;
      results.push({ id: s.id, label: s.label, category: s.category, stats, frames: out.frames });
      spec.onResult(s, stats, out);
    }

    spec.afterRun?.(cfg, renderer);

    $('hud-phase').textContent = 'done';
    $('progress-bar').style.width = '100%';
    log(`Complete: ${results.length} shaders`, 'ok');
    running = false;
    $('btn-start').disabled = false; $('btn-stop').disabled = true;

    showResultsPopup(results, cfg);
  }

  function showResultsPopup(results, cfg) {
    const res = spec.report.resolution(cfg);
    // Shared annotator (idempotent — exportResults runs it again): adds
    // marginalMs / marginalMsAtRef / marginalPoints from the slope-based
    // per-pass costs, normalized to the reference pixel count.
    annotateMarginalCost(results, { pixels: res.width * res.height });
    const rows = results.map(r => ({
      label: r.label,
      medianMs: r.stats.msPerPass ?? r.stats.medianFt,
      marginalMs: r.stats.marginalMsAtRef ?? r.stats.marginalMs,
      points: r.stats.marginalPoints,
    }));

    const payload = {
      metadata: {
        schemaVersion: 2,
        bench: spec.report.bench,
        tool: spec.report.tool,
        resolution: res,
        date: new Date().toISOString(),
        userAgent: navigator.userAgent,
        gpu: gpuInfo,
        adapterInfo,
        timingMethod: timer.timingMethod,
        quantized: timer.quantized(),
        clockPinned: null,
        stereo: false,
        config: cfg,
        calibration: { targetMs: CALIBRATE_TARGET_MS, maxPasses: timer.maxPasses(), method: 'two-level slope' },
        notes: spec.report.notes,
      },
      shaders: results,
    };

    showDonePopup({
      title: spec.report.popupTitle,
      subtitle: `${results.length} shaders @ ${res.width}×${res.height} on ${gpuInfo} (${timer.timingMethod}${spec.report.subtitleSuffix ?? ''})`,
      rows,
      onDownload: () => exportResults(payload, spec.report.filename),
      onRunAgain: () => { gateApi.show(); },
    });
  }

  // ── Boot ─────────────────────────────────────────────────────────────────
  //
  // IMPORTANT: cache DOM refs and wire all event listeners + the picker
  // SYNCHRONOUSLY, *before* any `await` — createBenchDriver is called from
  // the bench module's top level, and the launcher (../index.html) moves
  // #hud / #controls / #shader-picker / #log out of the iframe into its
  // sidebar on the iframe's `load` event. Module execution finishes before
  // `load`, so cached refs taken now resolve correctly — and adopted nodes
  // keep their identity, so the cached references keep working after the
  // launcher re-parents them. If we queried `document.getElementById`
  // after an `await`, it would return null because the nodes no longer
  // live in the iframe's document.
  const refs = {
    pickList:     $('pick-list'),
    shaderPicker: $('shader-picker'),
    log:          $('log'),
    btnStart:     $('btn-start'),
    btnStop:      $('btn-stop'),
    btnShaders:   $('btn-shaders'),
    btnLog:       $('btn-log'),
    btnReset:     $('btn-reset'),
  };

  let gateApi;
  buildPicker(registry, refs.pickList, spec.pickerKey, spec.defaultGroups);
  const settings = wireSettings(spec.defaults, spec.settingsKey);

  refs.btnStart  .addEventListener('click', () => { gateApi?.hide(); runBenchmark(); });
  refs.btnStop   .addEventListener('click', () => { running = false; });
  refs.btnShaders.addEventListener('click', () => refs.shaderPicker.classList.toggle('visible'));
  refs.btnLog    .addEventListener('click', () => refs.log.classList.toggle('visible'));
  refs.btnReset  .addEventListener('click', () => { settings.reset(); log('Settings reset to defaults', 'ok'); });

  gateApi = createStartGate({
    title: spec.gate.title,
    subtitle: spec.gate.subtitle,
    buttonLabel: spec.gate.buttonLabel,
    onStart: runBenchmark,
  });

  (async () => {
    try {
      await initRenderer();
      spec.afterInit?.(renderer);
    } catch (e) {
      log(`Init failed: ${e.message}`, 'err');
      console.error(e);
    }
  })();
}
