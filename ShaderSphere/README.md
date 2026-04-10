# ShaderSphere

GPU benchmark for TSL shaders. Measures per-fragment cost at Quest 3 per-eye resolution (2064×2208) with full viewport coverage. Outputs a **points** score: 100 points = 120 fps (8.33 ms frame budget).

Two modes:

- **TSL** (`index.html`) — Pure Three.js WebGPU. GPU-synced timing via fences (`onSubmittedWorkDone`). Measures isolated shader execution cost.
- **A-Frame** (`aframe.html`) — Unpaused A-Frame pipeline. rAF-to-rAF frame deltas measure the full pipeline: system ticks + render + compositor. Display-bound at low load, GPU-bound at high load.

Results export as JSON and CSV.

## How it works

A sphere is scaled to fill the entire viewport at Quest 3 per-eye resolution. After warmup frames stabilize the pipeline, frame times are recorded for the configured duration. The median frame time determines the shader's point score.

**Points formula:** `points = round(medianFrameTime / 8.33 × 100)`

| Points | Frame time | FPS | Meaning |
|--------|-----------|-----|---------|
| 50 | 4.17 ms | 240 | Very cheap |
| 100 | 8.33 ms | 120 | Budget baseline |
| 133 | 11.11 ms | 90 | Exceeds 120 Hz |
| 167 | 13.89 ms | 72 | Exceeds 90 Hz |
| 200 | 16.67 ms | 60 | Exceeds 72 Hz |

**TSL mode** calls `renderer.render()` directly with GPU fence sync — each sample is one render with measured GPU completion time.

**A-Frame mode** leaves the scene running and observes frame-to-frame rAF deltas. This captures real-world FPS including A-Frame overhead. At low GPU load, frame times cluster at the display refresh interval. At high load, they exceed it.

## Methodology

The benchmark isolates per-fragment shader cost by controlling every variable except the shader itself. A single sphere with `MeshPhysicalNodeMaterial` is rendered at a fixed resolution (Quest 3 per-eye: 2064×2208) and scaled large enough to guarantee full viewport coverage. This means every pixel on screen executes the shader — there is no geometry complexity, no scene graph overhead, and no partial coverage to introduce noise. Each shader is benchmarked independently with a configurable warmup (default 10 frames) followed by a recording period (default 3 seconds). The sphere rotates slowly during recording to prevent the GPU from optimizing for a static image.

### Two modes, two purposes

**TSL mode** is the primary tool for cost ranking. It creates a standalone Three.js WebGPU renderer, calls `renderer.render()` directly, and waits for a GPU fence (`device.queue.onSubmittedWorkDone()`) after each frame. This measures actual GPU execution time — not display-limited frame deltas — so it can differentiate every shader from the cheapest (staticNoise at ~0.5ms) to the most expensive (caustics at ~9ms). The TSL benchmark was run on a **macOS 26.4 MacBook Pro with Apple M4 Max** using Safari, which provides full WebGPU support and high-resolution timers without the precision limitations of mobile browsers. On Quest 3, `performance.now()` has ~1ms precision due to Spectre mitigations, which quantizes individual frame times to integers — running on Mac avoids this issue entirely. The point score is derived from **average FPS** across all recorded frames: `points = round((1000 / avgFps) / 8.33 × 100)`. Averaging hundreds to thousands of samples provides stable, reproducible scores.

**A-Frame mode** validates the results under real-world conditions on Quest 3 hardware. It runs an unpaused A-Frame scene and observes `requestAnimationFrame` deltas, which include A-Frame system ticks, render submission, and compositor overhead. Because rAF timing is vsync-locked, frame times cannot go below the display refresh interval — on Quest 3 at 72 Hz, every shader that fits within 13.9ms reports the same frame time. This means A-Frame mode cannot rank cheap shaders, but it reveals which shaders actually break the frame budget in production. Shaders that score 167+ points in A-Frame mode are genuinely over budget for 72 Hz; shaders that score 334+ are dropping to 36 fps or worse.

### How the modes complement each other

TSL mode on Mac provides the **relative cost ranking** used in FastShaders' point system — every tsl-texture gets a distinct score that reflects its true GPU cost. A-Frame mode on Quest 3 provides **absolute validation on target hardware** — confirming which shaders actually drop frames in the full VR pipeline with framework overhead included. The two datasets together give both a fine-grained ranking and a real-world pass/fail for Quest 3 VR.

### Warmup

Before recording begins, warmup frames are rendered and discarded. This lets the WebGPU pipeline compile and cache the shader, warm the GPU instruction and texture caches, and stabilize driver-level lazy allocations. Without warmup, cold-start frames inflate the score and make every shader look more expensive than it is in steady state.

### Line counting

