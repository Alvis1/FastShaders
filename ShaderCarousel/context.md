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
│   ├── bench-stats.js          # computeStats (IQR-filtered) + exportResults
│   ├── bench-registry.js       # canonical corpus (baseline + presets + noises + saved)
│   ├── bench-ui.js             # picker, settings, start gate, done popup, headset detect
│   └── three/                  # Three.js WebGPU bundle (three.webgpu.js, three.tsl.js, three.core.js)
├── components/three/
│   └── aframe-171-a-0.1.min.js # A-Frame 1.7 IIFE (only the InOut bench uses this)
├── sphere-mover.js             # A-Frame component — linear ping-pong z animation (InOut only)
├── bench-inout/                # immersive WebXR bench
│   ├── index.html
│   └── bench.js
├── bench-static/               # WebGPU multi-pass on a full-coverage sphere
│   ├── index.html
│   └── bench.js
└── bench-microplane/           # WebGPU multi-pass on a 512² ortho quad
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
| Backend | A-Frame 1.7 → THREE.WebGLRenderer (only stable WebXR path on Quest 3 Browser today; WebGPU XR is not reliable on Quest yet) |
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
| GPU sync | `device.queue.onSubmittedWorkDone()` after each multi-pass batch |
| Multi-pass | **30 passes per measurement** (default), render in tight loop → one fence → divide elapsed by N |
| Why multi-pass | A single render at desktop refresh clamps to the vsync floor (8.3 ms @ 120 Hz). 30× amplifies the per-pass cost above that floor — the technique Table 2's macOS column uses |

Best run on macOS with M-class GPUs to recover the fragment cost numbers the
paper reports. Outputs feed directly into the complexity-suggestion file.

### 3. MicroPlane — per-node calibration

| Property | Value |
|---|---|
| Backend | `THREE.WebGPURenderer`, ortho camera |
| Geometry | 2 × 2 plane covering the framebuffer |
| Resolution | **512 × 512** by default — small enough that ALU dominates over bandwidth, large enough to be measurable |
| GPU sync | Same `onSubmittedWorkDone` fence |
| Multi-pass | 30 passes × 60 frames per shader |
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
| **Saved Groups** | 0 — N (per-user) | Pulled from `localStorage['fs:savedGroups']`. Each entry is *listed* by name; entries get an executable `build()` only if the editor has populated a `tslCode: string` field on the saved record. Greyed out otherwise |

The baseline always runs first — the picker forces its checkbox on and disabled.

## Stats + export (`lib/bench-stats.js`)

Per shader, `computeStats` returns:

- `medianFt`, `meanFt`, `p95Ft`, `p99Ft` from an IQR-filtered sample (Q1 − 1.5·IQR, Q3 + 1.5·IQR fence)
- `sdFt`, `cvPercent` — dispersion and coefficient of variation
- `points = round(medianFt / 8.33 × 100)` — same anchor across all three benches
- `thermalDrift` — mean of second half ÷ mean of first half; > 1 means the bench got slower as it ran
- `outlierCount`, `frameCount`, `filteredCount` for transparency

`annotateMarginalCost` then adds `baselineMs`, `marginalMs`, `marginalPoints`
to each result. `marginalMs = medianFt − baselineMs` is the shader's
contribution above scene + driver fixed overhead — the right quantity to use
when assigning points in `complexity.json`.

`exportResults` writes three files per run:

1. **Raw JSON** — every captured frame + per-shader stats + run metadata (device, GPU, headset, config)
2. **Summary CSV** — one row per shader, all stats flattened, ready for pivot tables
3. **complexity-suggestion JSON** — `{ id, label, category, medianMs, marginalMs, suggestedPoints }` per shader. Drop this next to `src/registry/complexity.json` and diff to see what the device-measured points would be

## Calibration loop (closing the paper's gap)

The intended workflow for re-calibrating `complexity.json`:

1. Run **MicroPlane** on a desktop with stable WebGPU (e.g. macOS M-series). Subtract the baseline median from each atomic noise → marginal ms per primitive node. Convert via the `8.33 ms / 100 pts` anchor.
2. Run **Sphere Static** on the same device. The presets are compositions of the atomics — comparing measured composition cost vs. summed atomic cost is the regression input for the "combinations of nodes" work § 6 calls out.
3. Run **Sphere InOut** on a Meta Quest 3 in immersive mode. The ratio of InOut median to Static median quantifies the foveal + stereo + driver immersive overhead — the missing factor in the paper's § 5.2 limitation.
4. Diff each run's `*-complexity-suggestion-*.json` against the current `complexity.json` to see deltas per-node.

Total bench time per device (with 16-shader defaults): ~5 min combined.

## Defaults (rationale)

Picked from the existing `face/bench.js` calibration loop + the
`shaderRegistry.js` ShaderSphere defaults the paper used:

| Setting | InOut | Static | MicroPlane | Why |
|---|---|---|---|---|
| Duration / cycle | 10 s | 3 s | — | InOut: one full sphere-mover ping-pong; Static: enough to drain compile noise; Micro: bounded by frames |
| Frames per shader | (cycle-driven) | 30 | 60 | More micro frames because per-shader cost is smaller → higher relative jitter |
| Passes per measurement | 1 (rAF) | 30 | 30 | 30× amplifies cost above vsync floor (paper Table 2 macOS) |
| Warmup | 200 ms | 5 passes | 5 passes | Compile / texture upload spike skip |
| Log stride | every frame | every frame | every frame | Thinning happens at export, not capture — losing samples kills stats budget |
| Render size | per-eye XR | 2064 × 2208 | 512 × 512 | InOut: platform-driven; Static: matches XR for direct comparison; Micro: ALU-bound |

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
and lists each entry by name. `buildBenchRegistry` checks for an optional
`tslCode: string` field and, if present, wraps it via
`new Function('TSL', code)` to produce an executable build function. The
editor's current `saveGroupToLibrary` (see [`src/store/useAppStore.ts`](../src/store/useAppStore.ts))
persists `{ id, name, color, nodes, edges }` but **not** `tslCode` —
so saved groups appear in the picker with a disabled checkbox and the hint
*"editor needs to export TSL — re-save group in FastShaders v0.1.14+"*.

The bench side is ready. The editor extension is:
- In `saveGroupToLibrary`, after the `SavedGroup` construction, call
  `graphToCode(saved.nodes, saved.edges)` and assign `saved.tslCode = code`.
- Bump editor version so users know which save is the executable one.

Once shipped, saved groups become a first-class benchmarkable corpus — the
"combinations of nodes" extension paper § 6 future-works.

## Operational notes

- **Same-origin requirement**: the launcher and benches must be served from
  the same origin (the iframe adoption uses `iframe.contentDocument`). Open
  `index.html` via `python3 -m http.server`, not `file://`.
- **Quest 3 testing**: the gh-pages deploy at `/FastShaders/ShaderCarousel/`
  is HTTPS, which is required for WebXR session entry on Quest 3 Browser.
- **WebGPU vs WebGL**: Static + MicroPlane need WebGPU (no fallback in this
  version — they explicitly target the fence-sync timing). InOut uses WebGL
  via the A-Frame IIFE bundle because Quest 3's WebGPU XR is not yet reliable.
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
