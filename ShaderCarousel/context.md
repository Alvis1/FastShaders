# ShaderCarousel — Research Context

## Overview

ShaderCarousel is the benchmarking arm of the research project *Performance-Aware
Shader Authoring for Web-Based Virtual Reality Development*. It exists to close
specific calibration gaps the [FastShaders paper](../) identifies:

| Paper section | Gap | Bench that addresses it |
|---|---|---|
| § 3.3 | "Recovering individual node costs requires microbenchmarks or regression over a larger shader corpus" | **MicroPlane** |
| § 5.2 | Quest 3 measurements ran in non-immersive mode, missing stereoscopic fragment doubling | **Sphere InOut** |
| § 5.2 | Current scoring under-weights branch-divergent and bandwidth-bound ops (marble, voronoi); vsync clamps on-device timing | **Sphere Static** (vsync-defeating multi-pass) |
| § 6 future work | Extend pipeline to *combinations* of nodes, characterise interactions, produce a more precise approximation beyond linear summation | All three (corpus expandable via saved groups) |

Earlier iterations of this project used a rotating platform of shader instances
and the FastShaders shaderloader runtime — those approaches were retired in
favour of the three focused benches below, which together cover atomic
calibration, desktop ranking, and on-device immersive validation.

## Architecture

```
ShaderCarousel/
├── index.html                  # launcher — full-screen iframe + adopted sidebar
├── lib/
│   ├── bench-style.css         # unified theme for all three benches
│   ├── bench-stats.js          # computeStats + two-level slope per-pass cost + REF_PIXELS-normalized marginal points + validity-gated complexity-suggestion export (schema v2)
│   ├── bench-timing.js         # shared GPU timing (Static + MicroPlane): GPU timestamp queries via r184 trackTimestamp with a wall-clock-fence fallback; two-level N/2N slope; pairs-per-pass + 100 µs-quantization detection
│   ├── bench-registry.js       # canonical corpus (baseline + presets + noises + saved)
│   ├── bench-ui.js             # picker, settings, start gate, done popup, headset detect
│   └── three/                  # Three.js r184 WebGPU ESM (three.webgpu.min.js, three.tsl.min.js, three.core.min.js — official .min builds copied from node_modules/three@0.184)
├── benchData/                  # committed calibration runs (raw JSON + suggestion JSON per device-slug); currently only a README — the loop is NOT yet closed (no measured run committed)
├── components/three/
│   └── a-frame-180-a-01.min.js # A-Frame 1.8.0 IIFE, r184 WebGPU (synced from a-frame-shaderloader/js/ by fs-vendor-sync; only the InOut bench uses this)
├── sphere-mover.js             # A-Frame component — linear ping-pong z animation (InOut only)
├── bench-inout/                # immersive WebXR bench
│   ├── index.html
│   └── bench.js
├── bench-static/               # WebGPU multi-pass on a full-coverage sphere
│   ├── index.html
│   └── bench.js
└── bench-microplane/           # WebGPU multi-pass on a 1024² ortho quad
    ├── index.html
    └── bench.js
```

The launcher's job is purely DOM choreography: it loads each bench in a
same-origin iframe, then **adopts** the iframe's `#hud`, `#progress-bar`,
`#controls`, `#shader-picker`, `#log` into a left sidebar via
`document.adoptNode`. Adopted nodes keep their event listeners, so the bench's
JS continues to drive them from inside the iframe. The launcher also forwards
the iframe's `<style>` *and* `<link rel="stylesheet">` tags so the moved
elements stay styled. `#bench-start-gate` and `#bench-done-popup` are
deliberately **not** adopted — they stay inside the iframe so the gate's
button counts as a user-gesture origin for `sceneEl.enterVR()`.

## The three benches

### 1. Sphere InOut — immersive WebXR

| Property | Value |
|---|---|
| Backend | A-Frame 1.8.0 / Three.js r184 bundle, run on the WebGL backend (only stable WebXR path on Quest 3 Browser today; WebGPU XR is not reliable on Quest yet) |
| Geometry | Inverted sphere (`THREE.BackSide`), radius 2.5, 64×32 segments |
| Camera path | sphere-mover linear ping-pong on z (default 10 s cycle: z = −10 → 0 → −10) — the sphere envelops the viewer at z = 0 |
| Timing | rAF delta inside a one-shot `bench-tick` A-Frame component → fires every render whether `requestAnimationFrame` (flat) or `xr.setAnimationLoop` (in-headset) is driving the loop |
| Headset detect | UA pattern match (Quest 3 / Quest Pro / Pico / Vision Pro) with a text-input override in the start gate; logged into metadata |
| Auto-play | **No** — sphere stays at flat baseline until the gate button is pressed; click triggers `enterVR()` then begins the shader playlist |

