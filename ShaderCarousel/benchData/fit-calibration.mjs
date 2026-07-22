#!/usr/bin/env node
/* fit-calibration — turn a MicroPlane bench export into per-node point
 * suggestions by regressing the k-copy calibration sweep.
 *
 * The MicroPlane bench measures each calibration shader's marginal per-pass
 * cost (baseline-subtracted, normalized to the 2064×2208 reference
 * resolution). This script closes the last mile the bench can't do in the
 * browser: it fits the k-copy SWEEP.
 *
 *   • For every op the registry emits as `calib_<op>_x{1,4,16}`, it fits a
 *     line marginalMsAtRef = slope·k + c by ordinary least squares. The
 *     slope is the cost of ONE op instance; R² flags nonlinearity
 *     (amortization / register pressure — slope isn't the whole story if R²
 *     is low).
 *   • It subtracts the `calib_scaffold_x*` slope (seed transform +
 *     accumulate, present in every calib shader) so the number is the op
 *     alone — finer than the flat-baseline subtraction the bench already did.
 *   • It converts op ms/copy → points (round(ms / BUDGET_MS · 100)) and
 *     diffs against the current src/registry/complexity.json.
 *   • For the `combo_*` shaders it checks ADDITIVITY: does the isolated-slope
 *     model predict the measured composite? A ratio far from 1.0 means node
 *     costs don't simply add (the point system's core assumption).
 *
 * Usage:  node fit-calibration.mjs <microplane-export.json>
 *
 * Input is the raw `shadercarousel-microplane-*.json` a MicroPlane run
 * downloads (NOT the -complexity-suggestion file). Commit runs into this
 * directory so the calibration loop actually closes.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { BUDGET_MS } from '../lib/bench-stats.js';

const __dir = dirname(fileURLToPath(import.meta.url));

// ── Least squares ───────────────────────────────────────────────────────────
function ols(xs, ys) {
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

const pts = ms => Math.round((ms / BUDGET_MS) * 100);

// ── Load run + current cost table ───────────────────────────────────────────
const inPath = process.argv[2];
if (!inPath) { console.error('usage: node fit-calibration.mjs <microplane-export.json>'); process.exit(2); }

const run = JSON.parse(readFileSync(inPath, 'utf8'));
const shaders = run.shaders || [];
if (!shaders.length) { console.error('no .shaders[] in input — is this a raw microplane export?'); process.exit(2); }

let current = {};
try {
  current = JSON.parse(readFileSync(resolve(__dir, '../../src/registry/complexity.json'), 'utf8')).costs || {};
} catch { /* running detached from the repo — diff column just blanks */ }

// Prefer resolution-normalized marginal; fall back to raw marginal, then median.
const cost = s => s?.stats?.marginalMsAtRef ?? s?.stats?.marginalMs ?? s?.stats?.medianFt ?? null;

// id → shader, and a parser for calib_<op>_x<k>
const byId = new Map(shaders.map(s => [s.id, s]));
const sweep = new Map(); // op -> [{k, ms}]
for (const s of shaders) {
  const m = /^calib_(.+)_x(\d+)$/.exec(s.id);
  if (!m) continue;
  const [, op, k] = m;
  const ms = cost(s);
  if (ms == null) continue;
  if (!sweep.has(op)) sweep.set(op, []);
  sweep.get(op).push({ k: +k, ms });
}

const fit = op => {
  const rows = (sweep.get(op) || []).sort((a, b) => a.k - b.k);
  if (rows.length < 2) return null;
  return { ...ols(rows.map(r => r.k), rows.map(r => r.ms)), rows };
};

const scaffold = fit('scaffold');
const scaffoldSlope = scaffold?.slope ?? 0;

// ── Per-op report ───────────────────────────────────────────────────────────
console.log(`\nMicroPlane calibration fit  —  ${inPath}`);
console.log(`device: ${run.metadata?.gpu || run.metadata?.device || '?'}   timing: ${run.metadata?.timingMethod || '?'}   valid: ${run.metadata?.valid ?? '?'}`);
if (run.metadata?.reasons?.length) console.log(`  ⚠ ${run.metadata.reasons.join('\n  ⚠ ')}`);
console.log(`scaffold slope (per-copy overhead, subtracted): ${scaffoldSlope.toFixed(5)} ms  (R²=${scaffold?.r2?.toFixed(3) ?? '—'})\n`);

