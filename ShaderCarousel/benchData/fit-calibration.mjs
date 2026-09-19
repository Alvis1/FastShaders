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
 *   • It subtracts the SCAFFOLD slope (seed transform + accumulate, present
 *     in every calib shader) so the number is the op alone — finer than the
 *     flat-baseline subtraction the bench already did. The scaffold is per
 *     FAMILY: ALU ops subtract `calib_scaffold_x*`, texture ops (`tex_*`)
 *     subtract their own `calib_tex_scaffold_x*`, whose per-copy overhead is
 *     a UV derivation rather than the ALU seed. Neither scaffold is a row.
 *   • It converts op ms/copy → points (round(ms / BUDGET_MS · 100)) and
 *     diffs against the current src/registry/complexity.json.
 *   • When the run carries texture sweeps it adds a "Texture atoms" section:
 *     per-atom points, the Image node's size curve against nodeCost's
 *     IMAGE_COST_MIN_SCALE, the coherence ratios, the per-fetch profile
 *     cross-check and flags.
 *   • For the `combo_*` shaders it checks ADDITIVITY: does the isolated-slope
 *     model predict the measured composite? A ratio far from 1.0 means node
 *     costs don't simply add (the point system's core assumption).
 *
 * Usage:  node fit-calibration.mjs <microplane-export.json> [--texture-json <out.json>]
 *
 * --texture-json writes the texture report as JSON (with the run's device,
 * bench, timing method, resolution and date). A run with no texture sweep
 * writes `{ "texture": null }` and exits 1.
 *
 * Input is the raw `shadercarousel-microplane-*.json` a MicroPlane run
 * downloads (NOT the -complexity-suggestion file). Commit runs into this
 * directory so the calibration loop actually closes.
 *
 * All the arithmetic, and the report text itself, lives in ./fit-core.mjs —
 * the pure half the vitest suite imports (src/registry/fitCalibration.test.ts).
 * This file is only the I/O around it.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { renderCalibrationReport, textureReport } from './fit-core.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const USAGE = 'usage: node fit-calibration.mjs <microplane-export.json> [--texture-json <out.json>]';

// ── Arguments ───────────────────────────────────────────────────────────────
let inPath = null;
let textureJson = null;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--texture-json') {
    textureJson = args[++i] ?? null;
    if (!textureJson) { console.error(USAGE); process.exit(2); }
    continue;
  }
  if (inPath == null) inPath = args[i];
}
if (!inPath) { console.error(USAGE); process.exit(2); }

// ── Load run + current cost table ───────────────────────────────────────────
const run = JSON.parse(readFileSync(inPath, 'utf8'));
const shaders = run.shaders || [];
if (!shaders.length) { console.error('no .shaders[] in input — is this a raw microplane export?'); process.exit(2); }

let current = {};
try {
  current = JSON.parse(readFileSync(resolve(__dir, '../../src/registry/complexity.json'), 'utf8')).costs || {};
} catch { /* running detached from the repo — diff column just blanks */ }

// ── Report ──────────────────────────────────────────────────────────────────
for (const line of renderCalibrationReport(run, inPath, current)) console.log(line);

// ── --texture-json ──────────────────────────────────────────────────────────
if (textureJson) {
  const report = textureReport(shaders, current);
  const md = run.metadata;
  const out = report
    ? { source: inPath, device: md?.gpu, bench: md?.bench, timingMethod: md?.timingMethod, resolution: md?.resolution, date: md?.date, ...report }
    : { texture: null };
  writeFileSync(textureJson, JSON.stringify(out, null, 2) + '\n');
  if (!report) {
    console.error(`no texture sweep (calib_tex_*) in ${inPath}; wrote { "texture": null } to ${textureJson}`);
    process.exit(1);
  }
}