Why InOut earns its name: the sphere moves *in* and *out* through the camera
position, so every rotation samples a range of screen-coverage fractions —
mirroring real VR content where shaders run on geometry at varied distances.

### 2. Sphere Static — WebGPU multi-pass (vsync-defeating)

| Property | Value |
|---|---|
| Backend | `THREE.WebGPURenderer`, antialias off, `high-performance` power preference |
| Geometry | Sphere @ `fullCoverageScale = 2.0` at z = −5, every pixel runs the shader |
| Resolution | **2064 × 2208** — Quest 3 per-eye target, so numbers are directly comparable to InOut |
| GPU timing | `lib/bench-timing.js` — **GPU timestamp queries** (three r184 `trackTimestamp` + `resolveTimestampsAsync`) when the adapter exposes `timestamp-query`, else a wall-clock fence (`device.queue.onSubmittedWorkDone()`). `timingMethod` (`gpu-timestamp` \| `wallclock-fence`) is exported per run |
| Multi-pass | **Two-level slope**: each shader is measured at N and 2N passes/batch (`bench-timing.calibrate` bumps N per-shader until a batch spans ~`CALIBRATE_TARGET_MS` 20 ms). Per-pass cost = (median(total@2N) − median(total@N)) / N, so the fixed per-batch overhead C cancels exactly (the old single-level divide-by-N left C/N in every marginal). `passesLo`/`passesHi` are exported |
| Why multi-pass | A single render at desktop refresh clamps to the vsync floor (8.3 ms @ 120 Hz). 30×+ amplifies the per-pass cost above that floor — the technique Table 2's macOS column uses |

Best run on macOS with M-class GPUs to recover the fragment cost numbers the
paper reports. Outputs feed directly into the complexity-suggestion file.

### 3. MicroPlane — per-node calibration

| Property | Value |
|---|---|
| Backend | `THREE.WebGPURenderer`, ortho camera |
| Geometry | 2 × 2 plane covering the framebuffer |
| Resolution | **1024 × 1024** by default (raised from 512² so cheap atomics clear `performance.now()` ~1 ms quantization) — large enough to be measurable, ALU still dominates over bandwidth. Marginal ms is scaled by `REF_PIXELS / (w·h)` before the point conversion, so 1024² points land in the same 2064×2208 currency as Static (this corrects the old ~4.35× deflation) |
| GPU timing | Same `lib/bench-timing.js` — GPU timestamp queries with wall-clock-fence fallback |
| Multi-pass | Same **two-level N/2N slope** as Static. `input-frames` (default 60) is now the number of measurement **pairs** per shader (one N batch + one 2N batch each), run interleaved ABAB so thermal drift hits both levels symmetrically |
| Default corpus | **8 noise atomics + baseline** — atomic shaders are what allow per-node cost recovery by subtraction. Presets are available but unchecked by default; the Static bench is where compositions belong |
| Immersive | **No** — microbench is sensitive to thermal & scheduler variance; immersive XR adds noise |

This is the bench paper § 3.3 explicitly asks for. Outputs are designed to
feed a regression over a larger node corpus (future work).

## Shared corpus (`lib/bench-registry.js`)

All three benches consume the same shader registry, built against the TSL
namespace passed in (`three/tsl` for WebGPU benches, `THREE.TSL` for the
A-Frame bundle). Groups, in picker display order:

| Group | Count | Purpose |
|---|---|---|
| **Baseline** | 1 — `ref_baseline` (flat color) | First shader of every run; required for marginal-cost subtraction |
| **Presets** | 8 — polkaDots, grid, tigerFur, staticNoise, crumpledFabric, gasGiant, marble, wood | Direct ports of FastShaders' `src/registry/builtinTextures.ts`. These are the user-facing texture presets the editor ships |
| **Noises** | 8 — perlin, perlinVec3, fbm, fbmVec3, cellNoise, voronoi, voronoiVec2, voronoiVec3 | The MaterialX noise primitives the editor's Noise category wraps. Called the way `graphToCode` emits them: bare `positionGeometry`, no scale |
| **Saved Groups** | 0 — N (per-user) | Pulled from `localStorage['fs:savedGroups']` and *listed* by name, but **always greyed-out** — inline `tslCode` execution was removed for security (see "Saved Groups loader status" below) |

The baseline always runs first — the picker forces its checkbox on and disabled.

## Stats + export (`lib/bench-stats.js`)

Per shader, `computeStats` returns:

