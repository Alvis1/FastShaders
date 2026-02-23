# GPU Shader Cost Analysis

> [!info] Baseline
> `add = 1 point`. All costs are relative to a single full-rate ALU operation.
> Budgets assume **3–5 concurrent shaders** in the scene.

---

## Methodology

Mobile GPUs (Adreno, Mali Valhall, Apple GPU) share a dual-pipeline architecture:

- **Main ALU (FMA/ADD)** — full-rate arithmetic: add, sub, mul, fma all execute at full throughput
- **Special Function Unit (SFU)** — quarter-rate transcendentals: sin, cos, sqrt, rcp run at **1/4 throughput**

This 4:1 ratio is consistent across all major mobile GPU architectures used in VR headsets.[^1][^2][^3][^4]

### Key hardware facts

| Architecture | Device           | Main ALU             | SFU Ratio                   |
| ------------ | ---------------- | -------------------- | --------------------------- |
| Adreno 650   | Quest 2          | Full-rate FMA        | 1:4 (quarter-rate)[^36][^6] |
| Adreno 660   | Quest 3S, Pico 4 | Full-rate FMA        | 1:4 (quarter-rate)[^5][^6]  |
| Adreno 740   | Quest 3          | Full-rate FMA        | 1:4 (quarter-rate)[^7][^8]  |
| Adreno 750   | Steam Frame      | Full-rate FMA        | 1:4 (quarter-rate)[^33]     |
| Apple M5 GPU | Vision Pro (M5)  | 10-core next-gen     | SFU ~1:4 effective[^29][^3] |
| Mali Valhall | Reference        | 16-wide FMA + 16 CVT | 4-wide SFU (1:4)[^2]        |

---

## Revised Node Costs

### Inputs & Constructors (0 pts)

Register reads and assignments — not ALU operations.

| Node                                              | Old | New   | Rationale                                |
| ------------------------------------------------- | --- | ----- | ---------------------------------------- |
| `positionGeometry`, `normalLocal`, `tangentLocal` | 0   | 0     | Built-in varying/attribute reads         |
| `time`, `screenUV`, `property_float`              | 0   | 0     | Uniform/built-in reads                   |
| `float`, `int`, `vec2`, `vec3`, `vec4`            | 1   | **0** | Register assignment, not computation[^9] |
| `color`                                           | 2   | **0** | Identical to vec3 at GPU level           |
| `slider`                                          | 1   | **0** | Same as `float()` — register assignment  |

### Arithmetic (1–4 pts)

| Node                | Old | New   | Pipeline  | Rationale                                                                                    |
| ------------------- | --- | ----- | --------- | -------------------------------------------------------------------------------------------- |
| `add`, `sub`, `mul` | 1   | **1** | FMA       | Full-rate baseline operations[^1]                                                            |
| `div`               | 2   | **4** | SFU + FMA | Compiled as `x * rcp(y)` — `rcp` is a quarter-rate SFU op. Apple GPU: 6-cycle throughput[^3] |

### Math — Unary (0–5 pts)

| Node                      | Old | New   | Pipeline        | Rationale                                                                             |
| ------------------------- | --- | ----- | --------------- | ------------------------------------------------------------------------------------- |
| `abs`                     | 1   | **0** | Source modifier | Free on all mobile GPUs — source operand modifier, not an instruction[^1][^10]        |
| `floor`, `round`, `fract` | 1   | **1** | CVT/ALU         | Hardware conversion instructions[^2]                                                  |
| `sin`, `cos`              | 8   | **4** | SFU             | Single native SFU instruction at quarter-rate. Old value was 2x too high[^1][^3][^11] |
| `sqrt`                    | 3   | **4** | SFU             | Typically `x * rsqrt(x)`. Apple GPU: 8-cycle throughput[^3]                           |
| `log2`                    | 6   | **4** | SFU             | Native SFU instruction[^1][^3]                                                        |
| `exp`                     | 6   | **5** | SFU + FMA       | `exp2(x * 1.4427)` = 1 SFU + 1 multiply[^1]                                           |

