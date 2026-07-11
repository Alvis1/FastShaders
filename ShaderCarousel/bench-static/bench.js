/* Sphere Static — WebGPU multi-pass benchmark.
 *
 * Paper § 3.3 + Table 2 macOS column: a static fullscreen sphere,
 * rendering N passes per measurement so the per-pass cost rises above
 * the display vsync floor. Without multi-pass, desktop screens (60 Hz /
 * 120 Hz) clamp every shader to the same number — losing the cost
 * signal entirely.
 *
 * The measurement machinery (renderer init, warmup/calibrate/ABAB loop,
 * stats + export plumbing, boot wiring) is the shared driver in
 * ../lib/bench-driver.js; timing + per-pass cost derivation live in
 * ../lib/bench-timing.js: GPU timestamp queries when the adapter
 * supports them (wall-clock around an onSubmittedWorkDone fence
 * otherwise), and a two-level (N / 2N passes) slope so fixed per-batch
 * overhead cancels out of the per-pass figure. This file owns only the
 * sphere scene and the bench-specific config/report text.
 *
 * Resolution matches Quest 3 per-eye (2064 × 2208) — the reference
 * pixel count of the point currency (bench-stats REF_PIXELS). */

import {
  Scene, PerspectiveCamera,
  SphereGeometry, Mesh, MeshPhysicalNodeMaterial, Color,
  AmbientLight, DirectionalLight,
} from 'three';
import * as TSL from 'three/tsl';
import { buildBenchRegistry } from '../lib/bench-registry.js';
import { createBenchDriver } from '../lib/bench-driver.js';
import { makeLogger, readSetting, installErrorOverlay } from '../lib/bench-ui.js';

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

createBenchDriver({
  log,
  registry: REGISTRY,
  defaults: DEFAULTS,
  settingsKey: SETTINGS_KEY,
  pickerKey: PICKER_KEY,
  defaultGroups: DEFAULT_GROUPS,

  render: renderer => renderer.render(scene, camera),

  setInitialSize(renderer) {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  },

  extraInitLogs: [`Render resolution: ${Q3_WIDTH}×${Q3_HEIGHT} (Quest 3 per-eye)`],

  // Idle-state render so the scene isn't black before Start
  afterInit: renderer => renderer.render(scene, camera),

  readConfig: () => ({
    duration: readSetting('input-duration', DEFAULTS['input-duration'], LIMITS.duration) * 1000,
    frames:   readSetting('input-frames',   DEFAULTS['input-frames'],   LIMITS.frames),
    passes:   readSetting('input-passes',   DEFAULTS['input-passes'],   LIMITS.passes),
    warmup:   readSetting('input-warmup',   DEFAULTS['input-warmup'],   LIMITS.warmup),
    stride:   readSetting('input-stride',   DEFAULTS['input-stride'],   LIMITS.stride),
  }),

  // Snap renderer to Quest 3 per-eye for measurement
  beforeRun(cfg, renderer) {
    renderer.setSize(Q3_WIDTH, Q3_HEIGHT, false);
    camera.aspect = Q3_WIDTH / Q3_HEIGHT; camera.updateProjectionMatrix();
  },

  // Restore display
  afterRun(cfg, renderer) {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    sphere.material = baseMat; sphere.scale.setScalar(FULL_COVERAGE_SCALE);
  },

  applyShader(shaderDef) {
    // Apply at tiny scale so the compile/upload spike is invisible
    sphere.scale.setScalar(0.001);
    const mat = new MeshPhysicalNodeMaterial();
    mat.colorNode = shaderDef.build(); // throws on bad TSL → driver logs FAIL + skips
    sphere.material = mat;
    sphere.scale.setScalar(FULL_COVERAGE_SCALE);
    return mat;
  },

  // frames[].t = elapsed ms into this shader's run (duration-capped bench)
  frameT: (_i, elapsedMs) => +elapsedMs.toFixed(1),

  onResult(_shaderDef, stats, out) {
    log(`  → ${stats.points} pts | ${stats.msPerPass ?? stats.medianFt} ms/pass (slope) | ${stats.cvPercent}% CV | ${out.passesLo}/${out.passesHi} passes`, 'ok');
  },

  report: {
    bench: 'static',
    tool: 'ShaderCarousel — Sphere Static',
    filename: 'shadercarousel-static',
    popupTitle: 'Static bench complete',
    resolution: () => ({ width: Q3_WIDTH, height: Q3_HEIGHT, label: 'Quest 3 per-eye' }),
    notes: 'Static fullscreen sphere, multi-pass per measurement, timed via GPU timestamp queries when available (timingMethod) with a wall-clock fence fallback. Each shader is measured at N and 2N passes per batch (stats.passesLo/passesHi); per-pass cost = (median(total@2N) − median(total@N)) / N so fixed per-batch overhead cancels. stats.msPerPass is authoritative; stats.medianFt is the hi-level per-pass median (diagnostic).',
  },

  gate: {
    title: 'Sphere Static — WebGPU multi-pass',
    subtitle: 'Full-coverage sphere at Quest 3 per-eye resolution. Measures each shader at N and 2N passes per batch (GPU timestamps when available) and takes the slope, so vsync, clock granularity, and per-batch overhead all cancel out of the per-pass cost.',
    buttonLabel: '▶ Start Static bench',
  },
});
