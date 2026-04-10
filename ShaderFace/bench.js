// ShaderFace — Micro-Benchmark Engine
// Multi-pass timing with GPU sync, standard + resolution sweep modes

import {
  WebGPURenderer, Scene, OrthographicCamera,
  PlaneGeometry, Mesh, MeshBasicNodeMaterial,
} from 'three';
import { color as tslColor } from 'three/tsl';
import { SHADER_REGISTRY } from './shaderRegistry.js';

// ── DOM refs ──
const canvas = document.getElementById('canvas');
const hudShader = document.getElementById('hud-shader');
const hudLoop = document.getElementById('hud-loop');
const hudPhase = document.getElementById('hud-phase');
const hudGpu = document.getElementById('hud-gpu');
const hudMethod = document.getElementById('hud-method');
const progressBar = document.getElementById('progress-bar');
const logPanel = document.getElementById('log');
const btnStart = document.getElementById('btn-start');
const btnStop = document.getElementById('btn-stop');
const btnExport = document.getElementById('btn-export');
const btnLog = document.getElementById('btn-log');
const inputMode = document.getElementById('input-mode');
const inputLoops = document.getElementById('input-loops');
const inputFrames = document.getElementById('input-frames');
const inputPasses = document.getElementById('input-passes');
// Sweep mode
const btnShaders = document.getElementById('btn-shaders');
const shaderPicker = document.getElementById('shader-picker');
const pickList = document.getElementById('pick-list');
const inputResMin = document.getElementById('input-res-min');
const inputResMax = document.getElementById('input-res-max');
const inputResStep = document.getElementById('input-res-step');
const inputSweepSamples = document.getElementById('input-sweep-samples');
const inputSweepPasses = document.getElementById('input-sweep-passes');

// ── Logging ──
logPanel.classList.add('visible');

function log(msg, cls = 'info') {
  const d = document.createElement('div');
  d.className = cls;
  d.textContent = `[${new Date().toISOString().slice(11, 23)}] ${msg}`;
  logPanel.appendChild(d);
  logPanel.scrollTop = logPanel.scrollHeight;
  console.log(`[ShaderFace] ${msg}`);
}

btnLog.addEventListener('click', () => logPanel.classList.toggle('visible'));

// ── Mode toggle ──
inputMode.addEventListener('change', () => {
  document.body.className = inputMode.value === 'sweep' ? 'mode-sweep' : '';
});

// ── Shader picker ──
btnShaders.addEventListener('click', () => shaderPicker.classList.toggle('visible'));
document.getElementById('pick-all').addEventListener('click', () => {
  pickList.querySelectorAll('input').forEach(cb => cb.checked = true);
});
document.getElementById('pick-none').addEventListener('click', () => {
  pickList.querySelectorAll('input').forEach(cb => cb.checked = false);
});
document.getElementById('pick-top10').addEventListener('click', () => {
  // Select top 10 most expensive (by registry order — roughly sorted by cost)
  const cbs = [...pickList.querySelectorAll('input')];
  cbs.forEach(cb => cb.checked = false);
  // Always include baseline
  cbs.find(cb => cb.value === 'ref_flat_color')?.click();
  // Pick first 10 textures (registry is roughly cost-ordered)
  let count = 0;
  for (const cb of cbs) {
    if (count >= 10) break;
    if (cb.value.startsWith('tex_')) { cb.checked = true; count++; }
  }
});

function getSelectedShaderIds() {
  return [...pickList.querySelectorAll('input:checked')].map(cb => cb.value);
}

function buildShaderPicker() {
  pickList.innerHTML = '';
  for (const s of SHADER_REGISTRY) {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = s.id;
    cb.checked = true;
    label.appendChild(cb);
    label.appendChild(document.createTextNode(` ${s.label}`));
    pickList.appendChild(label);
  }
}

// ── Baseline color node ──
const BASELINE_NODE = tslColor(0x888888);

// ── Renderer setup ──
let rendererReady = false;
let renderer;
let gpuDevice = null;
let backendIsWebGL = false;

