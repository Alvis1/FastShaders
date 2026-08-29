#!/usr/bin/env node
/**
 * Eval-study analysis — ingests the zips the eval mode produces and emits the
 * paper numbers. Written BEFORE data collection on purpose (EVAL_MODE_PLAN.md
 * Phase 7: schema gaps must surface in the pilot, not after the study).
 *
 *   node scripts/eval-analysis.mjs <package.zip>... [<dir>] [-o out.csv]
 *
 * A directory argument is scanned (non-recursively) for fastshaders-eval-*.zip.
 * Output: a per-participant table + aggregate SUS statistics (mean, SD, 95%
 * t-CI — the small-N reporting practice per Sauro & Lewis 2016) printed as
 * markdown, and a per-participant CSV (default eval-analysis.csv).
 *
 * Dependency-free: the packages are written by the app's own STORE-method zip
 * writer, so a ~40-line reader suffices (method 8 handled via node:zlib just
 * in case). Every zip is VALIDATED before it counts: schema tag, quality-check
 * block, and the SUS score recomputed from the raw item responses — a stored
 * score that disagrees with its own items fails the run loudly.
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { inflateRawSync } from 'node:zlib';

// ---------- minimal zip reader (STORE + deflate) ----------

function readZipEntries(buf) {
  // End-of-central-directory: scan back for its signature.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65535; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip (no end-of-central-directory)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    // Local header carries its OWN name/extra lengths — offsets differ.
    const lNameLen = buf.readUInt16LE(lho + 26);
    const lExtraLen = buf.readUInt16LE(lho + 28);
    const dataStart = lho + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + csize);
    entries.set(name, method === 8 ? inflateRawSync(raw) : raw);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// ---------- SUS scoring (mirror of src/eval/susScore.ts) ----------

function computeSus(responses) {
  if (responses.length !== 10) return null;
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const r = responses[i];
    if (!Number.isInteger(r) || r < 1 || r > 5) return null;
    sum += i % 2 === 0 ? r - 1 : 5 - r;
  }
  return sum * 2.5;
}

// Two-tailed 95% t critical values by df (Student's t); >30 interpolates the
// standard published tail values.
const T95 = [NaN, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262,
  2.228, 2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086,
  2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042];
function t95(df) {
  if (df <= 30) return T95[df];
  if (df <= 40) return 2.021;
  if (df <= 60) return 2.0;
  if (df <= 120) return 1.98;
  return 1.96;
}

/** Sauro–Lewis curved grading scale (Quantifying the User Experience, 2e).
 *  The F/D/C/B+/A/A+ boundaries were fetch-verified against measuringu.com;
 *  the intermediate bands come from the same published scale. */
const GRADES = [
  [84.1, 'A+'], [80.8, 'A'], [78.9, 'A−'], [77.2, 'B+'], [74.1, 'B'],
  [72.6, 'B−'], [71.1, 'C+'], [65.0, 'C'], [62.7, 'C−'], [51.7, 'D'], [0, 'F'],
];
function grade(score) {
  for (const [min, g] of GRADES) if (score >= min) return g;
  return 'F';
}
/** Adjective anchors (Bangor, Kortum & Miller 2009): OK≈51, Good≈71.4, Excellent≈85.5. */
function adjective(score) {
  if (score >= 85.5) return 'Excellent';
  if (score >= 71.4) return 'Good';
  if (score >= 51) return 'OK';
  return 'Poor';
}

// ---------- ingestion ----------

const args = process.argv.slice(2);
let outCsv = 'eval-analysis.csv';
const inputs = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '-o') { outCsv = args[++i]; continue; }
  inputs.push(args[i]);
}
if (inputs.length === 0) {
  console.error('usage: node scripts/eval-analysis.mjs <package.zip>... [<dir>] [-o out.csv]');
  process.exit(1);
}
const zipPaths = inputs.flatMap((p) =>
  statSync(p).isDirectory()
    ? readdirSync(p).filter((f) => /^fastshaders-eval-.*\.zip$/.test(f)).map((f) => join(p, f))
    : [p],
);
if (zipPaths.length === 0) {
  console.error('no fastshaders-eval-*.zip found in the given inputs');
  process.exit(1);
}

