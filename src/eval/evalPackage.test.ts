import { describe, it, expect } from 'vitest';
import { buildZip } from '@/utils/zipWriter';
import {
  buildEvalPackageEntries,
  buildEvalReadme,
  buildSummaryCsv,
  evalZipFileName,
  type EvalPackageInput,
} from './evalPackage';
import { deriveSummary, runQualityChecks, type EvalEvent } from './telemetryModel';
import { backgroundCsvColumns, buildBackgroundRecord } from './background';
import { PRO_ITEMS_VERSION, buildProRecord } from './proQuestions';

function fixtureInput(withShader: boolean): EvalPackageInput {
  const events: EvalEvent[] = [
    { seq: 1, t: 0, type: 'session-start' },
    { seq: 2, t: 5_000, type: 'node-add', nodeType: 'perlin' },
    { seq: 3, t: 9_000, type: 'edge-connect', targetHandle: 'color' },
    { seq: 4, t: 12_000, type: 'session-end' },
  ];
  const summary = deriveSummary(events, { idleThresholdMs: 60_000 });
  const quality = runQualityChecks(events, summary);
  return {
    schema: 'fs-eval-1',
    session: {
      app: { version: '0.0.0-test', build: 'web', address: 'http://localhost/' },
      session: { id: 'es-1', participant: 'P01', startedIso: '2026-08-28T10:00:00.000Z' },
    },
    sus: {
      participant: 'P01',
      language: 'en',
      score: 77.5,
      items: [],
      submittedIso: '2026-08-28T10:41:00.000Z',
    },
    events,
    summary,
    quality,
    shader: withShader
      ? { fileName: 'my-shader.js', bytes: new TextEncoder().encode('// shader') }
      : null,
  };
}

describe('evalZipFileName', () => {
  it('kebabs the participant and stamps to the minute', () => {
    expect(evalZipFileName('P01', '2026-08-28T10:41:12.345Z')).toBe(
      'fastshaders-eval-p01-202608281041.zip',
    );
  });

  it('survives diacritics and empty participants', () => {
    // toKebabCase is many-to-one over Latvian diacritics (the Work-folder
    // lesson) — the zip name just needs to be a valid, non-empty filename.
    const name = evalZipFileName('Jānis Bērziņš', '2026-08-28T10:41:00.000Z');
    expect(name).toMatch(/^fastshaders-eval-[a-z0-9-]+-202608281041\.zip$/);
    expect(evalZipFileName('', '2026-08-28T10:41:00.000Z')).toBe(
      'fastshaders-eval-participant-202608281041.zip',
    );
  });
});

describe('buildEvalPackageEntries', () => {
  it('emits the documented entry list, shader included', () => {
    const entries = buildEvalPackageEntries(fixtureInput(true));
    expect(entries.map((e) => e.name)).toEqual([
      'session.json',
      'sus.json',
      'telemetry-events.json',
      'telemetry-summary.json',
      'summary.csv',
      'README.txt',
      'shader/my-shader.js',
    ]);
  });

  it('omits only the shader entry when the bundle failed', () => {
    const entries = buildEvalPackageEntries(fixtureInput(false));
    expect(entries.map((e) => e.name)).not.toContain('shader/my-shader.js');
    expect(entries).toHaveLength(6);
  });

  it('every JSON entry parses and carries the schema tag where documented', () => {
    const entries = buildEvalPackageEntries(fixtureInput(true));
    const dec = new TextDecoder();
    const byName = new Map(entries.map((e) => [e.name, e.data]));
    const session = JSON.parse(dec.decode(byName.get('session.json')));
    const eventsFile = JSON.parse(dec.decode(byName.get('telemetry-events.json')));
    const summaryFile = JSON.parse(dec.decode(byName.get('telemetry-summary.json')));
    expect(session.schema).toBe('fs-eval-1');
    expect(eventsFile.schema).toBe('fs-eval-1');
    expect(eventsFile.events).toHaveLength(4);
    expect(summaryFile.summary.idleThresholdMs).toBe(60_000);
    expect(Array.isArray(summaryFile.quality)).toBe(true);
  });

  it('is deterministic — same input, byte-identical zip', () => {
    const a = buildZip(buildEvalPackageEntries(fixtureInput(true)));
    const b = buildZip(buildEvalPackageEntries(fixtureInput(true)));
    expect(a).toEqual(b);
  });
});