const header = ['op', 'ms/copy(net)', 'R²', 'suggested', 'current', 'Δ', 'flag'];
const rows = [];
for (const op of [...sweep.keys()].filter(o => o !== 'scaffold').sort()) {
  const f = fit(op);
  if (!f) continue;
  const net = f.slope - scaffoldSlope;            // op cost with scaffold removed
  const suggested = pts(Math.max(0, net));
  const cur = current[op];
  const delta = cur != null ? suggested - cur : null;
  const flags = [];
  if (f.r2 < 0.97) flags.push('nonlinear?');       // poor line fit → amortization/pressure
  if (net <= 0) flags.push('below-scaffold');      // op cheaper than overhead → measurement floor
  if (cur != null && Math.abs(delta) >= Math.max(3, cur * 0.5)) flags.push('mispriced');
  rows.push([op, net.toFixed(5), f.r2.toFixed(3), String(suggested), cur ?? '—', delta ?? '—', flags.join(' ')]);
}
const w = header.map((h, i) => Math.max(h.length, ...rows.map(r => String(r[i]).length)));
const fmt = r => r.map((c, i) => String(c).padEnd(w[i])).join('  ');
console.log(fmt(header));
console.log(w.map(n => '─'.repeat(n)).join('  '));
rows.forEach(r => console.log(fmt(r)));

// ── Additivity checks (combos) ──────────────────────────────────────────────
// Predicted from ISOLATION SLOPES (which already include per-copy scaffold),
// so a k-copy combo predicts as Σ kᵢ·slope(opᵢ). Ratio measured/predicted ≈ 1
// ⟺ node costs add.
const slopeOf = op => fit(op)?.slope ?? null;
const additivity = [
  { id: 'combo_sin4_sqrt4', terms: [['sin', 4], ['sqrt', 4]] },
  { id: 'combo_perlin4_voronoi4', terms: [['perlin', 4], ['voronoi', 4]] },
];
console.log('\nAdditivity (measured ÷ predicted-from-isolation):');
for (const c of additivity) {
  const s = byId.get(c.id);
  const measured = cost(s);
  const predicted = c.terms.reduce((acc, [op, k]) => acc + (slopeOf(op) ?? NaN) * k, 0);
  if (measured == null || !isFinite(predicted)) { console.log(`  ${c.id}: missing data`); continue; }
  const ratio = measured / predicted;
  const verdict = Math.abs(ratio - 1) < 0.15 ? 'additive' : ratio > 1 ? 'SUPER-additive (whole > parts)' : 'SUB-additive (whole < parts)';
  console.log(`  ${c.id}: measured ${measured.toFixed(5)} / predicted ${predicted.toFixed(5)} = ${ratio.toFixed(2)}×  → ${verdict}`);
}

// ILP: sqrt chained vs parallel (same 8 sqrts)
const par = cost(byId.get('combo_sqrt_parallel8'));
const chn = cost(byId.get('combo_sqrt_chain8'));
if (par != null && chn != null) {
  console.log(`\nILP (sqrt×8): chain ${chn.toFixed(5)} / parallel ${par.toFixed(5)} = ${(chn / par).toFixed(2)}×  (>1 ⟹ latency-bound; point model counts throughput only)`);
}

// DCE sentinel integrity
const dropped = cost(byId.get('combo_dce_dropped'));
const kept = cost(byId.get('combo_dce_kept'));
if (dropped != null && kept != null) {
  const dceWorks = Math.abs(dropped) < 0.2 * Math.abs(kept);
  console.log(`\nDCE sentinel: dropped ${dropped.toFixed(5)} vs kept ${kept.toFixed(5)}  → compiler DCE ${dceWorks ? 'ACTIVE (good: accumulation is load-bearing)' : 'NOT eliminating zero-weighted work (accumulation still safe, but note it)'}`);
}
console.log('');
