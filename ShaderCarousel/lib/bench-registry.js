/* bench-registry — canonical shader corpus for all three benches.
 *
 * Three groups in display order:
 *   • presets — 8 procedural texture reconstructions (polkaDots, grid,
 *     tigerFur, staticNoise, crumpledFabric, gasGiant, marble, wood).
 *     Ported verbatim from the editor's src/registry/builtinTextures.ts
 *     so the corpus tracks what FastShaders actually ships.
 *   • noises — the 8 MaterialX noise atomics the editor exposes as Noise
 *     nodes (perlin/perlinVec3/fbm/fbmVec3/cellNoise/voronoi/voronoiVec2/
 *     voronoiVec3). These are the "atomic" shaders MicroPlane defaults to.
 *   • savedGroups — names read from localStorage['fs:savedGroups'], the
 *     same key the editor's saveGroupToLibrary writes. The current editor
 *     stores graph snapshots, not TSL strings, so without a compile step
 *     these can only be listed — see note at end of this file. The bench
 *     surfaces them with a disabled checkbox and a hint pointing at the
 *     editor; once the editor learns to persist `tslCode` on SavedGroup
 *     this loader picks it up automatically via the `tslCode` field check.
 *
 * The first registry entry is always the baseline (flat color) — both for
 * cycling-start visual consistency and so annotateMarginalCost() can find
 * it via id === 'ref_baseline'. */

/**
 * Build the corpus against a given TSL namespace.
 *   • bench.js (WebGPU)     passes `import * as TSL from 'three/tsl'`
 *   • bench-aframe variants pass `THREE.TSL`
 *
 * Returns a flat list of `{ id, label, category, group, build }` entries.
 * `group` is one of 'baseline' | 'noise' | 'preset' | 'saved'.
 */