### Math — Binary (1–12 pts)

| Node         | Old | New    | Pipeline | Rationale                                                   |
| ------------ | --- | ------ | -------- | ----------------------------------------------------------- |
| `min`, `max` | 1   | **1**  | ALU      | Single instruction[^1]                                      |
| `mod`        | 2   | **2**  | ALU      | `x - y * floor(x/y)` = floor + mul + sub                    |
| `clamp`      | 2   | **2**  | ALU      | `min(max(x, a), b)` = 2 instructions                        |
| `pow`        | 5   | **12** | SFU x3   | `exp2(y * log2(x))` = 3 chained SFU operations[^1][^3][^12] |

> [!warning] `pow()` is the biggest correction
> Was 2.4x undervalued. It compiles to 3 chained SFU ops, making it one of the most expensive common operations. AMD GCN measured: 16-cycle latency vs 4 for mul.

### Interpolation (2–7 pts)

| Node         | Old | New   | Pipeline  | Rationale                                                                                              |
| ------------ | --- | ----- | --------- | ------------------------------------------------------------------------------------------------------ |
| `mix`        | 3   | **2** | FMA       | `a + t*(b-a)` = 1–2 FMA instructions[^1]                                                               |
| `select`     | 2   | **2** | ALU       | Predicated select                                                                                      |
| `remap`      | 5   | **5** | ALU       | Linear remap: sub + div + mul + add                                                                    |
| `smoothstep` | 4   | **7** | ALU + SFU | `t = clamp((x-e0)/(e1-e0)); t*t*(3-2*t)` — involves division (SFU rcp) + clamp + cubic polynomial[^13] |

### Vector Operations (3–8 pts, for vec3)

Costs scale with vector dimension. Values below are for vec3 (most common in shaders).

| Node        | Old | New   | Pipeline  | Rationale                                             |
| ----------- | --- | ----- | --------- | ----------------------------------------------------- |
| `dot`       | 2   | **3** | FMA       | 3 multiply-adds (one per component)[^1]               |
| `cross`     | 3   | **6** | FMA       | 6 multiplies + 3 subtracts[^1]                        |
| `normalize` | 4   | **7** | FMA + SFU | `v * rsqrt(dot(v,v))` = dot(3) + rsqrt SFU(4)[^1][^3] |
| `length`    | 3   | **7** | FMA + SFU | `sqrt(dot(v,v))` = dot(3) + sqrt SFU(4)[^1][^3]       |
| `distance`  | 4   | **8** | FMA + SFU | `length(a-b)` = sub(1) + length(7)                    |

### Color Space (15 pts)

| Node                 | Old | New    | Rationale                                                                    |
| -------------------- | --- | ------ | ---------------------------------------------------------------------------- |
| `hsl` (HSL to RGB)   | 5   | **15** | Hue sector selection (3 branches), multiply, clamp = ~12–15 ALU ops[^14]     |
| `toHsl` (RGB to HSL) | 5   | **15** | min/max of 3 channels, division, conditional hue logic = ~15–20 ALU ops[^14] |

### Noise (55–140 pts)

| Node                               | Old | New     | Rationale                                                                                                     |
| ---------------------------------- | --- | ------- | ------------------------------------------------------------------------------------------------------------- |
| `fractal` (mx_fractal_noise_float) | 80  | **140** | FBM with ~4 octaves of 3D Perlin noise. Each octave ~35 ALU ops (8 gradient lookups). 4 x 35 = ~140[^15][^16] |
| `voronoi` (mx_worley_noise_float)  | 60  | **55**  | 2D Worley: 9 neighboring cells x (hash + distance). ~50–60 ALU ops[^15]                                       |

### tsl-textures (10–165 pts)

Costs based on internal composition: noise calls, loop iterations, trigonometric operations, voronoi lookups.

