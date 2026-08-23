# ShaderCarousel

The benchmark suite behind FastShaders' cost bar. It measures what each shader
node actually costs on **this** GPU, and hands the result back to the editor so
the points shown while you build a shader are measured numbers rather than
guesses.

Three purpose-built pages share one launcher, one shader corpus and one
stats/export library — they differ in how that corpus is timed. No build step;
it is static HTML.

## Quick start

Open the launcher on the deployed site (`<base>/ShaderCarousel/`, the editor's
**SC** link), or locally:

```bash
npm run dev
# → http://localhost:5173/FastShaders/ShaderCarousel/
```

Press **▶ Benchmark this device**. That is the whole flow: it loads MicroPlane —
the per-node pricing mode — and presses its start gate for you. Roughly three
minutes; it never enters VR. On a first visit it runs the shipped corpus
(baseline + the eight noise atomics); the picker and settings then persist per
browser, so a returning user gets whatever they last selected — check
**Advanced** if you have changed them.

When it finishes, a FastShaders tab on the **same origin** offers the run in its
cost bar as a one-click chip. That is why those two are the paths to prefer:
`localStorage` is origin-scoped, so the suite and the editor have to be served
together. From anywhere else — including the plain static server below —
download the profile `.json` and drag it onto the cost bar instead.

The suite is static HTML with no build step, so any http(s) server works:

```bash
cd FastShaders && python3 -m http.server 8765
# → http://127.0.0.1:8765/ShaderCarousel/
```

(`npm run preview` serves the built site on port 4173. The old warning against
Vite's dev server is obsolete — a dev-only resolver now reads each bench page's
own import map.)

