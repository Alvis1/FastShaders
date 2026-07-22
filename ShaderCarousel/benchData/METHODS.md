<!-- Generated 2026-07-23 from a verified multi-agent research pass. See README.md + fit-calibration.mjs. -->

# Recovering Precise Per-Node GPU Cost in FastShaders: A Methods Report

## 1. Can precise per-node cost actually be recovered? What is the accuracy ceiling?

**Short answer: Yes — but "precise" must mean *per-node marginal cost as a device-specific throughput slope with a confidence interval*, not a single exact cycle count.** The realistic target is relative per-node costs (ratios to `add`) recovered to roughly the tens-of-percent accuracy band that every empirical GPU model in this space lives in, with tight bootstrap CIs on the well-isolated nodes and honestly-wide CIs on the entangled ones. Cycle-exact per-node numbers are *not* achievable in a browser on Quest, and are not even the right goal — a live editor budget can only afford to sum a table.

The ceiling is set by four hard constraints, all confirmed:

- **Timer quantization.** Chrome's WebGPU `timestamp-query` is quantized to **100 µs** by default, and is **not exposed at all** in non-cross-origin-isolated contexts. Full resolution requires launching with `chrome://flags/#enable-webgpu-developer-features`. So the shipping end-user path must assume 100 µs buckets; the dev-flag path (your own calibration runs) is effectively unquantized. Your existing mitigations — multi-pass amortization (default 30) and large `k` — are exactly right: push the measured window to hundreds of µs, then divide back.
- **vsync clamping.** rAF is clamped to 72/90/120 Hz on Quest, so rAF deltas are *frame-fit telemetry, not per-op cost*. Your `bench-static` `onSubmittedWorkDone` fence + multi-pass is the correct way to defeat this, and the InOut bench's rAF logs should be read only as "does the whole shader fit the frame."
- **Occupancy / register-pressure nonlinearity.** This is the accuracy ceiling on *additivity itself* (see §3): per-node costs are additive in the low-register regime and break superlinearly near the register/occupancy limit — which is exactly where the VR budget bites.
- **Cross-vendor non-transfer.** Desktop and Mali numbers do **not** transfer to Adreno 740 (TBDR, very wide 64/128 waves, FP16-at-2× ALUs). The Quest run — not the desktop run — must set the shipped `complexity.json` values. Desktop is for fast iteration and DCE validation only.

Bottom line: precise *relative* per-node calibration on Quest 3 is feasible and is a large, defensible improvement over the hand-guessed table; a *portable, cycle-exact, purely-additive* table is not, and the report below is built around that distinction.

---

## 2. Method families and the best options in each

### Family A — Offline / static shader cost analyzers (compiler-based)

Best options:

1. **Qualcomm Adreno Offline Compiler (AOC)** — the *exact-vendor* match (Quest 3 is Adreno 740). Feed it fragment SPIR-V and it reports instruction **counts by class** (16-bit ALU, 32-bit ALU, texture, complex/transcendental, flow-control, long-latency sync), GPR footprint, and an occupancy percentage. Caveats (all confirmed): it supports **only Android Vulkan (SPIR-V)** input; it reports *counts, not cycles*, so it cannot by itself resolve the SFU rate — it tells you how many "complex" instructions a voronoi emits and you weight them; Meta explicitly warns it is not a reliable absolute performance comparator and "lacks loop-related contextual information"; there is **no macOS build** (run it on Linux/Windows or in CI). *Correction to source framing:* the detailed instruction-class breakdown and the two caveats are documented in Meta's **blog post**, not the primary doc page (which only confirms the Android-Vulkan-only restriction); and "SPIR-V" is the accurate gloss for Meta's own wording "Android Vulkan."
2. **Arm Mali Offline Compiler (malioc)** — the best *cross-check* on the physics of SFU/FMA rates, and the most convenient tool on macOS. Free, ships in Arm Performance Studio as a macOS `.dmg` CLI (auto-added to PATH), accepts SPIR-V via `--vulkan`, and emits a per-pipeline **cycle** breakdown. On Valhall/5th-Gen cores the detailed breakdown splits arithmetic into **FMA / CVT / SFU** columns plus LS / V / T and a "Bound" bottleneck marker. *Nuance (confirmed):* the compact summary table shows a single combined "A" column; the three-way FMA/CVT/SFU split appears in the detailed per-pipeline view. It models **Mali, not Adreno** — use it for the *structure* of SFU-vs-FMA rates and as an independent throughput sanity model, never as Quest ground truth.