#### Tier 1 — Utility (coordinate transforms, 10–20 pts)

| Node                 | Old | New    | Composition                    |
| -------------------- | --- | ------ | ------------------------------ |
| `tslTex_translator`  | 18  | **10** | Addition offset                |
| `tslTex_scaler`      | 20  | **12** | Multiplication only            |
| `tslTex_rotator`     | 22  | **18** | 2x sin/cos (8) + 4 mul + 2 add |
| `tslTex_supersphere` | 25  | **20** | Power-based formula            |

#### Tier 2 — Simple patterns (trig/step, no noise, 25–38 pts)

| Node                 | Old | New    | Composition             |
| -------------------- | --- | ------ | ----------------------- |
| `tslTex_grid`        | 28  | **25** | Step functions + mod    |
| `tslTex_satin`       | 38  | **28** | Sine waves              |
| `tslTex_zebraLines`  | 42  | **28** | Sine-based stripes      |
| `tslTex_circles`     | 32  | **30** | Distance + step         |
| `tslTex_polkaDots`   | 52  | **35** | Distance + smoothstep   |
| `tslTex_staticNoise` | 42  | **35** | Hash noise (no Perlin)  |
| `tslTex_stars`       | 55  | **38** | Random hash + threshold |

#### Tier 3 — Medium (single noise or moderate math, 45–62 pts)

| Node                    | Old | New    | Composition                 |
| ----------------------- | --- | ------ | --------------------------- |
| `tslTex_darthMaul`      | 50  | **45** | Pattern + color math        |
| `tslTex_scream`         | 50  | **48** | Distortion pattern          |
| `tslTex_watermelon`     | 52  | **48** | Stripes + noise             |
| `tslTex_camouflage`     | 45  | **52** | Noise + multi-threshold     |
| `tslTex_caveArt`        | 52  | **52** | Noise + threshold           |
| `tslTex_perlinNoise`    | 48  | **55** | Single 3D Perlin evaluation |
| `tslTex_isolines`       | 48  | **55** | Noise + step/fract          |
| `tslTex_tigerFur`       | 54  | **55** | Noise + directional stripes |
| `tslTex_dalmatianSpots` | 55  | **55** | Voronoi-based spots         |
| `tslTex_karstRock`      | 55  | **58** | Noise + color mapping       |
| `tslTex_isolayers`      | 52  | **58** | Multiple noise layers       |
| `tslTex_neonLights`     | 58  | **62** | Noise + glow calculations   |

#### Tier 4 — Heavy (FBM / multi-noise, 78–100 pts)

| Node                    | Old | New     | Composition                       |
| ----------------------- | --- | ------- | --------------------------------- |
| `tslTex_processedWood`  | 62  | **78**  | FBM + distortion                  |
| `tslTex_concrete`       | 72  | **80**  | FBM noise texture                 |
| `tslTex_fordite`        | 65  | **82**  | Layered patterns                  |
| `tslTex_marble`         | 68  | **85**  | FBM + sin wave distortion         |
| `tslTex_scepterHead`    | 70  | **85**  | Complex mathematical pattern      |
| `tslTex_waterDrops`     | 72  | **85**  | Voronoi + refraction              |
| `tslTex_romanPaving`    | 72  | **88**  | Voronoi + edge detection          |
| `tslTex_circleDecor`    | 80  | **88**  | Complex geometric pattern         |
| `tslTex_entangled`      | 75  | **90**  | Multi-noise combination           |
| `tslTex_reticularVeins` | 75  | **90**  | Voronoi-based veins               |
| `tslTex_roughClay`      | 78  | **92**  | FBM + surface detail              |
| `tslTex_crumpledFabric` | 78  | **92**  | FBM deformation                   |
| `tslTex_voronoiCells`   | 85  | **92**  | Voronoi + edge/cell coloring      |
| `tslTex_bricks`         | 90  | **95**  | Complex pattern + mortar + edge   |
| `tslTex_rust`           | 80  | **95**  | Multi-noise + color               |
| `tslTex_wood`           | 82  | **95**  | FBM + ring distortion             |
| `tslTex_brain`          | 82  | **98**  | Complex organic folds             |
| `tslTex_cork`           | 85  | **98**  | Noise + cellular pattern          |
| `tslTex_clouds`         | 82  | **100** | FBM 4–5 octaves                   |
| `tslTex_protozoa`       | 85  | **100** | Organic animation, multiple noise |