export function buildBenchRegistry(TSL) {
  const {
    abs, add, clamp, color, cos, div, dot, exp, fract, max, min, mix, mul,
    normalize, oneMinus, positionGeometry, pow, round, screenUV, sin,
    smoothstep, sqrt, sub, time, uniform, vec3,
    mx_noise_float, mx_noise_vec3,
    mx_fractal_noise_float, mx_fractal_noise_vec3,
    mx_cell_noise_float,
    mx_worley_noise_float, mx_worley_noise_vec2, mx_worley_noise_vec3,
  } = TSL;

  /** Wrap a build fn so a compile failure shows magenta instead of crashing
   *  the whole run — mirrors the editor's unknown-node fallback. */
  const safeWrap = (label, fn) => () => {
    try { return fn(); }
    catch (e) { console.warn(`[bench-registry] ${label}:`, e); return color(0xff00ff); }
  };

  // ── Baseline ────────────────────────────────────────────────────────────
  const baseline = {
    id: 'ref_baseline', label: 'Flat Color (baseline)',
    category: 'baseline', group: 'baseline',
    build: () => color(0x888888),
  };

  // ── Noise atomics ────────────────────────────────────────────────────────
  // Called the way graphToCode emits them: bare positionGeometry, no scale.
  // Float-output noises are wrapped in vec3() so they land in the color slot;
  // vec2 is padded to vec3 with a zero in z.
  const noiseDefs = [
    ['perlin',      'Perlin',         () => vec3(mx_noise_float(positionGeometry))],
    ['perlinVec3',  'Perlin (vec3)',  () => mx_noise_vec3(positionGeometry)],
    ['fbm',         'fBm',            () => vec3(mx_fractal_noise_float(positionGeometry))],
    ['fbmVec3',     'fBm (vec3)',     () => mx_fractal_noise_vec3(positionGeometry)],
    ['cellNoise',   'Cell Noise',     () => vec3(mx_cell_noise_float(positionGeometry))],
    ['voronoi',     'Voronoi F1',     () => vec3(mx_worley_noise_float(positionGeometry))],
    ['voronoiVec2', 'Voronoi F1/F2',  () => vec3(mx_worley_noise_vec2(positionGeometry), 0)],
    ['voronoiVec3', 'Voronoi F1/F2/F3', () => mx_worley_noise_vec3(positionGeometry)],
  ];
  const noises = noiseDefs.map(([id, label, fn]) => ({
    id: `noise_${id}`, label, category: 'noise', group: 'noise',
    build: safeWrap(label, fn),
  }));

  // ── Preset reconstructions ──────────────────────────────────────────────
  // Direct ports from src/registry/builtinTextures.ts. Kept inline rather
  // than imported so this file works in the launcher iframe without a build
  // step. If the editor's builtinTextures change shape, update here too.

  const polkaDots = () => {
    const scale = uniform(3), size = uniform(0.5), blur = uniform(0.25);
    const pos = positionGeometry;
    const sPos = mul(pos, scale);
    const fx = sub(fract(sPos.x), 0.5);
    const fy = sub(fract(sPos.y), 0.5);
    const fz = sub(fract(sPos.z), 0.5);
    const dist = sqrt(add(add(mul(fx, fx), mul(fy, fy)), mul(fz, fz)));
    const xsize = exp(sub(mul(size, 5), 5));
    const blur2 = mul(blur, blur);
    const xblur = mul(blur2, blur2);
    const k = smoothstep(sub(xsize, xblur), add(xsize, xblur), dist);
    return mix(color(0x262680), color(0xFFF7EB), k);
  };

  const grid = () => {
    const scale = uniform(1), count = uniform(8), thickness = uniform(0.05);
    const sPos = mul(positionGeometry, scale);
    const gx = mul(sPos.x, count), gy = mul(sPos.y, count), gz = mul(sPos.z, count);
    const d = min(min(abs(sub(gx, round(gx))), abs(sub(gy, round(gy)))), abs(sub(gz, round(gz))));
    const k = smoothstep(thickness, add(thickness, 0.01), d);
    return mix(color(0x1A1A1A), color(0xF2F2F2), k);
  };

  const tigerFur = () => {
    const scale = uniform(2), lengths = uniform(4), blur = uniform(0.3), strength = uniform(0.3);
    const pos = positionGeometry;
    const xscale = add(div(scale, 2), 1);
    const eScale = exp(xscale);
    const sX = mul(pos.x, eScale), sY = mul(pos.y, eScale), sZ = mul(pos.z, eScale);
    const lenInv = div(1, add(lengths, 5));
    const stripePos = vec3(mul(sX, xscale), mul(sY, lenInv), mul(sZ, lenInv));
    const stripeNoise = mx_noise_float(stripePos);
    const k = add(stripeNoise, sub(strength, 0.5));
    const pattern = oneMinus(smoothstep(mul(blur, -1), blur, k));
    const bellyT = smoothstep(-1, 0.5, pos.y);
    const baseColor = mix(color(0xFFFFED), color(0xFFAB00), bellyT);
    return mul(baseColor, pattern);
  };

  const staticNoiseShader = () => {
    const scaleU = uniform(80), speed = uniform(30);
    const uv = screenUV;
    const uvX = mul(uv.x, scaleU), uvY = mul(uv.y, scaleU);
    const offset = mul(sin(round(mul(time, speed))), 1000);
    const k = mx_noise_float(vec3(uvX, uvY, offset));
    const kNorm = add(mul(k, 0.5), 0.5);
    return vec3(kNorm, kNorm, kNorm);
  };

  const crumpledFabric = () => {
    const scaleU = uniform(2), pinch = uniform(0.5);
    const mainColor = color(0xB0F0FF), subColor = color(0x4040F0), bgColor = color(0x003000);
    const eScale = exp(sub(scaleU, 0.5));
    const pos0 = mul(positionGeometry, eScale);
    const warp = (p) => {
      const x = mx_noise_float(p);
      const y = mx_noise_float(vec3(p.y, p.z, p.x));
      const z = mx_noise_float(vec3(p.z, p.x, p.y));
      return add(p, mul(vec3(x, y, z), pinch));
    };
    const p4 = warp(warp(warp(warp(pos0))));
    const k = clamp(div(add(mx_noise_float(p4), 1), 2), 0, 1);
    const w1 = oneMinus(abs(sub(mul(k, 2), 1)));
    return add(add(mul(mainColor, w1), mul(subColor, pow(k, 2))), mul(bgColor, pow(oneMinus(k), 2)));
  };

  const gasGiant = () => {
    const scaleU = uniform(2), turbulence = uniform(0.3), blur = uniform(0.6);
    const pos = positionGeometry;
    const xscale = add(div(scaleU, 2), 1);
    const sPos = mul(pos, exp(xscale));
    const yt1 = mx_noise_float(vec3(0, mul(pos.y, 0.5), 0));
    const yt2 = mul(mx_noise_float(vec3(0, pos.y, 0)), 0.5);
    const yt3 = mul(mx_noise_float(vec3(1, mul(pos.y, 2), 1)), 0.25);
    const xturb = mul(abs(mul(add(add(yt1, yt2), yt3), turbulence)), 5);
    const wn1 = mx_noise_float(sPos);
    const wn2 = mx_noise_float(add(sPos, 100));
    const wn3 = mx_noise_float(add(sPos, 200));
    const wPos = add(sPos, mul(vec3(wn1, wn2, wn3), xturb));
    const bandRaw = mx_noise_float(vec3(0, mul(wPos.y, xscale), 0));
    const hfRaw = mx_noise_float(mul(wPos, 15));
    const bandTotal = add(bandRaw, mul(hfRaw, oneMinus(pow(blur, 0.2))));
    const k = oneMinus(smoothstep(-1, 1, sub(bandTotal, 0.5)));
    const yColK = add(mx_noise_float(vec3(0, mul(pos.y, 0.75), 0)), 1);
    const base = mix(color(0xF0E8B0), color(0xFFF8F0), yColK);
    return mul(mix(base, color(0xAFA0D0), mul(xturb, 0.3)), k);
  };

  const marble = () => {
    const scaleU = uniform(3), sharpness = uniform(0.2), detail = uniform(0.3);
    const sPos = mul(positionGeometry, scaleU);
    const n1 = mx_noise_float(sPos);
    const n2 = mul(mx_noise_float(mul(sPos, 2)), 0.5);
    const n3 = mul(mx_noise_float(mul(sPos, 6)), 0.1);
    const veins = oneMinus(pow(abs(add(add(n1, n2), n3)), sharpness));
    const detailPow = pow(abs(mx_noise_float(mul(sPos, 50))), 3);
    return mix(color(0xF0F8FF), color(0x4545D3), add(veins, mul(detailPow, detail)));
  };

  const wood = () => {
    const scaleU = uniform(2.5), rings = uniform(4.5), lengths = uniform(1);
    const angle = uniform(0), fibers = uniform(0.3), fibersDensity = uniform(10);
    const pos = positionGeometry;
    const angleRad = mul(angle, 0.01745329);
    const cosA = cos(angleRad), sinA = sin(angleRad);
    const rotX = sub(mul(pos.x, cosA), mul(pos.y, sinA));
    const rotY = add(mul(pos.x, sinA), mul(pos.y, cosA));
    const scaleE = exp(sub(scaleU, 3));
    const invLen = div(1, max(lengths, 0.01));
    const ringScaleXZ = mul(scaleE, invLen);
    const ringScaleY = mul(scaleE, 4);
    const ringPos = vec3(mul(rotX, ringScaleXZ), mul(rotY, ringScaleY), mul(pos.z, ringScaleXZ));
    const rBase = mul(mul(add(mx_noise_float(ringPos), 1), 10), rings);
    const k = div(add(cos(add(rBase, cos(rBase))), 1), 2);
    const fiberE = exp(sub(scaleU, 2));
    const fiberScaleY = mul(fiberE, fibersDensity);
    const fiberOctave = (s, w) => {
      const sx = mul(fiberE, s);
      const sy = mul(fiberScaleY, s);
      const fPos = vec3(mul(rotX, sx), mul(rotY, sy), mul(pos.z, sx));
      return mul(w, mx_noise_float(fPos));
    };
    const fAcc = add(add(add(fiberOctave(1, 2), fiberOctave(1.8, 1.2)), fiberOctave(3.24, 0.72)), fiberOctave(5.832, 0.432));
    const kk = div(add(sin(mul(fAcc, 11.49)), 1), 2);
    return mix(color(0xCC6600), color(0x661A00), mix(k, kk, fibers));
  };

  const presetDefs = [
    ['polkaDots',      'Polka Dots',      polkaDots],
    ['grid',           'Grid',            grid],
    ['tigerFur',       'Tiger Fur',       tigerFur],
    ['staticNoise',    'Static Noise',    staticNoiseShader],
    ['crumpledFabric', 'Crumpled Fabric', crumpledFabric],
    ['gasGiant',       'Gas Giant',       gasGiant],
    ['marble',         'Marble',          marble],
    ['wood',           'Wood',            wood],
  ];
  const presets = presetDefs.map(([id, label, fn]) => ({
    id: `preset_${id}`, label, category: 'preset', group: 'preset',
    build: safeWrap(label, fn),
  }));

  // ── Calibration corpus (k-copy isolation sweeps + combinations) ─────────
  //
  // Purpose: recover PRECISE per-node marginal cost by regression rather than
  // hand-guessing complexity.json. Two ideas do the work:
  //
  //   1. k-COPY AMORTIZATION. Evaluate one target op k times on DISTINCT,
  //      runtime-varying inputs and accumulate into the output. The marginal
  //      per-pass cost measured at k ∈ {1,4,16} is linear in k with slope =
  //      cost of one op instance. Run the whole family and fit the slope
  //      (bench-stats already gives per-shader ms/pass via the two-level
  //      N/2N method; a second fit over k isolates the node).
  //
  //   2. A SCAFFOLD CONTROL. Every calib shader carries identical per-copy
  //      overhead: the seed transform + the accumulate. `calib_scaffold_x*`
  //      is that loop with the op removed, so (op slope − scaffold slope)
  //      isolates the op — finer than subtracting the flat baseline, which
  //      matters for cheap ops whose seed cost isn't negligible.
  //
  // DEAD-CODE / CSE SAFETY (the whole thing is worthless if the compiler
  // folds it away):
  //   • `seed()` is a per-fragment (positionGeometry) AND per-copy (i)
  //     distinct value, so no two copies common-subexpression-merge and the
  //     compiler can't hoist to a uniform/vertex stage.
  //   • It is wrapped in `fract()` — a NON-LINEAR guard. Without it the
  //     scaffold's Σ of linear transforms would algebraically collapse to a
  //     single mul+add and stop scaling with k, breaking the control.
  //   • Every copy accumulates into the returned colour, so nothing is
  //     dead-code-eliminated (see the two `combo_dce_*` sentinels, which
  //     deliberately CAN be eliminated and should measure ≈ baseline).
  //
  // Edit K_LEVELS / OPS to change the sweep. These default OFF in the picker
  // (not in any bench's DEFAULT_GROUPS) — tick "Calibration" to run them,
  // ideally in MicroPlane where per-node points are derived.
  const K_LEVELS = [1, 4, 16];

  // seed(p0, i): distinct, runtime-varying, non-collapsible per-copy input in
  // [0,1)³. Primes-ish constants avoid coincidental CSE between copies.
  const seed = (p0, i) =>
    fract(add(mul(p0, 1 + i * 0.13717), vec3(i * 0.7919, i * 1.3313, i * 0.5171)));

  // kCopy(k, opFn): k distinct evaluations of opFn, accumulated (DCE-safe).
  // The trailing `mul(acc, 1/k)` keeps the output in-gamut; it's one op,
  // independent of k, so it cancels in the slope.
  const kCopy = (k, opFn) => () => {
    const p0 = positionGeometry;
    let acc = vec3(0);
    for (let i = 0; i < k; i++) acc = add(acc, opFn(seed(p0, i)));
    return mul(acc, 1 / k);
  };

  // Isolation ops. Each takes a seeded vec3 p ∈ [0,1)³ and returns a vec3 —
  // exactly one "node instance" as the editor would emit it on vec3 data
  // (so the measured cost maps straight onto a complexity.json entry). Binary
  // ops derive their 2nd operand from p via a (free) swizzle.
  const OPS = [
    ['mul',        'mul',        (p) => mul(p, p.yzx)],
    ['add',        'add',        (p) => add(p, p.zxy)],
    ['mix',        'mix',        (p) => mix(p, p.yzx, 0.5)],
    ['clamp',      'clamp',      (p) => clamp(p, 0, 1)],
    ['smoothstep', 'smoothstep', (p) => smoothstep(0, 1, p)],
    ['sin',        'sin',        (p) => sin(p)],
    ['sqrt',       'sqrt',       (p) => sqrt(p)],                    // p ≥ 0 (fract)
    ['div',        'div',        (p) => div(p, add(p.yzx, 0.1))],    // denom ≥ 0.1
    ['exp',        'exp',        (p) => exp(p)],                     // p < 1 → no overflow
    ['pow',        'pow',        (p) => pow(p, vec3(2.2))],
    ['dot',        'dot',        (p) => vec3(dot(p, p.yzx))],
    ['normalize',  'normalize',  (p) => normalize(add(p, 0.1))],
    ['perlin',     'Perlin',     (p) => vec3(mx_noise_float(p))],
    ['fbm',        'fBm',        (p) => vec3(mx_fractal_noise_float(p))],
    ['cellNoise',  'Cell',       (p) => vec3(mx_cell_noise_float(p))],
    ['voronoi',    'Voronoi',    (p) => vec3(mx_worley_noise_float(p))],
  ];

  const calib = [];
  for (const k of K_LEVELS) {
    calib.push({
      id: `calib_scaffold_x${k}`, label: `scaffold ×${k}`,
      category: 'calib', group: 'calib',
      build: safeWrap(`scaffold x${k}`, kCopy(k, (p) => p)),
    });
  }
  for (const [id, label, opFn] of OPS) {
    for (const k of K_LEVELS) {
      calib.push({
        id: `calib_${id}_x${k}`, label: `${label} ×${k}`,
        category: 'calib', group: 'calib',
        build: safeWrap(`${id} x${k}`, kCopy(k, opFn)),
      });
    }
  }

  // ── Combinations (additivity, ILP, and DCE-integrity probes) ────────────
  // These answer "does sum-of-parts predict the whole?" and validate the
  // measurement itself. Each documents its node inventory so the team can
  // compute predicted points from complexity.json and compare.
  const combos = [
    {
      // Additive check: predicted ≈ 4·(sin−scaffold) + 4·(sqrt−scaffold).
      id: 'combo_sin4_sqrt4', label: 'sin×4 + sqrt×4 (additivity)',
      build: safeWrap('combo sin4 sqrt4', () => {
        const p0 = positionGeometry;
        let a = vec3(0), b = vec3(0);
        for (let i = 0; i < 4; i++) a = add(a, sin(seed(p0, i)));
        for (let i = 0; i < 4; i++) b = add(b, sqrt(seed(p0, i + 4)));
        return mul(add(a, b), 0.125);
      }),
    },
    {
      // Additive check on the expensive/uncertain end (voronoi is suspected
      // ~4× underpriced — this + the isolation sweep localise that).
      id: 'combo_perlin4_voronoi4', label: 'Perlin×4 + Voronoi×4 (additivity)',
      build: safeWrap('combo perlin4 voronoi4', () => {
        const p0 = positionGeometry;
        let a = vec3(0), b = vec3(0);
        for (let i = 0; i < 4; i++) a = add(a, vec3(mx_noise_float(seed(p0, i))));
        for (let i = 0; i < 4; i++) b = add(b, vec3(mx_worley_noise_float(seed(p0, i + 4))));
        return mul(add(a, b), 0.125);
      }),
    },
    {
      // Throughput: 8 INDEPENDENT sqrt (SFU) — schedules in parallel.
      id: 'combo_sqrt_parallel8', label: 'sqrt×8 parallel (throughput)',
      build: safeWrap('combo sqrt parallel8', () => {
        const p0 = positionGeometry;
        let acc = vec3(0);
        for (let i = 0; i < 8; i++) acc = add(acc, sqrt(seed(p0, i)));
        return mul(acc, 0.125);
      }),
    },
    {
      // Latency: the SAME 8 sqrt in a dependency CHAIN — can't parallelise.
      // chain − parallel exposes how much the point model (a throughput
      // count) under/over-states serial SFU work.
      id: 'combo_sqrt_chain8', label: 'sqrt×8 chained (latency)',
      build: safeWrap('combo sqrt chain8', () => {
        const p0 = positionGeometry;
        let v = seed(p0, 0);
        for (let i = 1; i <= 8; i++) v = sqrt(add(mul(v, 0.999), 0.001));
        return v;
      }),
    },
    {
      // End-to-end model check. Inventory: 3 perlin + 2 sin + 1 smoothstep +
      // 1 mix + ~4 mul + 1 oneMinus. Predicted pts (current table) ≈
      // 3·35 + 2·4 + 7 + 2 + 4·1 + 1 = 127. Compare to measured marginal pts.
      id: 'combo_model_check', label: 'model check (3·perlin+2·sin+…)',
      build: safeWrap('combo model check', () => {
        const p0 = positionGeometry;
        const n1 = mx_noise_float(seed(p0, 0));
        const n2 = mx_noise_float(seed(p0, 1));
        const n3 = mx_noise_float(seed(p0, 2));
        const s1 = sin(mul(n1, 6.2832));
        const s2 = sin(mul(n2, 6.2832));
        const m = mix(vec3(n3), vec3(s1), smoothstep(0, 1, s2));
        return mul(m, oneMinus(mul(n1, n2)));
      }),
    },
    {
      // DCE sentinel (dropped): fBm×4 multiplied by 0 → a correct compiler
      // eliminates the whole chain, so this should measure ≈ baseline. If it
      // costs like fBm×4, the backend isn't DCE-ing zero-weighted work.
      id: 'combo_dce_dropped', label: 'DCE sentinel: fBm×4 × 0 (≈baseline)',
      build: safeWrap('combo dce dropped', () => {
        const p0 = positionGeometry;
        let acc = vec3(0);
        for (let i = 0; i < 4; i++) acc = add(acc, vec3(mx_fractal_noise_float(seed(p0, i))));
        return add(color(0x888888), mul(acc, 0));
      }),
    },
    {
      // DCE sentinel (kept): identical fBm×4 but weight 0.25. dropped−kept
      // ≈ −(fBm×4 cost) proves the delta is DCE, not noise — and confirms
      // the accumulation in every calib shader above is load-bearing.
      id: 'combo_dce_kept', label: 'DCE sentinel: fBm×4 × 0.25 (kept)',
      build: safeWrap('combo dce kept', () => {
        const p0 = positionGeometry;
        let acc = vec3(0);
        for (let i = 0; i < 4; i++) acc = add(acc, vec3(mx_fractal_noise_float(seed(p0, i))));
        return add(color(0x222222), mul(acc, 0.25));
      }),
    },
  ].map(c => ({ ...c, category: 'combo', group: 'combo' }));

  // ── Saved Groups (from editor localStorage) ─────────────────────────────
  // The editor's saveGroupToLibrary persists graph snapshots, not TSL code.
  // Until it also writes a `tslCode: string` field on SavedGroup, the bench
  // can list groups by name but can't execute them. When the editor learns
  // to persist `tslCode`, the bench picks it up here without further changes.
  const saved = loadSavedGroups(TSL);

  return [baseline, ...presets, ...noises, ...calib, ...combos, ...saved];
}

