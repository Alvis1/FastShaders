# Node minus control: a brute-force method for per-node GPU cost

Proposed 2026-10-01. **Not yet run on a headset.** The bench cannot run it as it
stands today; §10 lists what has to be built first. `METHODS.md` in this folder
is the long research report (regression, experimental design, offline
compilers). This file is the short alternative: no model, only subtraction,
division and a median, and every number ships with pass/fail lines a stranger
can recompute.

Throughout, **measured** means read from a file or timed in this repo, and
**projected** means derived from such numbers but never run.

## 1. The method in five sentences

1. For each node build two shaders: one holding K independent copies of the
   node, each on a different per-pixel input, all added into the output colour;
   and a **control** that is the same shader with the node taken out.
2. Time both on the Quest 3 in the MicroPlane bench at its default settings.
   The cost of one node is (node shader − control shader) ÷ K.
3. Do it again with 2K copies. The cost per copy must come out the same.
4. Time every shader twice in mirrored order, with the control re-timed before,
   between and after. How far the two timings of one shader disagree is the
   session's noise floor.
5. A number is published only if every check in §5 passes; otherwise the row
   names the failed check and the old price stays. At the end the new prices
   are summed over real preset shaders and compared with those shaders timed
   whole.

## 2. The arithmetic

- **Reading** `r`: the bench's own ms per pass,
  `(median(hi totals) − median(lo totals)) / (passesHi − passesLo)`
  (`slopeMsPerPass` in `lib/bench-stats.js`). Each batch total is in the raw
  file, so `r` is recomputed, never trusted. Measured: recomputing it from the
  committed Quest 3 run reproduces the stored value for all 9 shaders.
- Each shader is read twice, `rA` and `rB`. **Value** `v = (rA + rB) / 2`.
  **Disagreement** `d = |rA − rB|`.
- **Floor** `F = 2 × median(d)` over every shader of the session, in ms per
  pass. It is the size a difference must exceed to be more than noise.
- **Net** `net(K) = v(node shader, K copies) − c(K)`, where `c(K)` is the
  median of all readings of that control in the block.
- **Cost per copy** `= net(2K) / (2K)`.
- **Points** `= cost per copy × 52.18` at 1024×1024. (One point is 8.33 ms ÷
  100 at 2064×2208, which is 0.01917 ms per pass at 1024×1024; the constants
  are `BUDGET_MS` and `REF_PIXELS` in `lib/bench-stats.js`.)
- **Error bar** `= F / (2K)`, in points.

Settings are MicroPlane's defaults and are never changed: 1024×1024, 60 pairs,
30 passes minimum, 5 warm-up batches, stride 1. That is the one configuration
whose noise has been measured on the device. Signal comes from more copies, not
from tuning.

## 3. How many copies

The authored price picks the tier. It is used for nothing else.

| Tier | Authored price | K and 2K | Nodes |
|---|---|---|---|
| C (cheap) | 5 points or less | 32 and 64 | 28 |
| M (middle) | 6 to 40 | 4 and 8 | 31 |
| H (heavy) | above 40 | 1 and 2 | 6 |

A row that ends as SMALL (§6) is re-run one tier toward more copies. A SMALL
row already in tier C is re-run once with 120 minimum passes. A shader whose 2K
reading is above 12 ms per pass moves one tier toward fewer copies.

Why a ladder: one fixed K fails both ways. Sixteen copies of a 1-point node is
about 16 points of signal, under ten floors; sixteen copies of Voronoi took 137
s for one shader on a Mac and is projected at about 6.6 minutes on the Quest.

## 4. Run order

The driver runs the ticked entries once each, in registry order. So every visit
is its own registry entry and the corpus file is written in run order. One
**block** holds six nodes:

```
ctl_K  ctl_2K   n1_K n1_2K … n6_K n6_2K   ctl_K  ctl_2K   n6_2K n6_K … n1_2K n1_K   ctl_K  ctl_2K
```

The second half is the first half backwards, so a node's two readings sit a few
minutes apart and slow drift cancels in their mean. The control is read three
times per block.

A **session** is: opening lines, two to four blocks, closing lines.

- Opening: flat-colour baseline, the known shader (fBm), two shaders that must
  fail (§5, S4).
- Closing: fBm again, the baseline again.

Each session is self-contained (its own floor, its own controls, its own known
answer at both ends), so sessions can be days apart.

