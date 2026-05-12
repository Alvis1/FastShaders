/* Sphere Static — WebGPU multi-pass benchmark.
 *
 * Paper § 3.3 + Table 2 macOS column: a static fullscreen sphere with
 * `device.queue.onSubmittedWorkDone` fence sync, rendering N passes per
 * measurement so the per-pass cost rises above the display vsync floor.
 * Without multi-pass, desktop screens (60 Hz / 120 Hz) clamp every shader
 * to the same number — losing the cost signal entirely.
 *
 * Resolution matches Quest 3 per-eye (2064 × 2208) so the numbers are
 * directly comparable to the InOut bench's immersive on-device timings. */

import {
  WebGPURenderer, Scene, PerspectiveCamera,
  SphereGeometry, Mesh, MeshPhysicalNodeMaterial, Color,
  AmbientLight, DirectionalLight,
} from 'three';
import * as TSL from 'three/tsl';
import { buildBenchRegistry } from '../lib/bench-registry.js';
import { computeStats, exportResults } from '../lib/bench-stats.js';
import {
  makeLogger, buildPicker, getSelectedIds, wireSettings,
  createStartGate, showDonePopup, installErrorOverlay,
} from '../lib/bench-ui.js';

installErrorOverlay();
const log = makeLogger('SS-static');

// Quest 3 per-eye resolution — matches the InOut bench's per-eye render target
const Q3_WIDTH = 2064;
const Q3_HEIGHT = 2208;

const DEFAULTS = {
  'input-duration': 6,    // seconds per shader (cap; frames or duration ends first)
  'input-frames':   30,   // measurements per shader (multi-pass × this many)
  'input-passes':   30,   // MINIMUM passes per measurement. Calibrated per
                          // shader (see calibratePasses) so the measurement
                          // window spans CALIBRATE_TARGET_MS — without that,
                          // performance.now()'s 1 ms quantization in some
                          // browser/iframe contexts (Safari especially)
                          // dominates the signal at 30 passes on a fast GPU.
  'input-warmup':   5,    // warmup multi-pass measurements before recording
  'input-stride':   1,    // log every Nth measurement (1 = every)
};

// Adaptive-pass calibration target: each measurement should span at least
// this many ms so the recorded per-pass cost isn't a quantization artefact.
const CALIBRATE_TARGET_MS = 20;
const CALIBRATE_MAX_PASSES = 4000;

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

let renderer, gpuDevice, gpuInfo = 'unknown';
let running = false;

