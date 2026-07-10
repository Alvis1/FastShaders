# benchData — committed calibration runs

The benches export three browser downloads per run:

- `shadercarousel-<bench>-<ts>.json` — raw payload (per-batch samples, full metadata)
- `shadercarousel-<bench>-summary-<ts>.csv` — one row per shader
- `shadercarousel-<bench>-complexity-suggestion-<ts>.json` — suggested points, diffable against `src/registry/complexity.json`

**Move the raw JSON + suggestion JSON here and commit them.** Browser downloads
evaporate; this directory is what closes the measure → suggest → `complexity.json`
loop and keeps every update to the point table auditable back to a run.

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