## 5. The checks

Every check is one line in the output, with its numbers printed so it can be
redone by hand.

**Session checks.** A failure voids the session.

| | Pass rule | Catches |
|---|---|---|
| S1 Timer | `timingMethod` is `gpu-timestamp`, backend is WebGPU, 1024×1024, every reading at 30/60 passes | wall-clock fallback, a silent WebGL2 fallback on a non-secure origin, a changed pass count |
| S2 GPU inside wall | GPU time ≤ wall time in at least 95 % of each reading's 120 batches | timestamp intervals that overlap and count queue wait as work |
| S3 Known answer | fBm − baseline within ±10 % of 1.930 ms per pass, at the start and at the end, and the two within 3 % of each other | a whole session in the GPU's other speed state, wrong resolution or backend |
| S4 Must fail | a shader whose node is multiplied by 0 fails R5; a shader whose build throws shows as a build failure with no number | checks that cannot fail |
| S5 Control ladder (first session) | for the plain control at 1, 2, 4 … 64 copies, each doubling step costs 1.8 to 2.2 times the step before it (judged only where that earlier step is at least 10F), and 64 copies compile | the harness itself bending in large shaders, before any node is blamed |

**Row and block checks.** A failure marks the row, or voids one block.

| | Pass rule | Catches |
|---|---|---|
| R1 Pass count | median(hi totals) ÷ median(lo totals) between 1.90 and 2.10 | a clamped or saturated timer, a fixed cost hidden in each batch |
| R2 Steady | `stats.thermalDrift` between 0.90 and 1.10 | the GPU changing speed inside one shader's 60 pairs |
| R3 Repeat | `d ≤ max(2F, 3 % of v)` | a reading that does not repeat |
| R4 Control | each control reading within `max(2F, 3 %)` of that control's session median; else the block is void | heat, or a block measured entirely in the other speed state |
| R5 Picture | of 16 pixels read back, at least 8 differ from the control's; they are not all magenta; the 2K shader differs from the K shader | dead code, a fallback shader, a shader that failed to compile |
| R6 Not below control | `net ≥ −F` at both rungs | a substituted or empty shader, which is cheaper than its own control |
| R7 Signal | `net(K) ≥ 10F`, else the row is SMALL | a number inside the noise |
| R8 Doubling | `net(2K) ÷ net(K)` between 1.8 and 2.2 | merged copies (ratio near 1), amortisation or super-linear growth in large shaders |

**End-to-end check.** Printed at the top of the table. A failure is published;
it does not void rows.

| | Rule | Catches |
|---|---|---|
| E1 Presets | for the 8 preset shaders and `combo_model_check`: measured (shader − baseline) against the sum of the NEW prices over the same graph; pass when within `max(15 %, 5 points)` | sum of parts not predicting the whole |

Where the thresholds come from (all measured on the committed run
`quest3-20260723/`, MicroPlane file, unless marked):

- R1: the 9 shaders give 1.970 to 2.066.
- R2: 0.990 to 1.053 for the seven undisturbed shaders; 0.826 and 1.135 for the
  two that contain a speed change of 1.74 to 1.83 times.
- S3: fBm − baseline is 1.9296 ms per pass. A speed change would move it by
  more than 40 %. **Provisional**: one session exists, so session-to-session
  spread is unknown. Replace 10 % by three times the observed spread once three
  sessions exist.
- R3, R4: undisturbed shaders drift within ±3 % over their own run.
- R7: at `net(K) = 10F` the ratio in R8 carries about ±0.2 of noise, which is
  the width of R8's band. Below that, R8 would fail by noise alone.
- R8: bounds the growth exponent to roughly 0.85 to 1.14, a per-copy error of
  about 10 %. The existing three-level fit (`fit-core.mjs`, R² < 0.97) lets a
  61 % under-read through unflagged (calculated: cost ∝ k^0.7 gives R² 0.994).
- E1: 15 % is the additivity tolerance `fit-core.mjs` already uses.
- F itself: splitting the committed run's pairs into even and odd halves as
  stand-in readings gives F = 0.034 ms = 1.75 points. A real mirrored session
  can only be equal or worse, because the halves are interleaved.

## 6. Verdict and price

