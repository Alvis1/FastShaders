/* MicroPlane — per-node microbenchmarks on a small ortho quad.
 *
 * Paper § 3.3: "Recovering individual node costs requires microbenchmarks
 * or regression over a larger shader corpus". This bench gives the
 * regression input — every shader runs against a fixed-size 2D quad
 * (default 512×512), under multi-pass WebGPU fence sync, so the timing is
 * dominated by ALU/bandwidth rather than scene overhead.
 *
 * Default corpus = 8 noise atomics + baseline. Presets are available but
 * unchecked by default — they're compositions, more useful in the Static
 * bench. Marginal cost (median − baseline) feeds the complexity.json
 * suggestion emitter directly. */

import {
  WebGPURenderer, Scene, OrthographicCamera,
  PlaneGeometry, Mesh, MeshBasicNodeMaterial,
} from 'three';
import * as TSL from 'three/tsl';
import { buildBenchRegistry } from '../lib/bench-registry.js';
import { computeStats, exportResults } from '../lib/bench-stats.js';
import {
  makeLogger, buildPicker, getSelectedIds, wireSettings,
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
  'input-frames':  60,   // measurements per shader
  'input-passes':  30,   // MINIMUM passes per measurement. Calibration
                         // (see calibratePasses) may bump this per-shader
                         // until each measurement spans `CALIBRATE_TARGET_MS`,
                         // so 1 ms clock granularity is small relative to
                         // the window. Cheap shaders need more passes.
  'input-warmup':  5,
  'input-stride':  1,
};

// Target wall-clock per measurement (~5% error at 1ms granularity).
// Capped at 4000 passes so very-cheap shaders don't run forever; if a
// shader is so cheap we hit the cap, the measurement is still valid —
// the recorded per-pass cost will just inherit some clock noise.
const CALIBRATE_TARGET_MS = 20;
const CALIBRATE_MAX_PASSES = 4000;

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

let renderer, gpuDevice, gpuInfo = 'unknown';
let running = false;
let benchSize = DEFAULTS['input-size'];

