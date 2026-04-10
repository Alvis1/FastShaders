// ShaderSphere v3 — A-Frame Pipeline Benchmark (points-based)
// Full coverage at Quest 3 per-eye resolution. rAF-to-rAF frame deltas.
// 100 points = 120 fps (8.33 ms). Display-bound at low GPU load.

import {
  computeStats, downloadJSON,
  buildShaderPicker, getSelectedIds, pickerAll, pickerNone,
  saveSettings, loadSettings,
} from './stats.js';

const TEXTURE_NAMES = [
  'caustics','circleDecor','cork','turbulentSmoke','dalmatianSpots',
  'protozoa','reticularVeins','planet','crumpledFabric','rust',
  'romanPaving','wood','entangled','runnyEggs','gasGiant','bricks',
  'watermelon','neonLights','voronoiCells','marble','clouds','satin',
  'photosphere','polkaDots','karstRock','dysonSphere','caveArt',
  'camouflage','scream','darthMaul','fordite','processedWood','brain',
  'tigerFur','scepterHead','stars','isolayers','perlinNoise','isolines',
  'circles','staticNoise',
];

// Quest 3 per-eye resolution
const Q3_WIDTH = 2064;
const Q3_HEIGHT = 2208;

const CONFIG = { fov: 30, sphereRadius: 1, sphereZ: -5, duration: 3000, warmupFrames: 10, rotationSpeed: 0.5, fullCoverageScale: 2.5 };
const $ = id => document.getElementById(id);

// ── DOM ─────────────────────────────────────────────────────────────────────
const hudShader = $('hud-shader'), hudFt = $('hud-ft'), hudPts = $('hud-pts');
const hudProgress = $('hud-progress'), hudPhase = $('hud-phase');
const progressBar = $('progress-bar'), logPanel = $('log');
const btnStart = $('btn-start'), btnStop = $('btn-stop');

function log(msg, cls = 'info') {
  const d = document.createElement('div'); d.className = cls;
  d.textContent = `[${new Date().toISOString().slice(11,23)}] ${msg}`;
  logPanel.appendChild(d); logPanel.scrollTop = logPanel.scrollHeight;
  console.log(`[SS-AF] ${msg}`);
}

function nextFrame() { return new Promise(r => requestAnimationFrame(r)); }

// ── Shader registry from IIFE globals ───────────────────────────────────────

function buildShaderRegistry() {
  const TSL = THREE.TSL, TEX = window.tslTextures;
  if (!TSL || !TEX) { log('THREE.TSL or tslTextures missing', 'err'); return []; }
  const shaders = [
    { id: 'ref_flat_color', label: 'Flat Color (baseline)', category: 'reference', build: () => TSL.color(0x888888) },
    { id: 'atom_voronoi', label: 'Voronoi (mx)', category: 'atomic', build: () => TSL.vec3(TSL.mx_worley_noise_float(TSL.positionGeometry.mul(4))) },
  ];
  for (const name of TEXTURE_NAMES) {
    if (!TEX[name]) continue;
    const fn = TEX[name];
    shaders.push({ id: `tex_${name}`, label: name, category: 'texture',
      build: () => { try { return fn(); } catch (e) { return TSL.color(0xff00ff); } } });
  }
  return shaders;
}

// ── A-Frame setup ───────────────────────────────────────────────────────────

let sceneEl, renderer, threeCamera, sphereObj, sphereMesh = null;
let gpuInfo = 'unknown', renderSubmitTime = 0;
let running = false, idleRAF = 0, results = [], SHADERS = [];

async function initFromAFrame() {
  sceneEl = $('scene');
  await new Promise(r => { if (sceneEl.hasLoaded) r(); else sceneEl.addEventListener('loaded', r); });
  log('A-Frame loaded', 'ok');

  renderer = sceneEl.renderer;
  threeCamera = $('camera').getObject3D('camera');
  threeCamera.fov = CONFIG.fov; threeCamera.updateProjectionMatrix();

  $('bench-sphere').removeAttribute('material');
  sphereObj = $('bench-sphere').object3D;
  sphereObj.position.set(0, 0, CONFIG.sphereZ); sphereObj.scale.setScalar(0.5);

  const obj = $('bench-sphere').getObject3D('mesh');
  if (obj) obj.traverse(c => { if (c.isMesh) sphereMesh = c; });

  // Hook renderer.render to capture CPU-side submission time
  const origRender = renderer.render.bind(renderer);
  renderer.render = function (...args) {
    const t0 = performance.now();
    origRender(...args);
    renderSubmitTime = performance.now() - t0;
  };

  try { if (navigator.gpu) { const a = await navigator.gpu.requestAdapter(); const i = a?.info; gpuInfo = [i?.vendor, i?.architecture, i?.device, i?.description].filter(Boolean).join(' / ') || 'unknown'; } } catch (_) {}
  log(`GPU: ${gpuInfo}`, 'ok');
  log(`Benchmark resolution: ${Q3_WIDTH}×${Q3_HEIGHT} (Quest 3 per-eye)`, 'ok');

  applyMaterial(THREE.TSL.color(0x888888));
  log('Ready', 'ok');
}

let currentMat = null;
function applyMaterial(colorNode) {
  if (!sphereMesh) return;
  if (currentMat) currentMat.dispose();
  currentMat = new THREE.MeshPhysicalNodeMaterial();
  currentMat.colorNode = colorNode;
  currentMat.needsUpdate = true;
  sphereMesh.material = currentMat;
}