const scene = new Scene();
const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);

const quadGeo = new PlaneGeometry(2, 2);
const quadMat = new MeshBasicNodeMaterial();
quadMat.colorNode = BASELINE_NODE;
const quad = new Mesh(quadGeo, quadMat);
quad.frustumCulled = false;
scene.add(quad);

const BENCH_SIZE = 512;

async function initRenderer() {
  log('Initializing renderer...');
  try {
    renderer = new WebGPURenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    renderer.setSize(BENCH_SIZE, BENCH_SIZE);
    renderer.setPixelRatio(1);
    await renderer.init();
    log(`Renderer initialized (${BENCH_SIZE}x${BENCH_SIZE})`, 'ok');

    const backend = renderer.backend;
    backendIsWebGL = !!(backend && backend.isWebGLBackend);
    const backendName = backendIsWebGL ? 'WebGL' : 'WebGPU';
    log(`Backend: ${backendName}`, 'ok');

    try {
      if (backend && backend.device) {
        gpuDevice = backend.device;
        log('GPU sync: device.queue.onSubmittedWorkDone (WebGPU)', 'ok');
      } else if (backend && backend.gl) {
        gpuDevice = null;
        log('GPU sync: gl.finish() (WebGL) — WARNING: unreliable', 'warn');
      } else {
        log('GPU sync: double rAF fallback — WARNING: unreliable', 'warn');
      }
    } catch (e) {
      log(`GPU sync detection failed: ${e.message}`, 'warn');
    }

    hudMethod.textContent = `multi_pass (${backendName})`;
  } catch (e) {
    log(`Renderer init failed: ${e.message}`, 'err');
    hudPhase.textContent = 'ERROR';
    return;
  }

  rendererReady = true;
  try {
    renderer.render(scene, camera);
    log('Test render OK', 'ok');
  } catch (e) {
    log(`Test render failed: ${e.message}`, 'err');
  }
}

// ── GPU sync ──
async function gpuSyncAsync() {
  if (gpuDevice && gpuDevice.queue && gpuDevice.queue.onSubmittedWorkDone) {
    await gpuDevice.queue.onSubmittedWorkDone();
    return;
  }
  const backend = renderer.backend;
  if (backend && backend.gl) {
    backend.gl.finish();
    return;
  }
  await new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
}

// ── Measurement ──
function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function renderFrame() {
  return new Promise(resolve => {
    requestAnimationFrame(() => {
      renderer.render(scene, camera);
      resolve();
    });
  });
}

async function renderFrames(count) {
  for (let i = 0; i < count; i++) {
    await renderFrame();
  }
}

async function measureMultiPass(passes) {
  renderer.render(scene, camera);
  await gpuSyncAsync();
  const t0 = performance.now();
  for (let i = 0; i < passes; i++) {
    renderer.render(scene, camera);
  }
  await gpuSyncAsync();
  return (performance.now() - t0) / passes;
}

// ── Calibration ──
const MIN_PASSES_RELIABLE = 100;
const MIN_PASSES_UNRELIABLE = 200;

async function calibratePasses() {
  const hasRealSync = !!(gpuDevice && gpuDevice.queue && gpuDevice.queue.onSubmittedWorkDone);
  const targetMs = hasRealSync ? 10 : 50;
  const minPasses = hasRealSync ? MIN_PASSES_RELIABLE : MIN_PASSES_UNRELIABLE;

  log(`Calibrating (target: ${targetMs}ms, min: ${minPasses}, sync: ${hasRealSync ? 'GPU' : 'UNRELIABLE'})...`);
  applyBaseline();
  renderer.render(scene, camera);
  await gpuSyncAsync();

  let passes = 10;
  for (let attempt = 0; attempt < 8; attempt++) {
    const t0 = performance.now();
    for (let i = 0; i < passes; i++) {
      renderer.render(scene, camera);
    }
    await gpuSyncAsync();
    const elapsed = performance.now() - t0;
    log(`  ${passes} passes = ${elapsed.toFixed(1)}ms`, 'info');

    if (elapsed >= targetMs && passes >= minPasses) {
      log(`Calibrated: ${passes} passes (${elapsed.toFixed(1)}ms)`, 'ok');
      return passes;
    }
    const scale = Math.max(2, Math.ceil(targetMs / Math.max(elapsed, 0.1)));
    passes = Math.min(passes * scale, 500);
  }

  passes = Math.max(passes, minPasses);
  log(`Calibration capped at ${passes} passes`, 'warn');
  return passes;
}