**A server of some kind is required** — the bench pages load their driver as an
ES module and the launcher reads the iframe's document, so opening `index.html`
from disk does nothing. `localhost` and `127.0.0.1` count as secure contexts, so
WebGPU works there with no flags; a plain-HTTP **LAN** address does not — see
[Running on a headset](#running-on-a-headset).

## The three benches

| Bench | Path | Renderer | What it measures | Prices nodes? |
| --- | --- | --- | --- | --- |
| **MicroPlane** *(default)* | [`bench-microplane/`](./bench-microplane/) | WebGPU, three r184 | Multi-pass over a 1024² orthographic full-frame quad. Isolates per-node cost by subtracting the flat-colour baseline; the fastest way to price a device, and the only one that can drive the k-sweep. | **Yes** |
| **Sphere Static** | [`bench-static/`](./bench-static/) | WebGPU, three r184 | The same multi-pass timing on a full-coverage sphere rendered at 2064×2208 (Quest 3 per-eye), i.e. natively at the reference resolution — no scaling needed. | **Yes** |
| **Sphere InOut** | [`bench-inout/`](./bench-inout/) | A-Frame 1.8.0 (WebGL2) | Frame deltas inside a real immersive WebXR session while a sphere ping-pongs through the camera. Answers "does the whole shader fit the frame budget". | **No** — see below |

InOut logs one animation-loop delta per **presented frame** (not per eye), which
is refresh-quantized, and it records no render resolution — so its export is
always stamped `valid: false` with reasons `raf-delta timing` and
`resolution-unknown`, and it never writes a device profile. It is a budget-fit
instrument, not a pricing one.

The two WebGPU benches defeat vsync clamping, clock granularity **and** fixed
per-batch overhead at once: each shader's pass count is calibrated upward until
a batch spans ~20 ms, then measured at both *N* and *2N* passes, and the
per-pass cost is taken as the **slope** so the constant overhead cancels. The
30-pass default is a floor, not the count.

Mode selection lives in the collapsed **Advanced** panel; `?mode=bench-static`
deep-links one, and the choice is remembered. `M` toggles the sidebar.

## What a run produces

A MicroPlane or Static run downloads **one file** by default:

- `shadercarousel-<bench>-<device>-profile-<ts>.json` — the `{ meta, costs }`
  device profile (~1 KB) the FastShaders cost bar imports.

A single download is deliberate; three would trip the browser's
"download multiple files" prompt. The rest is behind a second button,
**⬇ Research data (raw + CSV + suggestion)**:

- `shadercarousel-<bench>-<device>-<ts>.json` — raw frames + per-shader stats
- `shadercarousel-<bench>-<device>-summary-<ts>.csv` — one row per shader, 18 columns
- `shadercarousel-<bench>-<device>-complexity-suggestion-<ts>.json` — implied
  points per shader, **plus the validity block**

InOut has only the single button, and it produces the three research files.

`<device>` is a slug taken from the headset name in the user-agent where there
is one (`quest-3`), falling back to the adapter string
(`qualcomm-adreno-7xx`). `<ts>` is minute-precision UTC (`2026-08-22T1234`).

### How a shader becomes points

```
marginal      = msPerPass(shader) − msPerPass(baseline)
marginalAtRef = marginal × 4557312 / measuredPixels     # 2064 × 2208
points        = max(0, round(marginalAtRef / 8.33 × 100))
```

100 points ≡ 8.33 ms ≡ one frame of a 120 Hz single-eye budget. **The
resolution normalization is not optional** — MicroPlane's 1024² quad is 4.35×
smaller than the reference, and omitting the scale under-reports its points by
exactly that factor.

The suggestion file carries `metadata.valid` and the profile `meta.valid`, each
with a machine-readable `reasons[]`. A run is valid only with the baseline
present, no vsync clamping, a known resolution, non-`raf-delta` timing and at
least two samples per shader. **The raw export carries no validity block** —
check the suggestion or profile file, not the raw one.

The baseline (`ref_baseline`, flat `#888888`) is a normal, user-toggleable
picker entry that happens to default on and to sort first. Untick it and every
marginal figure becomes null.

## Getting a result into FastShaders

Four entrances, all through the same validating parser:

1. **The handoff chip** — a finished WebGPU run writes its profile to
   `localStorage['fs:benchResult']`, and a FastShaders tab on the same origin
   shows an *Add* chip in the cost bar (live, via the cross-tab `storage`
   event; already-imported runs read as consumed).
2. **Drag** a `.json` onto the cost bar.
3. The device dropdown's **Import result JSON…** row.
4. **Drop** a `.json` on the code panel.

The profile, the suggestion file and the **raw** results export are all
accepted. The last mile into `src/registry/complexity.json` stays manual: the
cost bar's **⭳ complexity.json** button downloads the authored table with the
active profile merged over it and a provenance note, for you to commit.

## The shader corpus

75 built-in entries in five groups (plus any saved groups found in
`localStorage['fs:savedGroups']`, which are **listed but always disabled** —
running editor-authored TSL would mean executing arbitrary JS at the bench's
origin, and the inline path was removed for that reason).

| Group | Count | Default | What it is |
| --- | --- | --- | --- |
| Baseline | 1 | on | Flat colour — the subtrahend for every marginal figure |
| Presets | 8 | on¹ | Inline ports of the editor's built-in textures |
| Noises (atomic) | 8 | on | The MaterialX noise family, called the way `graphToCode` emits it |
| Calibration (k-sweep) | 51 | **off** | 3 scaffolds + 16 ops × k ∈ {1, 4, 16} |
| Combinations | 7 | **off** | Additivity, ILP and DCE sentinels |

¹ on in Static and InOut; MicroPlane defaults to **baseline + noise** only
(9 shaders).

The k-sweep is what makes per-op pricing possible. Each op is evaluated k times
on per-fragment *and* per-copy seeds, all accumulated into the output and
wrapped in a non-linear `fract()` so nothing can be dead-code-eliminated or
common-subexpression-folded away; cost is linear in k and the slope is the cost
of **one instance**. The `calib_scaffold_x{k}` entries are the same loop with
the op removed, so subtracting their slope removes the per-copy overhead too —
finer than baseline subtraction alone.

## Calibration workflow

To derive per-node points rather than per-shader ones:

1. Run **MicroPlane** with the **Calibration** group ticked in the picker (it
   is off by default), plus Combinations if you want the integrity checks.
2. Download the **research data** — `fit-calibration.mjs` needs the *raw*
   export, not the suggestion file.
3. Regress it:

   ```bash
   cd ShaderCarousel/benchData
   node fit-calibration.mjs <run>/shadercarousel-microplane-*.json
   ```

   It prints per-op suggested points (net of the scaffold), diffed against the
   current `src/registry/complexity.json`, and flags `nonlinear?` (R² < 0.97),
   `below-scaffold` (op under the timer floor) and `mispriced`. Then it checks
   additivity, an ILP ratio and the DCE sentinels.
4. Commit the raw + suggestion files under `benchData/<device>-<date>/` (e.g.
   `quest3-20260723/`) and reference them in the commit message that changes
   `complexity.json`.

[`benchData/`](./benchData/) holds one committed run, `quest3-20260723/` — a
Quest 3 (Adreno 7xx) on Oculus Browser 149, GPU-timestamp timing, MicroPlane at
1024² and Static natively at 2064×2208, both `valid: true`. That pair is what
repriced the noise family (voronoi had been ~4× underpriced) and it is the basis
for the cost bar's 200-point Quest 3 budget. The shipped numbers track the
**Static** run — measured at the reference resolution, so nothing had to be
scaled — with MicroPlane agreeing after its 4.35× normalization, which is the
cross-check `complexity.json`'s provenance note refers to. It was run **without** the
Calibration group, so `fit-calibration.mjs` has no committed run to chew on yet.

[`benchData/METHODS.md`](./benchData/METHODS.md) is the research protocol and
its accuracy ceiling. Numbers from a desktop GPU do not transfer to Adreno — the
headset run is what must set the shipped values.

## Running on a headset

WebXR and WebGPU need a secure origin, and a plain LAN address is not one. The
FastShaders **desktop app** carries a read-only LAN server for this: the
toolbar's **VR** button starts it on port 5199 (ephemeral fallback) serving the
bundled carousel, and shows the `http://<lan-ip>:5199/` URL to open on the
headset. One of two one-time per-headset fixes is then needed, both documented
in that popover:

- Headset browser → `chrome://flags` → *Insecure origins treated as secure* →
  add `http://<ip>:5199`, relaunch the browser; **or**
- USB developer mode → `adb reverse tcp:5199 tcp:5199`, then open
  `http://localhost:5199/` on the headset.

Plain HTTP is a deliberate choice — a self-signed certificate would throw a
warning interstitial on the headset anyway.

For high-precision GPU timestamps on a desktop Chrome, enable
`chrome://flags/#enable-webgpu-developer-features`; without it timestamps are
100 µs-quantized (still usable — the multi-pass loop amortizes it, and the run
records `quantized: true`).

## Layout

```
index.html            launcher — one primary button, mode switch in Advanced
images/               favicon (relative href — the tree is copied verbatim)
sphere-mover.js       the InOut ping-pong A-Frame component
bench-inout/          A-Frame + WebXR ping-pong bench
bench-static/         WebGPU sphere at Quest 3 per-eye resolution
bench-microplane/     WebGPU 1024² quad — the pricing bench
lib/
  bench-driver.js     shared WebGPU boot / calibrate / measure / export driver
  bench-timing.js     multi-pass wall clock + WebGPU timestamp queries
  bench-stats.js      stats, marginal-cost annotation, validity gate, exports
  bench-registry.js   the one shader corpus, built against a TSL namespace
  bench-ui.js         picker, settings, start gate, done popup, headset detect
  bench-style.css     the one stylesheet all three pages link
  three/              three r184 WebGPU ESM builds (import-map target)
components/three/     A-Frame 1.8.0 IIFE bundle (vendor-synced, do not edit)
benchData/            committed runs, METHODS.md, fit-calibration.mjs
context.md            design rationale + paper-section mapping
```

`components/three/a-frame-180-a-01.min.js` is copied in from the
`a-frame-shaderloader` submodule by a Vite plugin and pinned by a drift test —
edit the submodule source, never this copy.

## Deployment

On a web build the suite is copied into `dist/ShaderCarousel/` and is live at
`<base>/ShaderCarousel/` (the editor's **SC** toolbar link). `benchData/` is
excluded, and `bench-inout` is rewritten to share the app's A-Frame bundle —
which means **the dist copy is not portable on its own**; to move the suite
elsewhere, copy this source tree, which is self-contained.

On a desktop build it is excluded from `dist/` and staged into
`src-tauri/carousel-dist/` as a Tauri resource for the LAN server, keeping its
own bundle.

## Design notes

[`context.md`](./context.md) has the longer design rationale and the
paper-section mapping. Treat its *status* sections as historical — they predate
the 2026-07-23 measured run and still describe the calibration loop as never
closed.

## Contact

Alvis Misjuns · [alvis.misjuns@va.lv](mailto:alvis.misjuns@va.lv) · [alvismisjuns.lv](https://alvismisjuns.lv)
