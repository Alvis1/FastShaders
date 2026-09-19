# benchData — committed calibration runs

A finished run downloads **one** file by default — the device profile
`shadercarousel-<bench>-<device>-profile-<ts>.json`, which is what the editor's
cost bar imports. Research data is the second button,
**⬇ Research data (raw + CSV + suggestion)**, and that is what this directory is
for:

- `shadercarousel-<bench>-<device>-<ts>.json` — raw payload (per-batch samples, full metadata)
- `shadercarousel-<bench>-<device>-summary-<ts>.csv` — one row per shader
- `shadercarousel-<bench>-<device>-complexity-suggestion-<ts>.json` — suggested points, diffable against `src/registry/complexity.json`

`<device>` is a slug derived from the run's metadata (`quest-3`, else the adapter
string). Files committed before 2026-08 predate it and carry no device segment.

**Move the raw JSON + suggestion JSON here and commit them.** Browser downloads
evaporate; this directory is what closes the measure → suggest → `complexity.json`
loop and keeps every update to the point table auditable back to a run.

## Calibration corpus + `fit-calibration.mjs`

`lib/bench-registry.js` has four opt-in groups built for pricing nodes precisely
(all OFF by default — tick their master checkboxes in the picker, ideally in
**MicroPlane**):

- **Calibration (k-sweep)** — `calib_<op>_x{1,4,16}`: each op evaluated k times on
  **distinct, runtime-varying, independent** inputs, accumulated into the output.
  Marginal per-pass cost is linear in k; the slope is one op instance's cost.
  `calib_scaffold_x{1,4,16}` is the same loop *without* the op — its slope is the
  per-copy overhead, subtracted out. DCE/CSE-safe by construction: per-fragment +
  per-copy distinct seeds wrapped in a non-linear `fract()` (so the scaffold can't
  algebraically collapse), everything sunk into the returned colour. Copies are
  *independent* (not a serial chain) so the slope measures **throughput**, which
  is what a high-occupancy VR shader should be priced against.
- **Texture atoms (per fetch)** — `texture_imageNode` (a 2048² mipmapped sRGB
  image) and `texture_colormap` (the 256×1 half-float LUT a Colormap node
  samples). Each runs 16 fetches and carries `copies: 16`, because one fetch
  sits under MicroPlane's timer floor. These two are what a device profile
  prices `imageNode`/`colormap` from.
- **Texture calibration (k-sweep)** — `calib_tex_<cfg>_x{1,4,16}` over 256 / 1024
  / 2048 / 4096 mipmapped sRGB images, a 2048 data map without mips,
  quarter-size-object variants of the 2048 pair (`…q`) and the LUT, plus
  their OWN scaffold `calib_tex_scaffold_x{1,4,16}`. **The scaffold is per
  family**: a texture copy's overhead is its UV derivation, not the ALU seed,
  so `tex_*` ops subtract `tex_scaffold` and every other op subtracts
  `scaffold`. The textures are generated in the page (hashed and
  incompressible: RGBA8 images, an RGBA half-float LUT; no network).
- These texture groups exist only because every bench passes `THREE` as
  well as `TSL` to `buildBenchRegistry`. They stay OFF in every bench until a
  Quest 3 run passes the acceptance gates in `METHODS.md` §6.
- **Combinations** — additivity (`combo_sin4_sqrt4`, `combo_perlin4_voronoi4`,
  and `combo_tex4_perlin4` for texture/ALU overlap: does
  `cost(A+B) ≈ cost(A)+cost(B)`?), ILP (`combo_sqrt_parallel8` vs
  `_chain8`: throughput vs latency), an end-to-end `combo_model_check` (documented
  node inventory ≈127 pts — does the sum predict the whole?), and two DCE
  sentinels (`combo_dce_dropped`/`_kept`: fBm×4 weighted 0 vs 0.25 — dropped should
  measure ≈ baseline, proving the accumulation elsewhere is load-bearing).

**`marginalPoints` is PER COPY for rows that carry `copies`.** `bench-stats`
divides the whole-shader marginal by `copies` (16 for the two per-fetch atoms)
and records the divisor in `stats.copies`, on the suggestion row and in the
CSV's `copies` column. `marginalMs` and `marginalMsAtRef` stay whole-shader
figures. A row without `copies` is priced exactly as before.

**To analyse a MicroPlane run:**

```
node fit-calibration.mjs shadercarousel-microplane-<device>-<ts>.json [--texture-json <out>.json]
```