Deprioritized in this family: **AMD RGA** (free/MIT, Windows/Linux only, models AMD GCN/RDNA only — methodological template for register-pressure signal, not device-representative); **PowerVR PVRShaderEditor** (PowerVR Rogue only, GLSL-ES input, reduced maintenance — at best a second TBDR data point); **Unity compiled-shader stats** (collapses to "use malioc" — FastShaders is not a Unity project); **Unreal Shader Complexity viewmode** — cite this only as the *cautionary reference*: it is a pure additive instruction-count proxy with no per-instruction weighting, and it is exactly the flat model FastShaders is replacing. **Correction:** Epic's docs say **non-unrolled (dynamic) loops** are misrepresented (mainly a vertex-shader issue) and that unrolled loops *are* counted accurately — do not state the inverse.

### Family B — Empirical microbenchmarking (the core recovery method)

Best options:

1. **k-copy / slope-over-k amortization** — recover one node's marginal cost by replicating its TSL fragment `k` times, sweeping `k`, and taking the slope `d(time)/d(k)`; the intercept absorbs all fixed per-invocation overhead. Your existing N/2N two-level slope *is* this method, and the pairwise `time(2N)−time(N)` form additionally cancels per-batch/dispatch overhead. **Prefer independent/throughput-mode copies** (many fragments in flight), because a full VR shader runs at high occupancy and the *throughput* number is what the budget should price against — latency-chained vs throughput-independent numbers can differ 4–20×.
2. **DCE/CSE avoidance** — the single biggest threat to validity. Three coupled guards: **(a) sink** the accumulator into the fragment output so nothing is dead; **(b) defeat CSE/constant-folding** by feeding each copy a runtime-varying value (uniform seed, `uv()`, `positionGeometry`) — mandatory for SFU ops and *especially* for the noise atoms, since a constant-argument `mx_noise` folds to a compile-time constant; **(c) keep copies non-foldable and live**. *Correction:* a strict serial dependency chain is the *latency* technique; throughput measurement wants *mutually independent* copies (for ILP) that are each still non-foldable and sunk. And the CUDA "write to global memory" DCE rule is literally about compute kernels — extending it to the framebuffer sink for fragment/WGSL shaders is a sound analogy, not a direct quote. Validate by confirming measured time actually scales with `k` before trusting any slope (if slope ≈ baseline slope, DCE won).

Supporting techniques in this family, all directly applicable: **baseline/overhead subtraction** (already in your microplane bench — extend to a per-node calibration table, but run each node at 2–3 occupancy tiers to confirm the subtracted cost is stable); **timestamp queries** (primary timer with the dev flag on desktop and on Quest Browser Chromium; assume 100 µs quantization on the shipping path); **`onSubmittedWorkDone` fences** (keep as the primary on-Quest timer if Adreno timestamp support misbehaves — mobile driver timestamp support is spottier than desktop); **occupancy/register-pressure nonlinearity** (the additivity killer, §3); **SFU isolation** (§3); **TBDR/tiling specifics** (keep the full-coverage quad to stay ALU-bound not bandwidth-bound; measure in FP32; treat the Adreno run as source of truth).

### Family C — Learned / analytical performance models

Best options:

1. **ShaderPerFormer** (Liu, Huang, Liu — I3D 2024, PACMCGIT) — the single most on-target work: a transformer that predicts *whole-shader* runtime from a platform-independent SPIR-V trace with sampled per-basic-block execution counts, so cost is context/trace-count dependent, not a flat additive sum. Reduces average MAPE by 8.26% vs a per-instruction linear-regression baseline and 25.25% vs a simple instruction-count heuristic; absolute MAPE is tens-of-percent (a ranking/estimate tool). Public 54,667-sample, 5-platform dataset + MIT code. **Explicitly limited to single-pass image shaders with uniform inputs and no texture read/write** — so borrow the *methodology* (label a corpus with measured Quest ms, fit a small regressor), not the model as-is. Its central finding — that real-shader cost is context-dependent — is precisely the hypothesis behind your "is cost additive?" question.
2. **Kaufman et al., Learned Performance Model for TPUs (GNN)** (MLSys 2021) — the closest *graph-native learned* blueprint: opcode-embedded nodes → message-passing GNN → whole-graph runtime regressor. Structurally identical to what FastShaders could build over its TSL graph. Domain is ML kernels on TPU, so transfer is by analogy — but it also gives a clean **additivity test**: if a linear sum-of-node-features model matches the GNN, costs *are* additive; if the GNN wins materially, interactions matter.

Analytical models for framing (not per-node numbers): **Hong & Kim MWP-CWP** (ISCA 2009) formalizes exactly the additivity question — ALU cost ≈ sum of per-op cycle costs ÷ achievable parallelism, *given* correct per-op cycles and a throughput-bound shader. **Correction:** its **13.3% is the applications** geometric-mean error (5.4% on microbenchmarks), validated on four **Tesla-generation NVIDIA** GPUs; the paper never mentions Adreno or mobile SFU rates, so "does not transfer to Adreno" is a defensible editorial inference (consistent with its own per-GPU parameter fitting), not a claim the paper makes. **GPUMech** (interval analysis, ~13.2% error, ~97× faster than cycle-accurate sim) — adopt its *CPI-stack* idea (attribute frame cost to op classes: SFU / texture / ALU) rather than the tool. **Correction: GPUMech is MICRO 2014, not ISCA 2014.** **Roofline / Instruction Roofline** — use to *classify* a graph as ALU-bound (per-node sum defensible) vs texture/data-bound (Image/Data/Stripes nodes dominate via bandwidth, additivity breaks); no browser counters exist to measure achieved intensity live. **Genetic Programming for Shader Simplification** (Sitthi-amorn et al., TOG 30(6), SIGGRAPH Asia 2011) and **Pellacini** (SIGGRAPH 2005) are relevant only if FastShaders later adds automatic shader LOD — the GP work is the canonical prior for *measured on-hardware* cost as the fitness over tens of thousands of variants, reinforcing that additivity must be validated not assumed. **ShaderTransformer** (SIGGRAPH 2022) predicts *quality*, not cost — the complementary half of a future LOD loop, not needed for cost recovery.

### Family D — Statistics / Design of Experiments (fit the table from a corpus)

Best options:

1. **Non-Negative Least Squares (NNLS)** (Lawson & Hanson, active-set) — the natural default over plain OLS: costs are inherently non-negative point budgets and a VR budget must never *drop* when a node is added. Its failure mode is *informative*: a node pinned at 0 is unidentifiable from your current corpus (never varies independently of a costlier neighbour) — a direct, actionable list of which nodes the microplane bench must isolate before their point value can be trusted.
2. **Fractional-factorial / D-optimal experimental design** (Montgomery; Atkinson–Donev–Tobias; Fedorov exchange) — because you can *programmatically synthesize any valid graph* via `graphToCode`, you have total control of the design matrix — a rare luxury that makes optimal DoE unusually applicable. A D-optimal exchange over a candidate pool of valid graphs outputs ~40–80 shaders that de-correlate the node columns, breaking the natural co-occurrence that otherwise forces ridge/NNLS-zeroing.