async function initRenderer() {
  log('Initializing WebGPU renderer…');
  renderer = new WebGPURenderer({
    canvas: $('canvas'),
    antialias: false,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(1);
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  await renderer.init();

  const backend = renderer.backend;
  if (backend?.device) {
    gpuDevice = backend.device;
    log('GPU sync: device.queue.onSubmittedWorkDone', 'ok');
  } else if (backend?.gl) {
    log('GPU sync: gl.finish() (WebGL fallback — less precise)', 'warn');
  }

  try {
    if (navigator.gpu) {
      const a = await navigator.gpu.requestAdapter();
      const i = a?.info;
      gpuInfo = [i?.vendor, i?.architecture, i?.device, i?.description]
        .filter(Boolean).join(' / ') || 'unknown';
    }
  } catch { /* no WebGPU adapter */ }
  log(`GPU: ${gpuInfo}`, 'ok');
  log(`Render resolution: ${Q3_WIDTH}×${Q3_HEIGHT} (Quest 3 per-eye)`, 'ok');

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

/** Render N passes in a tight loop, fence once. Returns *total elapsed ms*
 *  (callers divide by N for per-pass cost). */
async function measureMultiPass(passes) {
  const t0 = performance.now();
  for (let i = 0; i < passes; i++) renderer.render(scene, camera);
  await gpuSync();
  return performance.now() - t0;
}

/** Same adaptive calibration as MicroPlane — see comment there. The
 *  Q3-per-eye sphere is much heavier than the MicroPlane quad, so the
 *  per-shader pass count will usually settle near cfg.passes for the
 *  expensive presets and only inflate for the cheap atomics + baseline. */
async function calibratePasses(minPasses) {
  let p = minPasses;
  await measureMultiPass(p);
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
  for (let i = 0; i < cfg.warmup; i++) await measureMultiPass(cfg.passes);

  const passes = await calibratePasses(cfg.passes);
  if (passes !== cfg.passes) {
    log(`  calibrated ${shaderDef.label} → ${passes} passes/measurement`, 'info');
  }

  const frames = [];
  const start = performance.now();
  let i = 0;
  while (i < cfg.frames && (performance.now() - start) < cfg.duration && running) {
    const totalMs = await measureMultiPass(passes);
    const msPerPass = totalMs / passes;
    if ((i % cfg.stride) === 0) {
      frames.push({ t: +(performance.now() - start).toFixed(1), frameTime: +msPerPass.toFixed(4), passes });
    }
    $('hud-ft').textContent = msPerPass.toFixed(4) + ' ms';
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
    duration: (+$('input-duration').value || DEFAULTS['input-duration']) * 1000,
    frames:   +$('input-frames').value   || DEFAULTS['input-frames'],
    passes:   +$('input-passes').value   || DEFAULTS['input-passes'],
    warmup:   +$('input-warmup').value   || DEFAULTS['input-warmup'],
    stride:   +$('input-stride').value   || DEFAULTS['input-stride'],
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
    if (!out || out.frames.length === 0) continue;
    const stats = computeStats(out.frames);
    stats.calibratedPasses = out.calibratedPasses;
    $('hud-pts').textContent = stats.points;
    results.push({ id: s.id, label: s.label, category: s.category, stats, frames: out.frames });
    log(`  → ${stats.points} pts | ${stats.medianFt} ms/pass | ${stats.cvPercent}% CV | ${out.calibratedPasses} passes`, 'ok');
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
  // Annotate marginal cost via exportResults' shared annotator. Done in
  // showDonePopup ordering: we need marginal columns in the table, so we
  // compute them inline here (the exporter also computes them — idempotent).
  const baseline = results.find(r => r.id === 'ref_baseline');
  const baselineMs = baseline ? baseline.stats.medianFt : 0;
  const rows = results.map(r => ({
    label: r.label,
    medianMs: r.stats.medianFt,
    marginalMs: +(r.stats.medianFt - baselineMs).toFixed(4),
    points: r.stats.points,
  }));

  const payload = {
    metadata: {
      bench: 'static',
      tool: 'ShaderCarousel — Sphere Static',
      resolution: { width: Q3_WIDTH, height: Q3_HEIGHT, label: 'Quest 3 per-eye' },
      date: new Date().toISOString(),
      userAgent: navigator.userAgent,
      gpu: gpuInfo,
      config: cfg,
      calibration: { targetMs: CALIBRATE_TARGET_MS, maxPasses: CALIBRATE_MAX_PASSES },
      notes: 'Static fullscreen sphere, WebGPU fence sync, multi-pass per measurement. Pass count is calibrated per-shader (min = config.passes) so each measurement window is ≥ calibration.targetMs and the recorded ms/pass is not dominated by performance.now() granularity. Per-shader calibrated pass count is in stats.calibratedPasses. Cost = elapsed / calibratedPasses.',
    },
    shaders: results,
  };

  showDonePopup({
    title: 'Static bench complete',
    subtitle: `${results.length} shaders @ ${Q3_WIDTH}×${Q3_HEIGHT} on ${gpuInfo}`,
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
  subtitle: 'Full-coverage sphere at Quest 3 per-eye resolution. Renders the shader 30× per measurement (default) and divides by N so per-pass cost rises above the display vsync floor.',
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
