# ShaderFace Benchmark Protocol
## Empirical GPU Cost Measurement for FastShaders Performance Points

---

## Implementation Status

Based on the original [shader-benchmark-protocol.md](~/Downloads/shader-benchmark-protocol.md). Key deviations noted below.

### What was implemented

- Fixed-size quad method (bare Three.js + A-Frame modes)
- Multi-pass amplification with GPU sync (`device.queue.onSubmittedWorkDone`)
- Auto-calibration of pass count (adaptive target: 10ms for WebGPU, 50ms for WebGL)
- Randomized shader order per loop (standard mode)
- Thermal warm-up phase (5s standard, 3s sweep)
- GPU ramp discard (5 multi-pass cycles before recording)
- JSON export with IQR outlier filtering, median/mean/SD/CV%
- Baseline subtraction for marginal cost
- Incremental export at 20% intervals (crash recovery for Quest)
- Resolution sweep mode (steps through resolutions per shader, finds FPS cliffs)
- A-Frame overhead accounting (constant added to shader cost for VR frame budget)
- Periodic browser yields (every 5 samples) to prevent Quest compositor starvation

### What was changed from the protocol

| Protocol spec | Implementation | Reason |
|---------------|---------------|--------|
| GPU timer queries (preferred) | `device.queue.onSubmittedWorkDone` | WebGPU doesn't expose `EXT_disjoint_timer_query`; `onSubmittedWorkDone` is the WebGPU-native GPU fence |
| 3-minute thermal warm-up | 3–5 seconds | Quest 3 freezes/exits on long benchmarks; total runtime capped at ~5 min |
| 60-frame measurement + 2s warmup/shader | 30 frames + 5 ramp-discard cycles (standard), 20 samples (sweep) | Quest time budget |
| Discard first loop entirely | Ramp-discard per shader instead | More efficient; GPU DVFS settling is per-shader, not per-session |
| Atomic node test shaders | Removed (except Voronoi) | All atomics measured identical to baseline on desktop GPU — below timer resolution at any practical pass count |
| K=5 loops | K=2 (Quest), K=5 (desktop) | Quest time constraint |
| readPixels GPU sync | Not used | Can't mix WebGL context with WebGPU canvas; `onSubmittedWorkDone` is correct for WebGPU |
| Fixed resolution | Resolution sweep mode added | Need to find per-shader FPS cliffs at Quest 3 render resolution |

### Sync reliability

Only `device.queue.onSubmittedWorkDone()` (WebGPU) provides real GPU sync. When the renderer falls back to WebGL (Quest Browser) or the device isn't accessible (A-Frame's renderer), `gl.finish()` / double-rAF measures CPU dispatch time, not GPU execution. Auto-calibration then picks a low pass count because it thinks the GPU is fast. Fix: when sync is unreliable, target 50ms total (vs 10ms) and enforce minimum 200 passes. Results from unreliable sync runs should be treated as approximate.

Mac Safari with WebGPU is the gold standard — CV% 0–5%, perfectly reproducible rankings across runs.

Quest 3 with WebGL produces bimodal distributions (some measurements catch real GPU cost, others don't) but the ranking is consistent with Mac for 35/41 shaders when using 500+ passes.

### What was NOT implemented

- Python analysis pipeline (Section 3.3–3.5) — regression model, additivity test, LOO-CV
- Composite shaders (2–4 node combinations) for additivity testing
- Between-device cross-validation
- Thermal throttling detection (baseline drift monitoring between loops)

---

## Three Benchmark Modes

### 1. Standard Mode (`index.html`, mode=Standard)

Bare Three.js WebGPU renderer. Orthographic camera, 2×2 PlaneGeometry, `MeshBasicNodeMaterial`, fixed 512×512 render target. No scene graph overhead. Isolates pure fragment shader cost. Measures all 43 shaders with randomized order per loop.

### 2. Resolution Sweep Mode (`index.html`, mode=Resolution Sweep)

Same renderer, but steps through increasing resolutions (default 256→1760, step 128) for selected shaders. At each resolution: warmup, measure N samples, record median. Adds configurable A-Frame scene overhead constant to compute total frame time. Reports max resolution fitting 120/90/72 fps.

Fragment shader cost scales linearly with pixel count. The geometry (quad, sphere, complex mesh) doesn't matter — only the number of shaded pixels. A-Frame adds a fixed per-frame overhead (entity system, scene traversal, compositor) independent of shader complexity.

### 3. A-Frame Mode (`aframe.html`)

A-Frame scene with a plane entity, lights, and camera. Uses the same A-Frame IIFE bundle and shaderloader component as the FastShaders editor preview. A-Frame's render loop is paused; the benchmark drives `renderer.render(scene, camera)` manually for multi-pass measurement. Reuses a single material to avoid leaks.

**Purpose**: Measures A-Frame pipeline overhead vs bare Three.js. The difference (baseline A-Frame cost minus baseline quad cost) gives the constant overhead to add in the resolution sweep.

Uses `THREE.TSL` and `window.tslTextures` from A-Frame's IIFE globals.

---

## Validated Results

### Mac (WebGPU, `onSubmittedWorkDone`, 120 passes, 2 loops)

Reliable, reproducible. CV% 0–5% for all shaders. Rankings identical across runs.

Top shaders by marginal cost (ms, baseline-subtracted):

| Shader | Marginal (ms) |
|--------|-------------:|
| circleDecor | 0.558 |
| caustics | 0.542 |
| cork | 0.354 |
| turbulentSmoke | 0.275 |
| dalmatianSpots | 0.250 |
| protozoa | 0.208 |
| reticularVeins | 0.200 |
| planet | 0.142 |
| crumpledFabric | 0.100 |
| rust | 0.100 |
| romanPaving | 0.100 |
| wood | 0.092 |
| entangled | 0.083 |
| voronoi (mx) | 0.075 |
| runnyEggs | 0.075 |
| gasGiant | 0.067 |
| bricks | 0.058 |
| watermelon | 0.033 |
| neonLights | 0.025 |
| voronoiCells | 0.025 |

### Quest 3 (WebGL, `gl.finish`, 500 passes, 2 loops)

Noisy (CV% 60–87%) due to unreliable sync. Ranking matches Mac for 35/41 shaders.

Top shaders at 512×512:

| Shader | Marginal (ms) |
|--------|-------------:|
| cork | 5.54 |
| circleDecor | 5.15 |
| caustics | 5.00 |
| turbulentSmoke | 4.76 |
| dalmatianSpots | 4.28 |
| protozoa | 3.59 |

All shaders fit 120fps at 512×512. Resolution sweep mode needed to find the cliff at higher resolutions.

### VR Frame Budgets

| FPS | Frame budget (ms) |
|-----|------------------:|
| 120 | 8.33 |
| 90  | 11.11 |
| 72  | 13.89 |

---

## Quick-Start

1. Serve `ShaderFace/` via static HTTP server (not Vite)
2. Open `index.html`
3. **Standard**: leave defaults, press Start → measures all shaders at 512×512
4. **Resolution Sweep**: switch mode, select shaders, set resolution range, press Start → finds FPS cliffs
5. **A-Frame**: open `aframe.html` → measures A-Frame pipeline overhead
6. JSON auto-downloads on completion