Supporting statistical machinery: **OLS multiple regression** is the base estimator (design matrix rows = shaders, columns = node types, entries = node counts, intercept = fixed overhead, response = marginal ms); **weighted LS** with weights ∝ 1/Var(timing) for heteroscedastic noise; **Ridge** (Hoerl & Kennard 1970) when node counts are collinear; **robust regression** (Huber M-estimation / RANSAC) to survive Adreno thermal-throttle and vsync outliers; **bootstrap CIs** (Efron 1979; BCa preferred for NNLS's boundary-piled distributions) to attach an honest band to every `complexity.json` value; **mixed-effects models** (Bates et al., lme4) to absorb device/thermal variance and pool multi-device data into one relative table + per-device scale, with an elapsed-time covariate to subtract thermal droop; **VIF / condition-number diagnostics** (Belsley–Kuh–Welsch) as the *precondition* gate on whether any fitted number means anything; and **Tukey's 1-df non-additivity test** + explicit interaction columns to detect where sum-of-parts fails.

---

## 3. Recommended pipeline for FastShaders

A three-stage loop that combines your existing benches with a regression fit and a static cross-check. Everything shipped is calibrated **on Quest 3 over the LAN bench server**; desktop (dev flag) is for iteration and DCE validation.

### Stage 1 — Per-node isolation (microplane bench, extend what exists)

For each of the ~68 registry node types, emit a shader whose body is `k` **independent, non-foldable** copies of that node's TSL fragment, each driven by a runtime-varying seed (`uv()`/`positionGeometry`/uniform), all accumulated into the fragment output. Sweep `k`; take the throughput slope; baseline-subtract. This yields marginal ms per node — feed straight into `bench-stats`' complexity-suggestion JSON.

Guards (non-negotiable):
- **DCE/CSE**: sink + varying seed + non-foldable copies; the noise atoms (`perlin`/`fbm`/`voronoi`) are highest-risk — drive `pos` from `uv*seed`. Verify slope scales with `k` before trusting it.
- **Occupancy tiers**: run each node at 2–3 `k` ranges; if the slope kinks, you have crossed an occupancy/spill boundary — report the *low-pressure* slope as the base point and flag the kink.
- **SFU isolation**: run the k-slope separately for `sin`/`cos`, `sqrt`/`div`/`rcp`, `pow`/`exp`/`log`, and `normalize`/`length`/`distance` (rsqrt-backed), and take the **ratio to `add`'s slope**. *Expectation, stated as a hypothesis to measure, not assume:* on Adreno the SFU:FP32 issue-width ratio is sparse (the Snapdragon **X-Elite Adreno X1** die is disclosed at 8 SFU per 64-wide FP32 = 16:128 ≈ **1/8** — a *structural throughput* ratio, from architecture disclosure + microbench, **not** a measured per-op latency, and **not independently verified for the Adreno 740** specifically; treat it as an architectural-family prior). This supports the 1/8 end of your 1/4–1/8 suspicion and predicts the current `sqrt/div=4` vs `add=1` gap should *widen* and `normalize` (=7) should come out pricier relative to `add`. **Sanity gate:** if the Quest bench says `sin` costs the same as `add`, the measurement is broken (the dissection literature shows transcendentals are always multi-cycle) — DCE won.

### Stage 2 — Composed-corpus regression (the table fit)

Do **not** trust isolated slopes alone — fit them against real graphs to test additivity.

1. **Design the corpus with DoE**, not a grab-bag. Run VIF/condition-number diagnostics on a candidate design matrix; then a resolution-IV **fractional-factorial screen** over the ~68 nodes for main effects, followed by a **D-optimal exchange** to select ~40–80 valid, compilable graphs that de-correlate the node columns. This is uniquely feasible here because `graphToCode` can synthesize any graph on demand.
2. **Measure** each corpus shader's marginal ms on Quest via the N/2N two-level slope (already cancels per-batch overhead) with multi-pass amortization; use the `onSubmittedWorkDone` fence if Adreno timestamps misbehave.
3. **Fit `y = Xb`** where rows = corpus shaders, columns = node types (intercept = fixed overhead). Use **NNLS** as the default (costs ≥ 0); apply **ridge** where VIF flags collinear clusters (color/interpolation nodes that rarely appear alone); run the fit **Huber-robust** to down-weight thermal/vsync outliers; weight rows by 1/variance from the multi-pass repeats. **Count variadic folds (`arithmetic`, `append`) as (N−1) operations** to match `nodeCost.ts`, so a column value is *operations*, not node instances.
4. **Attach bootstrap CIs** (BCa, ~2,000–10,000 refits of the *full* NNLS-ridge-robust pipeline) to every value. A tight CI far from the hand-guessed number is the empirical mandate to re-cost (the suspected voronoi under-pricing); a wide CI straddling the current value means "no evidence to change it"; a node NNLS pins at 0 goes back to Stage 1 for isolation.
5. If you bench multiple devices/thermal states, fit a **mixed-effects** model with device/run as random effects + an elapsed-time covariate, yielding one device-agnostic *relative* table plus per-headset scale factors — exactly what a portable `complexity.json` needs.

### Stage 3 — Static cross-check (AOC on Adreno, malioc as physics reference)

For each corpus shader: TSL → WGSL (`renderer.debug.getShaderAsync`, WebGPU backend) → WGSL→SPIR-V (naga via wgpu, or Tint via Dawn) → **AOC** (`.spv`, on a Linux/Windows/CI box). AOC's per-node **instruction-class deltas** (ALU16/ALU32/tex/complex) and GPR-footprint jumps *explain* the bench numbers — they tell you *what* Adreno emits; the benches tell you *what it costs*. Register-footprint jumps flag exactly the occupancy cliffs Stage 1's tier check hunts for. Cross-feed the same SPIR-V to **malioc** `--vulkan` for an independent FMA/CVT/SFU cycle-structure read (Mali physics, not Quest ground truth) — a second opinion on whether your measured SFU ratios are structurally plausible.

### The additivity question — does sum-of-parts hold?

This is the crux, and the pipeline tests it directly rather than assuming an answer:

- **Expected answer (to be confirmed on Quest):** additivity holds reasonably in the **low-register regime** and **breaks superlinearly near the budget ceiling**, where added nodes raise register pressure → occupancy drops (Adreno's very wide 64/128 waves pressure the register file quickly) → less latency hiding → cost, and eventually spills. Two nodes each costing C in isolation can together cost ≫ 2C once they tip over an occupancy/spill boundary — precisely where the VR budget matters most.
- **How DoE + NNLS regression tests it:** if sum-of-parts held perfectly, the NNLS residuals over the composed corpus would be pure measurement noise. So: (1) fit the additive NNLS model; (2) run **Tukey's 1-df non-additivity test** (regress residuals on squared fitted values — a significant slope means a curved/multiplicative interaction the additive model misses); (3) plot residuals vs total node count to expose the register/occupancy *kink*; (4) augment X with explicit interaction columns (products of node counts, or a total-complexity² term) on the suspected non-additive noise-node subset — a stable, significant interaction coefficient *localizes which pairs* break additivity. As a learned cross-check, if a linear sum-of-features model matches a small GNN over the graph, costs are additive; if the GNN wins materially, interaction matters (the ShaderPerFormer finding).
- **What to ship:** keep `complexity.json` **additive** — a live editor budget can only afford to sum a table — but reframe it as **"sum + a pressure correction near the budget."** Use the interaction analysis to (a) certify the additive approximation's error bar and (b) fire a **CostBar warning** when a graph's estimated register footprint likely crosses an occupancy tier, instead of silently trusting the raw sum. Don't try to model every pair; model the threshold.

This closes the loop: **VIF/diagnostics → D-optimal design → measure on Quest → NNLS-ridge-robust fit + bootstrap CI → non-additivity test → back to design for any zero-pinned or wide-CI node**, iterating until every entry has an acceptable VIF and a tight CI.

---

## 4. Refuted / corrected claims — do not repeat the originals

- **Unreal Shader Complexity loops:** it is **non-unrolled (dynamic) loops** that are misrepresented (mainly a vertex-shader issue); unrolled loops *are* counted accurately. (Original claim inverted this.)
- **Wong 2010 primacy:** say "an **early/seminal** work," not "the first" — the superlative is unverified, and earlier GPU benchmarking (Volkov & Demmel, SC 2008) exists (aimed at library tuning, not per-instruction microarchitecture). Also, `github.com/spthm/cudabmk` is a **third-party archival reproduction**, not the authors' repo.
- **Adreno 1/8 SFU ratio:** the 16:128 (≈1/8) figure is from the **Snapdragon X-Elite Adreno X1** (a laptop iGPU), used as an **architectural-family proxy — not verified for the Quest 3's Adreno 740**. It is a **structural issue-width ratio (throughput implication), not a measured per-op latency multiple**, and the source supports the **1/8 end only** of the "1/4–1/8" suspicion. Must be re-measured on-device.
- **GPUMech venue:** **MICRO 2014**, not ISCA 2014.
- **Hong & Kim error figure:** **13.3% is the applications** geometric-mean error (**5.4% on microbenchmarks**); validated only on four Tesla-gen NVIDIA GPUs. The "does not transfer to Adreno SFU rates" clause is an **editorial inference** — the paper never mentions Adreno/mobile — consistent with its per-GPU fitting but not stated by it.
- **AOC sourcing:** the instruction-class breakdown + the "not a reliable comparator" / "lacks loop-related contextual information" caveats are in Meta's **blog post**, not the doc page; "SPIR-V" is the correct gloss for Meta's "Android Vulkan."
- **malioc columns:** the compact summary shows a combined **"A"** column; the FMA/CVT/SFU three-way split is in the **detailed** per-pipeline view (Valhall+).
- **DCE rule scope:** the CUDA "write to global memory" rule is literally for compute kernels; the **framebuffer-sink** extension for fragment shaders is a sound **analogy**, not a quote. "Live dependency chain" is the **latency** technique — **throughput** measurement wants **independent** (non-serialized) copies that are still non-foldable and sunk.

**Still uncertain — flag, do not assert:**
- **Pellacini 2005** exact page range/DOI (`10.1145/1073204.1073214`) is **unverified** in this session (title/author/venue/year confirmed).
- **Unity "Shader Heatmap"** as a currently-shipping named feature is **unverified** — it was experimental/legacy; the actionable Unity path collapses to "use malioc."
- The **Adreno-740-specific** SFU rate, occupancy tiers, and every absolute point value: **unknown until measured on Quest** — the entire justification for on-device calibration.

---

## 5. Papers to read

1. Henry Wong, Misel-Myrto Papadopoulou, Maryam Sadooghi-Alvandi, Andreas Moshovos. "Demystifying GPU Microarchitecture through Microbenchmarking." **IEEE ISPASS 2010**, pp. 235–246. DOI 10.1109/ISPASS.2010.5452013. (Seminal k-copy / dependency-chain method.)
2. Zhe Jia, Marco Maggioni, Benjamin Staiger, Daniele P. Scarpazza. "Dissecting the NVIDIA Volta GPU Architecture via Microbenchmarking." **arXiv:1804.06826**, 2018. (Per-instruction latency/throughput incl. SFU rates; DCE-safe kernels.)
3. Hamdy Abdelkhalik, Yehia Arafa, Nandakishore Santhi, Abdel-Hameed Badawy. "Demystifying the Nvidia Ampere Architecture through Microbenchmarking and Instruction-level Analysis." **IEEE HPEC 2022**, arXiv:2208.11174.
4. Xinxin Mei, Xiaowen Chu. "Dissecting GPU Memory Hierarchy through Microbenchmarking." **IEEE TPDS 28(1):72–86**, 2017. DOI 10.1109/TPDS.2016.2549523 (arXiv:1509.02308). (Overhead-differencing / P-chase.)
5. Jan Lemeire et al. "Microbenchmarks for GPU Characteristics: The Occupancy Roofline and the Pipeline Model." **Euromicro PDP 2016**, IEEE. (The additivity-killer: occupancy/register-pressure nonlinearity.)
6. Zitan Liu, Yikai Huang, Ligang Liu. "ShaderPerFormer: Platform-independent Context-aware Shader Performance Predictor." **PACMCGIT 7(1), I3D 2024.** DOI 10.1145/3651295. Code/data: github.com/libreliu/ShaderPerFormer. (Most on-target; context/trace-count cost.)
7. Samuel J. Kaufman et al. "A Learned Performance Model for Tensor Processing Units." **MLSys 2021**, arXiv:2008.01040. (Graph-native GNN cost model — the learned blueprint + additivity test.)
8. Sunpyo Hong, Hyesoon Kim. "An Analytical Model for a GPU Architecture with Memory-level and Thread-level Parallelism Awareness." **ISCA 2009**, pp. 152–163. DOI 10.1145/1555754.1555775. (MWP-CWP; formalizes the additive-ALU hypothesis.)
9. Jen-Cheng Huang, Joo Hwan Lee, Hyesoon Kim, Hsien-Hsin S. Lee. "GPUMech: GPU Performance Modeling Technique Based on Interval Analysis." **MICRO 2014**, pp. 68–79. DOI 10.1109/MICRO.2014.59. (CPI-stack bottleneck attribution.)
10. Pitchaya Sitthi-amorn, Nicholas Modly, Westley Weimer, Jason Lawrence. "Genetic Programming for Shader Simplification." **ACM TOG 30(6), Art. 152, SIGGRAPH Asia 2011.** DOI 10.1145/2070781.2024186. (On-hardware timing as cost fitness; validates measure-don't-guess.)
11. Charles L. Lawson, Richard J. Hanson. *Solving Least Squares Problems.* Prentice-Hall 1974; SIAM Classics in Applied Mathematics 15, 1995 (DOI 10.1137/1.9781611971217), Ch. 23. (NNLS — the default estimator.)
12. Douglas C. Montgomery. *Design and Analysis of Experiments*, 10th ed., Wiley 2019; and A.C. Atkinson, A.N. Donev, R.D. Tobias, *Optimum Experimental Designs, with SAS*, OUP 2007. (Fractional-factorial screening + D-optimal exchange for corpus design.)
13. Bradley Efron. "Bootstrap Methods: Another Look at the Jackknife." **Annals of Statistics 7(1):1–26**, 1979. DOI 10.1214/aos/1176344552. (CIs on the fitted per-node costs.)
14. Douglas Bates, Martin Mächler, Ben Bolker, Steve Walker. "Fitting Linear Mixed-Effects Models Using lme4." **JSS 67(1):1–48**, 2015. DOI 10.18637/jss.v067.i01. (Device/thermal random effects; John W. Tukey, "One degree of freedom for non-additivity," *Biometrics* 5(3):232–242, 1949, DOI 10.2307/3001938, is the companion non-additivity test.)

Tooling references (not papers, but read before building): Arm Mali Offline Compiler User Guide (doc 101863); Meta Horizon "Material Shader Statistics With Adreno Offline Compiler" (doc page + companion blog); Chrome for Developers "What's New in WebGPU (Chrome 121)" + "WebGPU developer features"; Qualcomm "OpenCL Optimization and Best Practices for Adreno GPUs" (ICPE 2018) for the TBDR/FlexRender tiling model.
