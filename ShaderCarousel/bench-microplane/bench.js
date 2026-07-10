/* MicroPlane — per-node microbenchmarks on a small ortho quad.
 *
 * Paper § 3.3: "Recovering individual node costs requires microbenchmarks
 * or regression over a larger shader corpus". This bench gives the
 * regression input — every shader runs against a fixed-size 2D quad
 * (default 1024×1024), multi-pass, so the timing is dominated by
 * ALU/bandwidth rather than scene overhead. Timing + per-pass cost
 * derivation live in ../lib/bench-timing.js: GPU timestamp queries when
 * available (wall-clock fence otherwise) and a two-level (N / 2N) slope
 * that cancels fixed per-batch overhead.
 *
 * Default corpus = 8 noise atomics + baseline. Presets are available but
 * unchecked by default — they're compositions, more useful in the Static
 * bench. Marginal cost (slope msPerPass − baseline), scaled to the
 * 2064×2208 reference pixel count, feeds the complexity.json suggestion
 * emitter directly. */

import {
  WebGPURenderer, Scene, OrthographicCamera,
  PlaneGeometry, Mesh, MeshBasicNodeMaterial,
} from 'three';
import * as TSL from 'three/tsl';
import { buildBenchRegistry } from '../lib/bench-registry.js';
import {
  statsFromTwoLevelRun, annotateMarginalCost, exportResults,
} from '../lib/bench-stats.js';
import { createBenchTimer, CALIBRATE_TARGET_MS } from '../lib/bench-timing.js';
import {
  makeLogger, buildPicker, getSelectedIds, wireSettings, readSetting,
  createStartGate, showDonePopup, installErrorOverlay,
} from '../lib/bench-ui.js';

installErrorOverlay();
const log = makeLogger('SC-micro');

const DEFAULTS = {
  'input-size':    1024, // px (square plane resolution) — 4× the fragments
                         // of the old 512² default. Multi-pass at 512² on
                         // Apple Silicon finished in ~2 ms total per
                         // measurement; with `performance.now()` clamped
                         // to 1 ms in Safari + some Chrome iframe contexts
                         // that meant 50% quantization noise and "ties"
                         // across shaders. 1024² puts cheap atomics into
                         // a measurable range and keeps expensive shaders
                         // tolerable under adaptive pass calibration.
  'input-frames':  60,   // measurement PAIRS per shader (each pair = one
                         // batch at N passes + one at 2N — see bench-timing's
                         // slope method)
  'input-passes':  30,   // MINIMUM passes per measurement. Calibration
                         // (bench-timing calibrate) may bump this per-shader
                         // until each measurement spans `CALIBRATE_TARGET_MS`,
                         // so 1 ms clock granularity is small relative to
                         // the window. Cheap shaders need more passes.
  'input-warmup':  5,
  'input-stride':  1,
};

// Range clamps for the settings inputs (readSetting). frames ≥ 2 because
// computeStats needs two samples; size bounded to sane render targets.
const LIMITS = {
  size:   { min: 64, max: 4096 },
  frames: { min: 2, max: 1000 },
  passes: { min: 1, max: 2000 },
  warmup: { min: 0, max: 100 },
  stride: { min: 1, max: 100 },
};

const SETTINGS_KEY = 'shadercarousel:micro:settings';
const PICKER_KEY = 'shadercarousel:micro:picker';
// Atomics + baseline only by default — presets are compositions and belong
// in the Static bench. User can still tick them manually.
const DEFAULT_GROUPS = new Set(['baseline', 'noise']);

// Falls back to the parent document when the iframe lookup misses —
// covers the case where the ShaderCarousel launcher has re-parented
// #controls / #hud / #shader-picker / #log into its sidebar by the time
// a click handler fires. See the matching comment in bench-inout/bench.js.
const $ = id => {
  const el = document.getElementById(id);
  if (el) return el;
  if (window.parent !== window) {
    try { return window.parent.document.getElementById(id); } catch { /* cross-origin */ }
  }
  return null;
};

// ── Scene setup ────────────────────────────────────────────────────────────
const REGISTRY = buildBenchRegistry(TSL);
const scene = new Scene();
const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);

const quadGeo = new PlaneGeometry(2, 2);
const baseMat = new MeshBasicNodeMaterial();
baseMat.colorNode = REGISTRY[0].build(); // baseline
const quad = new Mesh(quadGeo, baseMat);
quad.frustumCulled = false;
scene.add(quad);

let renderer, timer, gpuInfo = 'unknown', adapterInfo = null;
let running = false;
let benchSize = DEFAULTS['input-size'];