Source line counts exclude empty lines and comments. **Effective lines** include code from `tsl-utils.js` utility functions that each shader imports: `vnoise` (1 line), `approximateNormal` (3), `remapExp` (3), `hsl` (9, including its `hslHelper` dependency), `toHsl` (24), `spherical` (5). The most heavily-used functions — `noise`, `fractal`, `voronoi` and their variants — are re-exports from Three.js MaterialX built-ins (`mx_noise_float`, `mx_fractal_noise_float`, `mx_worley_noise_float`, etc.). Their implementation lives deep inside Three.js internals and cannot be counted as source lines. These MaterialX built-ins are the primary GPU cost drivers: a single `voronoi()` call is far more expensive than dozens of arithmetic lines.

### Statistics

Stats are computed from every recorded frame for maximum accuracy. Beyond the primary point score, additional metrics capture performance characteristics: p95 and p99 frame times reveal worst-case spikes, jitter (standard deviation) indicates consistency, and thermal drift (ratio of second-half to first-half mean frame time) detects GPU throttling during the run. The exported JSON thins the raw frame array to every 4th sample to reduce file size. A companion CSV with one row per shader is also exported for direct use in spreadsheets.

## Results

Benchmark data from two runs: TSL mode on macOS 26.4 M4 Max MacBook Pro (Safari), A-Frame mode on Meta Quest 3 (Oculus Browser 144, 72 Hz). Source from `tsl-textures@3.0.1`.

Points are derived from TSL avgFps: `points = round((1000 / avgFps) / 8.33 × 100)`.

| Shader | Pts | Mac fps | Q3 fps | Q3 medianFt | Lines | Eff. lines | Built-ins |
|--------|-----|---------|--------|-------------|-------|------------|-----------|
| circleDecor | 106 | 113 | 21.7 | 42.1ms | 44 | 44 | noise, voronoi |
| caustics | 104 | 115 | 11.9 | 83.3ms | 44 | 44 | voronoi, voronoi3 |
| cork | 74 | 163 | 10.7 | 96.9ms | 60 | 61 | noise (+vnoise) |
| turbulentSmoke | 59 | 203 | 72 | 13.9ms | 42 | 42 | fractal, fractal3, voronoi |
| dalmatianSpots | 55 | 218 | 13.1 | 69.8ms | 46 | 46 | noise |
| protozoa | 49 | 247 | 15.7 | 69.2ms | 67 | 67 | noise |
| reticularVeins | 47 | 253 | 21.1 | 42.1ms | 42 | 42 | noise, voronoi |
| planet | 38 | 320 | 20.7 | 42.1ms | 107 | 107 | noise |
| crumpledFabric | 30 | 397 | 24.6 | 41.6ms | 47 | 47 | noise |
| rust | 30 | 398 | 72 | 13.9ms | 89 | 89 | noise |
| romanPaving | 30 | 402 | 37.7 | 27.8ms | 30 | 30 | voronoi2 |
| wood | 29 | 412 | 26.1 | 41.5ms | 61 | 61 | noise |
| entangled | 27 | 441 | 72 | 13.8ms | 43 | 43 | noise |
| runnyEggs | 25 | 473 | 38.8 | 27.8ms | 114 | 117 | voronoi (+approxNormal) |
| gasGiant | 25 | 479 | 37.8 | 27.8ms | 55 | 88 | noise (+hsl, toHsl) |
| voronoi (mx) | 24 | 494 | 40 | 27.7ms | — | — | voronoi |
| bricks | 23 | 518 | 72 | 13.9ms | 69 | 72 | noise, fractal3 (+remapExp) |
| watermelon | 18 | 679 | 40 | 27.7ms | 54 | 54 | noise |
| neonLights | 16 | 753 | 41.3 | 27.8ms | 65 | 98 | noise (+hsl, toHsl) |
| voronoiCells | 16 | 750 | 72 | 13.9ms | 57 | 58 | noise (+vnoise) |
| clouds | 14 | 881 | 57.3 | 13.9ms | 69 | 69 | fractal |
| karstRock | 13 | 906 | 56.6 | 13.9ms | 36 | 36 | noise |
| marble | 13 | 924 | 56.8 | 13.9ms | 57 | 57 | noise |
| satin | 13 | 943 | 58.7 | 13.9ms | 40 | 40 | noise |
| photosphere | 13 | 958 | 72 | 13.9ms | 39 | 39 | noise |
| polkaDots | 12 | 1000 | 71.7 | 13.9ms | 61 | 66 | (+spherical) |
| dysonSphere | 12 | 1032 | 66.7 | 13.8ms | 90 | 90 | (none) |
| caveArt | 11 | 1094 | 67 | 13.9ms | 46 | 46 | noise |
| camouflage | 10 | 1191 | 72 | 13.9ms | 49 | 49 | noise |
| scream | 10 | 1159 | 72 | 14.0ms | 39 | 72 | noise (+hsl, toHsl) |
| brain | 9 | 1279 | 72 | 13.9ms | 70 | 70 | fractal, noise |
| fordite | 9 | 1306 | 72 | 13.8ms | 41 | 50 | noise (+hsl) |
| processedWood | 9 | 1330 | 72 | 13.9ms | 50 | 50 | noise |
| tigerFur | 9 | 1335 | 72 | 13.9ms | 47 | 47 | noise |
| darthMaul | 9 | 1381 | 72 | 13.9ms | 49 | 49 | noise |
| scepterHead | 8 | 1514 | 72 | 13.9ms | 56 | 92 | noise (+hsl, toHsl, remapExp) |
| stars | 7 | 1621 | 72 | 13.8ms | 40 | 73 | noise (+hsl, toHsl) |
| isolayers | 7 | 1691 | 72 | 13.9ms | 47 | 80 | noise (+hsl, toHsl) |
| circles | 7 | 1798 | 72 | 13.9ms | 44 | 77 | (+hsl, toHsl) |
| isolines | 7 | 1819 | 72 | 13.9ms | 41 | 41 | noise |
| perlinNoise | 7 | 1811 | 72 | 13.9ms | 37 | 37 | noise |
| staticNoise | 6 | 2067 | 72 | 13.9ms | 40 | 41 | noise (+vnoise) |

