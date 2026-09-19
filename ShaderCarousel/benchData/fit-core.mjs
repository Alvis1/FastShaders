/* fit-core — the PURE half of fit-calibration.mjs.
 *
 * Everything the calibration fit COMPUTES lives here, with no file system and
 * no process: `src/registry/fitCalibration.test.ts` imports this module and
 * pins it, while fit-calibration.mjs keeps only the I/O (argv, reading the run
 * and complexity.json, writing --texture-json). Its report text is built here
 * too (`renderCalibrationReport`), so the test can hold the CLI's output to a
 * committed golden against a FIXED cost table instead of whatever
 * complexity.json says that week.
 *
 * Its one import is BUDGET_MS, so the points a fit suggests are the points
 * the bench's own export would suggest.
 */

import { BUDGET_MS } from '../lib/bench-stats.js';

/** The k-copy sweep id the registry emits: `calib_<op>_x<k>`. */
export const K_RE = /^calib_(.+)_x(\d+)$/;

const hasOwn = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);

// ── Least squares ───────────────────────────────────────────────────────────
export function ols(xs, ys) {
  const n = xs.length;
  if (n < 2) return { slope: NaN, intercept: NaN, r2: NaN, n };
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  const slope = sxx ? sxy / sxx : 0;
  return { slope, intercept: my - slope * mx, r2: syy ? (sxy * sxy) / (sxx * syy) : 1, n };
}

const pointsOf = (ms, budgetMs) => Math.round((ms / budgetMs) * 100);

/** Prefer resolution-normalized marginal; fall back to raw marginal, then median. */
export const costOf = s => s?.stats?.marginalMsAtRef ?? s?.stats?.marginalMs ?? s?.stats?.medianFt ?? null;

/* The scaffold is PER FAMILY. Every calib shader carries per-copy overhead
 * (the seed transform + the accumulate) and the fit subtracts it, so the
 * number is the op alone. A texture atom's per-copy overhead is its own UV
 * derivation, not the ALU seed, so the texture family is measured against
 * its own `calib_tex_scaffold_x*` sweep; subtracting the ALU scaffold from a
 * fetch would mis-state every texture price. Both scaffolds stay out of the
 * op table. */
export const isScaffold = op => op === 'scaffold' || op === 'tex_scaffold';
export const scaffoldFor = op => (op.startsWith('tex_') ? 'tex_scaffold' : 'scaffold');

/** id → the sweep it belongs to: Map op → [{k, ms}] (rows with no cost skipped). */
export function collectSweeps(shaders) {
  const sweeps = new Map();
  for (const s of shaders || []) {
    const m = typeof s?.id === 'string' ? K_RE.exec(s.id) : null;
    if (!m) continue;
    const [, op, k] = m;
    const ms = costOf(s);
    if (ms == null) continue;
    if (!sweeps.has(op)) sweeps.set(op, []);
    sweeps.get(op).push({ k: +k, ms });
  }
  return sweeps;
}

/** OLS of ms against k for one op, or null with fewer than two points. */
export function fitOp(sweeps, op) {
  const rows = (sweeps.get(op) || []).sort((a, b) => a.k - b.k);
  if (rows.length < 2) return null;
  return { ...ols(rows.map(r => r.k), rows.map(r => r.ms)), rows };
}

/** The texture atoms that price a complexity.json entry directly. */
export const TABLE_KEY = Object.freeze({ tex_c2048: 'imageNode', tex_lut256: 'colormap' });

/* A RESTATEMENT of src/utils/nodeCost.ts's IMAGE_COST_REF_SIDE /
 * IMAGE_COST_FLOOR_SIDE / IMAGE_COST_MIN_SCALE — this file cannot import the
 * app's TypeScript. src/registry/fitCalibration.test.ts pins the two against
 * each other (constants AND imageNodeCost at every side), so moving one
 * without the other fails the suite. */
export const IMAGE_CURVE = Object.freeze({ REF_SIDE: 2048, FLOOR_SIDE: 256, MIN_SCALE: 0.5 });

/** The Image node's size discount at a geometric-mean side (nodeCost's curve). */
export function imageCurveScale(side, curve = IMAGE_CURVE) {
  const t = Math.min(1, Math.max(0, Math.log2(side / curve.FLOOR_SIDE) / Math.log2(curve.REF_SIDE / curve.FLOOR_SIDE)));
  return curve.MIN_SCALE + (1 - curve.MIN_SCALE) * t;
}