// ── Benchmark ───────────────────────────────────────────────────────────────

async function benchmark() {
  renderer.setSize(Q3_WIDTH, Q3_HEIGHT, false); renderer.setPixelRatio(1);
  sphereObj.scale.setScalar(CONFIG.fullCoverageScale);

  // Warmup
  for (let i = 0; i < CONFIG.warmupFrames; i++) await nextFrame();

  const frames = [];
  const start = performance.now();
  let prev = performance.now();
  let rotY = 0, rotX = 0;

  while (performance.now() - start < CONFIG.duration) {
    if (!running) return null;
    rotY += CONFIG.rotationSpeed * 0.016; rotX += CONFIG.rotationSpeed * 0.008;
    sphereObj.rotation.y = rotY; sphereObj.rotation.x = rotX;

    await nextFrame();
    const now = performance.now();
    const delta = now - prev;
    prev = now;

    frames.push({
      t: +(now - start).toFixed(1),
      frameTime: +delta.toFixed(3),
      renderTime: +renderSubmitTime.toFixed(3),
    });
    hudFt.textContent = delta.toFixed(2) + 'ms';
  }
  return frames;
}

async function runBenchmark() {
  running = true; results = [];
  btnStart.disabled = true; btnStop.disabled = false;
  cancelAnimationFrame(idleRAF);

  // Block A-Frame's resize handler during benchmark
  const origResize = sceneEl.resize.bind(sceneEl);
  sceneEl.resize = () => {};

  CONFIG.duration = (+$('input-duration').value || 8) * 1000;
  CONFIG.warmupFrames = +$('input-warmup').value || 10;
  const shaderIds = getSelectedIds($('pick-list'));
  const shaders = SHADERS.filter(s => shaderIds.includes(s.id));

  log(`Benchmarking ${shaders.length} shaders @ ${Q3_WIDTH}×${Q3_HEIGHT}`);

  for (let si = 0; si < shaders.length; si++) {
    if (!running) break;
    const shader = shaders[si];
    hudShader.textContent = shader.label;
    hudProgress.textContent = `${si + 1}/${shaders.length}`;
    progressBar.style.width = `${((si + 1) / shaders.length * 100).toFixed(1)}%`;

    sphereObj.scale.setScalar(0.001);
    try { applyMaterial(shader.build()); } catch (e) { log(`FAIL ${shader.label}: ${e.message}`, 'err'); continue; }

    log(`[${si + 1}/${shaders.length}] ${shader.label}...`);
    const frames = await benchmark();
    if (!frames) continue;

    const stats = computeStats(frames);
    hudPts.textContent = stats.points;
    const thinFrames = frames.filter((_, i) => i % 4 === 0);
    results.push({ id: shader.id, label: shader.label, category: shader.category, stats, frames: thinFrames });
    log(`  → ${stats.points} pts | ${stats.medianFt}ms | ${stats.avgFps} fps`, 'ok');
  }

  // Restore
  sceneEl.resize = origResize;
  renderer.setSize(window.innerWidth, window.innerHeight);
  threeCamera.aspect = window.innerWidth / window.innerHeight; threeCamera.updateProjectionMatrix();
  applyMaterial(THREE.TSL.color(0x888888)); sphereObj.scale.setScalar(0.5);

  progressBar.style.width = '100%'; hudPhase.textContent = 'done';
  log(`Complete: ${results.length} shaders`, 'ok');
  running = false; btnStart.disabled = false; btnStop.disabled = true;
  exportResults(); startIdle();
}

function exportResults() {
  downloadJSON({
    metadata: {
      tool: 'ShaderSphere v3', mode: 'aframe-pipeline', material: 'MeshPhysicalNodeMaterial',
      resolution: { width: Q3_WIDTH, height: Q3_HEIGHT, label: 'Quest 3 per-eye' },
      date: new Date().toISOString(), userAgent: navigator.userAgent, gpu: gpuInfo,
      config: { duration: CONFIG.duration, warmupFrames: CONFIG.warmupFrames },
      renderer: { antialias: true, highRefreshRate: true, colorManagement: true, foveationLevel: 0, alpha: false },
      notes: 'Full-coverage A-Frame pipeline benchmark at Quest 3 per-eye resolution. 100 points = 120 fps (8.33 ms). frameTime = rAF delta. Display-bound at low GPU load.',
    },
    shaders: results,
  }, 'shadersphere-aframe');
  log('Exported', 'ok');
}

function startIdle() {
  function tick() { if (!running) { sphereObj.rotation.y += .003; sphereObj.rotation.x += .001; } idleRAF = requestAnimationFrame(tick); }
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

(async () => {
  try {
    log('Waiting for A-Frame...');
    await initFromAFrame();
    SHADERS = buildShaderRegistry();
    log(`${SHADERS.length} shaders`, 'ok');
    buildShaderPicker(SHADERS, $('pick-list'));
    loadSettings();
    $('input-duration').addEventListener('change', saveSettings);
    $('input-warmup').addEventListener('change', saveSettings);
    btnStart.disabled = false; hudPhase.textContent = 'idle';
    startIdle();
  } catch (e) { log(`Init failed: ${e.message}`, 'err'); console.error(e); }
})();
