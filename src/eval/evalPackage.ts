/**
 * Eval-package assembly — PURE (no DOM, no store), node-tested. The caller
 * (SusModal's submit path) supplies everything, including the shader bundle
 * bytes from `buildShaderBundle()` and the submitted-at ISO stamp, so the
 * entry list is deterministic: same input, byte-identical zip (zipWriter is
 * deterministic by design).
 *
 * One zip per participant:
 *   session.json            — schema, app/env facts, session ids, consent record
 *   sus.json                — per-item responses, language, computed score
 *   telemetry-events.json   — the raw event log (the recomputable ground truth)
 *   telemetry-summary.json  — derived metrics + automated quality checks
 *   summary.csv             — one spreadsheet-friendly row of headline numbers
 *   shader/<name>.js|.zip   — the participant's shader, byte-identical to EXPORT
 *   README.txt              — schema version, metric formulas, the declared
 *                             idle threshold, quality-check meanings
 */

import type { ZipEntry } from '@/utils/zipWriter';
import { toKebabCase } from '@/utils/nameUtils';
import type { EvalEvent, EvalSummary, QualityCheck } from './telemetryModel';
import { backgroundCsvColumns } from './background';
import { proCsvColumns } from './proQuestions';

export interface EvalPackageInput {
  schema: string;
  /** Content of session.json — assembled by the caller (env + session ids). */
  session: Record<string, unknown>;
  /** Content of sus.json — responses, language, score. */
  sus: Record<string, unknown>;
  events: EvalEvent[];
  summary: EvalSummary;
  quality: QualityCheck[];
  /** The shader bundle; null only if bundle assembly itself failed. */
  shader: { fileName: string; bytes: Uint8Array } | null;
  /**
   * PNG of the 3D preview at submit — what the blinded quality-rating panel
   * judges. Null when the stage could not produce one (no preview mounted, a
   * backend that refuses toDataURL, a timeout); the package is valid without
   * it, and the README says whether it is there.
   */
  shot?: Uint8Array | null;
}

/** `fastshaders-eval-<participant>-<YYYYMMDDHHMM>.zip` */
export function evalZipFileName(participant: string, submittedIso: string): string {
  // toKebabCase's default fallback is 'shader' — wrong noun here.
  const stem = toKebabCase(participant || '', 'participant');
  const stamp = submittedIso.slice(0, 16).replace(/[-:T]/g, '');
  return `fastshaders-eval-${stem}-${stamp}.zip`;
}