| Verdict | Meaning | Price |
|---|---|---|
| MEASURED | every check passes | cost per copy, in points |
| SMALL | all pass except R7, after the re-runs in §3 | value and error bar published; price is the value (see rounding) |
| FAILED(check) | named check failed | authored price stays |
| NOT COVERED(rule) | excluded class, §7 | authored price stays, or its own protocol |

- The price is the all-inputs-wired form (Appendix A). Variants and modes never
  set it.
- `add`, `sub`, `mul`, `div`: the number is one operation. The existing rule,
  price × (operands − 1) in `src/utils/nodeCost.ts`, is unchanged.
- **Rounding is an owner decision.** With integers, any node under half a point
  becomes 0. The committed Static run implies about 0.2 point per arithmetic
  operation (projected from one preset), so integers would price `add`, `sub`
  and `mul` at 0, and a graph of 100 such nodes would read 0 while costing
  about 20. Recommended: integers from 10 up, one decimal below. The editor's
  importer keeps fractions (measured), but every surface prints the number raw.
- Delivery: one file in the patch shape the editor already imports with no new
  code, keyed by node type: `{"meta": {device, bench, generatedAt,
  timingMethod, valid, reasons}, "costs": {"sin": 3.1, …}}`. Leave out
  `meta.id`, `label`, `maxPoints`, `maxTextureDim` (they are read as profile
  identity). Only MEASURED and SMALL keys are present. A raw file with
  `brute_*` ids does not import (measured), which is intended.

## 7. Which nodes

The registry has 101 types and `complexity.json` has 102 keys (measured by
dumping both). **65 types are measured by this method**: 64 of the 76 keys
priced above zero, plus `abs`.

| Class | Count | Nodes | Rule |
|---|---|---|---|
| F, plain per-pixel functions | 43 | arithmetic, math, interpolation, logic, vector, the 8 noise nodes, `hsl`, `toHsl`, `dataRange` | measured |
| S, distance fields | 19 | every `sdf` node | measured as one evaluation on a quad |
| D, derivative nodes | 3 | `stripes` (untraced), `isolines`, `wireframe` (grid mode) | measured |
| Z, sources and constructors | 24 | positions, camera, time, sound, `uv`, properties, `float` … `color`, `split` | not covered: nothing to copy. Price stays authored |
| X, once-per-shader vectors | 4 | `positionWorldDirection`, `positionViewDirection`, `normalWorld`, `rayDirection` | not covered: K references are one computation, and `positionViewDirection` is a constant under MicroPlane's orthographic camera. Price stays authored, flagged |
| T, texture reads | 4 | `imageNode`, `colormap`, `dataNode`, `dataviz` (traced) | not covered here: measured by the texture protocol in `METHODS.md` §6 |
| O, sinks and placeholder | 4 | `output`, `raymarchOutput`, `splatOutput`, `unknown` | not covered. Price stays authored |

Every one of the 101 types gets a row in the output, so nothing is silent.

Also outside the method, and stated on the affected rows:

- **Multipliers.** A node in a Raymarch Output's Field scope is charged
  steps + 4 times (68 at the default 64 steps). This method supplies the base
  price and says nothing about the multiplier. A 1-point error in a distance
  field's price becomes 68 points there.
- The vertex stage (anything wired to `position`), Splat Output chains,
  `wireframe` in edges mode, and the march loop's own per-step overhead.

## 8. Headset protocol

Times are **projected** from `T ≈ 5.6 s × ms per pass + about 2 s` per reading
(5,610 passes at the fixed settings). Shader compile time on the Quest is in no
data and adds an unknown amount.

Preparation:

1. Serve the bench from a secure origin: an https host, or `adb reverse` to the
   dev server. On a plain LAN `http` origin WebGPU is absent and three falls
   back to WebGL2 without saying so (read in three's source, not tried on a
   headset). S1 exists to catch that.
2. Battery at least 50 %, headset stationary, display kept awake, no other app,
   bench tab in front. Write battery level, room temperature and start time
   into the run notes.
3. Open `bench-microplane` directly. Press **None**, tick the one session
   group. Leave every setting at its default. The picker remembers the last
   selection per browser, so check that the shader count in the log equals the
   session's count before starting.
4. After each run press **✕** on the editor's bench chip. Do not press **Add**:
   every run stores itself as a one-click device profile.

Sessions:

