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

`lib/bench-registry.js` has two opt-in groups built for pricing nodes precisely
(both OFF by default — tick their master checkboxes in the picker, ideally in
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
- **Combinations** — additivity (`combo_sin4_sqrt4`, `combo_perlin4_voronoi4`:
  does `cost(A+B) ≈ cost(A)+cost(B)`?), ILP (`combo_sqrt_parallel8` vs
  `_chain8`: throughput vs latency), an end-to-end `combo_model_check` (documented
  node inventory ≈127 pts — does the sum predict the whole?), and two DCE
  sentinels (`combo_dce_dropped`/`_kept`: fBm×4 weighted 0 vs 0.25 — dropped should
  measure ≈ baseline, proving the accumulation elsewhere is load-bearing).

**To analyse a MicroPlane run:**

```
node fit-calibration.mjs shadercarousel-microplane-<device>-<ts>.json
```

The input is the **raw** results file, not the `-complexity-suggestion` sibling.
The **Calibration** group must have been ticked in the picker for that run —
it is off by default, and against a run without it the script prints a scaffold
slope of zero, an empty op table and "missing data" for every combination. (The
one run committed here, `quest3-20260723/`, is such a run: it measured the noise
atomics, not the sweep.)

Fits the k-sweep by OLS (per op: net ms/copy, R², suggested points, diff vs the
current table, `mispriced`/`nonlinear?` flags), then reports additivity ratios,
the sqrt ILP ratio, and the DCE-sentinel check. Low R² ⟹ the op isn't a clean
line (amortization / register-pressure — the slope is an average, not a constant).
`below-scaffold` ⟹ the op is under the timer floor at this resolution; raise
`input-size` or `K_LEVELS`. See `METHODS.md` for how this fits into the full
recovery pipeline (isolation → composed-corpus NNLS/DoE regression → static
cross-check) and why the shipped table stays additive.

## Layout

```
benchData/
  <device>-<date>/          e.g. quest3-20260723/
    shadercarousel-<bench>-<device>-<ts>.json
    shadercarousel-<bench>-<device>-complexity-suggestion-<ts>.json
```

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
