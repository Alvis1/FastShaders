/* Sphere InOut — immersive WebXR benchmark.
 *
 * Closes the gap the paper § 5.2 calls out: Meta Quest 3 measurements ran
 * in non-immersive mode, missing the stereoscopic fragment doubling (up to
 * ~2× at the foveal centre). This bench enters an actual XR session before
 * cycling shaders so the recorded frametimes reflect on-device immersive
 * rendering, with foveation and multiview applied by the platform.
 *
 * NO auto-start. Everything is gated on the centred "Start" button. The
 * sphere remains static at the baseline until the user clicks Start, at
 * which point the bench:
 *   1. captures the (auto-detected or user-overridden) headset name into
 *      metadata,
 *   2. awaits scene.enterVR() — Three.js' WebXR session start,
 *   3. begins shader playlist with the existing sphere-mover ping-pong,
 *   4. on the last cycle-complete, exits VR and shows the results popup.
 *
 * Backend is A-Frame's WebGLRenderer (selected automatically from the
 * IIFE bundle). The Three.js WebGPU XR path is not stable on Quest 3
 * Browser today — see carousel.html notes.
 *
 * Frame timing: we register a one-shot A-Frame component on the scene
 * that captures `tick(time, deltaTime)`. A-Frame fires this every render
 * — both in WebGL rAF and during an XR session via `xr.setAnimationLoop`
 * — so the same code path captures both flat and immersive frametimes. */

/* global AFRAME, THREE */

import { buildBenchRegistry } from '../lib/bench-registry.js';
import {
  computeStats, annotateMarginalCost, exportResults, detectVsyncClamping,
} from '../lib/bench-stats.js';
import {
  makeLogger, buildPicker, getSelectedIds, wireSettings, readSetting,
  createStartGate, showDonePopup, installErrorOverlay,
  detectHeadset, diagnoseXR,
} from '../lib/bench-ui.js';

installErrorOverlay();
const log = makeLogger('SC-inout');

const DEFAULTS = {
  'input-cycle':     10,   // seconds per shader (one full ping-pong)
  'input-warmup-ms': 200,  // discard frames right after a shader swap
  'input-stride':    1,    // capture every Nth frame past warmup
};

// Range clamps for the settings inputs (readSetting). A zero/negative
// cycle would make sphere-mover's t never reach 1 — the cycle-complete
// event never fires and the bench hangs forever.
const LIMITS = {
  cycle:    { min: 2, max: 120 },
  warmupMs: { min: 0, max: 5000 },
  stride:   { min: 1, max: 100 },
};

const SETTINGS_KEY = 'shadercarousel:inout:settings';
const PICKER_KEY = 'shadercarousel:inout:picker';
const DEFAULT_GROUPS = new Set(['baseline', 'preset', 'noise']);

// Look up an element by id in the iframe document, falling back to the
// parent document if missing. The ShaderCarousel launcher re-parents
// #hud / #controls / #shader-picker / #log into its sidebar on the
// iframe's `load` event — so once a click handler fires (after `load`),
// `iframe.document.getElementById('btn-start')` returns null because the
// node now lives in the launcher's document. Same-origin (the launcher
// and benches are both under /ShaderCarousel/) makes the parent lookup
// safe. Outside the launcher (window.parent === window) we skip it.
const $ = id => {
  const el = document.getElementById(id);
  if (el) return el;
  if (window.parent !== window) {
    try { return window.parent.document.getElementById(id); } catch { /* cross-origin */ }
  }
  return null;
};

let sceneEl, renderer, sphereObj, sphereMesh = null;
let registry = null;
let running = false;
let cancel = false;
let headsetName = 'unknown';
let gpuInfo = 'unknown';
let gateApi = null;
// Tick distribution — a tiny pub/sub the bench-tick component pushes into.
const tickSubs = new Set();

// ── A-Frame init ────────────────────────────────────────────────────────────

// Register a component on the scene that forwards (time, deltaTime) to any
// listeners in `tickSubs`. This is the XR-safe way to read frame deltas:
// A-Frame routes tick through whichever animation loop is active (window
// rAF flat, or xr.setAnimationLoop in-headset), so the same hook works
// both before and after entering VR.
if (!AFRAME.components['bench-tick']) {
  AFRAME.registerComponent('bench-tick', {
    tick: function (time, deltaTime) {
      for (const fn of tickSubs) fn(time, deltaTime);
    },
  });
}