// ── Benchmark state ──
const RAMP_DISCARD = 5;
let running = false;
let aborted = false;
let sessionData = null;

function applyShader(shaderDef) {
  try {
    const node = shaderDef.build();
    quadMat.colorNode = node;
    quadMat.needsUpdate = true;
    return true;
  } catch (e) {
    log(`Failed to build "${shaderDef.id}": ${e.message}`, 'err');
    return false;
  }
}

function applyBaseline() {
  quadMat.colorNode = BASELINE_NODE;
  quadMat.needsUpdate = true;
}

// ── Stats ──
function median(arr) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function computeSummary(data) {
  const byShader = {};
  for (const m of data.measurements) {
    if (m.error) continue;
    if (!byShader[m.shaderId]) {
      byShader[m.shaderId] = { shaderId: m.shaderId, label: m.shaderLabel, category: m.category, allGpuTimes: [] };
    }
    byShader[m.shaderId].allGpuTimes.push(...m.gpuTimesMs);
  }

  const results = [];
  for (const s of Object.values(byShader)) {
    const gpuSorted = [...s.allGpuTimes].sort((a, b) => a - b);
    if (gpuSorted.length === 0) continue;
    const q1 = gpuSorted[Math.floor(gpuSorted.length * 0.25)];
    const q3 = gpuSorted[Math.floor(gpuSorted.length * 0.75)];
    const iqr = q3 - q1;
    const filtered = gpuSorted.filter(v => v >= q1 - 1.5 * iqr && v <= q3 + 1.5 * iqr);
    if (filtered.length === 0) continue;
    const med = median(filtered);
    const mean = filtered.reduce((a, b) => a + b, 0) / filtered.length;
    const sd = Math.sqrt(filtered.reduce((a, b) => a + (b - mean) ** 2, 0) / filtered.length);
    const cv = mean > 0 ? (sd / mean) * 100 : 0;

    results.push({
      shaderId: s.shaderId, label: s.label, category: s.category,
      sampleCount: s.allGpuTimes.length,
      outlierCount: s.allGpuTimes.length - filtered.length,
      medianGpuMs: +med.toFixed(4), meanGpuMs: +mean.toFixed(4),
      sdGpuMs: +sd.toFixed(4), cvPercent: +cv.toFixed(2),
      q1GpuMs: +q1.toFixed(4), q3GpuMs: +q3.toFixed(4),
      minGpuMs: +filtered[0].toFixed(4), maxGpuMs: +filtered[filtered.length - 1].toFixed(4),
    });
  }

  results.sort((a, b) => b.medianGpuMs - a.medianGpuMs);
  const baseline = results.find(r => r.shaderId === 'ref_flat_color');
  const baselineCost = baseline ? baseline.medianGpuMs : 0;
  for (const r of results) {
    r.marginalCostMs = +(r.medianGpuMs - baselineCost).toFixed(4);
  }
  return { baselineCostMs: baselineCost, shaders: results };
}

// ══════════════════════════════════════════════
// ── Standard Benchmark ──
// ══════════════════════════════════════════════

