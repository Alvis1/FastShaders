/* Sphere Static — WebGPU multi-pass benchmark.
 *
 * Paper § 3.3 + Table 2 macOS column: a static fullscreen sphere,
 * rendering N passes per measurement so the per-pass cost rises above
 * the display vsync floor. Without multi-pass, desktop screens (60 Hz /
 * 120 Hz) clamp every shader to the same number — losing the cost
 * signal entirely.
 *
 * Timing + per-pass cost derivation live in ../lib/bench-timing.js:
 * GPU timestamp queries when the adapter supports them (wall-clock
 * around an onSubmittedWorkDone fence otherwise), and a two-level
 * (N / 2N passes) slope so fixed per-batch overhead cancels out of the
 * per-pass figure.
 *
 * Resolution matches Quest 3 per-eye (2064 × 2208) — the reference
 * pixel count of the point currency (bench-stats REF_PIXELS). */

import {
  WebGPURenderer, Scene, PerspectiveCamera,
  SphereGeometry, Mesh, MeshPhysicalNodeMaterial, Color,
  AmbientLight, DirectionalLight,
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
const log = makeLogger('SS-static');

// Quest 3 per-eye resolution — matches the InOut bench's per-eye render target
const Q3_WIDTH = 2064;
const Q3_HEIGHT = 2208;

const DEFAULTS = {
  'input-duration': 6,    // seconds per shader (cap; frames or duration ends first)
  'input-frames':   30,   // measurement PAIRS per shader (each pair = one
                          // batch at N passes + one at 2N — see bench-timing's
                          // slope method)
  'input-passes':   30,   // MINIMUM passes per measurement. Calibrated per
                          // shader (bench-timing calibrate) so the measurement
                          // window spans CALIBRATE_TARGET_MS — without that,
                          // performance.now()'s 1 ms quantization in some
                          // browser/iframe contexts (Safari especially)
                          // dominates the signal at 30 passes on a fast GPU.
  'input-warmup':   5,    // warmup multi-pass measurements before recording
  'input-stride':   1,    // log every Nth measurement (1 = every)
};

// Range clamps for the settings inputs (readSetting). frames ≥ 2 because
// computeStats needs two samples; passes/duration/stride must be positive
// or the run loop degenerates.
const LIMITS = {
  duration: { min: 1, max: 600 },
  frames:   { min: 2, max: 1000 },
  passes:   { min: 1, max: 2000 },
  warmup:   { min: 0, max: 100 },
  stride:   { min: 1, max: 100 },
};

const SETTINGS_KEY = 'shadercarousel:static:settings';
const PICKER_KEY = 'shadercarousel:static:picker';
const DEFAULT_GROUPS = new Set(['baseline', 'preset', 'noise']);

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
scene.background = new Color(0x0b0b10);
const camera = new PerspectiveCamera(30, 1, 0.1, 100);
camera.position.set(0, 0, 0); camera.lookAt(0, 0, -1);

scene.add(new AmbientLight(0xffffff, 0.4));
const dir = new DirectionalLight(0xffffff, 0.8);
dir.position.set(2, 3, 1); scene.add(dir);

const FULL_COVERAGE_SCALE = 2.0;
const SPHERE_Z = -5;
const geo = new SphereGeometry(1, 64, 64);
const baseMat = new MeshPhysicalNodeMaterial();
baseMat.colorNode = REGISTRY[0].build(); // baseline
const sphere = new Mesh(geo, baseMat);
sphere.position.set(0, 0, SPHERE_Z);
sphere.scale.setScalar(FULL_COVERAGE_SCALE);
scene.add(sphere);

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
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
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
  } catch { /* no WebGPU adapter */ }
  log(`GPU: ${gpuInfo}`, 'ok');
  log(`Render resolution: ${Q3_WIDTH}×${Q3_HEIGHT} (Quest 3 per-eye)`, 'ok');

  renderer.render(scene, camera);
  log('Ready', 'ok');
}