A Static raw file works too: the texture sweep runs on either bench.
`fit-calibration.mjs` is only the CLI (arguments, file reads, the JSON
write); everything it computes lives in the pure `fit-core.mjs`, which
`src/registry/fitCalibration.test.ts` imports and pins. That includes
`IMAGE_CURVE`, fit-core's restatement of `nodeCost.ts`'s `IMAGE_COST_*`
constants, so the two move in the same commit.

The input is the **raw** results file, not the `-complexity-suggestion` sibling.
The **Calibration** group must have been ticked in the picker for that run —
it is off by default, and against a run without it the script prints a scaffold
slope of zero, an empty op table and "missing data" for every combination. (The
one run committed here, `quest3-20260723/`, is such a run: it measured the noise
atomics, not the sweep.)

Fits the k-sweep by OLS (per op: net ms/copy, R², suggested points, diff vs the
current table, `mispriced`/`nonlinear?` flags), then reports additivity ratios,
the sqrt ILP ratio, and the DCE-sentinel check. When the run carries the
texture sweep it adds a **Texture atoms** block: per-atom points and R², the
Image node's size curve (a suggested `IMAGE_COST_MIN_SCALE`, the log-linear
residual at 1024 px, the 4096/2048 flat check), the coherence ratios, the
per-fetch profile cross-check and flags. `--texture-json` writes that block
as JSON; a run without the texture sweep writes `{ "texture": null }` and
exits 1. Low R² ⟹ the op isn't a clean
line (amortization / register-pressure — the slope is an average, not a constant).
`below-scaffold` ⟹ the op is under the timer floor at this resolution; raise
`input-size` or `K_LEVELS`. See `METHODS.md` for how this fits into the full
recovery pipeline (isolation → composed-corpus NNLS/DoE regression → static
cross-check) and why the shipped table stays additive.

## Layout

```
benchData/
  <device>-<date>/          e.g. quest3-20260723/ (the texture run: quest3-<YYYYMMDD>-tex/)
    shadercarousel-<bench>-<device>-<ts>.json
    shadercarousel-<bench>-<device>-complexity-suggestion-<ts>.json
```

**A raw run carrying texture atoms changes what the test suite asserts.**
`src/registry/textureSampleCost.test.ts` looks through this directory by file
CONTENT, not by name. The moment a raw JSON here holds a `calib_tex_*` or
`texture_*` row, it stops checking the authored ordering and starts checking
the measurement: `complexity.json`'s meta must name the run's directory, and
`imageNode`/`colormap` must sit within 10 % of what `fit-core.mjs` derives
from it (`pickShippingRun` picks among the runs that can price: Static first,
then the latest). So
commit such a run TOGETHER with the repricing (METHODS.md §6), never on its
own. On its own it turns `npm test` red, and `release.yml` runs `npm test`
before it builds anything.

## Before trusting a suggestion file

Check `metadata` in the **suggestion** JSON. The raw export carries the run's
metadata but no validity block — `valid` / `reasons` are added by the suggestion
emitter, which is why `fit-calibration.mjs` prints `valid: ?` right beside a
`timingMethod` it read straight out of the raw file. The profile carries a
smaller `meta` block: it keeps the provenance (`schemaVersion`, `kind`, `source`,
`bench`, `device`, `generatedAt`, `note`) plus `valid`, `reasons`,
`timingMethod`, `resolution` and `refPixels`, and drops the suggestion's
`adapterInfo`, `browser`, `quantized`, `clockPinned`, `stereo`,
`resolutionScale` and `budgetMs`. Schema v2:

- `valid` — false means the run cannot price nodes; `reasons[]` says why
  (`baseline-missing`, `vsync-clamped`, `resolution-unknown`, `raf-delta timing`, …)
- `timingMethod` — `gpu-timestamp` (GPU pass time, preferred) vs
  `wallclock-fence` (includes CPU noise) vs `raf-delta` (InOut; budget-fit only)
- `quantized` — GPU timestamps 100 µs-quantized (Chrome default). Calibrate on a
  dev machine with `chrome://flags/#enable-webgpu-developer-features` for
  nanosecond precision; quantized runs are still usable (multi-pass amortizes)
- `resolutionScale` — marginal ms was scaled by `refPixels / (w·h)` so points are
  in the shared currency (100 pts = 8.33 ms @ 2064×2208)
- `stereo` / `clockPinned` / `adapterInfo` — never blind-average runs that differ
  in these; bridge via shared anchor workloads instead

When updating `src/registry/complexity.json` from a suggestion file, reference the
committed run file in the commit message so the provenance chain stays intact.