async function initFromAFrame() {
  sceneEl = $('scene');
  await new Promise(r => {
    if (sceneEl.hasLoaded) r();
    else sceneEl.addEventListener('loaded', r, { once: true });
  });
  log('A-Frame loaded', 'ok');

  // Attach the tick relay to the scene exactly once.
  if (!sceneEl.components['bench-tick']) {
    sceneEl.setAttribute('bench-tick', '');
  }

  renderer = sceneEl.renderer;

  // Strip the placeholder material and capture the mesh so we can swap
  // its TSL colorNode directly (faster than going through tsl-shader).
  const sphereEl = $('sphere');
  sphereEl.removeAttribute('material');
  sphereObj = sphereEl.object3D;
  const obj = sphereEl.getObject3D('mesh');
  if (obj) obj.traverse(c => { if (c.isMesh) sphereMesh = c; });
  if (!sphereMesh) throw new Error('sphere mesh not found');

  // Park at baseline.
  registry = buildBenchRegistry(THREE.TSL);
  applyMaterial(registry[0].build());

  // GPU adapter info (best-effort). The index.html guard hides
  // navigator.gpu to force the WebGL2 XR backend, stashing the real one on
  // window.__benchGpu — so prefer that for the (richer) WebGPU adapter
  // string, and fall back to the WebGL unmasked-renderer extension.
  try {
    const gpu = window.__benchGpu || navigator.gpu;
    if (gpu) {
      const a = await gpu.requestAdapter();
      const i = a?.info;
      gpuInfo = [i?.vendor, i?.architecture, i?.device, i?.description]
        .filter(Boolean).join(' / ') || 'unknown';
    }
    if (gpuInfo === 'unknown') {
      const gl = renderer.getContext?.();
      const dbg = gl?.getExtension?.('WEBGL_debug_renderer_info');
      if (dbg) gpuInfo = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || 'unknown';
    }
  } catch { /* ignore */ }
  log(`GPU: ${gpuInfo}`, 'ok');

  log('Ready — press Start to enter VR', 'ok');
}

let currentMat = null;
function applyMaterial(colorNode) {
  if (!sphereMesh) return;
  if (currentMat) currentMat.dispose();
  currentMat = new THREE.MeshPhysicalNodeMaterial();
  currentMat.side = THREE.BackSide;
  currentMat.colorNode = colorNode;
  currentMat.needsUpdate = true;
  sphereMesh.material = currentMat;
}

// ── XR entry / exit ─────────────────────────────────────────────────────────

async function enterVR() {
  if (!sceneEl) return false;
  if (sceneEl.is && sceneEl.is('vr-mode')) return true;
  try {
    await sceneEl.enterVR();
    $('hud-xr').textContent = 'yes';
    log('Entered immersive VR session', 'ok');
    return true;
  } catch (e) {
    log(`enterVR failed: ${e.message}`, 'err');
    return false;
  }
}

async function exitVR() {
  if (!sceneEl) return;
  try {
    if (sceneEl.is && sceneEl.is('vr-mode')) await sceneEl.exitVR();
    $('hud-xr').textContent = 'no';
    log('Exited VR session', 'ok');
  } catch (e) {
    log(`exitVR error: ${e.message}`, 'warn');
  }
}

// ── Cycle a single shader (driven by sphere-mover + bench-tick) ────────────

function cycleOnce(shaderDef, cfg) {
  return new Promise((resolve) => {
    const sphereEl = $('sphere');

    // Apply shader at scale=0 so the compile/upload spike isn't visible.
    sphereObj.scale.setScalar(0);
    try { applyMaterial(shaderDef.build()); }
    catch (e) {
      log(`FAIL ${shaderDef.label}: ${e.message}`, 'err');
      resolve(null);
      return;
    }

    // Re-configure sphere-mover duration before kicking the cycle.
    sphereEl.setAttribute(
      'sphere-mover',
      `duration: ${cfg.cycleMs}; startZ: -10; centerZ: 0; autostart: false`,
    );

    const frames = [];
    let prevTime = null;
    let cycleStart = performance.now();
    let frameIdx = 0;
    let done = false;

    function onTick(time, deltaTime) {
      if (done) return;
      if (cancel) { cleanup(); resolve(frames); return; }
      const now = performance.now();
      const delta = prevTime != null ? now - prevTime : deltaTime;
      prevTime = now;
      const elapsed = now - cycleStart;

      // Drop frames inside the warmup window (compile + texture upload spikes)
      if (elapsed < cfg.warmupMs) return;

      frameIdx++;
      if (frameIdx % cfg.stride !== 0) return;

      const z = sphereObj.position.z;
      frames.push({
        t: +elapsed.toFixed(1),
        frameTime: +delta.toFixed(3),
        fps: delta > 0 ? +(1000 / delta).toFixed(2) : 0,
        z: +z.toFixed(2),
      });
      $('hud-ft').textContent = delta.toFixed(2) + ' ms';
    }

    function onComplete() {
      done = true;
      cleanup();
      resolve(frames);
    }

    function cleanup() {
      tickSubs.delete(onTick);
      sphereEl.removeEventListener('cycle-complete', onComplete);
    }

    sphereEl.addEventListener('cycle-complete', onComplete, { once: true });
    tickSubs.add(onTick);
    cycleStart = performance.now();
    sphereEl.emit('start-cycle', null, false);
  });
}