- `medianFt`, `meanFt` — median / mean from an IQR-filtered sample (Q1 − 1.5·IQR, Q3 + 1.5·IQR fence, keeps the median robust)
- `p95Ft`, `p99Ft` — tail percentiles from the **UNFILTERED** sample (computing tails on the trimmed set made spikes invisible by construction)
- `sdFt`, `cvPercent` — dispersion and coefficient of variation
- `points = round(medianFt / 8.33 × 100)` — same anchor across all three benches
- `thermalDrift` — mean of second half ÷ mean of first half; > 1 means the bench got slower as it ran
- `outlierCount`, `frameCount`, `filteredCount` for transparency
- an `n < 2` sample returns the **full stats shape** with `insufficientData: true` (never partial/undefined fields), so downstream CSV/annotation can't silently zero a marginal

For the WebGPU benches, `statsFromTwoLevelRun` is the authoritative reducer:
it feeds the hi-level per-pass values through `computeStats` for dispersion,
then overwrites `msPerPass` (and recomputes `points`) from the **two-level
slope** — overhead-free, unlike a median divided by its pass count.

`annotateMarginalCost` then adds `baselineMs`, `marginalMs`, `marginalMsAtRef`,
`marginalPoints` to each result. `marginalMs = (msPerPass ?? medianFt) −
baselineMs` is the shader's contribution above scene + driver fixed overhead;
`marginalMsAtRef = marginalMs × REF_PIXELS / measuredPixels` normalizes it into
the 2064×2208 currency, and `marginalPoints` converts that via the 8.33 ms
anchor — the right quantity to assign in `complexity.json`. **When the baseline
is missing, the marginal fields are `null`** (they no longer silently fall back
to raw medians, which used to export as clean-looking-but-wrong suggestions).

`buildSuggestion` gates each run: `metadata.valid` is `true` only when it can
honestly price nodes. Otherwise `valid: false` + machine-readable `reasons[]`
(`baseline-missing`, `vsync-clamped`, `resolution-unknown`, `raf-delta timing`,
`insufficient-data`), so a suggestion file can never look clean while its
numbers are garbage. `detectVsyncClamping` flags runs whose shaders cluster
tightly around a known refresh period (chiefly an InOut hazard).

`exportResults` writes three files per run:

1. **Raw JSON** — every captured frame/batch + per-shader stats + run metadata (schema v2: `timingMethod`, `quantized`, `adapterInfo`, `stereo`, `clockPinned`, `resolution`, `resolutionScale`, `refPixels`)
2. **Summary CSV** — one row per shader, all stats flattened (incl. `msPerPass`, `marginalMsAtRef`), ready for pivot tables
3. **complexity-suggestion JSON** — `{ id, label, category, medianMs, msPerPass, marginalMs, marginalMsAtRef, suggestedPoints }` per shader plus the validity metadata block. Drop this next to `src/registry/complexity.json` and diff — **check `metadata.valid`/`reasons` first**. Commit the raw + suggestion JSON into `benchData/<device-slug>/`; browser downloads evaporate and the loop stays open otherwise

## Calibration loop (closing the paper's gap)

> **Status (2026-07): the loop has never been closed.** The Phase 0 timing
> infrastructure is in place (GPU timestamps, two-level slope, REF_PIXELS
> normalization, validity gating, schema v2, `benchData/`), but **no measured
> run has been committed** — `benchData/` holds only its README, and every
> number in `complexity.json` is still hand-guessed. The next step is
> mechanical: run MicroPlane + Static on desktop Chrome, commit the artifacts,
> update the noise-family prices with `source: 'measured-desktop-flat'`.

The intended workflow for re-calibrating `complexity.json`:

1. Run **MicroPlane** on a desktop with stable WebGPU (e.g. macOS M-series, or Chrome with `chrome://flags/#enable-webgpu-developer-features` to unquantize the 100 µs GPU timestamps). The two-level slope gives marginal ms per primitive node directly; convert via the `8.33 ms / 100 pts` anchor (already normalized to REF_PIXELS in the export).
2. Run **Sphere Static** on the same device. The presets are compositions of the atomics — comparing measured composition cost vs. summed atomic cost is the regression input for the "combinations of nodes" work § 6 calls out.
3. Run **Sphere InOut** on a Meta Quest 3 in immersive mode. The ratio of InOut median to Static median quantifies the foveal + stereo + driver immersive overhead — the missing factor in the paper's § 5.2 limitation.
4. Diff each run's `*-complexity-suggestion-*.json` against the current `complexity.json` to see deltas per-node.

Total bench time per device (default corpora — 17 shaders for Static/InOut, 9 for MicroPlane): ~5 min combined.

## Defaults (rationale)

Picked from the existing `face/bench.js` calibration loop + the
`shaderRegistry.js` ShaderSphere defaults the paper used:

| Setting | InOut | Static | MicroPlane | Why |
|---|---|---|---|---|
| Duration / cycle | 10 s | 6 s | — | InOut: one full sphere-mover ping-pong; Static: enough to drain compile noise; Micro: bounded by frames |
| Frames per shader | (cycle-driven) | 30 | 60 | For Static/MicroPlane this is the number of measurement **pairs** (one N + one 2N batch each). More micro pairs because per-shader cost is smaller → higher relative jitter |
| Passes per measurement | 1 (rAF) | ≥30 (adaptive N, two-level) | ≥30 (adaptive N, two-level) | 30 = minimum N; `bench-timing.calibrate` raises N per-shader (timestamp mode caps at ~500/1000 by the query-pool budget; wall-clock mode at 4000) to span ~20 ms, then measures N and 2N for the slope (paper Table 2 macOS) |
| Warmup | 200 ms | 5 passes | 5 passes | Compile / texture upload spike skip |
| Log stride | every frame | every frame | every frame | Thinning happens at export, not capture — losing samples kills stats budget |
| Render size | per-eye XR | 2064 × 2208 | 1024 × 1024 | InOut: platform-driven; Static: matches XR for direct comparison; Micro: ALU-bound |

A **Reset to defaults** button is wired in every bench's `#controls` and
restores all of the above plus the picker selection.

## Settings persistence

Each bench namespaces its own localStorage keys:

| Key | Purpose |
|---|---|
| `shadercarousel:inout:settings` / `:static:settings` / `:micro:settings` | Numeric input values |
| `shadercarousel:inout:picker` / `:static:picker` / `:micro:picker` | Selected shader IDs |
| `shaderCarousel:mode` | Last-selected launcher mode (auto-restored on revisit) |

## Saved Groups loader status

The picker reads `localStorage['fs:savedGroups']` (same origin as the editor)
and lists each entry by name, but **every entry is currently disabled
(greyed-out)**: `compileSavedGroup` in `lib/bench-registry.js` always returns
`{ runnable: false }`. The original loader executed a group's `tslCode` inside a
`new Function('TSL', "with (TSL) { … }")` wrapper, but that path was **removed
for security** — a `tslCode` field in `fs:savedGroups` would otherwise be
arbitrary JS running in the bench origin.

Making saved groups benchmarkable therefore needs **two** changes, not one:
- **Editor side** — `saveGroupToLibrary` (see [`src/store/useAppStore.ts`](../src/store/useAppStore.ts))
  must persist a `tslCode` field; it currently stores `{ id, name, color, nodes, edges }`
  only (e.g. call `graphToCode(saved.nodes, saved.edges)` and assign the result).
- **Bench side** — `compileSavedGroup` must add a **sandboxed** compile step
  (a worker, or the shaderloader parse pipeline) instead of the removed inline
  `new Function` path.

Until both land, saved groups stay listed-only. Once shipped they become a
first-class benchmarkable corpus — the "combinations of nodes" extension the
paper's § 6 calls out as future work.

## Operational notes

- **Same-origin requirement**: the launcher and benches must be served from
  the same origin (the iframe adoption uses `iframe.contentDocument`). Open
  `index.html` via `python3 -m http.server`, not `file://`.
- **Quest 3 testing**: the gh-pages deploy at `/FastShaders/ShaderCarousel/`
  is HTTPS, which is required for WebXR session entry on Quest 3 Browser.
- **WebGPU vs WebGL**: Static + MicroPlane target WebGPU fence sync; if the
  `WebGPURenderer` initializes on a WebGL backend they fall back to `gl.finish()`
  (logged as less precise), so prefer a real WebGPU device for accurate timing.
  InOut uses WebGL via the A-Frame IIFE bundle because Quest 3's WebGPU XR is
  not yet reliable.
- **Browsers**: Chrome / Edge / Brave for WebGPU; Meta Quest Browser for the
  InOut immersive path. Safari WebGPU works for Static + MicroPlane on Apple
  Silicon.

## Historical (removed)

For provenance — earlier iterations of this directory included:

- A rotating-platform `carousel.html` viewer that auto-cycled the playlist on
  load; replaced by the explicit Start-gated benches.
- The `shaderloader` + `tsl-shim` pair that the platform viewer used to load
  TSL modules from the `tsl/` folder at runtime; the benches now compile TSL
  inline from `lib/bench-registry.js` so the loader runtime is no longer
  needed here. The shaderloader proper still lives in
  [`public/js/`](../public/js/) for the main editor's preview iframe.
- Separate `sphere/` and `face/` directories (each with TSL + A-Frame
  variants); the four pages collapsed into the three current benches when
  the A-Frame microplane was dropped (its WebGL timing duplicated the
  WebGPU fence path without adding signal).
