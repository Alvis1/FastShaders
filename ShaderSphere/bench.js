// ShaderSphere v3 — Three.js TSL Benchmark (points-based)
// Full coverage at Quest 3 per-eye resolution. GPU-synced timing.
// 100 points = 120 fps (8.33 ms).

import {
  WebGPURenderer, Scene, PerspectiveCamera,
  SphereGeometry, Mesh, MeshPhysicalNodeMaterial, Color,
  AmbientLight, DirectionalLight,
} from 'three';
import { color as tslColor } from 'three/tsl';
import { SHADER_REGISTRY } from './shaderRegistry.js';
import {
  computeStats, downloadJSON,
  buildShaderPicker, getSelectedIds, pickerAll, pickerNone,
  saveSettings, loadSettings,
} from './stats.js';

// Quest 3 per-eye resolution
const Q3_WIDTH = 2064;
const Q3_HEIGHT = 2208;

const CONFIG = { fov: 30, sphereRadius: 1, sphereZ: -5, duration: 3000, warmupFrames: 10, rotationSpeed: 0.5, fullCoverageScale: 2.0 };
const $ = id => document.getElementById(id);

// ── DOM ─────────────────────────────────────────────────────────────────────
const canvas = $('canvas'), hudShader = $('hud-shader');
const hudFt = $('hud-ft'), hudPts = $('hud-pts');
const hudProgress = $('hud-progress'), hudPhase = $('hud-phase');
const progressBar = $('progress-bar'), logPanel = $('log');
const btnStart = $('btn-start'), btnStop = $('btn-stop');

function log(msg, cls = 'info') {
  const d = document.createElement('div'); d.className = cls;
  d.textContent = `[${new Date().toISOString().slice(11,23)}] ${msg}`;
  logPanel.appendChild(d); logPanel.scrollTop = logPanel.scrollHeight;
  console.log(`[SS-TSL] ${msg}`);
}

// ── Renderer ────────────────────────────────────────────────────────────────
let renderer, gpuDevice, gpuInfo = 'unknown', running = false, idleRAF = 0, results = [];

const scene = new Scene(); scene.background = new Color(0x111118);
const camera = new PerspectiveCamera(CONFIG.fov, 1, 0.1, 100);
camera.position.set(0, 0, 0); camera.lookAt(0, 0, -1);

scene.add(new AmbientLight(0xffffff, 0.4));
const dirLight = new DirectionalLight(0xffffff, 0.8);
dirLight.position.set(2, 3, 1); scene.add(dirLight);

const sphereGeo = new SphereGeometry(CONFIG.sphereRadius, 64, 64);
const baseMat = new MeshPhysicalNodeMaterial(); baseMat.colorNode = tslColor(0x888888);
const sphere = new Mesh(sphereGeo, baseMat);
sphere.position.set(0, 0, CONFIG.sphereZ); sphere.scale.setScalar(0.5); scene.add(sphere);

async function initRenderer() {
  log('Initializing WebGPU renderer...');
  renderer = new WebGPURenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(1);
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix();
  await renderer.init();
  const backend = renderer.backend;
  if (backend?.device) { gpuDevice = backend.device; log('GPU sync: onSubmittedWorkDone', 'ok'); }
  else if (backend?.gl) log('GPU sync: gl.finish (fallback)', 'warn');
  try { if (navigator.gpu) { const a = await navigator.gpu.requestAdapter(); const i = a?.info; gpuInfo = [i?.vendor,i?.architecture,i?.device,i?.description].filter(Boolean).join(' / ') || 'unknown'; } } catch (_) {}
  log(`GPU: ${gpuInfo}`, 'ok');
  log(`Benchmark resolution: ${Q3_WIDTH}×${Q3_HEIGHT} (Quest 3 per-eye)`, 'ok');
  renderer.render(scene, camera); log('Ready', 'ok');
}

async function gpuSync() {
  if (gpuDevice?.queue?.onSubmittedWorkDone) { await gpuDevice.queue.onSubmittedWorkDone(); return; }
  if (renderer.backend?.gl) { renderer.backend.gl.finish(); return; }
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
}

// ── Benchmark ───────────────────────────────────────────────────────────────

async function benchmark() {
  renderer.setSize(Q3_WIDTH, Q3_HEIGHT, false);
  camera.aspect = Q3_WIDTH / Q3_HEIGHT; camera.updateProjectionMatrix();
  sphere.scale.setScalar(CONFIG.fullCoverageScale);

  // Warmup
  for (let i = 0; i < CONFIG.warmupFrames; i++) { renderer.render(scene, camera); await gpuSync(); }

  const frames = [];
  const start = performance.now();
  let rotY = 0, rotX = 0;
  let frameIdx = 0;

  while (performance.now() - start < CONFIG.duration) {
    if (!running) return null;
    rotY += CONFIG.rotationSpeed * 0.016; rotX += CONFIG.rotationSpeed * 0.008;
    sphere.rotation.y = rotY; sphere.rotation.x = rotX;

    const t0 = performance.now();
    renderer.render(scene, camera);
    await gpuSync();
    const ft = performance.now() - t0;

    // Record every frame for accurate stats
    frames.push({ t: +(performance.now() - start).toFixed(1), frameTime: +ft.toFixed(3) });
    hudFt.textContent = ft.toFixed(2) + 'ms';
    frameIdx++;

    await new Promise(r => setTimeout(r, 0));
  }
  return frames;
}