async function initRenderer() {
  log('Initializing WebGPU renderer…');
  renderer = new WebGPURenderer({
    canvas: $('canvas'),
    antialias: false,
    powerPreference: 'high-performance',
    trackTimestamp: true, // three degrades this to false when the adapter lacks 'timestamp-query'
  });
  renderer.setPixelRatio(1);
  renderer.setSize(benchSize, benchSize, false);
  await renderer.init();

  timer = createBenchTimer({
    renderer,
    renderFn: () => renderer.render(scene, camera),
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
  } catch { /* no adapter */ }
  log(`GPU: ${gpuInfo}`, 'ok');

  renderer.render(scene, camera);
  log('Ready', 'ok');
}

async function benchmarkOne(shaderDef, cfg, baselineMsPerPass) {
  const mat = new MeshBasicNodeMaterial();
  try { mat.colorNode = shaderDef.build(); }
  catch (e) { log(`FAIL ${shaderDef.label}: ${e.message}`, 'err'); return null; }
  quad.material = mat;

  // Quick warmup (compile + first-frame texture upload spikes)
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
  let i = 0;
  while (i < cfg.frames && running) {
    const lo = await timer.measure(passesLo);
    const hi = await timer.measure(passesHi);
    loTotals.push(lo.totalMs);
    hiTotals.push(hi.totalMs);
    if ((i % cfg.stride) === 0) {
      frames.push({ t: i, passes: passesLo, totalMs: +lo.totalMs.toFixed(4), gpuMs: lo.gpuMs != null ? +lo.gpuMs.toFixed(4) : null, frameTime: +(lo.totalMs / passesLo).toFixed(4) });
      frames.push({ t: i, passes: passesHi, totalMs: +hi.totalMs.toFixed(4), gpuMs: hi.gpuMs != null ? +hi.gpuMs.toFixed(4) : null, frameTime: +(hi.totalMs / passesHi).toFixed(4) });
    }
    const msPerPass = hi.totalMs / passesHi;
    $('hud-ft').textContent = msPerPass.toFixed(4) + ' ms';
    if (baselineMsPerPass != null) {
      // Use the overhead-free slope (fixed per-batch overhead C cancels in
      // the difference) so the HUD marginal agrees with the exported
      // marginalMs — matches bench-stats' statsFromTwoLevelRun slope. The
      // single-batch hi.totalMs/passesHi is overhead-inclusive and inflates
      // marginal by C/passes if subtracted directly.
      const slopeMsPerPass = (hi.totalMs - lo.totalMs) / (passesHi - passesLo);
      $('hud-marginal').textContent = (slopeMsPerPass - baselineMsPerPass).toFixed(4) + ' ms';
    }
    i++;
    if (i % 5 === 0) await new Promise(r => setTimeout(r, 0));
  }

  mat.dispose();
  return { frames, loTotals, hiTotals, passesLo, passesHi };
}

async function runBenchmark() {
  running = true;
  $('btn-start').disabled = true; $('btn-stop').disabled = false;

  const cfg = {
    size:    readSetting('input-size',   DEFAULTS['input-size'],   LIMITS.size),
    frames:  readSetting('input-frames', DEFAULTS['input-frames'], LIMITS.frames),
    passes:  readSetting('input-passes', DEFAULTS['input-passes'], LIMITS.passes),
    warmup:  readSetting('input-warmup', DEFAULTS['input-warmup'], LIMITS.warmup),
    stride:  readSetting('input-stride', DEFAULTS['input-stride'], LIMITS.stride),
  };

  if (cfg.size !== benchSize) {
    benchSize = cfg.size;
    renderer.setSize(benchSize, benchSize, false);
  }

  // Honour the user's selection — baseline defaults on but is toggleable.
  // If unticked, marginal-cost columns fall back to raw ms in the export.
  const selectedIds = new Set(getSelectedIds(refs.pickList));
  const shaders = REGISTRY.filter(s => selectedIds.has(s.id) && !s.disabled);
  // If selected, baseline runs first so subsequent shaders can subtract.
  shaders.sort((a, b) => (a.id === 'ref_baseline' ? -1 : b.id === 'ref_baseline' ? 1 : 0));

  log(`Running ${shaders.length} shaders @ ${cfg.size}×${cfg.size}, ${cfg.passes} passes × ${cfg.frames} frames`);

  const results = [];
  let baselineMsPerPass = null;

  for (let i = 0; i < shaders.length; i++) {
    if (!running) break;
    const s = shaders[i];
    $('hud-shader').textContent = s.label;
    $('hud-progress').textContent = `${i + 1}/${shaders.length}`;
    $('progress-bar').style.width = `${((i + 1) / shaders.length * 100).toFixed(1)}%`;
    $('hud-phase').textContent = 'measuring';
    log(`[${i + 1}/${shaders.length}] ${s.label}…`);

    const out = await benchmarkOne(s, cfg, baselineMsPerPass);
    if (!out || out.hiTotals.length < 2) {
      if (out) log(`  skipped ${s.label}: only ${out.hiTotals.length} measurement pair(s) — need ≥2`, 'warn');
      continue;
    }
    const stats = statsFromTwoLevelRun(out);
    if (s.id === 'ref_baseline') baselineMsPerPass = stats.msPerPass ?? stats.medianFt;
    $('hud-pts').textContent = stats.points;
    results.push({ id: s.id, label: s.label, category: s.category, stats, frames: out.frames });
    const own = stats.msPerPass ?? stats.medianFt;
    const marg = baselineMsPerPass != null ? (own - baselineMsPerPass).toFixed(4) : '—';
    log(`  → ${own} ms/pass (slope, marg ${marg}) | ${stats.cvPercent}% CV | ${out.passesLo}/${out.passesHi} passes`, 'ok');
  }

  quad.material = baseMat;
  $('hud-phase').textContent = 'done';
  $('progress-bar').style.width = '100%';
  log(`Complete: ${results.length} shaders`, 'ok');
  running = false;
  $('btn-start').disabled = false; $('btn-stop').disabled = true;

  showResultsPopup(results, cfg);
}

function showResultsPopup(results, cfg) {
  // Shared annotator (idempotent — exportResults runs it again): adds
  // marginalMs / marginalMsAtRef / marginalPoints from the slope-based
  // per-pass costs, normalized to the reference pixel count. This is
  // where the old ~4.35× point deflation (1024² vs the 2064×2208
  // currency) gets corrected.
  annotateMarginalCost(results, { pixels: cfg.size * cfg.size });
  const rows = results.map(r => ({
    label: r.label,
    medianMs: r.stats.msPerPass ?? r.stats.medianFt,
    marginalMs: r.stats.marginalMsAtRef ?? r.stats.marginalMs,
    points: r.stats.marginalPoints,
  }));

  const payload = {
    metadata: {
      schemaVersion: 2,
      bench: 'microplane',
      tool: 'ShaderCarousel — MicroPlane',
      resolution: { width: cfg.size, height: cfg.size, label: 'microplane' },
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
      notes: 'Per-node microbenchmark on a 2×2 ortho quad, timed via GPU timestamp queries when available (timingMethod) with a wall-clock fence fallback. Each shader is measured at N and 2N passes per batch (stats.passesLo/passesHi); per-pass cost = (median(total@2N) − median(total@N)) / N so fixed per-batch overhead cancels. stats.msPerPass is authoritative; marginal points are normalized to the 2064×2208 reference resolution in the export.',
    },
    shaders: results,
  };

  showDonePopup({
    title: 'MicroPlane bench complete',
    subtitle: `${results.length} shaders @ ${cfg.size}×${cfg.size} on ${gpuInfo} (${timer.timingMethod}, points normalized to 2064×2208)`,
    rows,
    onDownload: () => exportResults(payload, 'shadercarousel-microplane'),
    onRunAgain: () => { gateApi.show(); },
  });
}

// ── Boot ───────────────────────────────────────────────────────────────────
//
// IMPORTANT: cache DOM refs and wire all event listeners + the picker
// SYNCHRONOUSLY at module top, *before* any `await`. The launcher moves
// #shader-picker / #log / #controls etc out of this iframe into its
// sidebar on the iframe `load` event. Module execution finishes before
// `load`, so refs taken now resolve correctly; adopted nodes keep their
// identity so the cached refs continue to work after re-parenting. See
// the matching note in bench-static/bench.js for the full rationale.
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
buildPicker(REGISTRY, refs.pickList, PICKER_KEY, DEFAULT_GROUPS);
const settings = wireSettings(DEFAULTS, SETTINGS_KEY);

refs.btnStart  .addEventListener('click', () => { gateApi?.hide(); runBenchmark(); });
refs.btnStop   .addEventListener('click', () => { running = false; });
refs.btnShaders.addEventListener('click', () => refs.shaderPicker.classList.toggle('visible'));
refs.btnLog    .addEventListener('click', () => refs.log.classList.toggle('visible'));
refs.btnReset  .addEventListener('click', () => { settings.reset(); log('Settings reset to defaults', 'ok'); });

gateApi = createStartGate({
  title: 'MicroPlane — per-node microbench',
  subtitle: 'Small ortho quad, multi-pass timing (GPU timestamps when available), two-level slope per shader. Defaults to noise atomics + baseline — best for deriving per-node points by subtraction; exported points are normalized to the 2064×2208 reference resolution. Does not enter immersive mode.',
  buttonLabel: '▶ Start MicroPlane bench',
  onStart: runBenchmark,
});

(async () => {
  try {
    await initRenderer();
  } catch (e) {
    log(`Init failed: ${e.message}`, 'err');
    console.error(e);
  }
})();