async function runBenchmark() {
  if (!rendererReady) { log('Renderer not ready!', 'err'); return; }

  const loopCount = parseInt(inputLoops.value) || 2;
  const framesPerShader = parseInt(inputFrames.value) || 30;
  let multiPassCount = parseInt(inputPasses.value) || 0;

  renderer.setSize(BENCH_SIZE, BENCH_SIZE);

  const shaders = SHADER_REGISTRY;
  const totalSteps = loopCount * shaders.length;
  let currentStep = 0;
  let lastExportPct = 0;

  // Thermal warm-up (5s)
  hudPhase.textContent = 'thermal warm-up';
  log('Thermal warm-up (5s)...');
  const warmupShader = shaders.find(s => s.id === 'ref_alu_heavy') || shaders[0];
  if (applyShader(warmupShader)) {
    const warmupEnd = performance.now() + 5000;
    while (performance.now() < warmupEnd && !aborted) {
      await renderFrame();
    }
  }
  if (aborted) return;
  log('Warm-up done.', 'ok');

  if (multiPassCount === 0) {
    multiPassCount = await calibratePasses();
  } else {
    const testTime = await measureMultiPass(multiPassCount);
    log(`User pass count ${multiPassCount}: baseline = ${(testTime * multiPassCount).toFixed(1)}ms total, ${testTime.toFixed(3)}ms/pass`);
    if (testTime * multiPassCount < 2) {
      log('Warning: total time < 2ms, results may be noisy. Set passes to 0 for auto-calibration.', 'warn');
    }
  }

  sessionData = {
    mode: 'standard',
    device: navigator.userAgent,
    platform: navigator.platform || 'unknown',
    renderResolution: [BENCH_SIZE, BENCH_SIZE],
    backend: backendIsWebGL ? 'WebGL' : 'WebGPU',
    syncMethod: gpuDevice ? 'onSubmittedWorkDone' : 'gl_finish_or_rAF',
    measurementMethod: 'multi_pass_synced_steady_state',
    rampDiscardSamples: RAMP_DISCARD,
    multiPassCount,
    framesPerShader,
    loopCount,
    sessionId: new Date().toISOString().replace(/[:.]/g, '-'),
    startTime: new Date().toISOString(),
    measurements: [],
  };

  log(`Starting: ${shaders.length} shaders x ${loopCount} loops, ${multiPassCount} passes/sample, ${RAMP_DISCARD} ramp-up discarded`);

  for (let loop = 0; loop < loopCount; loop++) {
    if (aborted) break;
    const order = shuffleArray(shaders);
    hudLoop.textContent = `${loop + 1}/${loopCount}`;
    log(`--- Loop ${loop + 1}/${loopCount} (${order.length} shaders) ---`);

    for (let si = 0; si < order.length; si++) {
      if (aborted) break;
      const shader = order[si];
      currentStep++;
      progressBar.style.width = `${(currentStep / totalSteps) * 100}%`;
      hudShader.textContent = shader.label;

      hudPhase.textContent = 'compiling';
      const applied = applyShader(shader);
      if (!applied) {
        sessionData.measurements.push({
          shaderId: shader.id, shaderLabel: shader.label, category: shader.category,
          loopIndex: loop, orderInLoop: si, error: 'failed to compile',
          timestamp: new Date().toISOString(),
        });
        continue;
      }

      hudPhase.textContent = 'warmup';
      try {
        renderer.render(scene, camera);
        await gpuSyncAsync();
        for (let w = 0; w < RAMP_DISCARD; w++) {
          await measureMultiPass(multiPassCount);
        }
      } catch (e) {
        log(`Warmup failed for "${shader.id}": ${e.message}`, 'err');
        sessionData.measurements.push({
          shaderId: shader.id, shaderLabel: shader.label, category: shader.category,
          loopIndex: loop, orderInLoop: si, error: `warmup failed: ${e.message}`,
          timestamp: new Date().toISOString(),
        });
        applyBaseline();
        continue;
      }
      if (aborted) break;

      hudPhase.textContent = 'measuring';
      const gpuTimesMs = [];
      for (let f = 0; f < framesPerShader; f++) {
        if (aborted) break;
        if (f > 0 && f % 5 === 0) await new Promise(r => setTimeout(r, 0));
        try {
          const gpuTime = await measureMultiPass(multiPassCount);
          gpuTimesMs.push(gpuTime);
          hudGpu.textContent = `${gpuTime.toFixed(3)} ms`;
        } catch (e) {
          log(`Measure error on "${shader.id}" frame ${f}: ${e.message}`, 'err');
          break;
        }
      }

      if (aborted) break;

      if (gpuTimesMs.length > 0) {
        const med = median(gpuTimesMs);
        const q1 = gpuTimesMs.sort((a, b) => a - b)[Math.floor(gpuTimesMs.length * 0.25)];
        const q3 = gpuTimesMs[Math.floor(gpuTimesMs.length * 0.75)];
        sessionData.measurements.push({
          shaderId: shader.id, shaderLabel: shader.label, category: shader.category,
          loopIndex: loop, orderInLoop: si,
          gpuTimesMs, medianGpuMs: med,
          timestamp: new Date().toISOString(),
        });
        log(`  ${shader.label}: ${med.toFixed(3)}ms [${q1.toFixed(3)}–${q3.toFixed(3)}] (n=${gpuTimesMs.length})`, 'ok');
      }

      const pct = Math.floor((currentStep / totalSteps) * 100);
      if (pct >= lastExportPct + 20) {
        lastExportPct = Math.floor(pct / 20) * 20;
        exportData(`${lastExportPct}pct`);
      }

      hudPhase.textContent = 'cooldown';
      applyBaseline();
      await renderFrames(20);
    }
    log(`Loop ${loop + 1} done`);
  }

  sessionData.endTime = new Date().toISOString();
  hudPhase.textContent = 'done';
  progressBar.style.width = '100%';
  log(`Complete! ${sessionData.measurements.length} measurements.`, 'ok');
  exportData();
}

