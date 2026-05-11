# ShaderFace

GPU micro-benchmark for TSL shader cost measurement. Two modes: **Standard** measures all shaders at fixed resolution; **Resolution Sweep** steps through increasing resolutions per shader to find the FPS cliff on target hardware (Quest 3).

## Run

Serve the `ShaderFace/` folder with any static HTTP server (e.g. VS Code Live Server, `python3 -m http.server`). Do **not** use the Vite dev server — it interferes with the import map.

Open `index.html` in a WebGPU-capable browser (Safari 18+, Chrome 113+, Quest Browser).

## Modes

### Standard Benchmark

Measures all 43 shaders at 512×512 with multi-pass timing. Produces per-shader marginal cost.

| Setting       | Default | Description                                               |
| ------------- | ------- | --------------------------------------------------------- |
| Loops         | 2       | Full passes through all shaders (randomized each time)    |
| Frames/shader | 30      | Measurement samples per shader per loop                   |
| Multi-pass    | 0       | Renders per sample (0 = auto-calibrate)                   |

### Resolution Sweep

Steps through increasing render resolutions for selected shaders. Finds the max resolution that fits within 120/90/72 fps frame budgets. Adds configurable A-Frame scene overhead to account for real-world VR pipeline cost.

| Setting   | Default | Description                                       |
| --------- | ------- | ------------------------------------------------- |
| Min res   | 256     | Smallest resolution to test                       |
| Max res   | 1760    | Largest resolution (Quest 3 per-eye ≈ 1680×1760)  |
| Step      | 128     | Resolution increment                              |
| Samples   | 20      | Measurements per shader per resolution             |
| Passes    | 0       | Multi-pass count (0 = auto-calibrate)             |

Use the **Shaders** button to select which shaders to sweep (All / None / Top 10).

### A-Frame Benchmark (`aframe.html`)

Same measurement method but renders through A-Frame's scene graph. Used to measure A-Frame pipeline overhead vs bare Three.js. The overhead difference is a constant added to shader cost in the resolution sweep.

## How it works

1. **Fixed-size quad** with orthographic camera isolates fragment shader cost
2. **Multi-pass amplification** — renders N passes per sample, divides total time by N
3. **GPU sync** via `device.queue.onSubmittedWorkDone()` (WebGPU) or `gl.finish()` (WebGL fallback)
4. **Ramp discard** — first 5 measurement cycles are discarded (GPU power state warm-up)
5. **Randomized order** per loop decorrelates thermal drift from shader identity
6. **Auto-calibration** — passes=0 finds the right count (min 100 for WebGPU, min 200 for WebGL)
7. **Periodic yields** — every 5 samples, yields to browser to prevent Quest compositor starvation

## GPU sync reliability

Only WebGPU's `onSubmittedWorkDone()` provides true GPU sync. Quest Browser falls back to WebGL where `gl.finish()` is unreliable — calibration compensates with higher pass counts (200+ vs 100) and higher time targets (50ms vs 10ms). Mac Safari with WebGPU produces the most reliable data (CV% 0–5%).

## Output

**Standard**: JSON with raw timing arrays + summary statistics (median, mean, SD, CV%, IQR, outlier count, baseline-subtracted marginal cost). Auto-downloads at 20% increments.

**Resolution Sweep**: JSON with per-shader cost at each resolution, plus `maxRes120`, `maxRes90`, `maxRes72` — the largest tested resolution fitting within each FPS budget (including A-Frame overhead).

## Shaders tested

- 1 baseline (flat color)
- 1 atomic (Voronoi/mx_worley_noise — only atomic measurably above baseline)
- 41 tsl-textures (all that show signal above noise floor)

## Dependencies

Uses Three.js WebGPU build + tsl-textures from the parent FastShaders project. Local copies in `lib/`.