const rows = [];
const problems = [];
for (const zp of zipPaths) {
  const name = basename(zp);
  try {
    const entries = readZipEntries(readFileSync(zp));
    const json = (n) => {
      const e = entries.get(n);
      if (!e) throw new Error(`missing ${n}`);
      return JSON.parse(e.toString('utf8'));
    };
    const sus = json('sus.json');
    const summaryFile = json('telemetry-summary.json');
    const session = json('session.json');
    const events = json('telemetry-events.json');

    if (session.schema !== 'fs-eval-1') problems.push(`${name}: unknown schema ${session.schema}`);

    const failed = (summaryFile.quality ?? []).filter((q) => !q.ok);
    if (failed.length) problems.push(`${name}: FAILED quality checks — ${failed.map((q) => q.id).join(', ')}`);

    const responses = (sus.items ?? []).map((it) => it.response);
    const recomputed = computeSus(responses);
    if (recomputed == null) problems.push(`${name}: SUS responses invalid/incomplete`);
    else if (recomputed !== sus.score) problems.push(`${name}: stored SUS ${sus.score} ≠ recomputed ${recomputed}`);

    const s = summaryFile.summary;
    if ((events.events?.length ?? 0) !== s.eventCount) {
      problems.push(`${name}: event count mismatch (${events.events?.length} vs summary ${s.eventCount})`);
    }

    const task = session.task ?? {};
    rows.push({
      file: name,
      // Session id is how a server-inbox package is reconciled against one
      // returned by hand — the same session must never be counted twice.
      sessionId: session.session?.id ?? '?',
      task: task.id ?? '',
      briefBudget: task.briefBudget ?? '',
      costBarVisible: task.costBarVisible == null ? '' : String(task.costBarVisible),
      costTable: session.costTable?.source ?? '',
      device: session.device ? `${session.device.gpu ?? '?'} · ${session.device.cores ?? '?'} cores` : '',
      hasShot: entries.has('preview.png'),
      participant: sus.participant || '?',
      language: sus.language ?? '?',
      sus: recomputed ?? sus.score,
      responses,
      wallMin: s.wallMs / 60000,
      activeMin: s.activeMs / 60000,
      idleThresholdS: s.idleThresholdMs / 1000,
      events: s.eventCount,
      nodeAdds: Object.values(s.nodeAddsByType ?? {}).reduce((a, b) => a + b, 0),
      distinctTypes: s.distinctNodeTypesAdded ?? 0,
      connects: s.counts?.['edge-connect'] ?? 0,
      undos: s.undoCount ?? 0,
      redos: s.redoCount ?? 0,
      applies: s.codeApplyCount ?? 0,
      rebuilds: s.previewRebuildCount ?? 0,
      ttfConnectS: s.timeToFirstConnectMs == null ? null : s.timeToFirstConnectMs / 1000,
      ttfNodeS: s.timeToFirstNodeAddMs == null ? null : s.timeToFirstNodeAddMs / 1000,
      budgetCrossings: s.budgetCrossings ?? 0,
      overBudgetMin: (s.overBudgetMs ?? 0) / 60000,
      comment: sus.comment ?? '',
    });
  } catch (e) {
    problems.push(`${name}: UNREADABLE — ${e.message}`);
  }
}

// Duplicate participants: legitimate (pilot vs real) but worth a loud note.
const byParticipant = new Map();
for (const r of rows) byParticipant.set(r.participant, (byParticipant.get(r.participant) ?? 0) + 1);
for (const [p, n] of byParticipant) if (n > 1) problems.push(`participant "${p}" appears ${n} times`);
// The same SESSION arriving twice (server inbox + a hand-returned copy) is a
// double count, not a second participant — reconcile on the session id.
const bySession = new Map();
for (const r of rows) bySession.set(r.sessionId, (bySession.get(r.sessionId) ?? 0) + 1);
for (const [id, n] of bySession) {
  if (n > 1) problems.push(`session ${id} appears ${n} times — same session returned twice (server + by hand?)`);
}

// ---------- report ----------

const fmt = (v, d = 1) => (v == null ? '—' : typeof v === 'number' ? v.toFixed(d) : String(v));
console.log(`# FastShaders eval analysis — ${rows.length} package(s)\n`);
console.log('| participant | task | costbar | lang | SUS | active min | node adds | connects | undos | over-budget min | png | session |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of rows) {
  console.log(`| ${r.participant} | ${r.task || '—'} | ${r.costBarVisible === '' ? '—' : (r.costBarVisible === 'true' ? 'on' : 'OFF')} | ${r.language} | ${fmt(r.sus)} | ${fmt(r.activeMin, 2)} | ${r.nodeAdds} | ${r.connects} | ${r.undos} | ${fmt(r.overBudgetMin, 2)} | ${r.hasShot ? 'y' : '—'} | ${r.sessionId} |`);
}