/** What the current table charges for the node an op measures (null = no entry). */
export function currentPriceFor(op, current) {
  const own = k => (hasOwn(current, k) && typeof current[k] === 'number' ? current[k] : null);
  if (op === 'tex_lut256') return own('colormap');
  const side = op === 'tex_c256' ? 256 : op === 'tex_c1024' ? 1024 : null;
  if (side != null) {
    const base = own('imageNode');
    return base == null ? null : Math.round(base * imageCurveScale(side));
  }
  if (op.startsWith('tex_')) return own('imageNode');
  return own(op);
}

/** The op table: one row per fitted non-scaffold op, net of its family's scaffold. */
export function netOpRows(shaders, current, budgetMs = BUDGET_MS) {
  const sweeps = collectSweeps(shaders);
  const rows = [];
  for (const op of [...sweeps.keys()].filter(o => !isScaffold(o)).sort()) {
    const f = fitOp(sweeps, op);
    if (!f) continue;
    const net = f.slope - (fitOp(sweeps, scaffoldFor(op))?.slope ?? 0); // op cost with scaffold removed
    const suggested = pointsOf(Math.max(0, net), budgetMs);
    const cur = currentPriceFor(op, current);
    const delta = cur != null ? suggested - cur : null;
    const flags = [];
    if (f.r2 < 0.97) flags.push('nonlinear?');       // poor line fit → amortization/pressure
    if (net <= 0) flags.push('below-scaffold');      // op cheaper than overhead → measurement floor
    if (cur != null && Math.abs(delta) >= Math.max(3, cur * 0.5)) flags.push('mispriced');
    rows.push({ op, net, r2: f.r2, suggested, cur, delta, flags });
  }
  return rows;
}

const TEX_SIDES = [256, 1024, 2048, 4096];

/**
 * The texture family's report, or null when the run carries no `tex_*` sweep
 * (every run committed before the texture groups existed). Ratios are taken
 * over net MILLISECONDS, not rounded points — at a few points per fetch the
 * rounding alone would move MIN_SCALE by a tenth.
 */