// ══════════════════════════════════════════════
// ── Resolution Sweep ──
// For each selected shader, step through resolutions and measure cost.
// Finds the max resolution that fits within each FPS target.
// ══════════════════════════════════════════════

// A-Frame scene overhead estimate — added to shader cost for total frame budget.
// Measured as the difference between A-Frame mode and quad mode baselines.
// Set to 0 if unknown; user can override via input.
const AFRAME_OVERHEAD_MS = 2.0; // conservative estimate from Mac A-Frame vs quad baseline difference

const FPS_TARGETS = [120, 90, 72];
const FPS_BUDGETS = FPS_TARGETS.map(fps => ({ fps, budgetMs: 1000 / fps }));

async function runResolutionSweep() {
  if (!rendererReady) { log('Renderer not ready!', 'err'); return; }

  const selectedIds = getSelectedShaderIds();
  if (selectedIds.length === 0) { log('No shaders selected!', 'err'); return; }

  const shaders = selectedIds.map(id => SHADER_REGISTRY.find(s => s.id === id)).filter(Boolean);
  // Always include baseline
  if (!shaders.find(s => s.id === 'ref_flat_color')) {
    const bl = SHADER_REGISTRY.find(s => s.id === 'ref_flat_color');
    if (bl) shaders.unshift(bl);
  }

  const resMin = parseInt(inputResMin.value) || 256;
  const resMax = parseInt(inputResMax.value) || 1760;
  const resStep = parseInt(inputResStep.value) || 128;
  const samplesPerShader = parseInt(inputSweepSamples.value) || 20;
  let multiPassCount = parseInt(inputSweepPasses.value) || 0;

  // Build resolution list
  const resolutions = [];
  for (let r = resMin; r <= resMax; r += resStep) {
    resolutions.push(r);
  }
  if (resolutions[resolutions.length - 1] !== resMax) {
    resolutions.push(resMax);
  }

  log(`Resolution sweep: ${shaders.length} shaders, ${resolutions.length} resolutions (${resMin}–${resMax}, step ${resStep})`);
  log(`Resolutions: ${resolutions.join(', ')}`);

  // Thermal warm-up (3s)
  hudPhase.textContent = 'thermal warm-up';
  log('Thermal warm-up (3s)...');
  renderer.setSize(resolutions[resolutions.length - 1], resolutions[resolutions.length - 1]);
  applyShader(shaders[0]);
  const warmupEnd = performance.now() + 3000;
  while (performance.now() < warmupEnd && !aborted) {
    await renderFrame();
  }
  if (aborted) return;

  // Calibrate at largest resolution
  renderer.setSize(resolutions[resolutions.length - 1], resolutions[resolutions.length - 1]);
  if (multiPassCount === 0) {
    multiPassCount = await calibratePasses();
  }

  const totalSteps = shaders.length * resolutions.length;
  let currentStep = 0;

  sessionData = {
    mode: 'resolution_sweep',
    device: navigator.userAgent,
    platform: navigator.platform || 'unknown',
    backend: backendIsWebGL ? 'WebGL' : 'WebGPU',
    syncMethod: gpuDevice ? 'onSubmittedWorkDone' : 'gl_finish_or_rAF',
    multiPassCount,
    samplesPerShader,
    rampDiscardSamples: RAMP_DISCARD,
    resolutions,
    aframeOverheadMs: AFRAME_OVERHEAD_MS,
    fpsTargets: FPS_TARGETS,
    sessionId: new Date().toISOString().replace(/[:.]/g, '-'),
    startTime: new Date().toISOString(),
    measurements: [],
    sweepResults: [],
  };

  // For each shader, sweep resolutions (low→high for early-exit potential)
  for (let si = 0; si < shaders.length; si++) {
    if (aborted) break;
    const shader = shaders[si];
    hudShader.textContent = shader.label;
    log(`--- ${shader.label} (${si + 1}/${shaders.length}) ---`);

    const shaderResult = {
      shaderId: shader.id,
      shaderLabel: shader.label,
      category: shader.category,
      resolutions: [],
      // Will be filled: maxRes120, maxRes90, maxRes72
    };

    for (let ri = 0; ri < resolutions.length; ri++) {
      if (aborted) break;
      const res = resolutions[ri];
      currentStep++;
      progressBar.style.width = `${(currentStep / totalSteps) * 100}%`;

      renderer.setSize(res, res);
      hudPhase.textContent = `${res}x${res}`;
      hudLoop.textContent = `${ri + 1}/${resolutions.length}`;

      // Apply shader
      if (!applyShader(shader)) {
        shaderResult.resolutions.push({ size: res, error: 'build failed' });
        continue;
      }

      // Warmup at this resolution
      try {
        renderer.render(scene, camera);
        await gpuSyncAsync();
        for (let w = 0; w < RAMP_DISCARD; w++) {
          await measureMultiPass(multiPassCount);
        }
      } catch (e) {
        log(`  Warmup failed at ${res}: ${e.message}`, 'err');
        shaderResult.resolutions.push({ size: res, error: `warmup: ${e.message}` });
        applyBaseline();
        continue;
      }

      // Measure
      const times = [];
      for (let s = 0; s < samplesPerShader; s++) {
        if (aborted) break;
        if (s > 0 && s % 5 === 0) await new Promise(r => setTimeout(r, 0));
        try {
          times.push(await measureMultiPass(multiPassCount));
        } catch (e) { break; }
      }

      if (times.length > 0) {
        const med = median(times);
        const withOverhead = med + AFRAME_OVERHEAD_MS;
        shaderResult.resolutions.push({
          size: res,
          medianMs: +med.toFixed(4),
          withAframeMs: +withOverhead.toFixed(4),
          samples: times.length,
        });
        hudGpu.textContent = `${med.toFixed(3)}ms (+${AFRAME_OVERHEAD_MS}ms AF = ${withOverhead.toFixed(3)}ms)`;
        log(`  ${res}x${res}: ${med.toFixed(3)}ms (+ A-Frame ${AFRAME_OVERHEAD_MS}ms = ${withOverhead.toFixed(3)}ms)`, 'ok');
      }

      // Cooldown
      applyBaseline();
      await renderFrames(5);
    }

    // Compute max resolution for each FPS target
    for (const { fps, budgetMs } of FPS_BUDGETS) {
      const validRes = shaderResult.resolutions
        .filter(r => !r.error && r.withAframeMs < budgetMs);
      const maxRes = validRes.length > 0
        ? validRes[validRes.length - 1].size
        : 0; // 0 = doesn't fit at any tested resolution
      shaderResult[`maxRes${fps}`] = maxRes;
    }

    sessionData.sweepResults.push(shaderResult);

    // Log summary for this shader
    log(`  → max@120fps: ${shaderResult.maxRes120 || 'none'}, @90fps: ${shaderResult.maxRes90 || 'none'}, @72fps: ${shaderResult.maxRes72 || 'none'}`, 'ok');
  }

  // Restore default size
  renderer.setSize(BENCH_SIZE, BENCH_SIZE);

  sessionData.endTime = new Date().toISOString();
  hudPhase.textContent = 'done';
  progressBar.style.width = '100%';

  // Log final summary table
  log('═══ RESOLUTION SWEEP RESULTS ═══', 'ok');
  log(`A-Frame overhead: ${AFRAME_OVERHEAD_MS}ms (added to shader cost)`, 'info');
  log(`Budget: 120fps=${(1000/120).toFixed(2)}ms, 90fps=${(1000/90).toFixed(2)}ms, 72fps=${(1000/72).toFixed(2)}ms`, 'info');
  for (const r of sessionData.sweepResults) {
    const costAtMax = r.resolutions[r.resolutions.length - 1];
    const topCost = costAtMax && !costAtMax.error ? `${costAtMax.withAframeMs.toFixed(2)}ms@${costAtMax.size}` : '?';
    log(`${r.shaderLabel}: 120→${r.maxRes120 || '-'} | 90→${r.maxRes90 || '-'} | 72→${r.maxRes72 || '-'} (${topCost})`, 'ok');
  }

  exportData();
}