| Session | Content | Projected |
|---|---|---|
| 0 | opening lines, control ladder 1 … 64, tier H (6 nodes) | about 25 min |
| C1, C2 | tier C, 28 nodes and their special controls | about 55 min together (25 to 115) |
| M1, M2 | tier M, 31 nodes and their special controls | about 51 min together |
| E | 8 presets, `combo_model_check` and the other combos, mirrored between baseline readings | about 15 min |

Session 0 is the go/no-go: S1, S2, S3, S4, S5 must pass, and F is read off. If
S2 fails on the Quest as it did on the Mac (§12), the method has no valid timer
and stops there. If S5 fails at 64 copies, tier C drops to 16 and 32.

No session longer than 35 minutes. At least 10 minutes powered down between
sessions. Total: about 2.5 hours of headset time (range 1.6 to 4), which can be
spread over several days.

A Mac is for rehearsing the clicks. **Mac numbers are never read** (§12).

## 9. What comes out, and how a stranger checks it

Committed under `benchData/quest3-<date>-brute/`:

- the raw JSON export of every session, unchanged;
- `brute-table.csv`: one row per registry type with both readings at both
  rungs, the controls, net, ratio, cost per copy, points, error bar, authored
  price, verdict and failed checks;
- `brute-checks.txt`: one PASS or FAIL line per check per row, for example
  `PASS R8 DOUBLING sin net(64)=… net(32)=… ratio=… in [1.8, 2.2]`;
- `brute-prices.json`: the patch file of §6.

To verify: run `node verify-brute.mjs <raw files>`. It reads only the batch
totals in `frames[]`, recomputes every reading, and must reproduce the three
derived files byte for byte. The script is a few dozen lines with no
dependencies, so it can be read in one sitting. To check that the shaders are
what the table claims, compare the corpus file's hash (recorded in each raw
file) with the committed corpus, and read the recipe for any node in
Appendix A.

## 10. What must be built first

1. **The corpus**, `lib/bench-brute.js`: the 65 recipes at two rungs and two
   visits, the plain control at seven rungs, the special controls, the baseline
   and fBm lines, the two must-fail shaders, written in run order with one
   picker group per session. Three rules:
   - Entries are **not** wrapped in `safeWrap`. Today a build that throws is
     replaced by flat magenta, timed, and exported as 0 points with
     `valid: true`.
   - Seed: `p0 = vec3(x, y, 0.61803·x + 0.38197·y)` instead of
     `positionGeometry`, then the existing seed formula. On the flat quad
     `positionGeometry.z` is 0, so one input lane was the same for every pixel
     (measured: `hsl` × 1 rendered flat black).
   - The helper functions (`hsl`, `toHsl`, every `sd*` and `sdf*`) are copied
     verbatim from `src/engine/moduleHelpers.ts`.
2. **A generator and drift test** (one vitest file, the pattern of
   `scripts/gen-tsl-exports.mjs` with `tslExportNames.test.ts`): writes the
   corpus, otherwise asserts it is unchanged, and asserts that every F, S and D
   registry type has exactly one recipe and every other type has an exclusion
   rule. A new node then fails the suite until it has one or the other.
3. **Picker and registry**: the session group names in `GROUP_LABELS` and
   `GROUP_ORDER` (`lib/bench-ui.js`); the corpus appended to the registry.
4. **Raw export additions** (`lib/bench-driver.js`): wall time per batch (the
   timer already measures it and the export drops it), start time and sequence
   number per shader, the backend name, the corpus hash, 16 read-back pixels
   per shader, and a row with status `build-failed` instead of a skipped
   shader.
5. **`verify-brute.mjs`** (§9).
6. **A preset predictor** for E1: built-in textures → `codeToGraph` →
   `nodeCostPoints` under a given price table.
7. **When prices land**, in the same commit: re-base the tests that pin prices
   (measured: 35 assertions in 6 files for non-noise prices, and the noise band
   in `src/utils/nodeCost.test.ts`, which is pinned to the Static run within
   10 %). Put the raw files in a new directory: `quest3-20260723/` must hold
   exactly two raw JSONs, and a raw file with a `texture_*` or `calib_tex_*` id
   switches `textureSampleCost.test.ts` to its measured half.

## 11. Limits

- **Throughput, not latency.** Copies are independent. A node inside a long
  dependency chain may cost more or less; only E1 sees that, in aggregate.