describe('summary.csv + README', () => {
  it('neutralises formula-injection in the participant cell', () => {
    // The participant code is typed by the participant and lands in a file
    // the README aims at spreadsheets — a leading = must not execute.
    const input = fixtureInput(true);
    const csv = buildSummaryCsv('=HYPERLINK("http://evil")', 50, input.summary);
    const row = csv.split('\n')[1];
    expect(row.startsWith('"\'=')).toBe(true);
  });

  it('csv has matching header and data column counts', () => {
    const input = fixtureInput(true);
    const csv = buildSummaryCsv('P01', 77.5, input.summary);
    const [header, row, tail] = csv.split('\n');
    expect(tail).toBe('');
    expect(header.split(',')).toHaveLength(row.split(',').length);
    expect(header).toContain('sus_score');
    expect(row).toContain('77.5');
  });

  it('carries one bg_ column per experience answer, read from the sus block', () => {
    // The columns follow BACKGROUND_ITEMS: the first wave's exp_<id> levels
    // and the retired "other node editors" item must not linger as columns.
    const input = fixtureInput(true);
    const csv = buildSummaryCsv('P01', 77.5, input.summary, {
      susBlock: { background: buildBackgroundRecord({ 'toolsUsed.blender': 'yes', 'toolsUsed.unity': 'no', nodeEditorUse: 'few' }) },
    });
    const [header, row] = csv.split('\n');
    const cells = Object.fromEntries(header.split(',').map((h, i) => [h, row.split(',')[i]]));
    expect(header.split(',').filter((h) => h.startsWith('exp_'))).toEqual([]);
    expect(header.split(',').filter((h) => h.startsWith('bg_'))).toEqual(backgroundCsvColumns(undefined).map(([k]) => k));
    expect(cells).toMatchObject({ bg_items_version: 'bg-2', bg_toolsUsed_blender: 'yes', bg_toolsUsed_unity: 'no', bg_nodeEditorUse: 'few', bg_shaderCodeUse: '' });
  });

  it('carries the pro_* columns: empty for a student, the choices for a professional', () => {
    const input = fixtureInput(true);
    const parse = (csv: string) => {
      const [header, row] = csv.split('\n');
      return Object.fromEntries(header.split(',').map((h, i) => [h, row.split(',')[i]]));
    };
    const student = parse(buildSummaryCsv('J01', 50, input.summary, { susBlock: {} }));
    expect(student.pro_items_version).toBe('');
    expect(student.pro_pilotQ5).toBe('');
    const pro = parse(buildSummaryCsv('FS_LD_01', 70, input.summary, {
      susBlock: { professional: buildProRecord({ pilotQ5: 4, pointsCredible: 'na', mainWork: 'techArt', 'platforms12m.webxr': 'yes' }) },
    }));
    expect(pro).toMatchObject({
      pro_items_version: PRO_ITEMS_VERSION,
      pro_pilotQ5: '4',
      pro_pointsCredible: 'na',
      pro_mainWork: 'techArt',
      pro_platforms12m_webxr: 'yes',
    });
  });

  it('carries the study arm and the ready-made, edit and intro columns', () => {
    const events: EvalEvent[] = [
      { seq: 1, t: 0, type: 'session-start' },
      { seq: 2, t: 100, type: 'intro-open', via: 'start', slide: 'connect' },
      { seq: 3, t: 30_100, type: 'intro-close', slide: 'connect' },
      { seq: 4, t: 34_000, type: 'asset-drop', kind: 'preset', id: 'vertex-wave', nodes: 11 },
      { seq: 5, t: 40_000, type: 'node-edit', nodeType: 'perlin', fields: ['values.scale'] },
      { seq: 6, t: 50_000, type: 'session-end' },
    ];
    const csv = buildSummaryCsv('P01', 50, deriveSummary(events, { idleThresholdMs: 60_000 }), {
      arm: 'evalpro',
      pointsVisible: true,
    });
    const [header, row] = csv.split('\n');
    const cells = Object.fromEntries(header.split(',').map((h, i) => [h, row.split(',')[i]]));
    expect(cells).toMatchObject({
      arm: 'evalpro', points_visible: 'true',
      preset_drops: '1', asset_nodes: '11', node_edits: '1', gestures: '0',
      intro_opens: '1', intro_s: '30.0', intro_slides_seen: '1',
    });
  });

  it('carries the device budget and what the screen printed it as, beside final_points', () => {
    // final_points is TABLE points; since 2026-10-23 the bar printed it out of
    // 100, so without these two a 186 read against a brief of 100 looks 86 %
    // over budget for a participant whose bar said 93 / 100.
    const csv = buildSummaryCsv('P01', 50, fixtureInput(true).summary, { deviceBudget: 200, shownBudget: 100 });
    const [header, row] = csv.split('\n');
    const cols = header.split(',');
    const cells = Object.fromEntries(cols.map((h, i) => [h, row.split(',')[i]]));
    expect([cells.device_budget, cells.shown_budget]).toEqual(['200', '100']);
    expect(cols.indexOf('device_budget')).toBe(cols.indexOf('final_points_all') + 1);
    const readme = buildEvalReadme(fixtureInput(true));
    expect(readme).toContain('TABLE points');
    expect(readme).toContain('final_points x shown_budget / device_budget');
    expect(readme).not.toContain("the cost bar's number");
  });

  it('README declares the idle threshold and the schema', () => {
    const input = fixtureInput(true);
    const readme = buildEvalReadme(input);
    expect(readme).toContain('fs-eval-1');
    expect(readme).toContain('60 s');
    expect(readme).toContain('Quality checks: all passed.');
  });

  it('README names failing quality checks', () => {
    const input = fixtureInput(true);
    input.quality = [
      ...input.quality,
      { id: 'seq-contiguous', ok: false, detail: 'gap' },
    ];
    expect(buildEvalReadme(input)).toContain('seq-contiguous');
  });
});