// ── Controls ──
btnStart.addEventListener('click', async () => {
  if (running) return;
  running = true;
  aborted = false;
  btnStart.disabled = true;
  btnStop.disabled = false;

  try {
    if (inputMode.value === 'sweep') {
      await runResolutionSweep();
    } else {
      await runBenchmark();
    }
  } catch (e) {
    log(`Benchmark error: ${e.message}`, 'err');
    console.error(e);
  }

  running = false;
  btnStart.disabled = false;
  btnStop.disabled = true;
});

btnStop.addEventListener('click', () => {
  aborted = true;
  log('Aborted by user', 'err');
});

function exportData(tag = 'final') {
  if (!sessionData || (sessionData.measurements?.length === 0 && sessionData.sweepResults?.length === 0)) {
    log('No data to export', 'err');
    return;
  }
  const out = sessionData.mode === 'standard'
    ? { ...sessionData, summary: computeSummary(sessionData) }
    : { ...sessionData };
  const json = JSON.stringify(out, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `shaderface-${sessionData.mode}-${sessionData.sessionId}-${tag}.json`;
  a.click();
  URL.revokeObjectURL(url);
  log(`Exported [${tag}]`, 'ok');
}

btnExport.addEventListener('click', exportData);

// ── Init ──
log('ShaderFace loading...');
initRenderer().then(() => {
  if (!rendererReady) {
    log('Failed to initialize any renderer', 'err');
    return;
  }
  buildShaderPicker();
  log(`Registry: ${SHADER_REGISTRY.length} shaders`);
  log(`  ${SHADER_REGISTRY.filter(s => s.category === 'reference').length} reference, ${SHADER_REGISTRY.filter(s => s.category === 'atomic').length} atomic, ${SHADER_REGISTRY.filter(s => s.category === 'texture').length} texture`);
  log('Ready — select mode and press Start', 'ok');
}).catch(e => {
  log(`Init failed: ${e.message}`, 'err');
  console.error(e);
});