function csvCell(v: unknown): string {
  let s = v == null ? '' : String(v);
  // Formula-escape: the README aims this file at spreadsheets, and the first
  // cell is participant-typed — a code like `=HYPERLINK(...)` would execute
  // on the RESEARCHER's machine. A leading apostrophe makes Excel/Sheets/
  // LibreOffice treat the cell as text (the standard CSV-injection guard).
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n']/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** One header row + one data row of the headline numbers. */
export function buildSummaryCsv(
  participant: string,
  susScore: number | null,
  summary: EvalSummary,
  /** Identity/condition columns, so one row is self-describing. */
  extra: {
    sessionId?: string;
    /** The study entry (`/eval`, `/evalp`, `/evalpro`) — the grouping variable. */
    arm?: string | null;
    task?: string;
    briefBudget?: number | null;
    costBarVisible?: boolean;
    pointsVisible?: boolean;
    costTable?: string;
    /** session.json costTable.budget / .shownBudget: the device budget in
     *  TABLE points, and what the screen printed it as (100 since 2026-10-23). */
    deviceBudget?: number | null;
    shownBudget?: number | null;
    /** The sus.json block, for the experience levels. */
    susBlock?: Record<string, unknown>;
  } = {},
): string {
  const cols: [string, unknown][] = [
    ['participant', participant],
    ['session_id', extra.sessionId ?? ''],
    ['arm', extra.arm ?? ''],
    ['task', extra.task ?? ''],
    ['brief_budget', extra.briefBudget ?? ''],
    ['cost_bar_visible', extra.costBarVisible == null ? '' : String(extra.costBarVisible)],
    ['points_visible', extra.pointsVisible == null ? '' : String(extra.pointsVisible)],
    ['cost_table', extra.costTable ?? ''],
    ['sus_score', susScore],
    // The experience block — the covariate a usability score is read against
    // — one column per answer, generated from BACKGROUND_ITEMS so a question
    // added or retired there cannot leave a stale or missing column. (The
    // first wave's packages carried exp_<id> levels 0-4 instead.)
    ...backgroundCsvColumns(readPath<unknown>(extra.susBlock ?? {}, ['background'])),
    // The professional block (/evalpro only; empty elsewhere): one column per
    // answer, generated from PRO_ITEMS like the exp_* columns. Typed text
    // never reaches the CSV — it stays in sus.json.
    ...proCsvColumns(readPath<unknown>(extra.susBlock ?? {}, ['professional'])),
    ['wall_min', (summary.wallMs / 60_000).toFixed(2)],
    ['active_min', (summary.activeMs / 60_000).toFixed(2)],
    ['idle_threshold_s', summary.idleThresholdMs / 1000],
    ['events', summary.eventCount],
    ['node_adds', Object.values(summary.nodeAddsByType).reduce((a, b) => a + b, 0)],
    ['distinct_node_types', summary.distinctNodeTypesAdded],
    // Ready-made material: a preset or texture is ONE drop that brings a whole
    // group and no node-add, so node_adds alone undercounts what was built.
    ['preset_drops', summary.assetDropsByKind['preset'] ?? 0],
    ['texture_drops', summary.assetDropsByKind['texture'] ?? 0],
    ['saved_group_drops', summary.assetDropsByKind['savedGroup'] ?? 0],
    ['file_drops', summary.assetDropsByKind['file'] ?? 0],
    ['asset_nodes', summary.assetNodesAdded],
    ['connects', summary.counts['edge-connect'] ?? 0],
    ['disconnects', summary.counts['edge-disconnect'] ?? 0],
    ['node_edits', summary.nodeEditCount],
    ['gestures', summary.gestureCount],
    ['undos', summary.undoCount],
    ['redos', summary.redoCount],
    ['code_applies', summary.codeApplyCount],
    ['preview_rebuilds', summary.previewRebuildCount],
    ['exports', summary.exportCount],
    // The last snapshot's two prices, in TABLE points: what the shader RENDERS
    // (only what feeds the counted Outputs) and every node on the canvas priced
    // once (`costPointsAll`, absent before 2026-10-20). Apart they show work
    // parked off the Output. The cost bar PRINTED final_points × shown_budget /
    // device_budget — the two columns after them, so the row is readable
    // against a brief_budget stated out of 100 (no shown_budget: printed as is).
    ['final_points', summary.finalSnapshot?.costPoints ?? ''],
    ['final_points_all', summary.finalSnapshot?.costPointsAll ?? ''],
    ['device_budget', extra.deviceBudget ?? ''],
    ['shown_budget', extra.shownBudget ?? ''],
    ['budget_crossings', summary.budgetCrossings],
    ['over_budget_min', (summary.overBudgetMs / 60_000).toFixed(2)],
    ['time_to_first_connect_s', summary.timeToFirstConnectMs == null ? '' : (summary.timeToFirstConnectMs / 1000).toFixed(1)],
    ['time_to_first_node_add_s', summary.timeToFirstNodeAddMs == null ? '' : (summary.timeToFirstNodeAddMs / 1000).toFixed(1)],
    ['intro_opens', summary.introOpenCount],
    ['intro_s', (summary.introMs / 1000).toFixed(1)],
    ['intro_slides_seen', summary.introSlidesSeen],
    ['tutorial_starts', summary.tutorialStartCount],
    ['tutorials_completed', summary.tutorialsCompleted],
    ['tutorial_auto_steps', summary.tutorialAutoSteps],
  ];
  return `${cols.map(([k]) => csvCell(k)).join(',')}\n${cols.map(([, v]) => csvCell(v)).join(',')}\n`;
}

export function buildEvalReadme(input: EvalPackageInput): string {
  const failing = input.quality.filter((q) => !q.ok);
  return [
    `FastShaders evaluation package (schema ${input.schema})`,
    '',
    'Files:',
    '  session.json            session identity, consent record, app + environment facts',
    '  sus.json                System Usability Scale responses and the computed score',
    '  telemetry-events.json   the raw event log — the ground truth every derived number',
    '                          can be recomputed from',
    '  telemetry-summary.json  derived metrics + automated quality checks',
    '  summary.csv             one row of headline numbers for spreadsheets',
    '  shader/                 the shader the participant made (byte-identical to the',
    '                          editor\'s EXPORT download; a .zip there carries embedded',
    '                          images/model alongside the .js module)',
    input.shot && input.shot.length
      ? '  preview.png             the 3D preview at the moment of submission'
      : '  (no preview.png — the preview could not produce an image this session)',
    '',
    'Timestamps: each event carries `t` = milliseconds on the page\'s monotonic clock',
    '(performance.now()); session.json carries the wall-clock ISO anchor. Durations are',
    'differences of `t`, never wall-clock arithmetic.',
    '',
    'Active time: the union of periods where the tab was visible AND focused AND the',
    `last input was under ${input.summary.idleThresholdMs / 1000} s ago (the declared idle threshold), derived from the`,
    'raw visibility/focus/activity events — recompute under any other threshold from',
    'telemetry-events.json. Focus entering the app\'s own 3D-preview iframe is logged',
    'as `focus {focused:false, target:"iframe"}` and counted as PRESENT plus one',
    'activity marker at entry — input inside the sandboxed preview is unobservable,',
    'so long uninterrupted preview inspection is counted conservatively (it idles',
    'out after the threshold like any other input gap).',
    '',
    'Study entry: session.json task.arm is the link the participant opened (eval,',
    'evalp or evalpro); the flags beside it say what that condition showed. On the',
    'eval and evalpro entries the intro slides open right after the consent, so',
    'time_to_first_* in summary.csv INCLUDE intro_s (intro-open/-slide/-close in the',
    'event log give the exact intervals).',
    '',
    'Questionnaire (sus.json): `background` (itemsVersion bg-3) holds the experience',
    'block asked before the SUS — which tools the participant has made materials or',
    'shaders with (Yes/No rows: Blender, Unreal, Unity, three.js/A-Frame, another',
    'node-based shader editor, which may be named), how much they have worked with node editors, and whether',
    'they have written or changed shader code (no / changed existing code / written',
    'their own); the first wave\'s packages carried three None-Expert self-ratings',
    'stored 0-4 instead, which must never be pooled with these. On evalpro,',
    '`professional` (itemsVersion pro-3) follows SUS item 10: whether a node\'s look',
    'told its function and its cost (Yes/Partly/No rows), whether the code panel and',
    'the presets helped, credibility of the cost points (1-5, or na = "can\'t judge"),',
    'whether the points changed what was built (five behavioural rungs), tolerance of',
    'a 20 % per-node error, where the system might mislead (text), what the tool',
    'suits, what got in the way (text), whether WebXR\'s constraints deter them (1-5 or',
    'na), how they find out shader cost today, main work and years of paid experience.',
    'Every answer records the English wording it was asked with and the language it',
    'was given in; the bg_* and pro_* columns of summary.csv repeat the choices (never',
    'typed text).',
    'session.json consent.participantAtConsent is the code given at Agree;',
    'participantEdited marks a package whose code was changed on the form.',
    '',
    'Actions: node_adds counts nodes added one at a time; a preset, texture or saved',
    'group arrives as one asset-drop whose `nodes` field says how many it brought',
    '(asset_nodes). node_edits are discrete setting changes (a typed number, a',
    'dropdown, a checkbox) — one per burst on the same node and fields within 2 s —',
    'and name WHICH settings changed, never their values; gestures are continuous',
    'ones (a drag-scrub or a colour-picker session), one per gesture.',
    '',
    'Step by step (evalpro only): the asset browser\'s lessons. tutorial-start marks',
    'a lesson replacing the graph with one Output (`lesson` = its id), tutorial-step',
    'each step shown, tutorial-end its close (`completed` = the finish screen was',
    'reached). A "Do it for me" press is one tutorial-auto; the node-add/node-edit',
    'events it causes carry `auto: true` and are NOT in node_adds, node_edits or',
    'time_to_first_node_add_s, and the wires it makes log no edge-connect (the',
    'snapshots still count them). tutorial_starts, tutorials_completed (distinct',
    'lessons) and tutorial_auto_steps are the summary.csv columns.',
    '',
    'Points: final_points is what the shader renders (only nodes feeding the counted',
    'Outputs); final_points_all prices every node on the canvas once, wired or not',
    '(snapshot `costPointsAll`). A gap between them is work parked off the Output.',
    'Both are TABLE points, the unit of every point figure in this package; the cost',
    'bar PRINTED final_points x shown_budget / device_budget (summary.csv; session.json',
    'costTable.shownBudget / costTable.budget), i.e. every device\'s budget read as',
    '100. A package without shown_budget printed table points as they are.',
    '',
    'device.memoryGb is null where the browser does not report memory (Safari and',
    'Firefox never do).',
    '',
    'SUS scoring: odd items contribute (response − 1), even items (5 − response);',
    'sum × 2.5 → 0–100 (Brooke 1996; item 8 uses the "awkward" wording, Finstad 2006).',
    '',
    failing.length === 0
      ? 'Quality checks: all passed.'
      : `Quality checks: ${failing.length} FAILED — see telemetry-summary.json (${failing.map((q) => q.id).join(', ')}).`,
    '',
  ].join('\n');
}

/** Read a nested value out of the caller-assembled session block, or undefined. */
function readPath<T>(obj: Record<string, unknown>, path: string[]): T | undefined {
  let cur: unknown = obj;
  for (const k of path) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur as T | undefined;
}

export function buildEvalPackageEntries(input: EvalPackageInput): ZipEntry[] {
  const enc = new TextEncoder();
  const json = (v: unknown): Uint8Array => enc.encode(`${JSON.stringify(v, null, 2)}\n`);

  const susScore = typeof input.sus.score === 'number' ? input.sus.score : null;
  const participant = typeof input.sus.participant === 'string' ? input.sus.participant : '';

  const entries: ZipEntry[] = [
    { name: 'session.json', data: json({ schema: input.schema, ...input.session }) },
    { name: 'sus.json', data: json(input.sus) },
    { name: 'telemetry-events.json', data: json({ schema: input.schema, events: input.events }) },
    { name: 'telemetry-summary.json', data: json({ schema: input.schema, summary: input.summary, quality: input.quality }) },
    {
      name: 'summary.csv',
      data: enc.encode(
        buildSummaryCsv(participant, susScore, input.summary, {
          sessionId: readPath(input.session, ['session', 'id']),
          arm: readPath(input.session, ['task', 'arm']),
          task: readPath(input.session, ['task', 'id']),
          briefBudget: readPath(input.session, ['task', 'briefBudget']),
          costBarVisible: readPath(input.session, ['task', 'costBarVisible']),
          pointsVisible: readPath(input.session, ['task', 'pointsVisible']),
          costTable: readPath(input.session, ['costTable', 'source']),
          deviceBudget: readPath(input.session, ['costTable', 'budget']),
          shownBudget: readPath(input.session, ['costTable', 'shownBudget']),
          susBlock: input.sus,
        }),
      ),
    },
    { name: 'README.txt', data: enc.encode(buildEvalReadme(input)) },
  ];
  if (input.shader) {
    entries.push({ name: `shader/${input.shader.fileName}`, data: input.shader.bytes });
  }
  if (input.shot && input.shot.length) {
    entries.push({ name: 'preview.png', data: input.shot });
  }
  return entries;
}