export function textureReport(shaders, current, budgetMs = BUDGET_MS) {
  const sweeps = collectSweeps(shaders);
  const scaffold = fitOp(sweeps, 'tex_scaffold');
  const scaffoldMs = scaffold ? scaffold.slope : null;
  const atoms = {};
  for (const op of [...sweeps.keys()].filter(o => o.startsWith('tex_') && !isScaffold(o)).sort()) {
    const f = fitOp(sweeps, op);
    if (!f) continue;
    const netMs = f.slope - (scaffoldMs ?? 0);
    atoms[op] = { netMs, points: pointsOf(Math.max(0, netMs), budgetMs), r2: f.r2, current: currentPriceFor(op, current) };
  }
  if (!Object.keys(atoms).length) return null;

  const netOf = op => (hasOwn(atoms, op) ? atoms[op].netMs : null);
  // A net at or below the scaffold is under the measurement floor, not a
  // price: it is FLAGGED below and never becomes a ratio. Letting it through
  // made a negative c256 net suggest IMAGE_COST_MIN_SCALE 0.1 (the clamp) with
  // no flag at all, i.e. a 256 px image at 1 point, under colormap.
  const ratio = (num, den) => (num != null && den != null && num > 0 && den > 0 ? num / den : null);

  const ms = {}, ratioTo2048 = {}, currentRatio = {};
  for (const side of TEX_SIDES) ms[side] = netOf(`tex_c${side}`);
  for (const side of TEX_SIDES) {
    ratioTo2048[side] = ratio(ms[side], ms[2048]);
    currentRatio[side] = imageCurveScale(side) / imageCurveScale(IMAGE_CURVE.REF_SIDE);
  }
  const r256 = ratioTo2048[256];
  const suggestedMinScale = r256 == null ? null : Math.min(1, Math.max(0.1, Math.round(r256 * 100) / 100));
  // What a log-linear curve through the suggested floor predicts at 1024 px
  // (two thirds of the way from 256 to 2048), against what was measured.
  const predicted = suggestedMinScale == null ? null : imageCurveScale(1024, { ...IMAGE_CURVE, MIN_SCALE: suggestedMinScale });
  const measured = ratioTo2048[1024];
  const residual = predicted != null && measured != null ? measured - predicted : null;
  const flatAbove2048 = ratioTo2048[4096];

  const c2048 = netOf('tex_c2048'), d2048 = netOf('tex_d2048');
  const c2048q = netOf('tex_c2048q'), d2048q = netOf('tex_d2048q');
  const coherence = {
    dataOverColour: ratio(d2048, c2048),
    minifiedColourOverFull: ratio(c2048q, c2048),
    minifiedDataOverColour: ratio(d2048q, c2048q),
    minifiedDataOverFull: ratio(d2048q, c2048),
  };

  const profileRow = (shaders || []).find(s => s?.id === 'texture_imageNode');
  const profilePts = profileRow?.stats?.marginalPoints;
  const profileCrossCheck = {
    texture_imageNode: typeof profilePts === 'number' ? profilePts : null,
    fit: hasOwn(atoms, 'tex_c2048') ? atoms.tex_c2048.points : null,
  };

  const suggestions = {
    imageNode: hasOwn(atoms, 'tex_c2048') ? atoms.tex_c2048.points : null,
    colormap: hasOwn(atoms, 'tex_lut256') ? atoms.tex_lut256.points : null,
    IMAGE_COST_MIN_SCALE: suggestedMinScale,
  };

  const flags = [];
  if (scaffoldMs == null) flags.push('no calib_tex_scaffold sweep: the texture atoms still carry their per-copy overhead');
  for (const op of Object.keys(atoms)) {
    if (atoms[op].r2 < 0.97) flags.push(`nonlinear? ${op} (R²=${atoms[op].r2.toFixed(3)})`);
    if (atoms[op].netMs <= 0) flags.push(`below-scaffold ${op} (net ${atoms[op].netMs.toFixed(5)} ms <= 0): under the measurement floor, not a price`);
  }
  if (hasOwn(atoms, 'tex_c2048') && atoms.tex_c2048.points < 2) {
    flags.push(`tex_c2048 at ${atoms.tex_c2048.points} pts: below the 2-point measurement floor`);
  }
  // Bigger textures may not be CHEAPER; one point of slack absorbs rounding.
  // Only up to the anchor side: gate 4 (METHODS §6.5) is c256 ≤ c1024 ≤ c2048,
  // and above it the flatAbove2048 flag owns the question (an owner decision
  // in §6.6, not a gate), so a 4096 inside its own band must not read as a
  // gate-4 failure.
  const curve = TEX_SIDES
    .filter(side => side <= IMAGE_CURVE.REF_SIDE && hasOwn(atoms, `tex_c${side}`))
    .map(side => [side, atoms[`tex_c${side}`].points]);
  for (let i = 1; i < curve.length; i++) {
    if (curve[i][1] < curve[i - 1][1] - 1) {
      flags.push(`size curve not monotone: ${curve[i - 1][0]} px ${curve[i - 1][1]} pts > ${curve[i][0]} px ${curve[i][1]} pts`);
      break;
    }
  }
  if (c2048q != null && c2048 != null && c2048q >= c2048) {
    flags.push('minified colour (c2048q) is not cheaper than full-footprint colour (c2048): are the mips being used?');
  }
  if (d2048q != null && c2048q != null && d2048q < c2048q) {
    flags.push('minified data (d2048q) is cheaper than minified colour (c2048q): a no-mip fetch should miss cache more');
  }
  if (flatAbove2048 != null && (flatAbove2048 < 0.85 || flatAbove2048 > 1.15)) {
    flags.push(`4096/2048 = ${flatAbove2048.toFixed(2)}, outside [0.85, 1.15]: the price is not flat above 2048`);
  }
  if (residual != null && Math.abs(residual) > 0.1) {
    flags.push(`log-linear residual at 1024 = ${residual.toFixed(3)} (> 0.1)`);
  }

  return {
    scaffoldMs,
    atoms,
    sizeCurve: { ms, ratioTo2048, currentRatio, suggestedMinScale, logLinearAt1024: { predicted, measured, residual }, flatAbove2048 },
    coherence,
    profileCrossCheck,
    suggestions,
    flags,
  };
}

// Predicted from ISOLATION SLOPES (which already include per-copy scaffold),
// so a k-copy combo predicts as Σ kᵢ·slope(opᵢ). Ratio measured/predicted ≈ 1
// ⟺ node costs add.
export const ADDITIVITY = Object.freeze([
  { id: 'combo_sin4_sqrt4', terms: [['sin', 4], ['sqrt', 4]] },
  { id: 'combo_perlin4_voronoi4', terms: [['perlin', 4], ['voronoi', 4]] },
  { id: 'combo_tex4_perlin4', terms: [['tex_c2048', 4], ['perlin', 4]] },
]);