#### Tier 5 — Very heavy (domain warping, multi-layer, 115–165 pts)

| Node                    | Old | New     | Composition                           |
| ----------------------- | --- | ------- | ------------------------------------- |
| `tslTex_runnyEggs`      | 95  | **115** | Complex distortion                    |
| `tslTex_photosphere`    | 100 | **125** | HDR + complex spherical math          |
| `tslTex_planet`         | 105 | **135** | FBM + domain warping                  |
| `tslTex_caustics`       | 105 | **140** | Multiple Voronoi layers + animation   |
| `tslTex_gasGiant`       | 108 | **145** | Multi-FBM + banding                   |
| `tslTex_turbulentSmoke` | 110 | **155** | Domain-warped FBM (noise-into-noise)  |
| `tslTex_dysonSphere`    | 115 | **165** | Highest complexity, many noise layers |

---

## VR Headset Performance Comparison

### Hardware specifications

| Device              | GPU                | Process | FP32 TFLOPS | Resolution (total)    | Target Hz | Memory BW |
| ------------------- | ------------------ | ------- | ----------- | --------------------- | --------- | --------- |
| **Quest 2**         | Adreno 650         | 7nm     | ~1.1        | 7.03M (1832x1920 x2)  | 72/90/120 | ~44 GB/s  |
| **Pico 4**          | Adreno 660         | 5nm     | ~1.3        | 9.33M (2160x2160 x2)  | 72/90     | ~44 GB/s  |
| **Quest 3S**        | Adreno 660         | 5nm     | ~1.3        | 7.03M (1832x1920 x2)  | 90/120    | ~44 GB/s  |
| **Quest 3**         | Adreno 740         | 4nm     | ~3.0        | 9.11M (2064x2208 x2)  | 72/90/120 | ~50 GB/s  |
| **Steam Frame**     | Adreno 750         | 4nm     | ~2.8        | 9.33M (2160x2160 x2)  | 72–120    | ~51 GB/s  |
| **Vision Pro (M5)** | Apple M5 (10-core) | 3nm     | ~5.7        | ~25.8M (+10% over M2) | 90/96/120 | 153 GB/s  |

> [!note] Steam Frame is standalone, not PCVR
> Despite Valve's "streaming-first" positioning, WebGPU/A-Frame shaders run **locally** on the Adreno 750. The wireless PC streaming only applies to native SteamVR games — web content renders on-device.[^34][^35]

### Per-pixel fragment budget calculation

The effective per-pixel budget depends on TFLOPS, resolution, framerate, overdraw, and system overhead:

```
FLOPs/pixel = (TFLOPS x utilization x (1 - system_overhead)) / (total_pixels x FPS x overdraw)
```

| Device              | Pixels/frame | FPS | Overdraw | Util. | System OH | Eff. FLOPs/px |
| ------------------- | ------------ | --- | -------- | ----- | --------- | ------------- |
| **Quest 2**         | 7.03M        | 90  | 3x       | 50%   | 15%       | ~69           |
| **Pico 4**          | 9.33M        | 90  | 3x       | 50%   | 15%       | ~62           |
| **Quest 3S**        | 7.03M        | 90  | 3x       | 50%   | 15%       | ~82           |
| **Quest 3**         | 9.11M        | 90  | 3x       | 50%   | 15%       | ~155          |
| **Steam Frame**     | 9.33M        | 90  | 3x       | 50%   | 10%       | ~150          |
| **Vision Pro (M5)** | ~25.8M       | 96  | 1.5x[^a] | 60%   | 30%[^b]   | ~170          |