async function initRenderer() {
  log('Initializing WebGPU renderer…');
  renderer = new WebGPURenderer({
    canvas: $('canvas'),
    antialias: false,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(1);
  renderer.setSize(benchSize, benchSize, false);
  await renderer.init();

  const backend = renderer.backend;
  if (backend?.device) {
    gpuDevice = backend.device;
    log('GPU sync: device.queue.onSubmittedWorkDone', 'ok');
  } else if (backend?.gl) {
    log('GPU sync: gl.finish() fallback', 'warn');
  }

  try {
    if (navigator.gpu) {
      const a = await navigator.gpu.requestAdapter();
      const i = a?.info;
      gpuInfo = [i?.vendor, i?.architecture, i?.device, i?.description]
        .filter(Boolean).join(' / ') || 'unknown';
    }
  } catch { /* no adapter */ }
  log(`GPU: ${gpuInfo}`, 'ok');

  renderer.render(scene, camera);
  log('Ready', 'ok');
}

async function gpuSync() {
  if (gpuDevice?.queue?.onSubmittedWorkDone) {
    await gpuDevice.queue.onSubmittedWorkDone();
    return;
  }
  if (renderer.backend?.gl) { renderer.backend.gl.finish(); return; }
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
}

async function measureMultiPass(passes) {
  const t0 = performance.now();
  for (let i = 0; i < passes; i++) renderer.render(scene, camera);
  await gpuSync();
  return performance.now() - t0;     // total elapsed ms (NOT per-pass)
}

/**
 * Find the smallest pass count ≥ `minPasses` that makes a measurement
 * span at least `CALIBRATE_TARGET_MS`. Without this, cheap atomics on a
 * fast GPU finish a 30-pass batch in 1–2 ms, where `performance.now()`'s
 * 1 ms quantization (Safari + some Chrome iframe contexts) dominates
 * the signal and every shader appears to "tie".
 *
 * Doubles passes per probe (or scales by a measured ratio when we have a
 * reading > 0). Caps at CALIBRATE_MAX_PASSES so a degenerate near-zero
 * cost can't run forever — at the cap we accept the noise.
 */
async function calibratePasses(minPasses) {
  let p = minPasses;
  await measureMultiPass(p);          // burn one batch to warm the pipeline
  for (let probe = 0; probe < 10; probe++) {
    const elapsed = await measureMultiPass(p);
    if (elapsed >= CALIBRATE_TARGET_MS || p >= CALIBRATE_MAX_PASSES) return p;
    const scale = elapsed > 0
      ? Math.max(2, Math.ceil((CALIBRATE_TARGET_MS / elapsed) * 1.2))
      : 4;
    p = Math.min(p * scale, CALIBRATE_MAX_PASSES);
  }
  return p;
}

async function benchmarkOne(shaderDef, cfg, baselineMedian) {
  const mat = new MeshBasicNodeMaterial();
  try { mat.colorNode = shaderDef.build(); }
  catch (e) { log(`FAIL ${shaderDef.label}: ${e.message}`, 'err'); return null; }
  quad.material = mat;

  // Quick warmup (compile + first-frame texture upload spikes)
  for (let i = 0; i < cfg.warmup; i++) await measureMultiPass(cfg.passes);

  // Per-shader pass calibration. The user's `passes` setting is the
  // minimum; we bump until each measurement spans CALIBRATE_TARGET_MS.
  const passes = await calibratePasses(cfg.passes);
  if (passes !== cfg.passes) {
    log(`  calibrated ${shaderDef.label} → ${passes} passes/measurement`, 'info');
  }

  const frames = [];
  let i = 0;
  while (i < cfg.frames && running) {
    const totalMs = await measureMultiPass(passes);
    const msPerPass = totalMs / passes;
    if ((i % cfg.stride) === 0) frames.push({ t: i, frameTime: +msPerPass.toFixed(4), passes });
    $('hud-ft').textContent = msPerPass.toFixed(4) + ' ms';
    if (baselineMedian != null) {
      $('hud-marginal').textContent = (msPerPass - baselineMedian).toFixed(4) + ' ms';
    }
    i++;
    if (i % 5 === 0) await new Promise(r => setTimeout(r, 0));
  }

  mat.dispose();
  return { frames, calibratedPasses: passes };
}

async function runBenchmark() {
  running = true;
  $('btn-start').disabled = true; $('btn-stop').disabled = false;

  const cfg = {
    size:    +$('input-size').value   || DEFAULTS['input-size'],
    frames:  +$('input-frames').value || DEFAULTS['input-frames'],
    passes:  +$('input-passes').value || DEFAULTS['input-passes'],
    warmup:  +$('input-warmup').value || DEFAULTS['input-warmup'],
    stride:  +$('input-stride').value || DEFAULTS['input-stride'],
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
  let baselineMedian = null;

  for (let i = 0; i < shaders.length; i++) {
    if (!running) break;
    const s = shaders[i];
    $('hud-shader').textContent = s.label;
    $('hud-progress').textContent = `${i + 1}/${shaders.length}`;
    $('progress-bar').style.width = `${((i + 1) / shaders.length * 100).toFixed(1)}%`;
    $('hud-phase').textContent = 'measuring';
    log(`[${i + 1}/${shaders.length}] ${s.label}…`);

    const out = await benchmarkOne(s, cfg, baselineMedian);
    if (!out || out.frames.length === 0) continue;
    const stats = computeStats(out.frames);
    stats.calibratedPasses = out.calibratedPasses;
    if (s.id === 'ref_baseline') baselineMedian = stats.medianFt;
    $('hud-pts').textContent = stats.points;
    results.push({ id: s.id, label: s.label, category: s.category, stats, frames: out.frames });
    const marg = baselineMedian != null ? (stats.medianFt - baselineMedian).toFixed(4) : '—';
    log(`  → ${stats.medianFt} ms/pass (marg ${marg}) | ${stats.cvPercent}% CV | ${out.calibratedPasses} passes`, 'ok');
  }

  quad.material = baseMat;
  $('hud-phase').textContent = 'done';
  $('progress-bar').style.width = '100%';
  log(`Complete: ${results.length} shaders`, 'ok');
  running = false;
  $('btn-start').disabled = false; $('btn-stop').disabled = true;

  showResultsPopup(results, cfg, baselineMedian);
}

function showResultsPopup(results, cfg, baselineMedian) {
  const rows = results.map(r => ({
    label: r.label,
    medianMs: r.stats.medianFt,
    marginalMs: baselineMedian != null ? +(r.stats.medianFt - baselineMedian).toFixed(4) : null,
    points: r.stats.points,
  }));

  const payload = {
    metadata: {
      bench: 'microplane',
      tool: 'ShaderCarousel — MicroPlane',
      resolution: { width: cfg.size, height: cfg.size, label: 'microplane' },
      date: new Date().toISOString(),
      userAgent: navigator.userAgent,
      gpu: gpuInfo,
      config: cfg,
      calibration: { targetMs: CALIBRATE_TARGET_MS, maxPasses: CALIBRATE_MAX_PASSES },
      notes: 'Per-node microbenchmark on a 2×2 ortho quad. Cost = elapsed / passes. Pass count is calibrated per-shader (min = config.passes) so each measurement window is ≥ calibration.targetMs and the recorded ms/pass is not dominated by performance.now() granularity. Per-shader calibrated pass count is in stats.calibratedPasses.',
    },
    shaders: results,
  };

  showDonePopup({
    title: 'MicroPlane bench complete',
    subtitle: `${results.length} shaders @ ${cfg.size}×${cfg.size} on ${gpuInfo}`,
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
  subtitle: 'Small ortho quad, WebGPU fence sync, multi-pass timing. Defaults to noise atomics + baseline — best for deriving per-node points by subtraction. Does not enter immersive mode.',
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
