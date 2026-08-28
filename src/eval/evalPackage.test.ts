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