- **The wired form.** Every input varies per pixel. Most graphs leave some
  inputs as constants the compiler may fold, so the price is an upper bound for
  them. What the Adreno driver folds is never observed, only its consequences.
- **Branchy nodes on random data.** three emits `select` as a real branch,
  nested inside `toHsl`, `sdCone`, `sdOctahedron`, `sdfRepeat` (measured in the
  generated shaders). On smooth real data they may be cheaper.
- **SMALL does not mean free.** In tier C it means under 10F ÷ 32 per copy,
  about half a point at the floor seen so far. R5 shows the result reached the
  pixel; it cannot show how the driver got there.
- **One fixture.** In the committed session MicroPlane and Static agreed within
  6 % above 100 points and disagreed by 23 to 30 % between 27 and 68 points,
  cause unknown. Which bench is the price of record is an owner decision;
  today's noise prices follow Static.
- **One device, one browser build**, WebGPU, mono, fragment stage, 1024×1024
  scaled by pixel count. Nothing here says what a frame costs in an immersive
  session.
- **Thresholds rest on one committed session** of 9 shaders. The causes of the
  speed change and of a 1.65 ms lattice in the batch totals are unknown; the
  checks detect their effect and do not remove them.
- **64-copy shaders have never been compiled on an Adreno 740.** S5 is there
  for that.

## 12. Why it is built this way

Four findings from the committed Quest run and a pilot on a Mac
(2026-09-29) decided the design.

1. **One copy of a cheap node is invisible.** Floor of a single-copy reading
   against the baseline: about 2.5 points (measured). `cellNoise` read −0.0075
   ms, below zero. 28 of the 65 nodes are priced 5 or less.
2. **The baseline is measured once, first, and the order is fixed.** In the
   committed run the GPU ran 1.74 to 1.83 times faster for a stretch covering
   the end of one shader and the start of the next. The median hid it and the
   run exported `valid: true`. A whole shader in that state would be wrong by
   about 45 % with no flag. Hence controls three times per block, mirrored
   order, R2, R4, S3.
3. **GPU timestamps can be wrong while every existing gate stays green.** On
   an Apple M4 Max in Chrome 154 the summed GPU time of a batch exceeded the
   wall time of that batch by 15 to 22 times, two identical runs differed by a
   median of 75 % per shader, 11 of 16 ops flipped sign, and all runs exported
   `valid: true, quantized: false`. The raw export keeps no wall time, so the
   committed Quest MicroPlane run cannot be checked the same way (its Static
   sibling can: wall ÷ GPU is 1.02 to 1.13). Hence S2, and wall time in the
   export. The pilot's raw files sat in a temporary directory that has since
   been cleared; the finding reproduces by running the Calibration group on
   that Mac.
4. **Today's table does not predict whole shaders.** Table sum against the
   committed Static measurement for the 8 presets:

   | Preset | Table | Measured | Ratio |
   |---|---|---|---|
   | polkaDots | 36 | 4 | 0.11 |
   | grid | 22 | 3 | 0.14 |
   | tigerFur | 77 | 39 | 0.51 |
   | staticNoise | 46 | 36 | 0.78 |
   | crumpledFabric | 510 | 419 | 0.82 |
   | gasGiant | 372 | 217 | 0.58 |
   | marble | 177 | 125 | 0.71 |
   | wood | 269 | 191 | 0.71 |

   No test makes this comparison today. Hence E1.

Also measured: the fBm × 0 "DCE sentinel" was **not** eliminated on the Mac, so
it is no evidence about any compiler. It is kept only as the must-fail shader
for R5.

Rejected, and why:

- **The three-level fit with an R² flag**: it is algebraically a two-point
  difference and its flag misses large errors (§5). One ratio says the same.
- **Subtracting the flat baseline** from a node shader: for a 1-point node the
  seed and the accumulate are most of each copy. The control removes them.
- **Raising the resolution**: four times the time per pass, and in the pilot it
  made a broken fit look clean.
- **A desktop GPU as a proxy or cross-check**: finding 3.
- **A modelled price for what cannot be measured**: an excluded node keeps its
  authored price and says so.
- **Shaders generated by the editor's own code generator** as the priced form:
  feasible (measured: 13 node types generated at three copy counts and rendered
  on both backends), but the editor's default emission leaves inputs as
  literals, which is the foldable form. It is the natural source for an
  optional "as emitted with defaults" column beside the price.