/** True when a run carries at least one fittable texture sweep. */
function hasTextureSweep(shaders) {
  const sweeps = collectSweeps(shaders);
  for (const op of sweeps.keys()) if (op.startsWith('tex_') && !isScaffold(op) && fitOp(sweeps, op)) return true;
  return false;
}

/* Whether a RAW run can price at all: the gates bench-stats' buildSuggestion
 * (and costOverride's raw branch) turn into `valid: false`, restated as a
 * pure predicate because both of those mutate `shaders`. A raw export carries
 * no validity block of its own, so without this an InOut run (raf-delta, no
 * resolution) or a vsync-clamped / baseline-less Static run was eligible, and
 * the Static preference then shipped its numbers. InOut never prices. */
function canPrice(r) {
  const md = r?.metadata || {};
  return md.bench !== 'inout'
    && md.timingMethod !== 'raf-delta'
    && !md.vsyncClamping
    && md.resolution?.width > 0 && md.resolution?.height > 0
    && r.shaders.some(s => s?.id === 'ref_baseline')
    && !r.shaders.some(s => s?.stats?.insufficientData);
}

/** The run a price change should come from: among runs that can price and
 *  carry texture sweeps, a Static run first (measured at the reference
 *  resolution, as the noise family's shipped prices are), then the latest
 *  metadata.date. */
export function pickShippingRun(runs) {
  const eligible = (runs || []).filter(r => Array.isArray(r?.shaders) && canPrice(r) && hasTextureSweep(r.shaders));
  if (!eligible.length) return null;
  const when = r => { const t = Date.parse(r?.metadata?.date); return Number.isFinite(t) ? t : -Infinity; };
  const isStatic = r => r?.metadata?.bench === 'static';
  return eligible.reduce((best, r) => {
    if (isStatic(r) !== isStatic(best)) return isStatic(r) ? r : best;
    return when(r) > when(best) ? r : best;
  });
}

function textureSectionLines(tex) {
  const n = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '—');
  const lines = [`\nTexture atoms (net of calib_tex_scaffold, ${n(tex.scaffoldMs, 5)} ms/copy subtracted):`];
  const ops = Object.keys(tex.atoms).sort();
  const w = Math.max(...ops.map(o => o.length));
  for (const op of ops) {
    const a = tex.atoms[op];
    const key = hasOwn(TABLE_KEY, op) ? `  → ${TABLE_KEY[op]}` : '';
    lines.push(`  ${op.padEnd(w)}  ${n(a.netMs, 5)} ms  ${a.points} pts  R²=${n(a.r2, 3)}  current ${a.current ?? '—'}${key}`);
  }
  const sc = tex.sizeCurve;
  lines.push(`Size curve: MIN_SCALE current ${IMAGE_CURVE.MIN_SCALE} → suggested ${sc.suggestedMinScale ?? '—'} (log-linear residual at 1024: ${n(sc.logLinearAt1024.residual, 3)}; 4096/2048 = ${n(sc.flatAbove2048, 2)})`);
  const co = tex.coherence;
  lines.push(`Coherence: data/colour ${n(co.dataOverColour, 2)}   minified colour/full ${n(co.minifiedColourOverFull, 2)}   minified data/colour ${n(co.minifiedDataOverColour, 2)}   minified data/full ${n(co.minifiedDataOverFull, 2)}`);
  const pc = tex.profileCrossCheck;
  lines.push(`Profile cross-check: texture_imageNode ${pc.texture_imageNode ?? '—'} pts/copy vs fit tex_c2048 ${pc.fit ?? '—'} pts`);
  const sg = tex.suggestions;
  lines.push(`Suggested: imageNode ${sg.imageNode ?? '—'}   colormap ${sg.colormap ?? '—'}   IMAGE_COST_MIN_SCALE ${sg.IMAGE_COST_MIN_SCALE ?? '—'}`);
  lines.push(tex.flags.length ? `  ⚠ ${tex.flags.join('\n  ⚠ ')}` : 'Texture flags: none');
  return lines;
}

/**
 * The CLI's whole report, as the strings it hands to console.log one by one
 * (an entry may itself contain newlines — the header's leading blank line and
 * the joined ⚠ reasons were always printed that way). For an ALU-only run the
 * text is byte-identical to what fit-calibration.mjs printed before this module
 * existed; the golden in src/registry/fixtures/fitCalibrationCli.txt was
 * captured from that older CLI.
 */