[^a]: Vision Pro uses Tile-Based Deferred Rendering — overdraw for opaque geometry is ~1x (only visible fragments shaded). Averaged to 1.5x including transparency.[^23]

[^b]: visionOS system compositor, passthrough cameras, hand tracking claim significant GPU share.[^24]

### Steam Frame vs Quest 3

Steam Frame (Adreno 750, ~2.8 TFLOPS) and Quest 3 (Adreno 740, ~3.0 TFLOPS) have nearly identical shader performance. Both render ~9M pixels at 90Hz. The Adreno 750 has a newer architecture with hardware ray tracing, but for ALU-bound procedural shaders the throughput is similar. SteamOS likely has slightly less compositor overhead than Android, giving it a small edge (~10%).[^33][^34]

### Why Vision Pro (M5) isn't 3x faster than Quest 3

Despite having 1.9x the TFLOPS (5.7 vs 3.0), Vision Pro renders **~2.83x more pixels** (~25.8M vs 9.11M, including the M5's 10% pixel boost). The M5's TBDR architecture helps with overdraw, and the 153 GB/s bandwidth (3x Adreno 740) ensures ALU-bound shaders aren't starved. However, the system compositor overhead remains heavy (~30%). Net result: Vision Pro M5 has roughly **1.7–1.8x** the effective per-shader budget of Quest 3.[^29][^30]

### Per-shader budget (3–5 shaders in scene)

Dividing effective budget by ~4 (average of 3–5 shaders weighted by screen coverage):

| Device              | Old maxPoints | **New maxPoints** | Change | Practical meaning                                                                   |
| ------------------- | ------------- | ----------------- | ------ | ----------------------------------------------------------------------------------- |
| **Pico 4**          | 100           | **80**            | -20%   | Basic patterns only. `polkaDots(35)` + math                                         |
| **Quest 2**         | —             | **90**            | new    | Slightly above Pico 4. `circles(30) + smoothstep(7) + mix(2)`                       |
| **Quest 3S**        | 120           | **110**           | -8%    | One medium texture + light math. `perlinNoise(55) + smoothstep(7)`                  |
| **Quest 3**         | 150           | **200**           | +33%   | One heavy texture + math pipeline. `marble(85) + hsl(15) + mix(2)`                  |
| **Steam Frame**     | 300           | **220**           | -27%   | Similar to Quest 3 + slight SteamOS edge. `marble(85) + pow(12) + hsl(15) + mix(2)` |
| **Vision Pro (M5)** | 400           | **350**           | -12%   | Heavy texture + complex pipeline. `clouds(100) + fractal(140) + mix(2)`             |

---

## Biggest Corrections Summary

| What                 | Old to New     | Impact                                                                         |
| -------------------- | -------------- | ------------------------------------------------------------------------------ |
| `pow()`              | 5 to **12**    | Was 2.4x undervalued. 3 chained SFU ops                                        |
| `sin()`/`cos()`      | 8 to **4**     | Was 2x overvalued. Single SFU instruction                                      |
| `hsl`/`toHsl`        | 5 to **15**    | Was 3x undervalued. Complex conditional color conversion                       |
| `fractal` (FBM)      | 80 to **140**  | Was 1.75x undervalued. 4 octaves x ~35 ALU each                                |
| Constructors         | 1–2 to **0**   | Were adding phantom cost. Register assignments are free                        |
| `normalize`/`length` | 3–4 to **7**   | Hidden SFU cost in the dot to sqrt/rsqrt chain                                 |
| `smoothstep`         | 4 to **7**     | Hidden division cost often overlooked                                          |
| Steam Frame          | 300 to **220** | Was treated as PCVR — actually standalone Adreno 750                           |
| Vision Pro           | 400 to **350** | M5 (5.7 TFLOPS) is powerful but ~26M pixels + system compositor cap the budget |

---

## Sources

[^1]: [The Hidden Cost of Shader Instructions — Interplay of Light (2025)](https://interplayoflight.wordpress.com/2025/01/19/the-hidden-cost-of-shader-instructions/) — AMD GCN/RDNA instruction throughput analysis, SFU quarter-rate pattern

[^2]: [ARM Mali Valhall Shader Core — ARM Documentation](https://documentation-service.arm.com/static/660e84991bc22b03bca93008) — 16-wide FMA + 4-wide SFU pipeline documentation

[^3]: [Apple GPU Microarchitecture Benchmarks — Philip Turner](https://github.com/philipturner/metal-benchmarks) — Apple GPU instruction throughput (sin: 14-cycle, rcp: 6-cycle, rsqrt: 8-cycle)

[^4]: [ARM Mali Valhall Architecture Notes](https://github.com/azhirnov/cpu-gpu-arch/blob/main/gpu/ARM-Mali-Valhall.md) — Detailed pipeline width documentation

[^5]: [Adreno 660 GPU Specs — NotebookCheck](https://www.notebookcheck.net/Qualcomm-Adreno-660-GPU-Benchmarks-and-Specs.513908.0.html) — Adreno 660 specifications (Quest 3S / Pico 4)

[^6]: [Inside Qualcomm's Adreno 530 — Chips and Cheese](https://chipsandcheese.com/p/inside-qualcomms-adreno-530-a-small-mobile-igpu) — Adreno architecture deep dive

[^7]: [Adreno 740 GPU Specs — NotebookCheck](https://www.notebookcheck.net/Qualcomm-Adreno-740-GPU-Benchmarks-and-Specs.669947.0.html) — Adreno 740 specifications (Quest 3)

[^8]: [Snapdragon XR2 Gen 2 GPU Analysis — UploadVR](https://www.uploadvr.com/snapdragon-xr2-gen-2/) — Quest 3 GPU performance (~2.5x Quest 2)

[^9]: [Shader Performance Tips — Unity Manual](https://docs.unity3d.com/Manual/SL-ShaderPerformance.html) — Constructor and register operation costs

[^10]: [Adreno GPU Best Practices — Qualcomm](https://docs.qualcomm.com/doc/80-78185-2/topic/mobile_best_practices.html) — Source modifiers (abs, negate) are free

[^11]: [Shader Optimization Reference — Shader Wiki](https://shaders.fandom.com/wiki/Shader_Optimization) — SFU instruction costs relative to ALU

[^12]: [GPU Performance Analysis — Sebastien Lagarde](https://seblagarde.wordpress.com/tag/gpu-performance/) — pow() decomposition into exp2/log2 chain

[^13]: [Smoothstep Analysis — Inigo Quilez](https://iquilezles.org/articles/smoothsteps/) — Smoothstep computational breakdown

[^14]: [RGB/HSV/HSL Conversion — Chilliant](https://chilliant.com/rgb2hsv.html) — Optimized branchless color space conversion instruction counts

[^15]: [Implementing Improved Perlin Noise — GPU Gems 2, NVIDIA](https://developer.nvidia.com/gpugems/gpugems2/part-iii-high-quality-rendering/chapter-26-implementing-improved-perlin-noise) — 3D Perlin noise compiled instruction count (~50 per evaluation)

[^16]: [Quest VR Optimized Shaders — GitHub](https://github.com/roundyyy/quest-vr-optimized-shaders) — FBM octave costs for mobile VR shaders

[^17]: [Quest 3 Specifications — VRCompare](https://vr-compare.com/headset/metaquest3) — Resolution, refresh rate specs

[^18]: [Quest 3S Specifications — VRCompare](https://vr-compare.com/headset/metaquest3s) — Resolution, refresh rate specs

[^19]: [Pico 4 Specifications — PICO](https://www.picoxr.com/global/products/pico4/specs) — Hardware specifications

[^20]: [Apple Vision Pro Specifications — Apple](https://www.apple.com/apple-vision-pro/specs/) — M5 chip, display specs

[^21]: [Apple M5 — Wikipedia](https://en.wikipedia.org/wiki/Apple_M5) — 10-core GPU, 5.7 TFLOPS, 153 GB/s, 3nm

[^22]: [GeForce RTX 30/40 Series — Wikipedia](https://en.wikipedia.org/wiki/GeForce_RTX_30_series) — RTX 3060 12.7 TFLOPS, memory bandwidth

[^23]: [PC Rendering Techniques to Avoid on Mobile VR — Meta](https://developers.meta.com/horizon/blog/pc-rendering-techniques-to-avoid-when-developing-for-mobile-vr/) — Overdraw guidelines, TBDR benefits

[^24]: [Creating a Performance Plan for visionOS — Apple Developer](https://developer.apple.com/documentation/visionos/creating-a-performance-plan-for-visionos-app) — System compositor GPU overhead, frame timing

[^25]: [WebXR Performance Workflow — Meta Developer](https://developers.meta.com/horizon/documentation/web/webxr-perf-workflow/) — WebGL/WebGPU overhead vs native (~20–30%)

[^26]: [WebXR Scene Optimization — Toji](https://toji.dev/webxr-scene-optimization/) — Fragment shading as primary VR bottleneck

[^27]: [Adreno Offline Compiler for Quest — Meta](https://developers.meta.com/horizon/blog/unreal-engine-adreno-offline-compiler-meta-quest/) — Getting actual instruction counts from Adreno compiler

[^28]: [Variable Rate Shading on Adreno GPUs — Keaukraine](https://keaukraine.medium.com/variable-rate-shading-on-adreno-gpus-7cbfa2864543) — Adreno 660 VRS capabilities

[^29]: [Apple Vision Pro upgraded with M5 chip — Apple Newsroom (Oct 2025)](https://www.apple.com/newsroom/2025/10/apple-vision-pro-upgraded-with-the-m5-chip-and-dual-knit-band/) — M5 specs, 10% more pixels, 120Hz, hw ray tracing

[^30]: [Apple M5 GPU Specs — NotebookCheck](https://www.notebookcheck.net/Apple-M5-GPU-Benchmarks-and-Specs.1139076.0.html) — 5.7 TFLOPS FP32, 153 GB/s bandwidth

[^31]: [M5 vs M2 Apple Vision Pro — AppleInsider](https://appleinsider.com/articles/25/10/16/m5-apple-vision-pro-vs-m2-apple-vision-pro-improved-spatial-computing) — Side-by-side comparison

[^32]: [Apple Vision Pro M5 Specs — VRCompare](https://vr-compare.com/headset/applevisionprom5) — Full hardware specifications

[^33]: [Adreno 750 GPU Specs — NotebookCheck](https://www.notebookcheck.net/Qualcomm-Adreno-750-GPU-Benchmarks-and-Specs.762136.0.html) — Adreno 750 specifications, ~2.8 TFLOPS

[^34]: [Valve Steam Frame Official Announcement — UploadVR](https://www.uploadvr.com/valve-steam-frame-official-announcement-features-details/) — Snapdragon 8 Gen 3, 2160x2160, streaming-first standalone

[^35]: [Steam Frame — Wikipedia](https://en.wikipedia.org/wiki/Steam_Frame) — Specifications, SteamOS, wireless PC streaming

[^36]: [Quest 2 — Wikipedia](https://en.wikipedia.org/wiki/Quest_2) — Snapdragon XR2, Adreno 650, 1832x1920/eye, ~1.1 TFLOPS

[^37]: [How Powerful Is Quest 2? — UploadVR](https://www.uploadvr.com/oculus-quest-2-benchmarks/) — GPU benchmarks, Adreno 650 performance analysis