async function runBenchmark() {
  running = true; results = [];
  btnStart.disabled = true; btnStop.disabled = false;
  cancelAnimationFrame(idleRAF);

  CONFIG.duration = (+$('input-duration').value || 8) * 1000;
  CONFIG.warmupFrames = +$('input-warmup').value || 10;
  const shaderIds = getSelectedIds($('pick-list'));
  const shaders = SHADER_REGISTRY.filter(s => shaderIds.includes(s.id));

  log(`Benchmarking ${shaders.length} shaders @ ${Q3_WIDTH}×${Q3_HEIGHT}`);

  for (let si = 0; si < shaders.length; si++) {
    if (!running) break;
    const shader = shaders[si];
    hudShader.textContent = shader.label;
    hudProgress.textContent = `${si + 1}/${shaders.length}`;
    progressBar.style.width = `${((si + 1) / shaders.length * 100).toFixed(1)}%`;

    // Swap material at tiny scale (invisible during swap)
    sphere.scale.setScalar(0.001);
    const mat = new MeshPhysicalNodeMaterial();
    try { mat.colorNode = shader.build(); } catch (e) { log(`FAIL ${shader.label}: ${e.message}`, 'err'); continue; }
    sphere.material = mat;

    log(`[${si + 1}/${shaders.length}] ${shader.label}...`);
    const frames = await benchmark();
    if (!frames) { mat.dispose(); continue; }

    const stats = computeStats(frames);
    hudPts.textContent = stats.points;
    // Thin frames for export (every 4th) — stats already computed from full data
    const thinFrames = frames.filter((_, i) => i % 4 === 0);
    results.push({ id: shader.id, label: shader.label, category: shader.category, stats, frames: thinFrames });
    log(`  → ${stats.points} pts | ${stats.medianFt}ms | ${stats.avgFps} fps`, 'ok');

    mat.dispose();
  }

  // Restore display size
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix();
  sphere.material = baseMat; sphere.scale.setScalar(0.5);

  progressBar.style.width = '100%'; hudPhase.textContent = 'done';
  log(`Complete: ${results.length} shaders`, 'ok');
  running = false; btnStart.disabled = false; btnStop.disabled = true;
  exportResults(); startIdle();
}

function exportResults() {
  downloadJSON({
    metadata: {
      tool: 'ShaderSphere v3', mode: 'tsl', material: 'MeshPhysicalNodeMaterial',
      resolution: { width: Q3_WIDTH, height: Q3_HEIGHT, label: 'Quest 3 per-eye' },
      date: new Date().toISOString(), userAgent: navigator.userAgent, gpu: gpuInfo,
      config: { duration: CONFIG.duration, warmupFrames: CONFIG.warmupFrames },
      notes: 'Full-coverage benchmark at Quest 3 per-eye resolution. 100 points = 120 fps (8.33 ms). GPU-synced timing.',
    },
    shaders: results,
  }, 'shadersphere-tsl');
  log('Exported', 'ok');
}

function startIdle() {
  function tick() { if (!running) { sphere.rotation.y += .003; sphere.rotation.x += .001; renderer.render(scene, camera); } idleRAF = requestAnimationFrame(tick); }
  tick();
}

// ── Events ──────────────────────────────────────────────────────────────────
btnStart.addEventListener('click', runBenchmark);
btnStop.addEventListener('click', () => { running = false; });
$('btn-export').addEventListener('click', exportResults);
$('btn-log').addEventListener('click', () => logPanel.classList.toggle('visible'));
$('btn-shaders').addEventListener('click', () => $('shader-picker').classList.toggle('visible'));
$('pick-all').addEventListener('click', () => pickerAll($('pick-list')));
$('pick-none').addEventListener('click', () => pickerNone($('pick-list')));
window.addEventListener('resize', () => {
  if (renderer && !running) {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix();
  }
});

(async () => {
  try {
    buildShaderPicker(SHADER_REGISTRY, $('pick-list'));
    loadSettings();
    $('input-duration').addEventListener('change', saveSettings);
    $('input-warmup').addEventListener('change', saveSettings);
    log(`${SHADER_REGISTRY.length} shaders`);
    await initRenderer(); startIdle();
  } catch (e) { log(`Init failed: ${e.message}`, 'err'); console.error(e); }
})();