// ── Main run ───────────────────────────────────────────────────────────────

async function runBenchmark() {
  if (running) return;
  running = true; cancel = false;
  $('btn-start').disabled = true; $('btn-stop').disabled = false;

  const cfg = {
    cycleMs:  readSetting('input-cycle', DEFAULTS['input-cycle'], LIMITS.cycle) * 1000,
    warmupMs: readSetting('input-warmup-ms', DEFAULTS['input-warmup-ms'], LIMITS.warmupMs),
    stride:   readSetting('input-stride', DEFAULTS['input-stride'], LIMITS.stride),
  };

  // try/finally so an exception mid-run can't leave running=true — the
  // `if (running) return` guard above would otherwise brick Start until
  // a page reload.
  let xrSucceeded = false;
  const results = [];
  try {
    // Enter VR before measurement so timings reflect the immersive path.
    const xr = await diagnoseXR();
    if (xr.ok) {
      const ok = await enterVR();
      if (ok) xrSucceeded = true;
      else log('Continuing in non-immersive fallback', 'warn');
    } else {
      log(`WebXR unavailable (${xr.reason}): ${xr.detail}`, 'warn');
      log('Running flat — frametimes will not reflect stereoscopic cost', 'warn');
    }

    // Honour the user's selection — baseline defaults on but is toggleable.
    // If unticked, marginal-cost columns are null in the export and the
    // suggestion file is marked invalid (baseline-missing).
    const selectedIds = new Set(getSelectedIds(refs.pickList));
    const shaders = registry.filter(s => selectedIds.has(s.id) && !s.disabled);
    // If selected, baseline runs first so subsequent shaders can subtract.
    shaders.sort((a, b) => (a.id === 'ref_baseline' ? -1 : b.id === 'ref_baseline' ? 1 : 0));

    log(`Running ${shaders.length} shaders, ${cfg.cycleMs}ms per cycle`);

    for (let i = 0; i < shaders.length; i++) {
      if (cancel) break;
      const s = shaders[i];
      $('hud-shader').textContent = s.label;
      $('hud-progress').textContent = `${i + 1}/${shaders.length}`;
      $('progress-bar').style.width = `${((i + 1) / shaders.length * 100).toFixed(1)}%`;
      $('hud-phase').textContent = 'measuring';
      log(`[${i + 1}/${shaders.length}] ${s.label}…`);

      const frames = await cycleOnce(s, cfg);
      if (!frames || frames.length < 2) {
        if (frames) log(`  skipped ${s.label}: only ${frames.length} frame(s) — need ≥2`, 'warn');
        continue;
      }
      const stats = computeStats(frames);
      $('hud-fps').textContent = stats.avgFps;
      results.push({ id: s.id, label: s.label, category: s.category, stats, frames });
      log(`  → ${stats.medianFt} ms | ${stats.avgFps} fps | drift ${stats.thermalDrift}`, 'ok');
    }
  } finally {
    await exitVR();
    $('hud-phase').textContent = 'done';
    $('progress-bar').style.width = '100%';
    log(`Complete: ${results.length} shaders`, 'ok');
    running = false; cancel = false;
    $('btn-start').disabled = false; $('btn-stop').disabled = true;
  }

  showResultsPopup(results, cfg, xrSucceeded);
}

