/* MicroPlane — per-node microbenchmarks on a small ortho quad.
 *
 * Paper § 3.3: "Recovering individual node costs requires microbenchmarks
 * or regression over a larger shader corpus". This bench gives the
 * regression input — every shader runs against a fixed-size 2D quad
 * (default 1024×1024), multi-pass, so the timing is dominated by
 * ALU/bandwidth rather than scene overhead. The measurement machinery
 * (renderer init, warmup/calibrate/ABAB loop, stats + export plumbing,
 * boot wiring) is the shared driver in ../lib/bench-driver.js; timing +
 * per-pass cost derivation live in ../lib/bench-timing.js: GPU timestamp
 * queries when available (wall-clock fence otherwise) and a two-level
 * (N / 2N) slope that cancels fixed per-batch overhead. This file owns
 * only the quad scene, the live-marginal HUD, and the bench-specific
 * config/report text.
 *
 * Default corpus = 8 noise atomics + baseline. Presets are available but
 * unchecked by default — they're compositions, more useful in the Static
 * bench. Marginal cost (slope msPerPass − baseline), scaled to the
 * 2064×2208 reference pixel count, feeds the complexity.json suggestion
 * emitter directly. */

import {
  Scene, OrthographicCamera,
  PlaneGeometry, Mesh, MeshBasicNodeMaterial,
} from 'three';
import * as TSL from 'three/tsl';
import { buildBenchRegistry } from '../lib/bench-registry.js';
import { createBenchDriver, $ } from '../lib/bench-driver.js';
import { makeLogger, readSetting, installErrorOverlay } from '../lib/bench-ui.js';

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

let benchSize = DEFAULTS['input-size'];
// Baseline slope ms/pass of the current run — set by onResult when the
// baseline shader completes, read by onPair for the live-marginal HUD and
// by the per-shader log lines.
let baselineMsPerPass = null;

createBenchDriver({
  log,
  registry: REGISTRY,
  defaults: DEFAULTS,
  settingsKey: SETTINGS_KEY,
  pickerKey: PICKER_KEY,
  defaultGroups: DEFAULT_GROUPS,

  render: renderer => renderer.render(scene, camera),

  setInitialSize: renderer => renderer.setSize(benchSize, benchSize, false),

  readConfig: () => ({
    size:    readSetting('input-size',   DEFAULTS['input-size'],   LIMITS.size),
    frames:  readSetting('input-frames', DEFAULTS['input-frames'], LIMITS.frames),
    passes:  readSetting('input-passes', DEFAULTS['input-passes'], LIMITS.passes),
    warmup:  readSetting('input-warmup', DEFAULTS['input-warmup'], LIMITS.warmup),
    stride:  readSetting('input-stride', DEFAULTS['input-stride'], LIMITS.stride),
  }),

  beforeRun(cfg, renderer) {
    baselineMsPerPass = null; // per-run — a stale baseline must not leak into "Run again"
    if (cfg.size !== benchSize) {
      benchSize = cfg.size;
      renderer.setSize(benchSize, benchSize, false);
    }
  },

  afterRun() { quad.material = baseMat; },

  applyShader(shaderDef) {
    const mat = new MeshBasicNodeMaterial();
    mat.colorNode = shaderDef.build(); // throws on bad TSL → driver logs FAIL + skips
    quad.material = mat;
    return mat;
  },

  frameT: i => i,

  onPair({ lo, hi, passesLo, passesHi }) {
    if (baselineMsPerPass == null) return;
    // Use the overhead-free slope (fixed per-batch overhead C cancels in
    // the difference) so the HUD marginal agrees with the exported
    // marginalMs — matches bench-stats' statsFromTwoLevelRun slope. The
    // single-batch hi.totalMs/passesHi is overhead-inclusive and inflates
    // marginal by C/passes if subtracted directly.
    const slopeMsPerPass = (hi.totalMs - lo.totalMs) / (passesHi - passesLo);
    $('hud-marginal').textContent = (slopeMsPerPass - baselineMsPerPass).toFixed(4) + ' ms';
  },

  onResult(shaderDef, stats, out) {
    if (shaderDef.id === 'ref_baseline') baselineMsPerPass = stats.msPerPass ?? stats.medianFt;
    const own = stats.msPerPass ?? stats.medianFt;
    const marg = baselineMsPerPass != null ? (own - baselineMsPerPass).toFixed(4) : '—';
    log(`  → ${own} ms/pass (slope, marg ${marg}) | ${stats.cvPercent}% CV | ${out.passesLo}/${out.passesHi} passes`, 'ok');
  },

  report: {
    bench: 'microplane',
    tool: 'ShaderCarousel — MicroPlane',
    filename: 'shadercarousel-microplane',
    popupTitle: 'MicroPlane bench complete',
    subtitleSuffix: ', points normalized to 2064×2208',
    // resolution.width × height is also the annotator's pixel count — this
    // is where the old ~4.35× point deflation (1024² vs the 2064×2208
    // currency) gets corrected.
    resolution: cfg => ({ width: cfg.size, height: cfg.size, label: 'microplane' }),
    notes: 'Per-node microbenchmark on a 2×2 ortho quad, timed via GPU timestamp queries when available (timingMethod) with a wall-clock fence fallback. Each shader is measured at N and 2N passes per batch (stats.passesLo/passesHi); per-pass cost = (median(total@2N) − median(total@N)) / N so fixed per-batch overhead cancels. stats.msPerPass is authoritative; marginal points are normalized to the 2064×2208 reference resolution in the export.',
  },

  gate: {
    title: 'MicroPlane — per-node microbench',
    subtitle: 'Small ortho quad, multi-pass timing (GPU timestamps when available), two-level slope per shader. Defaults to noise atomics + baseline — best for deriving per-node points by subtraction; exported points are normalized to the 2064×2208 reference resolution. Does not enter immersive mode.',
    buttonLabel: '▶ Start MicroPlane bench',
  },
});