// ── Measurement loop ───────────────────────────────────────────────────────
async function benchmarkOne(shaderDef, cfg) {
  // Apply at tiny scale so the compile/upload spike is invisible
  sphere.scale.setScalar(0.001);
  const mat = new MeshPhysicalNodeMaterial();
  try { mat.colorNode = shaderDef.build(); }
  catch (e) { log(`FAIL ${shaderDef.label}: ${e.message}`, 'err'); return null; }
  sphere.material = mat;
  sphere.scale.setScalar(FULL_COVERAGE_SCALE);

  // Warmup
  for (let i = 0; i < cfg.warmup; i++) await timer.measure(cfg.passes);

  const { passesLo, passesHi } = await timer.calibrate(cfg.passes);
  if (passesLo !== cfg.passes) {
    log(`  calibrated ${shaderDef.label} → ${passesLo}/${passesHi} passes per lo/hi batch`, 'info');
  }

  // Interleaved lo/hi batches (ABAB) so thermal drift hits both slope
  // levels symmetrically instead of biasing one.
  const frames = [];
  const loTotals = [], hiTotals = [];
  const start = performance.now();
  let i = 0;
  while (i < cfg.frames && (performance.now() - start) < cfg.duration && running) {
    const lo = await timer.measure(passesLo);
    const hi = await timer.measure(passesHi);
    loTotals.push(lo.totalMs);
    hiTotals.push(hi.totalMs);
    if ((i % cfg.stride) === 0) {
      const t = +(performance.now() - start).toFixed(1);
      frames.push({ t, passes: passesLo, totalMs: +lo.totalMs.toFixed(4), gpuMs: lo.gpuMs != null ? +lo.gpuMs.toFixed(4) : null, frameTime: +(lo.totalMs / passesLo).toFixed(4) });
      frames.push({ t, passes: passesHi, totalMs: +hi.totalMs.toFixed(4), gpuMs: hi.gpuMs != null ? +hi.gpuMs.toFixed(4) : null, frameTime: +(hi.totalMs / passesHi).toFixed(4) });
    }
    $('hud-ft').textContent = (hi.totalMs / passesHi).toFixed(4) + ' ms';
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
    duration: readSetting('input-duration', DEFAULTS['input-duration'], LIMITS.duration) * 1000,
    frames:   readSetting('input-frames',   DEFAULTS['input-frames'],   LIMITS.frames),
    passes:   readSetting('input-passes',   DEFAULTS['input-passes'],   LIMITS.passes),
    warmup:   readSetting('input-warmup',   DEFAULTS['input-warmup'],   LIMITS.warmup),
    stride:   readSetting('input-stride',   DEFAULTS['input-stride'],   LIMITS.stride),
  };

  // Snap renderer to Quest 3 per-eye for measurement
  renderer.setSize(Q3_WIDTH, Q3_HEIGHT, false);
  camera.aspect = Q3_WIDTH / Q3_HEIGHT; camera.updateProjectionMatrix();

  // Honour the user's selection — baseline defaults on but is toggleable.
  // If unticked, the export's marginal-cost columns fall back to raw ms.
  const selectedIds = new Set(getSelectedIds(refs.pickList));
  // If selected, baseline runs first so subsequent shaders can subtract.
  const shaders = REGISTRY.filter(s => selectedIds.has(s.id) && !s.disabled);
  shaders.sort((a, b) => (a.id === 'ref_baseline' ? -1 : b.id === 'ref_baseline' ? 1 : 0));

  log(`Running ${shaders.length} shaders @ ${Q3_WIDTH}×${Q3_HEIGHT}, ${cfg.passes} passes × ${cfg.frames} frames`);

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
    log(`  → ${stats.points} pts | ${stats.msPerPass ?? stats.medianFt} ms/pass (slope) | ${stats.cvPercent}% CV | ${out.passesLo}/${out.passesHi} passes`, 'ok');
  }

  // Restore display
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  sphere.material = baseMat; sphere.scale.setScalar(FULL_COVERAGE_SCALE);

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
  // per-pass costs, normalized to the reference pixel count.
  annotateMarginalCost(results, { pixels: Q3_WIDTH * Q3_HEIGHT });
  const rows = results.map(r => ({
    label: r.label,
    medianMs: r.stats.msPerPass ?? r.stats.medianFt,
    marginalMs: r.stats.marginalMsAtRef ?? r.stats.marginalMs,
    points: r.stats.marginalPoints,
  }));

  const payload = {
    metadata: {
      schemaVersion: 2,
      bench: 'static',
      tool: 'ShaderCarousel — Sphere Static',
      resolution: { width: Q3_WIDTH, height: Q3_HEIGHT, label: 'Quest 3 per-eye' },
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
      notes: 'Static fullscreen sphere, multi-pass per measurement, timed via GPU timestamp queries when available (timingMethod) with a wall-clock fence fallback. Each shader is measured at N and 2N passes per batch (stats.passesLo/passesHi); per-pass cost = (median(total@2N) − median(total@N)) / N so fixed per-batch overhead cancels. stats.msPerPass is authoritative; stats.medianFt is the hi-level per-pass median (diagnostic).',
    },
    shaders: results,
  };

  showDonePopup({
    title: 'Static bench complete',
    subtitle: `${results.length} shaders @ ${Q3_WIDTH}×${Q3_HEIGHT} on ${gpuInfo} (${timer.timingMethod})`,
    rows,
    onDownload: () => exportResults(payload, 'shadercarousel-static'),
    onRunAgain: () => { gateApi.show(); },
  });
}

// ── Boot ───────────────────────────────────────────────────────────────────
//
// IMPORTANT: cache DOM refs and wire all event listeners + the picker
// SYNCHRONOUSLY at module top, *before* any `await`. The launcher
// (../index.html) moves #hud / #controls / #shader-picker / #log out of
// this iframe into its sidebar on the iframe's `load` event. Module
// execution finishes before `load`, so cached refs taken now resolve
// correctly — and adopted nodes keep their identity, so the cached
// references keep working after the launcher re-parents them. If we
// queried `document.getElementById` after an `await`, it would return
// null because the nodes no longer live in the iframe's document.
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
  title: 'Sphere Static — WebGPU multi-pass',
  subtitle: 'Full-coverage sphere at Quest 3 per-eye resolution. Measures each shader at N and 2N passes per batch (GPU timestamps when available) and takes the slope, so vsync, clock granularity, and per-batch overhead all cancel out of the per-pass cost.',
  buttonLabel: '▶ Start Static bench',
  onStart: runBenchmark,
});

(async () => {
  try {
    await initRenderer();
    // Idle-state render so the scene isn't black before Start
    renderer.render(scene, camera);
  } catch (e) {
    log(`Init failed: ${e.message}`, 'err');
    console.error(e);
  }
})();