function showResultsPopup(results, cfg, xrSucceeded) {
  // Shared annotator (idempotent — exportResults runs it again). No
  // resolution is passed: the headset's real eye-buffer size is unknown
  // here, so marginal points stay UN-normalized and the suggestion file
  // is marked invalid (resolution-unknown + raf-delta) — InOut data is
  // for budget-fit checks and flat↔immersive ratios, not node pricing.
  annotateMarginalCost(results, {});
  const rows = results.map(r => ({
    label: r.label,
    medianMs: r.stats.medianFt,
    marginalMs: r.stats.marginalMs,
    points: r.stats.points,
  }));

  // Vsync-clamp detection — most common failure mode for this bench when
  // run outside an XR session. Wording is different depending on whether
  // we even tried to enter XR: in-XR + clamped means "shaders all fit the
  // headset's budget"; flat + clamped means "the bench produced garbage".
  const vsync = detectVsyncClamping(results);
  let warningHtml = null;
  if (vsync) {
    if (xrSucceeded) {
      log(`All shaders pinned to XR refresh (${vsync.hz} Hz / ${vsync.periodMs} ms ±${vsync.spreadMs} ms). Shaders fit budget — bench can't distinguish them.`, 'warn');
      warningHtml = `<strong>Headset hit refresh ceiling (${vsync.hz} Hz, ${vsync.periodMs} ms).</strong> Every measured shader took ${vsync.avgMs} ms ±${vsync.spreadMs} ms — they all fit the per-frame budget, but the bench can't distinguish their <em>relative</em> costs because there was no display-port pressure to expose differences. <br><br>For per-shader ranking on this headset, run heavier shaders (presets), drop the cycle duration so the shader runs while the sphere is at maximum coverage longer, or use <strong>Sphere Static</strong> for fence-synced relative cost on desktop.`;
    } else {
      log(`Vsync clamping detected: ${vsync.hz} Hz / ${vsync.periodMs} ms — these frametimes reflect display refresh, not shader cost`, 'err');
      warningHtml = `<strong>⚠ Vsync clamping detected (${vsync.hz} Hz, ${vsync.periodMs} ms).</strong> All ${vsync.shaderCount} measured shaders collapsed to ${vsync.avgMs} ms ±${vsync.spreadMs} ms — that's your monitor's refresh interval, not shader cost. <br><br>You were <strong>not</strong> in an XR session; rAF was pinned to display vsync and the bench cannot resolve any shader below ${vsync.periodMs} ms per frame. The exported file's frametimes are unusable for shader ranking. <br><br>For desktop measurement of the same corpus, use <strong>Sphere Static</strong> (multi-pass WebGPU fence sync defeats vsync). For true on-device immersive numbers, open this page in the Meta Quest Browser via the HTTPS deploy URL.`;
    }
  }

  const payload = {
    metadata: {
      schemaVersion: 2,
      bench: 'inout',
      tool: 'ShaderCarousel — Sphere InOut',
      mode: 'immersive-webxr',
      xrEntered: xrSucceeded,
      timingMethod: 'raf-delta',
      stereo: xrSucceeded,
      clockPinned: null,
      date: new Date().toISOString(),
      userAgent: navigator.userAgent,
      headset: headsetName,
      gpu: gpuInfo,
      config: cfg,
      vsyncClamping: vsync,                  // null when the data is clean
      warnings: vsync
        ? [
            xrSucceeded
              ? `All shaders clustered at headset refresh (${vsync.hz} Hz). They fit the budget — but the bench cannot rank them relative to each other from this data alone.`
              : `Frametimes vsync-clamped at ${vsync.hz} Hz on desktop monitor. Not in an XR session; data does NOT reflect shader cost. Re-run from the Quest Browser, or use Sphere Static instead.`,
          ]
        : undefined,
      notes: 'Immersive WebXR session, A-Frame WebGL pipeline, rAF frame deltas via bench-tick component. Captures true stereoscopic per-eye cost — the limitation the paper § 5.2 identifies. When frametimes cluster around a display refresh period (vsyncClamping != null), the bench was rAF-bound and the numbers do not reflect shader cost.',
    },
    shaders: results,
  };

  showDonePopup({
    title: 'InOut bench complete',
    subtitle: `${results.length} shaders on ${headsetName}${xrSucceeded ? ' (XR session)' : ' (flat — no XR)'}`,
    warning: warningHtml,
    rows,
    onDownload: () => exportResults(payload, 'shadercarousel-inout'),
    onRunAgain: () => { gateApi.show(); },
  });
}

