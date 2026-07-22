# benchData — committed calibration runs

The benches export three browser downloads per run:

- `shadercarousel-<bench>-<ts>.json` — raw payload (per-batch samples, full metadata)
- `shadercarousel-<bench>-summary-<ts>.csv` — one row per shader
- `shadercarousel-<bench>-complexity-suggestion-<ts>.json` — suggested points, diffable against `src/registry/complexity.json`

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
node fit-calibration.mjs shadercarousel-microplane-<ts>.json
```

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
  <device-slug>/            e.g. m4-max/, quest3/
    shadercarousel-<bench>-<ts>.json
    shadercarousel-<bench>-complexity-suggestion-<ts>.json
```

## Before trusting a suggestion file

Check `metadata` in the suggestion JSON (schema v2):

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