## Appendix A. One instance of each measured node

`p` is the seeded vec3 for that copy, in [0, 1)³. A float result is wrapped in
`vec3(…)` to be accumulated. "Control" is what the control shader computes per
copy in place of the node; blank means the plain control (identity). All 65
recipes, 18 controls and 22 variants compiled and rendered on three r184 on
both WebGPU and WebGL2 in Chrome on a Mac (measured, 2026-09-29, with the old
seed; re-check after the seed change).

Tier C, 32 and 64 copies:

| Node | One instance | Control |
|---|---|---|
| add | `add(p, p.zxy)` | |
| sub | `sub(p, p.yzx)` | |
| mul | `mul(p, p.yzx)` | |
| div | `div(p, add(p.yzx, 0.1))` | `add(p.yzx, 0.1)` |
| sin | `sin(p)` | |
| cos | `cos(p)` | |
| abs | `abs(sub(p, p.yzx))` | `sub(p, p.yzx)` |
| sqrt | `sqrt(p)` | |
| exp | `exp(p)` | |
| log2 | `log2(add(p, 0.1))` | `add(p, 0.1)` |
| floor | `floor(mul(p, 8))` | `mul(p, 8)` |
| round | `round(mul(p, 8))` | `mul(p, 8)` |
| fract | `fract(mul(p, 8))` | `mul(p, 8)` |
| oneMinus | `oneMinus(p)` | |
| mod | `mod(p, add(p.yzx, 0.1))` | `add(p.yzx, 0.1)` |
| clamp | `clamp(p, p.yzx, p.zxy)` | |
| min | `min(p, p.yzx)` | |
| max | `max(p, p.yzx)` | |
| mix | `mix(p, p.yzx, p.z)` | |
| remap | `vec3(remap(p.x, p.y, add(p.z, 1), p.y, p.z))` | `vec3(add(p.z, 1))` |
| select | `select(greaterThan(p.x, p.y), p.yzx, p.zxy)` | `vec3(float(greaterThan(p.x, p.y)))` |
| greaterThan | `vec3(float(greaterThan(p.x, p.y)))` | |
| lessThan | `vec3(float(lessThan(p.x, p.y)))` | |
| equal | `vec3(float(equal(p.x, p.y)))` | |
| dot | `vec3(dot(p, p.yzx))` | |
| append | `vec3(p.yz, p.x)` | |
| sdfModify | `vec3(sdRound(p.x, p.y))` | |
| sdfMask | `vec3(sdfMask(p.x, p.y))` | |

Tier M, 4 and 8 copies:

| Node | One instance | Control |
|---|---|---|
| pow | `pow(add(p, 0.1), p.yzx)` | `add(p, 0.1)` |
| smoothstep | `vec3(smoothstep(p.x, add(p.y, 1), p.z))` | `vec3(add(p.y, 1))` |
| normalize | `normalize(add(p, 0.1))` | `add(p, 0.1)` |
| length | `vec3(length(p))` | |
| distance | `vec3(distance(p, p.yzx))` | |
| cross | `cross(p, p.yzx)` | |
| perlin | `vec3(mx_noise_float(p))` | |
| cellNoise | `vec3(mx_cell_noise_float(p))` | |
| hsl | `hsl(p.x, p.y, p.z)` | |
| toHsl | `toHsl(p)` | |
| dataRange | `vec3(p.x.sub(0.25).mul(2).clamp(0.0, 1.0))` | |
| sdCircle | `vec3(sdCircle(p, p.y))` | |
| sdBox | `vec3(sdBox3(p, p.yzx, p.z))` | |
| sdTorus | `vec3(sdTorus(p, p.y, p.z))` | |
| sdCombine | `vec3(sdUnion(p.x, p.y, p.z))` | |
| sdCylinder | `vec3(sdCylinder(p, p.y, p.z, p.x))` | |
| sdCapsule | `vec3(sdCapsule(p, p.y, p.z))` | |
| sdCone | `vec3(sdCone(p, p.y, p.z, add(p.x, 0.1)))` | `vec3(add(p.x, 0.1))` |
| sdPlane | `vec3(sdPlane(p, p.yzx, p.z))` | |
| sdOctahedron | `vec3(sdOctahedron(p, p.y))` | |
| sdStar | `vec3(sdStar(p.xy, p.z, add(p.x, 5), add(p.y, 2)))` | `vec3(add(add(p.x, 5), add(p.y, 2)))` |
| sdfTransform | `sdfTransform(p, p.yzx, p.zxy, p.yzx)` | |
| sdfRepeat | `sdfRepeat(p, p.yzx, p.zxy)` | |
| sdfRepeatPolar | `sdfRepeatPolar(p, mul(p.y, 8))` | `vec3(mul(p.y, 8))` |
| sdfMirror | `sdfMirror(sub(p, 0.5), p.yzx)` | `sub(p, 0.5)` |
| sdfDeform | `sdfTwist(p, p.x)` | |
| sdfExtrude | `vec3(sdfExtrude(p.x, p, p.y))` | |
| sdfRevolve | `vec3(sdfRevolve(p, p.y), 0)` | |
| stripes | block below | |
| isolines | block below | |
| wireframe | block below | |