// ── Boot ───────────────────────────────────────────────────────────────────
//
// IMPORTANT: cache DOM refs and wire all event listeners SYNCHRONOUSLY at
// module top, *before* any `await`. The launcher (../index.html) moves
// #hud / #controls / #shader-picker / #log out of this iframe into its
// sidebar on the iframe's `load` event. Module execution finishes before
// `load`, so cached refs taken now resolve correctly — and adopted nodes
// keep their identity so the cached refs keep working after re-parenting.
// `buildPicker` is deferred until after A-Frame init only because the
// registry depends on `THREE.TSL` which arrives with the A-Frame bundle;
// it still receives the synchronously-cached `refs.pickList`.
const refs = {
  pickList:     $('pick-list'),
  shaderPicker: $('shader-picker'),
  log:          $('log'),
  hudHeadset:   $('hud-headset'),
  btnStart:     $('btn-start'),
  btnStop:      $('btn-stop'),
  btnShaders:   $('btn-shaders'),
  btnLog:       $('btn-log'),
  btnReset:     $('btn-reset'),
};

const settings = wireSettings(DEFAULTS, SETTINGS_KEY);

refs.btnStop   .addEventListener('click', () => { cancel = true; running = false; });
refs.btnShaders.addEventListener('click', () => refs.shaderPicker.classList.toggle('visible'));
refs.btnLog    .addEventListener('click', () => refs.log.classList.toggle('visible'));
refs.btnReset  .addEventListener('click', () => { settings.reset(); log('Settings reset to defaults', 'ok'); });

// Sidebar Start → just re-show the in-iframe gate. The gate's button is
// inside the iframe document and is therefore a valid user-gesture origin
// for `sceneEl.enterVR()`; standalone browsers (especially Meta Quest
// Browser) sometimes reject XR entry when the triggering button was
// adopted into the parent doc.
refs.btnStart  .addEventListener('click', () => { gateApi?.show(); });

// Headset detection runs sync (UA sniff only); the gate is created here so
// the user sees something even if A-Frame init is slow. The gate stays
// hidden until A-Frame is ready (its button is disabled until then).
const detected = detectHeadset() || 'Desktop browser';
headsetName = detected;
refs.hudHeadset.textContent = detected;

gateApi = createStartGate({
  title: 'Sphere InOut — immersive WebXR bench',
  subtitle: 'Inverted sphere approaches the camera and recedes (10 s ping-pong). Records rAF frame deltas inside an XR session — the only way to capture true stereoscopic per-eye cost on a standalone HMD.',
  buttonLabel: '▶ Start (Enter VR)',
  extraHtml: `
    <div>Detected headset: <strong id="gate-detected">${detected}</strong></div>
    <label>Override (if detection is wrong): <input type="text" id="gate-headset-override" placeholder="e.g. Meta Quest 3" autocomplete="off"></label>
    <div id="gate-xr-status" style="margin-top:8px; font-size:11px; color:#9aa">Checking WebXR…</div>
  `,
  beforeStart: () => {
    const override = document.getElementById('gate-headset-override')?.value?.trim();
    if (override) headsetName = override;
  },
  onStart: runBenchmark,
});
gateApi.setBusy(true);

(async () => {
  try {
    await initFromAFrame();
    if (!THREE?.TSL) throw new Error('THREE.TSL missing — A-Frame bundle does not include TSL');

    // Registry depends on THREE.TSL → populate the picker now that A-Frame
    // has loaded the bundle. `refs.pickList` was cached pre-adoption so
    // it still resolves whether the node is in the iframe or the sidebar.
    buildPicker(registry, refs.pickList, PICKER_KEY, DEFAULT_GROUPS);

    const xr = await diagnoseXR();
    const statusEl = document.getElementById('gate-xr-status');
    if (statusEl) {
      if (xr.ok) {
        statusEl.innerHTML = 'WebXR <strong>immersive-vr</strong> is available. Starting will enter an XR session.';
        statusEl.style.color = '#6dffa0';
      } else {
        // Distinct styling per reason so the user can see at a glance
        // whether it's an HTTPS problem, a browser problem, or a device
        // problem. `insecure` is by far the most common during local dev.
        const isInsecure = xr.reason === 'insecure';
        statusEl.innerHTML = `<strong>WebXR not available (${xr.reason}).</strong> ${xr.detail}`;
        statusEl.style.color = isInsecure ? '#ffb454' : '#fb6b6b';
      }
    }
    gateApi.setBusy(false);
  } catch (e) {
    log(`Init failed: ${e.message}`, 'err');
    console.error(e);
  }
})();