export function renderCalibrationReport(run, inPath, current, budgetMs = BUDGET_MS) {
  const out = [];
  const log = s => out.push(s);
  const shaders = run?.shaders || [];
  const sweeps = collectSweeps(shaders);
  const byId = new Map(shaders.map(s => [s.id, s]));
  const scaffold = fitOp(sweeps, 'scaffold');
  const scaffoldSlope = scaffold?.slope ?? 0;

  // ── Per-op report ─────────────────────────────────────────────────────────
  log(`\nMicroPlane calibration fit  —  ${inPath}`);
  log(`device: ${run.metadata?.gpu || run.metadata?.device || '?'}   timing: ${run.metadata?.timingMethod || '?'}   valid: ${run.metadata?.valid ?? '?'}`);
  if (run.metadata?.reasons?.length) log(`  ⚠ ${run.metadata.reasons.join('\n  ⚠ ')}`);
  log(`scaffold slope (per-copy overhead, subtracted): ${scaffoldSlope.toFixed(5)} ms  (R²=${scaffold?.r2?.toFixed(3) ?? '—'})\n`);

  const header = ['op', 'ms/copy(net)', 'R²', 'suggested', 'current', 'Δ', 'flag'];
  const rows = netOpRows(shaders, current, budgetMs).map(r =>
    [r.op, r.net.toFixed(5), r.r2.toFixed(3), String(r.suggested), r.cur ?? '—', r.delta ?? '—', r.flags.join(' ')]);
  const w = header.map((h, i) => Math.max(h.length, ...rows.map(r => String(r[i]).length)));
  const fmt = r => r.map((c, i) => String(c).padEnd(w[i])).join('  ');
  log(fmt(header));
  log(w.map(n => '─'.repeat(n)).join('  '));
  rows.forEach(r => log(fmt(r)));

  // ── Texture atoms ─────────────────────────────────────────────────────────
  const tex = textureReport(shaders, current, budgetMs);
  if (tex) textureSectionLines(tex).forEach(log);

  // ── Additivity checks (combos) ────────────────────────────────────────────
  const slopeOf = op => fitOp(sweeps, op)?.slope ?? null;
  log('\nAdditivity (measured ÷ predicted-from-isolation):');
  for (const c of ADDITIVITY) {
    // A run without the texture groups has nothing to say about a texture combo.
    if (!tex && c.terms.some(([op]) => op.startsWith('tex_'))) continue;
    const s = byId.get(c.id);
    const measured = costOf(s);
    const predicted = c.terms.reduce((acc, [op, k]) => acc + (slopeOf(op) ?? NaN) * k, 0);
    if (measured == null || !isFinite(predicted)) { log(`  ${c.id}: missing data`); continue; }
    const ratio = measured / predicted;
    const verdict = Math.abs(ratio - 1) < 0.15 ? 'additive' : ratio > 1 ? 'SUPER-additive (whole > parts)' : 'SUB-additive (whole < parts)';
    log(`  ${c.id}: measured ${measured.toFixed(5)} / predicted ${predicted.toFixed(5)} = ${ratio.toFixed(2)}×  → ${verdict}`);
  }

  // ILP: sqrt chained vs parallel (same 8 sqrts)
  const par = costOf(byId.get('combo_sqrt_parallel8'));
  const chn = costOf(byId.get('combo_sqrt_chain8'));
  if (par != null && chn != null) {
    log(`\nILP (sqrt×8): chain ${chn.toFixed(5)} / parallel ${par.toFixed(5)} = ${(chn / par).toFixed(2)}×  (>1 ⟹ latency-bound; point model counts throughput only)`);
  }

  // DCE sentinel integrity
  const dropped = costOf(byId.get('combo_dce_dropped'));
  const kept = costOf(byId.get('combo_dce_kept'));
  if (dropped != null && kept != null) {
    const dceWorks = Math.abs(dropped) < 0.2 * Math.abs(kept);
    log(`\nDCE sentinel: dropped ${dropped.toFixed(5)} vs kept ${kept.toFixed(5)}  → compiler DCE ${dceWorks ? 'ACTIVE (good: accumulation is load-bearing)' : 'NOT eliminating zero-weighted work (accumulation still safe, but note it)'}`);
  }
  log('');
  return out;
}