Tier H, 1 and 2 copies:

| Node | One instance |
|---|---|
| perlinVec3 | `mx_noise_vec3(p)` |
| fbm | `vec3(mx_fractal_noise_float(p))` |
| fbmVec3 | `mx_fractal_noise_vec3(p)` |
| voronoi | `vec3(mx_worley_noise_float(p))` |
| voronoiVec2 | `vec3(mx_worley_noise_vec2(p), 0)` |
| voronoiVec3 | `mx_worley_noise_vec3(p)` |

The three derivative nodes follow the statements `graphToCode` emits, with
`p.x` (or `p.xy`) standing in for the wired signal. Re-derive them from the
generator when building, in case the emission has moved.

```js
// stripes (untraced form)
const ph = p.x.mul(80);
const tri = ph.fract().mul(2.0).sub(1.0).abs();
const fw = dFdx(ph).abs().add(dFdy(ph).abs());
const ln = tri.smoothstep(float(0.5).sub(fw), float(0.5).add(fw));
const lnS = mix(ln, float(0.5), fw.mul(2.0).sub(1.0).clamp(0.0, 1.0));
const br = float(1.0).sub(lnS.mul(0.75));
const col = mix(color(0x1b2a4a), color(0xffd24d), p.y.clamp(0.0, 1.0));
return col.mul(br);

// isolines
const ph = p.x.sub(0).mul(10);
const fw = dFdx(ph).abs().add(dFdy(ph).abs()).max(0.00001);
const hw = fw.mul(1.5).mul(0.5);
const d = float(0.5).sub(ph.fract().sub(0.5).abs());
const ln = d.smoothstep(float(0.0), hw).oneMinus();
const avg = fw.mul(1.5).clamp(0.0, 1.0);
return vec3(mix(ln, avg, fw.mul(2.0).sub(1.0).clamp(0.0, 1.0)));

// wireframe (grid mode)
const q = p.xy.mul(10);
const d = vec2(0.5).sub(q.fract().sub(0.5).abs());
const fw = dFdx(d).abs().add(dFdy(d).abs()).max(0.00001);
const hw = fw.mul(1.5).mul(0.5);
const ln = d.smoothstep(vec2(0.0), hw).oneMinus();
const avg = fw.mul(1.5).clamp(0.0, 1.0);
const c = mix(ln, avg, fw.mul(2.0).sub(1.0).clamp(0.0, 1.0));
return vec3(c.x.max(c.y));
```

Notes on single rows:

- **Noise** is the bare call on a vec3 position. A node added from the palette
  also carries `.mul(0.5).add(0.5)`; a vec2 position compiles a different,
  2D function. Both are variant rows, not the price.
- **Logic nodes** include the bool-to-float conversion the editor wraps them
  in. `select` is net of its comparison.
- **mod** is a polyfill with a divide on WebGPU and native on WebGL2, so the
  backend in S1 matters to `mod`, `hsl` and `sdStar`.
- **dataRange** keeps its constants: the node decides them on the CPU by
  design, so constants are the faithful form.
- **Modes** (`sdCombine` subtract, intersect, xor; `sdfModify` shell, scale;
  `sdfDeform` bend, elongate; `sdBox` on a vec2; `dataRange` log, symlog) are
  variant rows. A variant that differs from the price by more than 25 % and
  more than 2 points is flagged on the row.