function loadSavedGroups(TSL) {
  let raw;
  try { raw = localStorage.getItem('fs:savedGroups'); } catch { return []; }
  if (!raw) return [];

  let parsed;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(parsed)) return [];

  return parsed.filter(g => g && typeof g.id === 'string').map(g => {
    const compiled = compileSavedGroup(g, TSL);
    return {
      id: `saved_${g.id}`,
      label: g.name || 'Saved Group',
      category: 'saved',
      group: 'saved',
      // `disabled` is true if we can't execute it — picker greys it out
      // and exposes a hint pointing at the editor.
      disabled: !compiled.runnable,
      disabledReason: compiled.reason,
      build: compiled.runnable ? compiled.build : null,
    };
  });
}

function compileSavedGroup(g, _TSL) {
  // SECURITY: the original implementation here executed g.tslCode via
  // `new Function('TSL', \`with (TSL) { ${g.tslCode}; ... }\`)` so any
  // process able to write `fs:savedGroups` (XSS in the editor, hand-edited
  // localStorage, a tampered shared file that the editor accepts) could
  // achieve arbitrary JS execution inside the bench origin the moment that
  // payload included a `tslCode` field. That code path was dormant — the
  // editor's saveGroupToLibrary does not persist `tslCode` — so removing
  // it loses no shipped functionality. If/when saved groups grow real TSL
  // round-tripping, recompile inside a sandboxed worker or evaluate via the
  // same shaderloader pipeline the editor uses (parsed, not executed via
  // Function-with-`with`).
  if (typeof g.tslCode === 'string' && g.tslCode.trim().length) {
    return {
      runnable: false,
      reason: 'inline tslCode execution disabled — bench needs a sandboxed compile step',
    };
  }
  return {
    runnable: false,
    reason: 'editor needs to export TSL — re-save group in FastShaders v0.1.14+',
  };
}