### Observations

- **Line count does not predict cost.** romanPaving (30 lines) costs 30 pts while dysonSphere (90 lines) costs only 12 pts. scepterHead has 92 effective lines but costs only 8 pts. The cost is dominated by which MaterialX built-ins are called and how many times — a single `voronoi()` call is far more expensive than dozens of arithmetic lines.
- **MaterialX built-ins are the cost drivers.** The top 7 most expensive shaders all use `voronoi` or multiple `fractal`/`noise` calls with iterative patterns. caustics calls `voronoi` + `voronoi3`, turbulentSmoke calls `fractal` + `fractal3` + `voronoi`, circleDecor combines `noise` + `voronoi`.
- **Mac-to-Quest cost ratio is not constant.** caustics runs at 115 fps on Mac but 11.9 fps on Quest (9.7x slower). cork runs at 163 fps on Mac but 10.7 fps on Quest (15.2x slower). Cheaper shaders show a smaller gap. This reflects the Adreno 740's weaker ALU throughput relative to M4 Max, especially for math-heavy procedural shaders.
- **A-Frame overhead is significant.** Many shaders that are cheap in TSL mode (7-13 pts) hit the 72 fps vsync cap on Quest 3. The Q3 avgFps column reveals shaders that are borderline: clouds (57.3), karstRock (56.6), marble (56.8), satin (58.7) run noticeably below 72 fps despite their median being display-locked at 13.9ms — they drop frames intermittently.
- **The expensive shaders are consistent across platforms.** caustics, cork, circleDecor, dalmatianSpots, and protozoa are the top 5 most expensive on both Mac and Quest.

## Scene multipliers

The raw points measure single-eye full-coverage cost. In a real scene, adjust with:

- **Coverage:** `× actual_coverage` (shader covers 30% of screen → cost × 0.3)
- **Stereo VR:** `× 2` (both eyes)
- **Multi-object:** sum points across all shader objects

## Files

| File | Purpose |
|------|---------|
| `index.html` | TSL mode entry point. Importmap resolves `three`, `three/tsl`, `tsl-textures` from ShaderFace lib |
| `aframe.html` | A-Frame mode entry point. Loads `aframe-171-a-0.1.min.js` + `a-frame-shaderloader-0.3.js` IIFE bundles |
| `bench.js` | TSL benchmark. WebGPU renderer, GPU-synced frame timing, points calculation |
| `bench-aframe.js` | A-Frame benchmark. rAF-to-rAF frame deltas + hooked render submission time |
| `shaderRegistry.js` | ES module shader registry. Imports 41 tsl-textures + reference/atomic shaders. Used by TSL mode |
| `stats.js` | Shared: median/percentile/jitter stats, points calculation, JSON + CSV export, shader picker UI |

## Usage

Serve the parent directory (needs sibling projects for imports):

```bash
npx serve ..
```

Open `index.html` (TSL mode) or `aframe.html` (A-Frame mode). Select shaders, set duration, then click Start. Results auto-download as JSON + CSV on completion.

## Output

Each export produces two files:

- **JSON** (`shadersphere-tsl-3s-*.json`) — full data with per-shader stats and thinned frame samples (every 4th frame). Contains metadata, config, and raw timing data for post-hoc analysis.
- **CSV** (`shadersphere-tsl-summary-3s-*.csv`) — one row per shader with columns: id, label, points, medianFt, p95Ft, p99Ft, jitter, avgFps, thermalDrift, frameCount. Directly usable in spreadsheets for sorting, charting, and copying into complexity.json.

## GPU synchronization

TSL mode uses GPU fence synchronization (`device.queue.onSubmittedWorkDone()`) to measure actual GPU render time per frame. Without synchronization, `renderer.render()` returns as soon as commands are submitted to the GPU queue — the measured time reflects CPU-side command encoding (~0.1 ms), not shader execution (often 2–15+ ms).

## A-Frame renderer settings

| Setting | Value | Why |
|---------|-------|-----|
| `antialias` | `true` | MSAA — matches production config |
| `highRefreshRate` | `true` | Requests 90 Hz+ on Quest |
| `colorManagement` | `true` | sRGB color space conversion |
| `foveationLevel` | `0` | Full resolution across entire viewport |
| `alpha` | `false` | No transparency buffer |
