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
    task?: string;
    briefBudget?: number | null;
    costBarVisible?: boolean;
    costTable?: string;
    /** The sus.json block, for the experience levels. */
    susBlock?: Record<string, unknown>;
  } = {},
): string {
  const cols: [string, unknown][] = [
    ['participant', participant],
    ['session_id', extra.sessionId ?? ''],
    ['task', extra.task ?? ''],
    ['brief_budget', extra.briefBudget ?? ''],
    ['cost_bar_visible', extra.costBarVisible == null ? '' : String(extra.costBarVisible)],
    ['cost_table', extra.costTable ?? ''],
    ['sus_score', susScore],
    // Experience levels 0-4 (none..expert) — the covariate a usability score
    // is read against; `readPath` pulls them out of the sus block the caller
    // assembled, so this file keeps knowing nothing about the questions.
    ...(['blender', 'unreal', 'otherNodeEditors', 'shaderCode'] as const).map(
      (id): [string, unknown] => [
        `exp_${id}`,
        (readPath<{ id: string; level: number | null }[]>(
          extra.susBlock ?? {}, ['background', 'items'],
        ) ?? []).find((it) => it.id === id)?.level ?? '',
      ],
    ),
    ['wall_min', (summary.wallMs / 60_000).toFixed(2)],
    ['active_min', (summary.activeMs / 60_000).toFixed(2)],
    ['idle_threshold_s', summary.idleThresholdMs / 1000],
    ['events', summary.eventCount],
    ['node_adds', Object.values(summary.nodeAddsByType).reduce((a, b) => a + b, 0)],
    ['distinct_node_types', summary.distinctNodeTypesAdded],
    ['connects', summary.counts['edge-connect'] ?? 0],
    ['disconnects', summary.counts['edge-disconnect'] ?? 0],
    ['undos', summary.undoCount],
    ['redos', summary.redoCount],
    ['code_applies', summary.codeApplyCount],
    ['preview_rebuilds', summary.previewRebuildCount],
    ['exports', summary.exportCount],
    ['budget_crossings', summary.budgetCrossings],
    ['over_budget_min', (summary.overBudgetMs / 60_000).toFixed(2)],
    ['time_to_first_connect_s', summary.timeToFirstConnectMs == null ? '' : (summary.timeToFirstConnectMs / 1000).toFixed(1)],
    ['time_to_first_node_add_s', summary.timeToFirstNodeAddMs == null ? '' : (summary.timeToFirstNodeAddMs / 1000).toFixed(1)],
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
          task: readPath(input.session, ['task', 'id']),
          briefBudget: readPath(input.session, ['task', 'briefBudget']),
          costBarVisible: readPath(input.session, ['task', 'costBarVisible']),
          costTable: readPath(input.session, ['costTable', 'source']),
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
