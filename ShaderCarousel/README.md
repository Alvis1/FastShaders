# ShaderCarousel

Benchmark suite for the FastShaders paper. Three purpose-built pages, one
unified launcher, one shared infrastructure.

| Bench | Path | Purpose |
| --- | --- | --- |
| **Sphere InOut** | [`bench-inout/`](./bench-inout/) | Immersive WebXR (A-Frame WebGL) — sphere ping-pongs through the camera; logs true stereoscopic per-eye frametimes. Quest 3 target. |
| **Sphere Static** | [`bench-static/`](./bench-static/) | WebGPU multi-pass on a full-coverage sphere @ 2064×2208 (Quest 3 per-eye). 30 passes per measurement defeat desktop vsync clamping. |
| **MicroPlane** | [`bench-microplane/`](./bench-microplane/) | WebGPU multi-pass on a 1024² ortho quad (512² was the original default). Defaults to noise atomics + baseline — for deriving per-node points by subtraction. No XR. |

## Run locally

ShaderCarousel is static HTML — no build step. Serve the FastShaders repo
root over plain HTTP and open `ShaderCarousel/index.html`:

```bash
cd FastShaders
python3 -m http.server 8765
# → http://127.0.0.1:8765/ShaderCarousel/
```

Do **not** use Vite's dev server here — it interferes with the WebGPU import
maps the benches rely on.

## What each run produces

Every bench writes three files when it finishes:

1. `shadercarousel-<bench>-<timestamp>.json` — raw frames + per-shader stats
2. `shadercarousel-<bench>-summary-<timestamp>.csv` — one row per shader
3. `shadercarousel-<bench>-complexity-suggestion-<timestamp>.json` — maps
   each measured shader to its implied complexity points
   (`marginalMs / 8.33 × 100`), diffable against
   [`src/registry/complexity.json`](../src/registry/complexity.json)

The first shader of every run is the flat-color baseline. Marginal cost
(median − baseline median) is the quantity the suggestion file uses, so the
output isolates each shader's contribution above scene + driver fixed
overhead.

## Architecture & defaults

See [`context.md`](./context.md) for full design rationale, the paper-section
mapping (which bench closes which calibration gap), and the saved-groups
loader status.

## Contact

Alvis Misjuns · [alvis.misjuns@va.lv](mailto:alvis.misjuns@va.lv) · [alvismisjuns.lv](https://alvismisjuns.lv)