const scores = rows.map((r) => r.sus).filter((v) => typeof v === 'number');
if (scores.length >= 2) {
  const n = scores.length;
  const mean = scores.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(scores.map((v) => (v - mean) ** 2).reduce((a, b) => a + b, 0) / (n - 1));
  const half = t95(n - 1) * sd / Math.sqrt(n);
  console.log(`\n## SUS aggregate`);
  console.log(`- N = ${n}, mean = ${mean.toFixed(1)}, SD = ${sd.toFixed(1)}`);
  console.log(`- 95% t-CI: ${(mean - half).toFixed(1)} … ${(mean + half).toFixed(1)} (±${half.toFixed(1)})`);
  // A t-CI at n=2..4 routinely runs outside SUS's own 0-100 range: it is
  // arithmetically correct and substantively useless, so say so rather than
  // letting a pilot number look like a finding. Planned N is 12-15 (Tullis &
  // Stetson 2004: SUS stabilises around n≈12; Caine 2016: the CHI norm is 12).
  if (n < 5 || mean - half < 0 || mean + half > 100) {
    console.log(`  ⚠ this interval is not informative at N = ${n} — it exceeds the 0-100 scale; collect the planned 12-15 before interpreting`);
  }
  console.log(`- vs. industrial mean 68: ${mean >= 68 ? 'above' : 'below'} average · Sauro–Lewis grade ${grade(mean)} · adjective ≈ ${adjective(mean)} (Bangor et al. 2009)`);
  // Condition breakdown — the point of recording the task/costbar identity.
  const conds = new Map();
  for (const r of rows) {
    const key = `${r.task || 'untasked'} / costbar ${r.costBarVisible === 'false' ? 'OFF' : 'on'}`;
    if (!conds.has(key)) conds.set(key, []);
    conds.get(key).push(r.sus);
  }
  if (conds.size > 1) {
    console.log('\n## By condition');
    for (const [key, xs] of conds) {
      const m = xs.reduce((a, b) => a + b, 0) / xs.length;
      console.log(`- ${key}: n = ${xs.length}, SUS mean = ${m.toFixed(1)}`);
    }
    console.log('  (descriptive only — a single-tool study cannot attribute a difference to the condition)');
  }
  const tables = [...new Set(rows.map((r) => r.costTable).filter(Boolean))];
  if (tables.length > 1) {
    problems.push(`packages were priced by DIFFERENT cost tables (${tables.join(', ')}) — point totals are not comparable across them`);
  }
  const langs = [...new Set(rows.map((r) => r.language))];
  console.log(`- language versions answered: ${langs.map((l) => `${l}×${rows.filter((r) => r.language === l).length}`).join(', ')} (report the split; the LV form is a non-validated adaptation)`);

  // Per-item means — the Lewis & Sauro (2018) item-diagnosis view.
  const itemMeans = Array.from({ length: 10 }, (_, i) => {
    const vs = rows.map((r) => r.responses[i]).filter((v) => Number.isInteger(v));
    return vs.reduce((a, b) => a + b, 0) / (vs.length || 1);
  });
  console.log(`- per-item response means (1–5, odd items positive / even negative): ${itemMeans.map((m, i) => `i${i + 1}=${m.toFixed(1)}`).join(' ')}`);
} else if (scores.length === 1) {
  console.log(`\n## SUS aggregate\n- N = 1, score = ${scores[0]} — no CI at N=1; collect more sessions before interpreting.`);
}

if (problems.length) {
  console.log(`\n## PROBLEMS (${problems.length})`);
  for (const p of problems) console.log(`- ${p}`);
}

// CSV — one row per participant, spreadsheet-ready.
const cols = ['file', 'sessionId', 'participant', 'task', 'briefBudget', 'costBarVisible', 'costTable', 'device', 'hasShot', 'budgetCrossings', 'overBudgetMin', 'language', 'sus', 'activeMin', 'wallMin', 'idleThresholdS', 'events', 'nodeAdds', 'distinctTypes', 'connects', 'undos', 'redos', 'applies', 'rebuilds', 'ttfConnectS', 'ttfNodeS', 'comment'];
const esc = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n']/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
writeFileSync(outCsv, [cols.join(','), ...rows.map((r) => cols.map((c) => esc(typeof r[c] === 'number' ? +r[c].toFixed(3) : r[c])).join(','))].join('\n') + '\n');
console.log(`\nCSV written: ${outCsv}`);
process.exitCode = problems.some((p) => p.includes('UNREADABLE') || p.includes('≠') || p.includes('FAILED')) ? 1 : 0;
